// Decrypted vault held in the crypto worker's memory. Dropped when the worker is terminated (lock).
import * as core from "../../dist/wasm/core_wasm.js";
import type { Folder, VaultItem, VaultList } from "../shared/messages.ts";
import { ci } from "../shared/validate.ts";

type Json = Record<string, unknown>;

let ciphers: Map<string, Json> | undefined;
let folders: Folder[] = [];

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const o = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function put(c: Json): void {
  const id = s(ci(c, "id"));
  if (ci(c, "deletedDate")) ciphers!.delete(id); // trash is not shown in Phase 2
  else ciphers!.set(id, c);
}

export function loadVault(encCiphers: unknown[], encFolders: unknown[], orgKeys: Record<string, string>): void {
  if (Object.keys(orgKeys).length) core.setOrgKeys(JSON.stringify(orgKeys));
  const r = JSON.parse(core.decryptCipherList(JSON.stringify(encCiphers))) as { ciphers: Json[]; failed: { id: string }[] };
  ciphers = new Map();
  for (const c of r.ciphers) put(c);
  // Keep undecryptable items visible instead of silently hiding them.
  for (const f of r.failed) ciphers.set(f.id, { id: f.id, type: 0, name: "", failed: true });
  const fr = JSON.parse(core.decryptFolders(JSON.stringify(encFolders))) as { folders: Json[] };
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
