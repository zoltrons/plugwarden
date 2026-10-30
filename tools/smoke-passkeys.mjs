#!/usr/bin/env node
// Passkey smoke test that needs no server: loads the built extension in Chromium and checks the
// always-on wiring (registered content scripts, the navigator.credentials shim, the advertised
// authenticator, conditional mediation + AbortSignal, the approval window for a plain get, and a clean
// console). Full passkey round trips need Vaultwarden: see tests/e2e/run.ts.
//   node tools/build.mjs   (after tools/build-wasm.sh)
//   node tools/smoke-passkeys.mjs        HEADED=1 to watch it
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "dist/ext");
const profile = mkdtempSync(join(tmpdir(), "pw-passkey-smoke-"));
const html = `<!doctype html><meta charset="utf-8"><form>
<input id="u" name="username" autocomplete="username">
<input id="p" name="password" type="password">
<button type="submit">Log in</button></form>`;
// Runs on load, so without the user activation Playwright's evaluate() would grant: a forged conditional create.
const forged = `<!doctype html><script>
addEventListener("message", (e) => { if (e.data?.plugwarden === "res") document.title = JSON.stringify(e.data.result); });
onload = () => postMessage({ plugwarden: "req", id: "forged", kind: "create", conditional: true, options: { rpName: "x", user: { id: "AA", name: "x", displayName: "x" }, challenge: "AA", exclude: [], discoverable: true } }, "*");
</script>`;
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url === "/forged" ? forged : html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://localhost:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !process.env.HEADED,
  // Playwright adds --disable-extensions, which would make --load-extension a no-op.
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const pageErrors = [];
const swErrors = [];
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  sw.on("console", (m) => m.type() === "error" && swErrors.push(m.text()));

  // Registered at service-worker start; give the idempotent registration a moment.
  let ids = [];
  for (let i = 0; i < 50 && ids.length < 2; i++) {
    ids = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id).sort()));
    if (ids.length < 2) await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(ids, ["pw-passkey-page", "pw-passkey-relay"]);
  console.log(`ok  content scripts registered: ${ids.join(", ")}`);

  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${site}/login`);

  const patched = await page.evaluate(() => ({
    create: !/\[native code\]/.test(navigator.credentials.create.toString()),
    get: !/\[native code\]/.test(navigator.credentials.get.toString()),
  }));
  assert.deepEqual(patched, { create: true, get: true });
  console.log("ok  navigator.credentials shim installed");

  // No platform authenticator in this browser: the shim advertises one, like the official client.
  const advertised = await page.evaluate(async () => [
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    await PublicKeyCredential.isConditionalMediationAvailable(),
  ]);
  assert.deepEqual(advertised, [true, true]);
  console.log("ok  platform authenticator and conditional mediation advertised");

  // Not logged in: conditional mediation is declined, so it keeps waiting for the browser's own UI,
  // and an AbortSignal still rejects (with AbortError) instead of leaving the page hanging.
  const conditional = await page.evaluate(async () => {
    const ac = new AbortController();
    let state = "pending";
    navigator.credentials
      .get({ mediation: "conditional", publicKey: { challenge: new Uint8Array(32), rpId: "localhost" }, signal: ac.signal })
      .then(() => (state = "resolved"), (e) => (state = e?.name ?? String(e)));
    await new Promise((r) => setTimeout(r, 1500));
    const before = state;
    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: state };
  });
  assert.deepEqual(conditional, { before: "pending", after: "AbortError" });
  console.log("ok  conditional mediation waits and honours AbortSignal");

  // Focusing a login field asks for inline-menu rows: nothing to offer without an account.
  await page.click("#u");
  await page.waitForTimeout(800);
  assert.equal(await page.locator("plugwarden-menu").count(), 0);
  console.log("ok  no inline menu without an account");

  // A logged-in (here: locked) account: a plain get opens the approval window, and closing it hands the
  // call back to the browser instead of leaving the page hanging. Calls fired in a loop open one window
  // (the extra modal calls are refused, like the browser does), while a conditional call is never refused.
  await sw.evaluate(() =>
    chrome.storage.local.set({ account: { email: "smoke@example.test", kdf: { type: 0, iterations: 600_000, memory: 64, parallelism: 4 }, protectedUserKey: "2.x|y|z" } }),
  );
  const windows = [];
  const onPage = (p) => p.url().includes("popup.html?passkey=") && windows.push(p);
  ctx.on("page", onPage);
  const settled = page.evaluate(async () => {
    const states = [];
    const track = (promise) => {
      const i = states.push("pending") - 1;
      promise.then(() => (states[i] = "resolved"), (e) => (states[i] = e?.name ?? String(e)));
    };
    const publicKey = { challenge: new Uint8Array(32), rpId: "localhost" };
    for (let i = 0; i < 5; i++) track(navigator.credentials.get({ publicKey }));
    track(navigator.credentials.get({ mediation: "conditional", publicKey }));
    await new Promise((r) => setTimeout(r, 2500));
    return states;
  });
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(windows.length, 1, "one approval window per tab");
  await windows[0].close();
  const states = await settled;
  ctx.off("page", onPage);
  assert.deepEqual(states.slice(1, 5), Array(4).fill("NotAllowedError"));
  assert.notEqual(states[0], "resolved");
  assert.equal(states[5], "pending", "a conditional call next to a modal one is not refused");
  console.log("ok  plain get opens one approval window; closing it falls back; conditional calls are not refused");

  // A page cannot open the window without a click by marking its create call as conditional.
  const forgedWindows = [];
  const onForged = (p) => p.url().includes("popup.html?passkey=") && forgedWindows.push(p);
  ctx.on("page", onForged);
  const forgedPage = await ctx.newPage();
  await forgedPage.goto(`${site}/forged`);
  await forgedPage.waitForFunction(() => document.title !== "");
  assert.deepEqual(JSON.parse(await forgedPage.title()), { fallback: true });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(forgedWindows.length, 0, "a forged conditional create opened a window");
  ctx.off("page", onForged);
  console.log("ok  a forged conditional create without user activation opens nothing");

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(swErrors, []);
  console.log("ok  no page or service-worker errors");
  console.log("passkey smoke test passed");
} finally {
  await ctx.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
