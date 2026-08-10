#!/usr/bin/env bash
# vitest-cloud.sh — Cloud Run Jobs wrapper for Vitest unit/server tests.
#
# Usage:
#   scripts/vitest-cloud.sh [subcommand] [flags] [vitest-args...]
#
# Subcommands:
#   run       (default) Run vitest tests locally or on Cloud Run Jobs
#   build     Build and push the Docker image to Artifact Registry
#   push      Push an already-built image to Artifact Registry
#   logs      Fetch logs from the latest Cloud Run Job execution
#   help      Show this help message
#
# Backend selection:
#   The FRESHELL_VITEST_BACKEND env var controls where tests run by default:
#     - "local"  (default if unset): run locally via vitest
#     - "cloud":                run on Google Cloud Run Jobs
#   Override at invocation time with --local or --cloud.
#
# Flags:
#   --local           Run locally (overrides FRESHELL_VITEST_BACKEND)
#   --cloud           Run on Cloud Run (overrides FRESHELL_VITEST_BACKEND)
#   --build           Force image rebuild + push before running
#   --local-build     Build locally with Docker instead of Cloud Build
#   --shards=N        Number of parallel Cloud Run tasks (default: 4)
#   --timeout=DURATION Cloud Run task timeout (default: 30m)
#   --config=default|server|all  Which vitest configs to run (default: all)
#   --account=EMAIL   GCP account (default: FRESHELL_GCP_ACCOUNT env or dan@danshapiro.com)
#   --project-id=ID   GCP project (default: FRESHELL_GCP_PROJECT env or misc-puttering-project)
#   --region=REGION   GCP region (default: FRESHELL_GCP_REGION env or us-west1)
#
# Examples:
#   scripts/vitest-cloud.sh run --local test/unit/lib/pane-utils.test.ts
#   scripts/vitest-cloud.sh run --cloud --shards=4
#   scripts/vitest-cloud.sh run --cloud --config=default --shards=2
#   scripts/vitest-cloud.sh build
#   scripts/vitest-cloud.sh help
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-dan@danshapiro.com}"
GCP_PROJECT="${FRESHELL_GCP_PROJECT:-misc-puttering-project}"
GCP_REGION="${FRESHELL_GCP_REGION:-us-west1}"
GCP_REPO="${FRESHELL_GCP_REPO:-freshell-e2e}"
GCP_JOB="${FRESHELL_GCP_VITEST_JOB:-freshell-vitest}"

IMAGE_LOCAL="freshell-e2e:latest"
IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/freshell-e2e:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ensure gcloud's bin dir is on PATH (for docker-credential-gcloud used by
# Docker when pushing to Artifact Registry).
if command -v gcloud &>/dev/null; then
  GCLOUD_BIN="$(gcloud info --format="value(installation.sdk_root)" 2>/dev/null)/bin"
  if [ -d "$GCLOUD_BIN" ] && ! echo "$PATH" | grep -q "$GCLOUD_BIN"; then
    export PATH="$GCLOUD_BIN:$PATH"
  fi
fi

DEFAULT_CONFIGS="config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
gcloud_flags() {
  echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --region=${GCP_REGION}"
}

# gcloud artifacts commands use --location, not --region
gcloud_artifacts_flags() {
  echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --location=${GCP_REGION}"
}

usage() {
  cat <<'EOF'
Usage: scripts/vitest-cloud.sh [subcommand] [flags] [vitest-args...]

Subcommands:
  run       (default) Run vitest tests locally or on Cloud Run Jobs
  build     Build and push the Docker image to Artifact Registry
  push      Push an already-built image to Artifact Registry
  logs      Fetch logs from the latest Cloud Run Job execution
  help      Show this help message

Flags:
  --local           Run locally (overrides FRESHELL_VITEST_BACKEND)
  --cloud           Run on Cloud Run (overrides FRESHELL_VITEST_BACKEND)
  --build           Force image rebuild + push before running
  --local-build     Build locally with Docker instead of Cloud Build
  --shards=N        Number of parallel Cloud Run tasks (default: 4)
  --timeout=DURATION Cloud Run task timeout (default: 30m)
  --config=default|server|all  Which vitest configs to run (default: all)
  --account=EMAIL   GCP account (default: dan@danshapiro.com)
  --project-id=ID   GCP project (default: misc-puttering-project)
  --region=REGION   GCP region (default: us-west1)

Environment:
  FRESHELL_VITEST_BACKEND  "local" (default) or "cloud"

Examples:
  scripts/vitest-cloud.sh run --local test/unit/lib/pane-utils.test.ts
  scripts/vitest-cloud.sh run --cloud --shards=4
  scripts/vitest-cloud.sh run --cloud --config=default --shards=2
  scripts/vitest-cloud.sh build
  scripts/vitest-cloud.sh help
EOF
}

