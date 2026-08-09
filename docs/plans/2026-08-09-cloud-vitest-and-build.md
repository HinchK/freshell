# Cloud Vitest + Cloud Build Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Move Vitest unit/server test suites and Docker image builds to Google Cloud, reducing validation pipeline wall time from ~5 min to ~2 min.

**Architecture:** The existing Docker image (built for Playwright e2e) already contains Node.js, all npm deps, the Rust server binary, and dist artifacts — everything Vitest needs. We add a `TEST_MODE=vitest` branch to the entrypoint that runs `npx vitest run --shard=I/N` for both default and server configs. A new `scripts/vitest-cloud.sh` wrapper (modeled on `scripts/e2e-cloud.sh`) dispatches to Cloud Run Jobs with `TEST_MODE=vitest`. `scripts/run-standard-tests.ts` gets an early-return dispatch when `FRESHELL_VITEST_BACKEND=cloud` that runs only the client+server stages in the cloud, then runs the electron stage locally. For Docker builds, a `cloudbuild.yaml` + `.gcloudignore` configures Google Cloud Build with layer caching. Cloud Build is the **default** build path (the original request says "so the image builds in the cloud instead of locally"); `--local-build` opts back into local Docker.

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
- `.dockerignore` currently excludes `docs/` and `*.md`. The server Vitest suite includes `test/integration/server/test-coordinator.test.ts` which reads `AGENTS.md` and `docs/skills/testing.md`. These files must be present in the Docker image.
- The existing `scripts/run-standard-tests.ts` runs three suites: client (default config), server (server config), and electron (electron config). Cloud dispatch must not silently drop the electron stage.
- The logs directory for this run is: `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-vitest-and-build`

## Requirements

- **R1 — Cloud Vitest:** Vitest default + server suites run on Cloud Run Jobs with 4-way sharding, completing in <3 min wall time
- **R2 — Cloud Build:** Docker image builds on Google Cloud Build (as the default build path, not opt-in), completing in <15 min cold / <5 min warm
- **R3 — Backend selection:** `FRESHELL_VITEST_BACKEND` env var controls local vs cloud, mirroring the `FRESHELL_E2E_BACKEND` pattern; `--local`/`--cloud` flags override per-invocation
- **R4 — Integration:** `npm test` / `npm run check` / `npm run verify` dispatch to cloud vitest when `FRESHELL_VITEST_BACKEND=cloud`, while preserving the electron stage locally
- **R5 — Tests:** Full test coverage of new scripts, configs, and entrypoint changes, following the existing `scripts/test/cloud-*.test.sh` pattern
- **R6 — Docs:** AGENTS.md updated with cloud vitest instructions

---

### Task 1: Entrypoint vitest mode + .dockerignore fix

**Requirements served:** R1

**Behavior:**
- When `TEST_MODE=vitest` env var is set, the entrypoint runs Vitest instead of Playwright
- Each Cloud Run task runs both default and server vitest configs, using `--shard=I/N` for sharding
- Shard index comes from `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT`
- If any config fails, the exit code is non-zero (but both configs still run)
- When `TEST_MODE` is unset or `playwright`, current behavior is unchanged
- `.dockerignore` is updated to allow `AGENTS.md` and `docs/skills/testing.md` into the image (needed by `test/integration/server/test-coordinator.test.ts`)
- The entrypoint accepts `VITEST_ARGS` env var for pass-through arguments (e.g., specific test files), so the container smoke test can run a single fast test file

**Files:**
- Modify: `docker/cloud-run/entrypoint.sh` (add vitest branch at top, before playwright logic)
- Modify: `.dockerignore` (add `!AGENTS.md` and `!docs/skills/testing.md` exceptions)
- Test: `scripts/test/cloud-vitest-entrypoint.test.sh`

**Interfaces:**
- Consumes: `TEST_MODE` (env var, new), `CLOUD_RUN_TASK_INDEX` (existing), `CLOUD_RUN_TASK_COUNT` (existing), `VITEST_CONFIGS` (env var, new — space-separated list of config paths, default: `"config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts"`), `VITEST_ARGS` (env var, new — space-separated extra args passed to vitest, e.g., a test file path)
- Produces: Vitest test output on stdout/stderr, exit code 0 (all pass) or 1 (any fail)

