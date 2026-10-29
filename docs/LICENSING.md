# Licensing

**Status: proposed, awaiting maintainer confirmation.**

## Decision (proposed)

Plugwarden is licensed **GPL-3.0-only**.

| Upstream | License | How we use it |
|---|---|---|
| bitwarden/sdk-internal (`bitwarden-crypto`) | GPL-3.0-only OR Bitwarden SDK License | Cargo **git dependency pinned to a rev**; we take it under the **GPL-3.0-only** option. Not vendored. |
| bitwarden/sdk-internal `test-vectors/` | same | Downloaded at test time by `tools/fetch-test-vectors.sh` into `target/` (gitignored). Not committed. |
| bitwarden/clients | GPL-3.0-only | Read as reference only. No source copied. |
| publicsuffix/list | MPL-2.0 | Data file fetched at build time (`tools/fetch-psl.mjs`, pinned in `upstream.lock`) and shipped as `psl.json`. MPL-2.0 is GPL-compatible; ship its notice with releases. |
| dani-garcia/vaultwarden | AGPL-3.0-only | Protocol reference and a test server in Docker. No code linked or copied. |

Why GPL-3.0-only and not the Bitwarden SDK License: the SDK License only allows use in a
"Compatible Application" for Bitwarden's own services; Plugwarden targets self-hosted Vaultwarden,
so relying on it would be at best ambiguous. The GPL option has no such restriction, and
GPL-3.0-only is compatible with bitwarden/clients.

Consequence: the distributed extension (including the WASM built from `bitwarden-crypto`) must ship
with GPL-3.0 terms and corresponding source (this repository at the released tag + `upstream.lock`).

## Rules

* Do not copy upstream source into this repo without asking first; prefer pinned dependencies.
* Local modules that re-implement upstream behaviour (`cipher.rs`, `totp.rs`, `generator.rs`) are
  written from scratch against the behaviour and test vectors; `upstream-map.yaml` records what they track.
* Never enable sdk-internal's `bitwarden-license` feature or any `bitwarden_license/` crate.