# ---------------------------------------------------------------------------
# Subcommand: build
# ---------------------------------------------------------------------------
cmd_build() {
  local local_build=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local-build)
        local_build=true
        shift
        ;;
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  # Recompute IMAGE_REMOTE with potentially overridden GCP settings
  IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/freshell-e2e:latest"

  if $local_build; then
    echo "[vitest-cloud] Building Docker image locally..."
    docker build -f "$ROOT/docker/cloud-run/Dockerfile" -t "$IMAGE_LOCAL" "$ROOT"
    echo "[vitest-cloud] Image built: $IMAGE_LOCAL"
    cmd_push
  else
    echo "[vitest-cloud] Building Docker image via Cloud Build..."
    gcloud builds submit \
      --config "$ROOT/docker/cloud-run/cloudbuild.yaml" \
      --account="$GCP_ACCOUNT" \
      --project="$GCP_PROJECT" \
      --substitutions=_IMAGE="$IMAGE_REMOTE" \
      "$ROOT"
    echo "[vitest-cloud] Cloud Build complete: $IMAGE_REMOTE"
  fi
}

# ---------------------------------------------------------------------------
# Subcommand: push
# ---------------------------------------------------------------------------
cmd_push() {
  echo "[vitest-cloud] Pushing to Artifact Registry..."

  # Ensure the Artifact Registry repo exists
  if ! gcloud artifacts repositories describe $(gcloud_artifacts_flags) "$GCP_REPO" &>/dev/null; then
    echo "[vitest-cloud] Creating Artifact Registry repository: $GCP_REPO"
    gcloud artifacts repositories create $(gcloud_artifacts_flags) "$GCP_REPO" \
      --repository-format=docker || true
  fi

  # Authenticate Docker to Artifact Registry using an access token.
  gcloud auth print-access-token --account="$GCP_ACCOUNT" | \
    docker login -u oauth2accesstoken --password-stdin \
      "https://${GCP_REGION}-docker.pkg.dev"

  docker tag "$IMAGE_LOCAL" "$IMAGE_REMOTE"
  docker push "$IMAGE_REMOTE"
  echo "[vitest-cloud] Pushed: $IMAGE_REMOTE"
}

