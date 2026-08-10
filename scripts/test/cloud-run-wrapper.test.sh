#!/usr/bin/env bash
# Test: e2e-cloud wrapper script and npm script integration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

SCRIPT="$ROOT/scripts/e2e-cloud.sh"

echo "=== Cloud Run Wrapper Script Test ==="

# Check 1: Script exists
if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh does not exist"
  exit 1
fi
echo "PASS: script exists"

# Check 2: Script is executable
if [ ! -x "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh is not executable"
  exit 1
fi
echo "PASS: script is executable"

# Check 3: help subcommand
echo "Testing: scripts/e2e-cloud.sh help"
HELP_OUTPUT=$("$SCRIPT" help 2>&1) || {
  echo "FAIL: help subcommand failed"
  echo "$HELP_OUTPUT"
  exit 1
}

if ! echo "$HELP_OUTPUT" | grep -qi "usage"; then
  echo "FAIL: help output does not contain 'usage'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'usage'"

if ! echo "$HELP_OUTPUT" | grep -qi "run"; then
  echo "FAIL: help output does not contain 'run'"
  exit 1
fi
echo "PASS: help contains 'run'"

if ! echo "$HELP_OUTPUT" | grep -qi -- "--local"; then
  echo "FAIL: help output does not contain '--local'"
  exit 1
fi
echo "PASS: help contains '--local'"

# Check 4: --local flag runs tests locally
echo "Testing: scripts/e2e-cloud.sh run --local --project=chromium auth.spec.ts"
LOCAL_OUTPUT=$("$SCRIPT" run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: --local run failed"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
}

if ! echo "$LOCAL_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in --local output"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: --local runs 6 auth tests"

# Check 5: npm run test:e2e -- --local works
echo "Testing: npm run test:e2e -- --local"
NPM_LOCAL_OUTPUT=$(npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e -- --local failed"
  echo "$NPM_LOCAL_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e -- --local works"

# Check 6: npm run test:e2e:local works
echo "Testing: npm run test:e2e:local"
NPM_LOCAL_SCRIPT_OUTPUT=$(npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:local failed"
  echo "$NPM_LOCAL_SCRIPT_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:local works"

# Check 7: existing scripts still work
echo "Testing: npm run test:e2e:chromium (unchanged)"
CHROMIUM_OUTPUT=$(npm run test:e2e:chromium -- test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:chromium failed"
  echo "$CHROMIUM_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:chromium still works"

# Check 8: help mentions --cloud and FRESHELL_E2E_BACKEND
echo "Testing: help mentions --cloud flag"
if ! echo "$HELP_OUTPUT" | grep -qi -- "--cloud"; then
  echo "FAIL: help output does not contain '--cloud'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains '--cloud'"

echo "Testing: help mentions FRESHELL_E2E_BACKEND"
if ! echo "$HELP_OUTPUT" | grep -qi "FRESHELL_E2E_BACKEND"; then
  echo "FAIL: help output does not contain 'FRESHELL_E2E_BACKEND'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'FRESHELL_E2E_BACKEND'"

# Check 9: default backend (unset env var) runs locally
echo "Testing: default backend (unset FRESHELL_E2E_BACKEND) runs locally"
DEFAULT_OUTPUT=$(env -u FRESHELL_E2E_BACKEND "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: default run failed"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
}
if ! echo "$DEFAULT_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
if ! echo "$DEFAULT_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: default backend (unset) runs locally"

# Check 10: FRESHELL_E2E_BACKEND=local runs locally
echo "Testing: FRESHELL_E2E_BACKEND=local runs locally"
LOCAL_ENV_OUTPUT=$(FRESHELL_E2E_BACKEND=local "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: FRESHELL_E2E_BACKEND=local run failed"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
}
if ! echo "$LOCAL_ENV_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' with FRESHELL_E2E_BACKEND=local"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: FRESHELL_E2E_BACKEND=local runs locally"

# Check 11: --cloud overrides FRESHELL_E2E_BACKEND=local, and the cloud run
# targets the COMMIT-ADDRESSED image for the current HEAD — never mutable
# :latest (wrap-review r3: a stale :latest let the cloud e2e gate pass
# against old source). Fully STUBBED gcloud/docker: this check previously
# invoked the real toolchain, which on an authenticated machine could
# really build, push, and execute a cloud job from a test.
echo "Testing: --cloud targets the HEAD-addressed image (stubbed gcloud/docker)"
STUB_DIR="$(mktemp -d /tmp/e2e-cloud-stubs.XXXXXX)"
export STUB_CAPTURE="$STUB_DIR/capture"
mkdir -p "$STUB_CAPTURE"
cat > "$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "info "*) echo "/nonexistent-sdk-root"; exit 0 ;;
  "auth print-access-token"*) echo stub-token; exit 0 ;;
  *"artifacts repositories describe"*) exit 1 ;;
  *"artifacts repositories create"*) exit 0 ;;
  *"artifacts docker images describe"*) echo "$args" >> "$STUB_CAPTURE/describe.args"; exit 1 ;;
  *"run jobs create"*) echo "$args" >> "$STUB_CAPTURE/create.args"; exit 0 ;;
  *"run jobs update"*) echo "$args" >> "$STUB_CAPTURE/update.args"; exit 0 ;;
  *"run jobs execute"*) exit 0 ;;
  *"executions list"*) echo "exec-stub"; exit 0 ;;
  *"executions describe"*)
    case "$args" in
      *failedCount*) echo "0" ;;
      *succeededCount*) echo "1" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  *"logs read"*) echo "  6 passed (4.2s)"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_CAPTURE/docker.args"
