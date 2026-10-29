# Phase 3 report: autofill

Date: 2026-10-29. Helium 156.0.8078.47 (headless) against Vaultwarden 1.37.4.

## Decisions (approved)

* **activeTab only**: no persistent content script, no `<all_urls>`. Fill happens on a user gesture
  (popup, Ctrl+Shift+L, context menu), each of which grants `activeTab`.
* New permissions: `activeTab`, `scripting`, `contextMenus`.
* "Domain" matching uses the Public Suffix List, pinned in `upstream.lock` (`publicsuffix/list@8437e52`),
  fetched at build time into `psl.json` (167 KiB raw) and loaded only by the crypto worker on first match.

## Done

* URI matching with Bitwarden's six match types; `null` = Domain. Equivalent domains not supported.
* Popup: "On this site — host" list with a Fill button per match; filling closes the popup.
* Ctrl+Shift+L (`commands`) and context menu on editable fields: fill the first match; if locked or
  nothing matches, open the popup.
* Fill script: top frame only; re-checks `location.origin` before writing; finds the password field and
  the nearest username field before it (same form preferred), or a username-only step; uses the native
  value setter + `input`/`change` events so framework-controlled inputs update.
* Only items whose URIs match the tab are ever filled, also when the popup asks for a specific item.
* "Save login from this page": reads the typed-in form; same username as a matching item → edit that
  item with the new password (history kept); otherwise a new Login prefilled with host, username,
  password and origin.

## Verified

* Unit (6/6): PSL cases (co.uk, github.io private section, `!www.ck` exception, `*.ck` wildcard, IPs,
  localhost) and all match types incl. `alice.github.io` ≠ `mallory.github.io`, `example.com.evil.net`.
* E2E (23/23, 4 new): popup lists matches and fills; shortcut handler fills on `localhost:8099` and
  refuses `127.0.0.1:8099` (no match); save-from-page creates a new item with the page origin; same
  username updates the password and keeps the old one in history.
* Release build: no `host_permissions`, test hook compiled out.

## Sizes (release)

| file | raw | brotli |
|---|---:|---:|
| background.js | 20.6 KiB | 6.5 KiB |
| popup.js + popup.css | 24.9 + 12.1 KiB | 7.7 + 2.7 KiB |
| worker.js + offscreen.js | 15.0 + 4.1 KiB | 4.6 + 1.6 KiB |
| psl.json (worker, lazy) | 166.9 KiB | — |
| core_wasm_bg.wasm | 621.6 KiB | 195.9 KiB |

## Not done / not verified

* The keyboard shortcut and context menu are triggered in tests through a test-only hook; real key
  presses / menu clicks are not automated. Helium leaves `Ctrl+Shift+L` **unassigned** — set it under
  `chrome://extensions/shortcuts`. Chrome normally assigns suggested keys; not checked there.
* The origin re-check inside the fill script is not exercised by a test (needs a navigation race).
* Iframes and shadow DOM are not handled (prompt: later phase). No automatic save prompt (activeTab model).
* Filling into `http://` pages for items saved with `https://` is allowed (Domain match ignores the
  scheme, like Bitwarden); there is no insecure-page warning yet.
