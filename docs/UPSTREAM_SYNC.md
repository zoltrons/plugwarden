# Upstream sync

Status: pins and map exist (Phase 0); the report tool and CI job are Phase 1 work.

## Pieces

1. **`upstream.lock`** — exact sdk-internal rev, clients commit, Vaultwarden version + image digest,
   wasm-bindgen version. `crates/core-wasm/Cargo.toml` uses the same rev; CI fails if they differ.
2. **`upstream-map.yaml`** — upstream path → local module, with what to watch.
3. **`tools/sync-upstream`** (Phase 1) — for every mapped path, `gh api repos/<repo>/compare/<pin>...main`
   filtered to that path; outputs Markdown grouped by local module. Flags: new/removed serde fields,
   changed enums (cipher types, KDF types, EncString types), new key formats (COSE, type 7+), KDF
   default changes, new required request fields (Vaultwarden `CipherData`, `ConnectData`). Read-only.
4. **CI bump job** (Phase 1) — weekly: bump the Cargo git rev to sdk-internal main, then run
   `tools/fetch-test-vectors.sh` + `cargo test`, the Vaultwarden contract tests on `:<pinned>` and
   `:latest`, and `tools/size-report.mjs` with the WASM size delta in the PR body.
5. **Renovate** (Phase 1) — JS devDependencies, the Vaultwarden image tag, and the sdk-internal rev
   (regex manager over `upstream.lock` + `Cargo.toml`).

## Contract tests

* (a) `crates/core-wasm/tests/vectors.rs` against sdk-internal `test-vectors/` — implemented.
* (b) Vaultwarden end-to-end (`spike/vw-flow.mjs` today; becomes `tools/e2e/` in Phase 1) plus the
  official `bw` CLI decrypting what we wrote and vice versa — to do.