**Test cases:**
- `TEST_MODE=vitest` branch exists in entrypoint → grep finds `TEST_MODE` and `vitest`
- Entrypoint with `TEST_MODE=playwright` (or unset) → current behavior unchanged
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=1` → runs `npx vitest run` for both configs (no `--shard` flag)
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=2` → runs `npx vitest run --shard=1/2` and `--shard=2/2` for both configs
- `VITEST_CONFIGS` env var limits which configs run (e.g., only default config)
- `VITEST_ARGS` env var passes extra args to vitest (e.g., a specific test file)
- `.dockerignore` has `!AGENTS.md` exception
- `.dockerignore` has `!docs/skills/testing.md` exception
- Docker build succeeds with the modified entrypoint and .dockerignore (if Docker is available)
- Running the entrypoint in a container with `TEST_MODE=vitest CLOUD_RUN_TASK_COUNT=1 VITEST_CONFIGS="config/vitest/vitest.config.ts" VITEST_ARGS="test/unit/lib/pane-utils.test.ts"` produces vitest output with passing tests (skip if Docker unavailable)
- Multi-shard correctness: `CLOUD_RUN_TASK_COUNT=2` with `VITEST_ARGS` pointing to two test files — shard 1 runs one file, shard 2 runs the other (verify disjoint file sets by checking output contains different test file names)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-entrypoint.test.sh` with:
- Check 1: entrypoint.sh contains `TEST_MODE` reference
- Check 2: entrypoint.sh contains `vitest` reference
- Check 3: entrypoint.sh contains `--shard` reference
- Check 4: entrypoint.sh references `VITEST_CONFIGS`
- Check 5: entrypoint.sh references `VITEST_ARGS`
- Check 6: When `TEST_MODE` is unset, entrypoint still references playwright (unchanged behavior)
- Check 7: `.dockerignore` contains `!AGENTS.md`
- Check 8: `.dockerignore` contains `!docs/skills/testing.md`
- Check 9: Docker build succeeds with the modified entrypoint (if Docker is available)
- Check 10: Running the entrypoint in a container with `TEST_MODE=vitest CLOUD_RUN_TASK_COUNT=1 VITEST_CONFIGS="config/vitest/vitest.config.ts" VITEST_ARGS="test/unit/lib/pane-utils.test.ts"` produces vitest output with passing tests (skip if Docker unavailable)
- Check 11: Multi-shard test — run two shards (`CLOUD_RUN_TASK_COUNT=2`, `CLOUD_RUN_TASK_INDEX=0` and `=1`) with `VITEST_ARGS="test/unit/lib/pane-utils.test.ts test/unit/lib/pane-snap-2d.test.ts"`, verify each shard runs a disjoint set of test files (skip if Docker unavailable)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-entrypoint.test.sh`

Expected: FAIL because `entrypoint.sh` does not contain `TEST_MODE` or `vitest` references, and `.dockerignore` lacks the `!AGENTS.md` / `!docs/skills/testing.md` exceptions

- [ ] **Step 3: Add the minimal production implementation**

Add to the top of `docker/cloud-run/entrypoint.sh`, after the `set -euo pipefail` and env var reads, before the playwright-specific logic:

```bash
# TEST_MODE=vitest: run Vitest instead of Playwright.
if [ "${TEST_MODE:-}" = "vitest" ]; then
  SHARD_INDEX=$((TASK_INDEX + 1))
  SHARD_COUNT="$TASK_COUNT"
  CONFIGS="${VITEST_CONFIGS:-config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts}"
  EXTRA_ARGS="${VITEST_ARGS:-}"
  SHARD_ARG=""
  if [ "$SHARD_COUNT" -gt 1 ]; then
    SHARD_ARG="--shard=${SHARD_INDEX}/${SHARD_COUNT}"
  fi
  EXIT_CODE=0
  for config in $CONFIGS; do
    echo "[vitest-entrypoint] Running vitest: $config $SHARD_ARG $EXTRA_ARGS"
    npx vitest run --config "$config" $SHARD_ARG $EXTRA_ARGS || EXIT_CODE=$?
  done
  exit "$EXIT_CODE"
fi
```

