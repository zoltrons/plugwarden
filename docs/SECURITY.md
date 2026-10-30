# Security model and invariants

What has to stay true for Plugwarden to be safe, and where each rule is enforced. Read this before
changing the message bus, the autofill path or the transport: most of these rules are one small edit
away from being silently undone, and several are covered by unit tests.

## Trust boundaries

| Context | Trust | Holds |
| --- | --- | --- |
| Web page (any origin, http and https) | **untrusted** | nothing of ours; can read anything we inject into its DOM |
| Content script (`content.js`, `passkey-relay.js`) | semi-trusted, page-adjacent | the page URL the browser reports, a per-document nonce |
| MAIN-world shim (`passkey-page.js`) | **untrusted** — it *is* page code | nothing; it only forwards `navigator.credentials` calls |
| `menu.html` / `bar.html` frames | trusted extension page, but framed by a page | item names/usernames for the current origin only |
| Service worker | trusted | encrypted cache, tokens, policy |
| Offscreen document + crypto worker | trusted | master key handles, user key, org keys, decrypted vault |
| Popup / side panel | trusted | decrypted data while open |

The only place keys and plaintext live is the crypto worker (`src/offscreen/worker.ts` + `vault.ts`).
Locking terminates the worker, so the WASM memory that held Argon2id's 64+ MiB and the user key is
freed rather than zeroed in place.

## Invariants

1. **Origin, URL, tab and frame always come from `sender`, never from the message.**
   `handlePage`/`handleFrame` (`src/background/inline.ts`) derive the URL from `sender.url` and the tab
   and frame from `sender.tab`/`sender.frameId`. The passkey port uses `port.sender.origin`
   (`src/background/passkey.ts`). Never accept a URL/origin/id from the payload for a security decision.

2. **Every cross-context message is parsed, never cast.** `parseRequest`, `parseCoreRequest`,
   `parsePageRequest`, `parseFrameRequest`, `parsePasskeyCall` (`src/shared/messages.ts`) validate
   shape *and* size. Unknown types are refused; anything a page or a server can make arbitrarily large
   (form values, challenges, credential-id lists, imports) is capped at the boundary.

3. **Filling is triple-checked.** For a login the item must match the site's URL, the injected function
   re-checks `location.origin` inside the frame (`src/autofill/page.ts`), and the inline menu injects
   into exactly the frame that asked (`frameIds: [ctx.frameId]`). A same-tab navigation or a tab switch
   between the click and the injection therefore cannot fill another site. Popup and gesture fills try
   the top frame first and, only when it has no form, every frame of the tab: the same origin check runs
   in each one, so a cross-origin iframe returns before it reads a single field.

4. **An iframe of ours is not an authority.** `menu.html`/`bar.html` are web-accessible, so any site can
   frame them. Both carry a per-document secret (menu: from `content.js` via the URL fragment, inside a
   closed shadow root; bar: issued by `showBar`): without it the worker refuses, so a copy the page
   frames itself cannot read the list or drive a fill/save.

5. **Only the service worker may talk to the offscreen document.** `sender.url === background.js`,
   `sender.tab` absent (`src/offscreen/offscreen.ts`). Conversely the worker answers only its parent.

6. **Vault secrets are never written unencrypted to disk.** `storage.local` holds the encrypted cache, the
   protected user key, the wrapped PIN and an encrypted generator history. The refresh token and the 2FA
   remember tokens are the exception, see Known gaps. Access tokens, and a typed password waiting in the
   save bar until it expires or the vault locks, live in `storage.session` (memory only); the decrypted
   vault lives in the crypto worker. Both stores are set to `TRUSTED_CONTEXTS` on *every* worker start, so
   content scripts cannot read them.

7. **The server is not trusted with URLs.** `http://` is refused except for loopback
   (`src/shared/url.ts`), the API client sends `credentials: "omit"`, `redirect: "error"`, and an
   attachment download URL must be on the configured server (`src/transport/vault.ts`). Response bodies
   are bounded (`readBytes` in `src/transport/http.ts`).

8. **2FA state is scoped and short-lived.** Remember-device tokens are keyed by `<server>|<email>` so
   they are never replayed to another server; a pending 2FA login holds a master-key handle, so an
   abandoned attempt is freed when it expires, by an alarm that needs no open popup (`PENDING_ALARM`).

8b. **Every unlock path ends in the same place.** Master password, PIN and biometrics all go through
    `afterUnlock` (`src/background/account.ts`), which sets `unlocked` and arms the auto-lock, so no path
    can unlock without the lock timer. PIN and biometric material is stored only as a *wrapped* user key
    (`storage.local`, removed on logout); the PIN is additionally limited to 5 attempts per session.
    Biometric unlock uses WebAuthn's PRF extension with `userVerification: "required"`, an RP ID of the
    extension origin and a random salt, and refuses authenticators without PRF instead of degrading to
    "biometrics as a UI gate".

9. **Origin keys are best effort, never fatal.** One undecryptable organization key must not make the
   personal vault unreadable (`crates/core-wasm/src/api.rs` `set_org_keys`, plus the `try/catch` in
   `loadVault`); affected items surface as undecryptable instead.

