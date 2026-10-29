// Decrypted vault held in the crypto worker's memory. Dropped when the worker is terminated (lock).
import * as core from "../../dist/wasm/core_wasm.js";
import type { Folder, PasskeyCandidate, SendItem, VaultItem, VaultList } from "../shared/messages.ts";
import { ci } from "../shared/validate.ts";
import { Psl, uriMatches } from "../autofill/match.ts";
import * as fido2 from "./fido2.ts";

type Json = Record<string, unknown>;

let ciphers: Map<string, Json> | undefined;
let folders: Folder[] = [];
let collections: Folder[] = [];
let organizations: Folder[] = [];
let sends = new Map<string, Json>();

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const o = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

/** Trashed items: shown only in the trash view, never matched or filled. */
let trash = new Map<string, Json>();

function put(c: Json): void {
  const id = s(ci(c, "id"));
  ciphers!.delete(id);
  trash.delete(id);
  (ci(c, "deletedDate") ? trash : ciphers!).set(id, c);
}

export function loadVault(encCiphers: unknown[], encFolders: unknown[], encSends: unknown[], orgKeys: Record<string, string>, encCollections: unknown[], orgs: Folder[]): void {
  if (Object.keys(orgKeys).length) core.setOrgKeys(JSON.stringify(orgKeys));
  const r = JSON.parse(core.decryptCipherList(JSON.stringify(encCiphers))) as { ciphers: Json[]; failed: { id: string }[] };
  ciphers = new Map();
  trash = new Map();
  for (const c of r.ciphers) put(c);
  // Keep undecryptable items visible instead of silently hiding them.
  for (const f of r.failed) ciphers.set(f.id, { id: f.id, type: 0, name: "", failed: true });
  const fr = JSON.parse(core.decryptFolders(JSON.stringify(encFolders))) as { folders: Json[] };
  const sr = JSON.parse(core.decryptSendList(JSON.stringify(encSends))) as { sends: Json[]; failed: { id: string }[] };
  sends = new Map([...sr.sends, ...sr.failed.map((f) => ({ id: f.id, failed: true }))].map((x) => [s(ci(x, "id")), x]));
  const named = (r: { folders: Json[] }) => r.folders.map((f) => ({ id: s(ci(f, "id")), name: s(ci(f, "name")) })).sort((a, b) => a.name.localeCompare(b.name));
  folders = named(fr);
  // Collection names use their organization's key (decryptFolders picks it by organizationId).
  collections = named(JSON.parse(core.decryptFolders(JSON.stringify(encCollections))) as { folders: Json[] });
  organizations = orgs;
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
  const sorted = (m: Map<string, Json>) => [...m.values()].map(summary).sort((a, b) => a.name.localeCompare(b.name));
  return { items: sorted(ciphers), folders, trash: sorted(trash), organizations, collections };
}

