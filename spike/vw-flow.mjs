#!/usr/bin/env node
// Phase 0: raw fetch against a local Vaultwarden using the pruned core-wasm (register build).
//   node spike/vw-flow.mjs [baseUrl] [wasmDir]
// register -> prelogin -> token -> unlock -> create cipher -> sync/decrypt -> edit -> refresh -> delete
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? "http://localhost:8080";
const wasmDir = process.argv[3] ?? join(root, "dist/wasm-register");

const wasm = await import(pathToFileURL(join(wasmDir, "core_wasm.js")).href);
await wasm.default({ module_or_path: readFileSync(join(wasmDir, "core_wasm_bg.wasm")) });
if (!wasm.makeRegistrationKeys) throw new Error("needs the `register` feature build");

const CLIENT = { name: "browser", version: "2026.10.1", deviceType: "2" };
const headers = (extra = {}) => ({
  "Bitwarden-Client-Name": CLIENT.name,
  "Bitwarden-Client-Version": CLIENT.version,
  "Device-Type": CLIENT.deviceType,
  Accept: "application/json",
  ...extra,
});
const log = (...a) => console.log(...a);
const keys = (o) => (o && typeof o === "object" ? Object.keys(o).join(",") : typeof o);
// Case-insensitive property read: Vaultwarden mixes PascalCase (token response) and camelCase.
const ci = (o, k) => o?.[Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase())];