In `.dockerignore`, add after the `*.md` line:
```
# Exception: files needed by server-side tests
!AGENTS.md
!docs/skills/testing.md
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
git add docker/cloud-run/entrypoint.sh .dockerignore scripts/test/cloud-vitest-entrypoint.test.sh
git commit -m "feat: add TEST_MODE=vitest to cloud-run entrypoint and fix .dockerignore for server tests"
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
- Sets `TEST_MODE=vitest`, `VITEST_CONFIGS`, and `VITEST_ARGS` env vars on the Cloud Run Job
- Local mode runs `npx vitest run` for both configs directly
- `build`/`push` subcommands are identical to `e2e-cloud.sh` (same Docker image)
- Cloud tests must NOT create or update the live Cloud Run Job — tests use a fake `gcloud` on PATH to verify the intended command without touching real infrastructure
- The script file must be created with executable bit (`chmod +x`)

**Files:**
- Create: `scripts/vitest-cloud.sh` (must be `chmod +x` and committed as mode `100755`)
- Test: `scripts/test/cloud-vitest-wrapper.test.sh`

**Interfaces:**
- Consumes: `FRESHELL_VITEST_BACKEND` env var, `FRESHELL_GCP_ACCOUNT`/`FRESHELL_GCP_PROJECT`/`FRESHELL_GCP_REGION`/`FRESHELL_GCP_REPO` env vars (same defaults as e2e)
- Produces: Cloud Run Job execution with `TEST_MODE=vitest` env var, exit code from vitest

**Test cases:**
- Script exists and is executable (verify with `test -x`)
- Script has mode `100755` in git (verify with `git ls-files -s scripts/vitest-cloud.sh`)
- `help` subcommand shows usage, mentions `--local`, `--cloud`, `FRESHELL_VITEST_BACKEND`, `--shards`, `--config`
- `--local` flag runs vitest locally (run a single fast test file to verify)
- Default backend (unset env var) runs locally
- `FRESHELL_VITEST_BACKEND=local` runs locally
- `--cloud` flag with a fake `gcloud` on PATH: verify the wrapper invokes `gcloud run jobs execute` with the correct job name (`freshell-vitest`) and env vars (`TEST_MODE=vitest`, `VITEST_CONFIGS`), without touching real infrastructure
- `--config=default` sets `VITEST_CONFIGS` to only the default config
- `--config=server` sets `VITEST_CONFIGS` to only the server config
- Existing `e2e-cloud.sh` tests still pass (no regression)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-wrapper.test.sh` with:
- Check 1: Script exists and is executable (`test -x`)
- Check 2: `git ls-files -s scripts/vitest-cloud.sh` shows mode `100755`
- Check 3: `help` contains "usage", "run", "--local", "--cloud", "FRESHELL_VITEST_BACKEND", "--shards", "--config"
- Check 4: `--local` runs a single fast test file locally (e.g., `--local test/unit/lib/pane-utils.test.ts`)
- Check 5: Default backend (unset env var) runs locally
- Check 6: `FRESHELL_VITEST_BACKEND=local` runs locally
- Check 7: `--cloud` flag with fake `gcloud` — create a temporary script that logs its args and exits 0, put it on PATH, verify the wrapper calls `gcloud run jobs execute` with `freshell-vitest` and sets `TEST_MODE=vitest` in the env-vars-file. Assert the fake gcloud was called (positive assertion), not just that "Running locally" is absent.
- Check 8: `--config=default` sets `VITEST_CONFIGS` to only `config/vitest/vitest.config.ts` (verify via fake gcloud capturing the env-vars-file content)
- Check 9: `--config=server` sets `VITEST_CONFIGS` to only `config/vitest/vitest.server.config.ts` (verify via fake gcloud)

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
  - Cloud mode: env-vars-file sets `TEST_MODE: "vitest"`, `VITEST_CONFIGS: "<configs>"`, and `VITEST_ARGS: "<extra args>"`
  - `--config=default|server|all` flag controls which configs to run
  - Log summary greps for vitest output patterns (`Test Files`, `Tests`)
  - Default `--shards=4` (not 1)
  - Default `--timeout=30m` (not 60m)
  - Non-positional args (not recognized as config selectors) are forwarded as `VITEST_ARGS`
