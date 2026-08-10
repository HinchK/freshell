# Cloud Vitest + Cloud Build Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Move Vitest unit/server test suites and Docker image builds to Google Cloud, reducing validation pipeline wall time from ~5 min to ~2 min.

**Architecture:** The existing Docker image (built for Playwright e2e) already contains Node.js, all npm deps, the Rust server binary, and dist artifacts — everything Vitest needs. We add a `TEST_MODE=vitest` branch to the entrypoint that runs `npx vitest run --passWithNoTests --shard=I/N` for both default and server configs. A new `scripts/vitest-cloud.sh` wrapper (modeled on `scripts/e2e-cloud.sh`) dispatches to Cloud Run Jobs with `TEST_MODE=vitest`. `scripts/run-standard-tests.ts` gets an early-return dispatch when `FRESHELL_VITEST_BACKEND=cloud` that runs only the client+server stages in the cloud, then runs the electron stage locally. For Docker builds, a `cloudbuild.yaml` + `.gcloudignore` configures Google Cloud Build with BuildKit `mode=max` layer caching (preserving intermediate stage layers). Cloud Build is the **default** build path (the original request says "so the image builds in the cloud instead of locally"); `--local-build` opts back into local Docker.

**Tech Stack:** Google Cloud Run Jobs, Google Cloud Build, Artifact Registry, Vitest `--shard`, BuildKit registry cache, bash, TypeScript

## Design Decisions

### Vitest `--shard` vs e2e duration-based sharding

The e2e entrypoint uses a custom duration-aware bin-packing algorithm: it
discovers spec files, looks up per-spec duration estimates from
`test-durations.txt`, and greedy-assigns specs to shards by estimated
runtime. This is necessary for Playwright because spec durations vary wildly
(some specs take 2s, others 120s).

Vitest's built-in `--shard` flag partitions test files equally by count, not
by duration. **This is an intentional design choice**, not a gap:

1. Vitest parallelizes tests *within* each shard (using worker threads), so
   even if one shard gets more slow tests, it compensates with parallelism.
2. Vitest test durations are far more uniform than Playwright specs (most
   unit tests take <100ms; the slowest integration tests are ~5s).
3. The 4-shard count-based partition already brings wall time from ~5 min
   to ~2 min based on load-bearing validation (LB1, LB2).
4. Duration-based sharding can be added later if imbalance is observed in
   production — the entrypoint's `VITEST_ARGS_JSON` mechanism provides the
   injection point for custom file lists.

### `VITEST_ARGS_JSON` for lossless argument forwarding

Arguments forwarded to the entrypoint are serialized as a JSON array
(`VITEST_ARGS_JSON`), not a space-separated string. This preserves argument
boundaries (args with spaces, shell metacharacters, newlines) and avoids
glob expansion. The entrypoint parses the array with `jq -r '.[]'` (jq is
already in the Docker image per Dockerfile:99). The wrapper script builds
the JSON array using `jq -nc --args` to serialize safely.

### Non-root runtime user

The Dockerfile runtime stage currently runs as root. Two server-side tests
in `claude-transcript-locator.test.ts` (lines 120, 134) use `chmod 0o000` to
verify that permission errors propagate rather than being swallowed. Root
bypasses these mode bits, so those tests would not reject as expected. The
Dockerfile will add `USER node` (the `node:22-bookworm` base image provides
a `node` user, UID 1000) and `chown -R node:node /app` to ensure the
runtime is unprivileged. The server globalSetup writes to `/app/dist/server`
— this directory must be writable by the `node` user.

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
- The existing `run-standard-tests.ts` uses `--passWithNoTests` (line 89) so that forwarded file filters targeting one suite don't cause sibling suites to fail with no matching tests. The entrypoint vitest mode must do the same.
- The logs directory for this run is: `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-vitest-and-build`

## Requirements

- **R1 — Cloud Vitest:** Vitest default + server suites run on Cloud Run Jobs with 4-way sharding (Vitest built-in `--shard`, count-based partition), completing in <3 min wall time
- **R2 — Cloud Build:** Docker image builds on Google Cloud Build (as the default build path, not opt-in) with BuildKit `mode=max` registry cache preserving intermediate stage layers, completing in <15 min cold / <5 min warm
- **R3 — Backend selection:** `FRESHELL_VITEST_BACKEND` env var controls local vs cloud, mirroring the `FRESHELL_E2E_BACKEND` pattern; `--local`/`--cloud` flags override per-invocation
- **R4 — Integration:** `npm test` / `npm run check` / `npm run verify` dispatch to cloud vitest when `FRESHELL_VITEST_BACKEND=cloud`, while preserving the electron stage locally
- **R5 — Tests:** Full test coverage of new scripts, configs, and entrypoint changes, following the existing `scripts/test/cloud-*.test.sh` pattern
- **R6 — Docs:** AGENTS.md updated with cloud vitest instructions

