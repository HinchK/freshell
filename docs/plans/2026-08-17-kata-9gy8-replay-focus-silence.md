# Kata 9gy8 — replay focus-report silencing Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix pre-existing kata `9gy8`: when saved terminal history is replayed to rebuild a pane (page reload, pane refresh, reconnect attach, split-pane open, resize rebinding), xterm.js re-fires the app's "report focus" switch (?1004) whose instruction bytes are inside the replayed chunk and immediately tells the app "you just got focus" — an invented keypress (`ESC[I`, seen live in opencode) the app never asked for. Terminal apps must stop receiving these phantom focus keystrokes during any replay-driven rebuild of a leaf surface.

### Explicit constraints
- Work starts in a dedicated git worktree under `.worktrees/` on a branch based on current `origin/main`; all changes are merged only through an approved PR to `main`.
- Server-side protocol stays exactly as-is; nothing already merged needs changing to support this fix.

### Accepted tradeoffs and residuals
- A genuine focus event that lands *during* an active replay write is also silenced (phantom and real reports are byte-identical; replay time, not bytes, is the only discriminator). This is bounded: the next genuine click/focus change re-reports focus and the app recovers.

**Goal:** After any form of history replay (reload, refresh, reconnect, split, resize rebind), an app that previously armed xterm focus reporting (`?1004h`) must not receive invented `ESC[I`/`ESC[O` input bytes caused purely by the replay — while the arm itself stays intact (`getTerminalModes().sendFocusMode === true`) and live focus reports continue to flow.

**Architecture:** xterm fires `ESC[I`/`ESC[O` synchronously from its parser whenever a `?1004h` arming byte is parsed — including when that byte arrives via history replay. Freshell already wraps every replay write in a write scope (`beginTerminalOutputWriteScope`) carrying `suppressExternalSideEffects: true`, held open until xterm's write callback, so both sync and deferred (WriteBuffer macrotask) parses are covered. The fix adds a narrow gate at the single place where all terminal input leaves the client — the `term.onData` handler — that swallows an exact focus-report payload (`ESC[I` or `ESC[O`) while the current write scope has `suppressExternalSideEffects === true`. The arm itself is unaffected (xterm still tracks the mode; harness must observe `sendFocusMode: true` after replay), live focus reports outside a replay scope pass through unchanged, and nothing else touches input.

**Tech Stack:** TypeScript/React (client), xterm.js, Vitest (unit + server), Playwright (e2e).

## Global Constraints

- Server protocol and code: NO changes (`shared/ws-protocol.ts`, `server/`, `crates/` untouched).
- Do not weaken, skip, or silence assertions in existing tests to make this pass. No code change may avoid the e2e style already established in `test/e2e-browser/specs/multi-client.spec.ts` (ws frame tracer, keyboard-typed arm command, `page.waitForFunction` on harness accessors).
- The gate must cover BOTH `ESC[I` (focused) and `ESC[O` (blurred) — background/hidden pane replays emit the blur variant.
- The swallowed report must not reach ANY of: ws input, `recordPaneTabActivity`, `updateSessionActivity`, or the un-anchored input buffer. The gate must sit before all of them.
- Keep tracked mode state intact: `getTerminalModes().sendFocusMode === true` after replay (arm preserved, report silenced).
- Commit conventional messages (`feat:`, `fix:`, `test:`, `docs:`); verify CI will see clippy/contract/typecheck-client green (no Rust/TS/contract changes expected, but prove it).
- Bypass-the-scope buffering: reports generated while an attach anchor is pending are buffered upstream; the gate must therefore reject the phantom BEFORE the un-anchored fast-path can buffer it (onData entry is that point).

---

### Task 1: Gate predicate in terminal-output-side-effects lib (pure)

**Files:**
- Modify: `src/lib/terminal-output-side-effects.ts`
- Test: `test/unit/client/lib/terminal-output-side-effects.test.ts`

