# j90s Harness Flake Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Fix kata `j90s` (Freshell repo, KataTracker): the flaky e2e test `Settings › Expand thinking and Expand tools switches persist locally and reset to defaults` at `test/e2e-browser/specs/settings.spec.ts:185`, whose attempt-1 failure is `TestHarness.waitForConnection` (`test/e2e-browser/helpers/test-harness.ts:21`) timing out while waiting for `window.__FRESHELL_TEST_HARNESS__` on cloud cold start.

### Explicit constraints
- Run this work through the-usual workflow (dedicated worktree, plan, load-bearing validation, independent plan review, TDD execution with per-task review, independent delta review, recap).
- Follow the repo's rules in AGENTS.md: work in `.worktrees/j90s-harness-flake` on branch `the-usual/j90s-harness-flake` from `origin/main`; TDD red/green/refactor; both unit and e2e coverage for the fix; never reduce coverage, skip tests, or loosen assertions to hide flakes — diagnose and fix the flake mechanism.
- The affected e2e spec must actually pass on the configured cloud e2e backend before the run finishes; a spec sitting in `CLOUD_SKIP_SPECS` or a filter that matched no tests is not coverage.
- Do not restart or interfere with the self-hosted production Freshell server (port 3001) without explicit user approval.
- Kata tracking: keep kata j90s updated; close it when the work is genuinely complete.