- After creating the file: `chmod +x scripts/vitest-cloud.sh`
- Verify: `git ls-files -s scripts/vitest-cloud.sh` shows `100755` (use `git update-index --chmod=+x` if needed)

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
- When `FRESHELL_VITEST_BACKEND=cloud`, `scripts/run-standard-tests.ts` dispatches client+server stages to `scripts/vitest-cloud.sh run`, then runs the electron stage locally
- The dispatch happens at the top of `main()`, before any local test planning
- The cloud dispatch runs only the client and server configs; the electron config always runs locally (it needs a display and native modules not available in the container)
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
- Produces: Exit code from `scripts/vitest-cloud.sh run` (for client+server) then local vitest exit code (for electron)

**Test cases:**
- `FRESHELL_VITEST_BACKEND=cloud` in `run-standard-tests.ts` → dispatches to `vitest-cloud.sh` for client+server, then runs electron locally (verify by injecting a fake `vitest-cloud.sh` that logs its invocation and exits 0, and checking that both the fake and the local electron run were invoked)
- `FRESHELL_VITEST_BACKEND` unset → current behavior (all three suites locally)
- `FRESHELL_VITEST_BACKEND=local` → current behavior (all three suites locally)
- `npm run test:cloud` script exists and dispatches to `scripts/vitest-cloud.sh run`
- `npm run test:cloud:build` script exists and dispatches to `scripts/vitest-cloud.sh build`
- `AGENTS.md` mentions `FRESHELL_VITEST_BACKEND`
- `FRESHELL_VITEST_BACKEND=local npx tsx scripts/run-standard-tests.ts --mode desktop` still runs all three suites locally (no regression)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-integration.test.sh` with:
- Check 1: `scripts/run-standard-tests.ts` contains `FRESHELL_VITEST_BACKEND` reference
- Check 2: `scripts/run-standard-tests.ts` contains `vitest-cloud.sh` reference
- Check 3: `package.json` contains `test:cloud` script
- Check 4: `package.json` contains `test:cloud:build` script
- Check 5: `AGENTS.md` mentions `FRESHELL_VITEST_BACKEND`
- Check 6: Process-level test — create a temporary fake `vitest-cloud.sh` that logs its args to a temp file and exits 0. Set `FRESHELL_VITEST_BACKEND=cloud` and run `npx tsx scripts/run-standard-tests.ts --mode desktop` with the fake on PATH. Verify the fake was invoked (the temp file exists and contains "run"). This proves the cloud-dispatch branch actually executes, not just that the string exists in source.
- Check 7: `FRESHELL_VITEST_BACKEND=local npx tsx scripts/run-standard-tests.ts --mode desktop` still runs locally (no regression — verify it does NOT invoke vitest-cloud.sh)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-integration.test.sh`

