#!/usr/bin/env bash
# Test: e2e-cloud.sh run stamps the cloud-lane harness WS-ready timeout env
# var (kata j90s) onto every created Cloud Run job, honors an operator
# override, and documents the var in usage. Hermetic: gcloud/docker are
# fully stubbed; no network, no real cloud resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# gcloud-robot hermeticity pin (same as cloud-run-wrapper.test.sh): pinning
# GCLOUD_IDENT forces the identity ladder's rung-2 bypass so nothing here can
# reach a real probe/network.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"

SCRIPT="$ROOT/scripts/e2e-cloud.sh"
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

STUB_DIR="$(mktemp -d /tmp/e2e-harness-timeout-stubs.XXXXXX)"
STUB_CAPTURE="$STUB_DIR/capture"
mkdir -p "$STUB_CAPTURE"
export STUB_CAPTURE
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "info "*) echo "/nonexistent-sdk-root"; exit 0 ;;
  "auth print-access-token"*) echo stub-token; exit 0 ;;
  *"artifacts repositories describe"*) exit 1 ;;
  *"artifacts repositories create"*) exit 0 ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*)
    echo "$args" >> "${STUB_CAPTURE:?}/gcloud.args"
    envfile="$(printf '%s\n' "$args" | grep -oP -- '--env-vars-file=\K[^ ]+')"
    if [ -n "$envfile" ] && [ -f "$envfile" ]; then
      cp "$envfile" "${STUB_CAPTURE:?}/env.yaml"
    fi
    exit 0 ;;
  *"run jobs execute"*) exit 0 ;;
  *"executions list"*) echo "exec-stub"; exit 0 ;;
  *"executions describe"*)
    case "$args" in
      *failedCount*) echo "0" ;;
      *succeededCount*) echo "1" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *"logs read"*) echo "  6 passed (4.2s)"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
exit 0
STUB
chmod +x "$STUB_DIR/gcloud" "$STUB_DIR/docker"

echo "=== e2e harness timeout env test ==="

# Check 1: a cloud run's job env file carries the default 90s window.
# env -u keeps the leg hermetic: an ambient FRESHELL_E2E_WS_READY_TIMEOUT_MS
# (operator override) must neither satisfy nor break the default assertion.
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS PATH="$STUB_DIR:$PATH" bash "$SCRIPT" run --cloud --shards=1 \
  test/e2e-browser/specs/settings.spec.ts >/dev/null 2>&1 || true
check "run jobs create captured an env-vars file" test -f "$STUB_CAPTURE/env.yaml"
check "env file sets FRESHELL_E2E_WS_READY_TIMEOUT_MS to 90000 by default" \
  grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS: "90000"' "$STUB_CAPTURE/env.yaml"
check "env file carries FRESHELL_E2E_SERVER_VERBOSE: \"1\" (server-log visibility)" \
  grep -q 'FRESHELL_E2E_SERVER_VERBOSE: "1"' "$STUB_CAPTURE/env.yaml"
check "env file still carries PLAYWRIGHT_ARGS" \
  grep -q 'PLAYWRIGHT_ARGS' "$STUB_CAPTURE/env.yaml"

# Check 2: an operator override wins over the default.
rm -f "$STUB_CAPTURE/env.yaml" "$STUB_CAPTURE/gcloud.args"
env PATH="$STUB_DIR:$PATH" FRESHELL_E2E_WS_READY_TIMEOUT_MS=60000 \
  bash "$SCRIPT" run --cloud --shards=1 \
  test/e2e-browser/specs/settings.spec.ts >/dev/null 2>&1 || true
check "operator override (60000) lands in the env file" \
  grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS: "60000"' "$STUB_CAPTURE/env.yaml"

# Check 3: usage documents both env vars.
check "help documents FRESHELL_E2E_WS_READY_TIMEOUT_MS" \
  bash -c "bash '$SCRIPT' help 2>&1 | grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS'"
check "help documents FRESHELL_E2E_SERVER_VERBOSE" \
  bash -c "bash '$SCRIPT' help 2>&1 | grep -q 'FRESHELL_E2E_SERVER_VERBOSE'"

# Check 4: the wrapper script itself stays syntactically valid.
check "e2e-cloud.sh passes bash -n" bash -n "$SCRIPT"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILURES CHECK(S) FAILED"
exit 1