---

### Task 1: Entrypoint vitest mode + .dockerignore fix + Dockerfile USER node

**Requirements served:** R1

**Behavior:**
- When `TEST_MODE=vitest` env var is set, the entrypoint runs Vitest instead of Playwright
- Each Cloud Run task runs both default and server vitest configs, using `--shard=I/N` for sharding
- Shard index comes from `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT`
- `--passWithNoTests` is always passed, so a config with no matching test files exits 0 (not 1) — this mirrors `run-standard-tests.ts:89`
- If any config fails, the exit code is non-zero (but both configs still run)
- When `TEST_MODE` is unset or `playwright`, current behavior is unchanged
- `.dockerignore` is updated to allow `AGENTS.md` and `docs/skills/testing.md` into the image (needed by `test/integration/server/test-coordinator.test.ts`)
- The Dockerfile runtime stage switches to `USER node` (non-root) so that `claude-transcript-locator.test.ts` permission tests (lines 120, 134) behave correctly — `chmod 0o000` is not bypassed by root. Playwright browsers must be installed to a shared system path (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) before the `USER node` switch, since the default `~/.cache/ms-playwright` would be root's home and inaccessible to the `node` user
- The entrypoint accepts `VITEST_ARGS_JSON` env var for pass-through arguments (JSON array, parsed with `jq`), so the container smoke test can run a single fast test file without losing argument boundaries

**Files:**
- Modify: `docker/cloud-run/entrypoint.sh` (add vitest branch at top, before playwright logic)
- Modify: `docker/cloud-run/Dockerfile` (add `chown` + `USER node` in runtime stage)
- Modify: `.dockerignore` (add `!AGENTS.md` and `!docs/skills/testing.md` exceptions)
- Test: `scripts/test/cloud-vitest-entrypoint.test.sh`

**Interfaces:**
- Consumes: `TEST_MODE` (env var, new), `CLOUD_RUN_TASK_INDEX` (existing), `CLOUD_RUN_TASK_COUNT` (existing), `VITEST_CONFIGS` (env var, new — space-separated list of config paths, default: `"config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts"`), `VITEST_ARGS_JSON` (env var, new — JSON array of extra args passed to vitest, e.g. `'["test/unit/lib/pane-utils.test.ts"]'`)
- Produces: Vitest test output on stdout/stderr, exit code 0 (all pass) or 1 (any fail)

