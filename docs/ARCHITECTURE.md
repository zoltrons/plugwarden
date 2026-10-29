# Plugwarden architecture

Plugwarden is a Manifest V3 Chrome extension (Chromium 156+) that talks to a self-hosted
**Vaultwarden** server using the Bitwarden client protocol. Priorities, in order:

1. Protocol compatibility with Vaultwarden (pinned in `upstream.lock`; the server is the source of truth).
2. Security (minimal permissions, plaintext only in memory, auto-lock).
3. Size and speed (no UI framework, esbuild, small pruned WASM, cheap content script).
4. Easy upstream sync (pinned revs, upstream map, diff reports, contract tests).

## Process model

```
 ┌─────────────┐  typed msgs   ┌──────────────────────────┐  typed msgs  ┌─────────────────────────┐
 │ popup (ui)  │ ────────────► │ service worker            │ ───────────► │ offscreen document      │
 └─────────────┘               │ (background, stateless)   │              │ - core-wasm (lazy)      │
 ┌─────────────┐  typed msgs   │ - message router          │ ◄─────────── │ - unlocked user key     │
 │ content     │ ────────────► │ - transport (fetch)       │              │ - decrypted vault index │
 │ script      │               │ - alarms / idle / commands│              │ - closes when idle/lock │
 │ (autofill)  │ ◄──────────── │ - chrome.scripting fill   │              └─────────────────────────┘
 └─────────────┘               └──────────────────────────┘
        chrome.storage.local:   encrypted vault cache, refresh token, settings
        chrome.storage.session: lock state, timestamps (TRUSTED_CONTEXTS only)
```

* **Service worker** (`src/background`): stateless and event driven. Every handler re-reads what it
  needs from `chrome.storage.*`; nothing important lives in globals (the SW can be killed at any time).
  Owns network I/O (`src/transport`), alarms (auto-lock, token refresh, periodic sync), `idle`,
  `commands`, context menu, and on-demand `chrome.scripting.executeScript` for fill.
* **Offscreen document** (`src/offscreen`, reason `WORKERS`): spawns one dedicated worker
  (`worker.ts`) that holds the WASM module, the master key during login/2FA and the unlocked user key.
  Lock terminates the worker and closes the document, which also frees the 64+ MiB Argon2id grew the
  WASM memory to. The SW never holds the user key, only encrypted blobs it passes through.
* **Popup** (`src/ui`): vanilla TS, no components framework. Asks the SW for data; never sees keys, never calls
  `fetch`. First paint must not wait for WASM.
* **Content script** (`src/autofill/detect`): <10 KB, `document_idle`, exits immediately when the page
  has no password field. Filling runs as an isolated-world function injected by the SW via
  `chrome.scripting`, so the persistent content script holds no fill logic and no secrets.

## Modules and boundaries

| Path | Responsibility | May import |
|---|---|---|
| `crates/core-wasm` | Rust cdylib: KDF, auth hash, unlock, batch decrypt/encrypt, TOTP, generator | `bitwarden-crypto` (pinned git rev) |
| `src/shared` | Message schemas + validators, constants, tiny utils | nothing |
| `src/transport` | Typed `fetch` client: prelogin, token (+refresh, 2FA), sync, ciphers/folders CRUD, profile, revision-date, config | `shared` |
| `src/vault` | Encrypted cache, lock state machine, incremental sync, in-memory search index | `shared`, `transport` (SW side), core-wasm (offscreen side) |
| `src/background` | SW entry, router, alarms, commands, context menu | `shared`, `transport`, `vault` |
| `src/offscreen` | WASM host + decrypted state | `shared`, core-wasm |
| `src/autofill` | Detector content script, fill function, URI matching | `shared` |
| `src/ui` | Popup | `shared` |

Rule: **UI and autofill never touch crypto or the network.** All cross-context calls go through the
message bus (`src/shared/messages.ts`); every message type has a hand-written validator and unknown or
malformed messages are dropped. Senders are checked (`sender.id === chrome.runtime.id`; content
scripts may only send a whitelisted subset of message types).

## Crypto core (`crates/core-wasm`)

* Depends on `bitwarden-crypto` from `bitwarden/sdk-internal` by **git dependency pinned to the exact
  rev in `upstream.lock`** (no vendoring/copying; see `docs/LICENSING.md`).
