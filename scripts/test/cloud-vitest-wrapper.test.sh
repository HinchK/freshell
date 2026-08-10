#!/usr/bin/env bash
# Test: cloud-vitest-wrapper — verify vitest-cloud.sh exists, has correct
# subcommands, flags, backend selection, and local/cloud dispatch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

SCRIPT="$ROOT/scripts/vitest-cloud.sh"

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

echo "=== Cloud Vitest Wrapper Test ==="

# Check 1: Script exists and is executable
check "scripts/vitest-cloud.sh exists and is executable" test -x "$SCRIPT"

# Check 2: help contains usage, run, --local, --cloud, FRESHELL_VITEST_BACKEND, --shards, --config
HELP_OUTPUT=$(bash "$SCRIPT" help 2>&1 || true)
for term in "usage" "run" "--local" "--cloud" "FRESHELL_VITEST_BACKEND" "--shards" "--config"; do
  check "help contains '$term'" grep -qi -- "$term" <<< "$HELP_OUTPUT"
done

# Check 3: Default backend (unset env var) runs locally
# Run with --local flag and a fast test to verify local execution works
LOCAL_OUTPUT=$(FRESHELL_VITEST_BACKEND= bash "$SCRIPT" run --local --config=default test/unit/lib/pane-utils.test.ts 2>&1 || true)
check "--local runs vitest locally" grep -q 'passed\|PASS\|Test Files' <<< "$LOCAL_OUTPUT"

# Check 4: FRESHELL_VITEST_BACKEND=local runs locally
LOCAL_ENV_OUTPUT=$(FRESHELL_VITEST_BACKEND=local bash "$SCRIPT" run --config=default test/unit/lib/pane-utils.test.ts 2>&1 || true)
check "FRESHELL_VITEST_BACKEND=local runs locally" grep -q 'passed\|PASS\|Test Files' <<< "$LOCAL_ENV_OUTPUT"

# Check 5: --cloud flag with fake gcloud — verify the wrapper calls gcloud
FAKE_GCLOUD_DIR=$(mktemp -d)
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
# Capture env-vars file content before it's deleted
for i in "$@"; do
  if [[ "$i" == --env-vars-file=* ]]; then
    envfile="${i#--env-vars-file=}"
    if [ -f "$envfile" ]; then
      cp "$envfile" "${FAKE_GCLOUD_LOG}.envvars"
    fi
  fi
done
# More specific patterns first; catch-all run jobs last
if [[ "$*" == *"artifacts docker images describe"* ]]; then
  exit 0
fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then
  exit 0
fi
if [[ "$*" == *"auth print-access-token"* ]]; then
  echo "fake-token"
  exit 0
fi
if [[ "$*" == *"info"* ]]; then
  echo "/usr/lib/google-cloud-sdk"
  exit 0
fi
if [[ "$*" == *"logs read"* ]]; then
  echo "Test Files  1 passed (1)"
  exit 0
fi
if [[ "$*" == *"executions describe"* ]]; then
  echo "1"
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then
  echo "test-execution-1"
  exit 0
fi
if [[ "$*" == *"builds submit"* ]]; then
  exit 0
fi
# Catch-all for run jobs create/update/execute
if [[ "$*" == *"run jobs"* ]]; then
  exit 0
fi
exit 0
FAKE
chmod +x "$FAKE_GCLOUD_DIR/gcloud"

export FAKE_GCLOUD_LOG="$FAKE_GCLOUD_DIR/gcloud.log"
touch "$FAKE_GCLOUD_LOG"
export PATH="$FAKE_GCLOUD_DIR:$PATH"

CLOUD_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1 || true)
check "--cloud calls gcloud (fake)" grep -q 'FAKE_GCLOUD' "$FAKE_GCLOUD_LOG"
check "--cloud references freshell-vitest job" grep -q 'freshell-vitest' "$FAKE_GCLOUD_LOG"

# Check 6: --config=default sets VITEST_CONFIGS to only default config
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash "$SCRIPT" run --cloud --config=default 2>&1 > /dev/null || true
check "--config=default sets correct config" grep -q 'vitest.config.ts' "$FAKE_GCLOUD_LOG"

# Check 7: --config=server sets VITEST_CONFIGS to only server config
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash "$SCRIPT" run --cloud --config=server 2>&1 > /dev/null || true
check "--config=server sets correct config" grep -q 'vitest.server.config.ts' "$FAKE_GCLOUD_LOG"

# Check 8: VITEST_ARGS_JSON is valid JSON when pass-through args are present
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash "$SCRIPT" run --cloud --config=default test/unit/lib/pane-utils.test.ts 2>&1 > /dev/null || true
# Extract VITEST_ARGS_JSON from the --update-env-vars flag in the gcloud log
ENV_VARS_LINE=$(grep 'update-env-vars' "$FAKE_GCLOUD_LOG" | head -1 || true)
if [ -n "$ENV_VARS_LINE" ]; then
  # Extract the JSON array value after VITEST_ARGS_JSON= (non-greedy match for [...])
  VITEST_ARGS_VAL=$(echo "$ENV_VARS_LINE" | grep -oP 'VITEST_ARGS_JSON=\K\[.*?\]' || true)
  if [ -n "$VITEST_ARGS_VAL" ]; then
    check "VITEST_ARGS_JSON is valid JSON" bash -c "echo '$VITEST_ARGS_VAL' | jq -e '.' > /dev/null 2>&1"
  else
    echo "FAIL: VITEST_ARGS_JSON not found in --update-env-vars"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "FAIL: --update-env-vars not found in fake gcloud log"
  FAILURES=$((FAILURES + 1))
fi

# Check 9: TEST_MODE=vitest is set in --update-env-vars
if [ -n "$ENV_VARS_LINE" ]; then
  check "TEST_MODE=vitest set in --update-env-vars" grep -q 'TEST_MODE=vitest' <<< "$ENV_VARS_LINE"
else
  echo "FAIL: --update-env-vars not available for TEST_MODE check"
  FAILURES=$((FAILURES + 1))
fi

# Cleanup
rm -rf "$FAKE_GCLOUD_DIR"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
