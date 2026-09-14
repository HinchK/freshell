#!/usr/bin/env bash
# Behavioral contract: a Playwright retry that ultimately passes must leave
# the first failed attempt's stack and trace bytes in durable JSONL output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECEIPT="$ROOT/scripts/e2e-cloud-retry-receipt.mjs"

WORK="$(mktemp -d /tmp/freshell-cloud-retry-receipt.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

TRACE="$WORK/first-retry-trace.zip"
UNRELATED_TRACE="$WORK/retry-success-trace.zip"
REPORT="$WORK/report.json"
OUT="$WORK/receipt.jsonl"
printf 'synthetic first retry trace\n' > "$TRACE"
printf 'unrelated successful retry trace\n' > "$UNRELATED_TRACE"

cat > "$REPORT" <<JSON
{
  "stats": { "expected": 1 },
  "suites": [{
    "title": "retry fixture",
    "specs": [{
      "title": "recovers on the first retry",
      "file": "test/e2e-browser/specs/retry-fixture.spec.ts",
      "line": 42,
      "tests": [{
        "projectName": "chromium",
        "results": [
          {
            "status": "failed",
            "retry": 0,
            "errors": [{
              "message": "expected ready state",
              "stack": "Error: expected ready state\\n    at retry-fixture.spec.ts:42:9"
            }],
            "attachments": [{
              "name": "trace",
              "contentType": "application/zip",
              "path": "$TRACE"
            }]
          },
          {
            "status": "passed",
            "retry": 1,
            "attachments": [{
              "name": "trace",
              "contentType": "application/zip",
              "path": "$UNRELATED_TRACE"
            }]
          }
        ]
      }]
    }]
  }]
}
JSON

if [ ! -f "$RECEIPT" ]; then
  echo "FAIL: retry-receipt exporter does not exist: $RECEIPT"
  exit 1
fi

CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
  node "$RECEIPT" "$REPORT" > "$OUT"

SUMMARY="$(jq -c 'select(.event == "e2e_playwright_retry_evidence")' "$OUT")"
if [ -z "$SUMMARY" ]; then
  echo "FAIL: successful retry emitted no durable retry-evidence summary"
  cat "$OUT"
  exit 1
fi

if ! jq -e '
  .severity == "WARNING"
  and .taskIndex == 2
  and .taskCount == 4
  and .execution == "retry-receipt-probe"
  and .attempt == 0
  and .failureAttempt == 0
  and .trace.traceAttempt == 0
  and .test.title == "recovers on the first retry"
  and (.error.stack | contains("expected ready state"))
  and .trace.storage == "cloud-logging-jsonl-chunks"
  and (.trace.artifactId | startswith("playwright-retry-trace-"))
' <<< "$SUMMARY" >/dev/null; then
  echo "FAIL: retry summary did not preserve the first-attempt stack and durable trace reference"
  echo "$SUMMARY"
  exit 1
fi

CHUNKS="$(jq -c 'select(.event == "e2e_playwright_retry_trace_chunk")' "$OUT")"
if [ -z "$CHUNKS" ]; then
  echo "FAIL: successful retry emitted no durable trace chunks"
  cat "$OUT"
  exit 1
fi

RECONSTRUCTED="$WORK/reconstructed-trace.zip"
jq -r 'select(.event == "e2e_playwright_retry_trace_chunk") | .data' "$OUT" \
  | base64 --decode > "$RECONSTRUCTED"
cmp -s "$TRACE" "$RECONSTRUCTED" || {
  echo "FAIL: retained trace chunks do not reconstruct the first-retry trace"
  exit 1
}

COMPLETION="$(jq -c 'select(.event == "e2e_playwright_task_complete")' "$OUT")"
if ! jq -e '
  .execution == "retry-receipt-probe"
  and .taskIndex == 2
  and .taskCount == 4
  and .recoveredRetryCount == 1
' <<< "$COMPLETION" >/dev/null; then
  echo "FAIL: exporter did not emit an exact task completion receipt"
  cat "$OUT"
  exit 1
fi

printf '{}' > "$WORK/malformed-report.json"
if CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
  node "$RECEIPT" "$WORK/malformed-report.json" >/dev/null 2>&1; then
  echo "FAIL: structurally incomplete Playwright JSON report was accepted"
  exit 1
fi
for incomplete_report in \
  '{"stats":{"expected":0},"suites":{}}' \
  '{"stats":{"expected":1},"suites":[{}]}' \
  '{"stats":{"expected":1},"suites":[{"specs":[{"tests":[{}]}]}]}'; do
  printf '%s' "$incomplete_report" > "$WORK/incomplete-report.json"
  if CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
    node "$RECEIPT" "$WORK/incomplete-report.json" >/dev/null 2>&1; then
    echo "FAIL: wrong-typed suites, missing specs, or missing results were accepted"
    exit 1
  fi
done

