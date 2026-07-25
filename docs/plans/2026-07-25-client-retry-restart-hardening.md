# Client-Side Retry + Restart-Signal Hardening (Lane C) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the freshell web client survive server restarts without dead-end panes or swallowed turn-complete chimes: bounded retry for launch-time `INVALID_TERMINAL_ID` (gap F9/G5, P0), a `serverInstanceId` fallback restart signal when `bootId` is absent (gap F2/G10), and dedupe-baseline resets that fire on both restart signals and idempotently on first-ready (gap F10/G11).

**Architecture:** All three fixes are client-only (React/Redux, `src/`). Fix 1 generalizes the existing rate-limit retry scheduler in `TerminalView.tsx` and routes launch-time `INVALID_TERMINAL_ID` through it, keyed on the SAME `createRequestId` with the restore flag re-armed. Fixes 2+3 restructure the ~35-line `'ready'` restart-detection block in `App.tsx`: parse-failure guard, `serverInstanceId` fallback, loud logging, and a widened dedupe-reset condition. Three new Playwright rust-only e2e specs prove the behavior against real abrupt server restarts.

**Tech Stack:** React 18, Redux Toolkit, Zod, Vitest + Testing Library (unit), Playwright + `RustServer` fixture (e2e).

## Global Constraints

- Base: `origin/main @ 2bf579e6`. Worktree: `/home/dan/code/freshell/.worktrees/client-retry-restart-hardening`, branch `fix/client-retry-restart-hardening`. All commands below run from the worktree root.
- SCOPE FENCE: you own `src/components/TerminalView.tsx` (retry/error blocks), `src/App.tsx` (`:900-960` region + schema), `src/store/turnCompletionSlice.ts` (no changes ended up needed there — its reducer semantics are already correct and pinned; the wiring lives in App.tsx). Do NOT touch `crates/` (Lanes A/B/D/E own them; read-only), do NOT touch the frozen legacy `server/` tree, no kimi/gemini/opencode changes.
- Red-Green-Refactor TDD for every change. Never skip the failing-test run.
- E2E specs spin up their OWN rust servers via `test/e2e-browser/helpers/rust-server.ts` (`RustServer`, ephemeral ports via `findFreePort`). NEVER ports 3001/3002 (the user's LIVE servers). NEVER restart the user's self-hosted server. NEVER broad kill patterns.
- Broad test runs go through the coordinator: set `FRESHELL_TEST_SUMMARY`, check `npm run test:status`, WAIT if another agent holds the gate (four sibling lanes run concurrently).
- Server-side TS uses NodeNext ESM (`.js` extensions on relative imports). The files touched here are client/`test` side; e2e spec files under `test/e2e-browser/` DO use `.js`-suffixed relative imports (match the existing specs).
- `npm run lint` must pass for any UI change (a11y rules). No UI markup is added by this plan, but run lint anyway.
- PR POLICY: NOT yet approved. Push the branch, STOP before `gh pr create`, report branch + red→green proof.
- Cross-lane contract (campaign §4.3): the launch retry loop built here is "the named retryer" that a future lane will point `SESSION_RESERVED{retryAfterMs}` at. Do NOT implement `SESSION_RESERVED`/`INDEX_WARMING` handling now; just keep the scheduler a single generic mechanism (one counter, one timer) rather than an INVALID_TERMINAL_ID-specific one.
- Commit message trailer for every commit:

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

## Reference map (current code, verified at 2bf579e6)

- `src/components/TerminalView.tsx` (4593 lines):
  - retry constants `:155-157` (`RATE_LIMIT_RETRY_MAX_ATTEMPTS = 5`, `RATE_LIMIT_RETRY_BASE_MS = 2000`, `RATE_LIMIT_RETRY_MAX_MS = 12000`, all exported), retry ref `:568`, `clearRateLimitRetry` `:2733-2740`, `scheduleRateLimitRetry` `:2798-2814`, `sendCreate` `:2759-2796`, restore-flag peek wrapper `getRestoreFlag` `:2749`, `ensure()` `:2896`, `failLaunch` `:2900-2928`, `settleCleanRestoreStartupExit` `:2930-2960`, `terminal.created` handler clears restore flag at `:3694`, exit-during-launch `failLaunch` call `:3816`, generic create-error handler (`RATE_LIMITED` retry entry) `:3995-4024`, INVALID_TERMINAL_ID guard `:4026-4040`, other-terminal filter `:4061`, `failedDuringLaunch` block `:4069-4088` (**fix target**), `status !== 'exited'` no-auto-respawn rule `:4092`, unmount cleanup `:4347-4355`.
- `src/lib/terminal-restore.ts` (86 lines): non-destructive peek `consumeTerminalRestoreRequestId` `:51-54`, `clearTerminalRestoreRequestId` `:61-63`, `addTerminalRestoreRequestId` `:65-68`.
- `src/App.tsx`: `import { createLogger } from '@/lib/client-logger'` `:73`, `const log = createLogger('App')` `:79`, `ReadyMessageSchema` `:149-154`, ready handler `:899-945` (restart block `:923-934`).
- `src/store/turnCompletionSlice.ts` (158 lines): `resetCompletionDedupeBaselines` clears both `lastAtByTerminalId` and `lastIdleAtByTerminalId`, preserves attention (pinned by `test/unit/client/store/turnCompletionSlice.test.ts:82-97` and `:393-398`).
- Server facts: legacy TS server ALWAYS emits `bootId` on ready (`server/ws-handler.ts:1910-1915`); rust server always emits both (`crates/freshell-ws/src/lib.rs:356-362`). The shared wire type (`shared/ws-protocol.ts:605-611`) and the frozen port-oracle contract (`test/unit/port/oracle/mutation-validation.test.ts:645-669`) keep both OPTIONAL.
- Test harness models: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (mock boilerplate lines 1-120; RATE_LIMITED retry test at `:2853`), `test/unit/client/components/App.ws-bootstrap.test.tsx` (ready-handler harness), `test/e2e-browser/specs/compound-restart-rust.spec.ts` (restartAbrupt + seeding), `test/e2e-browser/specs/terminal-activity-rust.spec.ts` (fake-bel-cli + CLI pane open), `test/e2e-browser/specs/truly-idle-alerting.spec.ts` (`state.turnCompletion` assertions).

---

### Task 0: Baseline sanity

**Files:** none modified.

- [ ] **Step 0.1:** Confirm the worktree is on `fix/client-retry-restart-hardening` at base `2bf579e6`:

```bash
git -C /home/dan/code/freshell/.worktrees/client-retry-restart-hardening log --oneline -1
git -C /home/dan/code/freshell/.worktrees/client-retry-restart-hardening status --short
```

Expected: `2bf579e6 Merge pull request #531 ...` (plus this plan file once committed).

- [ ] **Step 0.2:** Check the coordinator gate before any broad run:

```bash
npm run test:status
```

If another agent holds the gate, WAIT (do not kill a foreign holder). The workspace stage already verified the base suite green; do not re-run the full suite now.

---

### Task 1: Bounded launch retry for launch-time INVALID_TERMINAL_ID (TerminalView)

**Files:**
- Modify: `src/components/TerminalView.tsx:2798-2814` (generalize scheduler), `:3995-4001` (rename call site), `:2960` region (new `retryLaunchAfterInvalidTerminal` closure, added right after `settleCleanRestoreStartupExit`), `:4076-4088` (wire retry into `failedDuringLaunch`)
- Test: `test/unit/client/components/TerminalView.launchRetry.test.tsx` (new)

**Interfaces:**
- Consumes: `scheduleRateLimitRetry`/`rateLimitRetryRef`/`clearRateLimitRetry` machinery, `sendCreate(requestId)`, `failLaunch(message, restore, terminalId?)`, `addTerminalRestoreRequestId(requestId)` (already imported in TerminalView), exported constants `RATE_LIMIT_RETRY_*`.
- Produces: effect-scope `scheduleCreateRetry(requestId: string, kind: 'rate-limit' | 'launch'): boolean` (replaces `scheduleRateLimitRetry`; same counter/timer/constants/staleness guard) and `ensure()`-scope `retryLaunchAfterInvalidTerminal(restore: boolean, deadTerminalId: string | undefined): boolean`. No new exports. Task 3's e2e spec relies on: pane stays `status: 'creating'` during retries, retried `terminal.create` reuses the same `createRequestId` with `restore: true` re-armed, exhaustion falls back to the existing `failLaunch` error state.

Behavioral contract being built (write it as a comment above the new closure):
- Launch-time `INVALID_TERMINAL_ID` (server no longer knows the terminal we just created — the restart/half-initialized signature, i.e. NO numeric `terminalExitCode` on the error) gets a bounded backoff retry (5 attempts, 2/4/8/12/12s — same budget as RATE_LIMITED) that re-sends `terminal.create` with the SAME `createRequestId`.
- A launch failure that carries a numeric nonzero `terminalExitCode` means the CLI process spawned and died — do NOT respawn-storm it; fall straight to `failLaunch`. (`terminalExitCode === 0` + restore + sessionRef keeps its existing `settleCleanRestoreStartupExit` escape hatch, which runs FIRST.)
- The restore flag must be re-armed before each retry: `terminal.created` already consumed it at `:3694`, and `restore: true` also exempts the retry from the server's `terminal.create` rate limit (`server/ws-handler.ts:2376-2389`).
- Exhaustion → the existing `failLaunch` path. Never an infinite loop.
- Untouched invariants: the stale-error guard `:4026-4040` (only current-attach errors are acted on), the `status !== 'exited'` no-auto-respawn rule `:4092`, and the RATE_LIMITED retry behavior.

- [ ] **Step 1.1: Write the failing tests**

Create `test/unit/client/components/TerminalView.launchRetry.test.tsx`. Harness: copy the mock boilerplate from `TerminalView.lifecycle.test.tsx` lines 1-120 (wsMocks / MockTerminal / FitAddon / lucide / ResizeObserver / rAF stubs / `createSettingsState` / beforeEach-afterEach), with ONE deliberate difference: do **NOT** `vi.mock('@/lib/terminal-restore')` — this file uses the REAL module so the re-arm → non-destructive-peek chain is exercised for real (same approach as `TerminalView.restore-flag-persistence.test.tsx`).

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  addTerminalRestoreRequestId,
  clearTerminalRestoreRequestId,
} from '@/lib/terminal-restore'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

