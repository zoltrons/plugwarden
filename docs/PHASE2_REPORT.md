# Phase 2 report: vault

Date: 2026-10-29. Helium 156.0.8078.47 (headless) against Vaultwarden 1.37.4.

## Scope (agreed cuts)

Create/edit only for personal Login and Secure note; every type is viewable. Folders: filter + assign,
no folder management. Organization items read-only; new items use the user key (no per-item cipher key).
No favicons, attachment download or generator history.

## Done

* Sync: `/api/sync` cached encrypted in `storage.local`; a full sync only when `/api/accounts/revision-date`
  moved (Vaultwarden has no delta sync). Decryption in the offscreen worker (one WASM call for the vault).
* List with letter tiles, search (name, username, URIs), folder chips, favorites marker.
* Item view: username/password (reveal), TOTP with live countdown, URIs, custom fields (hidden ones
  masked), notes, card/identity/SSH/bank/licence/passport fields generically (secrets masked), attachment count.
* Copy to clipboard; cleared 30 s later by an alarm through the offscreen document (`CLIPBOARD` reason,
  `clipboardWrite` permission from the original list).
* Create / edit Login and Note (folder, favorite, generated password); a changed password goes to
  `passwordHistory` (max 5); edits send `lastKnownRevisionDate`, so the server refuses stale overwrites.
* Move to trash (soft delete, restorable in the web vault).
* Generator: password (length, sets, avoid ambiguous) and passphrase (words, separator, capitalize, number).

## Verified (`npm run test:e2e`: 19/19 steps, 9 of them new)

List/search/folder filter · reveal + TOTP equals an independent computation · hidden custom field stays
masked · copy puts the value on the clipboard and the alarm really clears it · card is read-only and its
number masked · item created in the popup decrypts in a separate client session with the same username,
20-char password and URIs · edit keeps password history, custom fields and TOTP · a stale edit is refused
("out of date") · an item created elsewhere appears after sync · trash sets `deletedDate` on the server ·
generator password length and passphrase · lock removes decrypted items from the popup.

## Sizes (release)

| file | raw | brotli |
|---|---:|---:|
| core_wasm_bg.wasm | 621.6 KiB | 195.9 KiB |
| popup.js + popup.css | 23.7 + 11.9 KiB | 7.3 + 2.7 KiB |
| background.js | 17.5 KiB | 5.5 KiB |
| worker.js + offscreen.js | 13.3 + 3.9 KiB | 4.0 + 1.5 KiB |

No Rust changes were needed: the Phase 0 WASM API already covered list decrypt, encrypt, TOTP and generation.

## Not done / not verified

* Organization items: decrypt path exists (org keys from `profile.organizations`) but no e2e with a real org.
* "Independent" check uses the test's own WASM instance, not the official `bw` CLI (still to do).
* The whole vault sits in one `storage.local` key (10 MB quota) — marked `shortcut:` in `src/background/vault.ts`.
* The clipboard is cleared unconditionally after 30 s, even if the user copied something else meanwhile
  (no `clipboardRead` permission to check).
* Popup shows the decrypted list while open; it is dropped on lock and when the popup closes.
