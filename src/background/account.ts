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
import { CoreError, coreCall } from "./core.ts";
import { lockNow, touchAutoLock } from "./lock.ts";
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

async function completeLogin(email: string, kdf: KdfParams, handle: number, t: TokenResponse): Promise<void> {
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
    await setLocal("rememberTokens", { ...remember, [email]: t.TwoFactorToken });
  }
  await updateSession({
    unlocked: true,
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.expiresAt,
    pending: undefined,
    ssoError: undefined,
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
  const remembered = (await getLocal("rememberTokens"))?.[email];
  try {
    const t = await passwordToken(base, {
      email,
      authHash,
      deviceId,
      ...(remembered ? { twoFactor: { provider: TWO_FACTOR.Remember, token: remembered, remember: false } } : {}),
    });
    await completeLogin(email, kdf, handle, t);
  } catch (e) {
    if (e instanceof TwoFactorRequired) {
      if (remembered) {
        // The server rejected (or expired) our remember token: forget it and ask for a real code.
        const all = (await getLocal("rememberTokens")) ?? {};
        delete all[email];
        await setLocal("rememberTokens", all);
      }
      await updateSession({
        pending: { email, kdf, handle, challenge: e.challenge, expiresAt: Date.now() + PENDING_TTL_MS },
      });
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
    await completeLogin(pending.email, pending.kdf, pending.handle, t);
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
  if (pending) await coreCall({ op: "freeKey", handle: pending.handle }).catch(() => undefined);
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
  await updateSession({ unlocked: true });
  await touchAutoLock();
}

export async function logout(): Promise<void> {
  await lockNow();
  await removeLocal("account", "vault");
  await updateSession({ accessToken: undefined, accessExpiresAt: undefined });
}

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function accessToken(): Promise<string> {
  const s = await getSession();
  if (s.accessToken && (s.accessExpiresAt ?? 0) - 60_000 > Date.now()) return s.accessToken;
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
    await updateSession({ sso: undefined, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  } catch (e) {
    await updateSession({ sso: undefined, ssoError: e instanceof Error ? e.message : String(e) });
    if (!(e instanceof UserError)) throw e;
  } finally {
    // Closed only once the outcome is stored, so a popup opened right after shows it.
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
