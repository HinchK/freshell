# Cloud Vitest + Cloud Build Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Move Vitest unit/server test suites and Docker image builds to Google Cloud, reducing validation pipeline wall time from ~5 min to ~2 min.

**Architecture:** The existing Docker image (built for Playwright e2e) already contains Node.js, all npm deps, the Rust server binary, and dist artifacts — everything Vitest needs. We add a `TEST_MODE=vitest` branch to the entrypoint that runs `npx vitest run --shard=I/N` for both default and server configs. A new `scripts/vitest-cloud.sh` wrapper (modeled on `scripts/e2e-cloud.sh`) dispatches to Cloud Run Jobs with `TEST_MODE=vitest`. `scripts/run-standard-tests.ts` gets an early-return dispatch when `FRESHELL_VITEST_BACKEND=cloud`. For Docker builds, a `cloudbuild.yaml` + `.gcloudignore` configures Google Cloud Build with layer caching, and both wrapper scripts gain a `--cloud-build` flag.

**Tech Stack:** Google Cloud Run Jobs, Google Cloud Build, Artifact Registry, Vitest `--shard`, bash, TypeScript

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions
- Never use broad kill patterns (`pkill -f ...`)
- The self-hosted Freshell server (port 3001) must never be restarted without explicit "APPROVED"
- Docker image is shared between e2e and vitest — changes to the Dockerfile affect both
- `FRESHELL_VITEST_BACKEND` env var: unset or `"local"` = local (safe default), `"cloud"` = Cloud Run Jobs
- `FRESHELL_E2E_BACKEND` env var: already exists for e2e; separate from vitest backend
- GCP coordinates: account `dan@danshapiro.com`, project `misc-puttering-project`, region `us-west1`, repo `freshell-e2e`
- Cloud Run Job names: `freshell-e2e` (existing, e2e), `freshell-vitest` (new, vitest)
- Docker image: `us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:latest` (shared)
- Existing test scripts live in `scripts/test/cloud-*.test.sh` and follow a bash integration-test pattern

## Requirements

- **R1 — Cloud Vitest:** Vitest default + server suites run on Cloud Run Jobs with 4-way sharding, completing in <3 min wall time
- **R2 — Cloud Build:** Docker image builds on Google Cloud Build with layer caching, completing in <15 min cold / <5 min warm
- **R3 — Backend selection:** `FRESHELL_VITEST_BACKEND` env var controls local vs cloud, mirroring the `FRESHELL_E2E_BACKEND` pattern; `--local`/`--cloud` flags override per-invocation
- **R4 — Integration:** `npm test` / `npm run check` / `npm run verify` dispatch to cloud vitest when `FRESHELL_VITEST_BACKEND=cloud`
- **R5 — Tests:** Full test coverage of new scripts, configs, and entrypoint changes, following the existing `scripts/test/cloud-*.test.sh` pattern
- **R6 — Docs:** AGENTS.md updated with cloud vitest instructions

---

### Task 1: Entrypoint vitest mode

**Requirements served:** R1

**Behavior:**
- When `TEST_MODE=vitest` env var is set, the entrypoint runs Vitest instead of Playwright
- Each Cloud Run task runs both default and server vitest configs, using `--shard=I/N` for sharding
- Shard index comes from `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT`
- If any config fails, the exit code is non-zero (but both configs still run)
- When `TEST_MODE` is unset or `playwright`, current behavior is unchanged

**Files:**
- Modify: `docker/cloud-run/entrypoint.sh` (add vitest branch at top, before playwright logic)
- Test: `scripts/test/cloud-vitest-entrypoint.test.sh`

**Interfaces:**
- Consumes: `TEST_MODE` (env var, new), `CLOUD_RUN_TASK_INDEX` (existing), `CLOUD_RUN_TASK_COUNT` (existing), `VITEST_CONFIGS` (env var, new — space-separated list of config paths, default: `"config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts"`)
- Produces: Vitest test output on stdout/stderr, exit code 0 (all pass) or 1 (any fail)