**Interfaces:**
- Consumes: `getTerminalOutputWriteScope(terminalInstanceId)` from `./terminal-output-write-scope.js` (returns `{ suppressExternalSideEffects: boolean, ... } | null`) — tests simulate scopes directly via `beginTerminalOutputWriteScope(...)`, as the existing suite does.
- Produces: `export function isReplayPhantomFocusReport(data: string, terminalInstanceId: string | undefined): boolean` — true exactly when `data === '\u001b[I'` or `data === '\u001b[O'` AND `getTerminalOutputWriteScope(terminalInstanceId)?.suppressExternalSideEffects === true`. No logging inside the helper (caller logs).

- [x] **Step 1: Write the failing behavioral test**

Add a `describe('isReplayPhantomFocusReport')` block with these tests (exact assertions):

1. Swallow: inside `beginTerminalOutputWriteScope({ terminalInstanceId: 't1', source: 'replay', attachRequestId: undefined, generation: 'g', suppressExternalSideEffects: true })`, `isReplayPhantomFocusReport('\u001b[I', 't1') === true` and `isReplayPhantomFocusReport('\u001b[O', 't1') === true`.
2. Pass-through, live scope: with `suppressExternalSideEffects: false`, the predicate is `false` for both byte strings.
3. Pass-through, no scope: outside any scope, predicate is `false`.
4. Pass-through, non-report bytes: with a suppressing replay scope open, `isReplayPhantomFocusReport('a', 't1') === false` and `isReplayPhantomFocusReport('\u001b[?1004h', 't1') === false` (the arm bytes themselves are terminal input bytes going nowhere — but prove arbitrary data is untouched).
5. Cross-instance isolation: open a suppressing scope for 't1', assert `isReplayPhantomFocusReport('\u001b[I', 't2') === false`.
6. Scope completion releases: after `scope.complete()`, the predicate returns `false` for the same input on the same instance id.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/lib/terminal-output-side-effects.test.ts --reporter=basic`

Expected: FAIL — `isReplayPhantomFocusReport` is not exported (`ImportError`/`TypeError`), proving the tests exercise the new predicate rather than a stub.

- [x] **Step 3: Add the minimal production implementation**

```ts
import {
  getTerminalOutputWriteScope,
  type TerminalOutputSideEffect,
  type TerminalOutputSource,
} from './terminal-output-write-scope.js'

const XTERM_FOCUS_IN = '\u001b[I'
const XTERM_FOCUS_OUT = '\u001b[O'

/**
 * xterm fires ESC[I / ESC[O synchronously from its parser every time it
 * parses a ?1004h arm byte — including when that byte arrives via history
 * replay (kata 9gy8). Such a replay-triggered report is a phantom: nothing
 * about user focus changed, and the app receives an invented keypress.
 * The replay write scope (“suppressExternalSideEffects”) is held open until
 * xterm's write callback, which covers both synchronous and deferred parses,
 * so it is the correct discriminator; the exact-bytes check keeps all other
 * input untouched.
 */
export function isReplayPhantomFocusReport(
  data: string,
  terminalInstanceId: string | undefined,
): boolean {
  if (data !== XTERM_FOCUS_IN && data !== XTERM_FOCUS_OUT) return false
  return getTerminalOutputWriteScope(terminalInstanceId)?.suppressExternalSideEffects === true
}
```

(Names of the two constants are the literals shown in red-box form above: `'\u001b[I'` and `'\u001b[O'`.)

- [x] **Step 4: Run the focused test**

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/lib/terminal-output-side-effects.test.ts --reporter=basic`

Expected: PASS (all new tests green, existing suite green).

- [x] **Step 5: Refactor while green**

None expected; helper is a pure predicate with two constants. If the existing suite has a naming pattern for ESC literals, follow it instead of introducing local constants.

- [x] **Step 6: Run impacted-test verification**

