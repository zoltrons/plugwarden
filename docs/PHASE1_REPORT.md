# Phase 1 report: skeleton + auth

Date: 2026-10-29. Browser for tests: Helium 156.0.8078.47 (Chromium 156), headless, via Playwright.
Server: Vaultwarden 1.37.4 (local Docker).

## Done

* MV3 manifest, `minimum_chrome_version: 156`, CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
* Permissions: `storage`, `alarms`, `idle`, `offscreen` + optional host permission per server origin
  (approved; reason: Vaultwarden CORS, see COMPATIBILITY.md).
* esbuild build (`npm run build`), `tsc` type check, Node unit tests, e2e harness.
* Server URL setup with capability info from `/api/config`.
* Login with password, PBKDF2 and Argon2id; TOTP two-step login with "remember this device";
  email two-step login (code request + submit).
* Refresh-token grant (`accessToken()` in `src/background/account.ts`, transport tested).
* Lock / unlock, auto-lock via `chrome.alarms` (1 min – 4 h, or browser restart), lock on OS lock via `chrome.idle`.
* Keys live only in a worker inside the offscreen document; lock terminates it.
* Popup with its own dense admin-style design system (no third-party assets copied), light + dark.

## Verified (`npm run test:e2e`, all 10 steps pass)

transport contract (prelogin, password + refresh grant, revision-date) · setup + host permission ·
PBKDF2-600k login · popup first render **~20 ms** (budget 100 ms) · lock frees the offscreen
document · wrong password rejected · no master password / auth hash in extension storage · auto-lock
alarm · Argon2id 3/64 MiB/4 login · TOTP 2FA incl. wrong code · remembered device skips 2FA.
Unit tests: 3/3 (`npm test`). Rust: 5 unit + test-vector parity.

## Sizes (release build)

| file | raw | brotli |
|---|---:|---:|
| core_wasm_bg.wasm (SIMD) | 621.6 KiB | 195.9 KiB |
| background.js | 13.0 KiB | 4.3 KiB |
| popup.js + popup.css | 10.5 + 9.0 KiB | 3.6 + 2.1 KiB |
| offscreen.js + worker.js (incl. wasm glue) | 2.6 + 7.3 KiB | 1.1 + 2.7 KiB |

No runtime dependencies. Dev dependencies (approved): esbuild, typescript, @types/chrome, playwright-core.

## Not done / not verified

* Email 2FA is not covered by e2e (deferred by decision; needs an SMTP catcher).
* The service worker's refresh path (`accessToken()`) has no caller until Phase 2 sync; only the
  transport function is tested.
* `idle` "locked" handling is not tested (cannot simulate an OS lock headless).
* CI workflows and Renovate config are written but have not run (no GitHub remote yet).
* Only English strings (`_locales/en`); Turkish deferred by decision.
* Other 2FA providers (WebAuthn, YubiKey, Duo) show "not supported yet" (Phase 4).
