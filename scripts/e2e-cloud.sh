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
#   --local-build     Build locally with Docker instead of Cloud Build
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
# A dirty tree gets a non-addressable `-dirty` SENTINEL tag so a build of
# uncommitted code can never masquerade as the clean commit (untracked files
# count as dirty — the image bakes the working tree); `-dirty` tags are not
# content-addressable, so the run path ALWAYS rebuilds on a dirty tree
# instead of reusing a stale `-dirty` image (wrap-review r4).
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

# Unique per-run job. `gcloud run jobs execute` snapshots the job's CURRENT
# template, so sharing one job across runs lets a concurrent run's job update
# swap the image/config of an in-flight run, and forces "find my execution"
# to fall back to "the latest execution of the shared job" — which may be
# another run's results. Every run therefore creates its own job
# (<prefix>-<imagetag>-<random6>), executes it, and deletes it on every exit
# path (success, failure, SIGINT/SIGTERM). FRESHELL_GCP_JOB is the prefix.
unique_job_name() {
  local rand
  rand=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)
  printf '%s-%s-%s' "$GCP_JOB" "$(image_tag_for_head)" "$rand"
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
  --local-build     Build locally with Docker instead of Cloud Build
  --shards=N        Number of parallel Cloud Run tasks (default: 1)
  --timeout=DURATION Cloud Run task timeout (default: 60m)
  --grep=PATTERN    Pass --grep=PATTERN to Playwright
  --project=NAME    Pass --project=NAME to Playwright
  --account=EMAIL   GCP account (default: dan@danshapiro.com)
  --project-id=ID   GCP project (default: misc-puttering-project)
  --region=REGION   GCP region (default: us-west1)

Environment:
  FRESHELL_E2E_BACKEND  "local" (default) or "cloud"
  FRESHELL_GCP_JOB      Cloud Run job-name prefix (default: freshell-e2e)

