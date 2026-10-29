// Phase 1 end-to-end test: real extension in a Chromium 156 browser against a local Vaultwarden.
//   docker compose -f dev/vaultwarden/docker-compose.yml up -d
//   bash tools/build-wasm.sh --features register --out dist/wasm-register   (test-only account setup)
//   node tools/build.mjs --e2e-host=http://localhost:8080
//   CHROME_PATH=<chromium-based browser that honours --load-extension> npm run test:e2e
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page, type Worker } from "playwright-core";
import { passwordToken, prelogin, refreshToken, revisionDate } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";

const BASE = process.env.VW_URL ?? "http://localhost:8080";
const root = join(import.meta.dirname, "../..");
const TOTP_KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // test fixture, 20 bytes

const wasmDir = join(root, "dist/wasm-register");
const wasm = await import(pathToFileURL(join(wasmDir, "core_wasm.js")).href);
await wasm.default({ module_or_path: readFileSync(join(wasmDir, "core_wasm_bg.wasm")) });

type Kdf = [number, number, number, number];
interface TestUser { email: string; password: string; kdf: Kdf }

const passed: string[] = [];
let currentPage: Page | undefined;
async function step(name: string, fn: () => Promise<void>) {
  const t = performance.now();
  try {
    await fn();
  } catch (e) {
    console.error(`FAIL ${name}\n  popup: ${(await currentPage?.locator("#app").innerText().catch(() => "?"))?.replace(/\s+/g, " ")}`);
    throw e;
  }
  passed.push(`ok  ${name} (${Math.round(performance.now() - t)} ms)`);
  console.log(passed.at(-1));
}

// ---------- server-side fixtures (through the API, like a fresh client would) ----------

function authHash(u: TestUser): string {
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  try {
    return wasm.makeAuthHash(h, u.password, false);
  } finally {
    wasm.freeMasterKey(h);
  }
}

async function register(label: string, kdf: Kdf): Promise<TestUser> {
  const u = { email: `pw-${label}-${randomBytes(4).toString("hex")}@example.test`, password: `test-${label}-pw`, kdf };
  const token = await call(BASE, "POST", "/identity/accounts/register/send-verification-email", { json: { email: u.email, name: label } });
  const h = wasm.deriveMasterKey(u.password, u.email, ...kdf);
  const keys = JSON.parse(wasm.makeRegistrationKeys(h));
  await call(BASE, "POST", "/identity/accounts/register/finish", {
    json: {
      email: u.email, emailVerificationToken: token, masterPasswordHash: wasm.makeAuthHash(h, u.password, false), key: keys.key,
      kdf: kdf[0], kdfIterations: kdf[1], kdfMemory: kdf[0] === 1 ? kdf[2] : null, kdfParallelism: kdf[0] === 1 ? kdf[3] : null,
      userAsymmetricKeys: { publicKey: keys.publicKey, encryptedPrivateKey: keys.encryptedPrivateKey },
    },
  });
  wasm.freeMasterKey(h);
  return u;
}

const totpNow = () => JSON.parse(wasm.totp(TOTP_KEY, Date.now())) as { code: string; remaining: number };

/** Vaultwarden rejects a TOTP code twice in the same step, so wait for a fresh one. */
async function freshTotp(): Promise<string> {
  await new Promise((r) => setTimeout(r, (totpNow().remaining + 1) * 1000));
  return totpNow().code;
}

async function enableTotp(u: TestUser): Promise<void> {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  await call(BASE, "POST", "/api/two-factor/authenticator", {
    token: tok.access_token,
    json: { key: TOTP_KEY, token: totpNow().code, masterPasswordHash: authHash(u) },
  });
}

// ---------- browser ----------