# ---------------------------------------------------------------------------
# Subcommand: run
# ---------------------------------------------------------------------------
cmd_run() {
  local local_mode=false
  local cloud_mode=false
  local force_build=false
  local local_build_flag=false
  local shards=4
  local timeout="30m"
  local config_selector="all"
  local -a vt_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local)
        local_mode=true
        shift
        ;;
      --cloud)
        cloud_mode=true
        shift
        ;;
      --build)
        force_build=true
        shift
        ;;
      --local-build)
        local_build_flag=true
        shift
        ;;
      --shards=*)
        shards="${1#*=}"
        shift
        ;;
      --timeout=*)
        timeout="${1#*=}"
        shift
        ;;
      --config=*)
        config_selector="${1#*=}"
        shift
        ;;
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      *)
        vt_args+=("$1")
        shift
        ;;
    esac
  done

  # Resolve configs based on selector
  local configs
  case "$config_selector" in
    default)
      configs="config/vitest/vitest.config.ts"
      ;;
    server)
      configs="config/vitest/vitest.server.config.ts"
      ;;
    all)
      configs="$DEFAULT_CONFIGS"
      ;;
    *)
      echo "[vitest-cloud] Unknown --config value: $config_selector (expected default|server|all)"
      exit 1
      ;;
  esac

  # Resolve backend: explicit flags override env var; env var defaults to local.
  if $cloud_mode; then
    local_mode=false
  elif $local_mode; then
    : # local_mode already true
  elif [ "${FRESHELL_VITEST_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
  else
    local_mode=true
  fi

  if $local_mode; then
    echo "[vitest-cloud] Running locally..."
    cd "$ROOT"
    local exit_code=0
    for config in $configs; do
      echo "[vitest-cloud] Running vitest: $config ${vt_args[*]-}"
      npx vitest run --passWithNoTests --config "$config" "${vt_args[@]+"${vt_args[@]}"}" || exit_code=$?
    done
    exit "$exit_code"
  fi

  # Recompute IMAGE_REMOTE with potentially overridden GCP settings
  IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/freshell-e2e:latest"

  # Cloud mode
  if $force_build; then
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  fi

  # Ensure image exists in remote registry
  if ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" &>/dev/null 2>&1; then
    echo "[vitest-cloud] Remote image not found, building and pushing..."
    cmd_build
  fi

  echo "[vitest-cloud] Running on Cloud Run Jobs..."
  echo "[vitest-cloud]   Image:   $IMAGE_REMOTE"
  echo "[vitest-cloud]   Shards:  $shards"
  echo "[vitest-cloud]   Timeout: $timeout"
  echo "[vitest-cloud]   Configs: $configs"
  echo "[vitest-cloud]   Args:    ${vt_args[*]-}"

  # Build VITEST_ARGS_JSON (JSON array) from pass-through args.
  # Handle empty args correctly (printf with no args produces [""], not []).
  local vitest_args_json="[]"
  if [ ${#vt_args[@]} -gt 0 ]; then
    vitest_args_json=$(printf '%s\n' "${vt_args[@]}" | jq -R . | jq -sc .)
  fi

  # Ensure the job exists with the correct image (create fails if it already
  # exists, fall back to update image only — NOT tasks/timeout/env, which are
  # per-execution overrides passed to `execute` below to avoid racing with
  # concurrent agents on the shared job).
  gcloud run jobs create $(gcloud_flags) "$GCP_JOB" \
    --image="$IMAGE_REMOTE" \
    --max-retries=0 \
    --memory=4Gi \
    --cpu=4 \
    2>/dev/null || \
  gcloud run jobs update $(gcloud_flags) "$GCP_JOB" \
    --image="$IMAGE_REMOTE" \
    --max-retries=0 \
    --memory=4Gi \
    --cpu=4

  # Execute the job with per-execution overrides (tasks, timeout, env-vars).
  # This avoids mutating the shared job with per-run state, preventing races
  # with concurrent agents. Capture the execution ID from the output.
  echo "[vitest-cloud] Executing Cloud Run Job..."
  local execute_output
  local execute_exit=0
  # Use ^@^ delimiter for --update-env-vars to handle commas in JSON arrays.
  local env_overrides="^@^TEST_MODE=vitest@VITEST_CONFIGS=${configs}@VITEST_ARGS_JSON=${vitest_args_json}"
  execute_output=$(gcloud run jobs execute $(gcloud_flags) "$GCP_JOB" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --update-env-vars="$env_overrides" \
    --wait 2>&1) || execute_exit=$?
  echo "$execute_output"

  # Extract the execution ID from the execute output (format: "Execution NAME")
  local execution_id
  execution_id=$(echo "$execute_output" | grep -oP 'Execution \K[^ ]+' | head -1)
  if [ -z "$execution_id" ]; then
    echo "[vitest-cloud] WARNING: could not capture execution ID, falling back to latest"
    execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
      --job="$GCP_JOB" \
      --sort-by="~metadata.creationTimestamp" \
      --format="value(name)" \
      --limit=1)
  fi

  # If execute itself failed, report and exit — don't mask with status queries.
  if [ "$execute_exit" -ne 0 ]; then
    echo "[vitest-cloud] Cloud Run Job execution failed (exit code $execute_exit)."
    # Still fetch logs for debugging
    echo "[vitest-cloud] Fetching logs..."
    gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true
    exit 1
  fi

  # Fetch logs
  echo "[vitest-cloud] Fetching logs..."
  local log_output
  log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true)

  # Print full log output from ALL shards.
  echo "$log_output"

  # Extract and display a per-shard summary from the vitest output.
  echo ""
  echo "[vitest-cloud] Per-shard summary:"
  echo "$log_output" | grep -E '(\[vitest-entrypoint\]|Test Files|Tests )' || true

  # Check execution status — propagate query errors instead of normalizing to 0.
  local succeeded
  local failed
  if ! succeeded=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
    --format="value(status.succeededCount)" 2>/dev/null); then
    echo "[vitest-cloud] ERROR: failed to query execution status"
    exit 1
  fi
  if ! failed=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
    --format="value(status.failedCount)" 2>/dev/null); then
    echo "[vitest-cloud] ERROR: failed to query execution status"
    exit 1
  fi

  # Normalize empty/null to 0
  succeeded="${succeeded:-0}"
  failed="${failed:-0}"

  echo ""
  echo "[vitest-cloud] Succeeded tasks: $succeeded"
  echo "[vitest-cloud] Failed tasks: $failed"

  if [ "$failed" -gt 0 ] 2>/dev/null; then
    echo "[vitest-cloud] Some tasks failed."
    exit 1
  fi

  echo "[vitest-cloud] All tasks completed successfully."
}

# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------
cmd_logs() {
  local execution_id
  execution_id=$(gcloud run jobs executions list $(gcloud_flags) --job="$GCP_JOB" --sort-by="~metadata.creationTimestamp" --format="value(name)" --limit=1)
  if [ -z "$execution_id" ]; then
    echo "[vitest-cloud] No executions found for job $GCP_JOB"
    exit 1
  fi
  gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" "$@"
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
SUBCOMMAND="${1:-run}"
case "$SUBCOMMAND" in
  run)
    if [ $# -gt 0 ]; then shift; fi
    cmd_run "$@"
    ;;
  build)
    shift
    cmd_build "$@"
    ;;
  push)
    shift
    cmd_push "$@"
    ;;
  logs)
    shift
    cmd_logs "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    # If first arg is a flag, treat as `run` with that flag
    cmd_run "$SUBCOMMAND" "${@:2}"
    ;;
esac
