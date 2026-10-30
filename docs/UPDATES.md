# Updates from GitHub releases

Every `v*` tag builds a signed `.crx`, a `.zip` and an **`updates.xml`** (`.github/workflows/release.yml`).
The manifest's `update_url` points at `https://github.com/zoltrons/plugwarden/releases/latest/download/updates.xml`,
which always resolves to the newest release's update manifest:

```xml
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="<extension id>">
    <updatecheck codebase=".../releases/download/vX.Y.Z/plugwarden-vX.Y.Z.crx" version="X.Y.Z" />
  </app>
</gupdate>
```

The browser polls it on its own schedule (a few hours), downloads the `.crx` when `version` is newer than the
installed one, checks the signature against the extension's key and installs it. Nothing in the extension code
makes the request.

- **The extension id is fixed by the `CRX_KEY` secret.** The workflow derives the id from it (SHA-256 of the
  public key, first 128 bits, written with `a`-`p`), so a new key means a new extension that cannot update the
  old one. Never regenerate it.
- **Only builds that contain `update_url` can update themselves.** An older install has to be replaced by hand
  once.
- **The browser decides whether an off-store extension may update.** Chromium honours `update_url` for extensions
  installed by enterprise policy, which also works for personal machines. On macOS, for example, a managed
  preference for the browser's bundle id with `ExtensionInstallForcelist` set to
  `<extension id>;https://github.com/zoltrons/plugwarden/releases/latest/download/updates.xml` installs and keeps
  the extension current. A hand-installed `.crx` is refused by stock Chrome, and Chromium forks differ in what
  they allow, so check yours before relying on it.
