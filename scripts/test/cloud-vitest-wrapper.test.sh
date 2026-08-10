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
# For artifacts docker images describe, exit 0 (image exists)
if [[ "$*" == *"artifacts docker images describe"* ]]; then
  exit 0
fi
# For run jobs create/update/execute, exit 0
if [[ "$*" == *"run jobs"* ]]; then
  exit 0
fi
# For logs read, output something
if [[ "$*" == *"logs read"* ]]; then
  echo "Test Files  1 passed (1)"
  exit 0
fi
# For executions describe
if [[ "$*" == *"executions describe"* ]]; then
  echo "1"
  exit 0
fi
# For executions list
if [[ "$*" == *"executions list"* ]]; then
  echo "test-execution-1"
  exit 0
fi
# For info (sdk_root)
if [[ "$*" == *"info"* ]]; then
  echo "/usr/lib/google-cloud-sdk"
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
check "--config=default sets correct config" grep -q 'vitest.config.ts' "${FAKE_GCLOUD_LOG}.envvars"

# Check 7: --config=server sets VITEST_CONFIGS to only server config
rm -f "${FAKE_GCLOUD_LOG}.envvars"
bash "$SCRIPT" run --cloud --config=server 2>&1 > /dev/null || true
check "--config=server sets correct config" grep -q 'vitest.server.config.ts' "${FAKE_GCLOUD_LOG}.envvars"

# Check 8: VITEST_ARGS_JSON is valid JSON when pass-through args are present
rm -f "${FAKE_GCLOUD_LOG}.envvars"
bash "$SCRIPT" run --cloud --config=default test/unit/lib/pane-utils.test.ts 2>&1 > /dev/null || true
if [ -f "${FAKE_GCLOUD_LOG}.envvars" ]; then
  # Extract the YAML double-quoted value and unescape it to get the raw JSON
  VITEST_ARGS_VAL=$(grep 'VITEST_ARGS_JSON' "${FAKE_GCLOUD_LOG}.envvars" | sed 's/^VITEST_ARGS_JSON: //' || true)
  if [ -n "$VITEST_ARGS_VAL" ]; then
    # Use jq to parse the YAML double-quoted string back to raw JSON, then validate
    check "VITEST_ARGS_JSON is valid JSON" bash -c "echo '$VITEST_ARGS_VAL' | jq -r . | jq -e '.' > /dev/null 2>&1"
  else
    echo "FAIL: VITEST_ARGS_JSON not found in env-vars file"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "FAIL: env-vars file not captured by fake gcloud"
  FAILURES=$((FAILURES + 1))
fi

# Check 9: TEST_MODE=vitest is set in env-vars file
if [ -f "${FAKE_GCLOUD_LOG}.envvars" ]; then
  check "env-vars file sets TEST_MODE=vitest" grep -q 'TEST_MODE.*vitest' "${FAKE_GCLOUD_LOG}.envvars"
else
  echo "FAIL: env-vars file not available for TEST_MODE check"
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