**Test cases:**
- `TEST_MODE=vitest` branch exists in entrypoint → grep finds `TEST_MODE` and `vitest`
- Entrypoint with `TEST_MODE=playwright` (or unset) → current behavior unchanged
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=1` → runs `npx vitest run --passWithNoTests` for both configs (no `--shard` flag)
- Entrypoint with `TEST_MODE=vitest` and `CLOUD_RUN_TASK_COUNT=2` → runs `npx vitest run --passWithNoTests --shard=1/2` and `--shard=2/2` for both configs
- `VITEST_CONFIGS` env var limits which configs run (e.g., only default config)
- `VITEST_ARGS_JSON` env var passes extra args to vitest (e.g., a specific test file) — test with an arg containing a space to verify lossless parsing
- `--passWithNoTests` is present in the entrypoint vitest branch
- `VITEST_ARGS_JSON` is parsed with `jq` (entrypoint references `jq` and `VITEST_ARGS_JSON`)
- `.dockerignore` has `!AGENTS.md` exception
- `.dockerignore` has `!docs/skills/testing.md` exception
- Dockerfile runtime stage has `USER node` directive
- Dockerfile runtime stage has `chown` for `/app` ownership
- Docker build succeeds with the modified entrypoint, Dockerfile, and .dockerignore (if Docker is available)
- Running the entrypoint in a container with `TEST_MODE=vitest CLOUD_RUN_TASK_COUNT=1 VITEST_CONFIGS="config/vitest/vitest.config.ts" VITEST_ARGS_JSON='["test/unit/lib/pane-utils.test.ts"]'` produces vitest output with passing tests (skip if Docker unavailable)
- Running the entrypoint in a container as the `node` user: `claude-transcript-locator.test.ts` permission tests reject as expected (skip if Docker unavailable)
- Multi-shard correctness: `CLOUD_RUN_TASK_COUNT=2` with `VITEST_ARGS_JSON` pointing to two test files — shard 1 runs one file, shard 2 runs the other (verify disjoint file sets by checking output contains different test file names)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-entrypoint.test.sh` with:
- Check 1: entrypoint.sh contains `TEST_MODE` reference
- Check 2: entrypoint.sh contains `vitest` reference
- Check 3: entrypoint.sh contains `--shard` reference
- Check 4: entrypoint.sh contains `--passWithNoTests`
- Check 5: entrypoint.sh references `VITEST_CONFIGS`
- Check 6: entrypoint.sh references `VITEST_ARGS_JSON` (not `VITEST_ARGS`)
- Check 7: entrypoint.sh references `jq` (for parsing `VITEST_ARGS_JSON`)
- Check 8: When `TEST_MODE` is unset, entrypoint still references playwright (unchanged behavior)
- Check 9: `.dockerignore` contains `!AGENTS.md`
- Check 10: `.dockerignore` contains `!docs/skills/testing.md`
- Check 11: Dockerfile contains `USER node` in the runtime stage
- Check 12: Dockerfile contains `chown` for `/app` ownership transfer
- Check 13: Docker build succeeds with the modified entrypoint (if Docker is available)
- Check 14: Running the entrypoint in a container with `TEST_MODE=vitest CLOUD_RUN_TASK_COUNT=1 VITEST_CONFIGS="config/vitest/vitest.config.ts" VITEST_ARGS_JSON='["test/unit/lib/pane-utils.test.ts"]'` produces vitest output with passing tests (skip if Docker unavailable)
- Check 15: Running `claude-transcript-locator.test.ts` in a container as `node` user — the permission tests reject as expected (not silently pass) (skip if Docker unavailable)
- Check 16: Multi-shard test — run two shards (`CLOUD_RUN_TASK_COUNT=2`, `CLOUD_RUN_TASK_INDEX=0` and `=1`) with `VITEST_ARGS_JSON='["test/unit/lib/pane-utils.test.ts", "test/unit/lib/pane-snap-2d.test.ts"]'`, verify each shard runs a disjoint set of test files (skip if Docker unavailable)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-entrypoint.test.sh`

Expected: FAIL because `entrypoint.sh` does not contain `TEST_MODE` or `vitest` references, `.dockerignore` lacks the `!AGENTS.md` / `!docs/skills/testing.md` exceptions, and the Dockerfile has no `USER node` directive

- [ ] **Step 3: Add the minimal production implementation**

Add to the top of `docker/cloud-run/entrypoint.sh`, after the `set -euo pipefail` and env var reads (`TASK_INDEX`/`TASK_COUNT`), before the playwright-specific logic:

```bash
# TEST_MODE=vitest: run Vitest instead of Playwright.
if [ "${TEST_MODE:-}" = "vitest" ]; then
  SHARD_INDEX=$((TASK_INDEX + 1))
  SHARD_COUNT="$TASK_COUNT"
  CONFIGS="${VITEST_CONFIGS:-config/vitest/vitest.config.ts config/vitest/vitest.server.config.ts}"

  # Parse VITEST_ARGS_JSON (JSON array) into a bash array using jq.
  # This preserves argument boundaries (spaces, metacharacters, etc.)
  # that would be lost with space-separated serialization.
  EXTRA_ARGS=()
  if [ -n "${VITEST_ARGS_JSON:-}" ]; then
    while IFS= read -r arg; do
      EXTRA_ARGS+=("$arg")
    done < <(jq -r '.[]' <<< "$VITEST_ARGS_JSON")
  fi

  SHARD_ARG=()
  if [ "$SHARD_COUNT" -gt 1 ]; then
    SHARD_ARG=(--shard="${SHARD_INDEX}/${SHARD_COUNT}")
  fi

  EXIT_CODE=0
  for config in $CONFIGS; do
    echo "[vitest-entrypoint] Running vitest: $config ${SHARD_ARG[*]-} ${EXTRA_ARGS[*]-}"
    npx vitest run --passWithNoTests --config "$config" "${SHARD_ARG[@]}" "${EXTRA_ARGS[@]}" || EXIT_CODE=$?
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

In `docker/cloud-run/Dockerfile`, in the runtime stage (Stage 3), after the `RUN chmod +x /usr/local/bin/e2e-entrypoint.sh` line (line 128) and before the `HEALTHCHECK` line, add ownership transfer and switch to non-root user. This must come AFTER the `COPY docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh` and `RUN chmod +x` lines — those write to root-owned paths (`/usr/local/bin/`) and must run as root:

Two changes to the Dockerfile runtime stage:

**Change 1:** Set `PLAYWRIGHT_BROWSERS_PATH` before the **existing** Playwright install (line 105), so browsers go to a shared system path instead of root's home. Do NOT add a second install — move the env var to before the existing one:

```dockerfile
# Before the existing install line (line 105):
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# (existing line) RUN npx --yes playwright@1.58.2 install --with-deps chromium
```

