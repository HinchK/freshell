#!/usr/bin/env bash
# Test: cloud-gcp-identity — hermetic coverage for the gcloud-robot identity
# ladder (scripts/lib/gcp-identity.sh) adopted by scripts/e2e-cloud.sh and
# scripts/vitest-cloud.sh. Covers every ladder rung (rung-1 repo pin respect,
# rung-2 GCLOUD_IDENT bypass, rung-3 probe via GCLOUD_ROBOT_HOME, rung-4
# quiet ambient fallback and GCLOUD_ROBOT_REQUIRE=1 fail-closed), bridge/env
# forwarding, operator overrides, and single-probe idempotency.
#
# ALWAYS hermetic: the probe branch drives an inert fake selector under a
# fake GCLOUD_ROBOT_HOME and every wrapper run uses a stubbed gcloud — no
# network, no real credentials, no real IAM answers (skill trap 11).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

HELPER="$ROOT/scripts/lib/gcp-identity.sh"
WRAPPER_E2E="$ROOT/scripts/e2e-cloud.sh"
WRAPPER_VITEST="$ROOT/scripts/vitest-cloud.sh"

FAILURES=0
check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== Cloud GCP identity ladder test ==="

TDIR="$(mktemp -d /tmp/cloud-gcp-identity.XXXXXX)"
trap 'rm -rf "$TDIR"' EXIT

# Inert stand-in for the gcloud-robot selector: records every invocation
# (proves the probe branch ran) plus the env contract it observed, then
# prints the caller-chosen account or takes the zero-candidate exit-1 path
# with empty stdout (its documented failure shape — see skill known-issues
# trap 11). Touches nothing but $TDIR; real curl/gcloud never run.
FAKE_HOME="$TDIR/robot-home"
mkdir -p "$FAKE_HOME/scripts"
cat > "$FAKE_HOME/scripts/select-gcloud-identity.sh" <<'FAKE_SELECTOR'
#!/usr/bin/env bash
echo ran >> "${SELECTOR_MARKER:?set SELECTOR_MARKER}"
echo "project=${GCLOUD_ROBOT_PROJECT:-} probe=${GCLOUD_ROBOT_PROBE_PERMISSION:-}" >> "${SELECTOR_MARKER}.env"
if [ "${SELECTOR_FAIL:-0}" = "1" ]; then exit 1; fi
printf '%s\n' "${SELECTOR_ACCOUNT:-}"
FAKE_SELECTOR
chmod +x "$FAKE_HOME/scripts/select-gcloud-identity.sh"

export SELECTOR_MARKER="$TDIR/selector-ran"
LADDER_STDERR="$TDIR/stderr"

# Reads one "key=value" outcome line out of a run_ladder transcript.
field() {
  grep "^$2=" <<< "$1" | head -1 | cut -d= -f2-
}

# Identity/ladder knobs scrubbed out of the harness environment before every
# ladder/wrapper invocation — an operator machine may legitimately export any
# of these (FRESHELL_GCP_ACCOUNT, GCLOUD_ROBOT_REQUIRE=1, a real
# GCLOUD_ROBOT_HOME, ...), and any leak would silently change which rung a
# check exercises. Every ladder/wrapper call below applies this list, then
# layers only the knobs the check intends.
SCRUB=(-u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE
       -u GCLOUD_ROBOT_PROJECT -u GCLOUD_ROBOT_PROBE_PERMISSION
       -u FRESHELL_GCP_ACCOUNT -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT
       -u SELECTOR_ACCOUNT -u SELECTOR_FAIL)

# Runs the identity ladder in a FRESH bash process over the scrubbed env;
# extra KEY=VALUE arguments are the check's intended knobs, forwarded to env.
# Stdout: rc/ident/account/pin outcome lines. Stderr from the ladder lands in
# $LADDER_STDERR. Resets the selector markers per run. Always returns 0: the
# ladder's own rc is reported as the rc= outcome line, so a subshell crash
# shows up as missing lines, not a set -e abort.
run_ladder() {
  local probe="$1"
  shift
  rm -f "$LADDER_STDERR" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  env "${SCRUB[@]}" "$@" bash -c '
    set -u
    . "$1"
    GCP_PROJECT="misc-puttering-project"
    GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
    if freshell_resolve_cloud_identity "$2"; then rc=0; else rc=$?; fi
    printf "rc=%s\n" "$rc"
    printf "ident=%s\n" "${GCLOUD_IDENT:-}"
    printf "account=%s\n" "${CLOUDSDK_CORE_ACCOUNT:-}"
    printf "pin=%s\n" "$GCP_ACCOUNT"
  ' _ "$HELPER" "$probe" 2>"$LADDER_STDERR" || true
}

