// Login, 2FA, unlock, token refresh. Pure orchestration: crypto runs in the offscreen worker,
// HTTP in src/transport.
import { KDF_ARGON2ID, TWO_FACTOR } from "../shared/constants.ts";
import type { ErrorCode, KdfParams } from "../shared/messages.ts";
import {
  authorizationCodeToken,
  jwtClaim,
  jwtSubject,
  passwordToken,
  prelogin,
  refreshToken,
  sendEmailLogin,
  ssoPrevalidate,
  type TokenResponse,
  toTokens,
  TwoFactorRequired,
} from "../transport/auth.ts";
import { ApiError } from "../transport/http.ts";
import { verifyPassword } from "../transport/vault.ts";
import { CoreError, coreAlive, coreCall } from "./core.ts";
import { lockNow, touchAutoLock } from "./lock.ts";
import { grantReprompt } from "./reprompt.ts";
import {
  type Account,
  getDeviceId,
  getLocal,
  getSession,
  removeLocal,
  setLocal,
  updateSession,
} from "./store.ts";

/** Error with a code the popup can switch on (see ErrorCode in shared/messages.ts). */
export class UserError extends Error {
  override name = "UserError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const PENDING_TTL_MS = 10 * 60_000;
export const PENDING_ALARM = "pendingLogin";

/**
 * A 2FA "remember me" token is only valid for the server that issued it, so it is stored per server:
 * changing the configured server (or pointing at another one) must never replay it there.
 */
const rememberKey = (serverUrl: string, email: string) => `${serverUrl}|${email}`;

async function requireServer(): Promise<string> {
  const server = await getLocal("server");
  if (!server) throw new UserError("wrongPhase", "No server configured");
  return server.url;
}

interface Prepared {
  handle: number;
  authHash: string;
}

const prepareKey = (email: string, password: string, kdf: KdfParams) =>
  coreCall<Prepared>({ op: "prepareKey", email, password, kdf });

function kdfFromToken(t: TokenResponse, fallback: KdfParams): KdfParams {
  if (t.Kdf === undefined || t.KdfIterations === undefined) return fallback;
  const argon = t.Kdf === KDF_ARGON2ID;
  return {
    type: t.Kdf,
    iterations: t.KdfIterations,
    memory: argon ? (t.KdfMemory ?? 0) : 0,
    parallelism: argon ? (t.KdfParallelism ?? 0) : 0,
  };
}

async function completeLogin(serverUrl: string, email: string, kdf: KdfParams, handle: number, t: TokenResponse): Promise<void> {
  if (!t.Key) throw new UserError("badServer", "Server did not return an encrypted user key");
  try {
    await coreCall({ op: "unlock", handle, protectedUserKey: t.Key, encryptedPrivateKey: t.PrivateKey });
  } catch (e) {
    throw new UserError("badServer", `Could not decrypt the account key: ${(e as Error).message}`);
  }
  const tokens = toTokens(t);
  await removeLocal("vault"); // never show a previous account's cache
  const account: Account = {
    email,
    userId: jwtSubject(t.access_token),
    kdf: kdfFromToken(t, kdf),
    protectedUserKey: t.Key,
    encryptedPrivateKey: t.PrivateKey,
    refreshToken: tokens.refreshToken,
  };
  await setLocal("account", account);
  if (t.TwoFactorToken) {
    const remember = (await getLocal("rememberTokens")) ?? {};
    await setLocal("rememberTokens", { ...remember, [rememberKey(serverUrl, email)]: t.TwoFactorToken });
  }
  await updateSession({
    unlocked: true,
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.expiresAt,
    pending: undefined,
    ssoError: undefined,
    pin: undefined,
  });
  await touchAutoLock();
}

function mapLoginError(e: unknown): never {
  if (e instanceof UserError) throw e;
  if (e instanceof ApiError && (e.status === 400 || e.status === 401))
    throw new UserError("badCredentials", e.message);
  throw e;
}

export async function login(rawEmail: string, password: string): Promise<void> {
  const base = await requireServer();
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) throw new UserError("invalid", "Email and master password are required");
  await lockNow();

  const kdf = await prelogin(base, email);
  const { handle, authHash } = await prepareKey(email, password, kdf);
  const deviceId = await getDeviceId();
  const remembered = (await getLocal("rememberTokens"))?.[rememberKey(base, email)];
  try {
    const t = await passwordToken(base, {
      email,
      authHash,
      deviceId,
      ...(remembered ? { twoFactor: { provider: TWO_FACTOR.Remember, token: remembered, remember: false } } : {}),
    });
    await completeLogin(base, email, kdf, handle, t);
  } catch (e) {
    if (e instanceof TwoFactorRequired) {
      if (remembered) {
        // The server rejected (or expired) our remember token: forget it and ask for a real code.
        const all = (await getLocal("rememberTokens")) ?? {};
        delete all[rememberKey(base, email)];
        await setLocal("rememberTokens", all);
      }
      const expiresAt = Date.now() + PENDING_TTL_MS;
      await updateSession({ pending: { email, kdf, handle, challenge: e.challenge, expiresAt } });
      // The pending login holds the master key: free it on time even if the popup is never opened again.
      await chrome.alarms.create(PENDING_ALARM, { when: expiresAt });
      return;
    }
    await coreCall({ op: "freeKey", handle }).catch(() => undefined);
    mapLoginError(e);
  }
}

