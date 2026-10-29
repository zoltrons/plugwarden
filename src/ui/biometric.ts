// Biometric unlock through WebAuthn's PRF extension (hmac-secret).
//
// The extension creates a platform-authenticator credential (Touch ID, Windows Hello, …) and asks
// the authenticator for a stable PRF output over a random salt. Only that output is used, as the
// key-wrapping key for the user key (see `prfProtectUserKey` in the WASM core); the biometric
// secret itself never leaves the authenticator. Every unlock is an assertion with
// `userVerification: "required"`, so the OS demands the biometric (or the device passcode) again.
//
// The credential's RP ID defaults to the extension origin, so no other site or extension can use it.
// Devices whose authenticator has no PRF support are refused instead of falling back to a weaker
// "biometrics as a UI gate" scheme.
import { t } from "./dom.ts";

type PrfClientResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function b64uEncode(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function b64Encode(buffer: ArrayBuffer): string {
  let raw = "";
  for (const b of new Uint8Array(buffer)) raw += String.fromCharCode(b);
  return btoa(raw);
}

function prfResults(credential: PublicKeyCredential): PrfClientResults {
  return credential.getClientExtensionResults() as PrfClientResults;
}

function friendly(e: unknown): Error {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return new Error(t("biometricCancelled"));
    if (e.name === "InvalidStateError") return new Error(t("biometricAlreadySetUp"));
    if (e.name === "NotSupportedError" || e.name === "SecurityError") return new Error(t("biometricUnavailable"));
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function platformAuthenticatorAvailable(): Promise<boolean> {
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function assertionPrf(credentialId: BufferSource, salt: BufferSource): Promise<ArrayBuffer> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: random(32),
    allowCredentials: [{ type: "public-key", id: credentialId, transports: ["internal"] }],
    userVerification: "required",
    timeout: 60_000,
  };
  (publicKey as { extensions?: unknown }).extensions = { prf: { eval: { first: salt } } };
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error(t("biometricCancelled"));
  const first = prfResults(credential).prf?.results?.first;
  if (!first) throw new Error(t("biometricPrfUnsupported"));
  return first;
}

/** Creates the unlock credential and returns its id, salt and the PRF output for wrapping. */
export async function createBiometricCredential(email: string): Promise<{ credentialId: string; prfSalt: string; prf: string }> {
  if (!(await platformAuthenticatorAvailable())) throw new Error(t("biometricUnavailable"));
  const salt = random(32);
  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { name: "Plugwarden" },
    user: { id: random(16), name: email, displayName: email },
    challenge: random(32),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    timeout: 60_000,
  };
  (publicKey as { extensions?: unknown }).extensions = { prf: { eval: { first: salt } } };
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (e) {
    throw friendly(e);
  }
  if (!credential) throw new Error(t("biometricCancelled"));
  const results = prfResults(credential);
  if (results.prf?.enabled === false && !results.prf.results) throw new Error(t("biometricPrfUnsupported"));
  // Some authenticators only evaluate the PRF on assertions, so ask the fresh credential once more.
  let first = results.prf?.results?.first;
  if (!first) {
    try {
      first = await assertionPrf(credential.rawId, salt);
    } catch (e) {
      throw friendly(e);
    }
  }
  return { credentialId: b64uEncode(new Uint8Array(credential.rawId)), prfSalt: b64uEncode(salt), prf: b64Encode(first) };
}

/** Asks the authenticator for the PRF output (with user verification) for an existing credential. */
export async function getBiometricPrf(credentialId: string, prfSalt: string): Promise<string> {
  try {
    return b64Encode(await assertionPrf(b64uDecode(credentialId), b64uDecode(prfSalt)));
  } catch (e) {
    throw friendly(e);
  }
}
