# Phase 4 report: side panel, WebAuthn 2FA, Send, passkeys, SSO

Date: 2026-10-29. Helium 156.0.8078.47 (headless) against Vaultwarden 1.37.4 (web vault 2026.7.0).
Scope chosen by the user: side panel, WebAuthn 2FA, Send, passkeys, SSO (not YubiKey OTP, not import/export).

## Decisions

* **New permission: `sidePanel`** (approved with the scope choice). No other new permissions.
  Passkeys request `https://*/*` at runtime from the existing `optional_host_permissions`, only when the
  user turns them on in Settings.
* **No new JS dependencies.** Rust: `base64` and `zeroize` as direct deps; both were already in the
  tree through `bitwarden-crypto` (no size cost beyond the code using them).
* **WebAuthn 2FA through the server's own `webauthn-connector.html`** in an iframe: the credential is
  bound to the server origin, which an extension page cannot claim. Vaultwarden serves `*connector.html`
  without frame restrictions for exactly this.
* **Send crypto in core-wasm** (`send.rs`), using `derive_shareable_key` and `pbkdf2` from
  `bitwarden-crypto`; only the field walking is local, mirroring `bitwarden-send`.
* **Passkeys are opt-in** and use registered content scripts (MAIN-world shim + isolated relay), so the
  default stays "no content script, no site access". Signing is WebCrypto ES256 in the crypto worker;
  the format is Bitwarden's `login.fido2Credentials`, so passkeys sync with the official clients.
  Every request needs a click in an approval window; closing it hands the call back to the browser.
* **SSO** uses `client_id=browser` (Vaultwarden then always redirects to `<server>/sso-connector.html`)
  with PKCE and a random state. A content script registered for that one page only during the login
  reports the URL back. SSO signs in; the vault is still unlocked with the master password.

## Done

* Side panel: `sidepanel.html` (same bundle, fluid width), "Open in side panel" in Settings.
* WebAuthn 2FA: "Security key" method on the two-step screen; cancel/error pauses instead of
  re-prompting; "Open in a new tab" because the OS security-key dialog closes the action popup; a
  failed attempt fetches a fresh challenge (Vaultwarden deletes it on every try).
* Send: new "Send" tab: list (name, deletion date, password/disabled), create text or file send
  (deletion after 1–30 days, optional password, optional max access count, hide text), link copied on
  create, copy link, delete. Sends come with sync and are cached encrypted like ciphers.
* Passkeys: create (new Login item with the passkey, username and site URI) and sign-in (pick among the
  site's passkeys; `allowCredentials` honoured, otherwise discoverable ones), `excludeCredentials` →
  `InvalidStateError`, RP ID checked against the real origin with the Public Suffix List, one pending
  request per tab.
* SSO: "Log in with SSO" on the login screen; errors from the background finish are shown the next
  time the popup opens.
* Test setup: `dev/vaultwarden/mock-idp.mjs`, a dependency-free OIDC provider running next to
  Vaultwarden in docker-compose (`SSO_ENABLED=true`, password login unchanged).

## Verified

* Rust unit (`send::tests`): text + file send roundtrip, password hash length; sdk-internal test
  vectors still pass. JS unit 6/6. Typecheck clean.
* E2E 34/34 (11 new), run twice in a row:
  * WebAuthn: key registered through `/api/two-factor/webauthn` with a CDP virtual authenticator;
    login through the connector iframe in the popup.
  * Side panel: `sidePanel.getOptions` path, fluid width, button only outside the panel.
  * Send: the recipient flow (`send_access` token → `/api/sends/access` → file download) decrypted
    with an independent `node:crypto` implementation; wrong password refused by the server, right one
    accepted (so our PBKDF2 hash matches what the server checks); delete gone after a fresh sync.
  * Passkeys: create on `http://localhost:8099` (clientData type/origin/challenge, rpIdHash, flags,
    stored as `fido2Credentials` on the server); sign-in signature verified in Node with the public key
    from creation; user handle round-trips; closing the window falls back to the browser's WebAuthn.
  * SSO: mock IdP → Vaultwarden → `sso-connector.html` → code redeemed, tab closed, account locked,
    unlocked with the master password, no SSO state or content script left behind; a callback whose
    state does not match is refused with a message.
* Release build: no `host_permissions`, test hook compiled out.

## Sizes (release)

| file | raw | brotli | Phase 3 raw |
|---|---:|---:|---:|
| background.js | 30.1 KiB | 9.2 KiB | 20.6 KiB |
| popup.js + popup.css | 33.5 + 12.3 KiB | 9.8 + 2.8 KiB | 24.9 + 12.1 KiB |
| worker.js + offscreen.js | 22.4 + 5.2 KiB | 6.6 + 1.9 KiB | 15.0 + 4.1 KiB |
| passkey-page.js + passkey-relay.js (opt-in) | 2.1 + 0.5 KiB | 0.8 + 0.3 KiB | — |
| sso-callback.js (during SSO only) | 0.1 KiB | 0.1 KiB | — |
| core_wasm_bg.wasm | 635.3 KiB | 199.7 KiB | 621.6 KiB |

Popup first render (unlocked): 20 ms. Content scripts are now in the size budget (10 KiB each).

## Not done / not verified

* **Send**: editing an existing send, disabling it, and the "hide email" / email-restricted sends are
  not offered. Files are limited to 25 MB (base64 through two message hops). The official web vault
  refuses plain-http servers, so the e2e recipient check uses the API plus an independent
  `node:crypto` implementation instead of the web vault.
* **Passkeys**: a new passkey always becomes a new Login item (attaching it to an existing item is not
  offered). Not handled, left to the browser: conditional mediation (passkey autofill UI), non-ES256
  requests, iframes, `AbortSignal`. Not tried on real websites, only on the local test page.
* **SSO**: SSO together with two-step login is refused with a message; accounts without a master
  password (SSO-only signups, key connector, trusted devices) cannot unlock; tested only against the
  mock IdP.
* **WebAuthn 2FA**: tested with a CDP virtual authenticator on http://localhost (where the U2F `appid`
  is dropped); not tried with a hardware key, Windows Hello, or an https server with legacy U2F keys.
* Side panel: page autofill and "On this site" do not work there (`activeTab` is not granted to the
  side panel); `sidePanel.open` itself is not clicked in the tests.
