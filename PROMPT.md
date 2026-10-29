You are building "Plugwarden": a minimal, fast, fully native Manifest V3 Chrome extension (target: Chromium 156) that is a Bitwarden-compatible password manager client for a self-hosted Vaultwarden server. Working directory: C:\Users\Eray\Documents\plugwarden (git repo). Respond to me in Turkish; code, comments and commit messages in English.

## Hard requirements
1. Full compatibility with Vaultwarden (latest release, currently 1.37.4). The server is the source of truth for the protocol. Compatibility is the top priority, above features.
2. As light and fast as possible: no Angular/React/RxJS/webpack. No UI framework, or a <5 KB one. Bundle with esbuild. Content script <10 KB and it must do nothing on pages without login fields. Popup first paint <100 ms. The service worker must be stateless and event driven.
3. Only take from Bitwarden what is needed: crypto, KDF, EncString, cipher decrypt/encrypt, TOTP, password generator. Do NOT take Angular code, admin-console, billing, org/member-admin, SSH, autotype, IPC, or the generated bitwarden-api-* HTTP clients.
4. An architecture that makes syncing with upstream (bitwarden/clients, bitwarden/sdk-internal) easy. See "Upstream sync" below.
5. Security: minimal permissions (start with activeTab, scripting, storage, alarms, idle, offscreen, clipboardWrite; add others only with written justification), CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, decrypted data only in memory (offscreen document / storage.session), auto-lock via idle+alarms, clipboard clearing, schema-validated messaging, zeroize secrets in Rust.

## Reference material (read, do not blindly copy)
- https://github.com/bitwarden/clients  (apps/browser: manifest.v3.json, src/autofill/content, src/autofill/*.design.md and performance.design.md, src/platform/offscreen-document, src/background). Official manifest sets minimum_chrome_version 134; we target 156.
- https://github.com/bitwarden/sdk-internal  (crates: bitwarden-crypto, bitwarden-vault, bitwarden-generators, bitwarden-auth for reference only; bitwarden-wasm-internal/build.sh shows how the official WASM is built; test-vectors/). The published @bitwarden/sdk-internal WASM is ~8.2 MB, too big for us; we build our own pruned WASM crate.
- https://github.com/dani-garcia/vaultwarden (src/api/identity.rs, src/api/core/accounts.rs, src/api/core/ciphers.rs). Facts already verified: POST /identity/accounts/prelogin and /prelogin/password; POST /identity/connect/token (grant types password, refresh_token, client_credentials, authorization_code only if SSO is on; requires device_identifier, device_name, device_type, scope); token response contains Kdf/KdfIterations/KdfMemory/KdfParallelism, Key, UserDecryptionOptions; GET /api/sync contains a userDecryption block; 2FA: Authenticator, Email, FIDO2, YubiKey, Duo.
- Use Context7 / official docs to verify current Chrome MV3 APIs for Chromium 156 (offscreen, scripting, storage.session, alarms, idle, commands, sidePanel). Do not assume APIs exist; verify and note anything you could not verify.
- Licensing: sdk-internal is dual licensed (GPL-3.0-only OR Bitwarden SDK License, which requires a "Compatible Application"); clients is GPLv3; Vaultwarden is AGPL-3.0. Record the chosen license decision in docs/LICENSING.md and ask me before copying any upstream source into this repo. Depending on a pinned git rev of a crate is preferred over copying.

