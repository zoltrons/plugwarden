// Typed message bus. Every message crossing a context boundary is validated on receipt.
//   popup  --Request-->  service worker  --OffscreenRequest-->  offscreen doc  --postMessage-->  worker
import { AUTO_LOCK_CHOICES } from "./constants.ts";
import { arr, bool, literal, num, obj, opt, record, str, unknownValue, type Validator, ValidationError } from "./validate.ts";

// ---------- popup -> service worker ----------

export type Request =
  | { type: "getState" }
  | { type: "setServer"; url: string }
  | { type: "login"; email: string; password: string }
  | { type: "twoFactorSubmit"; provider: number; token: string; remember: boolean }
  | { type: "twoFactorSendEmail" }
  | { type: "twoFactorCancel" }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "logout" }
  | { type: "setSettings"; autoLockMinutes?: number; lockOnSystemLock?: boolean }
  // vault (unlocked only)
  | { type: "vaultList" }
  | { type: "sync"; force: boolean }
  | { type: "getItem"; id: string }
  | { type: "saveItem"; item: Record<string, unknown> }
  | { type: "deleteItem"; id: string }
  | { type: "totp"; id: string }
  | { type: "generate"; options: Record<string, unknown> }
  | { type: "clipboardCopied" };

const requestValidators: { [K in Request["type"]]: Validator<Extract<Request, { type: K }>> } = {
  getState: obj({ type: literal("getState") }),
  setServer: obj({ type: literal("setServer"), url: str }),
  login: obj({ type: literal("login"), email: str, password: str }),
  twoFactorSubmit: obj({ type: literal("twoFactorSubmit"), provider: num, token: str, remember: bool }),
  twoFactorSendEmail: obj({ type: literal("twoFactorSendEmail") }),
  twoFactorCancel: obj({ type: literal("twoFactorCancel") }),
  unlock: obj({ type: literal("unlock"), password: str }),
  lock: obj({ type: literal("lock") }),
  logout: obj({ type: literal("logout") }),
  setSettings: (v, p) => {
    const s = obj({ type: literal("setSettings"), autoLockMinutes: opt(num), lockOnSystemLock: opt(bool) })(v, p);
    if (s.autoLockMinutes !== undefined && !(AUTO_LOCK_CHOICES as readonly number[]).includes(s.autoLockMinutes))
      throw new ValidationError("autoLockMinutes: not an allowed choice");
    return s;
  },
  vaultList: obj({ type: literal("vaultList") }),
  sync: obj({ type: literal("sync"), force: bool }),
  getItem: obj({ type: literal("getItem"), id: str }),
  saveItem: (v, p) => {
    const s = obj({ type: literal("saveItem"), item: record })(v, p);
    // Phase 2 edits personal Login (1) and Secure note (2) items only.
    if (![1, 2].includes(s.item.type as number)) throw new ValidationError("item.type: only login and note can be edited");
    if (typeof s.item.name !== "string" || !s.item.name.trim()) throw new ValidationError("item.name: required");
    if (s.item.organizationId) throw new ValidationError("organization items are read-only");
    return s;
  },
  deleteItem: obj({ type: literal("deleteItem"), id: str }),
  totp: obj({ type: literal("totp"), id: str }),
  generate: obj({ type: literal("generate"), options: record }),
  clipboardCopied: obj({ type: literal("clipboardCopied") }),
};

export function parseRequest(v: unknown): Request {
  const type = (v as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !Object.hasOwn(requestValidators, type)) throw new ValidationError("unknown message type");
  return requestValidators[type as Request["type"]](v, "");
}

export type Phase = "setup" | "loggedOut" | "twoFactor" | "locked" | "unlocked";

export interface TwoFactorChallenge {
  providers: number[];
  emailHint?: string;
}

export interface Settings {
  autoLockMinutes: number;
  lockOnSystemLock: boolean;
}

export interface State {
  phase: Phase;
  serverUrl?: string;
  serverVersion?: string;
  email?: string;
  twoFactor?: TwoFactorChallenge;
  settings: Settings;
}

