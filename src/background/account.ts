// Login, 2FA, unlock, token refresh. Pure orchestration: crypto runs in the offscreen worker,
// HTTP in src/transport.
import { KDF_ARGON2ID, TWO_FACTOR } from "../shared/constants.ts";
import type { ErrorCode, KdfParams } from "../shared/messages.ts";
import {
  jwtSubject,
  passwordToken,
  prelogin,
  refreshToken,
  sendEmailLogin,
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
  const code = token.replace(/\s+/g, "");
  if (!code) throw new UserError("invalid", "Enter the verification code");
  try {
    const t = await passwordToken(base, {
      email: pending.email,
      authHash,
      deviceId: await getDeviceId(),
      twoFactor: { provider, token: code, remember },
    });
    await completeLogin(pending.email, pending.kdf, pending.handle, t);
  } catch (e) {
    if (e instanceof TwoFactorRequired || (e instanceof ApiError && e.status === 400))
      throw new UserError("badTwoFactor", e instanceof ApiError ? e.message : "Invalid verification code");
    throw e;
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