async function call(method, path, { json, form, token } = {}) {
  const h = headers(token ? { Authorization: `Bearer ${token}` } : {});
  let body;
  if (json !== undefined) (h["Content-Type"] = "application/json"), (body = JSON.stringify(json));
  if (form) (h["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"), (body = new URLSearchParams(form));
  const t = performance.now();
  const res = await fetch(BASE + path, { method, headers: h, body });
  const ms = Math.round(performance.now() - t);
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  log(`  ${method} ${path} ${res.status} ${ms}ms`);
  return data;
}

async function flow(u) {
  const email = `${u.emailPrefix}-${randomBytes(4).toString("hex")}@example.test`;
  const [kdfType, iterations, memory, parallelism] = u.kdf;
  log(`\n== ${u.label} (${email})`);

  // Register
  const verifyToken = await call("POST", "/identity/accounts/register/send-verification-email", { json: { email, name: u.label } });
  let mk = wasm.deriveMasterKey(u.password, email, ...u.kdf);
  const reg = JSON.parse(wasm.makeRegistrationKeys(mk));
  await call("POST", "/identity/accounts/register/finish", {
    json: {
      email, emailVerificationToken: verifyToken,
      masterPasswordHash: wasm.makeAuthHash(mk, u.password, false), key: reg.key,
      kdf: kdfType, kdfIterations: iterations,
      kdfMemory: kdfType === 1 ? memory : null, kdfParallelism: kdfType === 1 ? parallelism : null,
      userAsymmetricKeys: { publicKey: reg.publicKey, encryptedPrivateKey: reg.encryptedPrivateKey },
    },
  });
  wasm.freeMasterKey(mk);

  // Prelogin (as a fresh client would)
  const pre = await call("POST", "/identity/accounts/prelogin", { json: { email } });
  log("  prelogin keys:", keys(pre));
  const kdf = [ci(pre, "kdf"), ci(pre, "kdfIterations"), ci(pre, "kdfMemory") ?? 0, ci(pre, "kdfParallelism") ?? 0];
  if (String(kdf) !== String(u.kdf)) throw new Error(`prelogin kdf ${kdf} != ${u.kdf}`);

  // Token
  let t = performance.now();
  mk = wasm.deriveMasterKey(u.password, email, ...kdf);
  const kdfMs = Math.round(performance.now() - t);
  const deviceId = randomUUID();
  const tok = await call("POST", "/identity/connect/token", {
    form: {
      grant_type: "password", username: email, password: wasm.makeAuthHash(mk, u.password, false),
      scope: "api offline_access", client_id: CLIENT.name,
      deviceType: CLIENT.deviceType, deviceIdentifier: deviceId, deviceName: "chrome",
    },
  });
  log("  token keys:", keys(tok));
  log("  token.UserDecryptionOptions:", JSON.stringify(ci(tok, "UserDecryptionOptions")));

  // Unlock
  t = performance.now();
  wasm.unlockUserKey(mk, ci(tok, "Key"), ci(tok, "PrivateKey"));
  log(`  kdf ${kdfMs}ms, unlock ${Math.round(performance.now() - t)}ms`);
  // Vaultwarden >= 1.34 (web-v2025.6.0 protocol) requires `encryptedFor` = user id on cipher writes.
  const userId = JSON.parse(Buffer.from(ci(tok, "access_token").split(".")[1], "base64url")).sub;
  const forUser = (c) => ({ ...c, encryptedFor: userId });

  // Create cipher
  const plain = {
    type: 1, name: "Example login", notes: "Ünïcödé note ✓", favorite: false, reprompt: 0,
    folderId: null, organizationId: null,
    login: { username: "alice@example.com", password: "s3cr3t-🔑", totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
      uris: [{ uri: "https://example.com/login", match: null }] },
    fields: [{ name: "PIN", value: "1234", type: 1, linkedId: null }],
  };
  const created = await call("POST", "/api/ciphers", { json: forUser(JSON.parse(wasm.encryptCipher(JSON.stringify(plain)))), token: ci(tok, "access_token") });
  const id = ci(created, "id");
  log("  cipher response keys:", keys(created));

  // Sync + decrypt
  const sync = await call("GET", "/api/sync?excludeDomains=true", { token: ci(tok, "access_token") });
  log("  sync keys:", keys(sync), "| userDecryption:", JSON.stringify(ci(sync, "userDecryption")));
  const dec = JSON.parse(wasm.decryptCipherList(JSON.stringify(ci(sync, "ciphers"))));
  const got = dec.ciphers.find((c) => ci(c, "id") === id);
  const same = got && got.name === plain.name && got.notes === plain.notes && got.login.password === plain.login.password &&
    got.login.uris[0].uri === plain.login.uris[0].uri && got.fields[0].value === plain.fields[0].value;
  if (!same || dec.failed.length) throw new Error(`decrypt mismatch: ${JSON.stringify({ got, failed: dec.failed })}`);
  log("  decrypted round trip OK; totp:", JSON.parse(wasm.totp(got.login.totp, Date.now())).code);

  // Edit
  const edited = { ...got, name: "Edited login", login: { ...got.login, password: "n3w-p4ss" } };
  await call("PUT", `/api/ciphers/${id}`, { json: forUser(JSON.parse(wasm.encryptCipher(JSON.stringify(edited)))), token: ci(tok, "access_token") });
  const one = await call("GET", `/api/ciphers/${id}`, { token: ci(tok, "access_token") });
  const d1 = JSON.parse(wasm.decryptCipher(JSON.stringify(one)));
  if (d1.name !== "Edited login" || d1.login.password !== "n3w-p4ss") throw new Error("edit mismatch");
  log("  edit OK");

  // Refresh token
  const ref = await call("POST", "/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: CLIENT.name, refresh_token: ci(tok, "refresh_token") },
  });
  log("  refresh keys:", keys(ref));
  const rev = await call("GET", "/api/accounts/revision-date", { token: ci(ref, "access_token") });
  log("  revision-date:", rev);

  // Delete (hard)
  await call("DELETE", `/api/ciphers/${id}`, { token: ci(ref, "access_token") });
  const after = await call("GET", "/api/sync?excludeDomains=true", { token: ci(ref, "access_token") });
  if (ci(after, "ciphers").some((c) => ci(c, "id") === id)) throw new Error("delete did not remove cipher");
  log("  delete OK");
  wasm.lock();
  return { label: u.label, email, kdfMs };
}

const cfg = await call("GET", "/api/config");
log("server:", JSON.stringify(cfg.server), "version:", cfg.version);
const fixture = JSON.parse(readFileSync(join(root, "dev/vaultwarden/test-users.json"), "utf8"));
const results = [];
for (const u of fixture.users) results.push(await flow(u));
log("\nALL OK", JSON.stringify(results));