async function requirePending() {
  const { pending } = await getSession();
  if (!pending) throw new UserError("wrongPhase", "No login in progress");
  if (pending.expiresAt < Date.now()) {
    await cancelTwoFactor();
    throw new UserError("sessionExpired", "The login attempt expired, please log in again");
  }
  try {
    return { pending, authHash: await coreCall<string>({ op: "authHash", handle: pending.handle }) };
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    await updateSession({ pending: undefined });
    throw new UserError("sessionExpired", "The login attempt expired, please log in again");
  }
}

export async function submitTwoFactor(provider: number, token: string, remember: boolean): Promise<void> {
  const base = await requireServer();
  const { pending, authHash } = await requirePending();
  if (!pending.challenge.providers.includes(provider)) throw new UserError("invalid", "Provider not offered by server");
  // WebAuthn tokens are the assertion JSON from the connector page; codes may be typed with spaces.
  const code = provider === TWO_FACTOR.WebAuthn ? token : token.replace(/\s+/g, "");
  if (!code) throw new UserError("invalid", "Enter the verification code");
  const grant = { email: pending.email, authHash, deviceId: await getDeviceId() };
  try {
    const t = await passwordToken(base, { ...grant, twoFactor: { provider, token: code, remember } });
    await completeLogin(base, pending.email, pending.kdf, pending.handle, t);
  } catch (e) {
    if (!(e instanceof TwoFactorRequired || (e instanceof ApiError && e.status === 400))) throw e;
    if (provider === TWO_FACTOR.WebAuthn) {
      // Vaultwarden deletes the WebAuthn challenge on every attempt; ask for a fresh one.
      await passwordToken(base, grant).catch(async (r: unknown) => {
        if (r instanceof TwoFactorRequired) await updateSession({ pending: { ...pending, challenge: r.challenge } });
      });
    }
    throw new UserError("badTwoFactor", e instanceof ApiError ? e.message : "Invalid verification code");
  }
}

export async function sendTwoFactorEmail(): Promise<void> {
  const base = await requireServer();
  const { pending, authHash } = await requirePending();
  if (!pending.challenge.providers.includes(TWO_FACTOR.Email))
    throw new UserError("invalid", "Email two-step login is not enabled for this account");
  await sendEmailLogin(base, pending.email, authHash, await getDeviceId());
}

export async function cancelTwoFactor(): Promise<void> {
  const { pending } = await getSession();
  await updateSession({ pending: undefined });
  // Only a live worker can hold the handle: do not spin one up just to free it.
  if (pending && (await coreAlive())) await coreCall({ op: "freeKey", handle: pending.handle }).catch(() => undefined);
}

export async function unlock(password: string): Promise<void> {
  const account = await getLocal("account");
  if (!account) throw new UserError("wrongPhase", "Not logged in");
  const { handle } = await prepareKey(account.email, password, account.kdf);
  try {
    await coreCall({
      op: "unlock",
      handle,
      protectedUserKey: account.protectedUserKey,
      encryptedPrivateKey: account.encryptedPrivateKey,
    });
  } catch (e) {
    await coreCall({ op: "freeKey", handle }).catch(() => undefined);
    if (e instanceof CoreError) throw new UserError("wrongPassword", "Wrong master password");
    throw e;
  }
  await afterUnlock(account);
}

/** Shared tail of every unlock path (master password, PIN, biometrics). */
async function afterUnlock(account: Account): Promise<void> {
  await updateSession({ unlocked: true });
  await touchAutoLock();
  // After a browser restart the PIN-wrapped key is gone: re-arm it from the stored PIN.
  const { pin } = await getSession();
  if (account.protectedPin && pin?.email !== account.email) {
    const [plain] = await coreCall<string[]>({ op: "decryptText", values: [account.protectedPin] });
    if (plain) await armPin(account, plain);
  } else if (pin?.attempts) await updateSession({ pin: { ...pin, attempts: 0 } });
}

// ---------- Biometrics (WebAuthn PRF) ----------

/**
 * Turns biometric unlock on: wraps the unlocked user key with a key derived from the
 * authenticator's PRF output. Only the wrapped key is stored; the PRF secret never leaves the
 * platform authenticator, and every unlock requires its user verification (Touch ID / Hello).
 */
