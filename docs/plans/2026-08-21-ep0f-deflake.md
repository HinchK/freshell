# ep0f Deflake: logger.separation + terminal-registry Load Flakes Implementation Plan

> **For agentic workers:** REQUIRED: Use the usual-subagents (subagent-driven-development / executing-plans) and the-usual TDD (test-driven-development) subskills to implement this plan task-by-task and subtask-by-subtask. Steps use checkbox (`- [ ]`) syntax for tracking.

## User Request

### Requested result
Root-cause and fix the two load-sensitive test flakes (kata ep0f families, newly observed in the rust-sidecar-sdk-0-3 final gates):
1. `test/integration/server/logger.separation.test.ts` (exit-before-flush race: probes `process.exit(0)` on a fixed 25/50ms timer can fire before rotating-file-stream's lazy open + async first write lands, leaving zero-byte files that burn the full 30s `waitForFileContent` gate).
2. `test/unit/server/terminal-registry.test.ts:3317` (`vi.waitFor` default 1000ms cap wraps a REAL nested worker_thread spawn + 12.5 GB opencode DB open on this dev host — measured 222ms idle ≈ 4.5× headroom the load lottery destroys).
Land as ONE branch (`the-usual/ep0f-deflake`) with a PR per repo rules.

### Features
For each flake: a precise root-cause fix (not timeout-widening), stress-loop verification under induced load, coordinated full-suite gate, kata ep0f advanced.

## Goal

Make the two suites deterministic under load by removing the two terminal/timing races, with zero production-code changes. Evidence: focused suites green repeatedly under induced load (registry focused `-t` ×50, registry full-file ×5, logger full-file ×20), coordinated full-suite pass at final HEAD (cloud backend), and kata ep0f updated with the fix + receipts.

## Determinism Guard

No `Date.now()`/timing-based production behavior changes are introduced by this plan at all (test-only changes). Tests must not depend on real time where avoidable: the registry fix removes real-time dependence (mocked classifier); the logger fix replaces a fixed sleep-before-exit with a poll-for-actual-condition (property-based waiting).

## Architecture

- `test/unit/server/terminal-registry.test.ts` gains a file-wide `vi.mock('../../../server/coding-cli/providers/opencode-subagent-query.js', ...)` mirroring its two sibling files, with `mockResolvedValue(false)` established inside a describe-local `beforeEach` of the `resumeTargetIsSubagent` block (NOT in the factory — see Global Constraint 8).
- `test/integration/server/logger.separation.test.ts` rewrites the three probe bodies (`SOURCE_LOGGER_PROBE`, `DIST_LOGGER_PROBE`, `LOG_LEVEL_PROBE`) to self-poll for their own expected record using the already-exported `resolveDebugLogPath()` (`server/logger.ts:95`, side-effect-free) and exit only when it lands (cap ~10s, `PROBE-FATAL` marker otherwise); and hardens `waitForFileContent` to dump the logDir listing+sizes on timeout.
- Zero production file changes. The plan's verification gauntlet uses induced-load stress loops plus the coordinated suite (cloud backend, works again 2026-08-21).

## Tech Stack

**Runtime:** Node ≥20.19, Vitest 3.2.4, pino 9.14, rotating-file-stream 3.2.9, node:worker_threads, node:sqlite

**Skills:** the-usual-beta (this run pipeline incl. focused repair loop after any FAILED delta round), test-driven-development (inverted: for test-only fixes RED = induced-load stress repro + recorded failure, GREEN = repeated loaded green), executing-plans (order + receipt discipline).

## Focus Profiles

Always verify the deterministic properties (no zero-byte debug files; flag cleared within microtasks) before edge-case polish. Terminal-condition removal beats margin-widening.

## Prior Art Available

Key verified facts (proven by mechanism + strategy reports in `.worktrees/.the-usual-logs/ep0f-deflake/reports/`):
- Logger probes race: `logger.ts:225-231` (rfs lazy open) + `logger.ts:346` (first write async threadpool) vs probe `setTimeout(process.exit(0), 25)` — under load the write never lands; `waitForFileContent` treats empty as not-yet and burns 30s.
- `resolveDebugLogPath()` export exists at `server/logger.ts:95` and re-reads mutated `process.argv`/env at call time — probes can self-verify without production changes.
- pino multistream `flushSync()` delegates to `stream.flushSync()`; rfs 3.2.9 implements none → no awaitable flush. rfs `'open'` ≠ drained. (No flush-based fix possible.)
- Registry flake: `bindSession` fire-and-forget `void isOpencodeSubagentSession(...)` (`terminal-registry.ts:4892`) → nested worker spawn (`opencode-by-id-runner.ts:66-115`, 15s outer cap) + 12.5 GB DB open; `vi.waitFor` default `interval=50, timeout=1000` (vitest 3.2.4). Result correctness is constant-false on ANY host; only arrival time flakes. Mock is behavior-preserving.
- Mock-safety audit (strategy doc): the ONLY classifier consumer in `terminal-registry.test.ts` is the :3317 test; create/list never invoke it; sibling files' mocks are file-scoped.
- Existing deterministic precedents: `terminal-registry.bind-reclassify-guard.test.ts:14-16`, `terminal-registry.rebind-metadata-resync.test.ts:17-19`; real-path coverage lives in `test/unit/server/coding-cli/opencode-subagent-query.test.ts`.
- `stress-ng` NOT installed; load recipe = 48 timeout-bounded CPU burners + 3–4 parallel vitest lanes (see Task 3).
- Cloud vitest backend healthy again (base-gate cloud run green at exact scratch `origin/main`; run-state stage-0 ledger).

## Global Constraints

1. **No production changes.** Both fixes are test-file-only edits. If a fix seems to need a `server/` change, stop and surface.
2. **Never widen timing budgets to "fix" a flake.** Logger: no bump to `FILE_CONTENT_TIMEOUT_MS` or probe delays; Registry: no bump to the `vi.waitFor` timeout. (Rejected hypotheses per strategy doc.)
3. **No raw `npx vitest`.** All vitest via `npm run test:vitest -- run <file> [--config config/vitest/vitest.server.config.ts]`; broad runs via `npm test` (coordinator). Env backends: cloud default (unset); do NOT export overrides.
4. **Process safety:** induced-load burners use individually-timeout-capped recording PIDs; stop via recorded PIDs only; no pkill patterns, no foreign-process kills.
5. **No behavior loss:** keep both-directions coverage claims honest (registry sibling files), keep the `concurrent launches` logger test truly concurrent, keep real-path classifier coverage in `opencode-subagent-query.test.ts`.
6. **Do not touch the other ep0f families** (remote-proxy, opencode-serve-manager, codex-session-flow) — tracked for later episodes.
7. **Commit at major checkpoints** (plan, corrections, per task); no pushes until the run converges.
8. **Registry mock placement (critical):** the enclosing `describe('TerminalRegistry')` beforeEach (`test/unit/server/terminal-registry.test.ts:2076-2092`) calls `vi.resetAllMocks()` (and re-establishes node-pty at :2080-2089). An implementation set INSIDE the `vi.mock` factory would be wiped before every test, making `bindSession` throw `undefined.then` synchronously. MUST set `vi.mocked(isOpencodeSubagentSession).mockResolvedValue(false)` in a describe-local `beforeEach` (runs after the outer reset) — mirror sibling files.
9. **Mock specifier verbatim:** `'../../../server/coding-cli/providers/opencode-subagent-query.js'` (trailing `.js`, matches siblings and the import in `terminal-registry.ts:27`).
10. **RED receipts:** each task's RED must be captured (induced-load repro log or the kata-recorded failure + margin measurement fallback). Never claim a fix without a recorded pre-fix failure mode.
11. **Secrets:** none. Do not read `.env` or credentials.

## Skills Integrity

Skill protocols in this plan are fixed by reference (the-usual-beta at `~/.config/opencode/skills/the-usual-beta/`, TDD + executing-plans). Remediation actors must not weaken tests, skip gates, or bypass review loops to silence failures.

---

## Tasks

### Task 1: terminal-registry — hermetic classifier mock (root cause)

**Files to change:**
- `test/unit/server/terminal-registry.test.ts` — add import + file-wide `vi.mock` (verbatim specifier, Constraint 9) + describe-local `beforeEach` with `mockResolvedValue(false)` (Constraint 8); rewrite the stale comment at :3325-3327 to state classification is mocked constant-false.
- `test/unit/server/terminal-registry.bind-reclassify-guard.test.ts` — reword header note (:7-16): the separation exists because that file needs deferred/controlled resolution, and the main file now mocks constant-false (not "the main file depends on the REAL classifier"). Comment-only.

**Test plan (inverted TDD):**
- RED: under induced load (Task 3 recipe), loop the focused test until a `Timed out in waitFor!` failure (expect within ~10 iterations at loadavg ≥ 50). Fallback RED: kata ep0f recorded failure + the 222ms-vs-1000ms margin measurement (both documented). Capture log into the run ledger.
- GREEN: post-fix, same focused command ×50 under load — all pass, first-poll resolution; full file ×5 under load + ×1 quiet; sibling files ×3 each under load.

**Steps:**
- [x] Read `test/unit/server/terminal-registry.test.ts` around :3293-3336 and the two sibling mock blocks; verify the strategy's audit (no other classifier consumer).
- [ ] Apply the edit: top-of-file import of `isOpencodeSubagentSession`; `vi.mock` factory returning `{ isOpencodeSubagentSession: vi.fn() }`; describe-local `beforeEach` in the `resumeTargetIsSubagent` describe setting `mockResolvedValue(false)`; comment rewrite.
- [ ] Verify: quiet focused + full file; then the loaded stress loops (Task 3).
- [ ] Reword sibling header comment.
- [ ] Commit: `test(terminal-registry): hermetic opencode-subagent classifier mock — removes real 12.5GB-DB worker spawn from vi.waitFor 1s window (kata ep0f)`

**Risks:** the reset-interplay trap (Constraint 8) — GREEN loop catches it if missed (synchronous throw, not a flake).

### Task 2: logger.separation — flush-before-exit probes + timeout diagnostics (root cause)

**Files to change:**
- `test/integration/server/logger.separation.test.ts` — probe bodies + `waitForFileContent` diagnostics only.

**Test plan (inverted TDD):**
- RED: land the diagnostics change first (its own pre-commit) so any loaded-stress repro self-classifies; loop the file ×20 under induced load (Task 3 recipe) until a failure shows the `development.source-mode` file absent/zero-size while `production.dist-mode` has content (or probe server.log shows the process exited at ~25ms). Fallback RED: kata-recorded failure + mechanism report. Runtime fallback if flake refuses to reproduce: an UNCOMMITTED throwaway edit shrinking probe delays to 0 demonstrates exit-before-flush deterministically (then revert/rewrite properly).
- GREEN: post-fix, file ×20 under induced load all green with both file waits finishing in seconds; ×1 quiet (~37s baseline); no `PROBE-FATAL` in any `server.log`.

**Steps:**
- [ ] **2a (diagnostics first, own commit):** on timeout, `waitForFileContent` includes `fsp.readdir(path.dirname(filePath))` + per-file `fsp.stat` sizes in the thrown message.
- [ ] Commit 2a: `test(logger.separation): dump logDir listing+sizes on content-wait timeouts (kata ep0f)`
- [ ] **2b:** rewrite all three probes: source/dist poll for their own `resolveDebugLogPath()` output containing `Resolved debug log path`; log-level probe polls its `LOG_DEBUG_PATH` file for `error-level console and file`. Poll interval ~100ms, cap ~10s; on cap expiry write `PROBE-FATAL: record never landed in <path>` to stderr and `process.exit(1)`; on success `process.exit(0)`. No extra output on success (preserve the negative-output assertions at :175-178).
- [ ] Use `Promise.all` for the two sequential file waits in the failing test (halves worst-case gate burn) — neutral to correctness.
- [ ] Commit 2b: `test(logger.separation): probes exit only after their debug record is on disk — kills exit-before-flush race (kata ep0f)`

**Risks:** probe string edits compile through the same tsx `-e` pipeline; 10s cap sits far under the 120s test budget; the only new failure mode is an informative `PROBE-FATAL` (gate burns once with diagnostics attached).

### Task 3: verification gauntlet + close-out (no new code)

**Steps:**
- [ ] Load recipe: `for i in $(seq 1 48); do timeout 3600 bash -c 'while :; do :; done' & echo $! >> /tmp/ep0f-burners.pids; done` (self-terminating ≤60min each); plus 3–4 parallel focused vitest lanes for the two suites. Record PIDs in the run ledger; stop ONLY via those PIDs.
- [ ] Execute RED (Task 1 before Task 1's edit; Task 2 after 2a, before 2b) — capture into `.worktrees/.the-usual-logs/ep0f-deflake/`.
- [ ] Execute GREEN per task specs.
- [ ] Re-stress both suites back-to-back post-Task-2 (full sequence once more under load).
- [ ] `npm run test:status` → coordinated full suite at final HEAD (cloud default backend). Also run the unit default config (registry file lives there) coverage via `npm run test:unit` in cloud (or per coordinator defaults).
- [ ] `npm run lint` on changed files; `npx tsc --noEmit` (or repo typecheck) on the test files.
- [ ] Update kata ep0f: comment the two fixes + receipts; body acceptance note that these two families are closed pending sustained green runs; kotlin leave remote-proxy/opencode-serve/codex-flow rows open.
- [ ] Executed marker + recap + outcome block (the-usual-beta format; focused-loop accounting only if it ran).

## Success Criteria

1. Logger probes cannot exit before their own record lands on disk (termination condition = the test's own assertion).
2. Registry :3317 test no longer spawns worker threads or touches the host opencode DB; first `waitFor` poll passes.
3. Focused suites green repeatedly under induced load (×50 / ×5 / ×20) + full-file passes quiet.
4. Coordinated full suite green at final HEAD (cloud backend; any surviving failure must be a DIFFERENT ep0f-family flake and gets ledgered, not fixed here).
5. Lint/types clean; kata ep0f advanced; zero production-file changes in the final diff.