**Test cases:**
- `TEST_MODE=vitest` branch exists in entrypoint → grep finds `TEST_MODE` and `vitest`
- Entrypoint with `TEST_MODE=playwright` (or unset) → current behavior unchanged
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=1` → runs `npx vitest run` for both configs (no `--shard` flag)
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=2` → runs `npx vitest run --shard=1/2` and `--shard=2/2` for both configs
- `VITEST_CONFIGS` env var limits which configs run (e.g., only default config)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-entrypoint.test.sh` with:
- Check 1: entrypoint.sh contains `TEST_MODE` reference
- Check 2: entrypoint.sh contains `vitest` reference
- Check 3: entrypoint.sh contains `--shard` reference
- Check 4: entrypoint.sh references `VITEST_CONFIGS`
- Check 5: When `TEST_MODE` is unset, entrypoint still references playwright (unchanged behavior)
- Check 6: Docker build succeeds with the modified entrypoint (if Docker is available)
- Check 7: Running the entrypoint in a container with `TEST_MODE=vitest CLOUD_RUN_TASK_COUNT=1 VITEST_CONFIGS="config/vitest/vitest.config.ts"` and a single fast test file produces vitest output (skip if Docker unavailable)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-entrypoint.test.sh`

Expected: FAIL because `entrypoint.sh` does not contain `TEST_MODE` or `vitest` references

- [ ] **Step 3: Add the minimal production implementation**

Add to the top of `docker/cloud-run/entrypoint.sh`, after the `set -euo pipefail` and env var reads, before the playwright-specific logic:

```bash
# TEST_MODE=vitest: run Vitest instead of Playwright.
if [ "${TEST_MODE:-}" = "vitest" ]; then
  SHARD_INDEX=$((TASK_INDEX + 1))
  SHARD_COUNT="$TASK_COUNT"
  CONFIGS="${VITEST_CONFIGS:-config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts}"
  SHARD_ARG=""
  if [ "$SHARD_COUNT" -gt 1 ]; then
    SHARD_ARG="--shard=${SHARD_INDEX}/${SHARD_COUNT}"
  fi
  EXIT_CODE=0
  for config in $CONFIGS; do
    echo "[e2e-entrypoint] Running vitest: $config $SHARD_ARG"
    npx vitest run --config "$config" $SHARD_ARG || EXIT_CODE=$?
  done
  exit "$EXIT_CODE"
fi
```

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-entrypoint.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The vitest branch is a clean early-return at the top of the entrypoint. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh` (existing Dockerfile tests still pass)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/entrypoint.sh scripts/test/cloud-vitest-entrypoint.test.sh
git commit -m "feat: add TEST_MODE=vitest to cloud-run entrypoint"
```

---

### Task 2: Vitest cloud wrapper script

**Requirements served:** R1, R3

**Behavior:**
- `scripts/vitest-cloud.sh` is a standalone wrapper modeled on `scripts/e2e-cloud.sh`
- Subcommands: `run` (default), `build`, `push`, `logs`, `help`
- Backend selection: `FRESHELL_VITEST_BACKEND` env var (unset/local = local, cloud = cloud), `--local`/`--cloud` flags override
- `--shards=N` (default 4), `--timeout=DURATION` (default 30m), `--build` (force rebuild)
- `--config=default|server|all` selects which vitest configs to run (default: all)
- Cloud Run Job name: `freshell-vitest`
- Sets `TEST_MODE=vitest` and `VITEST_CONFIGS` env vars on the Cloud Run Job
- `--cloud-build` flag uses Google Cloud Build instead of local Docker build (implemented in Task 4)
- Local mode runs `npx vitest run` for both configs directly
- `build`/`push` subcommands are identical to `e2e-cloud.sh` (same Docker image)

**Files:**
- Create: `scripts/vitest-cloud.sh`
- Test: `scripts/test/cloud-vitest-wrapper.test.sh`

**Interfaces:**
- Consumes: `FRESHELL_VITEST_BACKEND` env var, `FRESHELL_GCP_ACCOUNT`/`FRESHELL_GCP_PROJECT`/`FRESHELL_GCP_REGION`/`FRESHELL_GCP_REPO` env vars (same defaults as e2e)
- Produces: Cloud Run Job execution with `TEST_MODE=vitest` env var, exit code from vitest

