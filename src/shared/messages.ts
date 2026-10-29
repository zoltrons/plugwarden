// Typed message bus. Every message crossing a context boundary is validated on receipt.
//   popup  --Request-->  service worker  --OffscreenRequest-->  offscreen doc  --postMessage-->  worker
import { AUTO_LOCK_CHOICES } from "./constants.ts";
import { bool, literal, num, obj, opt, str, type Validator, ValidationError } from "./validate.ts";

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
  | { type: "setSettings"; autoLockMinutes?: number; lockOnSystemLock?: boolean };

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
  | { op: "status" };

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
};

export function parseCoreRequest(v: unknown): CoreRequest {
  const op = (v as { op?: unknown } | null)?.op;
  if (typeof op !== "string" || !Object.hasOwn(coreValidators, op)) throw new ValidationError("unknown core op");
  return coreValidators[op as CoreRequest["op"]](v, "");
}