// ... wsMocks / terminalThemeMocks / MockTerminal / FitAddon / lucide /
// xterm.css mocks copied verbatim from TerminalView.lifecycle.test.tsx
// (lines 1-120), EXCEPT the vi.mock('@/lib/terminal-restore') block, which is
// intentionally omitted: this suite uses the real terminal-restore module.

import TerminalView, {
  RATE_LIMIT_RETRY_MAX_ATTEMPTS,
  RATE_LIMIT_RETRY_BASE_MS,
  RATE_LIMIT_RETRY_MAX_MS,
} from '@/components/TerminalView'

const REQ = 'req-launch-retry'
const TAB = 'tab-launch-retry'
const PANE = 'pane-launch-retry'

function createSettingsState() {
  const serverSettings = createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug })
  const localSettings = resolveLocalSettings()
  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function makeStore() {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: REQ,
    status: 'creating',
    mode: 'shell',
    shell: 'system',
  }
  const root: PaneNode = { type: 'leaf', id: PANE, content: paneContent }
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB, mode: 'shell', status: 'running', title: 'Shell',
          titleSetByUser: false, createRequestId: REQ,
        }],
        activeTabId: TAB,
      },
      panes: { layouts: { [TAB]: root }, activePane: { [TAB]: PANE }, paneTitles: {} },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
    },
  })
  return { store, paneContent }
}

function sentCreates() {
  return wsMocks.send.mock.calls.map(([m]) => m).filter((m) => m?.type === 'terminal.create')
}

function paneStatus(store: ReturnType<typeof makeStore>['store']) {
  const layout = store.getState().panes.layouts[TAB] as { type: 'leaf'; content: any }
  return layout.content.status
}