The scope lib is self-contained; only the predicate consumer changes in Task 2. Run the two scope-related suites together to prove an unchanged baseline:

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/lib/terminal-output-write-scope.test.ts --reporter=basic`

Expected: PASS.

- [x] **Step 7: Commit the task**

```bash
git add src/lib/terminal-output-side-effects.ts test/unit/client/lib/terminal-output-side-effects.test.ts
git commit -m "feat(terminal): pure predicate for replay-phantom xterm focus reports (kata 9gy8)"
```

---

### Task 1.5: per-instance write-scope stack (closes same-instance overlap leak)

**Files:**
- Modify: `src/lib/terminal-output-write-scope.ts`
- Test: `test/unit/client/lib/terminal-output-write-scope.test.ts`

**Rationale (load-bearing A3):** `activeScopes` is one slot per `terminalInstanceId`; a scope completing out of order can clear the wrong entry (e.g. the synchronous-throw early-complete paths in terminal-write-queue.ts:153-159), letting a later phantom slip the gate. Upgrade the map to an identity-checked stack: `Map<string, TerminalOutputWriteContext[]>`; `beginTerminalOutputWriteScope` pushes; `complete()` removes exactly that context; `getTerminalOutputWriteScope` returns the TOP (last) entry. Known residual (accepted, not widened): if a live scope and a replay scope for the same instance are both open and the replay bytes parse LATE, the gate reads the live top and that one phantom slips — the serializing write queue prevents this on every replay-driven rebuild path; the residual is confined to the queue-null fallback edge.

- [x] Steps (TDD): RED test — begin replay-suppress scope, then begin a non-suppress scope for the same id, complete the inner, assert the outer suppress scope is again active (leak closed); also assert existing behavior (single begin/complete) green. Implement the stack; the existing write-scope test file gets the two new cases plus full-suite stays green.
- [x] Commit: `feat(terminal): per-instance write-scope stack (closes replay-scope overlap leak, kata 9gy8)`

### Task 2: onData gate in TerminalView + lifecycle integration tests

**Files:**
- Modify: `src/components/TerminalView.tsx` (onData handler at the registerTerminalCaptureHandler/connect block, current line ~2294)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (new `describe('replay phantom focus report silencing (kata 9gy8)')`)

**Interfaces:**
- Consumes: `isReplayPhantomFocusReport` from Task 1; existing `terminalInstanceIdRef.current`, `sendInput`, `dispatch(dismissTabGreen)`, `recordPaneTabActivity`, `updateSessionActivity`, `bufferPendingInput` — all already in scope at the onData handler.
- Produces: gate behavior only; no new public API.

- [x] **Step 1: Write the failing behavioral test**

Add a new describe block in the lifecycle suite following the file's existing pattern for replay writes (the `submitAcceptedOutput`-style path used by the modes-sync describe at ~:9659). Tests:

1. **Phantom swallowed on replay, byte-exact.** Mount a pane, arm nothing, drive a replay-mode write through the harness/mock containing the literal byte `\u001b[?1004h` followed by normal text; fire the registered onData handler WHILE the write scope is open: use `term.write.mockImplementationOnce` (or the suite's existing queue-driving spy) so the mock calls the captured `term.onData.mock.calls[0][0]('\u001b[I')` from inside the `write()` implementation — i.e. before the scope's callback completes it (calling onData after write resolves is post-scope and would not exercise the gate). Assert: no `send` call whose payload contains `\u001b[I`, and the mock harness `getSentWsMessages/...` input area is empty of focus bytes.
2. **Activity not disturbed.** Same setup: `recordPaneTabActivity`/session-activity side of the handler did NOT receive the phantom input (assert via the file's existing activity-observation pattern; if none exists, assert the dismissal path not fired for bare `\u001b[I` — it already is a non-engagement byte, the sub-assertion is a no-op regression net).
3. **Ingestion not disturbed for non-report bytes:** same replay chunk carries `\u001b[?1004h` + plain bytes; assert non-focus input from onData during the same scope window is untouched (i.e. gate applied only at the bytes level, not at the write-batch level).
4. **Live pass-through regression.** With NO open replay scope (simulate: normal live write), fire onData `'\u001b[I'` and assert it reaches `send` (input) with exactly `'\u001b[I'`. This pins "live focus reports keep flowing".
5. **Blur variant.** Same as (1) with `'\u001b[O'`: no send, no activity.
6. **Outside-scope wakeup during a LATER replay of same pane:** after the first replay completes a suppress-scope lifecycle, a second replay for the same pane must still swallow (proves no "first-time-only" state).

Concrete code: implementer reuses the file's existing replay-write-driving helper (the same one used to push a `terminal.modes.sync` frame in the existing modes-sync describe); the ONLY new bytes are the acceptance chunk and the onData invocation.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx --reporter=basic`

Expected: FAIL — tests 1, 2, 5, 6 observe `\u001b[I`/`\u001b[O` reaching the outgoing send stream / activity path (no gate exists yet); test 4 (live pass-through) passes pre-fix, and test 3 (non-report bytes) is a pass-through pin that stays green both ways.

- [x] **Step 3: Add the minimal production implementation**

In `src/components/TerminalView.tsx`, inside the `term.onData((data) => { ... })` handler, make the FIRST statement:

```ts
    term.onData((data) => {
      if (isReplayPhantomFocusReport(data, terminalInstanceIdRef.current)) {
        // Kata 9gy8: xterm re-fired a focus report because a replay chunk
        // contained the app's ?1004h arm byte. Nothing about user focus
        // changed; this is invented input. Swallow silently (no send, no
        // activity) — the mode state is untouched.
        log.debug('replay phantom focus report silenced (kata 9gy8)', {
          paneId,
          tabId,
          direction: data === '\u001b[I' ? 'in' : 'out',
        })
        return
      }
      sendInput(data)
      // ...existing engagement/activity logic unchanged
```

Add the import from the canonical source file: `import { isReplayPhantomFocusReport } from '@/lib/terminal-output-side-effects'` (write-scope.js does NOT re-export it today) and use the file's existing logger symbol (`log`, created via `createLogger` at ~:175) — `logClient` does not exist.

- [x] **Step 4: Run the focused test**

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx --reporter=basic`

Expected: PASS (all describe-block tests green; full file stays green).

- [x] **Step 5: Refactor while green**

Keep the gate body minimal; the helper already isolates the predicate. No further refactor.

- [x] **Step 6: Run impacted-test verification**

Everything touching onData/sendInput/write queue path:

Run: `FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts --reporter=basic`

Expected: PASS.

- [x] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminal): swallow replay-triggered phantom xterm focus reports at onData (kata 9gy8)"
```

---

### Task 3: e2e wire proof (multi-client spec)

**Files:**
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

**Interfaces:**
- Consumes: existing ws frame tracer (page.on('websocket')), the keyboard-typed arm pattern (`printf` bytes), `page.waitForFunction` on `window.__FRESHELL_TEST_HARNESS__` accessors (`getSentWsMessages`, `getTerminalModes`), the ws-terminal-modes-sync server's harness-provided FakeRegistry (no server change).
- Produces: one new spec entry proving phantom-free reload.

- [x] **Step 1: Write the failing e2e test**

Add (either as a `test` in the spec's "mode replay-sync" area or a sibling spec; the existing tests at multi-client.spec.ts:605-821 are the template):

1. Create a shell tab.
2. Type `printf '\u001b[?1004h\n'` + Enter (arm focus reporting).
3. `page.waitForFunction(() => window.__FRESHELL_TEST_HARNESS__.getTerminalModes('<terminal-id>')?.sendFocusMode === true)` — arm visible.
4. Reload the page.
5. After reload ready, re-arm verification: `waitForFunction(sendFocusMode === true)` again (replay restored the arm).
6. Assert: no sent ws message observed post-reload whose payload contains `\u001b[I` or `\u001b[O` (use the existing tracer collection pattern / harness sent-messages accessor). Scope the assertion window tightly: start at reload-ready, end at the arm-visible wait plus a short settle (load-bearing A4 — a GENUINE live focus report after the window would be legitimate and must not flake the test; headless runs generate no physical focus events, so the window is deterministic).

Title: `mode replay-sync: replay no longer injects phantom xterm focus reports (kata 9gy8)`.

Red-state proof BEFORE the fix: this test's step 6 currently FAILS on any leg where the arm byte lands in the retained window with the pane focused (the failing assertion is a ghost input frame; if a leg happens to be green due to a pane-focus race, the unit tests in Task 2 are the deterministic red).

- [x] **Step 2: Run the e2e and verify behavior**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/multi-client.spec.ts -g "9gy8"`

Expected: test runs on all three legs; pre-fix (or via assertion shape) shows phantom input; post-fix no phantom on any leg.

- [x] **Step 3: Refactor while green**

Share the tracer-verify helper with the existing mode-sync tests if one exists; otherwise duplicate minimally.

- [x] **Step 4: Run stable-e2e verification**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/multi-client.spec.ts -g "mode replay-sync"`

Expected: PASS all 6 prior tests plus the new one.

- [x] **Step 5: Commit the task**

```bash
git add test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(e2e): wire proof that replay no longer injects phantom focus reports (kata 9gy8)"
```

---

### Task 4: bookkeeping (plan-status + kata comment + contract update)

**Files:**
- Modify: `docs/plans/2026-08-17-terminal-mode-replay-sync.md` (status box only, noting 9gy8 as SILENCED/residual)
- Modify: `test/e2e-browser/specs/multi-client.spec.ts` line ~731 comment (residual now fixed)

- [x] **Step 1: Update the plan-status box**

In the mode-replay-sync plan, add to its Stage-6/update area: `kata 9gy8 = SILENCED` with a link to this plan's branch commit SHA.

- [x] **Step 2: Update the spec comment**

At multi-client.spec.ts:731-733 (the comment that says the sync preamble never fires and the replay path retains the focus-report bug), update the residual note: sync still never emits `?1004`, and replay no longer injects phantom reports via kata 9gy8. Reference the new test title.

- [x] **Step 3: Kata comment**

`kata comment 9gy8 -m "Fix implemented in worktree kata-9gy8-focus-silence / branch the-usual/kata-9gy8-focus-silence + PR review; tests pin no phantom input at unit + e2e levels. Close after merge."`

- [x] **Step 4: Commit**

```bash
git add docs/plans/2026-08-17-terminal-mode-replay-sync.md test/e2e-browser/specs/multi-client.spec.ts
git commit -m "docs: kata 9gy8 silenced; update spec residual comment"
```

---

## Self-review checklist

1. **Spec coverage:** phantom swallow on reload/refresh/reconnect all map to the same gate; both live and replay edges tested (Tasks 1-2); wire-level e2e proof (Task 3); tracked mode intact (Task 1 test 4 arm-bytes distinction; Task 3 waits).
2. **No silent deferrals:** none — every behavior change is tested; no stubs, mocks, or fake providers in production code.
3. **File/interface consistency:** exact paths specified; new predicate consumed from one place; existing helper (`getTerminalOutputWriteScope`, `beginTerminalOutputWriteScope`) signatures reused untouched.
4. **Executable tests:** every test has an exact command and expected outcome; reds proven for unit (export missing → ImportError) and lifecycle (assert sees phantom before gate); e2e red is leg-dependent (unit tests are the deterministic red).
5. **Placeholder scan:** none — no TBD/TODO; assertions are concrete strings and byte comparisons.
6. **Operational completeness:** debug log at debug level (off by default, per AGENTS.md); no user-facing UI, so no docs/index.html change; no AGENTS.md contract change; CI gates (clippy for Rust — no Rust touched; typecheck-client must pass; contract inventory untouched — no new ws message types added; lint: the file's existing `log` (createLogger) import pattern is reused; relative-vs-alias imports follow the file's existing imports).
