#!/usr/bin/env bash
# Behavioral contract for Cloud Logging jsonPayload retry receipts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUMMARY="$ROOT/scripts/e2e-cloud-structured-receipts.mjs"
WORK="$(mktemp -d /tmp/freshell-cloud-structured-receipts.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$SUMMARY" ]; then
  echo "FAIL: structured Cloud receipt parser does not exist: $SUMMARY"
  exit 1
fi

cat > "$WORK/records.json" <<'JSON'
[
  {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-probe","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},
  {"jsonPayload":{"event":"e2e_playwright_retry_evidence","execution":"exec-probe","taskIndex":1,"taskCount":2,"failureAttempt":0,"trace":{"artifactId":"trace-probe","traceAttempt":0},"error":{"stack":"first failure"}}},
  {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-probe","taskIndex":1,"taskCount":2,"recoveredRetryCount":1}}
]
JSON

SUMMARY_JSON="$(node "$SUMMARY" exec-probe 2 < "$WORK/records.json")"
if ! jq -e '
  .execution == "exec-probe"
  and .taskCount == 2
  and .recoveredRetryCount == 1
  and (.retryEvidence | length) == 1
  and .retryEvidence[0].trace.artifactId == "trace-probe"
' <<< "$SUMMARY_JSON" >/dev/null; then
  echo "FAIL: valid structured Cloud receipts did not produce an exact retry summary"
  echo "$SUMMARY_JSON"
  exit 1
fi

for invalid_records in \
  '[]' \
  '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-probe","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-probe","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}}]' \
  '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"wrong-execution","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"wrong-execution","taskIndex":1,"taskCount":2,"recoveredRetryCount":0}}]'; do
  if printf '%s' "$invalid_records" | node "$SUMMARY" exec-probe 2 >/dev/null 2>&1; then
    echo "FAIL: incomplete, duplicate, or mismatched structured task receipts were accepted"
    exit 1
  fi
done

echo "PASS: structured Cloud JSON receipts prove every task and recovered retry"