export async function setBiometric(credentialId: string, prfSalt: string, prf: string): Promise<void> {
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  if (!credentialId || !prfSalt || !prf) throw new UserError("invalid", "The biometric credential is incomplete");
  const protectedUserKey = await coreCall<string>({ op: "prfProtect", prf });
  await setLocal("biometric", { email: account.email, credentialId, prfSalt, protectedUserKey, createdAt: Date.now() });
}

export const removeBiometric = () => removeLocal("biometric").then(() => undefined);

export async function unlockWithBiometric(prf: string): Promise<void> {
  const [account, bio] = await Promise.all([getLocal("account"), getLocal("biometric")]);
  if (!account || !bio || bio.email !== account.email) throw new UserError("wrongPhase", "Biometric unlock is not set up");
  try {
    await coreCall({
      op: "unlockPrf",
      prf,
      protectedUserKey: bio.protectedUserKey,
      encryptedPrivateKey: account.encryptedPrivateKey,
    });
  } catch (e) {
    // A different authenticator/user (or a broken credential) fails the MAC: never retry silently.
    if (e instanceof CoreError) throw new UserError("badBiometric", "Biometric verification failed. Unlock with your master password and set it up again.");
    throw e;
  }
  await afterUnlock(account);
}

// ---------- Master password re-check ----------

/**
 * Confirms the master password with the server (it answers 400 when it is wrong). Used before a whole
 * vault export and for `reprompt` items: the derived key is freed immediately, only the auth hash is
 * used, so nothing extra stays in memory.
 */
export async function verifyMasterPassword(password: string): Promise<void> {
  const base = await requireServer();
  const account = await getLocal("account");
  if (!account) throw new UserError("sessionExpired", "Please log in again");
  const { handle, authHash } = await coreCall<Prepared>({ op: "prepareKey", email: account.email, password, kdf: account.kdf });
  await coreCall({ op: "freeKey", handle }).catch(() => undefined);
  await verifyPassword(base, await accessToken(), authHash).catch((e: unknown) => {
    throw e instanceof ApiError && e.status === 400 ? new UserError("wrongPassword", "Wrong master password") : e;
  });
}

/** Grants one item's re-prompt after the master password checked out. */
export async function confirmReprompt(id: string, password: string): Promise<void> {
  await verifyMasterPassword(password);
  grantReprompt(id);
}

// ---------- PIN (Bitwarden "unlock with PIN", locked with the master password on browser restart) ----------

const PIN_MAX_ATTEMPTS = 5;

async function armPin(account: Account, pin: string): Promise<void> {
  const key = await coreCall<string>({ op: "pinProtect", pin, email: account.email, kdf: account.kdf });
  await updateSession({ pin: { email: account.email, key, attempts: 0 } });
}

/** Turns PIN unlock on, or off without `pin`. Needs the unlocked vault. */
export async function setPin(pin?: string): Promise<void> {
  const account = await getLocal("account");
  if (!account) throw new UserError("wrongPhase", "Not logged in");
  if (pin === undefined) {
    const { protectedPin: _, ...rest } = account;
    await setLocal("account", rest);
    await updateSession({ pin: undefined });
    return;
  }
  const [protectedPin] = await coreCall<string[]>({ op: "encryptText", values: [pin] });
  await armPin(account, pin);
  await setLocal("account", { ...account, protectedPin: protectedPin! });
}

export async function unlockWithPin(pin: string): Promise<void> {
  const account = await getLocal("account");
  const { pin: p } = await getSession();
  if (!account?.protectedPin || !p || p.email !== account.email) throw new UserError("wrongPhase", "Unlock with the master password");
  try {
    await coreCall({ op: "unlockPin", pin, email: account.email, kdf: account.kdf, protectedUserKey: p.key, encryptedPrivateKey: account.encryptedPrivateKey });
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    // Like the official clients: a few wrong PINs end the session instead of allowing a slow brute force.
    if (p.attempts + 1 >= PIN_MAX_ATTEMPTS) {
      await logout();
      throw new UserError("wrongPassword", "Too many wrong PINs, you have been logged out");
    }
    await updateSession({ pin: { ...p, attempts: p.attempts + 1 } });
    throw new UserError("wrongPassword", "Wrong PIN");
  }
  await afterUnlock(account); // also resets the wrong-PIN count
}

export async function logout(): Promise<void> {
  await lockNow();
  await removeLocal("account", "vault", "genHistory", "biometric");
  await updateSession({ accessToken: undefined, accessExpiresAt: undefined, pin: undefined, alias: undefined });
}

