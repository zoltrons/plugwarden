# Plugwarden — project map

MV3 Chrome (156+) extension: a Bitwarden-protocol client for a self-hosted **Vaultwarden**. Vanilla TS +
esbuild, crypto in a pruned Rust→WASM core. Priorities: Vaultwarden compatibility > security > size/speed.
Deeper docs: `docs/ARCHITECTURE.md` (process model), `docs/SECURITY.md` (numbered invariants, known gaps),
`docs/COMPATIBILITY.md` (server quirks), `docs/UPSTREAM_SYNC.md`. Chat with the owner in Turkish; code,
comments and commits in English.

## Commands

| Task | Command |
|---|---|
| Fast loop (types + unit tests, no Rust, no server) | `npm run check` |
| Build wasm (needs rustup, wasm-bindgen-cli = `upstream.lock`, binaryen) | `npm run build:wasm` |
| Build extension → `dist/ext` | `node tools/fetch-psl.mjs` (once) then `npm run build` |
| Rust tests | `bash tools/fetch-test-vectors.sh && PW_TEST_VECTORS=target/test-vectors cargo test -p plugwarden-core-wasm` |
| Biometric / passkey smoke (no server) | `npm run test:biometric` / `npm run test:passkeys` |
| e2e vs. real Vaultwarden | `docker compose -f dev/vaultwarden/docker-compose.yml up -d --wait`, `node tools/build.mjs --e2e`, `npm run test:e2e` |
| UI preview with stubbed worker (no server) | `node dev/preview/build.mjs` → `dev/preview/shot.mjs` |

Browser is **Helium**, never Chrome (see the user's global rules). Unit tests are `src/**/*.test.ts`
(`node --test`); most changes only need `npm run check`.

## Layout (who calls whom)

```
ui (popup/sidepanel/menu/bar)  --Request-->  background/index.ts  --coreCall-->  offscreen/offscreen.ts
content.ts (web page)          --PageRequest-->  (router)                         └─ worker.ts → crates/core-wasm
menu.html/bar.html frames      --FrameRequest-->  background/inline.ts
```

- `src/shared/messages.ts` — **single source of truth for every message**: `Request` (UI→worker),
  `PageRequest`/`FrameRequest` (web page side), `CoreRequest` (worker→wasm), each with a hand-written
  validator, plus `State`, `VaultItem`, `ErrorCode`. Size caps live here.
- `src/background/` — stateless service worker. `index.ts` router (`handle`, `getState`, sender checks),
  `account.ts` login/2FA/SSO/unlock (PIN, biometric all end in `afterUnlock`), `vault.ts` sync/save/
  import/export/attachments/clipboard, `autofill.ts` fill + context menu, `inline.ts` inline menu + save
  bar, `passkey.ts` WebAuthn windows, `lock.ts` auto-lock, `reprompt.ts` master-password re-prompt gate,
  `store.ts` typed `chrome.storage` (local/session/tab state), `core.ts` offscreen bridge.
- `src/offscreen/` — holds keys + decrypted vault. `vault.ts` (cipher index, passkeys), `fido2.ts`,
  `worker.ts` (op switch), `offscreen.ts` (clipboard, worker lifecycle).
- `src/transport/` — thin fetch client (`http.ts` bounded bodies, `auth.ts`, `vault.ts`); no keys here.
- `src/autofill/` — content scripts (`content.ts` idle until a field is focused, `page.ts` injected
  fill, `passkey-*.ts`), `match.ts` URI matching.
- `src/ui/` — `popup.ts` shell/auth screens/settings, `vault.ts` list/item/edit (largest file), `send.ts`,
  `biometric.ts`, `dom.ts` (`h`, `send`, `t`), strings in `src/_locales/en/messages.json` (English only).
- `crates/core-wasm/` — `api.rs` (session, keys), `cipher.rs`, `send.rs`, `totp.rs`, `generator.rs`;
  `lib.rs` is the `wasm_bindgen` surface. Depends on `bitwarden-crypto` at the rev in `upstream.lock`.

## Recipes

- **New UI→worker request:** add to `Request` + `requestValidators` (messages.ts) → `case` in
  `handle()` (index.ts; vault-touching ones go in the unlocked branch) → call from `ui/*` via `send()`.
- **New crypto/vault op:** `CoreRequest` + `coreValidators` → `case` in `offscreen/worker.ts` → fn in
  `api.rs`/module + export in `lib.rs`.
- **Anything that returns item secrets** must go through `repromptPending` (reprompt.ts) — see SECURITY.md.
- **New string:** `src/_locales/en/messages.json`, use `t("key")`.
- **Permissions/manifest:** `src/manifest.json`; extra host/permission needs a written reason in SECURITY.md.

## Rules that bite

- Service worker is killed at any time: no state in globals except caches you can rebuild; keep
  `storage.session` for lock state.
- Decrypted data and keys live only in the offscreen worker; the SW and `storage.*` see ciphertext.
- Every message crossing a trust boundary is validated (`messages.ts`); page-controlled data is size-capped.
- Server-supplied URLs must stay on the configured server; http is allowed for loopback only.
- Lock must go through `lockNow()` (closes in-page UI, revokes re-prompt grants, frees keys).
- Size budget enforced by `npm run size` (`tools/size-budget.json`); no new dependencies without cause.
- Vaultwarden mixes PascalCase/camelCase JSON: read with the case-insensitive helpers (`ci`).