**Test cases:**
- Script exists and is executable
- `help` subcommand shows usage, mentions `--local`, `--cloud`, `FRESHELL_VITEST_BACKEND`, `--shards`, `--config`
- `--local` flag runs vitest locally (run a single fast test file to verify)
- Default backend (unset env var) runs locally
- `FRESHELL_VITEST_BACKEND=local` runs locally
- `--cloud` flag overrides `FRESHELL_VITEST_BACKEND=local` (does not print "Running locally")
- `npm run test:cloud -- --local` works (if npm script is added in Task 3)
- Existing `e2e-cloud.sh` tests still pass (no regression)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-wrapper.test.sh` with:
- Check 1: Script exists and is executable
- Check 2: `help` contains "usage", "run", "--local", "--cloud", "FRESHELL_VITEST_BACKEND", "--shards", "--config"
- Check 3: `--local` runs a single fast test file locally (e.g., `test/unit/lib/env.test.ts` or similar small test)
- Check 4: Default backend (unset env var) runs locally
- Check 5: `FRESHELL_VITEST_BACKEND=local` runs locally
- Check 6: `--cloud` flag does not print "Running locally"
- Check 7: `--config=default` only runs the default vitest config
- Check 8: `--config=server` only runs the server vitest config

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh`

Expected: FAIL because `scripts/vitest-cloud.sh` does not exist

- [ ] **Step 3: Add the minimal production implementation**

Create `scripts/vitest-cloud.sh` with:
- Same structure as `scripts/e2e-cloud.sh`: defaults, gcloud helpers, usage, `cmd_build`, `cmd_push`, `cmd_run`, `cmd_logs`, main dispatch
- Key differences from `e2e-cloud.sh`:
  - `GCP_JOB="freshell-vitest"` (not `freshell-e2e`)
  - `FRESHELL_VITEST_BACKEND` env var (not `FRESHELL_E2E_BACKEND`)
  - Local mode: `npx vitest run --config <config>` for each config (not `npx playwright test`)
  - Cloud mode: env-vars-file sets `TEST_MODE: "vitest"` and `VITEST_CONFIGS: "<configs>"`
  - `--config=default|server|all` flag controls which configs to run
  - Log summary greps for vitest output patterns (`Test Files`, `Tests`)
  - Default `--shards=4` (not 1)
  - Default `--timeout=30m` (not 60m)
  - `--cloud-build` flag (stubbed — full implementation in Task 4)

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review for duplication with `e2e-cloud.sh`. If `cmd_build` and `cmd_push` are identical, note for future extraction into a shared library but do not refactor now (two scripts is not enough duplication to justify the abstraction).

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-wrapper.test.sh` (existing e2e wrapper tests still pass)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add scripts/vitest-cloud.sh scripts/test/cloud-vitest-wrapper.test.sh
git commit -m "feat: add vitest-cloud.sh wrapper for Cloud Run Jobs"
```

---

### Task 3: Integration with run-standard-tests.ts + npm scripts + AGENTS.md

**Requirements served:** R3, R4, R6

**Behavior:**
- When `FRESHELL_VITEST_BACKEND=cloud`, `scripts/run-standard-tests.ts` dispatches to `scripts/vitest-cloud.sh run` instead of running vitest locally
- The dispatch happens at the top of `main()`, before any local test planning
- Forwarded args are passed through to the cloud wrapper
- New npm scripts: `test:cloud`, `test:cloud:build`
- AGENTS.md updated with cloud vitest instructions

**Files:**
- Modify: `scripts/run-standard-tests.ts` (add early dispatch in `main()`)
- Modify: `package.json` (add `test:cloud`, `test:cloud:build` scripts)
- Modify: `AGENTS.md` (add Vitest section to E2E Test Backend area)
- Test: `scripts/test/cloud-vitest-integration.test.sh`

**Interfaces:**
- Consumes: `FRESHELL_VITEST_BACKEND` env var
- Produces: Exit code from `scripts/vitest-cloud.sh run`

**Test cases:**
- `FRESHELL_VITEST_BACKEND=cloud` in `run-standard-tests.ts` → dispatches to `vitest-cloud.sh` (verify by checking that `vitest-cloud.sh run` is invoked)
- `FRESHELL_VITEST_BACKEND` unset → current behavior (local vitest)
- `FRESHELL_VITEST_BACKEND=local` → current behavior (local vitest)
- `npm run test:cloud` script exists and dispatches to `scripts/vitest-cloud.sh run`
- `npm run test:cloud:build` script exists and dispatches to `scripts/vitest-cloud.sh build`
- `npm run test:cloud -- --local` works (runs locally)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-integration.test.sh` with:
- Check 1: `scripts/run-standard-tests.ts` contains `FRESHELL_VITEST_BACKEND` reference
- Check 2: `scripts/run-standard-tests.ts` contains `vitest-cloud.sh` reference
- Check 3: `package.json` contains `test:cloud` script
- Check 4: `package.json` contains `test:cloud:build` script
- Check 5: `npm run test:cloud -- --local` runs a fast test locally
- Check 6: `AGENTS.md` mentions `FRESHELL_VITEST_BACKEND`
- Check 7: `FRESHELL_VITEST_BACKEND=local npx tsx scripts/run-standard-tests.ts --mode desktop` still runs locally (no regression)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-integration.test.sh`

