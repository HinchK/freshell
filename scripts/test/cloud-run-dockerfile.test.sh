#!/usr/bin/env bash
# Test: Cloud Run Docker image builds and can run Playwright tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

IMAGE_TAG="freshell-e2e:test"

echo "=== Cloud Run Docker Image Test ==="

# Check 1: Dockerfile exists
if [ ! -f "docker/cloud-run/Dockerfile" ]; then
  echo "FAIL: docker/cloud-run/Dockerfile does not exist"
  exit 1
fi
echo "PASS: Dockerfile exists"

# Check 2: entrypoint exists
if [ ! -f "docker/cloud-run/entrypoint.sh" ]; then
  echo "FAIL: docker/cloud-run/entrypoint.sh does not exist"
  exit 1
fi
echo "PASS: entrypoint.sh exists"

# Check 3: .dockerignore exists
if [ ! -f ".dockerignore" ]; then
  echo "FAIL: .dockerignore does not exist"
  exit 1
fi
echo "PASS: .dockerignore exists"

# Check 4: Build the image
echo "Building Docker image (this may take a while)..."
docker build -f docker/cloud-run/Dockerfile -t "$IMAGE_TAG" . || {
  echo "FAIL: docker build failed"
  exit 1
}
echo "PASS: docker build succeeded"

# Check 5: The Vitest lane behaviorally builds isolated Rust build-script
# fixtures. Verify the assembled Cloud test image provides a runnable Cargo
# toolchain to its configured (non-root) runtime user; a source-text check
# would not catch a broken copied toolchain or PATH.
echo "Checking Cargo is runnable in the Cloud test image..."
CARGO_OUTPUT=$(docker run --rm --entrypoint cargo "$IMAGE_TAG" --version 2>&1) || {
  echo "FAIL: cargo is not runnable in the Cloud test image"
  echo "$CARGO_OUTPUT"
  exit 1
}
if ! echo "$CARGO_OUTPUT" | grep -q '^cargo [0-9]'; then
  echo "FAIL: cargo --version did not report a Cargo version"
  echo "$CARGO_OUTPUT"
  exit 1
fi
echo "PASS: Cargo is runnable in the Cloud test image"

# Check 6: Run auth smoke test in container. No CLI --reporter flag: it would
# REPLACE the cloud config's reporter array, whose JSON reporter writes the
# retry-evidence report the entrypoint requires (fail-closed exit 70 without
# it). The config's own reporter array already includes the line reporter.
# CLOUD_RUN_EXECUTION emulates the env Cloud Run injects into every real task
# (same idiom as cloud-e2e-retry-receipt.test.sh) — the entrypoint's receipt
# export requires it.
echo "Running auth smoke test in container..."
RUN_OUTPUT=$(docker run --rm -e CLOUD_RUN_EXECUTION=dockerfile-test-task-0 "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1) || {
  echo "FAIL: docker run failed"
  echo "$RUN_OUTPUT" | tail -30
  exit 1
}

if ! echo "$RUN_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in output"
  echo "$RUN_OUTPUT" | tail -30
  exit 1
fi
if ! echo "$RUN_OUTPUT" | grep -q 'e2e_playwright_task_complete'; then
  echo "FAIL: retry-receipt export did not emit the task-complete event"
  echo "$RUN_OUTPUT" | tail -30
  exit 1
fi
echo "PASS: auth smoke test passed (6 passed, retry receipt exported)"

# Check 7: Sharding works
echo "Testing shard 1 of 2..."
SHARD1_OUTPUT=$(docker run --rm -e CLOUD_RUN_TASK_INDEX=0 -e CLOUD_RUN_TASK_COUNT=2 -e CLOUD_RUN_EXECUTION=dockerfile-test-shard-1 "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1) || {
  echo "FAIL: shard 1 run failed"
  echo "$SHARD1_OUTPUT" | tail -30
  exit 1
}
echo "PASS: shard 1/2 completed"

echo "Testing shard 2 of 2..."
SHARD2_OUTPUT=$(docker run --rm -e CLOUD_RUN_TASK_INDEX=1 -e CLOUD_RUN_TASK_COUNT=2 -e CLOUD_RUN_EXECUTION=dockerfile-test-shard-2 "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1) || {
  echo "FAIL: shard 2 run failed"
  echo "$SHARD2_OUTPUT" | tail -30
  exit 1
}
echo "PASS: shard 2/2 completed"

echo ""
echo "=== All checks passed ==="
