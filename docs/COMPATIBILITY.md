# Compatibility notes

Facts verified against **Vaultwarden 1.37.4** (`vaultwarden/server@sha256:efb3cde9…`, local Docker)
on 2026-10-29 by `spike/vw-flow.mjs`, unless marked otherwise.

## Server identity / capability detection

* `GET /api/config` → `version: "2026.6.0"` (the Bitwarden-server level Vaultwarden claims),
  `server.name: "Vaultwarden"`, `settings.disableUserRegistration`, `featureStates{...}`.
  Use `version` for capability gating (e.g. cipher key encryption needs ≥ 2024.2.0).

## Headers

* `Device-Type: 2` (ChromeExtension). Vaultwarden reads the lowercase `device-type` header and
  falls back to UnknownBrowser.
* `Bitwarden-Client-Version` must parse as semver on routes that use the `ClientVersion` guard.
  We send `2026.10.1` (browser-v2026.10.1 pin). `Bitwarden-Client-Name: browser`.
  Exact header set of the official extension still to be confirmed from
  `clients/libs/common/src/platform/services/api.service.ts` in Phase 1 (not yet read).

## Registration (test harness only)

* `POST /identity/accounts/register/send-verification-email {email, name}` returns the
  verification token directly (JSON string) when mail is disabled.
* `POST /identity/accounts/register/finish` accepts the "old" flat shape:
  `email, emailVerificationToken, masterPasswordHash, key, kdf, kdfIterations, kdfMemory,
  kdfParallelism, userAsymmetricKeys{publicKey, encryptedPrivateKey}`. The newer
  `masterPasswordAuthentication/masterPasswordUnlock` shape is also accepted (not tested yet).

## Prelogin

* `POST /identity/accounts/prelogin {email}` → camelCase:
  `kdf, kdfIterations, kdfMemory, kdfParallelism, kdfSettings, salt`.

## Token

* `POST /identity/connect/token` (form-encoded). Password grant fields used:
  `grant_type=password, username, password=<ServerAuthorization hash>, scope="api offline_access",
  client_id=browser, deviceType=2, deviceIdentifier=<uuid>, deviceName`.
* Response keys are **PascalCase** except the OAuth ones:
  `AccountKeys, ForcePasswordReset, Kdf, KdfIterations, KdfMemory, KdfParallelism, Key,
  MasterPasswordPolicy, PrivateKey, UserDecryptionOptions, access_token, expires_in,
  refresh_token, scope, token_type`.
* `UserDecryptionOptions.MasterPasswordUnlock` = `{Kdf{KdfType,Iterations,Memory,Parallelism},
  MasterKeyEncryptedUserKey, MasterKeyWrappedUserKey, Salt}` (PascalCase, nested).
* Refresh grant: `grant_type=refresh_token, client_id, refresh_token` → only
  `access_token, expires_in, refresh_token, scope, token_type`.
* JWT `sub` is the user id (needed for `encryptedFor`, below).

## Sync

* `GET /api/sync?excludeDomains=true` → camelCase: `ciphers, collections, domains, folders, object,
  policies, policiesNew, profile, sends, userDecryption`.
* `userDecryption.masterPasswordUnlock` is the camelCase twin of the token's
  `UserDecryptionOptions.MasterPasswordUnlock` (`kdf{kdfType,iterations,memory,parallelism}`).
  → Validators must be case-insensitive.

## Ciphers

* Cipher JSON is camelCase and already includes new item types:
  `bankAccount, driversLicense, passport, sshKey, archivedDate, permissions`.
* **`POST /api/ciphers` and `PUT /api/ciphers/{id}` require `encryptedFor` (user id)**; without it
  the request fails with 422 (`missing field encryptedFor`). Added in the web-v2025.6.0 protocol.
* `DELETE /api/ciphers/{id}` hard-deletes; `PUT /api/ciphers/{id}/delete` moves to trash (sets
  `deletedDate`, verified). Plugwarden only uses the trash.
* `PUT /api/ciphers/{id}` with `lastKnownRevisionDate` (ISO 8601) is refused with "The client copy of
  this cipher is out of date" when the server copy is more than 1 s newer (verified).
* Folders: `POST /api/folders {name: EncString}`; sync returns them encrypted under the user key.
* `GET /api/accounts/revision-date` → integer (ms since epoch).

## CORS and two-step login (verified in Phase 1)

* **CORS allows only `DOMAIN`, `file://` and the desktop origin**, never `chrome-extension://`
  (`src/util.rs` `Cors::get_allowed_origin`). The extension therefore needs a host permission for the
  server; it is requested per origin at setup.
* 2FA challenge: HTTP 400 `{"error":"invalid_grant","TwoFactorProviders":["0"],
  "TwoFactorProviders2":{"0":null,"1":{"Email":"a***@x"}}}`. Provider ids arrive as strings.
* Retry with form fields `twoFactorProvider`, `twoFactorToken`, `twoFactorRemember=1`; success adds
  `TwoFactorToken`, which later logins send as provider `5` (Remember) instead of a code.
* A wrong code returns Vaultwarden's generic error body: `error_description` is `""`, the text is in
  `message` / `ErrorModel.Message`.
* A TOTP code cannot be reused within its step (also across enable → login).
* Email 2FA code request: `POST /api/two-factor/send-email-login {email, masterPasswordHash,
  deviceIdentifier}` (no bearer). Implemented, **not covered by e2e** (needs SMTP).
* Unauthenticated endpoints (register, prelogin, send-email-login) share
  `UNAUTHENTICATED_RATELIMIT_*` (default burst 50 / 60 s); the test compose relaxes it.

## Not yet verified

* Organization ciphers / org keys against a real server (decapsulation code exists, untested on VW).
* Cipher key encryption (`key` on new ciphers) and V2 "blob" ciphers (`data` =
  `{"format_version":1,"wrapped_cek":...}`): present in sdk-internal test vectors; whether Vaultwarden
  1.37.4 stores/returns blob ciphers is unknown.
* Round-trip with the official `bw` CLI (contract test b) → Phase 1/2.

## Chromium 156 (verified in Playwright Chromium 156.0.8078.4)

* MV3 extension with `minimum_chrome_version: "156"`, module service worker, CSP
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` loads and instantiates WASM in an
  offscreen document.
* `chrome.offscreen.hasDocument()` exists (docs: Chrome 150+), used by the bench.
* Offscreen reasons (developer.chrome.com, via Context7): no reason fits "hold secrets in memory";
  the spike used `WORKERS`. To decide in Phase 1.