### Accepted tradeoffs and residuals
- The fix is expected to be proportionate (harness connection tolerance/readiness on the cloud lane), not a broad rewrite — the kata evidence points at harness-connection timing, not the settings feature.
- Sizing the real flake rate (the kata's direction 3) is in scope only as far as it shapes the fix; absence of a perfect historical rate estimate is acceptable if the mechanism fix is well-evidenced.

**Goal:** The cloud e2e lane stops flaking `settings.spec.ts:185` (and every other harness-connected spec) on cold-start connection timing, by (a) fixing `waitForConnection`'s timeout-binding bug — the `{timeout}` object currently binds to the predicate's *argument*, so the real window is Playwright's 30s default, not the intended 16s — and (b) making that now-real window environment-scalable, with 45s on the cloud lane so it survives the client's 10s ready-watchdog close/reconnect cycles. Local no-arg call sites keep their historical real ~30s window: the new default binds 30s (+1s slack), preserving actual behavior rather than narrowing it to the never-effective 16s.

**Architecture:** Three small, sequenced pieces. (1) `test/e2e-browser/helpers/test-harness.ts` gains a pure, unit-tested resolver (`resolveWsReadyTimeoutMs`) — explicit per-call timeout wins, then a new `FRESHELL_E2E_WS_READY_TIMEOUT_MS` env var, then a 30s default that preserves the historical real window (the never-effective 15s would have narrowed local behavior from 30s to 16s and risked new cold-start flakes) — and `waitForConnection` routes its window through it, called in the correct three-argument shape `waitForFunction(fn, undefined, { timeout })` so the timeout actually binds (load-bearing finding LB-1: the historical two-arg call made every explicit window decorative; the real window was Playwright's 30s default). (2) `scripts/e2e-cloud.sh` writes that env var (default 45000 ms, operator-overridable) into every cloud e2e job's env-vars file and documents it in its usage text. (3) A hermetic bash test (new `scripts/test/e2e-harness-timeout-env.test.sh`, following the proven stubbed-gcloud pattern from `scripts/test/cloud-run-wrapper.test.sh`) captures the generated env file and pins the default, the override, and the docs; the kata's own failing invocation (`fresh-agent.spec.ts` + `settings.spec.ts` on the cloud backend) is re-run as acceptance evidence.

**Tech Stack:** TypeScript + Playwright helper classes (e2e harness), Vitest (helper unit tests via `test/e2e-browser/vitest.config.ts` / `npm run test:e2e:helpers`), Bash (cloud lane wrapper `scripts/e2e-cloud.sh`, Cloud Run Jobs env-vars YAML), Google Cloud Run e2e backend.

## Global Constraints

- Never restart or otherwise interfere with the self-hosted production Freshell Rust server on port 3001; no exceptions without explicit user approval (the word "APPROVED").
- Never add `settings.spec.ts` to `CLOUD_SKIP_SPECS` or otherwise skip/mask the affected spec; the fix must be a real mechanism fix. Verification on the cloud backend is mandatory.
- TDD red/green/refactor per task; never reduce coverage, skip tests, loosen assertions, or accept known flakes to obtain green runs.
- The cloud image is content-addressed by commit: the worktree must be clean and committed before any `npm run test:e2e:cloud ...` invocation, or the run pays a full ~7-13 min cold rebuild against a `-dirty` tag.
- Non-interactive shells miss the user's `~/.bashrc` backend exports: export `FRESHELL_VITEST_BACKEND=cloud` / `FRESHELL_E2E_BACKEND=cloud` explicitly when invoking coordinated or cloud lanes, or use the forcing `:cloud` scripts.
- Broad vitest suites (`npm test`, `npm run check`) go through the shared coordinator gate (`npm run test:status`, `FRESHELL_TEST_SUMMARY=...` reason string, wait for foreign holders — never kill them). Focused e2e runs and `npm run test:e2e:helpers` are NOT coordinator-wired.
- Keep kata j90s updated (comments at milestones); close it only when the fix is verified.
- Commits use the repo's existing git identity; do not override git config. No PR creation — the user must approve PRs explicitly.
- This change is test-infrastructure only: no `docs/index.html`, README, or user-facing doc updates are required (per repo guidance, test-infra changes do not update the user-facing mock).

---

### Task 1: Env-scalable `waitForConnection` window in `TestHarness`

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts:19-30` (`waitForConnection`) plus new exports above the class
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new file; runs under `test/e2e-browser/vitest.config.ts`)

**Interfaces:**
- Consumes: `Page.waitForFunction(fn, options)` (`@playwright/test`); `process.env.FRESHELL_E2E_WS_READY_TIMEOUT_MS` (new, defined by Task 2's cloud wiring; absent locally).
- Produces: `export const DEFAULT_WS_READY_TIMEOUT_MS = 30_000`; `export function resolveWsReadyTimeoutMs(explicitMs: number | undefined, env?: Record<string, string | undefined>): number`; `TestHarness.waitForConnection(timeoutMs?: number)` (signature changes from defaulted `timeoutMs = 15_000` to optional `timeoutMs?: number` — strictly parameter-widening, so no call site can break). The 30s default preserves the historical REAL window (Playwright's default, since the old 15s never bound); the never-effective 15s would have narrowed every no-arg call site from a real 30s to 16s. Of the 186 call sites: 179 pass no argument (real window stays ~30s: 31s with slack — no narrowing), six pass `30_000` in restart/recovery specs (`reconnect-revive-rust.spec.ts:705`, `amplifier-lane-resilience-rust.spec.ts:407`, `freshopencode-restart-recovery.spec.ts:420`, `opencode-restart-recovery.spec.ts:538,1117`, `codex-status-completeness-rust.spec.ts:373`) and get a real 31s window (≥ today's real 30s — no regression possible), and one passes `20_000` (`test/e2e-browser/specs/terminal-lifecycle.spec.ts:280`, a forced-reconnect scenario resolving in ~1-2s — honoring its intended 21s window).

Workspace prep (once, before the Red step): from the worktree root run `npm ci --no-audit --no-fund` (expected: clean install; node-pty compiles via node-gyp; postinstall wires the shared pre-push gate).

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/helpers/test-harness.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import {
  DEFAULT_WS_READY_TIMEOUT_MS,
  TestHarness,
  resolveWsReadyTimeoutMs,
} from './test-harness'

const ENV_VAR = 'FRESHELL_E2E_WS_READY_TIMEOUT_MS'

/**
 * A fake Page that records the full argument tuple of each waitForFunction
 * call. The tuple shape IS the contract under test: Playwright's
 * waitForFunction(pageFunction, arg, options) only honors a timeout passed
 * as the third argument. The historical two-arg call bound the timeout
 * object to the predicate's argument, making every explicit window
 * decorative (the real window was Playwright's 30s default — the j90s
 * load-bearing ledger, LB-1).
 */
function fakePage() {
  const calls: unknown[][] = []
  const page = {
    waitForFunction: (...args: unknown[]) => {
      calls.push(args)
      return Promise.resolve()
    },
  }
  return { page: page as unknown as Page, calls }
}

afterEach(() => {
  delete process.env[ENV_VAR]
})

describe('resolveWsReadyTimeoutMs', () => {
  it('defaults to the 30s window that preserves the historical real window when the env var is unset', () => {
    expect(resolveWsReadyTimeoutMs(undefined, {})).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(DEFAULT_WS_READY_TIMEOUT_MS).toBe(30_000)
  })

  it('uses the env value when set and no explicit timeout is given', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '45000' })).toBe(45_000)
  })

  it('lets an explicit per-call timeout win over the env value', () => {
    expect(resolveWsReadyTimeoutMs(20_000, { [ENV_VAR]: '45000' })).toBe(20_000)
  })

  it('falls back to the default for empty, non-numeric, or non-positive env values', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: 'abc' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '0' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '-5' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
  })
})

describe('TestHarness.waitForConnection timeout wiring', () => {
  it('binds the default window (+1s slack) as waitForFunction OPTIONS', async () => {
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(3)
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS + 1000 })
  })

  it('binds the env-scaled window as options when no explicit timeout is given', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: 46_000 })
  })

  it('keeps an explicit timeout authoritative over the env var', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection(20_000)
    expect(calls[0][2]).toEqual({ timeout: 21_000 })
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: FAIL — the suite cannot import `resolveWsReadyTimeoutMs` / `DEFAULT_WS_READY_TIMEOUT_MS` from `./test-harness` (the resolver behavior is absent: the exports do not exist). This is the missing-behavior failure, not a syntax or setup accident. The wiring tests additionally exist to fail against the historical two-arg `waitForFunction(fn, {timeout})` shape (tuple `[fn, {timeout}]` instead of `[fn, undefined, {timeout}]`) — that guard is what makes the LB-1 binding bug un-regressable.

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/test-harness.ts`, add above the `TestHarness` class (below the existing imports):

```ts
/** Default waitForConnection window (ms) used when neither an explicit
 * per-call timeout nor FRESHELL_E2E_WS_READY_TIMEOUT_MS applies. 30s
 * preserves the historical REAL window: the old code passed 15s, but as
 * the predicate's argument (never bound), so the real window was
 * Playwright's 30s default. Binding 15s for real would have narrowed every
 * no-arg call site from 30s to 16s and risked new cold-start flakes. */
export const DEFAULT_WS_READY_TIMEOUT_MS = 30_000

/**
 * Resolve the effective waitForConnection window.
 *
 * Precedence: an explicit per-call timeout wins; otherwise the
 * FRESHELL_E2E_WS_READY_TIMEOUT_MS env var scales the window (the cloud e2e
 * lane sets it — see scripts/e2e-cloud.sh); otherwise the 30s default that
 * preserves the historical real window. Cloud cold starts can need more:
 * the client's 10s ready watchdog (CONNECTION_TIMEOUT_MS,
 * src/lib/ws-client.ts) force-closes a slow handshake and reconnects with
 * jittered 1→2→4s backoff, and the observed j90s flake exceeded a real 30s
 * window. Empty, non-numeric, or non-positive env values fall back to the
 * default — a malformed override must never poison the harness wait.
 */
export function resolveWsReadyTimeoutMs(
  explicitMs: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  if (explicitMs !== undefined) return explicitMs
  const raw = env.FRESHELL_E2E_WS_READY_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_WS_READY_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WS_READY_TIMEOUT_MS
  return parsed
}
```

Then change `waitForConnection` (keep the predicate body byte-identical; note the THREE-argument call — the timeout must land in `options`, not in the predicate's argument slot):

```ts
  /**
   * Wait for WebSocket connection to reach 'ready' state.
   *
   * The timeout is passed as waitForFunction's OPTIONS (third argument).
   * The historical two-arg call bound the timeout object to the
   * predicate's argument, so every explicit window was decorative and the
   * real wait was Playwright's 30s default (empirically confirmed — see
   * the j90s load-bearing ledger, LB-1). The resolved window keeps +1s
   * slack, so the no-arg default lands at 31s — preserving (by 1s of
   * harmless widening) the real 30s window local runs always had.
   */
  async waitForConnection(timeoutMs?: number): Promise<void> {
    const resolvedTimeoutMs = resolveWsReadyTimeoutMs(timeoutMs)
    await this.page.waitForFunction(
      () => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const reduxStatus = harness.getState()?.connection?.status
        return harness.getWsReadyState() === 'ready' && reduxStatus === 'ready'
      },
      undefined,
      { timeout: resolvedTimeoutMs + 1000 },
    )
  }
```

Do NOT touch `waitForHarness` (line 12): it has no WebSocket dependency (the harness installs at first React render) and has never flaked. Its `{timeout: 15_000}` is also decorative (real window: Playwright's 30s default) — fixing its binding now would SHORTEN the real window to 16s and risk brand-new cold-start flakes for zero demonstrated benefit. Left as a follow-up suggestion (see Notes).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: PASS (7 tests: 4 resolver cases, 3 wiring cases).

- [ ] **Step 5: Refactor while green**

The resolver already sits next to its only consumer and matches the file's JSDoc style; no further refactor. State this in the implementer report rather than inventing churn.

- [ ] **Step 6: Run impacted-test verification**

The change modifies a helper class used by ~80 spec files and flips a method signature default. State honestly (load-bearing LB-3): neither `npm run typecheck` nor `npm run lint` covers the e2e tree — tsconfig includes only src/server/shared and eslint lints src — which is how the decorative-timeout shape survived unnoticed. The signature change is strictly parameter-widening (`timeoutMs = 15_000` → `timeoutMs?: number`), so no call site can break at the type level; the real gates are (a) the full e2e-helpers unit suite (all sibling helper tests — includes the new tuple-shape guard) and (b) Task 3's real cloud spec runs. Typecheck and lint still run as cheap guards against accidental cross-tree effects.

Run: `npm run test:e2e:helpers && npm run typecheck && npm run lint`

Expected: PASS (helpers suite fully green — no sibling helper test regressed; typecheck and lint green for the covered trees).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/test-harness.ts test/e2e-browser/helpers/test-harness.test.ts
git commit -m "test(e2e): make TestHarness.waitForConnection window env-scalable (j90s)"
```

---

### Task 2: Cloud lane sets and documents the 45s harness window

**Files:**
- Modify: `scripts/e2e-cloud.sh:486-504` (env-vars file emission) and the usage/env-var documentation block near lines 173-178
- Test: `scripts/test/e2e-harness-timeout-env.test.sh` (new file)

**Interfaces:**
- Consumes: Task 1's `FRESHELL_E2E_WS_READY_TIMEOUT_MS` env var (read by `test-harness.ts` inside the cloud job's Playwright workers); the existing `RUN_ENV_FILE` YAML mechanism (`--env-vars-file` on `gcloud run jobs create`, YAML top-level keys — `CLOUD_RUN_TASK_COUNT`/`CLOUD_RUN_TASK_INDEX` are reserved and must not be set here).
- Produces: every cloud e2e job carries `FRESHELL_E2E_WS_READY_TIMEOUT_MS` (default `45000`, operator-overridable by exporting the var before `npm run test:e2e:cloud`); usage text documents it. `PLAYWRIGHT_ARGS` emission is unchanged.

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/e2e-harness-timeout-env.test.sh` (hermetic: gcloud/docker fully stubbed, modeled on the proven STUB pattern in `scripts/test/cloud-run-wrapper.test.sh`):

```bash
#!/usr/bin/env bash
# Test: e2e-cloud.sh run stamps the cloud-lane harness WS-ready timeout env
# var (kata j90s) onto every created Cloud Run job, honors an operator
# override, and documents the var in usage. Hermetic: gcloud/docker are
# fully stubbed; no network, no real cloud resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# gcloud-robot hermeticity pin (same as cloud-run-wrapper.test.sh): pinning
# GCLOUD_IDENT forces the identity ladder's rung-2 bypass so nothing here can
# reach a real probe/network.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"

SCRIPT="$ROOT/scripts/e2e-cloud.sh"
FAILURES=0

check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

STUB_DIR="$(mktemp -d /tmp/e2e-harness-timeout-stubs.XXXXXX)"
STUB_CAPTURE="$STUB_DIR/capture"
mkdir -p "$STUB_CAPTURE"
export STUB_CAPTURE
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "info "*) echo "/nonexistent-sdk-root"; exit 0 ;;
  "auth print-access-token"*) echo stub-token; exit 0 ;;
  *"artifacts repositories describe"*) exit 1 ;;
  *"artifacts repositories create"*) exit 0 ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*)
    echo "$args" >> "${STUB_CAPTURE:?}/gcloud.args"
    envfile="$(printf '%s\n' "$args" | grep -oP -- '--env-vars-file=\K[^ ]+')"
    if [ -n "$envfile" ] && [ -f "$envfile" ]; then
      cp "$envfile" "${STUB_CAPTURE:?}/env.yaml"
    fi
    exit 0 ;;
  *"run jobs execute"*) exit 0 ;;
  *"executions list"*) echo "exec-stub"; exit 0 ;;
  *"executions describe"*)
    case "$args" in
      *failedCount*) echo "0" ;;
      *succeededCount*) echo "1" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *"logs read"*) echo "  6 passed (4.2s)"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
exit 0
STUB
chmod +x "$STUB_DIR/gcloud" "$STUB_DIR/docker"

echo "=== e2e harness timeout env test ==="

# Check 1: a cloud run's job env file carries the default 45s window.
env PATH="$STUB_DIR:$PATH" bash "$SCRIPT" run --cloud --shards=1 \
  test/e2e-browser/specs/settings.spec.ts >/dev/null 2>&1 || true
check "run jobs create captured an env-vars file" test -f "$STUB_CAPTURE/env.yaml"
check "env file sets FRESHELL_E2E_WS_READY_TIMEOUT_MS to 45000 by default" \
  grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS: "45000"' "$STUB_CAPTURE/env.yaml"
check "env file still carries PLAYWRIGHT_ARGS" \
  grep -q 'PLAYWRIGHT_ARGS' "$STUB_CAPTURE/env.yaml"

# Check 2: an operator override wins over the default.
rm -f "$STUB_CAPTURE/env.yaml" "$STUB_CAPTURE/gcloud.args"
env PATH="$STUB_DIR:$PATH" FRESHELL_E2E_WS_READY_TIMEOUT_MS=60000 \
  bash "$SCRIPT" run --cloud --shards=1 \
  test/e2e-browser/specs/settings.spec.ts >/dev/null 2>&1 || true
check "operator override (60000) lands in the env file" \
  grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS: "60000"' "$STUB_CAPTURE/env.yaml"

# Check 3: usage documents the env var.
check "help documents FRESHELL_E2E_WS_READY_TIMEOUT_MS" \
  bash -c "bash '$SCRIPT' help 2>&1 | grep -q 'FRESHELL_E2E_WS_READY_TIMEOUT_MS'"

# Check 4: the wrapper script itself stays syntactically valid.
check "e2e-cloud.sh passes bash -n" bash -n "$SCRIPT"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILURES CHECK(S) FAILED"
exit 1
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/e2e-harness-timeout-env.test.sh`

Expected: FAIL — three of the suite's six assertions fail on the missing behavior: Check 1's default assertion (env file has no `FRESHELL_E2E_WS_READY_TIMEOUT_MS`), Check 2's override assertion (same absence, so the 60000 grep fails), and Check 3 (usage does not document the var). Check 1's first and third assertions and Check 4 pass already — the file mechanism and script syntax exist; that is expected and is not the missing behavior.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/e2e-cloud.sh`, immediately after the existing `RUN_ENV_FILE` `if/else` block that writes `PLAYWRIGHT_ARGS` (after the `else ... echo 'PLAYWRIGHT_ARGS: ""' > "$RUN_ENV_FILE"` `fi`, before the job-name validation), append the new env var to the same file:

```bash
  # Cloud-lane WS-ready tolerance (kata j90s). The client's 10s ready
  # watchdog (CONNECTION_TIMEOUT_MS in src/lib/ws-client.ts) force-closes a
  # cold-start-slowed handshake and reconnects with jittered 1→2→4s
  # backoff; each missed cycle costs ~11-17s, and the observed j90s flake
  # (PR #772 gate, 2026-09-14) exceeded a real 30s window (the explicit
  # windows were decorative — see test-harness.ts). 45s covers three full
  # watchdog cycles while the 60s per-test Playwright budget still bounds
  # the pathological tail. Override by exporting
  # FRESHELL_E2E_WS_READY_TIMEOUT_MS (ms) before this script.
  echo "FRESHELL_E2E_WS_READY_TIMEOUT_MS: \"${FRESHELL_E2E_WS_READY_TIMEOUT_MS:-45000}\"" >> "$RUN_ENV_FILE"
```

And in the usage/env-var documentation block (the `FRESHELL_E2E_BACKEND` / `FRESHELL_GCP_JOB` listing under the run subcommand's help), add:

```text
  FRESHELL_E2E_WS_READY_TIMEOUT_MS  Cloud-lane TestHarness.waitForConnection
                                    window in ms (default 45000; overrides
                                    the 15s in-code default). Set per-run
                                    job env on `run --cloud`.
```

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/e2e-harness-timeout-env.test.sh`

Expected: PASS — `ALL CHECKS PASSED`.

- [ ] **Step 5: Refactor while green**

No refactor: the emission is one line in the single place that owns per-run job env, and the test is a focused new file following the suite's established pattern. State this in the implementer report.

- [ ] **Step 6: Run impacted-test verification**

The change touches `scripts/e2e-cloud.sh`, exercised by the existing wrapper suite `scripts/test/cloud-run-wrapper.test.sh` (its stubbed cloud path asserts on the same `run jobs create` flags and env file). The suite also contains one real local-Playwright pass-through check — Playwright browsers live in the shared `~/.cache/ms-playwright`, so it runs in the worktree after Task 1's `npm ci`. NOTE: the suite's local-Playwright check triggers `test/e2e-browser/global-setup.ts`, which rebuilds `dist/` — run this suite ONLY inside the worktree, NEVER from the main checkout (the main checkout's `dist/client` is served live by the production Rust server on port 3001; rebuilding or validating there is prohibited without explicit user approval, and it would also validate the wrong tree).

Run (from the worktree root): `bash scripts/test/cloud-run-wrapper.test.sh`

Expected: PASS. If an environment dependency of the real local-Playwright check fails for reasons unrelated to this change (missing browser binary, port conflict), record the exact failure and evidence in the implementer report and STOP — do not work around it by validating from the main checkout; the orchestrator decides how to proceed. The change itself is a one-line YAML emission plus docs.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/e2e-cloud.sh scripts/test/e2e-harness-timeout-env.test.sh
git commit -m "test(e2e): give cloud lane a 45s harness WS-ready window via job env (j90s)"
```

---

### Task 3: Acceptance — the kata's failing cloud invocation goes green on attempt 1

**Files:**
- No new or modified source files. This task produces recorded verification evidence (cloud e2e run output + helpers suite output), stored under the run's logs dir. It may produce no commit; if verification surfaces a defect, fixing it becomes a fixer task with its own focused commit.

**Interfaces:**
- Consumes: Task 1's resolver (running inside the cloud job's Playwright workers via the env var from Task 2), the cloud e2e backend (`scripts/e2e-cloud.sh run --cloud`), the coordinator gate protocol for the broad vitest suite.
- Produces: recorded evidence that (a) the affected spec passes on the configured cloud backend and (b) the repo suite is green at the final HEAD.

- [ ] **Step 1: Confirm clean tree and HEAD**

Run: `git status --porcelain` (expect empty) and `git rev-parse HEAD`

Expected: clean tree (the cloud image must be commit-addressed, not `-dirty`), HEAD = Task 2's commit.

- [ ] **Step 2: Run the kata's failing invocation on the cloud backend**

This mirrors the PR #772 final-tree gate that caught the flake (both specs, same backend). First run may pay one image build for the new commit (~7-13 min); the run itself is minutes after that.

Run (unpiped — a `| tee` pipeline would report `tee`'s exit code and hide a failed run, load-bearing LB-4; the captured exit code is asserted at the end so the block itself fails when the run fails):

```bash
export FRESHELL_E2E_BACKEND=cloud
LOG=/home/dan/code/freshell/.worktrees/.the-usual-logs/j90s-harness-flake/reports/task3-cloud-e2e.log
npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts > "$LOG" 2>&1
cloud_exit=$?
echo "exit=$cloud_exit"; tail -40 "$LOG"
test "$cloud_exit" -eq 0
```

Expected: `exit=0` and the final `test` succeeds; all tests passed, 0 failed; the line reporter shows no `flaky` annotation on the `Expand thinking and Expand tools switches persist locally and reset to defaults` test (attempt-1 pass). Record `exit=` and the passed/failed counts (with the full log path) in the task report.

- [ ] **Step 3: Run the repo full-suite gate at the final HEAD**

Per the repo's test coordination rules: check `npm run test:status` first; if a foreign agent holds the gate, wait for it (never kill). Set a meaningful reason.

Run: `export FRESHELL_VITEST_BACKEND=cloud FRESHELL_TEST_SUMMARY="j90s harness flake fix: final full-suite gate" && npm test`

Expected: full-suite success, exit 0 (baseline at base_ref bab7d518 was green with the identical command; any failure here is attributable to this branch and must be fixed before completion). Immediately after, run the non-coordinated helpers suite and the new bash test at the final HEAD:

Run: `npm run test:e2e:helpers && bash scripts/test/e2e-harness-timeout-env.test.sh`

Expected: PASS for both.

- [ ] **Step 4: Record the gate evidence**

Append to the progress ledger: timestamps, HEAD SHA, exact commands, exit codes, and the cloud run's passed/failed counts (with the full log path). No commit is required for the evidence (it lives in the logs dir); if any check failed, a fixer cycle begins instead.

- [ ] **Step 5: Refactor while green**

Not applicable to a verification-only task; state this in the task report.

- [ ] **Step 6: Impacted-test verification**

This task IS the impacted-test verification for the whole branch (cloud e2e on the affected spec + full vitest suite + helpers suite + script test). Nothing further.

- [ ] **Step 7: Commit the task**

No commit is produced by a passing verification-only task (evidence lives in the logs dir). If a defect was found and fixed, the fixer commits with a focused message and this task's steps re-run.

---

## Verification summary (whole plan)

1. `npm run test:e2e:helpers -- test-harness` — resolver + wiring unit tests (Task 1 focused).
2. `npm run test:e2e:helpers && npm run typecheck && npm run lint` — Task 1 impacted set.
3. `bash scripts/test/e2e-harness-timeout-env.test.sh` — Task 2 focused (red first, then green).
4. `bash scripts/test/cloud-run-wrapper.test.sh` — Task 2 impacted set.
5. `npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts` — the kata's failing invocation, attempt-1 green on the cloud backend (Task 3 acceptance).
6. `npm test` (coordinated, cloud vitest backend) + `npm run test:e2e:helpers` + the new bash test at final HEAD — full-suite gate.

## Notes on scope decisions (evidence-based)

- **The central correction (load-bearing LB-1/LB-2, empirically double-confirmed):** the historical two-arg `page.waitForFunction(fn, {timeout})` call binds the timeout object to the predicate's ARGUMENT — every explicit window in `waitForConnection`/`waitForHarness` was decorative, and the real window was Playwright's 30s default (probes: finder + coordinator, Playwright 1.58.2; two-arg `{timeout: 500}` threw at 30.0s, three-arg at 0.5s). The PR #772 attempt-1 failure therefore exceeded a real 30s window, so the cloud default is 45s (three watchdog cycles at ~11-17s each), not 30s.
- **The in-code default becomes 30s, not the historical 15s** (plan-review round 1, Major): binding the never-effective 15s for real would have NARROWED every no-arg call site's real window from 30s to 16s — the exact new-cold-start-flake risk this plan refuses elsewhere. The 30s default (31s with slack) preserves the actual behavior local runs have always had; only the cloud lane widens (45s) via the env var.
- **Server readiness is not the problem** (kata direction 2 dismissed): the worker-scoped `TestServer` fixture health-gates `/api/health` (30s, 200ms poll) before any navigation; the flaky wait is the post-reload `waitForConnection` inside the test budget. No new readiness signal is needed.
- **`waitForHarness` is deliberately untouched**: its `{timeout: 15_000}` is also decorative (real window: Playwright's 30s default). Fixing its binding would SHORTEN the real window to 16s and risk new cold-start flakes for zero demonstrated benefit — it has never flaked. Recorded as a follow-up suggestion, not scope.
- **Raw two-arg `page.waitForFunction(fn, {timeout})` sites in five specs** (`cfg04-legacy-browser-seed`, `session-13-first-chat-exclusions`, `tabs-client-retire`, `multi-client`, `reconnection`) share the decorative shape; their real 30s windows exceed their intended 15-20s and none flake. Out of scope for the same reason.
- **Explicit-timeout `waitForConnection` callers survive the binding fix** (LB-5, enumerated): six `waitForConnection(30_000)` restart/recovery sites get a real 31s window (≥ today's real 30s — no regression possible); `terminal-lifecycle.spec.ts:280`'s `20_000` becomes a real 21s for a forced-reconnect scenario that resolves in ~1-2s.
- **45s vs the 60s per-test budget (LB-6, accepted residual)**: for the observed recovery class (one slow leg, others fast — fixture leg ~3-5s health-gated, body ~10s), a reload-leg recovery up to ~45s fits within the 60s cap. Pathological both-legs-slow runs die at the same 60s test cap as today — strictly no worse than the status quo. If the flake ever recurs, the available escalation is a per-test `setTimeout` for the affected spec (recorded OPTIONAL, deliberately not built now).
- **Flake rate**: exactly one recorded occurrence (PR #772 gate, 2026-09-14 ~08:29Z, attempt-1 timeout, passed on retry) against five clean cloud executions of the same spec Sep 12–14 — too sparse for a rate estimate; the fix rests on the corrected mechanism (watchdog cycles exceeding the real 30s window), which the binding fix now makes controllable. Evidence reports: `reports/plan-harness-architecture.md`, `reports/plan-cloud-e2e-infra.md`, `reports/load-bearing-finder.md`, `load-bearing-ledger.md` in the run logs dir.
