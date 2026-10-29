# Plugwarden architecture

Plugwarden is a Manifest V3 Chrome extension (Chromium 156+) that talks to a self-hosted
**Vaultwarden** server using the Bitwarden client protocol. Priorities, in order:

1. Protocol compatibility with Vaultwarden (pinned in `upstream.lock`; the server is the source of truth).
2. Security (minimal permissions, plaintext only in memory, auto-lock).
3. Size and speed (no UI framework, esbuild, small pruned WASM, a content script that stays idle until a field is focused).
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
* **Offscreen document** (`src/offscreen`, reasons `WORKERS` + `CLIPBOARD`): spawns one dedicated worker
  (`worker.ts`) that holds the WASM module, the master key during login/2FA and the unlocked user key.
  Lock terminates the worker and closes the document, which also frees the 64+ MiB Argon2id grew the
  WASM memory to. The SW never holds the user key, only encrypted blobs it passes through.
* **Popup** (`src/ui`): vanilla TS, no components framework. Asks the SW for data; never sees keys, never calls
  `fetch`. First paint must not wait for WASM.
* **Autofill** (`src/autofill`): a static content script (`content.js`, all http(s) pages and frames,
  `document_idle`) that only checks for a password field on load (one `querySelector`) and otherwise
  reacts when the user focuses an input. "Autofill on page load" (off by default) asks the worker to
  fill the frame's best login: the per-item tri-state decides who takes part, the login last used for
  the site wins, and only empty fields are written. For
  login, card and identity fields it frames the inline menu (`menu.html`) under the field; after a login
  form is submitted it asks the SW whether to show the save/update bar (`bar.html`, top frame only).
  Both are extension pages (web-accessible resources), so the site cannot read their contents; they ask
  the SW for data and the SW fills. Fills (inline menu, popup "Fill", Ctrl+Shift+L, context menu) inject a
  self-contained function from `page.ts` with `chrome.scripting` into the frame whose URL matched, and
  the function re-checks the origin before filling. Matching always uses the URL the browser reports
  (`sender.url` / `tab.url`), never one the page supplies.

## Modules and boundaries

| Path | Responsibility | May import |
|---|---|---|
| `crates/core-wasm` | Rust cdylib: KDF, auth hash, unlock, batch decrypt/encrypt, TOTP, generator | `bitwarden-crypto` (pinned git rev) |
| `src/shared` | Message schemas + validators, constants, tiny utils | nothing |
| `src/transport` | Typed `fetch` client: prelogin, token (+refresh, 2FA), sync, ciphers/folders CRUD, profile, revision-date, config | `shared` |
| `src/vault` | Encrypted cache, lock state machine, incremental sync, in-memory search index | `shared`, `transport` (SW side), core-wasm (offscreen side) |
| `src/background` | SW entry, router, alarms, commands, context menu | `shared`, `transport`, `vault` |
| `src/offscreen` | WASM host + decrypted state | `shared`, core-wasm |
| `src/autofill` | Injected fill/read functions, URI matching (+ Public Suffix List) | nothing (page.ts must stay self-contained) |
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
  `unlockUserKey`, `decryptCipherList`, `decryptCipher`, `encryptCipher`, `totp`, `generatePassword`,
  and the PIN / biometric wrappers (`pinProtectUserKey`, `unlockWithPin`, `prfProtectUserKey`,
  `unlockWithPrf`).
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

`storage`, `alarms`, `idle`, `offscreen`, `clipboardWrite` (clearing copied secrets), `scripting`,
`contextMenus`, `sidePanel` (the popup UI also opens in the side panel: `sidepanel.html`, same bundle).

Host permissions `https://*/*` and `http://*/*` are **required at install**, like the official
extension: Vaultwarden's CORS only allows its own origin, so the server needs one; the content script,
the inline menu and the save bar need every site; fills and the side panel's "On this site" use
`chrome.scripting` and `tabs.query` URLs on any tab, so `activeTab` is not needed.