const ext = join(root, "dist/ext");
const profile = mkdtempSync(join(tmpdir(), "pw-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
  headless: process.env.HEADED ? false : true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  const sw: Worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  const popupUrl = `chrome-extension://${id}/popup.html`;
  const page: Page = await ctx.newPage();
  currentPage = page;
  const open = async () => {
    await page.goto(popupUrl);
    await page.locator("#app .page").waitFor();
  };
  const heading = () => page.locator("#app h1").first().textContent();
  const fill = async (label: string, value: string) => page.getByLabel(label, { exact: true }).fill(value);
  const click = async (name: string) => page.getByRole("button", { name, exact: true }).click();
  const loginAs = async (u: TestUser) => {
    await fill("Email", u.email);
    await fill("Master password", u.password);
    await click("Log in");
  };
  const expectUnlocked = () => page.getByRole("searchbox", { name: "Search vault" }).waitFor({ timeout: 20_000 });
  const logout = async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
  };

  const pbkdf2 = await register("pbkdf2", [0, 600000, 0, 0]);
  const argon = await register("argon2", [1, 3, 64, 4]);
  const totpUser = await register("totp", [0, 600000, 0, 0]);
  await enableTotp(totpUser);

  await step("transport: prelogin, password grant, refresh grant, revision-date", async () => {
    const kdf = await prelogin(BASE, argon.email);
    assert.deepEqual([kdf.type, kdf.iterations, kdf.memory, kdf.parallelism], argon.kdf);
    const t = await passwordToken(BASE, { email: argon.email, authHash: authHash(argon), deviceId: crypto.randomUUID() });
    assert.ok(t.Key && t.PrivateKey && t.refresh_token);
    const r = await refreshToken(BASE, t.refresh_token!);
    assert.ok((await revisionDate(BASE, r.access_token)) > 0);
  });

  await step("setup: server URL + host permission", async () => {
    await open();
    assert.equal(await heading(), "Plugwarden");
    await fill("Server URL", BASE);
    await click("Continue");
    await page.getByRole("heading", { name: "Log in" }).waitFor();
  });

  await step("login PBKDF2-600k", async () => {
    await loginAs(pbkdf2);
    await expectUnlocked();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), true);
  });

  await step("popup first render < 100 ms (unlocked state)", async () => {
    await open();
    await expectUnlocked();
    const ms = await page.evaluate(() => performance.getEntriesByName("plugwarden:first-render")[0]?.startTime ?? -1);
    console.log(`    first render ${ms.toFixed(1)} ms`);
    assert.ok(ms > 0 && ms < 100, `first render took ${ms} ms`);
  });

  await step("lock drops keys; wrong password rejected; unlock works", async () => {
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), false);
    await fill("Master password", "wrong-password");
    await click("Unlock");
    await page.getByRole("alert").filter({ hasText: "Wrong master password" }).waitFor();
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
  });

  await step("no secrets in extension storage", async () => {
    const dump = await sw.evaluate(async () =>
      JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
    );
    assert.ok(!dump.includes(pbkdf2.password), "master password found in storage");
    assert.ok(!dump.includes(authHash(pbkdf2)), "auth hash found in storage");
  });

  await step("auto-lock alarm locks the vault", async () => {
    await sw.evaluate(() => chrome.alarms.create("autolock", { when: Date.now() + 200 }));
    await page.waitForTimeout(2000);
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
  });

  await step("logout, login Argon2id 3/64MiB/4", async () => {
    await logout();
    await loginAs(argon);
    await expectUnlocked();
  });

  await step("TOTP two-step login with remember-device", async () => {
    await logout();
    const code = await freshTotp();
    await loginAs(totpUser);
    await page.getByRole("heading", { name: "Two-step login" }).waitFor();
    await fill("Verification code", "000000");
    await click("Continue");
    await page.getByRole("alert").waitFor();
    await fill("Verification code", code);
    await page.getByText("Remember this device").click();
    await click("Continue");
    await expectUnlocked();
  });

  await step("remembered device skips the second step", async () => {
    await logout();
    await loginAs(totpUser);
    await expectUnlocked();
  });

  console.log(`\n${passed.length} steps passed (${await ctx.browser()?.version() ?? "persistent context"})`);
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
