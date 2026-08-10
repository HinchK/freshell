#!/usr/bin/env bash
# e2e-cloud.sh — Cloud Run Jobs wrapper for Playwright e2e tests.
#
# Usage:
#   scripts/e2e-cloud.sh [subcommand] [flags] [playwright-args...]
#
# Subcommands:
#   run       (default) Run e2e tests locally or on Cloud Run Jobs
#   build     Build and push the Docker image to Artifact Registry
#   push      Push an already-built image to Artifact Registry
#   logs      Fetch logs from the latest Cloud Run Job execution
#   help      Show this help message
#
# Backend selection:
#   The FRESHELL_E2E_BACKEND env var controls where tests run by default:
#     - "local"  (default if unset): run locally via Playwright
#     - "cloud":                run on Google Cloud Run Jobs
#   Override at invocation time with --local or --cloud.
#
# Flags:
#   --local           Run locally (overrides FRESHELL_E2E_BACKEND)
#   --cloud           Run on Cloud Run (overrides FRESHELL_E2E_BACKEND)
#   --build           Force image rebuild + push before running
#   --shards=N        Number of parallel Cloud Run tasks (default: 1)
#   --timeout=DURATION Cloud Run task timeout (default: 60m)
#   --grep=PATTERN    Pass --grep=PATTERN to Playwright
#   --project=NAME    Pass --project=NAME to Playwright
#   --account=EMAIL   GCP account (default: FRESHELL_GCP_ACCOUNT env or dan@danshapiro.com)
#   --project-id=ID   GCP project (default: FRESHELL_GCP_PROJECT env or misc-puttering-project)
#   --region=REGION   GCP region (default: FRESHELL_GCP_REGION env or us-west1)
#
# Examples:
#   scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts
#   scripts/e2e-cloud.sh run --project=chromium --reporter=line
#   scripts/e2e-cloud.sh run --shards=4 --project=chromium
#   scripts/e2e-cloud.sh run --shards=4 --timeout=30m --project=chromium
#   scripts/e2e-cloud.sh build
#   scripts/e2e-cloud.sh help
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-dan@danshapiro.com}"
GCP_PROJECT="${FRESHELL_GCP_PROJECT:-misc-puttering-project}"
GCP_REGION="${FRESHELL_GCP_REGION:-us-west1}"
GCP_REPO="${FRESHELL_GCP_REPO:-freshell-e2e}"
GCP_JOB="${FRESHELL_GCP_JOB:-freshell-e2e}"

IMAGE_NAME="freshell-e2e"
IMAGE_LOCAL="${IMAGE_NAME}:latest"
IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Commit-addressed image tag (wrap-review r3): a cloud run must execute the
# code at the CURRENT HEAD — with only a mutable :latest tag, `run` would
# happily execute whatever source was last pushed and the "cloud e2e gate"
# could pass against STALE code. `:latest` is still built/pushed (human
# convenience pointer + layer-cache anchor) but the run path never uses it.
# A dirty tree gets a non-addressable `-dirty` tag so a build of uncommitted
# code can never masquerade as the clean commit (untracked files count as
# dirty — the image bakes the working tree).
image_tag_for_head() {
  local sha
  sha="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    sha="${sha}-dirty"
  fi
  echo "$sha"
}

# Ensure gcloud's bin dir is on PATH (for docker-credential-gcloud used by
# Docker when pushing to Artifact Registry). Guarded: local runs, `help`,
# and machines without gcloud must get past this section — a failing
# `gcloud info` inside a bare assignment's command substitution would trip
# `set -e` before ANY subcommand dispatch (a silent 127 with stderr
# suppressed). Only the cloud paths below actually require gcloud.
GCLOUD_SDK_ROOT=""
if command -v gcloud >/dev/null 2>&1; then
  GCLOUD_SDK_ROOT="$(gcloud info --format="value(installation.sdk_root)" 2>/dev/null || true)"