`privacy` is **optional**: requested inside the click on "Make Plugwarden the default password
manager" (it turns off the browser's own password saving and autofill through `chrome.privacy`) and
removed when that setting is turned off.

Static content script `content.js` (see Autofill above) plus the web-accessible `menu.html` and
`bar.html`. Its per-tab state lives in `chrome.storage.session`, one key per tab, removed when the tab
closes: `inline:<tabId>` (frame, URL and kind of the field the open menu belongs to) and `save:<tabId>`
(a submitted login waiting in the save bar, 5 minute TTL).

Other content scripts are registered at runtime (`chrome.scripting.registerContentScripts`):

* **Passkeys** (always on, no setting): registers a MAIN-world shim (`passkey-page.js`, wraps
  `navigator.credentials.create/get`) and an isolated relay (`passkey-relay.js`) on every secure
  origin (`https`, `localhost`), top frames only. A `get`/`create` a stored passkey can answer opens an
  approval window (`popup.html?passkey=<id>`); anything else (no matching passkey, not logged in) is
  handed straight back to the browser without a window. Conditional mediation (passkey autofill) is
  raced against the browser's native UI, and while such a request waits the inline menu offers
  "Sign in with passkey" (the request is continued, not restarted). The origin comes from
  `port.sender.origin`, the RP ID is checked against it (with the PSL) in the worker, and keys are
  signed there (WebCrypto ES256). Closing the window or "use another device" hands the call back to
  the browser; an `AbortSignal` from the page drops the pending request.
* **SSO**: `sso-callback.js` is registered for `<server>/sso-connector.html*` only while a login is in
  progress and reports `sender.url` (code + state) back; the SW checks the state and the PKCE verifier.

## Storage and lock model

* `chrome.storage.local`: server URL, device id, encrypted vault (as returned by `/api/sync`),
  protected user key, KDF params, refresh token (plain, like the official extension; the area is
  set to `TRUSTED_CONTEXTS` so content scripts cannot read it), 2FA remember tokens, settings,
  generator history and (with PIN unlock on) the PIN, both encrypted with the user key.
* `chrome.storage.session`: lock state, access token, pending 2FA login, and with PIN unlock on the
  user key wrapped with the PIN key (bitwarden-crypto `PinKey`, account KDF). The unlocked user key
  lives only in the offscreen document's WASM memory. A browser restart empties this area, so the
  master password is needed once; that unlock re-wraps the key with the stored PIN. Five wrong PINs
  log out.
* Settings live in `chrome.storage.local` too: lock/timeout, inline menu (all/cards/identities),
  save prompt + never-save hosts, default password manager, favicons, TOTP copy, context-menu entry,
  default URI match strategy, clear-clipboard delay (10 s … 5 min, or never), autofill on page load
  + its default, and cards/identities in the tab view. `lastUsed` (cipher id → ms) is the only other
  local state: it decides which login page-load autofill prefers.
* `chrome.storage.local` also holds biometric unlock: the user key wrapped with a key derived from
  the platform authenticator's WebAuthn PRF output (bitwarden-crypto
  `derive_symmetric_key_from_prf`), plus the credential id and salt. No permission and no native
  helper: the credential is bound to the extension origin (`authenticatorAttachment: platform`,
  `userVerification: required`), the PRF secret never leaves the authenticator, and a wrong or
  missing PRF fails the MAC in the WASM core. Unlike the official extension (which asks the desktop
  app over native messaging), this needs no companion app; devices whose authenticator lacks PRF are
  refused instead of falling back to a weaker UI-only gate. The wrapped key is removed on logout.
* Lock = close offscreen document (drops WASM memory) + clear session state. Auto-lock via
  `chrome.idle` and `chrome.alarms`; the timeout action can instead log out (forget the account and
  the cache), also on browser start. Clipboard clearing via alarm + offscreen document.

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
