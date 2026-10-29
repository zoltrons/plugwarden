// Typed chrome.storage access. The service worker keeps no state in globals; every handler reads
// what it needs from here.
//   local   (disk):   device id, server, settings, account (encrypted keys + refresh token), 2FA remember tokens
//   session (memory): unlock flag, access token, pending 2FA login. Cleared on browser restart.
import { DEFAULT_AUTO_LOCK_MINUTES } from "../shared/constants.ts";
import type { HistoryEntry, KdfParams, Settings, TwoFactorChallenge } from "../shared/messages.ts";
import type { InlineContext, PendingSave } from "./inline.ts";

export interface Server {
  url: string;
  version: string;
  name: string;
}

export interface Account {
  email: string;
  userId?: string;
  kdf: KdfParams;
  protectedUserKey: string;
  encryptedPrivateKey?: string;
  refreshToken?: string;
  /** PIN unlock is on: the PIN, encrypted with the user key (to re-arm it after a browser restart). */
  protectedPin?: string;
}

export interface PendingLogin {
  email: string;
  kdf: KdfParams;
  handle: number;
  challenge: TwoFactorChallenge;
  /** epoch ms */
  expiresAt: number;
}

export interface Session {
  unlocked: boolean;
  accessToken?: string;
  accessExpiresAt?: number;
  pending?: PendingLogin;
  /** SSO login in progress: PKCE verifier and the state we sent. */
  sso?: { state: string; verifier: string; expiresAt: number };
  /** Why the last SSO login failed (shown when the popup opens next). */
  ssoError?: string;
  /** PIN unlock: the user key wrapped with the PIN key, and wrong tries so far. */
  pin?: { email: string; key: string; attempts: number };
}

/**
 * Per-tab state in storage.session, one key per tab ("inline:<tabId>", "save:<tabId>"), so writes for
 * different tabs (or the login session) never overwrite each other.
 *   inline: the field the inline menu belongs to;  save: a submitted login waiting in the save bar.
 */
interface TabState {
  inline: InlineContext;
  save: PendingSave;
}

export async function getTabState<K extends keyof TabState>(kind: K, tabId: number): Promise<TabState[K] | undefined> {
  const key = `${kind}:${tabId}`;
  return (await chrome.storage.session.get(key))[key] as TabState[K] | undefined;
}

export const setTabState = <K extends keyof TabState>(kind: K, tabId: number, value: TabState[K] | undefined) =>
  value === undefined ? chrome.storage.session.remove(`${kind}:${tabId}`) : chrome.storage.session.set({ [`${kind}:${tabId}`]: value });

export const clearTabState = (tabId: number) => chrome.storage.session.remove([`inline:${tabId}`, `save:${tabId}`]);

/** /api/sync data exactly as the server sent it (encrypted). */
export interface VaultCache {
  /** server revision date, ms */
  revision: number;
  syncedAt: number;
  ciphers: unknown[];
  folders: unknown[];
  /** Absent in caches written before Phase 4. */
  sends?: unknown[];
  orgKeys: Record<string, string>;
  /** Absent in caches written before collections were shown. */
  collections?: unknown[];
  orgs?: { id: string; name: string }[];
}

interface LocalSchema {
  vault: VaultCache;
  deviceId: string;
  server: Server;
  settings: Settings;
  account: Account;
  /** email -> TwoFactorToken returned when "remember me" was ticked. */
  rememberTokens: Record<string, string>;
  /** Copied generator values, encrypted with the user key, newest first. */
  genHistory: HistoryEntry[];
}

interface SessionSchema {
  session: Session;
}

export async function getLocal<K extends keyof LocalSchema>(key: K): Promise<LocalSchema[K] | undefined> {
  return (await chrome.storage.local.get(key))[key] as LocalSchema[K] | undefined;
}

export const setLocal = <K extends keyof LocalSchema>(key: K, value: LocalSchema[K]) =>
  chrome.storage.local.set({ [key]: value });

export const removeLocal = (...keys: (keyof LocalSchema)[]) => chrome.storage.local.remove(keys);

export async function getSession(): Promise<Session> {
  const s = (await chrome.storage.session.get("session")).session as SessionSchema["session"] | undefined;
  return s ?? { unlocked: false };
}

export async function updateSession(patch: Partial<Session>): Promise<Session> {
  const next = { ...(await getSession()), ...patch };
  for (const k of Object.keys(patch) as (keyof Session)[]) if (patch[k] === undefined) delete next[k];
  await chrome.storage.session.set({ session: next });
  return next;
}

export const clearSession = () => chrome.storage.session.remove("session");

export async function getSettings(): Promise<Settings> {
  return { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, timeoutAction: "lock", lockOnSystemLock: true, passkeys: false, inlineMenu: true, savePrompt: true, neverSave: [], defaultManager: false, favicons: true, autoCopyTotp: true, ...(await getLocal("settings")) };
}

export async function getDeviceId(): Promise<string> {
  let id = await getLocal("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    await setLocal("deviceId", id);
  }
  return id;
}

/** Content scripts must never read our storage. session is TRUSTED_CONTEXTS by default; local is not. */
export async function restrictStorageAccess(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

/**
 * Turns Chrome's own password saving and address/card autofill off (or hands them back), like the
 * official "make Bitwarden the default password manager". Needs the optional "privacy" permission,
 * which the popup requests in the click.
 */
export async function setDefaultManager(enabled: boolean): Promise<void> {
  if (enabled && !(await chrome.permissions.contains({ permissions: ["privacy"] })))
    throw new Error("Permission to change Chrome's password settings was not granted");
  if (chrome.privacy) {
    const prefs = [chrome.privacy.services.passwordSavingEnabled, chrome.privacy.services.autofillAddressEnabled, chrome.privacy.services.autofillCreditCardEnabled];
    // Some browsers (or policies, or another extension) own these; leave those alone.
    for (const p of prefs) if ((await p.get({})).levelOfControl.endsWith("by_this_extension")) await (enabled ? p.set({ value: false }) : p.clear({}));
  }
  if (!enabled) await chrome.permissions.remove({ permissions: ["privacy"] }).catch(() => undefined);
  await setLocal("settings", { ...(await getSettings()), defaultManager: enabled });
}