Expected: FAIL because `run-standard-tests.ts` does not reference `FRESHELL_VITEST_BACKEND`, and `package.json` has no `test:cloud` script

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/run-standard-tests.ts`, add at the top of `main()`:

```typescript
if (process.env.FRESHELL_VITEST_BACKEND === 'cloud') {
  const { execFileSync } = await import('node:child_process')
  const cloudScript = resolve(repoRoot, 'scripts/vitest-cloud.sh')
  try {
    execFileSync(cloudScript, ['run', ...argv], { stdio: 'inherit', cwd: repoRoot })
    process.exit(0)
  } catch {
    process.exit(1)
  }
}
```

In `package.json`, add:
```json
"test:cloud": "bash scripts/vitest-cloud.sh run",
"test:cloud:build": "bash scripts/vitest-cloud.sh build",
```

In `AGENTS.md`, add a section under Testing explaining `FRESHELL_VITEST_BACKEND` (similar to `FRESHELL_E2E_BACKEND`).

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-integration.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The early-return dispatch is clean. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:status` (coordinator still works)

Expected: PASS (idle state, no interference)

- [ ] **Step 7: Commit the task**

```bash
git add scripts/run-standard-tests.ts package.json AGENTS.md scripts/test/cloud-vitest-integration.test.sh
git commit -m "feat: integrate cloud vitest with run-standard-tests.ts and npm scripts"
```

---

### Task 4: Cloud Build config and --cloud-build flag

**Requirements served:** R2

**Behavior:**
- `docker/cloud-run/cloudbuild.yaml` configures Google Cloud Build with:
  - `docker pull` of existing image for `--cache-from` layer caching
  - `docker build -f docker/cloud-run/Dockerfile --cache-from <image> -t <image> .`
  - `images:` field for automatic push to Artifact Registry
  - `E2_HIGHCPU_32` machine type, 200GB disk, 1h timeout
- `.gcloudignore` excludes non-build files from Cloud Build source upload
- Both `scripts/e2e-cloud.sh` and `scripts/vitest-cloud.sh` gain a `--cloud-build` flag on their `build` subcommand
- When `--cloud-build` is set, `cmd_build` uses `gcloud builds submit --config docker/cloud-run/cloudbuild.yaml .` instead of local `docker build`
- Without `--cloud-build`, `cmd_build` uses local Docker (current behavior)

**Files:**
- Create: `docker/cloud-run/cloudbuild.yaml`
- Create: `.gcloudignore`
- Modify: `scripts/e2e-cloud.sh` (add `--cloud-build` flag to `cmd_build`)
- Modify: `scripts/vitest-cloud.sh` (add `--cloud-build` flag to `cmd_build`)
- Test: `scripts/test/cloud-build.test.sh`

**Interfaces:**
- Consumes: `cloudbuild.yaml`, `.gcloudignore`, `--cloud-build` flag
- Produces: Docker image in Artifact Registry (built by Cloud Build)

