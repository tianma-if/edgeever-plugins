#!/usr/bin/env bash
# Checkout the EdgeEver manifest parser used by the verifier.
# vendor/ is gitignored. CI runs this before bun install.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$root/vendor/edgeever"
mkdir -p "$root/vendor"
git clone --depth 1 --filter=blob:none --sparse https://github.com/tianma-if/edgeever.git "$root/vendor/edgeever"
git -C "$root/vendor/edgeever" sparse-checkout set packages/plugin-api