**Change 2:** After the `RUN chmod +x /usr/local/bin/e2e-entrypoint.sh` line (line 128) and before `HEALTHCHECK`, add ownership transfer and switch to non-root user:

```dockerfile
RUN chown -R node:node /app
USER node
```

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-entrypoint.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The vitest branch is a clean early-return at the top of the entrypoint. The Dockerfile change is two lines in the runtime stage. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh` (existing Dockerfile tests still pass)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/entrypoint.sh docker/cloud-run/Dockerfile .dockerignore scripts/test/cloud-vitest-entrypoint.test.sh
git commit -m "feat: add TEST_MODE=vitest to cloud-run entrypoint, fix .dockerignore, switch to non-root user"
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
- Sets `TEST_MODE=vitest`, `VITEST_CONFIGS`, and `VITEST_ARGS_JSON` env vars on the Cloud Run Job
- `VITEST_ARGS_JSON` is built using `jq -nc --args` to serialize pass-through args losslessly (JSON array)
- Local mode runs `npx vitest run --passWithNoTests --config <config>` for each config directly
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
- Script has mode `100755` in git (verify with `git ls-files -s` — this check runs at Step 7 after staging, not at Step 4)
- `help` subcommand shows usage, mentions `--local`, `--cloud`, `FRESHELL_VITEST_BACKEND`, `--shards`, `--config`
- `--local` flag runs vitest locally (run a single fast test file to verify)
- Default backend (unset env var) runs locally
- `FRESHELL_VITEST_BACKEND=local` runs locally
- `--cloud` flag with a fake `gcloud` on PATH: verify the wrapper invokes `gcloud run jobs execute` with the correct job name (`freshell-vitest`) and env vars (`TEST_MODE=vitest`, `VITEST_CONFIGS`), without touching real infrastructure. Assert the fake gcloud was called (positive assertion), not just that "Running locally" is absent.
- `--config=default` sets `VITEST_CONFIGS` to only the default config (verify via fake gcloud capturing the env-vars-file content)
- `--config=server` sets `VITEST_CONFIGS` to only the server config (verify via fake gcloud)
- `VITEST_ARGS_JSON` is valid JSON when pass-through args are present (verify via fake gcloud capturing the env-vars-file, then `jq` parse)
- `VITEST_ARGS_JSON` preserves args with spaces (verify via fake gcloud: pass an arg like `-t "test with spaces"`, confirm the JSON array has it as a single element)
- Existing `e2e-cloud.sh` tests still pass (no regression)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-wrapper.test.sh` with:
- Check 1: Script exists and is executable (`test -x`)
- Check 2: `help` contains "usage", "run", "--local", "--cloud", "FRESHELL_VITEST_BACKEND", "--shards", "--config"
- Check 3: `--local` runs a single fast test file locally (e.g., `--local test/unit/lib/pane-utils.test.ts`)
- Check 4: Default backend (unset env var) runs locally
- Check 5: `FRESHELL_VITEST_BACKEND=local` runs locally
- Check 6: `--cloud` flag with fake `gcloud` — create a temporary script that logs its args and exits 0, put it on PATH, verify the wrapper calls `gcloud run jobs execute` with `freshell-vitest` and sets `TEST_MODE=vitest` in the env-vars-file. Assert the fake gcloud was called (positive assertion), not just that "Running locally" is absent.
- Check 7: `--config=default` sets `VITEST_CONFIGS` to only `config/vitest/vitest.config.ts` (verify via fake gcloud capturing the env-vars-file content)
- Check 8: `--config=server` sets `VITEST_CONFIGS` to only `config/vitest/vitest.server.config.ts` (verify via fake gcloud)
- Check 9: `VITEST_ARGS_JSON` is valid JSON when pass-through args are present (capture env-vars-file via fake gcloud, parse with `jq -e .`)
- Check 10: `VITEST_ARGS_JSON` preserves args with spaces — pass `-t "test name"` as a pass-through arg, confirm the JSON array contains it as a single element (not split on space)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh`

Expected: FAIL because `scripts/vitest-cloud.sh` does not exist

- [ ] **Step 3: Add the minimal production implementation**

Create `scripts/vitest-cloud.sh` with:
- Same structure as `scripts/e2e-cloud.sh`: defaults, gcloud helpers, usage, `cmd_build`, `cmd_push`, `cmd_run`, `cmd_logs`, main dispatch
- Key differences from `e2e-cloud.sh`:
  - `GCP_JOB="freshell-vitest"` (not `freshell-e2e`)
  - `FRESHELL_VITEST_BACKEND` env var (not `FRESHELL_E2E_BACKEND`)
  - Local mode: `npx vitest run --passWithNoTests --config <config>` for each config (not `npx playwright test`)
  - Cloud mode: env-vars-file sets `TEST_MODE: "vitest"`, `VITEST_CONFIGS: "<configs>"`, and `VITEST_ARGS_JSON: "<json array>"`. The JSON array is built with: `if [ ${#pw_args[@]} -eq 0 ]; then echo '[]'; else printf '%s\n' "${pw_args[@]}" | jq -R . | jq -sc .; fi`. Since the JSON array contains double quotes, write the env-vars file using a YAML-safe method: either single-quote the JSON value in YAML (`VITEST_ARGS_JSON: '<json>'`) or use `jq -Rs .` to produce a YAML-safe double-quoted string with proper escaping. The env-vars file must round-trip through `gcloud run jobs execute --env-vars-file` without corrupting JSON values.
  - `--config=default|server|all` flag controls which configs to run
  - Log summary greps for vitest output patterns (`Test Files`, `Tests`)
  - Default `--shards=4` (not 1)
  - Default `--timeout=30m` (not 60m)
  - Non-positional args (not recognized as config selectors) are forwarded as `VITEST_ARGS_JSON`
- After creating the file: `chmod +x scripts/vitest-cloud.sh`

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review for duplication with `e2e-cloud.sh`. If `cmd_build` and `cmd_push` are identical, note for future extraction into a shared library but do not refactor now (two scripts is not enough duplication to justify the abstraction).

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh` (Dockerfile tests, no gcloud interaction).

Do NOT run `scripts/test/cloud-run-wrapper.test.sh` as a verification gate — its `--cloud` check uses real `gcloud` and can mutate/execute the live Cloud Run Job. That script's own CI gate is responsible for its safety.

Expected: PASS

- [ ] **Step 7: Verify git executable mode and commit**

Verify the file is tracked as executable:
```bash
git add scripts/vitest-cloud.sh scripts/test/cloud-vitest-wrapper.test.sh
git ls-files -s scripts/vitest-cloud.sh
```

If the mode is not `100755`, fix it:
```bash
git update-index --chmod=+x scripts/vitest-cloud.sh
```

Then commit:
```bash
git commit -m "feat: add vitest-cloud.sh wrapper for Cloud Run Jobs"
```

---

### Task 3: Integration with run-standard-tests.ts + npm scripts + AGENTS.md

**Requirements served:** R3, R4, R6

**Behavior:**
- When `FRESHELL_VITEST_BACKEND=cloud`, `scripts/run-standard-tests.ts` dispatches client+server stages to `scripts/vitest-cloud.sh run`, then runs the electron stage locally
- The dispatch happens at the top of `main()`, before any local test planning
- The cloud dispatch runs only the client and server configs; the electron config always runs locally (it needs a display and native modules not available in the container)
- Forwarded args are passed through to the cloud wrapper, **except** Git-dependent selectors like `--changed` — Vitest's `--changed` requires a `.git` directory, which is excluded from the Docker image. When `--changed` is detected in forwarded args, the cloud dispatch must fall back to local execution (log a warning and run locally)
- The cloud wrapper script path is injectable via `FRESHELL_VITEST_CLOUD_SCRIPT` env var (default: `resolve(repoRoot, 'scripts/vitest-cloud.sh')`), so tests can substitute a fake without relying on PATH interception of an absolute-path exec
- New npm scripts: `test:cloud`, `test:cloud:build`
- AGENTS.md updated with cloud vitest instructions

**Files:**
- Modify: `scripts/run-standard-tests.ts` (add early dispatch in `main()`, with injectable script path)
- Modify: `package.json` (add `test:cloud`, `test:cloud:build` scripts)
- Modify: `AGENTS.md` (add Vitest section to E2E Test Backend area)
- Test: `scripts/test/cloud-vitest-integration.test.sh`

**Interfaces:**
- Consumes: `FRESHELL_VITEST_BACKEND` env var, `FRESHELL_VITEST_CLOUD_SCRIPT` env var (optional, for test injection)
- Produces: Exit code from `scripts/vitest-cloud.sh run` (for client+server) then local vitest exit code (for electron)

**Test cases:**
- `FRESHELL_VITEST_BACKEND=cloud` in `run-standard-tests.ts` → dispatches to `vitest-cloud.sh` for client+server, then runs electron locally
- The dispatch is verifiable by injecting `FRESHELL_VITEST_CLOUD_SCRIPT` pointing to a fake script that logs its invocation and exits 0 — verify the fake was invoked (the log file exists and contains "run"), AND verify the local electron suite was also invoked. This proves both the cloud-dispatch branch and the local electron fallback execute. Note: this tests `run-standard-tests.ts` directly, not the full `test-coordinator.ts` path (which adds pre-phases and `FRESHELL_TEST_COORDINATOR_ACTIVE`). The coordinator path is a thin wrapper around `run-standard-tests.ts` — testing `run-standard-tests.ts` is sufficient for the dispatch logic.
- `FRESHELL_VITEST_BACKEND` unset → current behavior (all three suites locally)
- `FRESHELL_VITEST_BACKEND=local` → current behavior (all three suites locally)
- `npm run test:cloud` script exists and dispatches to `scripts/vitest-cloud.sh run`
- `npm run test:cloud:build` script exists and dispatches to `scripts/vitest-cloud.sh build`
- `AGENTS.md` mentions `FRESHELL_VITEST_BACKEND`
- `FRESHELL_VITEST_BACKEND=local npx tsx scripts/run-standard-tests.ts --mode desktop` still runs all three suites locally (no regression — verify it does NOT invoke vitest-cloud.sh)

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-vitest-integration.test.sh` with:
- Check 1: `scripts/run-standard-tests.ts` contains `FRESHELL_VITEST_BACKEND` reference
- Check 2: `scripts/run-standard-tests.ts` contains `FRESHELL_VITEST_CLOUD_SCRIPT` reference (the injection point)
- Check 3: `scripts/run-standard-tests.ts` contains `vitest-cloud.sh` reference (the default path)
- Check 4: `package.json` contains `test:cloud` script
- Check 5: `package.json` contains `test:cloud:build` script
- Check 6: `AGENTS.md` mentions `FRESHELL_VITEST_BACKEND`
- Check 7: Process-level test — create a temporary fake `vitest-cloud.sh` at a temp path that logs its args to a temp file and exits 0. Set `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_VITEST_CLOUD_SCRIPT=/tmp/fake-vitest-cloud.sh`. Run `npx tsx scripts/run-standard-tests.ts --mode desktop`. Verify the fake was invoked (the temp log file exists and contains "run"). Also verify the local electron suite was invoked (check stdout/stderr for electron vitest output). This proves the cloud-dispatch branch AND the electron fallback both execute, not just that the string exists in source.
- Check 8: `FRESHELL_VITEST_BACKEND=local npx tsx scripts/run-standard-tests.ts --mode desktop` still runs locally (no regression — verify it does NOT invoke any vitest-cloud.sh)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-integration.test.sh`

Expected: FAIL because `run-standard-tests.ts` does not reference `FRESHELL_VITEST_BACKEND`, and `package.json` has no `test:cloud` script

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/run-standard-tests.ts`, add at the top of `main()`:

```typescript
if (process.env.FRESHELL_VITEST_BACKEND === 'cloud') {
  const { execFileSync } = await import('node:child_process')
  const cloudScript = process.env.FRESHELL_VITEST_CLOUD_SCRIPT
    || resolve(repoRoot, 'scripts/vitest-cloud.sh')

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
"test:cloud": "bash scripts/vitest-cloud.sh run --cloud",
"test:cloud:build": "bash scripts/vitest-cloud.sh build",
```

In `AGENTS.md`, add a section under Testing explaining `FRESHELL_VITEST_BACKEND` (similar to `FRESHELL_E2E_BACKEND`). Include:
- Unset or `"local"` = local (safe default)
- `"cloud"` = Cloud Run Jobs with 4-way sharding (Vitest built-in `--shard`, count-based partition)
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
  - BuildKit enabled (`DOCKER_BUILDKIT=1`) for `mode=max` registry caching, which preserves intermediate stage layers (rust-builder, node-builder) — not just the final image
  - `docker pull` of existing image for `--cache-from` layer caching
  - `docker buildx build -f docker/cloud-run/Dockerfile --cache-from type=registry,ref=<image>-cache --cache-to type=registry,ref=<image>-cache,mode=max -t <image> --push .`
  - `--push` flag on `docker buildx build` for automatic push to Artifact Registry (no `images:` field — buildx --push handles the push directly)
  - `E2_HIGHCPU_32` machine type, 200GB disk
  - `timeout` at the **top level** (not under `options`), per the [Cloud Build schema](https://docs.cloud.google.com/build/docs/build-config-file-schema)
- `.gcloudignore` excludes non-build files from Cloud Build source upload (same as `.dockerignore` plus `.worktrees/`)
- Both `scripts/e2e-cloud.sh` and `scripts/vitest-cloud.sh` use Cloud Build as the **default** build path (the original request says "so the image builds in the cloud instead of locally")
- `--local-build` flag on `cmd_build` opts back into local Docker
- The `gcloud builds submit` command includes `--account`, `--project`, and the image URL is passed as a substitution derived from the wrapper's resolved settings (not hard-coded)
- Tests use a fake `gcloud` AND a fake `docker` on PATH to verify the intended commands without submitting a real build or touching real infrastructure

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
- `cloudbuild.yaml` uses `docker buildx build` with `--push` (not `images:` field)
- `cloudbuild.yaml` uses `E2_HIGHCPU_32` machine type (under `options`)
- `cloudbuild.yaml` has `timeout` at top level (NOT under `options`)
- `cloudbuild.yaml` uses substitutions (`${_IMAGE}`) not hard-coded image URLs
- `cloudbuild.yaml` enables BuildKit (`DOCKER_BUILDKIT=1` env or `--build-arg BUILDKIT=1`)
- `cloudbuild.yaml` uses `mode=max` in the cache-to reference (for intermediate layer export); `cache-from` has no `mode` (import reads all available cache)
- `.gcloudignore` exists and excludes `.git`, `node_modules`, `target`, `dist`, `.worktrees/`
- `e2e-cloud.sh help` mentions `--local-build`
- `vitest-cloud.sh help` mentions `--local-build`
- `e2e-cloud.sh build` (default, no flag) with a fake `gcloud` on PATH: verify the wrapper invokes `gcloud builds submit` with `--account`, `--project`, and `--config docker/cloud-run/cloudbuild.yaml`. Positive assertion on the command, not just absence of local Docker output.
- `vitest-cloud.sh build` (default, no flag) with a fake `gcloud` on PATH: same verification as above — the vitest wrapper also dispatches to Cloud Build by default.
- `e2e-cloud.sh build --local-build` with a fake `docker` AND a fake `gcloud` on PATH: verify the wrapper invokes `docker build` (local path still works), and verify it does NOT call `gcloud builds submit`.
- `vitest-cloud.sh build --local-build` with a fake `docker` AND a fake `gcloud` on PATH: same verification — the vitest wrapper also supports local build.
- The `--local-build` path fakes `gcloud` because the existing `cmd_push` function makes real `gcloud artifacts repositories describe/create` and `gcloud auth print-access-token` calls — the test must not depend on live credentials or create real registry resources.

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-build.test.sh` with:
- Check 1: `docker/cloud-run/cloudbuild.yaml` exists
- Check 2: `cloudbuild.yaml` is valid YAML (parse with `node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('...', 'utf8'))"`)
- Check 3: `cloudbuild.yaml` contains `docker/cloud-run/Dockerfile`
- Check 4: `cloudbuild.yaml` uses `buildx build` with `--push`
- Check 5: `cloudbuild.yaml` contains `E2_HIGHCPU_32` under `options:`
- Check 6: `cloudbuild.yaml` contains `timeout` at top level (verify it's NOT nested under `options`)
- Check 7: `cloudbuild.yaml` uses `${_IMAGE}` substitution (not a hard-coded URL)
- Check 8: `cloudbuild.yaml` enables BuildKit (contains `DOCKER_BUILDKIT=1` or `BUILDKIT=1`)
- Check 9: `cloudbuild.yaml` uses `mode=max` in cache-to reference
- Check 10: `.gcloudignore` exists
- Check 11: `.gcloudignore` excludes `.git`, `node_modules`, `target`, `dist`, `.worktrees/`
- Check 12: `e2e-cloud.sh help` contains `--local-build`
- Check 13: `vitest-cloud.sh help` contains `--local-build`
- Check 14: `e2e-cloud.sh build` (default) with fake `gcloud` — create a temp script that logs args and exits 0, put it on PATH. Run `e2e-cloud.sh build`. Verify the fake gcloud was called with `builds submit` and `--config` containing `cloudbuild.yaml`. Also verify `--account` and `--project` are present.
- Check 15: `vitest-cloud.sh build` (default) with fake `gcloud` — same as Check 14 but for the vitest wrapper. Verify it also dispatches to Cloud Build by default.
- Check 16: `e2e-cloud.sh build --local-build` with fake `docker` AND fake `gcloud` — create temp scripts for both that log args and exit 0. Run `e2e-cloud.sh build --local-build`. Verify the fake docker was called with `build`. Verify the fake gcloud was NOT called with `builds submit` (it may be called for `cmd_push`, but not for Cloud Build).
- Check 17: `vitest-cloud.sh build --local-build` with fake `docker` AND fake `gcloud` — same as Check 16 but for the vitest wrapper.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: FAIL because `cloudbuild.yaml` and `.gcloudignore` don't exist, and `--local-build` flag isn't implemented

- [ ] **Step 3: Add the minimal production implementation**

Create `docker/cloud-run/cloudbuild.yaml`:
```yaml
steps:
  # Create a buildx builder that supports registry cache export.
  # The default docker driver does not support --cache-to type=registry.
  - name: 'gcr.io/cloud-builders/docker'
    entrypoint: 'bash'
    args: ['-c', 'docker buildx create --use --name cloud-builder --driver docker-container || docker buildx use cloud-builder']
  # Pull existing cache image for layer caching (exit 0 if not found yet).
  - name: 'gcr.io/cloud-builders/docker'
    entrypoint: 'bash'
    args: ['-c', 'docker pull ${_IMAGE}-cache || exit 0']
    env:
      - 'DOCKER_BUILDKIT=1'
  # Build with BuildKit + mode=max registry cache to preserve intermediate
  # stage layers (rust-builder, node-builder), not just the final image.
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'buildx'
      - 'build'
      - '-f'
      - 'docker/cloud-run/Dockerfile'
      - '-t'
      - '${_IMAGE}'
      - '--cache-from'
      - 'type=registry,ref=${_IMAGE}-cache'
      - '--cache-to'
      - 'type=registry,ref=${_IMAGE}-cache,mode=max'
      - '--push'
      - '.'
    env:
      - 'DOCKER_BUILDKIT=1'
options:
  machineType: 'E2_HIGHCPU_32'
  diskSizeGb: 200
timeout: '3600s'
```

Note: No `substitutions` block — the wrapper always passes `--substitutions=_IMAGE="$IMAGE_REMOTE"` on the `gcloud builds submit` command line, so the image URL is never hard-coded in the YAML.

Create `.gcloudignore` with the same exclusions as `.dockerignore` plus `.worktrees/`, but **do not exclude `docs/` wholesale** — `.gcloudignore` follows gitignore rules where a child cannot be re-included if its parent directory is excluded, so `!docs/skills/testing.md` would be ignored. Instead, exclude only the docs subdirectories not needed by tests (e.g. `docs/plans/`, `docs/development/`, `docs/index.html`), keeping `docs/skills/testing.md` accessible. Include `!AGENTS.md` as an exception (AGENTS.md is at the root, not under an excluded parent).

In `scripts/e2e-cloud.sh`, modify `cmd_build` to default to Cloud Build:
- When `--local-build` is NOT set: run `gcloud builds submit --config "$ROOT/docker/cloud-run/cloudbuild.yaml" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" --substitutions=_IMAGE="$IMAGE_REMOTE" "$ROOT"`
- When `--local-build` IS set: run the existing local `docker build` + `cmd_push` path
- Add `--local-build` to the `cmd_build` arg parser and to `usage()`

In `scripts/vitest-cloud.sh`, same modification to `cmd_build`.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-build.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `--local-build` flag logic is a simple if/else in `cmd_build`. No refactor needed.

- [ ] **Step 6: Run broader verification**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh` (Dockerfile tests, no gcloud interaction).

Do NOT run `scripts/test/cloud-run-wrapper.test.sh` as a verification gate — its `--cloud` check uses real `gcloud` and can mutate/execute the live Cloud Run Job.

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/cloudbuild.yaml .gcloudignore scripts/e2e-cloud.sh scripts/vitest-cloud.sh scripts/test/cloud-build.test.sh
git commit -m "feat: add Cloud Build config with BuildKit mode=max cache and make cloud build the default"
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
- `scripts/vitest-cloud.sh build` (Cloud Build default) → same image (verify the vitest wrapper also builds successfully via Cloud Build)
- `scripts/vitest-cloud.sh run --cloud --shards=4` → all vitest tests pass (4/4 tasks succeeded), running against the image built by Cloud Build
- Cloud vitest wall time < 3 min
- Cloud build wall time < 15 min (cold) or < 5 min (warm)

- [ ] **Step 1: Build the Docker image via Cloud Build**

Run: `scripts/e2e-cloud.sh build`

Expected: Cloud Build succeeds, image pushed to Artifact Registry

- [ ] **Step 2: Verify vitest-cloud.sh build also works**

Run: `scripts/vitest-cloud.sh build`

Expected: Cloud Build succeeds (same image, verifies the vitest wrapper's build subcommand works against real Cloud Build)

- [ ] **Step 3: Run cloud vitest against the Cloud-Built image**

Run: `scripts/vitest-cloud.sh run --cloud --shards=4 --timeout=30m`

Expected: All 4 tasks succeed, vitest tests pass

- [ ] **Step 4: Record results**

Write results to `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-vitest-and-build/reports/cloud-validation.md` with:
- Cloud vitest: shard count, wall time, per-shard test counts, cost estimate
- Cloud build: wall time, cache hit/miss, cost estimate
- Any issues encountered

Note: The validation report is an external artifact in the logs directory (outside the worktree). Do not attempt to `git add` it.
