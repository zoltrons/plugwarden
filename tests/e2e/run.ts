// Phase 1 end-to-end test: real extension in a Chromium 156 browser against a local Vaultwarden.
//   docker compose -f dev/vaultwarden/docker-compose.yml up -d
//   bash tools/build-wasm.sh --features register --out dist/wasm-register   (test-only account setup)
//   node tools/fetch-psl.mjs && node tools/build.mjs --e2e
//   CHROME_PATH=<chromium-based browser that honours --load-extension> npm run test:e2e
import assert from "node:assert/strict";
import { constants, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, generateKeyPairSync, pbkdf2Sync, publicEncrypt, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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

/** Retries an async check (e.g. a value in extension storage) for up to 5 s. */
async function poll(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
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

/**
 * Server-side view of a user through a second, independent client session (the test's own WASM
 * instance + raw API calls), used to seed vaults and to check what the extension wrote.
 */
async function apiSession(u: TestUser) {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  wasm.unlockUserKey(h, tok.Key!, tok.PrivateKey);
  const userId = JSON.parse(Buffer.from(tok.access_token.split(".")[1]!, "base64url").toString()).sub as string;
  const token = tok.access_token;
  return {
    async create(plain: Record<string, unknown>) {
      const enc = JSON.parse(wasm.encryptCipher(JSON.stringify(plain)));
      return (await call(BASE, "POST", "/api/ciphers", { token, json: { ...enc, encryptedFor: userId } })) as { id: string };
    },
    async update(plain: Record<string, any>) {
      const enc = JSON.parse(wasm.encryptCipher(JSON.stringify(plain)));
      await call(BASE, "PUT", `/api/ciphers/${plain.id}`, { token, json: { ...enc, encryptedFor: userId } });
    },
    async folder(name: string) {
      const encName = JSON.parse(wasm.encryptCipher(JSON.stringify({ type: 2, name }))).name;
      return (await call(BASE, "POST", "/api/folders", { token, json: { name: encName } })) as { id: string };
    },
    async folders() {
      const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { folders: unknown[] };
      return (JSON.parse(wasm.decryptFolders(JSON.stringify(sync.folders))).folders as { name: string }[]).map((f) => f.name);
    },
    /** Personal items (this session holds no organization keys). */
    async ciphers() {
      const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { ciphers: { organizationId?: string }[] };
      return sync.ciphers.filter((c) => !c.organizationId).map((c) => JSON.parse(wasm.decryptCipher(JSON.stringify(c))) as Record<string, any>);
    },
    done: () => wasm.lock(),
  };
}

/**
 * Creates an organization with one collection for `u`, and a secure note in that collection. All
 * crypto here is node:crypto (org key RSA-OAEP-wrapped for the user, names AES-CBC + HMAC), independent
 * of core-wasm.
 */
async function createOrgNote(u: TestUser, orgName: string, collectionName: string, noteName: string): Promise<void> {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const token = tok.access_token;
  const userId = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string;
  const { publicKey } = (await call(BASE, "GET", `/api/users/${userId}/public-key`, { token })) as { publicKey: string };
  const orgKey = randomBytes(64);
  const enc = (plain: Buffer | string) => {
    const iv = randomBytes(16);
    const c = createCipheriv("aes-256-cbc", orgKey.subarray(0, 32), iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const mac = createHmac("sha256", orgKey.subarray(32)).update(Buffer.concat([iv, ct])).digest();
    return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
  };
  const wrapped = publicEncrypt({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, orgKey);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
  const org = (await call(BASE, "POST", "/api/organizations", {
    token,
    json: {
      name: orgName, billingEmail: u.email, planType: 0, collectionName: enc(collectionName), key: `4.${wrapped.toString("base64")}`,
      keys: { publicKey: pair.publicKey.toString("base64"), encryptedPrivateKey: enc(pair.privateKey) },
    },
  })) as { id: string };
  const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { collections: { id: string; organizationId: string }[] };
  const coll = sync.collections.find((c) => c.organizationId === org.id)!;
  await call(BASE, "POST", "/api/ciphers/create", {
    token,
    json: { cipher: { type: 2, name: enc(noteName), notes: null, secureNote: { type: 0 }, organizationId: org.id, encryptedFor: userId }, collectionIds: [coll.id] },
  });
}

// A plain login page for autofill tests, reachable as localhost:8099 (matches) and 127.0.0.1:8099 (does not).
const SITE = "http://localhost:8099";
const LOGIN_FORM = `<form onsubmit="return false"><input id="u" name="user" autocomplete="username"><input id="p" type="password" name="pw"><button type="button" id="show">Show</button><button>Sign in</button></form>`;
const pages: Record<string, string> = {
  "/card": `<form><input id="cn" autocomplete="cc-name"><input id="cc" autocomplete="cc-number"><select id="m" autocomplete="cc-exp-month"><option></option><option>01</option><option>02</option></select><input id="y" name="exp-year"><input id="cvc" name="cvc"></form>`,
  // Login fields inside an open shadow root.
  "/shadow": `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(LOGIN_FORM)};</script>`,
  "/change": `<form onsubmit="return false"><input id="u" autocomplete="username"><input id="cur" type="password" autocomplete="current-password"><input id="new" type="password" autocomplete="new-password"><input id="rep" type="password"><button>Change</button></form>`,
  "/framed": `<p>outer</p><iframe id="f" src="/login" style="width:500px;height:200px"></iframe>`,
};
const site = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>Test site</title>${pages[new URL(req.url!, SITE).pathname] ?? LOGIN_FORM}`);
}).listen(8099);

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
  // Extension origins cannot be granted clipboard-read, so read the (browser-wide) clipboard from a server page.
  await ctx.grantPermissions(["clipboard-read"], { origin: new URL(BASE).origin });
  const readClipboard = async () => {
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/alive`);
      return await p.evaluate(() => navigator.clipboard.readText());
    } finally {
      await p.close();
    }
  };
  let page: Page = await ctx.newPage();
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
  const unlockIfLocked = async () => {
    await page.goto(popupUrl);
    await page.locator("#app .page").waitFor();
    if (await page.getByRole("heading", { name: "Vault locked" }).count()) {
      await fill("Master password", "test-vault-pw");
      await click("Unlock");
      await expectUnlocked();
    }
  };
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

  await step("PIN: set in settings, unlocks the locked vault, wrong PIN refused, never stored in clear", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Unlock with PIN").check();
    await page.getByLabel("PIN", { exact: true }).fill("4826");
    await click("Set PIN");
    await poll("PIN armed", () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.pin));
    const dump = await sw.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
    assert.ok(!dump.includes("4826"), "PIN found in storage");
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), false);
    await fill("PIN", "0000");
    await click("Unlock");
    await page.getByRole("alert").filter({ hasText: "Wrong PIN" }).waitFor();
    await fill("PIN", "4826");
    await click("Unlock");
    await expectUnlocked();
  });

  await step("PIN: after a browser restart the master password re-arms it", async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    // A restart empties storage.session; drop the PIN-wrapped key the same way.
    await sw.evaluate(async () => {
      const { session } = await chrome.storage.session.get("session");
      delete session.pin;
      await chrome.storage.session.set({ session });
    });
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await page.getByLabel("PIN", { exact: true }).count(), 0);
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
    await poll("PIN re-armed", () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.pin));
  });

  await step("PIN: five wrong PINs log out", async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    await open();
    for (let i = 0; i < 5; i++) {
      await fill("PIN", "1111");
      await click("Unlock");
      await page.getByRole("alert").waitFor();
    }
    await page.getByRole("alert").filter({ hasText: "logged out" }).waitFor();
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    await loginAs(pbkdf2);
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

  await step("timeout action 'log out' forgets the account; login Argon2id 3/64MiB/4", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Timeout action").selectOption("logout");
    // Requests run in order and each re-arms the auto-lock alarm before replying: once this no-op
    // answers, the select's request has done so too and cannot push our short alarm back.
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings" }));
    assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.timeoutAction), "logout");
    await sw.evaluate(() => chrome.alarms.create("autolock", { when: Date.now() + 200 }));
    await page.waitForTimeout(2000);
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    assert.equal(await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(["account", "vault"])).length), 0);
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, timeoutAction: "lock" } });
    });
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

  await step("YubiKey OTP two-step login sends provider 3 with the typed OTP", async () => {
    await logout();
    // Vaultwarden checks OTPs with Yubico's servers, so stand in for the server's 2FA answer inside the
    // service worker; the second request (with the OTP) goes to the real server, which logs in this
    // user without two-step login.
    await sw.evaluate(() => {
      const real = globalThis.fetch;
      const g = globalThis as unknown as { yubiSeen: (string | null)[] };
      globalThis.fetch = async (input, init) => {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (String(input).endsWith("/identity/connect/token") && form.get("grant_type") === "password") {
          if (!form.has("twoFactorProvider"))
            return new Response(JSON.stringify({ error: "invalid_grant", TwoFactorProviders: ["3"], TwoFactorProviders2: { "3": { Nfc: true } } }), { status: 400 });
          g.yubiSeen = [form.get("twoFactorProvider"), form.get("twoFactorToken")];
          globalThis.fetch = real;
        }
        return real(input, init);
      };
    });
    await loginAs(pbkdf2);
    await page.getByRole("button", { name: "YubiKey" }).waitFor();
    const otp = "cccccbcjdifctrndncchkftchjlnbhvhtugdljibejrv";
    await fill("Verification code", otp);
    await page.getByLabel("Verification code", { exact: true }).press("Enter");
    await expectUnlocked();
    assert.deepEqual(await sw.evaluate(() => (globalThis as unknown as { yubiSeen: unknown }).yubiSeen), ["3", otp]);
  });

  // ---------- Phase 4: WebAuthn two-step login ----------
  const keyUser = await register("webauthn", [0, 600000, 0, 0]);
  // Virtual authenticator on a page of the server origin registers the key like the web vault would.
  const regPage = await ctx.newPage();
  await regPage.goto(`${BASE}/alive`);
  const regCdp = await ctx.newCDPSession(regPage);
  await regCdp.send("WebAuthn.enable", { enableUI: false });
  const authenticator = {
    protocol: "ctap2" as const, transport: "usb" as const, hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  };
  const { authenticatorId: regAuth } = await regCdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
  {
    const tok = await passwordToken(BASE, { email: keyUser.email, authHash: authHash(keyUser), deviceId: crypto.randomUUID() });
    const json = { masterPasswordHash: authHash(keyUser) };
    const challenge = await call(BASE, "POST", "/api/two-factor/get-webauthn-challenge", { token: tok.access_token, json });
    const deviceResponse = await regPage.evaluate(async (opts: any) => {
      const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      opts.challenge = bytes(opts.challenge);
      opts.user.id = bytes(opts.user.id);
      opts.excludeCredentials = (opts.excludeCredentials ?? []).map((c: any) => ({ ...c, id: bytes(c.id) }));
      const c = (await navigator.credentials.create({ publicKey: opts })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAttestationResponse;
      return { id: c.id, rawId: b64u(c.rawId), type: c.type, response: { attestationObject: b64u(r.attestationObject), clientDataJson: b64u(r.clientDataJSON) } };
    }, challenge);
    await call(BASE, "POST", "/api/two-factor/webauthn", { token: tok.access_token, json: { ...json, id: 1, name: "e2e key", deviceResponse } });
  }
  const { credentials } = await regCdp.send("WebAuthn.getCredentials", { authenticatorId: regAuth });
  await regPage.close();

  await step("WebAuthn two-step login through the server's connector page", async () => {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: credentials[0]! });
    await logout();
    // The virtual key answers at once, so the 2FA screen may be gone before we look; watch the connector frame instead.
    const connector = page.waitForEvent("framenavigated", (f) => f.url().startsWith(`${BASE}/webauthn-connector.html`));
    await loginAs(keyUser);
    await connector;
    await expectUnlocked();
    await cdp.detach();
  });

  await step("side panel: same UI, fluid width, offered from settings", async () => {
    assert.equal((await sw.evaluate(() => chrome.sidePanel.getOptions({}))).path, "sidepanel.html");
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 520, height: 800 });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.getByRole("searchbox", { name: "Search vault" }).waitFor();
    assert.equal(await panel.evaluate(() => document.body.getBoundingClientRect().width), 520);
    await panel.getByRole("button", { name: "Settings" }).click();
    assert.equal(await panel.getByRole("button", { name: "Open in side panel" }).count(), 0);
    await panel.close();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Open in side panel" }).waitFor();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
  });

  // ---------- Phase 4: Send ----------
  const openSendTab = async () => {
    await page.getByRole("navigation").getByRole("button", { name: "Send" }).click();
    await page.getByRole("heading", { name: "Send", exact: true }).waitFor();
  };
  // A recipient opens the link. The web vault refuses plain-http servers, so this is the recipient
  // flow over the API, decrypted with node:crypto (written from the spec, independent of core-wasm).
  const receive = async (link: string, password?: string) => {
    const m = /^(.+)\/#\/send\/([\w-]+)\/([\w-]+)$/.exec(link);
    assert.ok(m && m[1] === BASE, link);
    const [accessId, urlKey] = [m[2]!, m[3]!];
    const secret = Buffer.from(urlKey, "base64url");
    const prk = createHmac("sha256", "bitwarden-send").update(secret).digest();
    const t1 = createHmac("sha256", prk).update(Buffer.from("send\x01")).digest(); // HKDF-Expand, info "send"
    const t2 = createHmac("sha256", prk).update(Buffer.concat([t1, Buffer.from("send\x02")])).digest();
    const open = (iv: Buffer, mac: Buffer, ct: Buffer) => {
      assert.ok(createHmac("sha256", t2).update(Buffer.concat([iv, ct])).digest().equals(mac), "send MAC mismatch");
      const d = createDecipheriv("aes-256-cbc", t1, iv);
      return Buffer.concat([d.update(ct), d.final()]);
    };
    const str = (enc: string) => {
      const [iv, ct, mac] = enc.slice(2).split("|").map((b) => Buffer.from(b, "base64"));
      assert.equal(enc.slice(0, 2), "2.");
      return open(iv!, mac!, ct!).toString("utf8");
    };
    const form: Record<string, string> = { grant_type: "send_access", client_id: "web", send_id: accessId };
    if (password) form.password_hash_b64 = pbkdf2Sync(password, secret, 100_000, 32, "sha256").toString("base64");
    const { access_token: token } = (await call(BASE, "POST", "/identity/connect/token", { form })) as { access_token: string };
    const s = (await call(BASE, "POST", "/api/sends/access", { token })) as any;
    let file: Buffer | undefined;
    if (s.file) {
      const { url } = (await call(BASE, "POST", `/api/sends/access/file/${s.file.id}`, { token })) as { url: string };
      const b = Buffer.from(await (await fetch(url)).arrayBuffer());
      assert.equal(b[0], 2);
      file = open(b.subarray(1, 17), b.subarray(17, 49), b.subarray(49));
    }
    return { name: str(s.name), text: s.text?.text ? str(s.text.text) : undefined, fileName: s.file ? str(s.file.fileName) : undefined, file };
  };

  await step("Send: text send link decrypts for a recipient", async () => {
    await openSendTab();
    await page.getByRole("button", { name: "New Send" }).click();
    await fill("Name", "Wifi for guests");
    await page.getByLabel("Text", { exact: true }).fill("guest-wifi-pass-42");
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).waitFor();
    const r = await receive(await readClipboard());
    assert.deepEqual([r.name, r.text], ["Wifi for guests", "guest-wifi-pass-42"]);
  });

  let reportLink = "";
  await step("Send: password-protected file send; server checks our password hash", async () => {
    await page.getByRole("button", { name: "New Send" }).click();
    await fill("Name", "Report");
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByLabel("File", { exact: true }).setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly numbers\n") });
    await fill("Password (optional)", "s3nd-pw");
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
    const link = (reportLink = await readClipboard());
    await assert.rejects(receive(link, "wrong-pw"));
    const r = await receive(link, "s3nd-pw");
    assert.deepEqual([r.name, r.fileName, r.file?.toString("utf8")], ["Report", "report.txt", "quarterly numbers\n"]);
  });

  await step("Send: edit renames, keeps link and password; disabling stops access", async () => {
    await page.getByRole("button", { name: "Edit Report" }).click();
    await page.getByRole("heading", { name: "Edit Send" }).waitFor();
    await fill("Name", "Report Q3");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: "Report Q3" }).waitFor();
    assert.equal((await receive(reportLink, "s3nd-pw")).name, "Report Q3");
    await page.getByRole("button", { name: "Edit Report Q3" }).click();
    await page.getByLabel("Disable this Send").check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: "Disabled" }).waitFor();
    await assert.rejects(receive(reportLink, "s3nd-pw"));
  });

  await step("Send: delete removes it on the server", async () => {
    await page.getByRole("button", { name: "Delete Wifi for guests" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await page.getByRole("status").filter({ hasText: "Send deleted" }).waitFor();
    // Full sync from the server, then a fresh popup that reads the list from the worker again.
    await sw.evaluate(() => chrome.storage.local.remove("vault"));
    await open();
    await expectUnlocked();
    await openSendTab();
    await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
    assert.equal(await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).count(), 0);
    assert.equal(await page.getByRole("listitem").filter({ hasText: "Report" }).count(), 1);
  });

  // ---------- Phase 2: vault ----------
  const vaultUser = await register("vault", [1, 3, 64, 4]);
  const api = await apiSession(vaultUser);
  const work = await api.folder("Work");
  await api.create({ type: 1, name: "GitHub", folderId: work.id, login: { username: "octo", password: "gh-secret-1", totp: TOTP_KEY, uris: [{ uri: "https://github.com/login", match: null }] }, fields: [{ name: "PIN", value: "4321", type: 1 }] });
  await api.create({ type: 2, name: "Wifi note", notes: "SSID: home\npassword: hunter2", secureNote: { type: 0 } });
  await api.create({ type: 3, name: "Visa", card: { cardholderName: "Ada L", number: "4111111111111111", code: "123", brand: "Visa", expMonth: "1", expYear: "2030" } });
  api.done();
  const rows = () => page.getByRole("list").getByRole("listitem");
  const back = () => page.getByRole("button", { name: "Back" }).click();

  await step("vault: sync, list, search, folder filter", async () => {
    await logout();
    await loginAs(vaultUser);
    await expectUnlocked();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).waitFor();
    assert.equal(await rows().count(), 3);
    await page.getByRole("searchbox").fill("wifi");
    assert.equal(await rows().count(), 1);
    await page.getByRole("searchbox").fill("");
    await page.getByRole("button", { name: "Work", exact: true }).click();
    assert.equal(await rows().count(), 1);
    assert.match(await rows().first().innerText(), /GitHub/);
    await page.getByRole("button", { name: "Work", exact: true }).click(); // chips toggle off again
    assert.equal(await rows().count(), 3);
  });

  await step("website icons come from the server's icon service and can be turned off", async () => {
    const icon = () => rows().filter({ hasText: "GitHub" }).locator(".tile img");
    assert.equal(await icon().getAttribute("src"), `${BASE}/icons/github.com/icon.png`);
    assert.equal(await rows().filter({ hasText: "Wifi note" }).locator(".tile img").count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show website icons").uncheck();
    await poll("icons setting saved", () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.favicons === false));
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await rows().filter({ hasText: "GitHub" }).waitFor();
    assert.equal(await icon().count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show website icons").check();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await icon().waitFor();
  });

  await step("item view: reveal password, TOTP matches, hidden field, copy schedules clearing", async () => {
    await rows().filter({ hasText: "GitHub" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
    await page.getByRole("button", { name: "Show password" }).first().click();
    await page.getByText("gh-secret-1").waitFor();
    const shown = (await page.locator("[data-totp]").innerText()).replace(/\s/g, "");
    assert.ok([totpNow().code, JSON.parse(wasm.totp(TOTP_KEY, Date.now() - 30_000)).code].includes(shown), `totp ${shown}`);
    assert.ok(!(await page.locator("#app").innerText()).includes("4321"), "hidden custom field shown in clear");
    await page.getByRole("button", { name: "Copy Username" }).click();
    await page.getByRole("status").filter({ hasText: "Copied" }).waitFor();
    assert.ok(await sw.evaluate(() => chrome.alarms.get("clipboard")), "clipboard clear alarm not scheduled");
    assert.equal(await readClipboard(), "octo");
    await sw.evaluate(() => chrome.alarms.create("clipboard", { when: Date.now() + 100 }));
    await page.waitForTimeout(1500);
    assert.equal(await readClipboard(), "", "clipboard not cleared");
    await back();
  });

  await step("card shown with masked number and editable", async () => {
    await rows().filter({ hasText: "Visa" }).click();
    await page.getByRole("heading", { name: "Visa" }).waitFor();
    const text = await page.locator("#app").innerText();
    assert.ok(text.includes("Ada L") && !text.includes("4111111111111111"));
    assert.equal(await page.getByRole("button", { name: "Edit" }).count(), 1);
    await back();
  });

  await step("create login in popup; server copy decrypts independently", async () => {
    await page.getByRole("button", { name: "New item" }).click();
    await fill("Name", "Example");
    await fill("Username", "alice");
    await page.getByRole("button", { name: "Generate password" }).click();
    await fill("Websites (one per line)", "example.com\nhttps://login.example.com");
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Example" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Example");
    s.done();
    assert.equal(c?.login.username, "alice");
    assert.equal(c?.login.password.length, 20);
    assert.deepEqual(c?.login.uris.map((u: { uri: string }) => u.uri), ["example.com", "https://login.example.com"]);
  });

  await step("edit password keeps history; stale edits are refused by the server", async () => {
    await rows().filter({ hasText: "GitHub" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await fill("Password", "gh-secret-2");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "GitHub");
    s.done();
    assert.equal(c?.login.password, "gh-secret-2");
    assert.equal(c?.passwordHistory?.[0]?.password, "gh-secret-1");
    assert.equal(c?.fields?.[0]?.value, "4321", "custom field lost on edit");
    assert.equal(c?.login.totp, TOTP_KEY, "totp lost on edit");
    // Another client edits it; our now-stale copy must not overwrite that (server granularity is 1 s).
    await page.waitForTimeout(1500);
    const other = await apiSession(vaultUser);
    await other.update({ ...c, notes: "edited elsewhere" });
    other.done();
    await page.getByRole("button", { name: "Edit" }).click();
    await fill("Password", "gh-secret-3");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").filter({ hasText: "out of date" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await back();
  });

  await step("external change arrives with sync", async () => {
    const s = await apiSession(vaultUser);
    await s.create({ type: 2, name: "Added elsewhere", secureNote: { type: 0 } });
    s.done();
    await page.getByRole("button", { name: "Sync now" }).click();
    await rows().filter({ hasText: "Added elsewhere" }).waitFor();
  });

  await step("attachments: upload in the popup, download decrypts, server copy decrypts", async () => {
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("heading", { name: "Wifi note" }).waitFor();
    await page.getByLabel("Add attachment").setInputFiles({ name: "router.txt", mimeType: "text/plain", buffer: Buffer.from("admin / 1234\n") });
    const button = page.getByRole("button", { name: "Download router.txt" });
    await button.waitFor();
    const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
    assert.equal(dl.suggestedFilename(), "router.txt");
    assert.equal(readFileSync(await dl.path()).toString(), "admin / 1234\n");
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Wifi note");
    s.done();
    assert.equal(c?.attachments?.[0]?.fileName, "router.txt");
    await back();
  });

  await step("organization item shows its organization and collection names", async () => {
    await createOrgNote(vaultUser, "Team Alpha", "Engineering", "Team wiki");
    await page.getByRole("button", { name: "Sync now" }).click();
    await rows().filter({ hasText: "Team wiki" }).click();
    await page.getByRole("heading", { name: "Team wiki" }).waitFor();
    await page.getByText("Team Alpha", { exact: true }).waitFor();
    await page.getByText("Engineering", { exact: true }).waitFor();
    await back();
  });

  await step("move to trash", async () => {
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("button", { name: "Tap again to move to trash" }).click();
    await page.getByRole("status").filter({ hasText: "Moved to trash" }).waitFor();
    assert.equal(await rows().filter({ hasText: "Wifi note" }).count(), 0);
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Wifi note");
    s.done();
    assert.ok(c?.deletedDate, "not in server trash");
  });

  await step("trash: restore, then delete forever", async () => {
    await page.getByRole("button", { name: "Trash (1)" }).click();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByText("This item is in the trash.").waitFor();
    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByRole("status").filter({ hasText: "Restored" }).waitFor();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("button", { name: "Tap again to move to trash" }).click();
    await page.getByRole("button", { name: "Trash (1)" }).click();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Delete forever" }).click();
    await page.getByRole("button", { name: "Tap again to delete forever" }).click();
    await page.getByRole("status").filter({ hasText: "Deleted" }).waitFor();
    const s = await apiSession(vaultUser);
    assert.equal((await s.ciphers()).filter((x) => x.name === "Wifi note").length, 0);
    s.done();
  });

  await step("editor: new card with a hidden custom field; clone; favorite", async () => {
    await page.getByRole("button", { name: "New item" }).click();
    await page.getByRole("button", { name: "Card", exact: true }).click();
    await fill("Name", "Work Amex");
    await fill("Cardholder name", "Ada Lovelace");
    await page.getByLabel("Brand").selectOption("Amex");
    await fill("Number", "378282246310005");
    await page.getByLabel("Expiration month").selectOption("7");
    await fill("Expiration year", "2031");
    await page.getByRole("button", { name: "Add field" }).click();
    await page.getByLabel("Field name").fill("PIN");
    await page.getByLabel("Value").fill("9876");
    await page.getByRole("combobox").filter({ hasText: "Text" }).selectOption("1");
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Work Amex" }).click();
    await page.getByRole("button", { name: "Favorite" }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await page.getByRole("button", { name: "Clone" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Work Amex (copy)" }).waitFor();
    const s = await apiSession(vaultUser);
    const all = await s.ciphers();
    s.done();
    const c = all.find((x) => x.name === "Work Amex");
    assert.deepEqual([c?.type, c?.card.brand, c?.card.number, c?.card.expMonth, c?.card.expYear, c?.favorite], [3, "Amex", "378282246310005", "7", "2031", true]);
    assert.deepEqual(c?.fields, [{ name: "PIN", value: "9876", type: 1, linkedId: null }]);
    assert.equal(all.find((x) => x.name === "Work Amex (copy)")?.card.number, "378282246310005");
  });

  await step("folders: create, rename, delete (names checked on the server)", async () => {
    const names = () => page.locator("input[aria-label=\"Folder name\"]");
    const index = (name: string) => page.evaluate((n) => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].findIndex((i) => i.value === n), name);
    const serverFolders = async () => {
      const s = await apiSession(vaultUser);
      const f = await s.folders();
      s.done();
      return f;
    };
    await page.getByRole("button", { name: "Folders", exact: true }).click();
    await page.getByLabel("New folder").fill("Banking");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Banking"));
    assert.ok((await serverFolders()).includes("Banking"));
    const i = await index("Banking");
    await names().nth(i).fill("Bank");
    await page.getByRole("button", { name: "Rename" }).nth(i).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Bank"));
    assert.ok((await serverFolders()).includes("Bank"));
    await page.getByRole("button", { name: "Delete folder" }).nth(await index("Bank")).click();
    await page.waitForFunction(() => ![...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Bank"));
    assert.ok(!(await serverFolders()).includes("Bank"));
    await page.getByRole("button", { name: "Back" }).click();
  });

  await step("export: master password re-checked, personal items as Bitwarden JSON", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: /^Export vault/ }).click();
    await page.getByLabel("Master password").fill("wrong-password");
    await click("Export");
    await page.getByRole("alert").filter({ hasText: "Wrong master password" }).waitFor();
    await page.getByLabel("Master password").fill(vaultUser.password);
    const [dl] = await Promise.all([page.waitForEvent("download"), click("Export")]);
    assert.match(dl.suggestedFilename(), /^plugwarden_export_\d{14}\.json$/);
    const data = JSON.parse(readFileSync(await dl.path(), "utf8"));
    assert.equal(data.encrypted, false);
    const github = data.items.find((i: any) => i.name === "GitHub");
    assert.equal(github?.login?.username, "octo");
    assert.equal(data.folders.find((f: any) => f.id === github.folderId)?.name, "Work");
    assert.ok(!data.items.some((i: any) => i.name === "Team wiki"), "organization item exported");
  });

  await step("import: Bitwarden JSON creates items and folders on the server", async () => {
    const file = {
      encrypted: false,
      folders: [{ id: "f-1", name: "Imported folder" }],
      items: [
        { id: "i-1", folderId: "f-1", type: 1, name: "Imported login", favorite: true, login: { username: "imp", password: "imp-pw", uris: [{ uri: "https://imp.example", match: null }] } },
        { id: "i-2", type: 99, name: "Unknown type" },
      ],
    };
    await page.getByLabel("Import items").setInputFiles({ name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
    await page.getByRole("status").filter({ hasText: "Imported 1 item(s). Skipped 1 unsupported item(s)." }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Imported login");
    const folders = await s.folders();
    s.done();
    assert.deepEqual([c?.login.username, c?.login.password, c?.favorite], ["imp", "imp-pw", true]);
    assert.ok(folders.includes("Imported folder"));
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await rows().filter({ hasText: "Imported login" }).waitFor();
  });

  await step("generator: password and passphrase", async () => {
    await page.getByRole("button", { name: "Generator" }).click();
    const out = page.getByRole("status", { name: "Generated value" }).or(page.locator("output"));
    await page.waitForFunction(() => (document.querySelector("output")?.textContent ?? "…") !== "…");
    assert.equal((await out.first().innerText()).length, 20);
    await page.getByRole("button", { name: "Passphrase" }).click();
    await page.waitForFunction(() => (document.querySelector("output")?.textContent ?? "").split("-").length === 5);
  });

  await step("generator: usernames (random word, plus-addressed email, catch-all)", async () => {
    const until = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("output")?.textContent ?? ""), re.source);
    await page.getByRole("button", { name: "Username", exact: true }).click();
    await until(/^[A-Z][a-z-]+\d{4}$/); // capitalized EFF word + 4 digits (defaults)
    await page.getByRole("button", { name: "Plus-addressed email" }).click();
    await until(/^[^@]+\+[a-z0-9]{8}@/);
    const plus = await page.locator("output").innerText();
    assert.equal(plus.replace(/\+[a-z0-9]{8}@/, "@"), vaultUser.email);
    await page.getByRole("button", { name: "Catch-all email" }).click();
    await page.getByLabel("Domain").fill("catch.example");
    await page.getByLabel("Domain").blur();
    await until(/^[a-z0-9]{8}@catch\.example$/);
  });

  await step("generator history: copied values listed, encrypted at rest, clearable", async () => {
    const value = await page.locator("output").innerText();
    await page.getByRole("button", { name: "Copy Generated value" }).click();
    await poll("history entry", () => sw.evaluate(async () => ((await chrome.storage.local.get("genHistory")).genHistory ?? []).length === 1));
    const raw = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get("genHistory")));
    assert.ok(!raw.includes(value) && raw.includes('"2.'), raw);
    await page.getByRole("button", { name: "Generator history" }).click();
    await page.getByRole("listitem").filter({ hasText: value }).waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByText("Copied values show up here").waitFor();
    assert.equal(await sw.evaluate(async () => Object.keys(await chrome.storage.local.get("genHistory")).length), 0);
    await page.getByRole("button", { name: "Back" }).click();
  });

  // Design review screenshots (not assertions): SHOTS=<dir> npm run test:e2e
  if (process.env.SHOTS) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const shot = (name: string) => page.locator("body").screenshot({ path: join(process.env.SHOTS!, `${scheme}-${name}.png`) });
      await page.getByRole("button", { name: "Vault", exact: true }).click();
      await shot("list");
      await rows().filter({ hasText: "GitHub" }).click();
      await page.getByRole("heading", { name: "GitHub" }).waitFor();
      await shot("item");
      await page.getByRole("button", { name: "Edit" }).click();
      await shot("edit");
      await page.getByRole("button", { name: "Cancel" }).click();
      await back();
      await page.getByRole("button", { name: "Generator" }).click();
      await shot("generator");
      await page.getByRole("button", { name: "Settings" }).click();
      await shot("settings");
    }
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("button", { name: "Vault", exact: true }).click();
  }

  await step("re-prompt: a flagged item's secrets need the master password again, until the next lock", async () => {
    await unlockIfLocked();
    const ask = (msg: Record<string, unknown>) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const saved = await ask({ type: "saveItem", item: { type: 2, name: "Guarded note", notes: "guarded secret", secureNote: { type: 0 }, reprompt: 1 } });
    const id: string = saved.data.items.find((i: { name: string }) => i.name === "Guarded note").id;
    // Every path that returns secrets is gated in the service worker, not only in the UI.
    for (const m of [{ type: "getItem", id }, { type: "totp", id }, { type: "downloadAttachment", cipherId: id, attachmentId: "x" }])
      assert.equal((await ask(m)).code, "reprompt", m.type);
    assert.equal((await ask({ type: "confirmReprompt", id, password: "wrong" })).code, "wrongPassword");
    assert.equal((await ask({ type: "confirmReprompt", id, password: vaultUser.password })).ok, true);
    assert.equal((await ask({ type: "getItem", id })).data.notes, "guarded secret");
    await ask({ type: "lock" });
    await unlockIfLocked();
    assert.equal((await ask({ type: "getItem", id })).code, "reprompt", "grant survived a lock");
    await ask({ type: "deleteItem", id });
    await ask({ type: "purgeItem", id });
  });

  await step("lock clears decrypted vault from the popup", async () => {
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.ok(!(await page.locator("#app").innerText()).includes("GitHub"));
  });

  // ---------- Phase 3: autofill ----------
  const s3 = await apiSession(vaultUser);
  await s3.create({ type: 1, name: "Local app", login: { username: "local-user", password: "local-pass", totp: TOTP_KEY, uris: [{ uri: SITE, match: null }] } });
  s3.done();
  const loginPage = await ctx.newPage();
  await loginPage.goto(`${SITE}/login`);
  const reopenPopup = async () => {
    if (page.isClosed()) page = await ctx.newPage();
    currentPage = page;
    await loginPage.bringToFront(); // the "active tab" the popup works on
    await page.goto(popupUrl);
  };
  const fieldValues = () =>
    loginPage.evaluate(() => [(document.getElementById("u") as HTMLInputElement).value, (document.getElementById("p") as HTMLInputElement).value]);
  const setFields = (u: string, p: string) =>
    loginPage.evaluate(([u, p]) => {
      (document.getElementById("u") as HTMLInputElement).value = u!;
      (document.getElementById("p") as HTMLInputElement).value = p!;
    }, [u, p]);

  await step("autofill: popup lists site matches and fills the page; TOTP code copied", async () => {
    await unlockIfLocked();
    await reopenPopup();
    await page.getByRole("heading", { name: "On this site — localhost:8099" }).waitFor();
    await page.getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    const codes = () => [totpNow().code, JSON.parse(wasm.totp(TOTP_KEY, Date.now() - 30_000)).code];
    let copied = "";
    for (let i = 0; i < 10 && !codes().includes(copied); i++) copied = await readClipboard();
    assert.ok(codes().includes(copied), `clipboard ${copied}`);
    assert.ok(await sw.evaluate(() => chrome.alarms.get("clipboard")), "clipboard clear alarm not scheduled");
  });

  const shortcut = () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return (globalThis as any).plugwardenTest.autofillFromGesture(tab);
    });

  await step("Ctrl+Shift+L handler: fills matching sites only", async () => {
    const other = await ctx.newPage();
    await other.goto("http://127.0.0.1:8099/login");
    await other.bringToFront();
    assert.deepEqual(await shortcut(), { filled: false, reason: "noMatch" });
    await other.close();
    await setFields("", "");
    await loginPage.bringToFront();
    assert.deepEqual(await shortcut(), { filled: true });
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    const cmds = await sw.evaluate(() => chrome.commands.getAll());
    // The suggested key is only a suggestion; browsers may leave it unassigned (Helium does).
    const cmd = cmds.find((c) => c.name === "autofill-login");
    assert.ok(cmd, "autofill-login command not registered");
    console.log(`    assigned shortcut: ${JSON.stringify(cmd.shortcut)}`);
  });

  await step("badge counts the site's logins; context menu lists them and fills the picked one", async () => {
    await reopenPopup(); // also makes the login page the active tab
    const badge = () =>
      sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: "http://localhost:8099/*" });
        return chrome.action.getBadgeText({ tabId: t!.id });
      });
    await poll("badge 1", async () => (await badge()) === "1");
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const menuId = `plugwarden-autofill:${data.items[0].id}`;
    // contextMenus has no getter; update() fails for an id that does not exist.
    const menuExists = (mid: string) => sw.evaluate((m) => new Promise((r) => chrome.contextMenus.update(m, {}, () => r(!chrome.runtime.lastError))), mid);
    assert.equal(await menuExists(menuId), true);
    await setFields("", "");
    const r = await sw.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return (globalThis as any).plugwardenTest.onContextMenu({ menuItemId: m }, tab);
    }, menuId);
    assert.deepEqual(r, { filled: true });
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    await poll("badge cleared", async () => (await badge()) === "");
    assert.equal(await menuExists(menuId), false);
    await unlockIfLocked();
  });

  await step("save login from page: new username creates an item", async () => {
    await setFields("new-user", "new-pass");
    await reopenPopup();
    await page.getByRole("button", { name: "Save login from this page" }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "localhost");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "new-user" && !x.deletedDate);
    s.done();
    assert.equal(c?.login.password, "new-pass");
    assert.equal(c?.login.uris[0].uri, SITE);
  });

  await step("save login from page: same username updates the password", async () => {
    await setFields("local-user", "local-pass-2");
    await reopenPopup();
    await page.getByRole("button", { name: "Save login from this page" }).click();
    await page.getByRole("heading", { name: "Edit item" }).waitFor();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("heading", { name: "Local app" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Local app");
    s.done();
    assert.equal(c?.login.password, "local-pass-2");
    assert.equal(c?.passwordHistory?.[0]?.password, "local-pass");
  });

  // ---------- inline menu, save bar, card fill (content script on every page) ----------
  // Menu and bar are extension iframes inside a closed shadow root; Playwright still lists their frames.
  const frameOf = async (p: Page, file: string) => {
    for (let i = 0; i < 100; i++) {
      const f = p.frames().find((x) => x.url().includes(`/${file}`));
      if (f) return f;
      await p.waitForTimeout(100);
    }
    throw new Error(`${file} did not appear`);
  };
  const values = (p: Page | import("playwright-core").Frame, ids: string[]) =>
    p.evaluate((ids) => ids.map((id) => (document.getElementById(id) as HTMLInputElement).value), ids);

  await step("inline menu: focusing the username lists site matches; picking one fills", async () => {
    await unlockIfLocked();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    await menu.getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass-2"]);
    await loginPage.waitForTimeout(300);
    assert.equal(await loginPage.locator("plugwarden-menu").count(), 0, "menu reopened after the fill");
  });

  await step("inline menu: fields in an open shadow root and in an iframe", async () => {
    await loginPage.goto(`${SITE}/shadow`);
    await loginPage.locator("#u").click(); // Playwright pierces open shadow roots
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("host")!.shadowRoot!.getElementById("p") as HTMLInputElement).value !== "");
    await loginPage.goto(`${SITE}/framed`);
    const inner = loginPage.frameLocator("#f");
    await inner.locator("#u").click();
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    const f = loginPage.frames().find((x) => x.url() === `${SITE}/login`)!;
    await f.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await values(f, ["u", "p"]), ["local-user", "local-pass-2"]);
  });

  await step("inline menu: card fields list cards and fill name, number, expiry and code", async () => {
    await loginPage.goto(`${SITE}/card`);
    await loginPage.click("#cc");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Visa" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("cc") as HTMLInputElement).value !== "");
    assert.deepEqual(await values(loginPage, ["cn", "cc", "m", "y", "cvc"]), ["Ada L", "4111111111111111", "01", "2030", "123"]);
  });

  await step("save bar: a submitted new login is offered and saved", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "bar-user");
    await loginPage.fill("#p", "bar-pass");
    await loginPage.keyboard.press("Escape");
    await loginPage.click("#show"); // type="button": not a submit, must not offer anything
    await loginPage.waitForTimeout(600);
    assert.equal(await loginPage.locator("plugwarden-bar").count(), 0, "a non-submit button triggered the save bar");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByText("Save this login in Plugwarden?").waitFor();
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await loginPage.waitForFunction(() => !document.querySelector("plugwarden-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.deepEqual([c?.login.password, c?.login.uris[0].uri], ["bar-pass", SITE]);
  });

  await step("save bar: a changed password is offered as an update and keeps history", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "bar-user");
    await loginPage.fill("#p", "bar-pass-2");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByText("Update the saved password?").waitFor();
    await bar.getByRole("button", { name: "Update" }).click();
    await loginPage.waitForFunction(() => !document.querySelector("plugwarden-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.deepEqual([c?.login.password, c?.passwordHistory?.[0]?.password], ["bar-pass-2", "bar-pass"]);
  });

  await step("save bar: change-password form offers the new password, not the current one", async () => {
    await loginPage.goto(`${SITE}/change`);
    for (const [id, v] of [["u", "bar-user"], ["cur", "bar-pass-2"], ["new", "bar-pass-3"], ["rep", "bar-pass-3"]] as const) await loginPage.fill(`#${id}`, v);
    await loginPage.keyboard.press("Escape");
    await loginPage.click("button");
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByRole("button", { name: "Update" }).click();
    await loginPage.waitForFunction(() => !document.querySelector("plugwarden-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.equal(c?.login.password, "bar-pass-3");
  });

  await step("inline menu: a menu frame without the page's nonce is refused", async () => {
    const s = await apiSession(vaultUser);
    const github = (await s.ciphers()).find((x) => x.name === "GitHub")!;
    s.done();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    // A copy of menu.html framed by the page has no fragment: the worker refuses it before matching.
    const r = await menu.evaluate((id) => chrome.runtime.sendMessage({ type: "inlineFill", id, nonce: "not-the-nonce" }), github.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /not the one opened/);
    assert.deepEqual(await fieldValues(), ["", ""]);
  });

  await step("inline menu: a fill for an item not offered for this field is refused", async () => {
    const s = await apiSession(vaultUser);
    const github = (await s.ciphers()).find((x) => x.name === "GitHub")!; // saved for github.com, not this site
    s.done();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    const r = await menu.evaluate((id) => chrome.runtime.sendMessage({ type: "inlineFill", id, nonce: location.hash.slice(1) }), github.id);
    assert.deepEqual([r.ok, r.error], [false, "item not available here"]);
    assert.deepEqual(await fieldValues(), ["", ""]);
  });

  await step("default password manager: Chrome's own password saving off, then handed back", async () => {
    const set = (enabled: boolean) => page.evaluate((e) => chrome.runtime.sendMessage({ type: "setDefaultManager", enabled: e }), enabled);
    const prefs = () =>
      sw.evaluate(async () => {
        const s = chrome.privacy.services;
        const all = { passwordSaving: s.passwordSavingEnabled, address: s.autofillAddressEnabled, card: s.autofillCreditCardEnabled };
        return Object.fromEntries(await Promise.all(Object.entries(all).map(async ([k, p]) => [k, await p.get({})])));
      });
    const before = await prefs();
    const ours = Object.keys(before).filter((k) => before[k].levelOfControl === "controllable_by_this_extension");
    console.log(`    controllable here: ${ours.join(", ") || "none"} (${Object.entries(before).map(([k, v]) => `${k}=${v.levelOfControl}`).join(", ")})`);
    assert.ok(ours.length, "no Chrome autofill preference is controllable in this browser");
    assert.equal((await set(true)).ok, true);
    const on = await prefs();
    for (const k of ours) assert.deepEqual([k, on[k].value, on[k].levelOfControl], [k, false, "controlled_by_this_extension"]);
    assert.equal((await set(false)).ok, true);
    const off = await prefs();
    for (const k of ours) assert.equal(off[k].levelOfControl, "controllable_by_this_extension", k);
  });

  // ---------- Phase 4: passkeys ----------
  // The page calls WebAuthn; our approval window opens as a new page; Node verifies the results.
  const approve = async (action: (w: Page) => Promise<void>) => {
    const w = await ctx.waitForEvent("page", { predicate: (p) => p.url().includes("popup.html?passkey=") });
    await w.waitForLoadState();
    await action(w);
  };
  const challenge = randomBytes(32);
  let spki = "";

  await step("passkeys: page shim and relay are registered on every secure site", async () => {
    await unlockIfLocked();
    const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.deepEqual(scripts.map((s) => s.id).sort(), ["pw-passkey-page", "pw-passkey-relay"]);
    await loginPage.reload(); // the shim applies to new documents
  });

  await step("passkeys: create on a site, saved to the vault, attestation valid", async () => {
    const created = loginPage.evaluate(async (ch) => {
      const c = (await navigator.credentials.create({
        publicKey: {
          rp: { name: "Local app" }, user: { id: new Uint8Array([1, 2, 3, 4]), name: "pk-user", displayName: "PK User" },
          challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required" },
        },
      })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAttestationResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { proto: c instanceof PublicKeyCredential, id: c.id, clientData: new TextDecoder().decode(r.clientDataJSON), authData: b(r.getAuthenticatorData()), spki: b(r.getPublicKey()!) };
    }, [...challenge]);
    await approve(async (w) => {
      await w.getByText("Save a passkey for pk-user on Local app?").waitFor();
      await w.getByRole("button", { name: "Save passkey" }).click();
    });
    const c = await created;
    assert.ok(c.proto, "not a PublicKeyCredential");
    const cd = JSON.parse(c.clientData);
    assert.deepEqual([cd.type, cd.origin, cd.challenge], ["webauthn.create", SITE, challenge.toString("base64url")]);
    const ad = Buffer.from(c.authData, "base64");
    assert.ok(ad.subarray(0, 32).equals(createHash("sha256").update("localhost").digest()), "rpIdHash");
    assert.equal(ad[32]! & 0x45, 0x45, "UP, UV and AT flags");
    spki = c.spki;
    const s = await apiSession(vaultUser);
    const item = (await s.ciphers()).find((x) => x.login?.fido2Credentials?.length && !x.deletedDate);
    s.done();
    assert.equal(item?.login.fido2Credentials[0].rpId, "localhost");
    assert.equal(item?.login.username, "pk-user");
  });

  await step("passkeys: sign in with the stored passkey, signature verifies", async () => {
    const got = loginPage.evaluate(async (ch) => {
      const c = (await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost" } })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { clientData: b(r.clientDataJSON), authData: b(r.authenticatorData), sig: b(r.signature), user: b(r.userHandle!) };
    }, [...challenge]);
    await approve(async (w) => {
      await w.getByRole("listitem").filter({ hasText: "pk-user" }).click();
    });
    const g = await got;
    const clientData = Buffer.from(g.clientData, "base64");
    assert.equal(JSON.parse(clientData.toString()).type, "webauthn.get");
    const signed = Buffer.concat([Buffer.from(g.authData, "base64"), createHash("sha256").update(clientData).digest()]);
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    assert.ok(verify("sha256", signed, key, Buffer.from(g.sig, "base64")), "assertion signature");
    assert.deepEqual([...Buffer.from(g.user, "base64")], [1, 2, 3, 4]);
  });

  await step("passkeys: conditional mediation offers the passkey in the inline menu and signs in", async () => {
    // A passkey form: the site starts a conditional get (passkey autofill) and focuses the username field.
    await loginPage.goto(`${SITE}/login`);
    const got = loginPage.evaluate(async (ch) => {
      const pending = navigator.credentials.get({
        mediation: "conditional",
        publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost" },
      }) as Promise<PublicKeyCredential>;
      (document.getElementById("u") as HTMLInputElement).focus();
      const c = await pending;
      const r = c.response as AuthenticatorAssertionResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { clientData: b(r.clientDataJSON), authData: b(r.authenticatorData), sig: b(r.signature), user: b(r.userHandle!) };
    }, [...challenge]);
    const menu = await frameOf(loginPage, "menu.html");
    const entry = menu.getByRole("button", { name: "Sign in with passkey" });
    await entry.waitFor();
    const approval = approve(async (w) => {
      await w.getByRole("listitem").filter({ hasText: "pk-user" }).click();
    });
    await entry.click();
    await approval;
    const g = await got;
    const clientData = Buffer.from(g.clientData, "base64");
    assert.equal(JSON.parse(clientData.toString()).type, "webauthn.get");
    const signed = Buffer.concat([Buffer.from(g.authData, "base64"), createHash("sha256").update(clientData).digest()]);
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    assert.ok(verify("sha256", signed, key, Buffer.from(g.sig, "base64")), "assertion signature");
    assert.deepEqual([...Buffer.from(g.user, "base64")], [1, 2, 3, 4]);
  });

  await step("passkeys: closing the window hands the call back to the browser", async () => {
    // An empty virtual authenticator without UI makes the browser's own WebAuthn fail at once (headless
    // Chromium otherwise sometimes waits for UI that never comes).
    const cdp = await ctx.newCDPSession(loginPage);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
    const got = loginPage.evaluate(async (ch) => {
      try {
        await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost", timeout: 1000 } });
        return "resolved";
      } catch (e) {
        return (e as DOMException).name;
      }
    }, [...challenge]);
    await approve((w) => w.close());
    // The browser's own WebAuthn (the virtual authenticator has no credential) refuses.
    assert.equal(await got, "NotAllowedError");
    await cdp.detach();
  });

  // ---------- Phase 4: SSO (mock IdP from docker-compose.yml) ----------
  const ssoUser = await register("sso", [1, 3, 64, 4]);

  await step("SSO: IdP login, connector tab closes itself, vault unlocks with the master password", async () => {
    await fetch("http://localhost:9090/_next", { method: "POST", body: JSON.stringify({ email: ssoUser.email }) });
    await logout();
    const tab = ctx.waitForEvent("page") // the SSO tab (its URL is still about:blank or mid-redirect here);
    await click("Log in with SSO");
    const t = await tab;
    await t.waitForEvent("close", { timeout: 20_000 }); // finishSso closes it after redeeming the code
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.ok((await page.locator("#app").innerText()).includes(ssoUser.email));
    await fill("Master password", ssoUser.password);
    await click("Unlock");
    await expectUnlocked();
    const session = await sw.evaluate(() => chrome.storage.session.get("session"));
    assert.equal((session.session as { sso?: unknown }).sso, undefined, "SSO state left behind");
    assert.equal((await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ["pw-sso-callback"] }))).length, 0);
  });

  await step("SSO: a callback with a foreign state is refused", async () => {
    await logout();
    const tab = ctx.waitForEvent("page") // the SSO tab (its URL is still about:blank or mid-redirect here);
    await click("Log in with SSO");
    const t = await tab;
    // Replace our pending state, as if the callback belonged to someone else's login.
    await sw.evaluate(async () => {
      const s = (await chrome.storage.session.get("session")).session as Record<string, any>;
      await chrome.storage.session.set({ session: { ...s, sso: { ...s.sso, state: "other:clientId=browser" } } });
    });
    await t.waitForEvent("close", { timeout: 20_000 });
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "did not come from this browser" }).waitFor();
  });

  console.log(`\n${passed.length} steps passed (${await ctx.browser()?.version() ?? "persistent context"})`);
} finally {
  await ctx.close();
  site.close();
  rmSync(profile, { recursive: true, force: true });
}
