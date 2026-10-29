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

3. **Filling is triple-checked.** For a login the item must match the frame's own URL, the injected
   function re-checks `location.origin` inside the frame (`src/autofill/page.ts`), and the script is
   injected into exactly the frame that asked (`frameIds: [ctx.frameId]`). A same-tab navigation or a
   tab switch between the click and the injection therefore cannot fill another site.

4. **An iframe of ours is not an authority.** `menu.html`/`bar.html` are web-accessible, so any site can
   frame them. Both carry a per-document secret (menu: from `content.js` via the URL fragment, inside a
   closed shadow root; bar: issued by `showBar`): without it the worker refuses, so a copy the page
   frames itself cannot read the list or drive a fill/save.

5. **Only the service worker may talk to the offscreen document.** `sender.url === background.js`,
   `sender.tab` absent (`src/offscreen/offscreen.ts`). Conversely the worker answers only its parent.

6. **Secrets are never written unencrypted to disk.** `storage.local` holds the encrypted cache, the
   protected user key, the wrapped PIN and an encrypted generator history. Access tokens and the whole
   decrypted vault live in `storage.session` (memory only). Both stores are set to
   `TRUSTED_CONTEXTS` on *every* worker start, so content scripts cannot read them.

7. **The server is not trusted with URLs.** `http://` is refused except for loopback
   (`src/shared/url.ts`), the API client sends `credentials: "omit"`, `redirect: "error"`, and an
   attachment download URL must be on the configured server (`src/transport/vault.ts`). Response bodies
   are bounded (`readBytes` in `src/transport/http.ts`).

8. **2FA state is scoped and short-lived.** Remember-device tokens are keyed by `<server>|<email>` so
   they are never replayed to another server; a pending 2FA login holds a master-key handle, so an
   abandoned attempt is freed as soon as it expires (`getState` → `cancelTwoFactor`).

9. **Origin keys are best effort, never fatal.** One undecryptable organization key must not make the
   personal vault unreadable (`crates/core-wasm/src/api.rs` `set_org_keys`, plus the `try/catch` in
   `loadVault`); affected items surface as undecryptable instead.

10. **Decryption failures are isolated per item.** `decrypt_list`/`decrypt_folders`/`decrypt_send_list`
    report per-item failures instead of failing the batch, and a failed item is never matched or filled.

11. **Passkeys are bound to the origin.** `checkRpId` requires the RP ID to be the origin's host or a
    registrable parent, on a secure origin, and never a public suffix — including when the page's own
    host *is* the public suffix. The private key stays in the worker; only signatures leave.

12. **Rendered data is text, not markup.** No `innerHTML` anywhere; the `h()` helper sets properties
    from static keys and `textContent` for values, so vault, server and page strings cannot become
    markup. External links are restricted to http(s) (`webUrl`).

13. **Clipboard copies are cleared on a timer**, and the clear is armed only when the write actually
    happened — never after a failed copy that would otherwise erase the user's clipboard.

## Known gaps

- **Master password re-prompt (`reprompt`) is not implemented.** Items marked for re-prompt in the web
  vault are revealed and filled without asking again. Treat it as unsupported (see
  `docs/PARITY_REPORT.md`); this is the largest remaining gap versus the official clients.
- **The extension holds broad host permissions** (`https://*/*`, `http://*/*`) because autofill needs to
  inject into arbitrary sites. It is the largest standing privilege we have; do not add more without a
  written reason.
- **A redirect answered by your own server** during an attachment download is followed (S3-backed
  attachments need it), so the SSRF surface is limited to the server you configured.
- **Cards and identities are listed on every site** (parity with the official clients) and fill on an
  explicit click.
