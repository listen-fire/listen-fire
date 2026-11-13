#!/usr/bin/env bash
# How much of a movement run is JSON at the wasm boundary: runs the
# benchmark in packages/movement-engine/bench/wasm_boundary (its main.ts says
# what it measures and how) and prints the table. Tooling, not a test: it is
# in no suite and not in CI. It needs cargo and this repository's Node.
#
#   scripts/bench-wasm-boundary.sh [--runs small,walk,records,document]
#     [--iterations 30] [--warmup 15] [--no-wasm-replay] [--keep-wasm-target]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
TSX="$(node -p 'require.resolve("tsx/cjs", { paths: [require.resolve("module-kit/package.json", { paths: ["packages/movement-engine"] })] })')"
exec node --require "$TSX" packages/movement-engine/bench/wasm_boundary/main.ts "$@"
