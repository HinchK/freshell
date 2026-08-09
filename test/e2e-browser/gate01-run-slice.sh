#!/usr/bin/env bash
# GATE-01 slice runner. Runs ONE OR MORE spec files under BOTH gate projects
# (gate01-legacy + gate01-rust) with the pw lease held (300s heartbeat),
# then collates the JSON report into test/e2e-browser/gate01-baseline.json.
#
# Usage:
#   test/e2e-browser/gate01-run-slice.sh <run-id> <spec-file> [spec-file...]
#
# Slice groupings are listed in docs/plans/df1-evidence/GATE-01.md (appendix);
# the authoritative suite list comes from the collator itself.
#
# Required env (runner FAILS CLOSED without it):
#   FRESHELL_E2E_RUST_SERVER_BIN — absolute path to a pre-built
#     target/release/freshell-server FROM THIS WORKTREE AT THE CURRENT HEAD.
#     Rationale (helpers/rust-server.ts:110): the override skips the implicit
#     per-worker `cargo build --release`, so no cargo lease is needed here.
#     If this branch is rebased onto changed rust sources, REBUILD the binary
#     (under the cargo lease) before the next slice.
#
# Optional env:
#   DF1_HOLDER   lease holder id (default: df1-gate-01-unchanged-suite-both)
#   DF1_ACQUIRE  path to acquire.sh (default: the df1-control worktree copy)
#   GATE01_WORKERS  playwright workers (default: 2)
#
# Lease discipline: acquire pw --wait 3600; heartbeat every 300s during the
# run; release in all exits. Retry/timeout policy: playwright config defaults
# (retries=0 locally) — flakes are proven by dedicated isolated re-runs, not
# auto-retry (see docs/plans/df1/GATE-01.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPORTS="$ROOT/test/e2e-browser/gate01-reports"
BASELINE="$ROOT/test/e2e-browser/gate01-baseline.json"
HOLDER="${DF1_HOLDER:-df1-gate-01-unchanged-suite-both}"
ACQUIRE="${DF1_ACQUIRE:-/home/dan/code/freshell/.worktrees/df1-control/df1-control/scripts/acquire.sh}"
WORKERS="${GATE01_WORKERS:-2}"

RUN_ID="${1:?run-id required (e.g. slice-0)}"
shift
[ "$#" -ge 1 ] || { echo "at least one spec file required" >&2; exit 2; }
SPECS=("$@")

[ -n "${FRESHELL_E2E_RUST_SERVER_BIN:-}" ] || {
  echo "FRESHELL_E2E_RUST_SERVER_BIN not set (see header)" >&2; exit 2; }
[ -x "$FRESHELL_E2E_RUST_SERVER_BIN" ] || {
  echo "FRESHELL_E2E_RUST_SERVER_BIN not executable: $FRESHELL_E2E_RUST_SERVER_BIN" >&2; exit 2; }

mkdir -p "$REPORTS"
REPORT="$REPORTS/$RUN_ID.json"

HB_PID=""
cleanup() {
  [ -n "$HB_PID" ] && kill "$HB_PID" 2>/dev/null || true
  "$ACQUIRE" release pw "$HOLDER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

HEAD="$(git -C "$ROOT" rev-parse HEAD)"
BIN_SHA="$(sha256sum "$FRESHELL_E2E_RUST_SERVER_BIN" | cut -d' ' -f1)"

if [ ! -f "$BASELINE" ]; then
  (cd "$HERE" && nice -n 19 npx tsx helpers/gate01-collate.ts init --head "$HEAD" --bin-sha "$BIN_SHA")
fi

"$ACQUIRE" pw "$HOLDER" --wait 3600
(while true; do sleep 300; "$ACQUIRE" heartbeat pw "$HOLDER" >/dev/null 2>&1 || true; done) &
HB_PID=$!

cd "$ROOT/test/e2e-browser"
GATE01_JSON_OUTPUT="$REPORT" nice -n 19 npx playwright test \
  --config playwright.gate01.config.ts \
  --workers="$WORKERS" \
  "${SPECS[@]/#/specs/}"

kill "$HB_PID" 2>/dev/null || true
HB_PID=""
"$ACQUIRE" release pw "$HOLDER"

(cd "$HERE" && nice -n 19 npx tsx helpers/gate01-collate.ts merge --report "$REPORT" --run "$RUN_ID" --head "$HEAD" --bin-sha "$BIN_SHA")
