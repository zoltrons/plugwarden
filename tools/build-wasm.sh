#!/usr/bin/env bash
# Builds crates/core-wasm -> dist/wasm/{core_wasm.js,core_wasm_bg.wasm}.
#   tools/build-wasm.sh [--features register] [--simd]
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli (exact version from upstream.lock),
# wasm-opt (binaryen). Override binaries with WASM_BINDGEN / WASM_OPT.
set -euo pipefail
cd "$(dirname "$0")/.."

FEATURES=""
OUT="dist/wasm"
RUSTFLAGS_EXTRA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --features) FEATURES="--features $2"; shift ;;
    --simd) RUSTFLAGS_EXTRA="-C target-feature=+simd128" ;;
    --out) OUT="$2"; shift ;;
  esac
  shift
done

WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
WASM_OPT="${WASM_OPT:-wasm-opt}"
want=$(sed -n 's/^wasm-bindgen = "\(.*\)".*/\1/p' upstream.lock)
have=$("$WASM_BINDGEN" --version | awk '{print $2}')
[[ "$want" == "$have" ]] || { echo "wasm-bindgen-cli $have != $want (upstream.lock)" >&2; exit 1; }

# Keep the cfg from .cargo/config.toml when adding flags.
RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" $RUSTFLAGS_EXTRA" \
  cargo build --release --target wasm32-unknown-unknown -p plugwarden-core-wasm $FEATURES

mkdir -p "$OUT"
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/plugwarden_core_wasm.wasm \
  --target web --out-dir "$OUT" --out-name core_wasm --no-typescript
"$WASM_OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals ${RUSTFLAGS_EXTRA:+--enable-simd} \
  "$OUT/core_wasm_bg.wasm" -o "$OUT/core_wasm_bg.wasm"
ls -l "$OUT"