async function renderPane(store: any, paneContent: TerminalPaneContent) {
  render(
    <Provider store={store}>
      <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
    </Provider>
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(messageHandler).not.toBeNull()
}

/** Anchor the launch: server acks the create, launchAttempt gets terminalId. */
function anchor(terminalId: string) {
  messageHandler!({ type: 'terminal.created', terminalId, requestId: REQ })
}

/** Launch-time INVALID_TERMINAL_ID in the "server lost the terminal" shape
 *  (no requestId, no terminalExitCode — the emitter shape of
 *  server/ws-handler.ts:2832). Passes the :4039 `!msg.requestId` guard branch
 *  and the :4061 same-terminal filter, landing in failedDuringLaunch. */
function launchInvalidTerminal(terminalId: string) {
  messageHandler!({
    type: 'error',
    code: 'INVALID_TERMINAL_ID',
    message: 'Unknown terminalId',
    terminalId,
  })
}

describe('launch-time INVALID_TERMINAL_ID bounded retry', () => {
  // beforeEach/afterEach copied from TerminalView.lifecycle.test.tsx, plus:
  beforeEach(() => {
    clearTerminalRestoreRequestId(REQ)
  })
  afterEach(() => {
    clearTerminalRestoreRequestId(REQ)
    cleanup()
    vi.useRealTimers()
  })

  it('retries terminal.create with the SAME requestId and restore:true after a launch-time INVALID_TERMINAL_ID', async () => {
    vi.useFakeTimers()
    addTerminalRestoreRequestId(REQ) // this pane is a restore round
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)

    const first = sentCreates()
    expect(first.length).toBeGreaterThan(0)
    expect(first[first.length - 1].requestId).toBe(REQ)
    expect(first[first.length - 1].restore).toBe(true)

    await act(async () => { anchor('term-old') })
    // terminal.created consumed the restore flag (TerminalView:3694).
    await act(async () => { launchInvalidTerminal('term-old') })

    // NOT a dead end: still creating, no error status.
    expect(paneStatus(store)).toBe('creating')

    const before = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(RATE_LIMIT_RETRY_BASE_MS) })
    const after = sentCreates()
    expect(after.length).toBe(before + 1)
    const retried = after[after.length - 1]
    expect(retried.requestId).toBe(REQ)      // SAME createRequestId
    expect(retried.restore).toBe(true)       // re-armed before the retry
  })

  it('a non-restore launch also retries (without restore:true) instead of dying', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)
    await act(async () => { anchor('term-old') })
    await act(async () => { launchInvalidTerminal('term-old') })
    expect(paneStatus(store)).toBe('creating')
    const before = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(RATE_LIMIT_RETRY_BASE_MS) })
    const after = sentCreates()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].requestId).toBe(REQ)
    expect(after[after.length - 1].restore).toBeUndefined()
  })

  it('caps retries at RATE_LIMIT_RETRY_MAX_ATTEMPTS and then fails the launch', async () => {
    vi.useFakeTimers()
    addTerminalRestoreRequestId(REQ)
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)

    await act(async () => { anchor('term-0') })
    await act(async () => { launchInvalidTerminal('term-0') })

    for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = Math.min(RATE_LIMIT_RETRY_BASE_MS * 2 ** (attempt - 1), RATE_LIMIT_RETRY_MAX_MS)
      const before = sentCreates().length
      await act(async () => { vi.advanceTimersByTime(delay) })
      expect(sentCreates().length).toBe(before + 1) // retry N fired
      // Each retry round anchors to a fresh terminal, then fails again —
      // except we stop failing after the last scheduled retry to check the cap.
      await act(async () => { anchor(`term-${attempt}`) })
      await act(async () => { launchInvalidTerminal(`term-${attempt}`) })
    }

    // Budget exhausted (5 schedules consumed) -> the 6th failure fell through
    // to failLaunch inside the loop's final iteration.
    expect(paneStatus(store)).toBe('error')
    const wroteFailure = terminalInstances.some((t: any) =>
      t.write.mock.calls.some(([data]: [string]) => String(data).includes('[Restore failed]')))
    expect(wroteFailure).toBe(true)
    // And no further create is scheduled.
    const total = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(sentCreates().length).toBe(total)
  })

  it('does NOT retry a launch failure that carries a nonzero terminalExitCode (crashed CLI is not respawn-stormed)', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)
    await act(async () => { anchor('term-old') })
    await act(async () => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Terminal exited (exit 127)',
        terminalId: 'term-old',
        terminalExitCode: 127,
      })
    })
    expect(paneStatus(store)).toBe('error')
    const total = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(sentCreates().length).toBe(total)
  })
})
```

Notes for the implementer:
- `terminalInstances` and `messageHandler` come from the copied lifecycle boilerplate.
- If the `anchor()` step triggers a `terminal.attach` send with async scheduling under fake timers, flush with `await act(async () => { vi.advanceTimersByTime(50) })` after `anchor(...)` — the existing lifecycle tests (`:2423`, `:2853`) show the exact rhythm; mirror them.

- [ ] **Step 1.2: Run the new tests — verify they FAIL**

```bash
FRESHELL_TEST_SUMMARY="lane-C launch-retry RED" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/TerminalView.launchRetry.test.tsx
```

Expected: FAIL. Tests 1 and 2 fail with pane status `'error'` instead of `'creating'` (today's `failLaunch` dead-end at `:4086`). Test 4 may pass already (it pins current behavior) — that is acceptable for a pinned invariant; the suite as a whole must be red.

- [ ] **Step 1.3: Implement — generalize the scheduler**

In `src/components/TerminalView.tsx`, replace `:2798-2814`:

```ts
    const scheduleCreateRetry = (requestId: string, kind: 'rate-limit' | 'launch') => {
      const retryState = rateLimitRetryRef.current
      if (retryState.count >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) return false
      retryState.count += 1
      const delayMs = Math.min(
        RATE_LIMIT_RETRY_BASE_MS * (2 ** (retryState.count - 1)),
        RATE_LIMIT_RETRY_MAX_MS
      )
      if (retryState.timer) clearTimeout(retryState.timer)
      retryState.timer = setTimeout(() => {
        retryState.timer = null
        if (requestIdRef.current !== requestId) return
        sendCreate(requestId)
      }, delayMs)
      const notice = kind === 'rate-limit'
        ? `[Rate limited - retrying in ${(delayMs / 1000).toFixed(0)}s]`
        : `[Terminal launch interrupted - retrying in ${(delayMs / 1000).toFixed(0)}s]`
      writeLocalXtermNotice(term, `\r\n${notice}\r\n`)
      return true
    }
```

Update the single RATE_LIMITED call site at `:3997` from `scheduleRateLimitRetry(reqId)` to `scheduleCreateRetry(reqId, 'rate-limit')`. Grep the file for any other `scheduleRateLimitRetry` reference (there is exactly one call site today) and update it. `clearRateLimitRetry`, the shared `rateLimitRetryRef` counter (retry budget shared across both kinds — deliberate: bounds TOTAL create attempts per launch round), the staleness guard, and the exported constants are all unchanged.

- [ ] **Step 1.4: Implement — the launch retry closure**

Inside `ensure()`, immediately after `settleCleanRestoreStartupExit` (after `:2960`), add:

```ts
      // GAP F9/G5: a launch-time INVALID_TERMINAL_ID without a numeric
      // terminalExitCode means the server no longer knows the terminal we just
      // created — the restart / half-initialized-server signature. Instead of
      // the permanent failLaunch dead-end, take a bounded backoff retry that
      // re-sends terminal.create with the SAME createRequestId. The restore
      // flag is re-armed first: terminal.created already consumed it (see the
      // handler below), and restore:true also exempts the retry from the
      // server's terminal.create rate limit. Exhaustion falls back to
      // failLaunch. This closure is "the named retryer" future error codes
      // (e.g. SESSION_RESERVED) will reuse — keep it generic.
      const retryLaunchAfterInvalidTerminal = (
        restore: boolean,
        deadTerminalId: string | undefined,
      ): boolean => {
        const reqId = requestIdRef.current
        if (!reqId) return false
        if (restore) addTerminalRestoreRequestId(reqId)
        if (!scheduleCreateRetry(reqId, 'launch')) return false
        // Drop the dead terminal's identity so the retried create starts
        // clean, but keep the pane in 'creating' (NOT 'error') while the
        // retry timer runs. Mirrors failLaunch's cleanup minus the terminal
        // error state.
        clearQuarantineRepair()
        setIsAttaching(false)
        currentAttachRef.current = null
        launchAttemptRef.current = null
        deferredAttachStateRef.current = {
          mode: 'none',
          pendingIntent: null,
          pendingSinceSeq: 0,
          pendingReason: 'initial_hydrate',
        }
        if (deadTerminalId) {
          clearTerminalCursor(deadTerminalId)
          resetParserAppliedSurface()
          forgetSentViewport(deadTerminalId)
        }
        lastSentViewportRef.current = null
        terminalIdRef.current = undefined
        applySeqState(createAttachSeqState())
        updateContent({ terminalId: undefined, streamId: undefined, status: 'creating' })
        return true
      }
