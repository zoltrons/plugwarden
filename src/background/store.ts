// Typed chrome.storage access. The service worker keeps no state in globals; every handler reads
// what it needs from here.
//   local   (disk):   device id, server, settings, account (encrypted keys + refresh token), 2FA remember tokens
//   session (memory): unlock flag, access token, pending 2FA login. Cleared on browser restart.
import { DEFAULT_AUTO_LOCK_MINUTES } from "../shared/constants.ts";
import type { KdfParams, Settings, TwoFactorChallenge } from "../shared/messages.ts";

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
}

interface LocalSchema {
  deviceId: string;
  server: Server;
  settings: Settings;
  account: Account;
  /** email -> TwoFactorToken returned when "remember me" was ticked. */
  rememberTokens: Record<string, string>;
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
  return { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, lockOnSystemLock: true, ...(await getLocal("settings")) };
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