Cloud job lifecycle: each cloud run creates its OWN unique job
(<prefix>-<commit>[-dirty]-<random>), executes it, and deletes it
afterwards — never a shared job — so concurrent runs cannot overwrite each
other's image/config or read each other's results. The 'logs' subcommand
reads the legacy shared job only; per-run logs are printed in full during
the run and remain in Cloud Logging afterwards.

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

  # Content-addressed tag (see image_tag_for_head): the only tag `run` pins.
  local tag remote_base
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"

  if $local_build; then
    echo "[e2e-cloud] Building Docker image locally (tag: $tag)..."
    docker build -f "$ROOT/docker/cloud-run/Dockerfile" \
      -t "$IMAGE_LOCAL" \
      -t "${IMAGE_NAME}:${tag}" \
      "$ROOT"
    echo "[e2e-cloud] Image built: $IMAGE_LOCAL (${IMAGE_NAME}:${tag})"
    cmd_push
  else
    echo "[e2e-cloud] Building Docker image via Cloud Build (tag: $tag)..."
    gcloud builds submit \
      --config "$ROOT/docker/cloud-run/cloudbuild.yaml" \
      --account="$GCP_ACCOUNT" \
      --project="$GCP_PROJECT" \
      --substitutions=_IMAGE="${remote_base}:${tag}" \
      "$ROOT"
    echo "[e2e-cloud] Cloud Build complete: ${remote_base}:${tag}"
  fi
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
  local local_build_flag=false
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
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  elif [[ "$image_tag" == *-dirty ]]; then
    # A dirty tree has NO addressable content: a stored `<sha>-dirty` tag can
    # only ever name whatever the FIRST dirty build contained, so reusing it
    # would silently run stale source (wrap-review r4). Always rebuild+push;
    # docker's layer cache keeps an unchanged tree cheap.
    echo "[e2e-cloud] Dirty worktree — rebuilding the image (uncommitted tree has no addressable tag)..."
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  elif ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" &>/dev/null 2>&1; then
    # Clean tree: the HEAD tag genuinely addresses this image's content.
    echo "[e2e-cloud] No remote image for HEAD ($image_tag), building and pushing..."
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  fi

  echo "[e2e-cloud] Running on Cloud Run Jobs..."
  echo "[e2e-cloud]   Image:   $IMAGE_REMOTE"
  echo "[e2e-cloud]   Shards:  $shards"
  echo "[e2e-cloud]   Timeout: $timeout"
  echo "[e2e-cloud]   Args:    ${pw_args[*]}"

  # Build a YAML env-vars file for this run's Cloud Run Job.
  # We use --env-vars-file (YAML) instead of --set-env-vars because
  # --set-env-vars splits on spaces, breaking PLAYWRIGHT_ARGS.
  # PLAYWRIGHT_ARGS is NEWLINE-delimited (one arg per line, YAML literal
  # block scalar) so args CONTAINING spaces (e.g. --grep "foo bar") or YAML
  # metacharacters survive verbatim — a space-joined quoted scalar would be
  # re-split on spaces by the entrypoint and quotes could corrupt the YAML.
  # Note: CLOUD_RUN_TASK_COUNT and CLOUD_RUN_TASK_INDEX are reserved env vars
  # set automatically by Cloud Run when --tasks > 1 — do NOT set them here.
  RUN_ENV_FILE=$(mktemp /tmp/e2e-env-vars.XXXXXX.yaml)
  if [ "${#pw_args[@]}" -gt 0 ]; then
    {
      echo "PLAYWRIGHT_ARGS: |-"
      printf '  %s\n' "${pw_args[@]}"
    } > "$RUN_ENV_FILE"
  else
    echo 'PLAYWRIGHT_ARGS: ""' > "$RUN_ENV_FILE"
  fi

  # Create THIS run's own unique job (see unique_job_name). Create-only: a
  # name collision would mean the job is not unique to this run, so fail
  # rather than fall back to mutating a shared job. The job carries all
  # per-run state (image, tasks, timeout, arg env file) — safe to store on
  # the job precisely because no other run ever touches it. Delete the job
  # (and temp env file) on EVERY exit path: success, failure, Ctrl-C/TERM.
  RUN_JOB_NAME="$(unique_job_name)"
  if ! [[ "$RUN_JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}$ ]]; then
    echo "[e2e-cloud] ERROR: invalid job name '$RUN_JOB_NAME' (check FRESHELL_GCP_JOB prefix)" >&2
    rm -f "$RUN_ENV_FILE"
    exit 1
  fi
  echo "[e2e-cloud]   Job:     $RUN_JOB_NAME"
  cleanup_run_job() {
    if [ -n "${RUN_JOB_NAME:-}" ]; then
      gcloud run jobs delete $(gcloud_flags) "$RUN_JOB_NAME" --quiet >/dev/null 2>&1 || true
    fi
    if [ -n "${RUN_ENV_FILE:-}" ]; then
      rm -f "$RUN_ENV_FILE"
    fi
  }
  trap cleanup_run_job EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  gcloud run jobs create $(gcloud_flags) "$RUN_JOB_NAME" \
    --image="$IMAGE_REMOTE" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --max-retries=0 \
    --env-vars-file="$RUN_ENV_FILE" \
    --memory=2Gi \
    --cpu=2

  # Execute this run's job and wait for completion, capturing the exit
  # status: an execute failure (quota, permissions, template error) MAY NOT
  # masquerade as a test outcome.
  echo "[e2e-cloud] Executing Cloud Run Job..."
  local execute_output
  local execute_exit=0
  local execution_id=""
  execute_output=$(gcloud run jobs execute $(gcloud_flags) "$RUN_JOB_NAME" --wait 2>&1) || execute_exit=$?
  echo "$execute_output"

  # Extract the execution ID from the execute output. gcloud prints
  # `Execution [NAME] has successfully completed.` — brackets are literal and,
  # on color-capable captures, the name is wrapped in ANSI SGR codes — so strip
  # escapes and allow the bracket form. (A bare `Execution \K[^ ]+` captured
  # the bracket+escapes; downstream describe/logs then addressed a nonexistent
  # execution and the `|| echo 0` masking below reported succeeded=0 forever.)
  execution_id=$(echo "$execute_output" \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -oP 'Execution \[?\K[A-Za-z0-9][A-Za-z0-9-]*' \
    | head -1 || true)
  if [ -z "$execution_id" ]; then
    # Fallback: list executions of THIS run's own job only — attribution-safe
    # because no other run ever creates executions under it.
    echo "[e2e-cloud] WARNING: could not capture execution ID, falling back to listing this run's job"
    execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
      --job="$RUN_JOB_NAME" \
      --sort-by="~metadata.creationTimestamp" \
      --format="value(name)" \
      --limit=1 || true)
  fi

  if [ "$execute_exit" -ne 0 ]; then
    echo "[e2e-cloud] Cloud Run Job execution failed (exit code $execute_exit)."
    if [ -n "$execution_id" ]; then
      echo "[e2e-cloud] Fetching logs..."
      gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true
    fi
    exit 1
  fi

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

  # Check execution status — transient describe errors right after
  # `execute --wait` are a real flake class, so retry briefly; a PERMANENT
  # query failure must fail the run, never read as succeeded=0/failed=0.
  query_count() {
    local field="$1" val attempt
    for attempt in 1 2 3 4 5; do
      if val=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
        --format="value($field)" 2>/dev/null); then
        echo "${val:-0}"
        return 0
      fi
      sleep 3
    done
    return 1
  }
  local succeeded
  local failed
  if ! succeeded=$(query_count status.succeededCount); then
    echo "[e2e-cloud] ERROR: failed to query execution status"
    exit 1
  fi
  if ! failed=$(query_count status.failedCount); then
    echo "[e2e-cloud] ERROR: failed to query execution status"
    exit 1
  fi

  echo ""
  echo "[e2e-cloud] Succeeded tasks: $succeeded"
  echo "[e2e-cloud] Failed tasks: $failed"

  if [ "$failed" -gt 0 ] 2>/dev/null; then
    echo "[e2e-cloud] Some tasks failed."
    exit 1
  fi

  # Zero failures is not success: require every requested task to have
  # succeeded (a cancelled/preempted task yields succeeded=0, failed=0 — and
  # ran zero tests).
  if [ "$succeeded" != "$shards" ]; then
    echo "[e2e-cloud] ERROR: expected $shards succeeded task(s), got $succeeded."
    exit 1
  fi

  echo "[e2e-cloud] All tasks completed successfully."
}

# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------
cmd_logs() {
  # `logs read` takes an EXECUTION name, not the job name. NOTE: cloud runs
  # now use unique per-run jobs that are deleted when the run ends — this
  # legacy lookup only helps for executions of the old shared job. Per-run
  # logs are printed in full during the run and remain queryable in Cloud
  # Logging by job/execution name afterwards.
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