**Test cases:**
- `docker/cloud-run/cloudbuild.yaml` exists and is valid YAML
- `cloudbuild.yaml` references the correct Dockerfile path (`docker/cloud-run/Dockerfile`)
- `cloudbuild.yaml` references the correct image URL
- `cloudbuild.yaml` uses `E2_HIGHCPU_32` machine type
- `.gcloudignore` exists and excludes `.git`, `node_modules`, `target`, `dist`
- `e2e-cloud.sh help` mentions `--cloud-build`
- `vitest-cloud.sh help` mentions `--cloud-build`
- `e2e-cloud.sh build --cloud-build` would invoke `gcloud builds submit` (verify by checking output contains "gcloud builds" when run with `--cloud-build`, without actually submitting)
- `e2e-cloud.sh build` (without `--cloud-build`) still uses local Docker

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-build.test.sh` with:
- Check 1: `docker/cloud-run/cloudbuild.yaml` exists
- Check 2: `cloudbuild.yaml` is valid YAML (parse with `python3 -c "import yaml; yaml.safe_load(open('...'))"`)
- Check 3: `cloudbuild.yaml` contains `docker/cloud-run/Dockerfile`
- Check 4: `cloudbuild.yaml` contains the Artifact Registry image URL
- Check 5: `cloudbuild.yaml` contains `E2_HIGHCPU_32`
- Check 6: `.gcloudignore` exists
- Check 7: `.gcloudignore` excludes `.git`, `node_modules`, `target`, `dist`
- Check 8: `e2e-cloud.sh help` contains `--cloud-build`
- Check 9: `vitest-cloud.sh help` contains `--cloud-build`
- Check 10: `e2e-cloud.sh build --cloud-build --dry-run` outputs "gcloud builds" (dry-run flag prevents actual submission)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: FAIL because `cloudbuild.yaml` and `.gcloudignore` don't exist, and `--cloud-build` flag isn't implemented

- [ ] **Step 3: Add the minimal production implementation**

Create `docker/cloud-run/cloudbuild.yaml`:
```yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    entrypoint: 'bash'
    args: ['-c', 'docker pull ${_IMAGE} || exit 0']
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'build'
      - '-f'
      - 'docker/cloud-run/Dockerfile'
      - '-t'
      - '${_IMAGE}'
      - '--cache-from'
      - '${_IMAGE}'
      - '.'
images:
  - '${_IMAGE}'
options:
  machineType: 'E2_HIGHCPU_32'
  diskSizeGb: 200
  timeout: '3600s'
substitutions:
  _IMAGE: 'us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:latest'
```

Create `.gcloudignore` (same exclusions as `.dockerignore` plus `.worktrees/`).

In `scripts/e2e-cloud.sh`, modify `cmd_build` to accept `--cloud-build` flag. When set, use `gcloud builds submit --config docker/cloud-run/cloudbuild.yaml .` instead of local `docker build`.

In `scripts/vitest-cloud.sh`, same modification to `cmd_build`.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `--cloud-build` flag logic is a simple if/else in `cmd_build`. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-wrapper.test.sh` (e2e wrapper still works)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/cloudbuild.yaml .gcloudignore scripts/e2e-cloud.sh scripts/vitest-cloud.sh scripts/test/cloud-build.test.sh
git commit -m "feat: add Cloud Build config and --cloud-build flag"
```

---

### Task 5: End-to-end cloud validation

**Requirements served:** R1, R2, R3

**Behavior:**
- Run cloud vitest on Cloud Run Jobs and verify all tests pass
- Run cloud build on Google Cloud Build and verify the image builds successfully
- Record actual timings and cost estimates

**Files:**
- No new files (validation task)
- Record results in `<logs-dir>/reports/cloud-validation.md`

**Test cases:**
- `scripts/vitest-cloud.sh run --cloud --shards=4` → all vitest tests pass (4/4 tasks succeeded)
- `scripts/e2e-cloud.sh build --cloud-build` → Docker image builds and pushes successfully
- Cloud vitest wall time < 3 min
- Cloud build wall time < 15 min (cold) or < 5 min (warm)

- [ ] **Step 1: Build and push the Docker image (if needed)**

Run: `scripts/e2e-cloud.sh build`

Expected: Docker image builds and pushes to Artifact Registry

- [ ] **Step 2: Run cloud vitest**

Run: `scripts/vitest-cloud.sh run --cloud --shards=4 --timeout=30m`

Expected: All 4 tasks succeed, vitest tests pass

- [ ] **Step 3: Run cloud build**

Run: `scripts/e2e-cloud.sh build --cloud-build`

Expected: Cloud Build succeeds, image pushed to Artifact Registry

- [ ] **Step 4: Record results**

Write results to `<logs-dir>/reports/cloud-validation.md` with:
- Cloud vitest: shard count, wall time, per-shard test counts, cost estimate
- Cloud build: wall time, cache hit/miss, cost estimate
- Any issues encountered

- [ ] **Step 5: Commit the validation report**

```bash
git add <logs-dir>/reports/cloud-validation.md
git commit -m "docs: cloud vitest and cloud build validation results"
```

Note: The validation report is in the logs directory (outside the worktree), so this commit may not be needed. If so, skip the commit.
