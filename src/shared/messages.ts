// Typed message bus. Every message crossing a context boundary is validated on receipt.
//   popup  --Request-->  service worker  --OffscreenRequest-->  offscreen doc  --postMessage-->  worker
import { AUTO_LOCK_CHOICES, CLEAR_CLIPBOARD_CHOICES, type ClearClipboardDelay, URI_MATCH_CHOICES } from "./constants.ts";
import { arr, bool, literal, num, obj, opt, record, str, unknownValue, type Validator, ValidationError } from "./validate.ts";

// ---------- popup -> service worker ----------

export type Request =
  | { type: "getState" }
  | { type: "setServer"; url: string }
  | { type: "login"; email: string; password: string }
  | { type: "twoFactorSubmit"; provider: number; token: string; remember: boolean }
  | { type: "twoFactorSendEmail" }
  | { type: "twoFactorCancel" }
  | { type: "ssoStart" }
  | { type: "unlock"; password: string }
  | { type: "unlockPin"; pin: string }
  /** Without `pin`: turn PIN unlock off. */
  | { type: "setPin"; pin?: string }
  | { type: "lock" }
  | { type: "logout" }
  | {
      type: "setSettings";
      autoLockMinutes?: number;
      timeoutAction?: "lock" | "logout";
      lockOnSystemLock?: boolean;
      inlineMenu?: boolean;
      savePrompt?: boolean;
      favicons?: boolean;
      autoCopyTotp?: boolean;
      /** Clear the whole list, or remove one host from it. */
      clearNeverSave?: boolean;
      removeNeverSave?: string;
      defaultUriMatch?: number;
      clearClipboardDelay?: ClearClipboardDelay;
      autofillOnPageLoad?: boolean;
      autofillOnPageLoadDefault?: boolean;
      inlineMenuCards?: boolean;
      inlineMenuIdentities?: boolean;
      /** The browser context menu entry ("Fill with Plugwarden"). */
      contextMenu?: boolean;
      showCardsOnTab?: boolean;
      showIdentitiesOnTab?: boolean;
    }
  | { type: "setDefaultManager"; enabled: boolean }
  // vault (unlocked only)
  | { type: "vaultList" }
  | { type: "sync"; force: boolean }
  | { type: "getItem"; id: string }
  | { type: "saveItem"; item: Record<string, unknown> }
  | { type: "deleteItem"; id: string }
  | { type: "restoreItem"; id: string }
  | { type: "purgeItem"; id: string }
  | { type: "downloadAttachment"; cipherId: string; attachmentId: string }
  // Bitwarden JSON (unencrypted); export re-checks the master password
  | { type: "exportVault"; password: string }
  | { type: "importVault"; text: string }
  | { type: "addAttachment"; cipherId: string; file: { name: string; data: string } }
  | { type: "saveFolder"; name: string; id?: string }
  | { type: "deleteFolder"; id: string }
  | { type: "totp"; id: string }
  | { type: "generate"; options: Record<string, unknown> }
  | { type: "generatorHistory" }
  | { type: "generatorHistoryAdd"; value: string }
  | { type: "generatorHistoryClear" }
  | { type: "clipboardCopied" }
  // Send
  | { type: "sendList" }
  | { type: "getSend"; id: string }
  | { type: "saveSend"; send: Record<string, unknown>; file?: { name: string; data: string } }
  | { type: "deleteSend"; id: string }
  /** Removes the access password of an existing send (PUT /api/sends/{id}/remove-password). */
  | { type: "removeSendPassword"; id: string }
  // passkeys: the approval window opened for a website request
  | { type: "passkeyPrompt"; id: string }
  | { type: "passkeyDecision"; id: string; action: "use" | "fallback"; itemId?: string; credentialId?: string }
  // autofill on the active tab (host permissions cover every http(s) tab)
  | { type: "pageMatches" }
  | { type: "fill"; id: string }
  | { type: "readPageLogin" };

