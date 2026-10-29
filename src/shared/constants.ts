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
export const TWO_FACTOR = { Authenticator: 0, Email: 1, Remember: 5, WebAuthn: 7 } as const;

export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240, -1] as const; // minutes, -1 = on browser restart
export const DEFAULT_AUTO_LOCK_MINUTES = 15;