10. **Decryption failures are isolated per item.** `decrypt_list`/`decrypt_folders`/`decrypt_send_list`
    report per-item failures instead of failing the batch, and a failed item is never matched or filled.

11. **Passkeys are bound to the origin.** `checkRpId` requires the RP ID to be the origin's host or a
    registrable parent, on a secure origin, and never a public suffix — including when the page's own
    host *is* the public suffix. Signing happens in the worker. The private key leaves it only as part of
    the full item, when the item is opened for viewing or editing (see Known gaps).

12. **Rendered data is text, not markup.** No `innerHTML` anywhere; the `h()` helper sets properties
    from static keys and `textContent` for values, so vault, server and page strings cannot become
    markup. External links are restricted to http(s) (`webUrl`).

13. **Clipboard copies are cleared on a timer**, and the clear is armed only when the write actually
    happened — never after a failed copy that would otherwise erase the user's clipboard.

14. **Locking tears down in-page UI.** Auto-lock, logout and login call `lockNow`, which closes the
    inline menu and save bar in every tab: those frames show decrypted item names, so they must not
    survive the lock. The popup/side panel follow the session in `chrome.storage.session` and drop their
    decrypted state on the same event.

## Known gaps

- **The refresh token and 2FA remember tokens are on disk in clear text** (`storage.local`), because they must
  survive a browser restart without the master password. Anyone who can copy the browser profile can use them to
  fetch the still-encrypted vault and to change or delete items on the server, but not to read anything.
- **Plain text passes through the service worker and the popup in a few places.** The fill data, a TOTP code, the
  full item for the popup and for a save-bar update go through the service worker in transit; it does not keep
  them. The popup holds an opened item, including a passkey's private key, because editing sends the whole item
  back. Checks that need no secret use `cipherSummary`.
- **Updates are only as trustworthy as the release pipeline.** Installed copies follow
  `releases/latest/download/updates.xml` (`docs/UPDATES.md`). The browser verifies each `.crx` against the
  extension's key, so a build signed with another key is refused, but anyone who can push a `v*` tag and read
  `CRX_KEY` can ship code to every installed copy. Keep that secret and the repository's write access tight.

- **The inline menu's "Sign in with passkey" signs in without a window.** Picking the entry is the
  decision: with exactly one matching passkey `openConditional` (`src/background/passkey.ts`) asserts
  right away. Several passkeys (a choice to make) or a `reprompt`-flagged item open the approval
  window instead, so the flag is never bypassed by this path. The request is still tied to the
  frame's per-document nonce and the browser-reported origin (invariants 1 and 4).

- **One request leaves for a third party, on an explicit click only.** "Check for data breaches" on a
  login sends the first 5 hex digits of the password's SHA-1 to `api.pwnedpasswords.com` (k-anonymity,
  padded responses, no cookies, no referrer; `src/ui/pwned.ts`). It needs no new permission (the broad
  host permission already covers it) and nothing runs automatically. Maps links go to OpenStreetMap
  only when the user opens them.
- **Forwarded email aliases call a third-party service, on an explicit click only.** The generator sends
  the service's API token plus the current page's origin and path (no query or fragment) to the selected forwarding service
  (`src/background/alias.ts`); nothing runs automatically and no vault data is included. Tokens are kept
  per service in `storage.session` (never on disk), so switching the selected service cannot send one
  service's token to another, and they are dropped on logout. A self-hosted base URL must be https, or
  plain http on loopback; unlike the official client there is no "trust this unsafe URL" override, so a
  LAN forwarding service over http is refused.
- **The list carries two derived flags, not secrets.** `reused` (how many items share a password) and
  `weak` are computed in the worker (`listVault`) and shipped on list entries so the popup can filter
  by them without ever receiving a password. They are not part of what the inline menu / save bar get.
- **Values the user reveals can be re-shown.** Large Type, QR code and "Share as a Send" take the
  value the item view already holds; they sit behind the same re-prompt gate as viewing the item.

- **Master password re-prompt (`reprompt`) is enforced, with one exception.** Items flagged in the web
  vault are gated in the service worker for the item view (and therefore editing), copy, TOTP, filling
  (popup, inline menu and "fill the first match") and attachment downloads — see
  `src/background/reprompt.ts`. Page-load autofill skips flagged items entirely. **Not** covered: a
  passkey assertion from a flagged item still goes through the approval window (the user has already
  unlocked the vault and picked the item there), and an org policy that forces the flag is only honored
  as far as Vaultwarden reports it on each cipher.
- **The extension holds broad host permissions** (`https://*/*`, `http://*/*`) because autofill needs to
  inject into arbitrary sites. It is the largest standing privilege we have; do not add more without a
  written reason.
- **Attachment downloads never follow a redirect** and must stay on the configured server's origin
  (`src/transport/vault.ts`). The SSRF surface is the configured server only; the price is that an
  attachment store that redirects (e.g. S3) cannot be downloaded from.
- **Cards and identities are listed on every site** (parity with the official clients) and fill on an
  explicit click.
- **RUSTSEC-2023-0071 (Marvin timing attack on `rsa`) is ignored in `deny.toml`.** The crate arrives through
  `bitwarden-crypto`, has no patched release, and its RSA operations run only locally in the offscreen worker,
  where no remote party can observe their timing. Remove the ignore once `rsa` ships a fix.
