// Passkey authenticator, run in the crypto worker. Credentials live in Login items as
// `login.fido2Credentials[]`, using exactly the fields of the SDK's CipherFido2CredentialModel
// (bitwarden-api-api) so the SDK and the official clients read and write the same records:
// credentialId, keyType, keyAlgorithm, keyCurve, keyValue, rpId, rpName, userHandle, userName,
// userDisplayName, counter, discoverable, creationDate (all EncStrings except creationDate).
// The SDK at the pinned rev has no WebAuthn authenticator (the official browser extension
// implements WebAuthn in TypeScript as well), so ES256 lives here: ECDSA P-256 via WebCrypto, and the
// private key never leaves the worker.
import { ci } from "../shared/validate.ts";

type Json = Record<string, unknown>;

export const b64u = (b: Uint8Array): string => b.toBase64({ alphabet: "base64url", omitPadding: true });
export const fromB64u = (s: string): Uint8Array => Uint8Array.fromBase64(s, { alphabet: "base64url" });
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Bitwarden stores 16-byte ids as GUID strings, anything else as "b64.<base64url>". */
export function credentialIdBytes(id: string): Uint8Array {
  if (id.startsWith("b64.")) return fromB64u(id.slice(4));
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("bad credential id");
  return Uint8Array.fromHex(hex);
}

/** WebAuthn: the RP ID must be the origin's host or a registrable parent of it, on a secure origin. */
export function checkRpId(rpId: string, origin: string, isPublicSuffix: (d: string) => boolean): void {
  const u = new URL(origin);
  const host = u.hostname.toLowerCase();
  // WebAuthn treats loopback as a secure context (dev servers on http).
  const secure = u.protocol === "https:" || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const id = rpId.toLowerCase();
  if (!secure || !(host === id || host.endsWith(`.${id}`)) || (id !== host && isPublicSuffix(id)))
    throw new Error("SecurityError: the relying party id is not valid for this origin");
}

// Minimal CBOR encoder: unsigned/negative ints, text, bytes, maps. Enough for attestation objects and COSE keys.
export function cbor(v: unknown): number[] {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (v instanceof Map) return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
  throw new Error("cbor: unsupported value");
}

/** ECDSA raw r||s (WebCrypto) to the DER encoding WebAuthn signatures use. */
export function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0]! & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const sha256 = async (b: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : (b as Uint8Array<ArrayBuffer>)));

// Flags: UP | UV, and BE | BS because the credential syncs through the vault. AT is added on creation.
const FLAGS = 0x01 | 0x04 | 0x08 | 0x10;
const AT = 0x40;
const AAGUID = new Uint8Array(16); // none attestation: no authenticator model is claimed

async function authData(rpId: string, flags: number, counter: number, attested: number[] = []): Promise<Uint8Array> {
  return new Uint8Array([...(await sha256(rpId)), flags, counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255, ...attested]);
}

const clientData = (type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

export interface CreateInput {
  origin: string;
  rpId: string;
  rpName: string;
  /** base64url */
  challenge: string;
  user: { id: string; name: string; displayName: string };
  discoverable: boolean;
}

/** New ES256 credential: the stored fido2Credential plus the attestation response for the page. */
export async function createCredential(i: CreateInput) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); // 0x04 || x || y
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const credentialId = crypto.randomUUID();
  const rawId = credentialIdBytes(credentialId);
  const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, pub.subarray(1, 33)], [-3, pub.subarray(33)]]);
  const data = await authData(i.rpId, FLAGS | AT, 0, [...AAGUID, rawId.length >> 8, rawId.length & 255, ...rawId, ...cbor(cose)]);
  const attestationObject = new Uint8Array(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]])));
  return {
    fido2Credential: {
      credentialId,
      keyType: "public-key",
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
      keyValue: b64u(pkcs8),
      rpId: i.rpId,
      rpName: i.rpName,
      userHandle: i.user.id,
      userName: i.user.name,
      userDisplayName: i.user.displayName,
      counter: "0",
      discoverable: String(i.discoverable),
      creationDate: new Date().toISOString(),
    },
    response: {
      id: b64u(rawId),
      clientDataJSON: b64u(clientData("webauthn.create", i.challenge, i.origin)),
      attestationObject: b64u(attestationObject),
      authenticatorData: b64u(data),
      publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
      publicKeyAlgorithm: -7,
      transports: ["internal", "hybrid"],
      // Reported back through getClientExtensionResults(): tells the site the passkey is discoverable.
      credProps: { rk: i.discoverable },
    },
  };
}

/** Assertion with a stored credential. Bitwarden keeps synced counters at 0, so we do too. */
export async function assert(cred: Json, origin: string, challenge: string) {
  const key = await crypto.subtle.importKey("pkcs8", fromB64u(s(ci(cred, "keyValue"))) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const data = await authData(s(ci(cred, "rpId")), FLAGS, Number(s(ci(cred, "counter"))) || 0);
  const cd = clientData("webauthn.get", challenge, origin);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array([...data, ...(await sha256(cd))])));
  return {
    id: b64u(credentialIdBytes(s(ci(cred, "credentialId")))),
    clientDataJSON: b64u(cd),
    authenticatorData: b64u(data),
    signature: b64u(derSignature(sig)),
    userHandle: s(ci(cred, "userHandle")) || null,
  };
}