exit 0
STUB
chmod +x "$STUB_DIR/gcloud" "$STUB_DIR/docker"
EXPECTED_TAG="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  EXPECTED_TAG="${EXPECTED_TAG}-dirty"
fi
CLOUD_STUB_OUTPUT=$(env PATH="$STUB_DIR:$PATH" FRESHELL_E2E_BACKEND=local "$SCRIPT" run --cloud --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1) || {
  echo "FAIL: stubbed cloud run failed"
  echo "$CLOUD_STUB_OUTPUT" | tail -20
  rm -rf "$STUB_DIR"
  exit 1
}
if echo "$CLOUD_STUB_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: --cloud flag was ignored (printed 'Running locally')"
  echo "$CLOUD_STUB_OUTPUT" | tail -20
  rm -rf "$STUB_DIR"
  exit 1
fi
if ! grep -qE -- "--image=[^ ]+freshell-e2e:${EXPECTED_TAG} " "$STUB_CAPTURE/create.args" 2>/dev/null; then
  echo "FAIL: cloud job did not target the HEAD-addressed image tag ($EXPECTED_TAG)"
  echo "create args: $(cat "$STUB_CAPTURE/create.args" 2>/dev/null || echo '<none>')"
  rm -rf "$STUB_DIR"
  exit 1
fi
if grep -q -- "--image=[^ ]*freshell-e2e:latest" "$STUB_CAPTURE/create.args" 2>/dev/null; then
  echo "FAIL: cloud job targeted mutable :latest (stale-image hazard)"
  rm -rf "$STUB_DIR"
  exit 1
fi
if ! grep -q "push [^ ]*freshell-e2e:${EXPECTED_TAG}" "$STUB_CAPTURE/docker.args" 2>/dev/null; then
  echo "FAIL: the HEAD-addressed image was never pushed by the build fallback"
  echo "docker args: $(cat "$STUB_CAPTURE/docker.args" 2>/dev/null || echo '<none>')"
  rm -rf "$STUB_DIR"
  exit 1
fi
rm -rf "$STUB_DIR"
unset STUB_CAPTURE
echo "PASS: --cloud targets and pushes the HEAD-addressed image tag"

# Check 12: the wrapper works on machines WITHOUT gcloud for non-cloud
# subcommands. The top-level gcloud-sdk PATH setup must not kill the script
# under `set -e` before dispatch (previously a silent 127). `help` is the
# deterministic pin (needs no node/npx); the `run --local` dispatch itself
# never calls gcloud.
echo "Testing: help works without gcloud on PATH"
CLEAN_PATH="$PATH"
if GCLOUD_PATH=$(command -v gcloud 2>/dev/null); then
  GCLOUD_DIRNAME="$(cd "$(dirname "$GCLOUD_PATH")" && pwd)"
  CLEAN_PATH="$(echo "$PATH" | tr ':' '\n' | grep -vx "$GCLOUD_DIRNAME" | paste -sd:)"
  if [ "$CLEAN_PATH" = "$PATH" ]; then
    echo "FAIL: could not construct a gcloud-free PATH (gcloud dir not on PATH?)"
    exit 1
  fi