const requestValidators: { [K in Request["type"]]: Validator<Extract<Request, { type: K }>> } = {
  getState: obj({ type: literal("getState") }),
  setServer: obj({ type: literal("setServer"), url: str }),
  login: obj({ type: literal("login"), email: str, password: str }),
  twoFactorSubmit: obj({ type: literal("twoFactorSubmit"), provider: num, token: str, remember: bool }),
  twoFactorSendEmail: obj({ type: literal("twoFactorSendEmail") }),
  twoFactorCancel: obj({ type: literal("twoFactorCancel") }),
  ssoStart: obj({ type: literal("ssoStart") }),
  unlock: obj({ type: literal("unlock"), password: str }),
  unlockPin: obj({ type: literal("unlockPin"), pin: str }),
  setPin: (v, p) => {
    const s = obj({ type: literal("setPin"), pin: opt(str) })(v, p);
    if (s.pin !== undefined && !s.pin) throw new ValidationError("pin: required");
    return s;
  },
  lock: obj({ type: literal("lock") }),
  logout: obj({ type: literal("logout") }),
  setSettings: (v, p) => {
    const s = obj({
      type: literal("setSettings"),
      autoLockMinutes: opt(num),
      timeoutAction: opt(literal("lock", "logout")),
      lockOnSystemLock: opt(bool),
      inlineMenu: opt(bool),
      savePrompt: opt(bool),
      favicons: opt(bool),
      autoCopyTotp: opt(bool),
      clearNeverSave: opt(bool),
      removeNeverSave: opt(str),
      defaultUriMatch: opt(num),
      clearClipboardDelay: opt(literal(...CLEAR_CLIPBOARD_CHOICES)),
      autofillOnPageLoad: opt(bool),
      autofillOnPageLoadDefault: opt(bool),
      inlineMenuCards: opt(bool),
      inlineMenuIdentities: opt(bool),
      contextMenu: opt(bool),
      showCardsOnTab: opt(bool),
      showIdentitiesOnTab: opt(bool),
    })(v, p);
    if (s.autoLockMinutes !== undefined && !(AUTO_LOCK_CHOICES as readonly number[]).includes(s.autoLockMinutes))
      throw new ValidationError("autoLockMinutes: not an allowed choice");
    if (s.defaultUriMatch !== undefined && !(URI_MATCH_CHOICES as readonly number[]).includes(s.defaultUriMatch))
      throw new ValidationError("defaultUriMatch: not an allowed choice");
    return s;
  },
  vaultList: obj({ type: literal("vaultList") }),
  sync: obj({ type: literal("sync"), force: bool }),
  getItem: obj({ type: literal("getItem"), id: str }),
  saveItem: (v, p) => {
    const s = obj({ type: literal("saveItem"), item: record })(v, p);
    // Login, secure note, card, identity, SSH key.
    if (![1, 2, 3, 4, 5].includes(s.item.type as number)) throw new ValidationError("item.type: this item type cannot be edited");
    if (typeof s.item.name !== "string" || !s.item.name.trim()) throw new ValidationError("item.name: required");
    if (s.item.organizationId) throw new ValidationError("organization items are read-only");
    return s;
  },
  deleteItem: obj({ type: literal("deleteItem"), id: str }),
  restoreItem: obj({ type: literal("restoreItem"), id: str }),
  purgeItem: obj({ type: literal("purgeItem"), id: str }),
  downloadAttachment: obj({ type: literal("downloadAttachment"), cipherId: str, attachmentId: str }),
  exportVault: obj({ type: literal("exportVault"), password: str }),
  importVault: obj({ type: literal("importVault"), text: str }),
  addAttachment: obj({ type: literal("addAttachment"), cipherId: str, file: obj({ name: str, data: str }) }),
  saveFolder: obj({ type: literal("saveFolder"), name: str, id: opt(str) }),
  deleteFolder: obj({ type: literal("deleteFolder"), id: str }),
  totp: obj({ type: literal("totp"), id: str }),
  generate: obj({ type: literal("generate"), options: record }),
  generatorHistory: obj({ type: literal("generatorHistory") }),
  generatorHistoryAdd: obj({ type: literal("generatorHistoryAdd"), value: str }),
  generatorHistoryClear: obj({ type: literal("generatorHistoryClear") }),
  clipboardCopied: obj({ type: literal("clipboardCopied") }),
  sendList: obj({ type: literal("sendList") }),
  getSend: obj({ type: literal("getSend"), id: str }),
  saveSend: (v, p) => {
    const s = obj({ type: literal("saveSend"), send: record, file: opt(obj({ name: str, data: str })) })(v, p);
    if (typeof s.send.name !== "string" || !s.send.name.trim()) throw new ValidationError("send.name: required");
    // An edit (id) changes the stored send; a file send's content cannot change.
    if (s.send.id !== undefined && (typeof s.send.id !== "string" || s.file)) throw new ValidationError("send.id: invalid edit");
    return s;
  },
  deleteSend: obj({ type: literal("deleteSend"), id: str }),
  removeSendPassword: obj({ type: literal("removeSendPassword"), id: str }),
  setDefaultManager: obj({ type: literal("setDefaultManager"), enabled: bool }),
  passkeyPrompt: obj({ type: literal("passkeyPrompt"), id: str }),
  passkeyDecision: obj({ type: literal("passkeyDecision"), id: str, action: literal("use", "fallback"), itemId: opt(str), credentialId: opt(str) }),
  pageMatches: obj({ type: literal("pageMatches") }),
  fill: obj({ type: literal("fill"), id: str }),
  readPageLogin: obj({ type: literal("readPageLogin") }),
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
  /** WebAuthn request options (JSON) for the server's webauthn-connector.html. */
  webauthn?: string;
}