Expected: FAIL because `run-standard-tests.ts` does not reference `FRESHELL_VITEST_BACKEND`, and `package.json` has no `test:cloud` script

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/run-standard-tests.ts`, add at the top of `main()`:

```typescript
if (process.env.FRESHELL_VITEST_BACKEND === 'cloud') {
  const { execFileSync } = await import('node:child_process')
  const cloudScript = resolve(repoRoot, 'scripts/vitest-cloud.sh')

  // Run client + server suites in the cloud.
  try {
    execFileSync(cloudScript, ['run', ...forwardedArgs], { stdio: 'inherit', cwd: repoRoot })
  } catch {
    process.exitCode = 1
    return 1
  }

  // Run the electron suite locally (needs a display + native modules).
  const electronArgs = buildVitestArgs({
    configPath: electronVitestConfig,
    forwardedArgs,
  })
  log('info', 'Running electron suite locally after cloud dispatch', {
    args: electronArgs,
  })
  try {
    execFileSync(process.execPath, [vitestEntrypoint, ...electronArgs], {
      stdio: 'inherit',
      cwd: repoRoot,
      env: process.env,
    })
  } catch {
    process.exitCode = 1
    return 1
  }
  return 0
}
```

In `package.json`, add:
```json
"test:cloud": "bash scripts/vitest-cloud.sh run",
"test:cloud:build": "bash scripts/vitest-cloud.sh build",
```

In `AGENTS.md`, add a section under Testing explaining `FRESHELL_VITEST_BACKEND` (similar to `FRESHELL_E2E_BACKEND`). Include:
- Unset or `"local"` = local (safe default)
- `"cloud"` = Cloud Run Jobs with 4-way sharding
- Electron suite always runs locally even in cloud mode
- Set permanently in `~/.bashrc` to avoid repeated prompts

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

### Task 4: Cloud Build config and --local-build flag

**Requirements served:** R2

**Behavior:**
- `docker/cloud-run/cloudbuild.yaml` configures Google Cloud Build with:
  - `docker pull` of existing image for `--cache-from` layer caching
  - `docker build -f docker/cloud-run/Dockerfile --cache-from <image> -t <image> .`
  - `images:` field for automatic push to Artifact Registry
  - `E2_HIGHCPU_32` machine type, 200GB disk
  - `timeout` at the **top level** (not under `options`), per the [Cloud Build schema](https://docs.cloud.google.com/build/docs/build-config-file-schema)
- `.gcloudignore` excludes non-build files from Cloud Build source upload (same as `.dockerignore` plus `.worktrees/`)
- Both `scripts/e2e-cloud.sh` and `scripts/vitest-cloud.sh` use Cloud Build as the **default** build path (the original request says "so the image builds in the cloud instead of locally")
- `--local-build` flag on `cmd_build` opts back into local Docker
- The `gcloud builds submit` command includes `--account`, `--project`, and the image URL is passed as a substitution derived from the wrapper's resolved settings (not hard-coded)
- Tests use a fake `gcloud` to verify the intended command without submitting a real build

**Files:**
- Create: `docker/cloud-run/cloudbuild.yaml`
- Create: `.gcloudignore`
- Modify: `scripts/e2e-cloud.sh` (change `cmd_build` to default to Cloud Build, add `--local-build` flag for local Docker)
- Modify: `scripts/vitest-cloud.sh` (same `cmd_build` change)
- Test: `scripts/test/cloud-build.test.sh`

**Interfaces:**
- Consumes: `cloudbuild.yaml`, `.gcloudignore`, `--local-build` flag (new), GCP coordinates from wrapper env vars
- Produces: Docker image in Artifact Registry (built by Cloud Build)

**Test cases:**
- `docker/cloud-run/cloudbuild.yaml` exists and is valid YAML
- `cloudbuild.yaml` references the correct Dockerfile path (`docker/cloud-run/Dockerfile`)
- `cloudbuild.yaml` contains `images:` field
- `cloudbuild.yaml` uses `E2_HIGHCPU_32` machine type (under `options`)
- `cloudbuild.yaml` has `timeout` at top level (NOT under `options`)
- `cloudbuild.yaml` uses substitutions (`${_IMAGE}`) not hard-coded image URLs
- `.gcloudignore` exists and excludes `.git`, `node_modules`, `target`, `dist`, `.worktrees/`
- `e2e-cloud.sh help` mentions `--local-build`
- `vitest-cloud.sh help` mentions `--local-build`
- `e2e-cloud.sh build` (default, no flag) with a fake `gcloud` on PATH: verify the wrapper invokes `gcloud builds submit` with `--account`, `--project`, and `--config docker/cloud-run/cloudbuild.yaml`. Positive assertion on the command, not just absence of local Docker output.
- `e2e-cloud.sh build --local-build` with a fake `docker` on PATH: verify the wrapper invokes `docker build` (local path still works)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-build.test.sh` with:
- Check 1: `docker/cloud-run/cloudbuild.yaml` exists
- Check 2: `cloudbuild.yaml` is valid YAML (parse with `python3 -c "import yaml; yaml.safe_load(open('...'))"`)
- Check 3: `cloudbuild.yaml` contains `docker/cloud-run/Dockerfile`
- Check 4: `cloudbuild.yaml` contains `images:`
- Check 5: `cloudbuild.yaml` contains `E2_HIGHCPU_32` under `options:`
- Check 6: `cloudbuild.yaml` contains `timeout` at top level (verify it's NOT nested under `options`)
- Check 7: `cloudbuild.yaml` uses `${_IMAGE}` substitution (not a hard-coded URL)
- Check 8: `.gcloudignore` exists
- Check 9: `.gcloudignore` excludes `.git`, `node_modules`, `target`, `dist`, `.worktrees/`
- Check 10: `e2e-cloud.sh help` contains `--local-build`
- Check 11: `vitest-cloud.sh help` contains `--local-build`
- Check 12: `e2e-cloud.sh build` (default) with fake `gcloud` — create a temp script that logs args and exits 0, put it on PATH. Run `e2e-cloud.sh build`. Verify the fake gcloud was called with `builds submit` and `--config` containing `cloudbuild.yaml`. Also verify `--account` and `--project` are present.
- Check 13: `e2e-cloud.sh build --local-build` with fake `docker` — create a temp script that logs args and exits 0. Run `e2e-cloud.sh build --local-build`. Verify the fake docker was called with `build`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: FAIL because `cloudbuild.yaml` and `.gcloudignore` don't exist, and `--local-build` flag isn't implemented

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

In `scripts/e2e-cloud.sh`, modify `cmd_build` to default to Cloud Build:
- When `--local-build` is NOT set: run `gcloud builds submit --config "$ROOT/docker/cloud-run/cloudbuild.yaml" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" --substitutions=_IMAGE="$IMAGE_REMOTE" "$ROOT"`
- When `--local-build` IS set: run the existing local `docker build` + `cmd_push` path

In `scripts/vitest-cloud.sh`, same modification to `cmd_build`.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `--local-build` flag logic is a simple if/else in `cmd_build`. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-wrapper.test.sh` (e2e wrapper still works)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/cloudbuild.yaml .gcloudignore scripts/e2e-cloud.sh scripts/vitest-cloud.sh scripts/test/cloud-build.test.sh
git commit -m "feat: add Cloud Build config and make cloud build the default"
```

---

### Task 5: End-to-end cloud validation

**Requirements served:** R1, R2, R3

**Behavior:**
- Build the Docker image via Cloud Build first, then run cloud vitest against that image
- Verify all tests pass
- Record actual timings and cost estimates

**Files:**
- No new files (validation task)
- Record results in `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-vitest-and-build/reports/cloud-validation.md`

**Test cases:**
- `scripts/e2e-cloud.sh build` (Cloud Build default) → Docker image builds and pushes to Artifact Registry
- `scripts/vitest-cloud.sh run --cloud --shards=4` → all vitest tests pass (4/4 tasks succeeded), running against the image built by Cloud Build
- Cloud vitest wall time < 3 min
- Cloud build wall time < 15 min (cold) or < 5 min (warm)

- [ ] **Step 1: Build the Docker image via Cloud Build**

Run: `scripts/e2e-cloud.sh build`

Expected: Cloud Build succeeds, image pushed to Artifact Registry

- [ ] **Step 2: Run cloud vitest against the Cloud-Built image**

Run: `scripts/vitest-cloud.sh run --cloud --shards=4 --timeout=30m`

Expected: All 4 tasks succeed, vitest tests pass

- [ ] **Step 3: Record results**

Write results to `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-vitest-and-build/reports/cloud-validation.md` with:
- Cloud vitest: shard count, wall time, per-shard test counts, cost estimate
- Cloud build: wall time, cache hit/miss, cost estimate
- Any issues encountered

Note: The validation report is an external artifact in the logs directory (outside the worktree). Do not attempt to `git add` it.