fi
if env PATH="$CLEAN_PATH" command -v gcloud >/dev/null 2>&1; then
  echo "FAIL: gcloud still resolvable on the filtered PATH"
  exit 1
fi
NO_GCLOUD_HELP=$(env PATH="$CLEAN_PATH" "$SCRIPT" help 2>&1) || {
  echo "FAIL: help subcommand died without gcloud (top-level gcloud probe is not set -e safe)"
  echo "$NO_GCLOUD_HELP" | tail -10
  exit 1
}
if ! echo "$NO_GCLOUD_HELP" | grep -qi "usage"; then
  echo "FAIL: help output without gcloud does not contain 'usage'"
  echo "$NO_GCLOUD_HELP" | tail -10
  exit 1
fi
echo "PASS: help works without gcloud on PATH"

# Check 13: pass-through args CONTAINING SPACES survive end-to-end.
# Two halves:
#  (a) local path: `run --local` execs playwright with the raw arg array —
#      `--grep "auth modal"` (two whitespace-separated words, one arg)
#      must filter auth.spec.ts down to exactly its 3 modal-titled tests.
#  (b) cloud path: the container entrypoint reads PLAYWRIGHT_ARGS
#      newline-delimited (e2e-cloud.sh emits a YAML literal block scalar)
#      and must NOT word-split on spaces — pinned via the single-task
#      --dry-run echo, where a split arg would land in the spec-filter
#      tail instead of the flags list.
echo "Testing: spaced --grep arg filters locally (pass-through array)"
GREP_LOCAL_OUTPUT=$("$SCRIPT" run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line --grep "auth modal" 2>&1) || {
  echo "FAIL: --local run with spaced --grep failed"
  echo "$GREP_LOCAL_OUTPUT" | tail -20
  exit 1
}
if ! echo "$GREP_LOCAL_OUTPUT" | grep -q "3 passed"; then
  echo "FAIL: expected '3 passed' for --grep 'auth modal' (spaced arg corrupted?)"
  echo "$GREP_LOCAL_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: spaced --grep arg survives local pass-through"

echo "Testing: spaced args survive PLAYWRIGHT_ARGS newline round-trip (entrypoint)"
ENTRYPOINT="$ROOT/docker/cloud-run/entrypoint.sh"
DRY_OUTPUT=$(CLOUD_RUN_TASK_COUNT=1 \
  PLAYWRIGHT_ARGS="$(printf -- '--grep=wrap-review spaced sentinel\n--project=chromium')" \
  "$ENTRYPOINT" --dry-run 2>&1) || {
  echo "FAIL: entrypoint --dry-run with spaced PLAYWRIGHT_ARGS died"
  echo "$DRY_OUTPUT" | tail -10
  exit 1
}
if ! echo "$DRY_OUTPUT" | grep -q -- "--grep=wrap-review spaced sentinel --project=chromium"; then
  echo "FAIL: spaced arg was word-split by the entrypoint (expected intact flag in dry-run echo)"
  echo "$DRY_OUTPUT" | tail -10
  exit 1
fi
echo "PASS: entrypoint keeps space-containing PLAYWRIGHT_ARGS entries intact"

# Check 14: SPLIT-FORM value flags ("--grep foo", "--project chromium") are
# normalized to =form before either backend consumes the args. Without
# normalization the cloud entrypoint's dash-vs-positional classification
# silently reordered split values behind later flags
# ("--project chromium --grep 'auth modal'" corrupted into
# "--project --grep chromium 'auth modal'"). Playwright binds =form
# identically, so the observable pin here is the local run filtering
# auth.spec.ts down to its 3 modal-titled tests via split-form args.
echo "Testing: split-form flags normalize (--project chromium --grep 'auth modal')"
SPLIT_OUTPUT=$("$SCRIPT" run --local --project chromium test/e2e-browser/specs/auth.spec.ts --reporter line --grep "auth modal" 2>&1) || {
  echo "FAIL: --local run with split-form flags failed (normalization corrupted argv?)"
  echo "$SPLIT_OUTPUT" | tail -20
  exit 1
}
if ! echo "$SPLIT_OUTPUT" | grep -q "3 passed"; then
  echo "FAIL: expected '3 passed' for split-form --grep 'auth modal'"
  echo "$SPLIT_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: split-form value flags are normalized before dispatch"

echo ""
echo "=== All checks passed ==="
