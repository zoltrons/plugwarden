// Decrypted vault held in the crypto worker's memory. Dropped when the worker is terminated (lock).
import * as core from "../../dist/wasm/core_wasm.js";
import type { Folder, PasskeyCandidate, SendItem, VaultItem, VaultList } from "../shared/messages.ts";
import { ci } from "../shared/validate.ts";
import { Psl, uriMatches } from "../autofill/match.ts";
import * as fido2 from "./fido2.ts";

type Json = Record<string, unknown>;

let ciphers: Map<string, Json> | undefined;
let folders: Folder[] = [];
let sends = new Map<string, Json>();

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const o = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function put(c: Json): void {
  const id = s(ci(c, "id"));
  if (ci(c, "deletedDate")) ciphers!.delete(id); // trash is not shown in Phase 2
  else ciphers!.set(id, c);
}

export function loadVault(encCiphers: unknown[], encFolders: unknown[], encSends: unknown[], orgKeys: Record<string, string>): void {
  if (Object.keys(orgKeys).length) core.setOrgKeys(JSON.stringify(orgKeys));
  const r = JSON.parse(core.decryptCipherList(JSON.stringify(encCiphers))) as { ciphers: Json[]; failed: { id: string }[] };
  ciphers = new Map();
  for (const c of r.ciphers) put(c);
  // Keep undecryptable items visible instead of silently hiding them.
  for (const f of r.failed) ciphers.set(f.id, { id: f.id, type: 0, name: "", failed: true });
  const fr = JSON.parse(core.decryptFolders(JSON.stringify(encFolders))) as { folders: Json[] };
  const sr = JSON.parse(core.decryptSendList(JSON.stringify(encSends))) as { sends: Json[]; failed: { id: string }[] };
  sends = new Map([...sr.sends, ...sr.failed.map((f) => ({ id: f.id, failed: true }))].map((x) => [s(ci(x, "id")), x]));
  folders = fr.folders.map((f) => ({ id: s(ci(f, "id")), name: s(ci(f, "name")) })).sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertCipher(enc: Json): void {
  if (!ciphers) throw new Error("vault not loaded");
  put(JSON.parse(core.decryptCipher(JSON.stringify(enc))) as Json);
}

export function removeCipher(id: string): void {
  ciphers?.delete(id);
}

function summary(c: Json): VaultItem {
  const type = Number(ci(c, "type"));
  const login = o(ci(c, "login"));
  const sub =
    type === 1 ? s(ci(login, "username"))
    : type === 2 ? s(ci(c, "notes")).split("\n", 1)[0]!.slice(0, 80)
    : type === 3 ? s(ci(o(ci(c, "card")), "cardholderName"))
    : type === 4 ? [ci(o(ci(c, "identity")), "firstName"), ci(o(ci(c, "identity")), "lastName")].map(s).join(" ").trim()
    : type === 5 ? s(ci(o(ci(c, "sshKey")), "keyFingerprint"))
    : "";
  const uris = (Array.isArray(ci(login, "uris")) ? (ci(login, "uris") as unknown[]) : []).map((u) => s(ci(u, "uri"))).filter(Boolean);
  return {
    id: s(ci(c, "id")),
    type,
    name: s(ci(c, "name")),
    sub,
    uris,
    folderId: s(ci(c, "folderId")) || undefined,
    favorite: ci(c, "favorite") === true,
    readOnly: !!ci(c, "organizationId") || ci(c, "edit") === false,
    hasTotp: !!s(ci(login, "totp")),
    ...(c.failed ? { failed: true } : {}),
  };
}

export function listVault(): VaultList | null {
  if (!ciphers) return null;
  const items = [...ciphers.values()].map(summary).sort((a, b) => a.name.localeCompare(b.name));
  return { items, folders };
}

function get(id: string): Json {
  const c = ciphers?.get(id);
  if (!c) throw new Error("item not found");
  return c;
}

/** Full decrypted item (incl. secrets) for the item view / edit form. */
export const getCipher = (id: string): Json => get(id);

/**
 * Encrypts an edited/new personal Login or Note. Mirrors the official clients: a changed password is
 * pushed to passwordHistory (max 5), and edits carry lastKnownRevisionDate so the server refuses
 * to overwrite a newer copy.
 */
export function prepareSave(item: Json): Json {
  const id = s(item.id);
  const existing = id ? get(id) : undefined;
  if (existing && summary(existing).readOnly) throw new Error("item is read-only");
  if (existing && Number(item.type) === 1) {
    const oldPw = s(ci(o(ci(existing, "login")), "password"));
    const login = o(item.login);
    if (login && oldPw && oldPw !== s(login.password)) {
      const now = new Date().toISOString();
      const history = Array.isArray(ci(existing, "passwordHistory")) ? (ci(existing, "passwordHistory") as unknown[]) : [];
      item.passwordHistory = [{ password: oldPw, lastUsedDate: now }, ...history].slice(0, 5);
      login.passwordRevisionDate = now;
    }
  }
  const enc = JSON.parse(core.encryptCipher(JSON.stringify(item))) as Json;
  if (existing) enc.lastKnownRevisionDate = ci(existing, "revisionDate");
  return enc;
}

export function totp(id: string): { code: string; period: number; remaining: number } {
  const secret = s(ci(o(ci(get(id), "login")), "totp"));
  if (!secret) throw new Error("item has no TOTP");
  return JSON.parse(core.totp(secret, Date.now()));
}

export const generate = (options: Json): string => core.generatePassword(JSON.stringify(options));

let psl: Psl | undefined;

// Loaded on first use only: ~170 KB of rules that the worker otherwise never needs.
async function getPsl(): Promise<Psl> {
  psl ??= new Psl((await (await fetch(new URL("psl.json", import.meta.url))).json()) as string[]);
  return psl;
}

/** Personal and org logins whose URIs match `url` (Bitwarden match types, default Domain). */
export async function matchUri(url: string): Promise<VaultItem[]> {
  if (!ciphers) throw new Error("vault not loaded");
  await getPsl();
  const page = new URL(url);
  return [...ciphers.values()]
    .filter((c) => Number(ci(c, "type")) === 1)
    .filter((c) => {
      const uris = ci(o(ci(c, "login")), "uris");
      return Array.isArray(uris) && uris.some((u) => uriMatches(s(ci(u, "uri")), ci(u, "match") as number | null, page, psl!));
    })
    .map(summary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function fillData(id: string): { username: string; password: string } {
  const login = o(ci(get(id), "login"));
  return { username: s(ci(login, "username")), password: s(ci(login, "password")) };
}

// ---------- Send ----------

export type SendEntry = Omit<SendItem, "link"> & { accessId: string; urlKey: string };

/** List entries without the text/file content. The service worker turns accessId + urlKey into the link. */
export function listSends(): SendEntry[] {
  return [...sends.values()]
    .map((x) => ({
      id: s(ci(x, "id")),
      type: Number(ci(x, "type")),
      name: s(ci(x, "name")),
      accessId: s(ci(x, "accessId")),
      urlKey: s(ci(x, "urlKey")),
      deletionDate: s(ci(x, "deletionDate")),
      hasPassword: !!ci(x, "password"),
      disabled: ci(x, "disabled") === true,
      accessCount: Number(ci(x, "accessCount") ?? 0),
      maxAccessCount: typeof ci(x, "maxAccessCount") === "number" ? (ci(x, "maxAccessCount") as number) : undefined,
      ...(x.failed ? { failed: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const prepareSend = (send: Json): Json => JSON.parse(core.encryptSend(JSON.stringify(send))) as Json;

export const encryptSendFile = (key: string, data: string): string => core.encryptSendFile(key, Uint8Array.fromBase64(data)).toBase64();

export function upsertSend(enc: Json): void {
  const r = JSON.parse(core.decryptSendList(JSON.stringify([enc]))) as { sends: Json[] };
  for (const x of r.sends) sends.set(s(ci(x, "id")), x);
}

export const removeSend = (id: string): void => void sends.delete(id);

// ---------- Passkeys ----------


const checkRp = async (rpId: string, origin: string) => {
  const p = await getPsl();
  fido2.checkRpId(rpId, origin, (d) => p.baseDomain(`x.${d}`) === `x.${d}`);
};

/** Stored passkeys for `rpId`; with `ids` (base64url) only those, otherwise only discoverable ones. */
export async function passkeyCandidates(rpId: string, origin: string, ids: string[]): Promise<PasskeyCandidate[]> {
  if (!ciphers) throw new Error("vault not loaded");
  await checkRp(rpId, origin);
  const out: PasskeyCandidate[] = [];
  for (const c of ciphers.values()) {
    const creds = ci(o(ci(c, "login")), "fido2Credentials");
    if (Number(ci(c, "type")) !== 1 || !Array.isArray(creds)) continue;
    for (const cred of creds) {
      if (s(ci(cred, "rpId")) !== rpId) continue;
      let id: string;
      try {
        id = fido2.b64u(fido2.credentialIdBytes(s(ci(cred, "credentialId"))));
      } catch {
        continue;
      }
      if (ids.length ? !ids.includes(id) : s(ci(cred, "discoverable")) === "false") continue;
      out.push({ itemId: s(ci(c, "id")), name: s(ci(c, "name")), userName: s(ci(cred, "userName")), credentialId: id });
    }
  }
  return out;
}

export async function passkeyAssert(itemId: string, credentialId: string, rpId: string, origin: string, challenge: string) {
  await checkRp(rpId, origin);
  const creds = ci(o(ci(get(itemId), "login")), "fido2Credentials");
  const cred = (Array.isArray(creds) ? creds : []).find(
    (x) => s(ci(x, "rpId")) === rpId && fido2.b64u(fido2.credentialIdBytes(s(ci(x, "credentialId")))) === credentialId,
  );
  if (!cred) throw new Error("passkey not found");
  return fido2.assert(cred as Json, origin, challenge);
}

export async function passkeyCreate(input: fido2.CreateInput) {
  await checkRp(input.rpId, input.origin);
  return fido2.createCredential(input);
}