## Target architecture
Monorepo layout (adjust only with justification):
- crates/core-wasm   Rust cdylib, wasm-bindgen. Depends on bitwarden-crypto and bitwarden-vault (and bitwarden-generators if it stays small) via git dependency pinned to an exact rev from upstream.lock. Expose a tiny API: deriveMasterKey, makeAuthHash, unlockUserKey, decryptCipherList/decryptCipher, encryptCipher, totp, generatePassword. Batch calls (decrypt the whole vault in one call) to avoid JS<->WASM chatter. Build profile: opt-level="z", lto, codegen-units=1, panic="abort", strip; then wasm-opt -Oz. Track WASM size in CI (fail if over budget; set the initial budget after the Phase 0 measurement).
- src/transport      Thin typed fetch client for ONLY the endpoints Vaultwarden supports and we use: prelogin, connect/token (+refresh), sync, ciphers/folders CRUD, profile, revision-date, 2FA login. Send correct Bitwarden-Client-Name/Version and Device-Type headers (verify exact values from clients and Vaultwarden source). Runtime-validate responses (small hand-written validators, no heavy libs). Tolerate unknown fields; be case-insensitive on JSON keys where Vaultwarden mixes camelCase/PascalCase.
- src/vault          Encrypted local cache (chrome.storage.local/IndexedDB), lock/unlock state machine, incremental sync via revision date, in-memory decrypted index for search.
- src/background     Stateless service worker; routing, alarms, commands, context menu.
- src/offscreen      Hosts the WASM module; lazy-loaded; closes when idle.
- src/autofill       Minimal login-form detector (document_idle, bails out immediately if no password field), isolated-world fill via chrome.scripting on demand, URI matching (domain, host, startsWith, exact, regex, never), iframe + shadow DOM support in later phase.
- src/ui             Popup (vanilla TS / Web Components), locale-ready.
- tools/             sync-upstream, size-budget, e2e helpers.
- docs/              ARCHITECTURE.md, COMPATIBILITY.md, LICENSING.md, UPSTREAM_SYNC.md.
Strict module boundaries: UI and autofill never touch crypto or the network directly; everything goes through a typed message bus with schemas in src/shared.

## Upstream sync design (must be implemented, not just documented)
- upstream.lock: pinned sdk-internal rev, bitwarden/clients commit, targeted Vaultwarden version(s).
- upstream-map.yaml: maps each upstream file/dir we learn from to the local module that mirrors it (e.g. clients/apps/browser/src/autofill/content/* -> src/autofill/*; sdk-internal/test-vectors -> crates/core-wasm/tests; vaultwarden identity.rs -> src/transport/auth.ts), with a short note on what to keep in sync.
- tools/sync-upstream: for each mapped path, fetch the diff between the pinned commit and upstream main (via gh api or git), and output a Markdown report grouped by local module, flagging breaking changes (new fields, changed enums, new key formats such as COSE/v2 keys, KDF changes). Never edits code automatically.
- Cargo git-dependency pin bump and a CI job that updates it, runs the test vectors and the Vaultwarden integration tests, and reports WASM size delta. Add a Renovate config for JS deps and the SDK rev.
- Contract tests: (a) crypto against sdk-internal/test-vectors; (b) end-to-end against a Dockerized vaultwarden/server:<pinned> and :latest matrix: register a test user through the API, prelogin -> token -> sync -> create/edit/delete cipher -> verify using an independent official client path (e.g. the official `bw` CLI) that the item decrypts correctly in both directions.
- Feature flags / capability detection: the transport layer detects server capabilities (version from /api/config if available) instead of hardcoding assumptions.

## Phases (stop and report after each; keep the task list updated)
Phase 0 Spike (decision gate): 1) docker compose with Vaultwarden + a test user; 2) raw fetch prelogin -> token -> sync working against it; 3) build the pruned core-wasm crate, measure .wasm size (raw, gzip, brotli), instantiate time and Argon2id/PBKDF2 unlock time in an offscreen document; 4) compare with the official 8.2 MB build; 5) if pruning is impossible (dependency bleed from bitwarden-core), report the cause and propose fallback: only bitwarden-crypto, or WebCrypto with test-vector parity. STOP and show me the numbers before Phase 1.
Phase 1 Skeleton + auth: manifest (minimum_chrome_version 156, to be verified), build tooling, server URL setup, login with password (PBKDF2 and Argon2id), TOTP/email 2FA, refresh tokens, lock/unlock, auto-lock.
Phase 2 Vault: sync, encrypted cache, list/search/view, cipher CRUD, folders, TOTP codes, password generator.
Phase 3 Autofill: detector, popup fill, Ctrl+Shift+L command, context menu, URI matching, "save/update login" prompt.
Phase 4 (optional, ask first): WebAuthn/YubiKey 2FA, passkeys, Send, side panel, import/export, SSO.
Phase 5 Hardening: security review, perf profiling (cold start, memory, content script cost), e2e with Playwright, Chrome Web Store checklist.

## Working rules
- Verify before claiming: if you did not run it, say so. Report failing tests with output.
- Keep dependencies minimal; justify each one. Report bundle sizes after each phase.
- Do not commit secrets or test credentials outside docker-compose test fixtures.
- Ask me before: copying upstream code, adding permissions, adding dependencies over 20 KB, changing the license plan, or publishing anything.
- Start now with Phase 0. First write docs/ARCHITECTURE.md and upstream.lock skeleton, then the spike.
