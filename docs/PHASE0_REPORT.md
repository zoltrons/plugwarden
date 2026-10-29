# Phase 0 report (spike, decision gate)

Date: 2026-10-29. Pins: see `upstream.lock` (sdk-internal `d7ab996`, clients `d4141a4`,
Vaultwarden 1.37.4). Machine: Windows 11, Rust 1.98.1, Node 24.13, Playwright Chromium 156.0.8078.4
(headless). All numbers below were measured in this session; nothing is estimated unless marked.

## 1. Local Vaultwarden

`dev/vaultwarden/docker-compose.yml` (pinned 1.37.4, `VW_TAG=latest` for the matrix leg), running in
Docker inside WSL2, bound to `127.0.0.1:8080`. Test users are created per run through the API
(`dev/vaultwarden/test-users.json`, random email suffix).

## 2. Raw fetch flow — works

`node spike/vw-flow.mjs` against 1.37.4, for a PBKDF2-600k user and an Argon2id 3/64 MiB/4 user:

register → prelogin → token (password grant) → unlock (user key + RSA private key) → create cipher →
sync → batch decrypt → edit → get → refresh token → revision-date → delete → sync. **All OK.**

Findings that matter for Phase 1/2 (details in `docs/COMPATIBILITY.md`):
* Token response is PascalCase, sync is camelCase, same data appears in both → case-insensitive validators.
* Cipher create/update **requires `encryptedFor`** (user id from JWT `sub`), else 422.
* `/api/config` reports `version: 2026.6.0` → usable for capability detection.

## 3. Pruned core-wasm

`crates/core-wasm` depends only on `bitwarden-crypto` (git dep, pinned rev). Cipher field walking,
TOTP and the generator are small local modules (cipher.rs ~170 lines, totp.rs ~150, generator.rs ~120).
`bitwarden-crypto` needs its `wasm` feature on wasm32 (it does not compile without js-sys).

Correctness (native, `cargo test`): against sdk-internal `test-vectors/users` all master-password
accounts pass: auth hash, user-key unlock (incl. V2/COSE user key and type-7 private key), decrypt of
8 ciphers (with and without cipher keys, attachments) matching upstream plaintext, and
encrypt→decrypt round trip. Skipped: TDE / key-connector unlock (out of scope) and 4 V2
**blob-encrypted** ciphers (new upstream format, not implemented). TOTP: RFC 6238 SHA1/256/512 vectors pass.

### Sizes (wasm-opt -Oz, gzip -9, brotli q11)

| Build | raw | gzip | brotli |
|---|---:|---:|---:|
| **core-wasm** (crypto only) | **640.7 KiB** | 249.6 KiB | **199.2 KiB** |
| core-wasm + SIMD128 | 621.6 KiB | 243.2 KiB | 196.0 KiB |
| core-wasm + `register` feature (test harness) | 752.1 KiB | 309.6 KiB | 245.0 KiB |
| JS glue (`core_wasm.js`) | 19.4 KiB | 3.4 KiB | 3.1 KiB |
| Official `@bitwarden/sdk-internal` 0.2.0-main.1178 | 7 991.7 KiB | 3 110.6 KiB | 2 263.0 KiB |
| Fallback reference: Argon2id-only WASM | 32.0 KiB | 13.4 KiB | 11.2 KiB |
| bitwarden-vault + generators + core ("full", minimal use: `Cipher` serde + password generator) | 4 486.8 KiB | 1 824.5 KiB | 1 393.3 KiB |

→ **12.5× smaller** than the official build raw (11.4× brotli). Not yet analysed which crates make
up the 640 KiB (RSA bigint, ml-dsa, ed25519, coset/ciborium, serde_json are the suspects; to be
measured with twiggy before setting a tighter budget).

### Timing in a real MV3 offscreen document (Chromium 156, median of 3–5)