fi
if [ -n "$GCLOUD_SDK_ROOT" ] && [ -d "$GCLOUD_SDK_ROOT/bin" ] && ! echo "$PATH" | grep -q "$GCLOUD_SDK_ROOT/bin"; then
  export PATH="$GCLOUD_SDK_ROOT/bin:$PATH"
fi

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
Usage: scripts/e2e-cloud.sh [subcommand] [flags] [playwright-args...]

Subcommands:
  run       (default) Run e2e tests locally or on Cloud Run Jobs
  build     Build and push the Docker image to Artifact Registry
  push      Push an already-built image to Artifact Registry
  logs      Fetch logs from the latest Cloud Run Job execution
  help      Show this help message

Flags:
  --local           Run locally (overrides FRESHELL_E2E_BACKEND)
  --cloud           Run on Cloud Run (overrides FRESHELL_E2E_BACKEND)
  --build           Force image rebuild + push before running
  --shards=N        Number of parallel Cloud Run tasks (default: 1)
  --timeout=DURATION Cloud Run task timeout (default: 60m)
  --grep=PATTERN    Pass --grep=PATTERN to Playwright
  --project=NAME    Pass --project=NAME to Playwright
  --account=EMAIL   GCP account (default: dan@danshapiro.com)
  --project-id=ID   GCP project (default: misc-puttering-project)
  --region=REGION   GCP region (default: us-west1)

Environment:
  FRESHELL_E2E_BACKEND  "local" (default) or "cloud"

Examples:
  scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts
  scripts/e2e-cloud.sh run --cloud --project=chromium --reporter=line
  scripts/e2e-cloud.sh run --cloud --shards=4 --project=chromium
  scripts/e2e-cloud.sh run --cloud --shards=4 --timeout=30m --project=chromium
  scripts/e2e-cloud.sh build
  scripts/e2e-cloud.sh help
EOF
}

# ---------------------------------------------------------------------------
# Subcommand: build
# ---------------------------------------------------------------------------
cmd_build() {
  local tag
  tag="$(image_tag_for_head)"
  echo "[e2e-cloud] Building Docker image (tag: $tag)..."
  docker build -f "$ROOT/docker/cloud-run/Dockerfile" \
    -t "$IMAGE_LOCAL" \
    -t "${IMAGE_NAME}:${tag}" \
    "$ROOT"
  echo "[e2e-cloud] Image built: $IMAGE_LOCAL (${IMAGE_NAME}:${tag})"
  cmd_push
}

# ---------------------------------------------------------------------------
# Subcommand: push
# ---------------------------------------------------------------------------
cmd_push() {
  echo "[e2e-cloud] Pushing to Artifact Registry..."

  # Ensure the Artifact Registry repo exists
  if ! gcloud artifacts repositories describe $(gcloud_artifacts_flags) "$GCP_REPO" &>/dev/null; then
    echo "[e2e-cloud] Creating Artifact Registry repository: $GCP_REPO"
    gcloud artifacts repositories create $(gcloud_artifacts_flags) "$GCP_REPO" \
      --repository-format=docker || true
  fi

  # Authenticate Docker to Artifact Registry using an access token.
  # We can't rely on the docker-credential-gcloud helper being on PATH.
  gcloud auth print-access-token --account="$GCP_ACCOUNT" | \
    docker login -u oauth2accesstoken --password-stdin \
      "https://${GCP_REGION}-docker.pkg.dev"

  # Push BOTH refs explicitly: the commit-addressed tag (what `run`
  # resolves) and :latest (human convenience pointer + cache anchor; `run`
  # never consumes it). Never read the mutable $IMAGE_REMOTE global here —
  # the standalone `push` subcommand path still has it at :latest while the
  # run path has repointed it at the HEAD tag.
  local tag remote_base
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"
  docker tag "$IMAGE_LOCAL" "${remote_base}:latest"
  docker tag "$IMAGE_LOCAL" "${remote_base}:${tag}"
  docker push "${remote_base}:${tag}"
  docker push "${remote_base}:latest"
  echo "[e2e-cloud] Pushed: ${remote_base}:${tag} (+ ${remote_base}:latest)"
}