export interface Settings {
  autoLockMinutes: number;
  /** What auto-lock, system lock and a browser restart do: lock, or log out (forget the account). */
  timeoutAction: "lock" | "logout";
  lockOnSystemLock: boolean;
  /** Show the inline menu under login, card and identity fields. */
  inlineMenu: boolean;
  /** Offer to save / update logins after a form is submitted. */
  savePrompt: boolean;
  /** Hosts the user chose "never save" for. */
  neverSave: string[];
  /** Chrome's own password saving and address/card autofill are turned off (privacy permission). */
  defaultManager: boolean;
  /** Website icons for logins, from the server's /icons service. */
  favicons: boolean;
  /** After filling a login that has a TOTP key, put the current code on the clipboard. */
  autoCopyTotp: boolean;
  /** Match strategy for saved URIs whose own `match` is null (and what "Default" means). */
  defaultUriMatch: number;
  /** How long copied values stay on the clipboard (official default: five minutes). */
  clearClipboardDelay: ClearClipboardDelay;
  /** Fill matching logins when a page loads. */
  autofillOnPageLoad: boolean;
  /** Value of a login's tri-state "Autofill on page load" when it is not set explicitly. */
  autofillOnPageLoadDefault: boolean;
  inlineMenuCards: boolean;
  inlineMenuIdentities: boolean;
  /** Show the "Fill with Plugwarden" context-menu entry. */
  contextMenu: boolean;
  showCardsOnTab: boolean;
  showIdentitiesOnTab: boolean;
}

export interface State {
  phase: Phase;
  serverUrl?: string;
  serverVersion?: string;
  email?: string;
  twoFactor?: TwoFactorChallenge;
  /** The last SSO login failed (it finishes in the background, after the popup closed). */
  ssoError?: string;
  /** PIN unlock is turned on for this account. */
  pinSet?: boolean;
  /** The locked vault can be opened with the PIN (until the browser restarts). */
  pinUnlock?: boolean;
  /** epoch ms of the last successful sync. */
  syncedAt?: number;
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
  /** Tri-state "Autofill on page load" of a login (absent: inherit the account default). */
  autofillOnPageLoad?: boolean;
  /** epoch ms; used by the list's "recently edited / created" sorting. */
  revisionDate?: number;
  creationDate?: number;
  failed?: boolean;
}

