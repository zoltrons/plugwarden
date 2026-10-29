#!/usr/bin/env node
// Smoke test for biometric unlock without a Vaultwarden server.
//
//  1. Generates a throwaway account (protected user key) with the register-enabled WASM build.
//  2. Loads the extension, unlocks with the master password (no network), and turns on biometrics
//     on the Settings screen against a CDP virtual authenticator with PRF (hmac-secret) support.
//  3. Locks, unlocks with the biometric PRF output, and checks that logout removes the wrapped key.
//
// The wrap/unwrap primitive itself is also covered by `cargo test -p plugwarden-core-wasm`.
//   node tools/build.mjs --e2e && node tools/smoke-biometric.mjs
// Needs dist/wasm-register (tools/build-wasm.sh --features register --out dist/wasm-register).
// CHROME_PATH=... to use a specific Chromium 156+ build.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "dist/ext");
const wasmDir = join(root, "dist/wasm-register");
const email = "biometric-smoke@example.test";
const password = "correct horse battery staple";
const kdf = [0, 60_000];

const wasm = await import(pathToFileURL(join(wasmDir, "core_wasm.js")).href);
await wasm.default({ module_or_path: readFileSync(join(wasmDir, "core_wasm_bg.wasm")) });
const handle = wasm.deriveMasterKey(password, email, ...kdf, 0, 0);
const keys = JSON.parse(wasm.makeRegistrationKeys(handle));
wasm.freeMasterKey(handle);

const account = {
  email,
  userId: crypto.randomUUID(),
  kdf: { type: 0, iterations: kdf[1], memory: 0, parallelism: 0 },
  protectedUserKey: keys.key,
  encryptedPrivateKey: keys.encryptedPrivateKey,
};
const server = { url: "https://vault.invalid", version: "2026.6.0", name: "smoke" };

const profile = mkdtempSync(join(tmpdir(), "plugwarden-bio-"));
const ctx = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

async function poll(what, check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let sw;
const unlocked = () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.unlocked);
const storedBiometric = () => sw.evaluate(async () => (await chrome.storage.local.get("biometric")).biometric);

try {
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  await sw.evaluate(async ({ account, server }) => {
    await chrome.storage.local.set({ account, server });
    await chrome.storage.session.remove("session");
  }, { account, server });

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByLabel("Master password", { exact: true }).waitFor();
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await poll("master-password unlock", unlocked);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });

  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const toggle = page.getByRole("checkbox", { name: "Unlock with biometrics" });
  // The setup is async (WebAuthn + wrapping), so click once instead of `check()`, which would
  // click again while the switch is still unchecked during the round trip.
  await toggle.click();
  await poll("biometric setup", async () => !!(await storedBiometric()));
  const bio = await storedBiometric();
  assert.match(bio?.credentialId ?? "", /^[A-Za-z0-9_-]{16,}$/);
  assert.ok(bio?.protectedUserKey, "wrapped user key not stored");
  assert.equal(bio?.email, email);
  assert.ok(!JSON.stringify(bio).includes(password), "master password stored");

  // Lock, then unlock with the biometric credential instead of the master password.
  await page.getByRole("button", { name: "Lock now" }).click();
  await poll("lock", async () => !(await unlocked()));
  await page.getByRole("button", { name: "Unlock with biometrics" }).click();
  await poll("biometric unlock", unlocked);
  console.log("ok: setup + lock + unlock with biometrics (virtual PRF authenticator)");

  // Logging out must forget the wrapped key (the account is gone).
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await poll("logout", async () => !(await storedBiometric()));
  console.log("ok: logout removes the biometric key");
  await cdp.detach();
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
