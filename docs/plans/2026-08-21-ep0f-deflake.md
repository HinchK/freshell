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
3. **No raw `npx vitest`.** All vitest via `npm run test:vitest -- run`; EVERY focused command in this plan MUST pass `--config config/vitest/vitest.server.config.ts` explicitly (validated: both target files sit under that config's `include` globs, `test/unit/server/**` + `test/integration/server/**`). Never pass a bare `run <file>` without it: the wrapper prepends its own `run --config` phase and a trailing bare `run <file>` degrades into an extra filename FILTER matching unrelated `*run*` suites — contaminating the stress loops with out-of-scope tests (round-3 Major). Env backends: unset means LOCAL (repo dispatch selects cloud only when FRESHELL_VITEST_BACKEND/FRESHELL_E2E_BACKEND=cloud). The final full-suite gate pins cloud EXPLICITLY (`FRESHELL_VITEST_BACKEND=cloud npm test`) because full-suite local runs on this heavily-loaded multi-agent host are themselves flake-lotteries; the scratch base-gate validated cloud green at a clean origin/main.
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
- RED: under induced load (Task 3 recipe), loop the focused test until a `Timed out in waitFor!` failure: `npm run test:vitest -- run test/unit/server/terminal-registry.test.ts --config config/vitest/vitest.server.config.ts -t "resumeTargetIsSubagent"` (matches the describe block; contains exactly the test under study — post-rename the bare `'re-classifies ...'` selector no longer matches; this selector survives the rename; expect a failure within ~10 iterations at loadavg ≥ 50). Fallback RED: kata ep0f recorded failure + the 222ms-vs-1000ms margin measurement (both documented). Capture log into the run ledger.
- GREEN: post-fix, SAME command ×50 under load — all pass, resolving within one waitFor interval; full file ×5 under load + ×1 quiet; sibling files ×3 each under load (all with the mandatory server --config).

**Steps:**
- [x] Read `test/unit/server/terminal-registry.test.ts` around :3293-3336 and the two sibling mock blocks; verify the strategy's audit (no other classifier consumer).
- [ ] Apply the edit: top-of-file import of `isOpencodeSubagentSession`; `vi.mock` factory returning `{ isOpencodeSubagentSession: vi.fn() }`; describe-local `beforeEach` in the `resumeTargetIsSubagent` describe setting `mockResolvedValue(false)`; comment rewrite.
- [ ] Rename the :3317 test for honest coverage claims (round-2 Minor disposition): drop the 'both directions' phrase (a constant-false mock exercises only child->root clearing; real both-direction coverage lives in `terminal-registry.rebind-metadata-resync.test.ts` — say so in the test's comment). New name along the lines of `clears resumeTargetIsSubagent when bindSession retargets from child to root`.
- [ ] Verify: quiet focused + full file; then the loaded stress loops (Task 3).
- [ ] Reword sibling header comment.
- [ ] Commit: `test(terminal-registry): hermetic opencode-subagent classifier mock — removes real 12.5GB-DB worker spawn from vi.waitFor 1s window (kata ep0f)`

**Risks:** the reset-interplay trap (Constraint 8) — GREEN loop catches it if missed (synchronous throw, not a flake).

### Task 2: logger.separation — flush-before-exit probes + timeout diagnostics (root cause)

**Files to change:**
- `test/integration/server/logger.separation.test.ts` — probe bodies + `waitForFileContent` diagnostics only.

**Test plan (inverted TDD):**
- RED: land the diagnostics change first (its own pre-commit) so any loaded-stress repro self-classifies; loop the file ×20 under induced load (Task 3 recipe) until a failure shows the `development.source-mode` file absent/zero-size while `production.dist-mode` has content (or probe server.log shows the process exited at ~25ms). Fallback RED: kata-recorded failure + mechanism report. Runtime fallback if flake refuses to reproduce: an UNCOMMITTED throwaway edit shrinking probe delays to 0 demonstrates exit-before-flush deterministically (then revert/rewrite properly).
- GREEN: post-fix, file ×20 under induced load all green with both file waits finishing in seconds; ×1 quiet (~37s baseline); per-test assertions verify probe exitCode===0 and no `PROBE-FATAL` in captured output (Task 2b steps).

**Steps:**
- [ ] **2a (diagnostics first, own commit):** on timeout, `waitForFileContent` includes `fsp.readdir(path.dirname(filePath))` + per-file `fsp.stat` sizes in the thrown message, AND accepts an optional captured-output payload so EVERY probe-spawning test (single-probe ones included) attaches its `proc.readOutput()` to the thrown message (the PROBE-FATAL marker is then observable precisely when the fatal branch fires — the round-2/round-3 Minors' reachability defect). The single-probe tests gain the same exit/output assertions as the multi-probe ones (round-3 Minor: 'per-test' means per-test).
- [ ] Commit 2a: `test(logger.separation): dump logDir listing+sizes on content-wait timeouts (kata ep0f)`
- [ ] **2b:** rewrite all three probes: source/dist poll for their own `resolveDebugLogPath()` output containing `Resolved debug log path`; log-level probe polls its `LOG_DEBUG_PATH` file for `error-level console and file`. Poll interval ~100ms, cap ~10s; on cap expiry write the `PROBE-FATAL: record never landed in <path>` marker via `fs.writeFileSync(2, ...)` (synchronous fd write — a piped `console.error` is NOT guaranteed delivered before `process.exit(1)`; round-2 Minor disposition) and then `process.exit(1)`; on success `process.exit(0)`. No extra output on success (preserve the negative-output assertions at :175-178).
- [ ] Use `Promise.all` for the two sequential file waits in the failing test (halves worst-case gate burn) — neutral to correctness.
- [ ] Make the GREEN criterion observable in-test: in each multi-probe test, after the content waits pass, poll each probe's `proc.process.exitCode !== null` (up to 5s), assert `exitCode === 0`, and assert `proc.readOutput()` (harness-captured stdout+stderr) contains no `PROBE-FATAL`. (Prior wording — 'no PROBE-FATAL in any server.log' — was unobservable: afterEach deletes the stderr dirs before any check could run; green would have been a phantom.)
- [ ] Commit 2b: `test(logger.separation): probes exit only after their debug record is on disk — kills exit-before-flush race (kata ep0f)`

**Risks:** probe string edits compile through the same tsx `-e` pipeline; 10s cap sits far under the 120s test budget; the only new failure mode is an informative `PROBE-FATAL` (gate burns once with diagnostics attached).

### Task 3: verification gauntlet + close-out (no new code)

**Steps:**
- [ ] Load recipe: `BURN_PIDFILE=$(mktemp /tmp/ep0f-burners-XXXXXX.pids)` (fresh unique file per session; path recorded in the run ledger); `for i in $(seq 1 48); do timeout 3600 bash -c 'while :; do :; done' & echo $! >> "$BURN_PIDFILE"; done` (each burner individually self-terminating ≤60min); plus 3–4 parallel focused vitest lanes. Cleanup is a separate explicit step below: kill ONLY PIDs listed in $BURN_PIDFILE, each ownership-checked via `ps -fp` (must show our `while :; do :; done` bash) before signaling.
- [ ] Execute RED (Task 1 before Task 1's edit; Task 2 after 2a, before 2b) — capture into `.worktrees/.the-usual-logs/ep0f-deflake/`.
- [ ] Execute GREEN per task specs.
- [ ] Re-stress both suites back-to-back post-Task-2 (full sequence once more under load).
- [ ] Cleanup: ownership-checked kill of all burner PIDs from $BURN_PIDFILE BEFORE the final full-suite gate; confirm load decay via `uptime`; remove the pidfile.
- [ ] Coordinated full suite at final HEAD with the backend pinned explicitly: `FRESHELL_VITEST_BACKEND=cloud npm test`. Ledger records the pinned env + coordinator holder/test receipts.
- [ ] Honest statics-verification statement (round-2 Major disposition): the repo's standard typecheck/lint paths have no coverage of these two test files (eslint flat config globs `src/**` only; the repo typechecks via tsconfig.json/tsconfig.server.json which exclude `test/**`; five e2e-browser `tsconfig.*-check.json` configs do cover `test/e2e-browser/**` but not these files), and a scoped `tsc` over the two edited files cannot be made to pass without weakening the compiler into dishonesty (pre-existing test debt: extensionless imports, harness child-process cast, an intentional import of a deleted module). Therefore: NO tsc/eslint-based verification is claimed for these test files; static fitness is established by (a) the real suite executions in the stress loops each of which transpiles every edited line and runs every line on the success paths, and (b) new lines written in the same local typing style as their neighbors. The FAILURE branches (PROBE-FATAL marker write + exit 1; the waitForFileContent diagnostics throw) do NOT execute on green runs — they were exercised once each as manual receipts: (i) mechanical replication of the probe fatal branch (rc=1, marker delivered via writeFileSync(2); receipt in the run ledger), (ii) a throwaway uncommitted edit forcing an unsatisfiable wait inside the real harness (thrown error contained the 'LogDir contents' size listing and the 'Captured probe output' section; receipt in the run ledger; edit restored). Follow-up (not in scope): file a repo-hygiene kata noting test/ files sit outside both eslint and tsconfig coverage.
- [ ] Update kata ep0f: comment the two fixes + receipts; note in the kata that these two families are fixed pending sustained green runs; leave remote-proxy/opencode-serve/codex-flow rows tracked-open.
- [ ] Executed marker + recap + outcome block (the-usual-beta format; focused-loop accounting only if it ran).
- [ ] Landing sequence (User Request requires a PR per repo rules): push `the-usual/ep0f-deflake` with full provenance AFTER the run converges; notify the user the branch is PR-ready and STOP for explicit approval; only after approval `gh pr create` target main (danshapiro account), watch required checks green, merge per repo policy (self-merge), fast-forward local main, retire worktree+branch per the merge checklist. The push and PR-approval blocks are mandatory; the plan is not 'done' at gate green.

## Success Criteria

1. Logger probes cannot exit before their own record lands on disk (termination condition = the test's own assertion).
2. Registry :3317 test no longer spawns worker threads or touches the host opencode DB; the waitFor condition passes on its first interval evaluation (~50ms). Honesty note (round-1 Minor): vi.waitFor's initial synchronous evaluation may still observe the stale flag because the mock's resolve lands one microtask later — the condition is then constant and time-independent of host load, which is the actual acceptance property.
3. Focused suites green repeatedly under induced load (×50 / ×5 / ×20) + full-file passes quiet.
4. Coordinated full suite green at final HEAD (cloud backend; any surviving failure must be a DIFFERENT ep0f-family flake and gets ledgered, not fixed here).
5. kata ep0f advanced; zero production-file changes in the final diff. Statics-hygiene honest statement (round-3 Minor): the repo has no lint/typecheck coverage of test/** (kata f884); no such claim is made for these changes — static fitness is established by the executed stress suites, all of which transpile+run every edited line every iteration.
