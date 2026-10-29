// Values sent to the server. Vaultwarden gates some behaviour on these, so they track the official
// browser extension release pinned in upstream.lock ([clients].release), not our own version.
export const CLIENT_NAME = "browser";
export const CLIENT_VERSION = "2026.10.1";
/** Vaultwarden DeviceType::ChromeExtension. */
export const DEVICE_TYPE = 2;
export const DEVICE_NAME = "chrome";

export const KDF_PBKDF2 = 0;
export const KDF_ARGON2ID = 1;

/** Bitwarden TwoFactorProviderType values we handle. */
export const TWO_FACTOR = { Authenticator: 0, Email: 1, YubiKey: 3, Remember: 5, WebAuthn: 7 } as const;

export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240, -1] as const; // minutes, -1 = on browser restart
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

/** Bitwarden UriMatchStrategy (clients: libs/common/src/vault/models/domain/login-uri.ts). */
export const URI_MATCH = { Domain: 0, Host: 1, StartsWith: 2, Exact: 3, RegularExpression: 4, Never: 5 } as const;
export const URI_MATCH_CHOICES = [0, 1, 2, 3, 4, 5] as const;
/** Strategies the clients hide behind an "advanced" warning. */
export const URI_MATCH_ADVANCED: readonly number[] = [URI_MATCH.StartsWith, URI_MATCH.RegularExpression];

/** ClearClipboardDelay, as in clients libs/common/src/autofill/constants. */
export const CLEAR_CLIPBOARD_CHOICES = ["never", "tenSeconds", "twentySeconds", "thirtySeconds", "oneMinute", "twoMinutes", "fiveMinutes"] as const;
export type ClearClipboardDelay = (typeof CLEAR_CLIPBOARD_CHOICES)[number];
/** Milliseconds per choice; the official client defaults to five minutes. */
export const CLEAR_CLIPBOARD_MS: Record<ClearClipboardDelay, number> = {
  never: 0,
  tenSeconds: 10_000,
  twentySeconds: 20_000,
  thirtySeconds: 30_000,
  oneMinute: 60_000,
  twoMinutes: 120_000,
  fiveMinutes: 300_000,
};