```

- [ ] **Step 1.5: Implement — wire it into `failedDuringLaunch`**

Replace `:4076-4088` with:

```ts
          if (failedDuringLaunch) {
            if (
              launchAttempt?.restore &&
              msg.terminalExitCode === 0 &&
              current?.sessionRef &&
              currentTerminalId
            ) {
              settleCleanRestoreStartupExit(currentTerminalId, msg.message)
              return
            }
            // Only the "server lost the terminal" shape retries; a numeric
            // nonzero terminalExitCode means the CLI spawned and died — do
            // not respawn-storm it.
            if (
              typeof msg.terminalExitCode !== 'number'
              && retryLaunchAfterInvalidTerminal(launchAttempt!.restore, currentTerminalId)
            ) {
              return
            }
            failLaunch(msg.message || 'The terminal failed before it finished starting.', launchAttempt!.restore, currentTerminalId)
            return
          }
```

Do NOT touch: the guard block `:4026-4040`, the `:4061` other-terminal filter, the exit-during-launch call site `:3816` (a real `terminal.exit` during launch stays a non-retried failure), or the `status !== 'exited'` rule `:4092`.

- [ ] **Step 1.6: Run the new tests — verify they PASS**

```bash
FRESHELL_TEST_SUMMARY="lane-C launch-retry GREEN" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/TerminalView.launchRetry.test.tsx
```

Expected: PASS (all 4).

- [ ] **Step 1.7: Run the adjacent guard suites — verify no regression**

```bash
FRESHELL_TEST_SUMMARY="lane-C launch-retry guard suites" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/unit/client/components/TerminalView.rateLimit.test.ts \
  test/unit/client/components/TerminalView.restore-flag-persistence.test.tsx
```

Expected: PASS. Pay special attention to `:2423` (restored launch failure → no reconnect — now that test's scenario must still END in failure because its mocked restore module returns a fixed value; if it drives a no-exit-code INVALID_TERMINAL_ID it will now observe a retry instead. If `:2423` fails, UPDATE that test's expectation to the new contract: retry first, `failLaunch` only on exhaustion — and note the change in the commit message. The INVARIANT that must never change is `:2931` (`exited` panes never auto-respawn) and `:2853` (RATE_LIMITED retry).)

- [ ] **Step 1.8: Lint + typecheck the touched files**

```bash
npm run lint
npx tsc -p tsconfig.json --noEmit
```

Expected: clean (or pre-existing issues only — do not fix unrelated files).

- [ ] **Step 1.9: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx
git commit -m "fix(client): bounded retry for launch-time INVALID_TERMINAL_ID

Launch-time INVALID_TERMINAL_ID (server lost the terminal - the restart /
half-initialized signature) was a permanent dead-end: failLaunch set
status:'error' with no retry. Reuse the rate-limit backoff scheduler
(5 attempts, 2/4/8/12/12s) keyed on the SAME createRequestId, re-arming
the restore flag before each retry so the non-destructive peek keeps
delivering restore:true. Nonzero terminalExitCode still fails immediately
(no respawn storm). Exhaustion falls back to the existing failLaunch.

Gap F9/G5 (P0) of the restart-resilience campaign, Lane C.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Restart-signal hardening in App.tsx (bootId fallback + dedupe reset on both signals)

**Files:**
- Modify: `src/App.tsx:899-945` (the `'ready'` branch of the `ws.onMessage` handler; `ReadyMessageSchema` at `:149-154` is intentionally NOT changed — see the schema decision below)
- Test: `test/unit/client/components/App.restart-signals.test.tsx` (new)

**Interfaces:**
- Consumes: `ReadyMessageSchema` (unchanged), `appStore.getState().connection.{bootId,serverInstanceId}`, `setBootId` / `setServerRestarted` / `setServerInstanceId` / `setLiveTerminalIds` from `@/store/connectionSlice`, `resetCompletionDedupeBaselines` from `@/store/turnCompletionSlice`, module-scope `log = createLogger('App')` (`src/App.tsx:79`).
- Produces: new restart-detection semantics inside the ready handler (no new exports). Task 5's e2e spec relies on: a restart detected by either signal clears the dedupe baselines so a post-restart completion is never swallowed, and repeat readys with unchanged identity do NOT reset.

**Schema decision (document verbatim as a code comment):** `bootId` stays `.optional()` in `ReadyMessageSchema`. Both live servers always emit it (legacy: `server/ws-handler.ts:1910-1915`; rust: `crates/freshell-ws/src/lib.rs:356-362`), but the shared wire type (`shared/ws-protocol.ts:605-611`) and the frozen port-oracle contract (`test/unit/port/oracle/mutation-validation.test.ts:645-669`) mark it optional. Hard-requiring it would make the ENTIRE ready frame fail `safeParse` against any older server, silently disabling all ready processing — strictly worse than degraded restart detection. Instead: keep it optional, log loudly when absent, and fall back to a `serverInstanceId` change as the restart signal.

**New semantics:**
1. `safeParse` failure → `log.error`, keep the stored `bootId`/`serverInstanceId` (do NOT dispatch `setServerInstanceId(undefined)`), skip restart detection entirely. (Fixes the pre-existing bug where a malformed frame wiped identity AND spuriously flagged a restart.)
2. `bootId` present and changed (or previously present, now absent) → restart.
3. `bootId` absent on both sides → `serverInstanceId` change is the fallback restart signal; absence of `bootId` is loudly logged every time.
4. Dedupe-baseline reset fires when: restart detected (either signal), OR `serverInstanceId` changed, OR this is the FIRST parsed ready of the page lifetime (idempotent no-op today since baselines start empty; future-proofs against persisted/rehydrated baselines). It does NOT fire on repeat readys with unchanged identity (plain reconnects must not lose replay-dedupe protection).
5. `setLiveTerminalIds([])` keeps firing on restart only (inventory corrects it right after), exactly as today.

- [ ] **Step 2.1: Write the failing tests**

Create `test/unit/client/components/App.restart-signals.test.tsx`. Copy the FULL harness boilerplate from `test/unit/client/components/App.ws-bootstrap.test.tsx` (per this suite's copy-per-file convention): the heavy-child `vi.mock`s (TabContent/Sidebar/HistoryView/SettingsView/OverviewView/useTheme/SetupWizard), `stubAudio`, `createSettingsState`, the `wsMocks` + `@/lib/ws-client` mock capturing `messageHandler`, the `@/lib/terminal-restore` mock, the `createStore()` helper wiring the real reducers (settings/tabs/connection/sessions/panes/tabRegistry/terminalMeta/extensions/turnCompletion/network/codexActivity/opencodeActivity), and the fetch-stubbing `beforeEach`/`afterEach`. Then add:

```tsx
import { recordTurnComplete } from '@/store/turnCompletionSlice'
import { setLiveTerminalIds } from '@/store/connectionSlice'

