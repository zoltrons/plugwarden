#!/usr/bin/env node
// Field-detection smoke test: bundles the injected page functions and runs them against fixture pages in
// Helium (Chromium), no extension host and no server needed. Covers the login/card heuristics that the
// autofill path depends on (decoys, registration-vs-login, labels, forms, shadow roots, page load).
//   node tools/smoke-fill.mjs        HEADED=1 to watch it
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = (
  await build({
    absWorkingDir: root,
    entryPoints: ["src/autofill/page.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "PW",
    target: "chrome120",
    logLevel: "warning",
  })
).outputFiles[0].text;

const signup = `<form onsubmit="return false">
  <input id="su-email" autocomplete="email"><input id="su-pass" type="password" autocomplete="new-password"><button>Create account</button>
</form>
<form onsubmit="return false">
  <input id="u" name="login" autocomplete="username"><input id="p" type="password" autocomplete="current-password"><button>Sign in</button>
</form>`;

const fixtures = {
  // Zero-size password decoys sit in front of the real form on anti-autofill pages.
  decoy: `<input id="decoy" type="password" style="position:absolute;width:0;height:0;opacity:0;border:0">
    <form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password"><button>Sign in</button></form>`,
  // A registration form before the login one: the login must win, the registration stay empty.
  signup,
  // Two-step login: one account field, no password anywhere.
  useronly: `<form onsubmit="return false"><input id="u" name="login" placeholder="Email or phone"><button>Next</button></form>`,
  // Nothing but labels and placeholders to go on.
  labels: `<form onsubmit="return false">
    <label for="u">Email address</label><input id="u">
    <label for="p">Password</label><input id="p" type="password"><button>Log in</button></form>`,
  // A password-only re-authentication next to an unrelated subscribe box.
  nouser: `<div><input id="news" placeholder="Your email for our newsletter"><button>Subscribe</button></div>
    <form onsubmit="return false"><input id="p" type="password" placeholder="Confirm your password"><button>Unlock</button></form>`,
  // The same, but with the login fields in a form-less dialog block.
  modal: `<div><input id="news" placeholder="Your email for our newsletter"></div>
    <div class="dialog"><input id="u" placeholder="Email"><input id="p" type="password"><button>Sign in</button></div>`,
  // Login form inside an open shadow root.
  shadow: `<div id="host"></div><script>
    document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
      '<form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password"><button>Sign in</button></form>';
  </script>`,
  // A read-only account field (the site only lets the password be typed) and a change-password form.
  readonly: `<form onsubmit="return false"><input id="u" value="shown@example.com" readonly><input id="p" type="password"><button>Sign in</button></form>`,
  change: `<form onsubmit="return false"><input id="u" autocomplete="username">
    <input id="cur" type="password" autocomplete="current-password">
    <input id="new" type="password" autocomplete="new-password">
    <input id="rep" type="password"></form>`,
  // Card form with labels only: no autocomplete, no useful name or id.
  card: `<form onsubmit="return false">
    <label for="n">Name on card</label><input id="n">
    <label for="c">Card number</label><input id="c">
    <select id="m" aria-label="Expiry month"><option></option><option>01</option><option>02</option></select>
    <input id="y" placeholder="Expiry year">
    <input id="v" aria-label="Security code"></form>`,
};

const server = createServer((req, res) => {
  const key = new URL(req.url, "http://x").pathname.slice(1);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${key}</title><body>${fixtures[key] ?? ""}`, "utf8");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// The extension targets Chromium; Helium is the browser on this machine (HELIUM_PATH overrides).
const helium = process.env.HELIUM_PATH ?? join(homedir(), "Applications/Helium.app/Contents/MacOS/Helium");
if (!existsSync(helium)) throw new Error(`Helium not found at ${helium}; set HELIUM_PATH`);
const browser = await chromium.launch({ executablePath: helium, headless: !process.env.HEADED });
const errors = [];
let pass = 0;

const values = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...(function walk(root, out) {
        for (const el of root.querySelectorAll("input, select")) {
          out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot, out);
        }
        return out;
      })(document, [])].map((el) => [el.id || el.placeholder || el.tagName, el.value]),
    ),
  );

async function scenario(name, key, fn) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/${key}`);
  await page.addScriptTag({ content: bundle });
  // chrome.scripting serializes the function; a new Function has no closure either, so test that copy.
  await page.evaluate(() => (PW.fill = new Function(`return (${PW.fillInPage.toString()})`)()));
  try {
    await fn(page);
    pass++;
    console.log(`✔ ${name}`);
  } catch (e) {
    console.log(`✘ ${name}`);
    throw e;
  } finally {
    await page.close();
  }
}

const fill = (page, extra = {}) =>
  page.evaluate(
    (extra) => PW.fill({ mode: "login", origin: location.origin, username: "user@example.com", password: "pa55word", ...extra }),
    extra,
  );

await scenario("a zero-size password decoy is skipped", "decoy", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.decoy, v.u, v.p], ["", "user@example.com", "pa55word"]);
});