function get(id: string): Json {
  const c = ciphers?.get(id) ?? trash.get(id);
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

const gen = (options: Json) => core.generatePassword(JSON.stringify(options));
/** `n` random characters from a-z0-9 (or 0-9), from the core CSPRNG generator (minimum length 5). */
const randomChars = (n: number, digitsOnly = false) =>
  gen({ length: Math.max(n, 5), lowercase: !digitsOnly, uppercase: false, numbers: true, special: false, minNumber: 0 }).slice(0, n);

/** Passwords and passphrases come from core; usernames (Bitwarden's word / plus-addressed / catch-all) are built on it. */
export function generate(o: Json): string {
  if (o.type !== "username") return gen(o);
  if (o.usernameType === "plus") {
    const email = s(o.email).trim();
    const at = email.lastIndexOf("@");
    if (at < 1 || at === email.length - 1) throw new Error("Enter an email address");
    return `${email.slice(0, at)}+${randomChars(8)}${email.slice(at)}`;
  }
  if (o.usernameType === "catchall") {
    const domain = s(o.domain).trim().replace(/^@/, "");
    if (!domain) throw new Error("Enter a domain");
    return `${randomChars(8)}@${domain}`;
  }
  // Space never occurs in the EFF word list, so the first word comes out whole.
  const word = gen({ type: "passphrase", numWords: 3, wordSeparator: " ", capitalize: o.capitalize === true }).split(" ")[0]!;
  return o.includeNumber === true ? word + randomChars(4, true) : word;
}

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

/** `totp` is the current code, for copying after the fill. */
/** User-key strings (a failed one comes back empty). */
export function decryptText(values: string[]): string[] {
  const r = JSON.parse(core.decryptFolders(JSON.stringify(values.map((name, i) => ({ id: String(i), name }))))) as { folders: Json[] };
  const plain = new Map(r.folders.map((f) => [s(ci(f, "id")), s(ci(f, "name"))]));
  return values.map((_, i) => plain.get(String(i)) ?? "");
}

export function fillData(id: string): { username: string; password: string; totp?: string } {
  const login = o(ci(get(id), "login"));
  const secret = s(ci(login, "totp"));
  return { username: s(ci(login, "username")), password: s(ci(login, "password")), ...(secret ? { totp: JSON.parse(core.totp(secret, Date.now())).code as string } : {}) };
}

// ---------- Import / export (Bitwarden's unencrypted JSON format) ----------

const EXPORT_KEYS = ["id", "folderId", "type", "reprompt", "name", "notes", "favorite", "login", "secureNote", "card", "identity", "sshKey", "fields", "passwordHistory", "revisionDate", "creationDate"];

/** Personal items (not the trash, not organization items) and folders, like the official individual export. */
export function exportJson(): string {
  if (!ciphers) throw new Error("vault not loaded");
  const items = [...ciphers.values()]
    .filter((c) => !c.failed && !ci(c, "organizationId"))
    .map((c) => ({ ...Object.fromEntries(EXPORT_KEYS.map((k) => [k, ci(c, k) ?? null])), organizationId: null, collectionIds: null, deletedDate: null }));
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}

export interface ImportRequest {
  ciphers: Json[];
  folders: { name: string }[];
  folderRelationships: { key: number; value: number }[];
  skipped: number;
}

/** Parses an unencrypted Bitwarden JSON export and encrypts it for POST /api/ciphers/import. */
export function prepareImport(text: string): ImportRequest {
  let data: Json | undefined;
  try {
    data = o(JSON.parse(text));
  } catch {
    /* reported below */
  }
  if (!data || data.encrypted === true || !Array.isArray(data.items)) throw new Error("This is not an unencrypted Bitwarden JSON export");
  const srcFolders = (Array.isArray(data.folders) ? data.folders : []).map(o).filter((f): f is Json => typeof f?.name === "string");
  const folderIndex = new Map(srcFolders.map((f, i) => [s(f.id), i]));
  const out: ImportRequest = { ciphers: [], folders: srcFolders.map((f) => ({ name: s(prepareSave({ type: 2, name: f.name }).name) })), folderRelationships: [], skipped: 0 };
  for (const raw of data.items) {
    const item = o(raw);
    const type = Number(item?.type);
    if (!item || ![1, 2, 3, 4, 5].includes(type) || typeof item.name !== "string") {
      out.skipped++;
      continue;
    }
    // Server-assigned fields are dropped; the item lands in the personal vault.
    const { id: _id, folderId, organizationId: _org, collectionIds: _coll, revisionDate: _rev, creationDate: _cr, deletedDate: _del, attachments: _att, key: _key, ...rest } = item;
    const fi = folderIndex.get(s(folderId));
    if (fi !== undefined) out.folderRelationships.push({ key: out.ciphers.length, value: fi });
    out.ciphers.push(JSON.parse(core.encryptCipher(JSON.stringify({ ...rest, type }))) as Json);
  }
  return out;
}

// ---------- Attachments ----------

export const decryptAttachment = (cipherId: string, attachmentId: string, data: string): string =>
  core.decryptAttachment(JSON.stringify(get(cipherId)), attachmentId, Uint8Array.fromBase64(data)).toBase64();

/** Personal items only, like editing. Result: { key, fileName, data } for the upload. */
export function encryptAttachment(cipherId: string, fileName: string, data: string): Json {
  const c = get(cipherId);
  if (ci(c, "organizationId")) throw new Error("organization items are read-only");
  return JSON.parse(core.encryptAttachment(JSON.stringify(c), fileName, Uint8Array.fromBase64(data))) as Json;
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

/** A send with an `id` is an edit: the changes go on top of the stored send, with its key (the link stays). */
export function prepareSend(send: Json): Json {
  const id = s(ci(send, "id"));
  let plain = send;
  if (id) {
    const cur = sends.get(id);
    if (!cur || cur.failed) throw new Error("send not found");
    // The stored password is the server's hash: never hash it again. No new password keeps it server-side.
    const { password: _hash, ...rest } = cur;
    plain = { ...rest, ...send };
  }
  return JSON.parse(core.encryptSend(JSON.stringify(plain))) as Json;
}

export const encryptSendFile = (key: string, data: string): string => core.encryptSendFile(key, Uint8Array.fromBase64(data)).toBase64();

export function upsertSend(enc: Json): void {
  const r = JSON.parse(core.decryptSendList(JSON.stringify([enc]))) as { sends: Json[] };
  for (const x of r.sends) sends.set(s(ci(x, "id")), x);
}

export const removeSend = (id: string): void => void sends.delete(id);

// ---------- Passkeys ----------


const checkRp = async (rpId: string, origin: string) => {
  const p = await getPsl();
  fido2.checkRpId(rpId, origin, (d) => p.isPublicSuffix(d));
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

// ---------- card / identity fill ----------

/** Values keyed by HTML autocomplete token, for fillForm in the page. */
export function formValues(id: string): Record<string, string> {
  const c = get(id);
  const type = Number(ci(c, "type"));
  const f = (k: string, obj: Json | undefined) => s(ci(obj, k));
  if (type === 3) {
    const card = o(ci(c, "card"));
    const mm = f("expMonth", card).padStart(2, "0");
    const yyyy = f("expYear", card);
    return {
      "cc-name": f("cardholderName", card),
      "cc-number": f("number", card),
      "cc-csc": f("code", card),
      "cc-type": f("brand", card),
      "cc-exp-month": f("expMonth", card) ? mm : "",
      "cc-exp-year": yyyy,
      "cc-exp": f("expMonth", card) && yyyy ? `${mm}/${yyyy.slice(-2)}` : "",
    };
  }
  if (type === 4) {
    const i = o(ci(c, "identity"));
    const lines = ["address1", "address2", "address3"].map((k) => f(k, i)).filter(Boolean);
    return {
      name: [f("firstName", i), f("middleName", i), f("lastName", i)].filter(Boolean).join(" "),
      "given-name": f("firstName", i),
      "additional-name": f("middleName", i),
      "family-name": f("lastName", i),
      email: f("email", i),
      tel: f("phone", i),
      organization: f("company", i),
      username: f("username", i),
      "street-address": lines.join("\n"),
      "address-line1": f("address1", i),
      "address-line2": f("address2", i),
      "address-line3": f("address3", i),
      "address-level2": f("city", i),
      "address-level1": f("state", i),
      "postal-code": f("postalCode", i),
      country: f("country", i),
      "country-name": f("country", i),
    };
  }
  throw new Error("not a card or identity");
}