MULTI_FIRST_TRACE="$WORK/multi-first-failure.zip"
MULTI_LATER_TRACE="$WORK/multi-later-attempt.zip"
printf 'first failed attempt trace\n' > "$MULTI_FIRST_TRACE"
printf 'later attempt trace that must not be paired\n' > "$MULTI_LATER_TRACE"
cat > "$WORK/multi-report.json" <<JSON
{
  "stats": { "expected": 1 },
  "suites": [{ "specs": [{
    "title": "fails twice then recovers",
    "file": "test/e2e-browser/specs/multi-retry.spec.ts",
    "line": 7,
    "tests": [{ "projectName": "chromium", "results": [
      { "status": "failed", "retry": 0, "errors": [{ "stack": "first failure" }], "attachments": [{ "name": "trace", "contentType": "application/zip", "path": "$MULTI_FIRST_TRACE" }] },
      { "status": "failed", "retry": 1, "errors": [{ "stack": "later failure" }], "attachments": [{ "name": "trace", "contentType": "application/zip", "path": "$MULTI_LATER_TRACE" }] },
      { "status": "passed", "retry": 2, "attachments": [] }
    ]}]
  }]}]
}
JSON
MULTI_OUT="$WORK/multi-receipt.jsonl"
CLOUD_RUN_EXECUTION=multi-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$WORK/multi-report.json" > "$MULTI_OUT"
MULTI_SUMMARY="$(jq -c 'select(.event == "e2e_playwright_retry_evidence")' "$MULTI_OUT")"
if ! jq -e '
  .failureAttempt == 0
  and .trace.traceAttempt == 0
  and (.error.stack | contains("first failure"))
' <<< "$MULTI_SUMMARY" >/dev/null; then
  echo "FAIL: multi-attempt retry evidence did not retain the first failed attempt's error and trace identity"
  echo "$MULTI_SUMMARY"
  exit 1
fi
jq -r 'select(.event == "e2e_playwright_retry_trace_chunk") | .data' "$MULTI_OUT" \
  | base64 --decode > "$WORK/multi-reconstructed.zip"
cmp -s "$MULTI_FIRST_TRACE" "$WORK/multi-reconstructed.zip" || {
  echo "FAIL: multi-attempt retry receipt paired the first failure with a later attempt's trace"
  exit 1
}

NO_TRACE_REPORT="$WORK/no-trace-report.json"
cat > "$NO_TRACE_REPORT" <<'JSON'
{"stats":{"expected":1},"suites":[{"specs":[{"title":"recovers without a retained trace","tests":[{"projectName":"chromium","results":[{"status":"failed","retry":0,"errors":[{"stack":"failure without trace"}],"attachments":[]},{"status":"passed","retry":1,"attachments":[]}]}]}]}]}
JSON
NO_TRACE_OUT="$WORK/no-trace-receipt.jsonl"
CLOUD_RUN_EXECUTION=no-trace-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$NO_TRACE_REPORT" > "$NO_TRACE_OUT"
if ! jq -e 'select(.event == "e2e_playwright_retry_evidence") | .trace.retained == false and .trace.traceAttempt == 0 and .trace.reason == "No trace attachment was retained for the failed attempt."' "$NO_TRACE_OUT" >/dev/null; then
  echo "FAIL: retry evidence without a same-attempt trace did not state the precise unavailable-trace reason"
  cat "$NO_TRACE_OUT"
  exit 1
fi

CONFIG_REPORT="$WORK/config-report.json"
FRESHELL_CLOUD_RETRY_REPORT_PATH="$CONFIG_REPORT" \
  npx playwright test --config "$ROOT/test/e2e-browser/playwright.cloud.config.ts" --list >/dev/null
if [ ! -s "$CONFIG_REPORT" ]; then
  echo "FAIL: cloud Playwright config did not write the retry-evidence JSON report"
  exit 1
fi
TRACE_MODE="$(npx tsx --eval "import config from '$ROOT/test/e2e-browser/playwright.cloud.config.ts'; console.log(config.use?.trace)")"
if [ "$TRACE_MODE" != "retain-on-first-failure" ]; then
  echo "FAIL: Cloud Playwright config does not retain the trace from the first failed attempt"
  exit 1
fi
ZERO_OUT="$WORK/zero-test-receipt.jsonl"
CLOUD_RUN_EXECUTION=zero-test-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$CONFIG_REPORT" > "$ZERO_OUT"
if ! jq -e 'select(.event == "e2e_playwright_task_complete") | .recoveredRetryCount == 0' "$ZERO_OUT" >/dev/null; then
  echo "FAIL: explicit zero-test Playwright report did not produce a zero-retry completion receipt"
  cat "$ZERO_OUT"
  exit 1
fi

BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/npx" <<'NPX'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "playwright" ] && [ "$2" = "test" ]; then
  if [ -n "${FRESHELL_CLOUD_RETRY_REPORT_PATH:-}" ]; then
    cp "$STUB_RETRY_REPORT" "$FRESHELL_CLOUD_RETRY_REPORT_PATH"
  fi
  exit 0
fi
echo "unexpected npx invocation: $*" >&2
exit 2
NPX
chmod +x "$BIN/npx"

ENTRYPOINT_OUT="$(PATH="$BIN:$PATH" STUB_RETRY_REPORT="$REPORT" CLOUD_RUN_EXECUTION=entrypoint-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium 2>&1)"
if ! grep -q '"event":"e2e_playwright_retry_evidence"' <<< "$ENTRYPOINT_OUT"; then
  echo "FAIL: Cloud entrypoint did not export retry evidence after a successful retry"
  echo "$ENTRYPOINT_OUT"
  exit 1
fi

if PATH="$BIN:$PATH" STUB_RETRY_REPORT="$WORK/malformed-report.json" CLOUD_RUN_EXECUTION=entrypoint-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium >/dev/null 2>&1; then
  echo "FAIL: entrypoint accepted a structurally incomplete JSON report after a successful Playwright process"
  exit 1
fi

echo "PASS: successful retry retains first-attempt stack and trace in durable JSONL chunks"