/** Decrypted list entry. No passwords, TOTP secrets or notes beyond a one-line preview. */
export interface VaultItem {
  id: string;
  type: number;
  name: string;
  sub: string;
  uris: string[];
  folderId?: string;
  favorite: boolean;
  readOnly: boolean;
  hasTotp: boolean;
  failed?: boolean;
}

export interface Folder {
  id: string;
  name: string;
}

export interface VaultList {
  items: VaultItem[];
  folders: Folder[];
  syncedAt?: number;
}

export type Response<T = State> = { ok: true; data: T } | { ok: false; error: string; code?: ErrorCode };

export type ErrorCode =
  | "invalid"
  | "network"
  | "permission"
  | "badServer"
  | "badCredentials"
  | "badTwoFactor"
  | "wrongPassword"
  | "sessionExpired"
  | "wrongPhase";

// ---------- service worker -> offscreen -> worker ----------

export interface KdfParams {
  type: number;
  iterations: number;
  memory: number;
  parallelism: number;
}

// prepareKey derives the master key once and caches its server auth hash next to it in the worker,
// so a 2FA round trip does not need the password again. Result: { handle, authHash }.
export type CoreRequest =
  | { op: "prepareKey"; email: string; password: string; kdf: KdfParams }
  | { op: "authHash"; handle: number }
  | { op: "unlock"; handle: number; protectedUserKey: string; encryptedPrivateKey?: string }
  | { op: "freeKey"; handle: number }
  | { op: "lock" }
  | { op: "status" }
  // vault: the worker keeps the decrypted vault in memory
  | { op: "loadVault"; ciphers: unknown[]; folders: unknown[]; orgKeys: Record<string, string> }
  | { op: "upsertCipher"; cipher: Record<string, unknown> }
  | { op: "removeCipher"; id: string }
  | { op: "listVault" }
  | { op: "getCipher"; id: string }
  | { op: "prepareSave"; item: Record<string, unknown> }
  | { op: "totp"; id: string }
  | { op: "generate"; options: Record<string, unknown> }
  // handled by the offscreen document itself, not the worker
  | { op: "clearClipboard" };

export type CoreResult = { ok: true; value: unknown } | { ok: false; error: string };

export const OFFSCREEN_TARGET = "plugwarden-offscreen";

export const kdfParams: Validator<KdfParams> = obj({ type: num, iterations: num, memory: num, parallelism: num });

const coreValidators: { [K in CoreRequest["op"]]: Validator<Extract<CoreRequest, { op: K }>> } = {
  prepareKey: obj({ op: literal("prepareKey"), email: str, password: str, kdf: kdfParams }),
  authHash: obj({ op: literal("authHash"), handle: num }),
  unlock: obj({ op: literal("unlock"), handle: num, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  freeKey: obj({ op: literal("freeKey"), handle: num }),
  lock: obj({ op: literal("lock") }),
  status: obj({ op: literal("status") }),
  loadVault: obj({ op: literal("loadVault"), ciphers: arr(unknownValue), folders: arr(unknownValue), orgKeys: record as Validator<Record<string, string>> }),
  upsertCipher: obj({ op: literal("upsertCipher"), cipher: record }),
  removeCipher: obj({ op: literal("removeCipher"), id: str }),
  listVault: obj({ op: literal("listVault") }),
  getCipher: obj({ op: literal("getCipher"), id: str }),
  prepareSave: obj({ op: literal("prepareSave"), item: record }),
  totp: obj({ op: literal("totp"), id: str }),
  generate: obj({ op: literal("generate"), options: record }),
  clearClipboard: obj({ op: literal("clearClipboard") }),
};

export function parseCoreRequest(v: unknown): CoreRequest {
  const op = (v as { op?: unknown } | null)?.op;
  if (typeof op !== "string" || !Object.hasOwn(coreValidators, op)) throw new ValidationError("unknown core op");
  return coreValidators[op as CoreRequest["op"]](v, "");
}
