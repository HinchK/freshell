#!/usr/bin/env bash
# Behavioral Cloud wrapper contract: jsonPayload receipts are required, retried
# through ingestion lag, and used to reject recovered Playwright retries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$ROOT/scripts/e2e-cloud.sh"
WORK="$(mktemp -d /tmp/freshell-cloud-logging-receipt.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/capture"

cat > "$WORK/bin/gcloud" <<'GCLOUD'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STUB_CAPTURE/gcloud.args"
case "$*" in
  "info "*) echo /nonexistent-sdk-root ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*|*"run jobs delete"*) exit 0 ;;
  *"run jobs execute"*) echo "Execution [exec-json-receipt] has successfully completed." ;;
  *"executions logs read"*) echo "  4 passed (12.3s)" ;;
  *"logging read"*)
    case "$*" in
      *'labels."run.googleapis.com/execution_name"="exec-json-receipt"'*) ;;
      *'labels.execution_name'*) echo "obsolete execution label" >&2; exit 9 ;;
      *) echo "missing or incorrect Cloud Run Jobs execution label" >&2; exit 9 ;;
    esac
    if [ "${STUB_LOGGING_FAIL:-0}" = 1 ]; then echo "logging unavailable" >&2; exit 7; fi
    count_file="$STUB_CAPTURE/logging.count"
    count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
    if [ "${STUB_DELAY_ONCE:-0}" = 1 ] && [ "$count" -eq 1 ]; then echo '[]'; else printf '%s\n' "$STUB_LOGGING_JSON"; fi ;;
  *"executions describe"*)
    case "$*" in
      *failedCount*) echo 0 ;;
      *succeededCount*) echo "${STUB_SUCCEEDED:-2}" ;;
    esac ;;
  *) exit 0 ;;
esac
GCLOUD
chmod +x "$WORK/bin/gcloud"

records_no_retry='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"recoveredRetryCount":0}}
]'

OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_DELAY_ONCE=1 STUB_LOGGING_JSON="$records_no_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" || {
  echo "FAIL: delayed structured receipt run failed"; echo "$OUT"; exit 1
}
if ! grep -q "All tasks completed successfully" <<< "$OUT"; then
  echo "FAIL: complete delayed structured receipts did not allow success"; echo "$OUT"; exit 1
fi
if [ "$(cat "$WORK/capture/logging.count")" -lt 2 ]; then
  echo "FAIL: wrapper did not retry delayed Cloud Logging receipt ingestion"; cat "$WORK/capture/gcloud.args"; exit 1
fi
if ! grep -Fq 'labels."run.googleapis.com/execution_name"="exec-json-receipt"' "$WORK/capture/gcloud.args" \
  || grep -Fq 'labels.execution_name' "$WORK/capture/gcloud.args"; then
  echo "FAIL: wrapper did not issue a structured jsonPayload Cloud Logging query scoped to its execution"
  cat "$WORK/capture/gcloud.args"; exit 1
fi

records_empty_shards='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":2,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":3,"taskCount":4,"recoveredRetryCount":0}}
]'
EMPTY_SHARDS_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_LOGGING_JSON="$records_empty_shards" STUB_SUCCEEDED=4 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=4 2>&1)" || {
  echo "FAIL: a narrow multi-task run with empty shards did not accept one zero-retry receipt for each task"; echo "$EMPTY_SHARDS_OUT"; exit 1
}
if ! grep -q "All tasks completed successfully" <<< "$EMPTY_SHARDS_OUT"; then
  echo "FAIL: complete zero-retry receipts from empty shards did not allow success"; echo "$EMPTY_SHARDS_OUT"; exit 1
fi

records_retry='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_retry_evidence","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"failureAttempt":0,"error":{"stack":"first failure"},"trace":{"traceAttempt":0,"retained":false}}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"recoveredRetryCount":1}}
]'
rm -f "$WORK/capture/logging.count"
RETRY_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_LOGGING_JSON="$records_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" && RETRY_RC=0 || RETRY_RC=$?
if [ "$RETRY_RC" -eq 0 ] || ! grep -q "recovered Playwright retry evidence prevents a zero-flake" <<< "$RETRY_OUT"; then
  echo "FAIL: structured recovered retry did not fail the zero-flake receipt"; echo "$RETRY_OUT"; exit 1
fi

ERROR_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_LOGGING_FAIL=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" && ERROR_RC=0 || ERROR_RC=$?
if [ "$ERROR_RC" -eq 0 ] || ! grep -q "could not retrieve complete structured retry receipts" <<< "$ERROR_OUT"; then
  echo "FAIL: Cloud Logging read failure was accepted as zero retry evidence"; echo "$ERROR_OUT"; exit 1
fi

echo "PASS: Cloud wrapper requires structured delayed task receipts and rejects recovered retries"
