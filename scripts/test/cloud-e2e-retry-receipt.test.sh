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
REPORT="$WORK/report.json"
OUT="$WORK/receipt.jsonl"
printf 'synthetic first retry trace\n' > "$TRACE"

cat > "$REPORT" <<JSON
{
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
            "attachments": []
          },
          {
            "status": "passed",
            "retry": 1,
            "attachments": [{
              "name": "trace",
              "contentType": "application/zip",
              "path": "$TRACE"
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

CONFIG_REPORT="$WORK/config-report.json"
FRESHELL_CLOUD_RETRY_REPORT_PATH="$CONFIG_REPORT" \
  npx playwright test --config "$ROOT/test/e2e-browser/playwright.cloud.config.ts" --list >/dev/null
if [ ! -s "$CONFIG_REPORT" ]; then
  echo "FAIL: cloud Playwright config did not write the retry-evidence JSON report"
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

ENTRYPOINT_OUT="$(PATH="$BIN:$PATH" STUB_RETRY_REPORT="$REPORT" CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium 2>&1)"
if ! grep -q '"event":"e2e_playwright_retry_evidence"' <<< "$ENTRYPOINT_OUT"; then
  echo "FAIL: Cloud entrypoint did not export retry evidence after a successful retry"
  echo "$ENTRYPOINT_OUT"
  exit 1
fi

echo "PASS: successful retry retains first-attempt stack and trace in durable JSONL chunks"
