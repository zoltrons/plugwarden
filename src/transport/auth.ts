// Identity endpoints (mirrors vaultwarden src/api/identity.rs, see upstream-map.yaml).
import { CLIENT_NAME, DEVICE_NAME, DEVICE_TYPE, TWO_FACTOR } from "../shared/constants.ts";
import type { KdfParams, TwoFactorChallenge } from "../shared/messages.ts";
import { ci, num, obj, opt, parse, str } from "../shared/validate.ts";
import { ApiError, call } from "./http.ts";

const preloginResponse = obj({ kdf: num, kdfIterations: num, kdfMemory: opt(num), kdfParallelism: opt(num) });

export async function prelogin(base: string, email: string): Promise<KdfParams> {
  const r = parse(preloginResponse, await call(base, "POST", "/identity/accounts/prelogin", { json: { email } }));
  return { type: r.kdf, iterations: r.kdfIterations, memory: r.kdfMemory ?? 0, parallelism: r.kdfParallelism ?? 0 };
}

const tokenResponse = obj({
  access_token: str,
  expires_in: num,
  refresh_token: opt(str),
  Key: opt(str),
  PrivateKey: opt(str),
  Kdf: opt(num),
  KdfIterations: opt(num),
  KdfMemory: opt(num),
  KdfParallelism: opt(num),
  TwoFactorToken: opt(str),
});
export type TokenResponse = ReturnType<typeof tokenResponse>;

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
}

export const toTokens = (t: TokenResponse, now = Date.now()): Tokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: now + t.expires_in * 1000,
});

export class TwoFactorRequired extends Error {
  override name = "TwoFactorRequired";
  readonly challenge: TwoFactorChallenge;
  constructor(challenge: TwoFactorChallenge) {
    super("Two-factor authentication required");
    this.challenge = challenge;
  }
}

/** Recognizes Vaultwarden's 400 `{"error":"invalid_grant","TwoFactorProviders":[...]}` body. */
export function parseTwoFactorChallenge(body: unknown): TwoFactorChallenge | undefined {
  const providers = ci(body, "TwoFactorProviders");
  if (!Array.isArray(providers)) return undefined;
  const ids = providers.map(Number).filter(Number.isInteger);
  // An empty (or non-numeric) list is not a challenge: Vaultwarden also sends the key on plain
  // errors, and treating those as 2FA would show a dead-end screen instead of "wrong password".
  if (!ids.length) return undefined;
  const p2 = ci(body, "TwoFactorProviders2");
  const emailInfo = ci(p2, String(TWO_FACTOR.Email));
  const emailHint = ci(emailInfo, "Email");
  const webauthn = ci(p2, String(TWO_FACTOR.WebAuthn));
  return {
    providers: ids,
    ...(typeof emailHint === "string" ? { emailHint } : {}),
    ...(webauthn && typeof webauthn === "object" ? { webauthn: JSON.stringify(webauthn) } : {}),
  };
}

export interface PasswordGrant {
  email: string;
  authHash: string;
  deviceId: string;
  twoFactor?: { provider: number; token: string; remember: boolean };
}

const deviceForm = (deviceId: string) => ({
  scope: "api offline_access",
  client_id: CLIENT_NAME,
  deviceType: String(DEVICE_TYPE),
  deviceIdentifier: deviceId,
  deviceName: DEVICE_NAME,
});

export async function passwordToken(base: string, g: PasswordGrant): Promise<TokenResponse> {
  const form: Record<string, string> = { grant_type: "password", username: g.email, password: g.authHash, ...deviceForm(g.deviceId) };
  if (g.twoFactor) {
    form.twoFactorProvider = String(g.twoFactor.provider);
    form.twoFactorToken = g.twoFactor.token;
    form.twoFactorRemember = g.twoFactor.remember ? "1" : "0";
  }
  return grant(base, form);
}

/** SSO: redeems the code Vaultwarden handed to `redirectUri` (PKCE). */
export async function authorizationCodeToken(base: string, code: string, verifier: string, redirectUri: string, deviceId: string): Promise<TokenResponse> {
  return grant(base, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, ...deviceForm(deviceId) });
}

/** Errors unless Vaultwarden has SSO turned on. */
export async function ssoPrevalidate(base: string): Promise<void> {
  await call(base, "GET", "/identity/sso/prevalidate");
}

async function grant(base: string, form: Record<string, string>): Promise<TokenResponse> {
  try {
    return parse(tokenResponse, await call(base, "POST", "/identity/connect/token", { form }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      const challenge = parseTwoFactorChallenge(e.body);
      if (challenge) throw new TwoFactorRequired(challenge);
    }
    throw e;
  }
}

export async function refreshToken(base: string, refresh: string): Promise<TokenResponse> {
  const form = { grant_type: "refresh_token", client_id: CLIENT_NAME, refresh_token: refresh };
  return parse(tokenResponse, await call(base, "POST", "/identity/connect/token", { form }));
}

/** Asks Vaultwarden to mail an email-2FA code (no bearer token; authenticated by the hash). */
export async function sendEmailLogin(base: string, email: string, authHash: string, deviceId: string): Promise<void> {
  await call(base, "POST", "/api/two-factor/send-email-login", {
    json: { email, masterPasswordHash: authHash, deviceIdentifier: deviceId },
  });
}

export async function revisionDate(base: string, token: string): Promise<number> {
  return parse(num, await call(base, "GET", "/api/accounts/revision-date", { token }));
}

/** JWT payload `sub` (user id). The token is not verified here; the server does that. */
export const jwtSubject = (token: string): string | undefined => jwtClaim(token, "sub");

export function jwtClaim(token: string, name: string): string | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const json = new TextDecoder().decode(Uint8Array.fromBase64(part, { alphabet: "base64url" }));
    const v = (JSON.parse(json) as Record<string, unknown>)[name];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