# --- Check A: sourcing is silent and side-effect-free ---------------------
# help/local lanes source the helper unconditionally, so the source itself
# must never print, resolve, or require any env.
SRC_OUT=$(env "${SCRUB[@]}" bash -c \
  'set -u; . "$1" && declare -F resolve_gcp_identity >/dev/null && declare -F freshell_resolve_cloud_identity >/dev/null && echo sourced-ok' \
  _ "$HELPER" 2>&1 || true)
check "sourcing the helper defines both functions with zero output" \
  bash -c '[ "$1" = "sourced-ok" ]' _ "$SRC_OUT"

# --- Check B: rung 2 — explicit GCLOUD_IDENT bypass, no network -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="fake-bypass@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME")
check "rung-2 bypass: GCLOUD_IDENT flows to pin + exports, selector never runs, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "fake-bypass@example.invalid" ] &&
    [ "$3" = "fake-bypass@example.invalid" ] && [ "$4" = "fake-bypass@example.invalid" ] &&
    [ ! -e "$5" ] && [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check C: rung 3 — probe selects an account, env contract forwarded ---
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="gcloud-robot@example.invalid")
check "rung-3 probe: selector account adopted, project+probe env forwarded, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "gcloud-robot@example.invalid" ] &&
    [ "$3" = "gcloud-robot@example.invalid" ] && [ "$4" = "gcloud-robot@example.invalid" ] &&
    grep -q "project=misc-puttering-project probe=run.jobs.run" "$5.env" &&
    [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check D: probe finds nothing — quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1)
check "probe-empty: one ambient-fallback stderr note, no identity, exit 0" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] && [ -z "$3" ] && [ -z "$4" ] &&
    [ "$(wc -l < "$5")" = "1" ] &&
    grep -q "no probed identity; using ambient gcloud" "$5" &&
    [ -e "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check E: skill absent — single quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run")
check "skill-absent: exactly one ambient-fallback stderr note, exit 0" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$2" &&
    [ ! -e "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check F: strict mode fails closed when the skill is absent -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, skill absent: nonzero rc + strict-mode guidance" \
  bash -c '
    [ "$1" != "0" ] && grep -q "strict mode" "$2" && [ -z "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$(field "$OUT" account)"

# --- Check G: strict mode fails closed when the probe finds nothing -------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1 GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, probe empty: nonzero rc + probe failure named" \
  bash -c '
    [ "$1" != "0" ] && grep -q "no identity passes the probe" "$2"
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR"

# --- Check H: idempotent — a second resolve never re-runs the selector ----
rm -f "$SELECTOR_MARKER"
OUT=$(env "${SCRUB[@]}" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="once@example.invalid" \
      bash -c '
        set -u
        . "$1"
        GCP_PROJECT="misc-puttering-project"
        GCP_ACCOUNT=""
        freshell_resolve_cloud_identity "run.jobs.run"
        freshell_resolve_cloud_identity "cloudbuild.builds.create"
        printf "ident=%s\n" "$GCLOUD_IDENT"
      ' _ "$HELPER" 2>/dev/null || true)
check "two resolves in one process run the selector exactly once" \
  bash -c '
    [ "$1" = "once@example.invalid" ] && [ "$(wc -l < "$2")" = "1" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check I: operator-pinned GCLOUD_ROBOT_PROJECT survives the bridge ----
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="robot@example.invalid" \
      GCLOUD_ROBOT_PROJECT="other-project" GCLOUD_ROBOT_PROBE_PERMISSION="custom.perm.check")
check "operator overrides: project + probe pass through to the selector verbatim" \
  bash -c '
    grep -q "project=other-project probe=custom.perm.check" "$2.env" &&
    [ "$1" = "robot@example.invalid" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check J: rung 1 — a pinned GCP_ACCOUNT short-circuits the ladder -----
# A pin must win BEFORE any ladder work: no selector run (even with
# GCLOUD_ROBOT_HOME + GCLOUD_IDENT present), no CLOUDSDK exports, no stderr,
# and strict mode may not fail a pinned call. The ident transcript line still
# echoes the inherited env value — it is simply never consulted.
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="ident@example.invalid" \
      FRESHELL_GCP_ACCOUNT="pinned@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      GCLOUD_ROBOT_REQUIRE=1)
check "explicit account pin wins BEFORE the ladder (no probe, no exports, silent)" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "pinned@example.invalid" ] && [ -z "$3" ] &&
    [ ! -e "$4" ] && [ ! -s "$5" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" pin)" "$(field "$OUT" account)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# WRAPPER-LEVEL-CHECKS-ANCHOR (Task 2 appends here)

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