/** The refresh in flight, if any. The server may rotate the refresh token, so a second concurrent
 * refresh would be sent a spent one and fail (and end in a logout). Rebuildable: a restart just starts over. */
let refreshing: Promise<string> | undefined;

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function accessToken(): Promise<string> {
  const s = await getSession();
  if (s.accessToken && (s.accessExpiresAt ?? 0) - 60_000 > Date.now()) return s.accessToken;
  refreshing ??= refreshAccessToken().finally(() => (refreshing = undefined));
  return refreshing;
}

async function refreshAccessToken(): Promise<string> {
  const base = await requireServer();
  const account = await getLocal("account");
  if (!account?.refreshToken) throw new UserError("sessionExpired", "Please log in again");
  let t: TokenResponse;
  try {
    t = await refreshToken(base, account.refreshToken);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 401)) {
      await logout();
      throw new UserError("sessionExpired", "Your session expired, please log in again");
    }
    throw e;
  }
  const tokens = toTokens(t);
  if (tokens.refreshToken && tokens.refreshToken !== account.refreshToken)
    await setLocal("account", { ...account, refreshToken: tokens.refreshToken });
  await updateSession({ accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  return tokens.accessToken;
}

// ---------- SSO (Vaultwarden OpenID Connect) ----------
// client_id "browser" makes Vaultwarden redirect to <server>/sso-connector.html. A content script
// registered for exactly that page reports the URL back (finishSso). SSO only authenticates: the
// vault is still unlocked with the master password, so the account ends up "locked".

const SSO_SCRIPT = "pw-sso-callback";
const b64u = (b: Uint8Array) => b.toBase64({ alphabet: "base64url", omitPadding: true });
const connectorUrl = (base: string) => `${base}/sso-connector.html`;

export async function startSso(): Promise<void> {
  const base = await requireServer();
  await ssoPrevalidate(base).catch((e: unknown) => {
    if (e instanceof ApiError) throw new UserError("badServer", "SSO is not enabled on this server");
    throw e;
  });
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // The suffix makes the connector page show its hand-off message instead of starting a web vault login.
  const state = `${b64u(crypto.getRandomValues(new Uint8Array(16)))}:clientId=browser`;
  await updateSession({ sso: { state, verifier, expiresAt: Date.now() + PENDING_TTL_MS }, ssoError: undefined });
  await chrome.scripting.unregisterContentScripts({ ids: [SSO_SCRIPT] }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([{ id: SSO_SCRIPT, js: ["sso-callback.js"], matches: [`${connectorUrl(base)}*`], runAt: "document_start" }]);
  const q = new URLSearchParams({
    client_id: "browser",
    redirect_uri: connectorUrl(base),
    response_type: "code",
    scope: "api offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  await chrome.tabs.create({ url: `${base}/identity/connect/authorize?${q}` });
}

/** `url` is the connector page URL as seen by the browser (sender.url), never a value from the page. */
export async function finishSso(url: string, tabId: number): Promise<void> {
  const base = await requireServer();
  if (!url.startsWith(`${connectorUrl(base)}?`)) return;
  const { sso } = await getSession();
  await chrome.scripting.unregisterContentScripts({ ids: [SSO_SCRIPT] }).catch(() => undefined);
  const params = new URL(url).searchParams;
  try {
    if (!sso || sso.expiresAt < Date.now() || params.get("state") !== sso.state)
      throw new UserError("sessionExpired", "The SSO login expired or did not come from this browser, please try again");
    const code = params.get("code");
    if (!code) throw new UserError("badCredentials", "The identity provider did not sign you in");
    let t: TokenResponse;
    try {
      t = await authorizationCodeToken(base, code, sso.verifier, connectorUrl(base), await getDeviceId());
    } catch (e) {
      if (e instanceof TwoFactorRequired) throw new UserError("badTwoFactor", "Two-step login together with SSO is not supported yet");
      mapLoginError(e);
    }
    const email = jwtClaim(t.access_token, "email");
    if (!email) throw new UserError("badServer", "The server did not return the account email");
    if (!t.Key) throw new UserError("badServer", "This account has no master password yet; set one in the web vault first");
    await lockNow();
    await removeLocal("vault");
    const tokens = toTokens(t);
    await setLocal("account", {
      email,
      userId: jwtSubject(t.access_token),
      kdf: kdfFromToken(t, await prelogin(base, email)),
      protectedUserKey: t.Key,
      encryptedPrivateKey: t.PrivateKey,
      refreshToken: tokens.refreshToken,
    });
    await updateSession({ sso: undefined, pin: undefined, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  } catch (e) {
    await updateSession({ sso: undefined, ssoError: e instanceof Error ? e.message : String(e) });
    if (!(e instanceof UserError)) throw e;
  } finally {
    // Closed only once the outcome is stored, so a popup opened right after shows it.
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