| Step | plain | SIMD |
|---|---:|---:|
| `createDocument` (offscreen) | 47 ms | — |
| import JS glue | 20 ms | — |
| cold `init()` (fetch + streaming compile + instantiate) | 10.8–11.7 ms | 12.6 ms |
| `WebAssembly.compile` ours / official (lazy tier-up) | 0.8 ms / 8.2 ms | — |
| PBKDF2-SHA256 600k (master key) | 367–371 ms | **258 ms** |
| WebCrypto PBKDF2 600k (reference) | 98–108 ms | — |
| Argon2id 3 it / 64 MiB / p4 (client default) | 154–168 ms | 149 ms |
| Argon2id 6 it / 32 MiB / p4 | 143–166 ms | 160 ms |
| unlock user key + RSA private key (after KDF) | 4.4 ms | — |
| batch decrypt 1000 login ciphers (one call, JSON in/out) | 43.7 ms | — |
| encrypt 1000 ciphers (1000 calls) | 86.7 ms | — |

Memory: WASM linear memory is 1.3 MiB after init and **65.4 MiB after Argon2id 64 MiB, and it never
shrinks**. So the offscreen document should be closed/recreated after unlock-with-Argon2 (or KDF run
in a short-lived worker), otherwise ~64 MiB stays resident while unlocked.

## 4. Comparison with the official build

8.2 MB → 0.64 MB raw, 2.26 MB → 0.20 MB brotli. Instantiation is ~11 ms cold, so loading the WASM
lazily in the offscreen document on unlock is cheap; popup first paint never waits on it.

## 5. Pruning verdict

* **bitwarden-vault / bitwarden-generators cannot be pruned**: both depend on `bitwarden-core`
  (`internal`), `bitwarden-api-api`, `reqwest`; vault additionally on `bitwarden-ssh`,
  `bitwarden-state`, `bitwarden-sync`, `zxcvbn`, `chrono`. That is the dependency bleed. Measured:
  a crate that only deserializes `bitwarden_vault::Cipher` and calls the password generator (via a
  `bitwarden_core::Client`) is 4.49 MiB raw / 1.39 MiB brotli, 7× our crypto-only build.
* **bitwarden-crypto alone prunes well** (it still carries `bitwarden-api-key-connector`, rsa, ml-dsa,
  ed25519, coset, rayon, tokio(io-util) but LTO removes most of it).

## Recommendation (needs your decision)

**Option A — `bitwarden-crypto` only (recommended).** What is built and measured above.
200 KiB brotli, full protocol coverage of current and future key formats (COSE, XChaCha20-Poly1305,
signing keys, V2 accounts) for free on each rev bump; parity proven by upstream test vectors.
Costs: we own ~450 lines (cipher walk, TOTP, generator) tracked in `upstream-map.yaml`.

**Option B — WebCrypto + Argon2-only WASM (32 KiB).** 20× smaller and PBKDF2 3.5× faster, but we
would re-implement EncString parsing, AES-CBC-HMAC, RSA-OAEP, and later COSE/XChaCha20 (no WebCrypto
support) ourselves — exactly the code most likely to break on upstream changes. Not recommended
given "compatibility first".

Proposed refinements for Phase 1 if you pick A:
1. Build with SIMD128 (−3 % size, −30 % PBKDF2).
2. For PBKDF2 accounts, consider deriving the master key with WebCrypto (98 ms vs 258 ms) — only if
   `bitwarden-crypto` exposes a way to construct a master key from bytes without copying code; to check.
3. Initial CI size budget: **700 KiB raw** for `core_wasm_bg.wasm` (`tools/size-budget.json`),
   tightened after the twiggy breakdown.
4. Offscreen `reason`: none of the documented reasons matches "keep keys in memory"; candidates are
   `WORKERS` (run KDF in a worker, which also solves the 64 MiB memory issue) — to decide.

## Not done / not verified in Phase 0

* Contract test (b) with the official `bw` CLI (not installed) — Phase 1/2.
* `vaultwarden/server:latest` matrix leg — only 1.37.4 was run.
* tools/sync-upstream and the CI workflow — designed (`upstream-map.yaml`), not implemented yet.
* Exact official extension headers from bitwarden/clients — not read yet.
* Org cipher decrypt against a live server; blob ciphers; cipher-key generation for new items.

## Environment notes

* `C:\Users\Eray\Documents` is protected by Windows Controlled Folder Access, which blocks git,
  cargo, node and Claude from writing there; the project now lives in `C:\Users\Eray\src\plugwarden`.
  Two stray files remain in `Documents\plugwarden` (`docs\_probe.txt`,
  `dev\vaultwarden\docker-compose.yml`) that I could not delete.
* Docker Engine 29.1.3 + Compose 2.40.3 were installed into the WSL Ubuntu distro (`apt`).