await scenario("the login form wins over a registration form", "signup", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v["su-email"], v["su-pass"], v.u, v.p], ["", "", "user@example.com", "pa55word"]);
});

await scenario("a username-first step is filled, and page load skips it", "useronly", async (page) => {
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: false, reason: "noFields" });
  // passwordOnly (the top-frame pass of a popup fill) leaves it alone, so a login in an iframe can win.
  assert.deepEqual(await fill(page, { passwordOnly: true }), { filled: false, reason: "noFields" });
  assert.equal((await values(page)).u, "");
  assert.deepEqual(await fill(page), { filled: true });
  assert.equal((await values(page)).u, "user@example.com");
});

await scenario("labels alone identify the fields", "labels", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", "pa55word"]);
});

await scenario("a page-wide subscribe box is never the username", "nouser", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.news, v.p], ["", "pa55word"]);
});

await scenario("form-less login blocks are paired, page-wide boxes are not", "modal", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.news, v.u, v.p], ["", "user@example.com", "pa55word"]);
});

await scenario("fields inside an open shadow root are filled and read back", "shadow", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const read = await page.evaluate(() => PW.fill({ mode: "read" }));
  assert.deepEqual([read.username, read.password], ["user@example.com", "pa55word"]);
});

await scenario("page load keeps what the page or the user already typed", "signup", async (page) => {
  await page.evaluate(() => (document.getElementById("p").value = "typed-pass"));
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", "typed-pass"]);
  // Both fields full: nothing left to fill, and nothing overwritten.
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: false, reason: "noFields" });
});

await scenario("page load never fills a new password", "signup", async (page) => {
  await page.evaluate(() => (document.getElementById("u").value = ""));
  const read = await page.evaluate(() => {
    // Only the registration form is left: a page load must not fill it.
    document.querySelectorAll("form")[1].remove();
    return PW.fill({ mode: "login", origin: location.origin, username: "u", password: "p", onlyEmpty: true });
  });
  assert.deepEqual(read, { filled: false, reason: "noFields" });
});

await scenario("a read-only account field still names the login", "readonly", async (page) => {
  await page.fill("#p", "typed-pass");
  const read = await page.evaluate(() => PW.fill({ mode: "read" }));
  assert.deepEqual([read.username, read.password], ["shown@example.com", "typed-pass"]);
});

await scenario("a change-password form reports the new password", "change", async (page) => {
  for (const [id, value] of [["u", "bar-user"], ["cur", "old-pass"], ["new", "new-pass"], ["rep", "new-pass"]]) await page.fill(`#${id}`, value);
  const read = await page.evaluate(() => PW.fill({ mode: "read" }));
  assert.deepEqual([read.username, read.password], ["bar-user", "new-pass"]);
});

await scenario("card fields are found by their labels and placeholders", "card", async (page) => {
  const r = await page.evaluate(() =>
    PW.fill({
      mode: "form",
      origin: location.origin,
      values: { "cc-name": "Ada L", "cc-number": "4111111111111111", "cc-exp-month": "01", "cc-exp-year": "2030", "cc-csc": "123" },
    }),
  );
  assert.deepEqual(r, { filled: true });
  const v = await values(page);
  assert.deepEqual([v.n, v.c, v.m, v.y, v.v], ["Ada L", "4111111111111111", "01", "2030", "123"]);
});

await scenario("a frame on another origin is refused", "decoy", async (page) => {
  const r = await page.evaluate(() => PW.fill({ mode: "login", origin: "https://elsewhere.example", username: "u", password: "p" }));
  assert.deepEqual(r, { filled: false, reason: "origin" });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["", ""]);
});

await browser.close();
server.close();
assert.deepEqual(errors, []);
console.log(`\n${pass} autofill scenarios passed`);