const READY_BASE = { type: 'ready', timestamp: '2026-07-25T00:00:00.000Z' }

function sendReady(extra: Record<string, unknown>) {
  act(() => { messageHandler?.({ ...READY_BASE, ...extra }) })
}

function baselines(store: any) {
  return store.getState().turnCompletion.lastAtByTerminalId
}

describe('App restart signals (bootId + serverInstanceId fallback)', () => {
  it('bootId change: flags restart, clears live terminals and dedupe baselines; a lower post-restart at is not swallowed', async () => {
    const store = createStore()
    renderApp(store) // render(<Provider store={store}><App /></Provider>) + settle, per harness
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(setLiveTerminalIds(['term-old']))
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 10_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(10_000)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-2' })

    const conn = store.getState().connection
    expect(conn.serverRestarted).toBe(true)
    expect(conn.bootId).toBe('boot-2')
    expect(conn.liveTerminalIds).toEqual([])
    expect(baselines(store)).toEqual({})

    // THE regression pin (clamp-inflated-at swallow bug, App.tsx:930-933
    // comment): a resumed session's first completion after restart, stamped
    // with a LOWER wall-clock at, must be recorded — never deduped away.
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 2_000 }))
    })
    expect(store.getState().turnCompletion.pendingEvents.some((e: any) => e.at === 2_000)).toBe(true)
  })

  it('bootId absent: a serverInstanceId change is treated as an equivalent restart signal', async () => {
    const store = createStore()
    renderApp(store)
    sendReady({ serverInstanceId: 'srv-1' }) // no bootId
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 10_000 }))
    })
    sendReady({ serverInstanceId: 'srv-2' }) // no bootId, instance changed
    expect(store.getState().connection.serverRestarted).toBe(true)
    expect(baselines(store)).toEqual({})
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 2_000 }))
    })
    expect(store.getState().turnCompletion.pendingEvents.some((e: any) => e.at === 2_000)).toBe(true)
  })

  it('logs loudly when a ready frame carries no bootId', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const store = createStore()
    renderApp(store)
    sendReady({ serverInstanceId: 'srv-1' })
    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('bootId'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('does NOT reset dedupe baselines on a repeat ready with unchanged identity (plain reconnect)', async () => {
    const store = createStore()
    renderApp(store)
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 5_000 }))
    })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' }) // reconnect, same boot
    expect(baselines(store)['codex:ses-resumed']).toBe(5_000) // survived
    // Replay protection intact: an older at is still deduped.
    const eventsBefore = store.getState().turnCompletion.pendingEvents.length
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 4_000 }))
    })
    expect(store.getState().turnCompletion.pendingEvents.length).toBe(eventsBefore)
  })

  it('resets baselines on the FIRST parsed ready (idempotent first-ready reset)', async () => {
    const store = createStore()
    renderApp(store)
    // Simulate a stale/rehydrated baseline existing BEFORE the first ready
    // (the future-persistence hazard G11 names).
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 9_000 }))
    })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    expect(baselines(store)).toEqual({})
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 1_000 }))
    })
    expect(store.getState().turnCompletion.pendingEvents.some((e: any) => e.at === 1_000)).toBe(true)
  })

  it('a malformed ready frame neither wipes identity nor fakes a restart', async () => {
    const store = createStore()
    renderApp(store)
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 5_000 }))
    })
    sendReady({}) // missing serverInstanceId -> safeParse fails
    const conn = store.getState().connection
    expect(conn.serverInstanceId).toBe('srv-1') // NOT wiped
    expect(conn.bootId).toBe('boot-1')          // NOT wiped
    expect(conn.serverRestarted).not.toBe(true) // no spurious restart
    expect(baselines(store)['codex:ses-resumed']).toBe(5_000) // preserved
  })
})
```

(If the copied harness names its store factory or render helper differently, use those names — the test bodies above are the contract; the harness plumbing follows the source file.)

- [ ] **Step 2.2: Run the new tests — verify they FAIL**

```bash
FRESHELL_TEST_SUMMARY="lane-C restart-signals RED" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/App.restart-signals.test.tsx
```

Expected: FAIL. Test 1 passes already (bootId path exists — it is the pin that keeps it working); tests 2, 3, 5, 6 fail against current behavior (no fallback, no log, no first-ready reset, identity wiped on parse failure).

- [ ] **Step 2.3: Implement — restructure the ready restart block**

In `src/App.tsx`, the current block at `:917-934` reads (verbatim):

```ts
          dispatch(setError(undefined))
          dispatch(setStatus('ready'))
          dispatch(setServerInstanceId(nextServerInstanceId))
          const newBootId = ready.success ? ready.data.bootId : undefined
          const previousBootId = appStore.getState().connection.bootId
          const serverRestarted = !!previousBootId && previousBootId !== newBootId
          dispatch(setBootId(newBootId))
          dispatch(setServerRestarted(serverRestarted))
          if (serverRestarted) {
            dispatch(setLiveTerminalIds([]))
            // The fresh process replays nothing and may stamp a lower wall-clock `at` than
            // a clamp-inflated pre-restart value; drop the per-terminal `at` baselines so a
            // resumed durable session's next real completion is not swallowed.
            dispatch(resetCompletionDedupeBaselines())
          }