# ---------------------------------------------------------------------------
# Subcommand: run
# ---------------------------------------------------------------------------
cmd_run() {
  local local_mode=false
  local cloud_mode=false
  local force_build=false
  local shards=1
  local timeout="60m"
  local -a pw_args=()

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
      --shards=*)
        shards="${1#*=}"
        shift
        ;;
      --timeout=*)
        timeout="${1#*=}"
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
      --grep=*)
        pw_args+=("$1")
        shift
        ;;
      --project=*)
        pw_args+=("$1")
        shift
        ;;
      *)
        pw_args+=("$1")
        shift
        ;;
    esac
  done

  # Normalize split-form Playwright value flags ("--grep foo" ->
  # "--grep=foo") BEFORE either backend consumes pw_args. The cloud path
  # serializes the args one per line and the container entrypoint
  # classifies entries by shape (dash-prefixed => flag, else positional
  # spec filter), which is only correct when every value-carrying flag is
  # a SINGLE token: a split-form value would be reclassified as a spec
  # filter and silently REORDERED behind the remaining flags
  # ("--project chromium --grep 'auth modal'" became
  # "--project --grep chromium 'auth modal'"). Playwright binds =form
  # identically to split form, so local runs are unaffected. Only the
  # documented value-taking flags are rewritten; boolean switches and the
  # optional-value --update-snapshots are never split-form here.
  local -a value_flags=(--grep --grep-invert --project --reporter --retries --workers --timeout --global-timeout --max-failures --repeat-each --output)
  local -a normalized=()
  local i arg vf matched
  for ((i = 0; i < ${#pw_args[@]}; i++)); do
    arg="${pw_args[i]}"
    matched=false
    for vf in "${value_flags[@]}"; do
      if [ "$arg" = "$vf" ] && [ $((i + 1)) -lt ${#pw_args[@]} ]; then
        normalized+=("$vf=${pw_args[i + 1]}")
        i=$((i + 1))
        matched=true
        break
      fi
    done
    if [ "$matched" = false ]; then
      normalized+=("$arg")
    fi
  done
  pw_args=("${normalized[@]}")

  # Resolve backend: explicit flags override env var; env var defaults to local.
  if $cloud_mode; then
    local_mode=false
  elif $local_mode; then
    : # local_mode already true
  elif [ "${FRESHELL_E2E_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
  else
    local_mode=true
  fi

  if $local_mode; then
    echo "[e2e-cloud] Running locally..."
    cd "$ROOT"
    exec npx playwright test \
      --config test/e2e-browser/playwright.config.ts \
      "${pw_args[@]}"
  fi

  # Recompute the remote ref with potentially overridden GCP settings —
  # COMMIT-ADDRESSED, never mutable :latest (see image_tag_for_head): the
  # job must run THIS HEAD's code or fail loudly, never pass on a stale
  # image.
  local image_tag
  image_tag="$(image_tag_for_head)"
  IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:${image_tag}"

  # Cloud mode
  if $force_build; then
    cmd_build
  fi

  # Ensure the image FOR THIS HEAD exists in the remote registry
  if ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" &>/dev/null 2>&1; then
    echo "[e2e-cloud] No remote image for HEAD ($image_tag), building and pushing..."
    cmd_build
  fi

  echo "[e2e-cloud] Running on Cloud Run Jobs..."
  echo "[e2e-cloud]   Image:   $IMAGE_REMOTE"
  echo "[e2e-cloud]   Shards:  $shards"
  echo "[e2e-cloud]   Timeout: $timeout"
  echo "[e2e-cloud]   Args:    ${pw_args[*]}"

  # Build a YAML env-vars file for the Cloud Run Job.
  # We use --env-vars-file (YAML) instead of --set-env-vars because
  # --set-env-vars splits on spaces, breaking PLAYWRIGHT_ARGS.
  # PLAYWRIGHT_ARGS is NEWLINE-delimited (one arg per line, YAML literal
  # block scalar) so args CONTAINING spaces (e.g. --grep "foo bar") or YAML
  # metacharacters survive verbatim — a space-joined quoted scalar would be
  # re-split on spaces by the entrypoint and quotes could corrupt the YAML.
  # Note: CLOUD_RUN_TASK_COUNT and CLOUD_RUN_TASK_INDEX are reserved env vars
  # set automatically by Cloud Run when --tasks > 1 — do NOT set them here.
  local env_file
  env_file=$(mktemp /tmp/e2e-env-vars.XXXXXX.yaml)
  if [ "${#pw_args[@]}" -gt 0 ]; then
    {
      echo "PLAYWRIGHT_ARGS: |-"
      printf '  %s\n' "${pw_args[@]}"
    } > "$env_file"
  else
    echo 'PLAYWRIGHT_ARGS: ""' > "$env_file"
  fi

  # Create or update the Cloud Run Job (create fails if it already exists,
  # fall back to update).
  gcloud run jobs create $(gcloud_flags) "$GCP_JOB" \
    --image="$IMAGE_REMOTE" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --max-retries=0 \
    --env-vars-file="$env_file" \
    --memory=2Gi \
    --cpu=2 \
    2>/dev/null || \
  gcloud run jobs update $(gcloud_flags) "$GCP_JOB" \
    --image="$IMAGE_REMOTE" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --max-retries=0 \
    --env-vars-file="$env_file" \
    --memory=2Gi \
    --cpu=2

  rm -f "$env_file"

  # Execute the job and wait for completion
  echo "[e2e-cloud] Executing Cloud Run Job..."
  gcloud run jobs execute $(gcloud_flags) "$GCP_JOB" --wait

  # Get the latest execution name
  local execution_id
  execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
    --job="$GCP_JOB" \
    --sort-by="~metadata.creationTimestamp" \
    --format="value(name)" \
    --limit=1)

  # Fetch logs (requires beta track for logs read).
  # Capture to a variable so we can print the full output AND extract a
  # per-shard summary, even when some shards fail.
  echo "[e2e-cloud] Fetching logs..."
  local log_output
  log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true)

  # Print full log output from ALL shards.
  echo "$log_output"

  # Extract and display a per-shard summary from the Playwright output.
  # Each shard's entrypoint prints "Shard X/Y assignment" and Playwright's
  # line reporter prints a final "  N passed (duration)" or
  # "  N failed, M passed (duration)" summary line.
  echo ""
  echo "[e2e-cloud] Per-shard summary:"
  echo "$log_output" | grep -E '(\[e2e-entrypoint\] Shard [0-9]+/[0-9]+ assignment|^\s+[0-9]+ (passed|failed))' || true

  # Check execution status
  local succeeded
  local failed
  succeeded=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
    --format="value(status.succeededCount)" 2>/dev/null || echo "0")
  failed=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
    --format="value(status.failedCount)" 2>/dev/null || echo "0")

  # Normalize empty/null to 0
  succeeded="${succeeded:-0}"
  failed="${failed:-0}"

  echo ""
  echo "[e2e-cloud] Succeeded tasks: $succeeded"
  echo "[e2e-cloud] Failed tasks: $failed"

  if [ "$failed" -gt 0 ] 2>/dev/null; then
    echo "[e2e-cloud] Some tasks failed."
    exit 1
  fi

  echo "[e2e-cloud] All tasks completed successfully."
}

# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------
cmd_logs() {
  # `logs read` takes an EXECUTION name, not the job name — resolve the
  # latest execution exactly like cmd_run does before fetching its logs.
  local execution_id
  execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
    --job="$GCP_JOB" \
    --sort-by="~metadata.creationTimestamp" \
    --format="value(name)" \
    --limit=1)
  if [ -z "$execution_id" ]; then
    echo "[e2e-cloud] No executions found for job $GCP_JOB" >&2
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
    shift
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