/** Logins matching the active tab. `host` is absent when the tab is not an http(s) page. */
export interface PageMatches {
  host?: string;
  items: VaultItem[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface VaultList {
  items: VaultItem[];
  folders: Folder[];
  trash: VaultItem[];
  /** Names for organization items' details. */
  organizations?: Folder[];
  collections?: Folder[];
  syncedAt?: number;
}

/** A copied generator value, newest first. */
export interface HistoryEntry {
  /** epoch ms */
  date: number;
  value: string;
}

export interface PasskeyCandidate {
  itemId: string;
  name: string;
  userName: string;
  /** base64url */
  credentialId: string;
}

/** What the approval window shows for a pending website passkey request. */
export interface PasskeyPrompt {
  kind: "create" | "get";
  origin: string;
  rpId: string;
  rpName?: string;
  userName?: string;
  candidates: PasskeyCandidate[];
}

/** Decrypted send for the list. `link` carries the decryption secret in its fragment. */
export interface SendItem {
  id: string;
  type: number;
  name: string;
  link: string;
  deletionDate: string;
  hasPassword: boolean;
  disabled: boolean;
  accessCount: number;
  maxAccessCount?: number;
  failed?: boolean;
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
  // PIN: the user key wrapped with a key derived from the PIN (account KDF and email)
  | { op: "pinProtect"; pin: string; email: string; kdf: KdfParams }
  | { op: "unlockPin"; pin: string; email: string; kdf: KdfParams; protectedUserKey: string; encryptedPrivateKey?: string }
  | { op: "freeKey"; handle: number }
  | { op: "lock" }
  | { op: "status" }
  // vault: the worker keeps the decrypted vault in memory
  | { op: "loadVault"; ciphers: unknown[]; folders: unknown[]; sends: unknown[]; orgKeys: Record<string, string>; collections: unknown[]; orgs: Folder[] }
  | { op: "upsertCipher"; cipher: Record<string, unknown> }
  | { op: "removeCipher"; id: string }
  | { op: "listVault" }
  | { op: "getCipher"; id: string }
  | { op: "prepareSave"; item: Record<string, unknown> }
  | { op: "totp"; id: string }
  | { op: "generate"; options: Record<string, unknown> }
  // free text encrypted with the user key (like a folder name)
  | { op: "encryptText"; values: string[] }
  | { op: "decryptText"; values: string[] }
  | { op: "matchUri"; url: string; defaultMatch: number }
  | { op: "fillData"; id: string }
  | { op: "formValues"; id: string }
  // attachments (bodies base64)
  | { op: "decryptAttachment"; cipherId: string; attachmentId: string; data: string }
  | { op: "exportJson" }
  | { op: "prepareImport"; text: string }
  | { op: "encryptAttachment"; cipherId: string; fileName: string; data: string }
  // Send
  | { op: "listSends" }
  | { op: "getSend"; id: string }
  | { op: "prepareSend"; send: Record<string, unknown> }
  | { op: "encryptSendFile"; key: string; data: string }
  | { op: "upsertSend"; send: Record<string, unknown> }
  | { op: "removeSend"; id: string }
  // passkeys (all ids and binary values base64url)
  | { op: "passkeyCandidates"; rpId: string; origin: string; ids: string[] }
  | { op: "passkeyAssert"; itemId: string; credentialId: string; rpId: string; origin: string; challenge: string }
  | { op: "passkeyCreate"; input: PasskeyCreateInput }
  // handled by the offscreen document itself, not the worker
  | { op: "writeClipboard"; text: string };

export type CoreResult = { ok: true; value: unknown } | { ok: false; error: string };

export const OFFSCREEN_TARGET = "plugwarden-offscreen";

export const kdfParams: Validator<KdfParams> = obj({ type: num, iterations: num, memory: num, parallelism: num });

const user = obj({ id: str, name: str, displayName: str });
const passkeyCreateInput: Validator<PasskeyCreateInput> = obj({ origin: str, rpId: str, rpName: str, challenge: str, user, discoverable: bool });

const coreValidators: { [K in CoreRequest["op"]]: Validator<Extract<CoreRequest, { op: K }>> } = {
  prepareKey: obj({ op: literal("prepareKey"), email: str, password: str, kdf: kdfParams }),
  authHash: obj({ op: literal("authHash"), handle: num }),
  unlock: obj({ op: literal("unlock"), handle: num, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  pinProtect: obj({ op: literal("pinProtect"), pin: str, email: str, kdf: kdfParams }),
  unlockPin: obj({ op: literal("unlockPin"), pin: str, email: str, kdf: kdfParams, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  freeKey: obj({ op: literal("freeKey"), handle: num }),
  lock: obj({ op: literal("lock") }),
  status: obj({ op: literal("status") }),
  loadVault: obj({
    op: literal("loadVault"),
    ciphers: arr(unknownValue),
    folders: arr(unknownValue),
    sends: arr(unknownValue),
    orgKeys: record as Validator<Record<string, string>>,
    collections: arr(unknownValue),
    orgs: arr(obj({ id: str, name: str })),
  }),
  upsertCipher: obj({ op: literal("upsertCipher"), cipher: record }),
  removeCipher: obj({ op: literal("removeCipher"), id: str }),
  listVault: obj({ op: literal("listVault") }),
  getCipher: obj({ op: literal("getCipher"), id: str }),
  prepareSave: obj({ op: literal("prepareSave"), item: record }),
  totp: obj({ op: literal("totp"), id: str }),
  generate: obj({ op: literal("generate"), options: record }),
  encryptText: obj({ op: literal("encryptText"), values: arr(str) }),
  decryptText: obj({ op: literal("decryptText"), values: arr(str) }),
  matchUri: obj({ op: literal("matchUri"), url: str, defaultMatch: num }),
  fillData: obj({ op: literal("fillData"), id: str }),
  formValues: obj({ op: literal("formValues"), id: str }),
  decryptAttachment: obj({ op: literal("decryptAttachment"), cipherId: str, attachmentId: str, data: str }),
  exportJson: obj({ op: literal("exportJson") }),
  prepareImport: obj({ op: literal("prepareImport"), text: str }),
  encryptAttachment: obj({ op: literal("encryptAttachment"), cipherId: str, fileName: str, data: str }),
  listSends: obj({ op: literal("listSends") }),
  getSend: obj({ op: literal("getSend"), id: str }),
  prepareSend: obj({ op: literal("prepareSend"), send: record }),
  encryptSendFile: obj({ op: literal("encryptSendFile"), key: str, data: str }),
  upsertSend: obj({ op: literal("upsertSend"), send: record }),
  removeSend: obj({ op: literal("removeSend"), id: str }),
  passkeyCandidates: obj({ op: literal("passkeyCandidates"), rpId: str, origin: str, ids: arr(str) }),
  passkeyAssert: obj({ op: literal("passkeyAssert"), itemId: str, credentialId: str, rpId: str, origin: str, challenge: str }),
  passkeyCreate: obj({ op: literal("passkeyCreate"), input: passkeyCreateInput }),
  writeClipboard: obj({ op: literal("writeClipboard"), text: str }),
};

export function parseCoreRequest(v: unknown): CoreRequest {
  const op = (v as { op?: unknown } | null)?.op;
  if (typeof op !== "string" || !Object.hasOwn(coreValidators, op)) throw new ValidationError("unknown core op");
  return coreValidators[op as CoreRequest["op"]](v, "");
}

// ---------- page (passkey shim) -> isolated relay -> service worker, over a "passkey" port ----------

export const PASSKEY_PORT = "plugwarden-passkey";

export interface PasskeyCreateInput {
  origin: string;
  rpId: string;
  rpName: string;
  challenge: string;
  user: { id: string; name: string; displayName: string };
  discoverable: boolean;
}

/** Sent by the relay. The origin is never taken from here: the service worker uses port.sender.origin. */
export type PasskeyCall =
  | {
      kind: "create";
      options: { rpId?: string; rpName: string; user: { id: string; name: string; displayName: string }; challenge: string; exclude: string[]; discoverable: boolean };
    }
  | { kind: "get"; conditional: boolean; options: { rpId?: string; challenge: string; allow: string[] } };

/** Credential fields (base64url) or a reason to let the browser handle the call. */
export type PasskeyResult = { credential: Record<string, unknown> } | { fallback: true } | { error: { name: string; message: string } };

export function parsePasskeyCall(v: unknown): PasskeyCall {
  const kind = (v as { kind?: unknown } | null)?.kind;
  if (kind === "create")
    return obj({
      kind: literal("create"),
      options: obj({ rpId: opt(str), rpName: str, user, challenge: str, exclude: arr(str), discoverable: bool }),
    })(v, "");
  return obj({ kind: literal("get"), conditional: bool, options: obj({ rpId: opt(str), challenge: str, allow: arr(str) }) })(v, "");
}

// ---------- content script (every page) and our menu.html / bar.html iframes -> service worker ----------

export type FieldKind = "login" | "card" | "identity";

/** From the content script. Sender tab, frame and URL come from the browser (sender), never from here. */
export type PageRequest =
  | { type: "inlineFocus"; kind: FieldKind }
  | { type: "loginSubmitted"; username: string; password: string }
  /** Sent on load only when the frame contains a password field; the worker decides whether to fill. */
  | { type: "pageLoad" };

const pageValidators: { [K in PageRequest["type"]]: Validator<Extract<PageRequest, { type: K }>> } = {
  inlineFocus: obj({ type: literal("inlineFocus"), kind: literal("login", "card", "identity") }),
  loginSubmitted: obj({ type: literal("loginSubmitted"), username: str, password: str }),
  pageLoad: obj({ type: literal("pageLoad") }),
};

/** From menu.html / bar.html, which run as extension pages inside the website's tab. */
export type FrameRequest =
  | { type: "inlineList" }
  | { type: "inlineFill"; id: string }
  | { type: "inlinePasskey" }
  | { type: "inlineUnlock" }
  | { type: "barInfo" }
  | { type: "barAction"; action: "save" | "never" | "close" };

const frameValidators: { [K in FrameRequest["type"]]: Validator<Extract<FrameRequest, { type: K }>> } = {
  inlineList: obj({ type: literal("inlineList") }),
  inlineFill: obj({ type: literal("inlineFill"), id: str }),
  inlinePasskey: obj({ type: literal("inlinePasskey") }),
  inlineUnlock: obj({ type: literal("inlineUnlock") }),
  barInfo: obj({ type: literal("barInfo") }),
  barAction: obj({ type: literal("barAction"), action: literal("save", "never", "close") }),
};

const parseBy =
  <T>(validators: Record<string, Validator<unknown>>) =>
  (v: unknown): T => {
    const type = (v as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !Object.hasOwn(validators, type)) throw new ValidationError("unknown message type");
    return validators[type]!(v, "") as T;
  };

export const parsePageRequest = parseBy<PageRequest>(pageValidators);
export const parseFrameRequest = parseBy<FrameRequest>(frameValidators);

export interface MenuItem {
  id: string;
  type: number;
  name: string;
  sub: string;
}

export interface MenuData {
  kind: FieldKind;
  locked: boolean;
  items: MenuItem[];
  /** A website's conditional passkey sign-in is waiting: offer "Sign in with a passkey". */
  passkey: boolean;
}

export interface BarInfo {
  kind: "add" | "update";
  host: string;
  username: string;
}