```

Replace it with:

```ts
          dispatch(setError(undefined))
          dispatch(setStatus('ready'))
          // Restart detection (gaps F2/G10 + F10/G11). `bootId` stays OPTIONAL
          // in ReadyMessageSchema on purpose: both live servers always emit it
          // (legacy server/ws-handler.ts:1910-1915, rust freshell-ws/lib.rs:356),
          // but the shared wire type and the frozen port-oracle contract mark
          // it optional — hard-requiring it would fail the WHOLE ready frame
          // against an older server and silently disable all ready handling.
          // Instead: log loudly when absent and fall back to a
          // serverInstanceId change as the restart signal.
          const previousBootId = appStore.getState().connection.bootId
          const previousServerInstanceId = appStore.getState().connection.serverInstanceId
          if (!ready.success) {
            // A malformed ready frame must not wipe identity or fake a
            // restart: keep the stored bootId/serverInstanceId and skip
            // restart detection for this frame.
            log.error('ready frame failed schema validation; skipping restart detection', ready.error.issues)
          } else {
            dispatch(setServerInstanceId(nextServerInstanceId))
            const newBootId = ready.data.bootId
            if (!newBootId) {
              log.warn('ready frame carried no bootId; falling back to serverInstanceId for restart detection')
            }
            const bootIdRestart = !!previousBootId && previousBootId !== newBootId
            const instanceChanged = !!previousServerInstanceId
              && !!nextServerInstanceId
              && previousServerInstanceId !== nextServerInstanceId
            const serverRestarted = bootIdRestart || (!newBootId && instanceChanged)
            dispatch(setBootId(newBootId))
            dispatch(setServerRestarted(serverRestarted))
            if (serverRestarted) {
              dispatch(setLiveTerminalIds([]))
            }
            // The fresh process replays nothing and may stamp a lower
            // wall-clock `at` than a clamp-inflated pre-restart value; drop
            // the per-terminal `at` baselines so a resumed durable session's
            // next real completion is not swallowed. Fires on EITHER restart
            // signal, and idempotently on the first parsed ready of the page
            // lifetime (no-op while baselines are unpersisted; future-proofs
            // against rehydrated baselines). Never on a plain reconnect with
            // unchanged identity.
            const firstReadyBaseline = !previousBootId && !previousServerInstanceId
            if (serverRestarted || instanceChanged || firstReadyBaseline) {
              dispatch(resetCompletionDedupeBaselines())
            }
          }
```

Everything before (`platformCapabilitiesLoaded` / `lastReadyServerInstanceId` bookkeeping at `:903-911`, activity-overlay resets) and after (`resetWsSnapshotReceived()` onward, `:935+`) is unchanged. Note the ONE moved line: `dispatch(setServerInstanceId(nextServerInstanceId))` now runs only for parsed frames, AFTER `previousServerInstanceId` is captured.

- [ ] **Step 2.4: Run the new tests — verify they PASS**

```bash
FRESHELL_TEST_SUMMARY="lane-C restart-signals GREEN" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/App.restart-signals.test.tsx
```

Expected: PASS (all 6).

- [ ] **Step 2.5: Run the adjacent App + slice guard suites**

```bash
FRESHELL_TEST_SUMMARY="lane-C restart-signals guard suites" npm run test:vitest -- run \
  --config config/vitest/vitest.config.ts \
  test/unit/client/components/App.ws-bootstrap.test.tsx \
  test/unit/client/components/App.test.tsx \
  test/unit/client/store/turnCompletionSlice.test.ts \
  test/unit/client/store/connectionSlice.test.ts
```

Expected: PASS. Known interaction to watch: `App.ws-bootstrap.test.tsx` sends bootId-less readys — those now emit a `log.warn` (harmless) and, on the FIRST ready, a no-op baseline reset. If any of its tests assert exact dispatch sequences or console silence, adjust the fix only if it breaks a REAL contract; otherwise update the test with a one-line comment referencing this plan.

- [ ] **Step 2.6: Lint + typecheck**

```bash
npm run lint
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 2.7: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.restart-signals.test.tsx
git commit -m "fix(client): serverInstanceId fallback restart signal + hardened dedupe reset

bootId is optional in the ready schema, and a server omitting it silently
disabled restart detection (serverRestarted could never fire). Now: a
serverInstanceId change is an equivalent restart signal when bootId is
absent (loudly logged), a malformed ready frame no longer wipes identity
or fakes a restart, and the turn-completion dedupe-baseline reset fires
on either restart signal and idempotently on first-ready — never on a
plain reconnect. Pins the clamp-inflated-at swallow regression: a resumed
session's first completion after restart is never deduped away.

Gaps F2/G10 + F10/G11 of the restart-resilience campaign, Lane C.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: E2E — create in flight across abrupt restart retries and lands

**Files:**
- Create: `test/e2e-browser/specs/launch-retry-restart-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two one-line regex additions; sibling lanes append too — trivial conflicts are fine)

**Interfaces:**
- Consumes: `RustServer` (`start`, `restartAbrupt`, `stop`), `TestHarness` (`waitForHarness`, `waitForConnection`, `getState`), `window.__FRESHELL_TEST_HARNESS__.getWsReadyState()`, Task 1's retry behavior.
- Produces: nothing consumed by later tasks.

- [ ] **Step 3.1: Write the spec**

Create `test/e2e-browser/specs/launch-retry-restart-rust.spec.ts` (helpers copied, not imported, per this suite's per-spec-ownership convention):

```ts
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * LANE C / GAP F9: a terminal.create round in flight when the server dies
 * abruptly (SIGKILL, no clean WS close, revived on the same port/token) must
 * NOT strand the pane in a permanent status:'error' — the client's bounded
 * launch retry (same createRequestId, restore re-armed) must land it.
 * Rust-only: requires RustServer.restartAbrupt().
 */

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