* Phase 0 decides whether `bitwarden-vault` / `bitwarden-generators` are usable (see
  `docs/PHASE0_REPORT.md`). Both depend on `bitwarden-core`, `bitwarden-api-api`, `reqwest` and (vault)
  `bitwarden-ssh`/`bitwarden-state`/`zxcvbn`, so the expected outcome is "crypto only": cipher field
  walking, TOTP and the generator become small local Rust modules, kept honest by upstream test
  vectors and tracked in `upstream-map.yaml`.
* JS API is batch oriented (one call decrypts the whole vault): `deriveMasterKey`, `makeAuthHash`,
  `unlockUserKey`, `decryptCipherList`, `decryptCipher`, `encryptCipher`, `totp`, `generatePassword`.
* Release profile: `opt-level="z"`, `lto`, `codegen-units=1`, `panic="abort"`, `strip`, then
  `wasm-opt -Oz`. Size budget enforced in CI (`tools/size-budget`).
* Keys live in a WASM-side keystore addressed by opaque handles; JS never receives raw key bytes after
  unlock. Secrets are zeroized on drop (`zeroize` + bitwarden-crypto's zeroizing allocator).

## Transport

* Endpoints: `/identity/accounts/prelogin` (+ `/prelogin/password`), `/identity/connect/token`
  (password, refresh_token; 2FA via `twoFactorProvider`/`twoFactorToken`), `/api/sync`,
  `/api/ciphers*`, `/api/folders*`, `/api/accounts/profile`, `/api/accounts/revision-date`, `/api/config`.
* Headers: `Bitwarden-Client-Name`, `Bitwarden-Client-Version` (semver; Vaultwarden parses it with
  `semver` on some routes), `Device-Type: 2` (ChromeExtension in Vaultwarden's `DeviceType`; read as
  the lowercase `device-type` header). Exact values tracked in `docs/COMPATIBILITY.md`.
* Responses are validated by small hand-written validators that tolerate unknown fields and accept both
  camelCase and PascalCase keys (Vaultwarden mixes them, e.g. `Kdf`/`KdfIterations` in the token response).
* Capability detection: `/api/config` → `version` (Bitwarden-compat level, `2026.6.0` on Vaultwarden
  1.37.4) and `server.name`; features are gated on that rather than hardcoded.

## Permissions

`storage`, `alarms`, `idle`, `offscreen`, plus `optional_host_permissions` `https://*/*`,
`http://*/*`: Vaultwarden's CORS only allows its own origin, so the extension needs a host permission
for the server. It is requested at setup for that one origin only (`chrome.permissions.request`).
`activeTab`, `scripting`, `clipboardWrite` arrive with the phases that use them.

## Storage and lock model

* `chrome.storage.local`: server URL, device id, encrypted vault (as returned by `/api/sync`),
  protected user key, KDF params, refresh token (plain, like the official extension; the area is
  set to `TRUSTED_CONTEXTS` so content scripts cannot read it), 2FA remember tokens, settings.
* `chrome.storage.session`: lock state, access token, pending 2FA login. The unlocked user key lives only in the
  offscreen document's WASM memory.
* Lock = close offscreen document (drops WASM memory) + clear session state. Auto-lock via
  `chrome.idle` and `chrome.alarms`. Clipboard clearing via alarm + offscreen document.

## Upstream sync

`upstream.lock` (pins) → `upstream-map.yaml` (upstream path → local module) → `tools/sync-upstream`
(Markdown diff report; never edits code) → CI job (bump Cargo rev, run test vectors + Vaultwarden
matrix, report WASM size delta). Details in `docs/UPSTREAM_SYNC.md`.

## Repository layout

```
crates/core-wasm/       Rust -> WASM
src/{shared,transport,vault,background,offscreen,autofill,ui}/
tools/                  sync-upstream, size-budget, e2e helpers
dev/vaultwarden/        docker-compose for the local test server
spike/                  Phase 0 measurement harness (folded into tools/ or removed after Phase 0)
docs/                   ARCHITECTURE, COMPATIBILITY, LICENSING, UPSTREAM_SYNC, PHASE0_REPORT
upstream.lock, upstream-map.yaml
```