test.describe('Launch retry across abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a create in flight when the server dies abruptly retries and lands instead of a permanent error', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer({})
    const info = await server.start()
    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Fire a second tab's creation and IMMEDIATELY SIGKILL the server so
      // the create/attach round races the death+revival window.
      await page.locator('[data-context="tab-add"]').click()
      await server.restartAbrupt()
      // If the new tab is still showing the PanePicker, pick a shell now —
      // the create then lands on the freshly-revived (possibly still
      // half-initializing) process. Both interleavings are valid samples of
      // the F9 race.
      await selectShellIfPickerShowing(page)

      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

      // EVERY terminal pane converges to a live terminal; none is stuck in
      // 'error'. 90s accommodates the full 38s retry budget plus recovery.
      await expect(async () => {
        const state = await harness.getState()
        for (const tab of state!.tabs.tabs) {
          for (const leaf of collectLeaves(state!.panes.layouts[tab.id])) {
            if (leaf?.content?.kind !== 'terminal') continue
            expect(leaf.content.status).not.toBe('error')
            expect(leaf.content.terminalId).toBeTruthy()
          }
        }
        expect(state!.tabs.tabs.length).toBe(2)
      }).toPass({ timeout: 90_000 })

      // No pane surface shows a terminal launch failure notice.
      const state = await harness.getState()
      for (const tab of state!.tabs.tabs) {
        await page.locator(`[data-context="tab"][data-tab-id="${tab.id}"]`).click()
        await page.waitForTimeout(300)
        const xtermContent = await page.locator('.xterm').first().textContent()
        expect(xtermContent).not.toContain('[Launch failed]')
        expect(xtermContent).not.toContain('[Restore failed]')
      }
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
```

- [ ] **Step 3.2: Register the spec (rust-only pair)**

In `test/e2e-browser/playwright.config.ts` add one line to `RUST_ONLY_SPECS`:

```ts
  /launch-retry-restart-rust\.spec\.ts$/,
```

and the same regex line to the `rust-chromium` project's `testMatch` array. (Both lines are required: the first keeps the match-all `chromium` project from running it under the legacy fixture default; the second makes it actually run.)

- [ ] **Step 3.3: Run the spec**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/launch-retry-restart-rust.spec.ts
```

Expected: PASS. (First run builds `dist/` via globalSetup and `target/release/freshell-server` via cargo — allow several minutes.) If it fails, debug with `--headed` and `npx playwright show-report`; do NOT weaken the no-`error`-status assertion.

- [ ] **Step 3.4: Commit**

```bash
git add test/e2e-browser/specs/launch-retry-restart-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): create-in-flight abrupt restart lands via launch retry (Lane C F9)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: E2E — rapid double abrupt restart still converges

**Files:**
- Create: `test/e2e-browser/specs/double-restart-terminal-restore-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (same two-line registration pattern as Task 3)

**Interfaces:**
- Consumes: same fixtures as Task 3; Task 1's retry behavior (a recovery round interrupted by a second death is exactly the same-requestId re-drive + retry path).
- Produces: nothing consumed by later tasks.

Note: `restore-double-restart.spec.ts` already pins the FreshCodex double-restart incident. This spec covers the plain TERMINAL pane double-restart, which that spec does not.

- [ ] **Step 4.1: Write the spec**

Create `test/e2e-browser/specs/double-restart-terminal-restore-rust.spec.ts` (copy `selectShellIfPickerShowing` and `collectLeaves` from Task 3's spec — per-spec ownership):

```ts
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * LANE C: two rapid abrupt server deaths — the second landing while the
 * client is still mid-recovery from the first — must still converge every
 * terminal pane to a live terminal. No permanent error state, no duplicate
 * tabs/panes. Rust-only: requires RustServer.restartAbrupt().
 */

// ... selectShellIfPickerShowing + collectLeaves copied verbatim from
// launch-retry-restart-rust.spec.ts ...

test.describe('Rapid double abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a shell pane converges across two rapid abrupt restarts', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer({})
    const info = await server.start()
    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = await harness.getActiveTabId()
      await expect.poll(async () => {
        return (await harness.getPaneLayout(tabId!))?.content?.terminalId ?? null
      }, { timeout: 20_000 }).not.toBeNull()
      const terminalIdBefore: string = (await harness.getPaneLayout(tabId!))?.content?.terminalId
      const tabCountBefore = await harness.getTabCount()

      // Death #1, then death #2 one second into the recovery window.
      await server.restartAbrupt()
      await page.waitForTimeout(1_000)
      await server.restartAbrupt()

      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

      // The pane re-anchors to a NEW live terminal — old PTY died with the
      // first process — and never lands in 'error'.
      await expect(async () => {
        const content = (await harness.getPaneLayout(tabId!))?.content
        expect(content?.status).not.toBe('error')
        expect(content?.terminalId).toBeTruthy()
        expect(content?.terminalId).not.toBe(terminalIdBefore)
      }).toPass({ timeout: 90_000 })

      // Convergence, not duplication.
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      const state = await harness.getState()
      expect(collectLeaves(state!.panes.layouts[tabId!]).length).toBe(1)
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
```

- [ ] **Step 4.2: Register the spec** — add `/double-restart-terminal-restore-rust\.spec\.ts$/,` to BOTH `RUST_ONLY_SPECS` and `rust-chromium`'s `testMatch` in `test/e2e-browser/playwright.config.ts`.

- [ ] **Step 4.3: Run the spec**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/double-restart-terminal-restore-rust.spec.ts
```

Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add test/e2e-browser/specs/double-restart-terminal-restore-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): terminal pane converges across rapid double abrupt restart (Lane C)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: E2E — turn-complete chime fires exactly once across a restart

**Files:**
- Create: `test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (same two-line registration)

**Interfaces:**
- Consumes: `RustServer` with `env: { CODEX_CMD }` + `setupHome`, the `fake-bel-cli.mjs` fixture (700ms turn ending in a BEL; prompt matching `/slow/` = 6s turn), `openPanePicker` from `../helpers/pane-picker.js`, `state.turnCompletion` via `TestHarness.getState()` (assertion model from `truly-idle-alerting.spec.ts`), Task 2's baseline-reset wiring.
- Produces: nothing consumed by later tasks.

Scope note (state honestly in the spec's doc comment): the stable-dedupe-key swallow regression (fresh-agent `provider:sessionId` keys surviving a restart) is pinned at unit level in Task 2 — a terminal pane's PTY id changes across restart, so this e2e proves the USER-VISIBLE contract instead: after an abrupt restart and pane recovery, a completed turn produces exactly ONE new alert edge (no swallow, no double-chime).

- [ ] **Step 5.1: Write the spec**

Create `test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * LANE C / GAP F10: across an abrupt server restart, a recovered CLI pane's
 * next completed turn must ring EXACTLY once — not zero (baseline swallow)
 * and not twice (replay double-chime). Counted via the turnCompletion.seq
 * alert-edge counter (the bell/shade pipeline), the assertion model of
 * truly-idle-alerting.spec.ts. Rust-only: restartAbrupt + the rust
 * terminal.idle activity engine.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_BEL_CLI = path.resolve(__dirname, '../fixtures/fake-bel-cli.mjs')

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

// ... selectShellIfPickerShowing + collectLeaves copied verbatim from
// launch-retry-restart-rust.spec.ts ...

async function openCodexPaneAndGetTerminalId(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
): Promise<string> {
  const before = collectLeaves(await harness.getPaneLayout(tabId))
    .filter((leaf) => leaf?.content?.mode === 'codex')
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /Codex/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const leaf = collectLeaves(layout)
      .find((l) => l?.content?.mode === 'codex' && !beforeIds.has(l.id) && l?.content?.terminalId)
    return leaf?.content?.terminalId ?? null
  }, { timeout: 15_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const leaf = collectLeaves(layout)
    .find((l) => l?.content?.mode === 'codex' && !beforeIds.has(l.id) && l?.content?.terminalId)
  return leaf.content.terminalId as string
}

async function typePromptIntoLastPane(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').last().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Turn-complete alert across abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a recovered CLI pane rings exactly once for its first post-restart turn', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-lane-c-chime-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    const server = new RustServer({
      env: { CODEX_CMD: fakeCodex },
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['codex'] } },
        }, null, 2))
      },
    })
    const info = await server.start()
    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()

      const terminalId1 = await openCodexPaneAndGetTerminalId(page, harness, tabId!)
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 15_000 }).toBe(true)

      // Turn 1 (pre-restart): exactly one alert edge.
      await typePromptIntoLastPane(page, 'first prompt')
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.lastIdleAtByTerminalId?.[terminalId1] ?? null
      }, { timeout: 30_000 }).not.toBeNull()
      const seqAfterTurn1 = (await harness.getState()).turnCompletion.seq
      expect(seqAfterTurn1).toBeGreaterThanOrEqual(1)

      // Abrupt death + revival; the pane must recover to a NEW terminal.
      await server.restartAbrupt()
      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

      let terminalId2: string | null = null
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const leaf = collectLeaves(layout)
          .find((l) => l?.content?.mode === 'codex' && l?.content?.terminalId && l.content.terminalId !== terminalId1)
        terminalId2 = leaf?.content?.terminalId ?? null
        return terminalId2
      }, { timeout: 90_000 }).not.toBeNull()
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId2!)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 30_000 }).toBe(true)
      const seqBeforeTurn2 = (await harness.getState()).turnCompletion.seq

      // Turn 2 (post-restart): exactly ONE new alert edge — never zero
      // (swallowed by a stale baseline), never two (replay double-chime).
      await typePromptIntoLastPane(page, 'second prompt after restart')
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.lastIdleAtByTerminalId?.[terminalId2!] ?? null
      }, { timeout: 30_000 }).not.toBeNull()
      await expect.poll(async () => {
        return (await harness.getState()).turnCompletion.seq
      }, { timeout: 10_000 }).toBe(seqBeforeTurn2 + 1)

      // Settle window: no late duplicate edge.
      await page.waitForTimeout(3_000)
      expect((await harness.getState()).turnCompletion.seq).toBe(seqBeforeTurn2 + 1)
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

Implementation note: if the codex pane recovers with the SAME pane but the picker flow re-prompts, or the fake CLI's prompt marker differs post-restart, mirror the recovery polling from `compound-restart-rust.spec.ts`'s `assertRecoveredPane` — the assertions on `turnCompletion.seq` are the contract; the recovery choreography follows the existing specs.

- [ ] **Step 5.2: Register the spec** — add `/turn-complete-restart-resume-rust\.spec\.ts$/,` to BOTH `RUST_ONLY_SPECS` and `rust-chromium`'s `testMatch`.

- [ ] **Step 5.3: Run the spec**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/turn-complete-restart-resume-rust.spec.ts
```

Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): exactly-once turn-complete alert across abrupt restart (Lane C F10)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: Full verification + push (STOP before PR)

**Files:** none modified (fixes only if the suite finds regressions).

- [ ] **Step 6.1: Coordinated full suite** (wait for the gate if a sibling lane holds it):

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="lane-C client-retry-restart-hardening full check" npm run check
```

Expected: typecheck clean, coordinated suite green. Fix any regression (TDD: reproduce with a test first if the failure is in lane-C code), commit fixes atomically.

- [ ] **Step 6.2: Lint**

```bash
npm run lint
```

Expected: clean.

- [ ] **Step 6.3: Re-run the three lane-C e2e specs in one pass**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/launch-retry-restart-rust.spec.ts \
  specs/double-restart-terminal-restore-rust.spec.ts \
  specs/turn-complete-restart-resume-rust.spec.ts
```

Expected: 3 passed.

- [ ] **Step 6.4: Push the branch — and STOP**

```bash
git push -u origin fix/client-retry-restart-hardening
```

Do NOT run `gh pr create` (PR creation is not yet approved). Report: branch name, commit list, the red→green evidence per task (Step 1.2→1.6, Step 2.2→2.4), and the three e2e pass results.

---

## Self-Review (completed by the plan author)

**1. Spec coverage:**
- G5/F9 bounded retry, same requestId, restore:true preserved via peek, retries capped, exhaustion → existing error state → Task 1 (+ e2e Task 3). Guard block `:4026-4040` stale-error immunity and `:4092` exited-no-respawn explicitly untouched and guarded by existing tests `:2038`/`:2931`.
- G10/F2 serverInstanceId fallback + loud log + legacy-server check + documented schema decision → Task 2 (decision: keep optional; both servers verified to emit bootId; rationale in code comment).
- G11/F10 reset on both signals + first-ready idempotence + never-swallowed regression pins → Task 2 (App-level tests 1, 2, 5; slice-level reset semantics already pinned at `turnCompletionSlice.test.ts:82-97`).
- TDD unit list from the spec: retry fires/same requestId/restore:true (Task 1 tests 1-2), retries capped (test 3), exhaustion → error (test 3), bootId-absent fallback (Task 2 test 2), dedupe reset on both signals (Task 2 tests 1-2), no reset spam on every ready (Task 2 test 4). ✓
- E2E list: own RustServer/ephemeral ports (all three specs), restartAbrupt mid-create (Task 3), rapid double restart (Task 4), exactly-once chime across restart (Task 5), new files + playwright.config registration (each task). ✓
- No UNRESOLVED COVERAGE GAPS.

**1b. No silent deferrals:** every fix lands as production behavior proven by unit tests against real reducers/components and by e2e specs against a real rust server with real SIGKILL restarts. The only mocked seams in unit tests are the ws transport and xterm rendering (established harness convention); the e2e specs close those seams end-to-end. Task 5's doc comment states honestly which regression is unit-pinned vs e2e-proven.

**2. Placeholder scan:** the two "copy boilerplate from X verbatim" instructions (Task 1 harness from `TerminalView.lifecycle.test.tsx:1-120`; Task 2 harness from `App.ws-bootstrap.test.tsx`) reference exact existing sources and follow the repo's documented copy-per-file convention — the novel test bodies and all production code are given in full. No TBD/TODO/"add error handling" items remain.

**3. Type consistency:** `scheduleCreateRetry(requestId: string, kind: 'rate-limit' | 'launch'): boolean` is defined in Task 1 Step 1.3 and consumed with those exact arguments in Steps 1.4/1.5. `retryLaunchAfterInvalidTerminal(restore: boolean, deadTerminalId: string | undefined): boolean` defined 1.4, called 1.5 with `(launchAttempt!.restore, currentTerminalId)` — matching types. Task 2's `firstReadyBaseline`/`instanceChanged`/`bootIdRestart` are locals consumed in the same block. E2E helpers (`collectLeaves`, `selectShellIfPickerShowing`) are copied per spec with identical signatures.
