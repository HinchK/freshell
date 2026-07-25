# Hidden-Pane Rebind Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Background (hidden-tab) panes — both terminal and fresh-agent — must rebind their sessions after a WS reconnect or abrupt server restart WITHOUT being revealed, while expensive surface hydration stays deferred/staggered.

**Architecture:** Hidden panes are fully mounted React components (hiding is CSS `visibility:hidden` per-tab via the `hidden` prop chain `App → TabContent → PaneLayout → PaneContainer → leaf view`), so the rebind driver lives in the per-pane effects — no App-level driver is needed (`src/App.tsx`'s inventory census at ~:1018–1091 already walks every tab hidden-agnostically and stays untouched). The fix splits **session rebind** (cheap WS frames: `freshAgent.create`/`freshAgent.attach`/`terminal.attach`) from **surface hydration** (HTTP snapshot fetch, viewport hydrate): cheap rebind now runs regardless of `hidden`, paced through queues; hydration stays deferred to reveal (fresh-agent) or flows through the existing one-at-a-time background hydration queue (terminal). Concretely: (1) a new `src/lib/rebind-queue.ts` caps concurrent in-flight hidden fresh-agent rebinds (fresh-agent frames have NO server-side gate, so client pacing matters); (2) `FreshAgentView`'s four `hidden` early-returns (create effect, create-reconnect, attach effect, attach-reconnect) are removed, with hidden sends routed through the rebind queue and the reconnect-driven snapshot refresh deferred to reveal; (3) `TerminalView`'s two hidden-defer sites that today never re-drive (`terminal.created`-while-hidden ~:3833 and `runRefreshAttach`-while-hidden ~:2609) now call the existing `registerForBackgroundHydration()`, so the already-staggered hydration queue attaches them without reveal (terminal creates already fire hidden today and are `restore:true`-exempt from the server rate limit, with the server spawn gate — 4 concurrent, FIFO, from PR #532 — pacing actual PTY spawns; no client-side create pacing change is needed or wanted, to keep PR #532's launch-retry semantics untouched).

**Tech Stack:** React 18 + Redux Toolkit client, Vitest 3 (jsdom) unit tests, Playwright e2e with the owned `RustServer` fixture (`restartAbrupt()`), Rust server (READ-ONLY for this lane).

## Global Constraints

- **Worktree:** `/home/dan/code/freshell/.worktrees/hidden-pane-rebind`, branch `fix/hidden-pane-rebind`, base `origin/main @ c491aee0`. All paths below are relative to the worktree root.
- **Scope fence — you own:** `src/components/fresh-agent/FreshAgentView.tsx`, `src/components/TerminalView.tsx`, `src/App.tsx` recovery-driver region (this plan leaves it untouched), small client lib/store additions (`src/lib/rebind-queue.ts`), test files.
- **Scope fence — forbidden:** `src/store/persistMiddleware.ts`, `src/store/tab-registry-snapshot.ts` (Lane A1), everything under `crates/` (Lanes A2/A3/A5/A6 — server is READ-ONLY; if a server change seems required, STOP the task and report instead of editing).
- **No kimi/gemini** provider work anywhere.
- **PR #532 launch-retry semantics must stay intact** (see Task 5 hazards): `terminal.created` keeps calling `cancelCreateRetryTimer()` (no budget refund); `restore:true` re-arm ordering in `retryLaunchAfterInvalidTerminal`; nonzero-`terminalExitCode` never retries; `clearRateLimitRetry()` in the main-effect cleanup stays.
- **Tests:** Red-Green-Refactor. Single file: `npm run test:vitest -- run <path>` (ungated passthrough). Broad runs take the shared coordinator gate — run with `FRESHELL_TEST_SUMMARY="hidden-pane-rebind <phase>"` and WAIT if held (never kill a foreign holder); 5 sibling lanes run concurrently.
- **E2E:** own `RustServer` instances via `test/e2e-browser/helpers/rust-server.ts`, ephemeral ports only — NEVER 3001/3002; NEVER restart the user's self-hosted server; NEVER broad kill patterns (the fixture's ownership-safe reap is the only kill mechanism). `npm run build:client` before e2e; first e2e run pays `cargo build --release -p freshell-server`.
- **Lint:** `npm run lint` (eslint over `src/**` incl. `jsx-a11y`) must pass.
- **NodeNext ESM:** server-side TS imports need `.js` suffixes; client code under `src/` uses the `@/` alias per existing convention (this plan is client-only).
- **Disk:** ~36GB free — halt the task on any ENOSPC.
- **PR policy: NOT approved.** Final task pushes the branch and STOPS before `gh pr create`; report branch + proof.

---

### Task 1: Baseline verification

**Files:**
- Create: (none)
- Modify: (none)
- Test: whole suite (read-only run)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded green baseline at `c491aee0` that later tasks compare against.

- [ ] **Step 1: Check the coordinator gate**

Run: `npm run test:status`
Expected: prints holder status. If another agent holds the gate, note the holder and wait (the coordinated run below queues automatically, polling every 60s).

- [ ] **Step 2: Run the coordinated baseline suite**

Run: `FRESHELL_TEST_SUMMARY="hidden-pane-rebind baseline" npm test`
Expected: PASS (exit 0). This runs the default (jsdom) + server (node) vitest configs. If `test:status` shows an advisory reusable green baseline at commit `c491aee0`, you may cite it instead of re-running.
If the baseline is RED: STOP and report — do not build on a red base.

- [ ] **Step 3: Confirm branch state**

Run: `git -C /home/dan/code/freshell/.worktrees/hidden-pane-rebind status --short && git log --oneline -1`
Expected: clean tree (except this plan file once committed), HEAD at `c491aee0` on `fix/hidden-pane-rebind`.

No commit for this task.

---

### Task 2: `rebind-queue` — concurrency-capped, spaced rebind scheduler

**Files:**
- Create: `src/lib/rebind-queue.ts`
- Test: `test/unit/client/lib/rebind-queue.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; `setTimeout`/`clearTimeout` only).
- Produces (used verbatim by Tasks 3 and 4):
  - `interface RebindJob { key: string; run: (release: () => void) => void }`
  - `class RebindQueue { constructor(options?: { maxInFlight?: number; releaseTimeoutMs?: number; minStartIntervalMs?: number }); enqueue(job: RebindJob): void; readonly inFlightCount: number; readonly queuedCount: number }`
  - `function getRebindQueue(): RebindQueue` — module singleton (`maxInFlight: 4`, `releaseTimeoutMs: 10_000`, `minStartIntervalMs: 25`)
  - `function resetRebindQueueForTests(): void`

Semantics the tests pin: FIFO; at most `maxInFlight` jobs whose `release` has not been called; job starts spaced by at least `minStartIntervalMs`; `release` is idempotent; a job that never releases is auto-released after `releaseTimeoutMs`; `enqueue` dedups by `key` while a job with that key is queued or in-flight. `maxInFlight: 4` mirrors the server spawn gate (4 concurrent, `crates/freshell-ws/src/spawn_gate.rs`); `releaseTimeoutMs: 10_000` mirrors the gate's 10s permit timeout.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/lib/rebind-queue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RebindQueue, getRebindQueue, resetRebindQueueForTests } from '@/lib/rebind-queue'

describe('RebindQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps concurrent in-flight jobs at maxInFlight', () => {
    const queue = new RebindQueue({ maxInFlight: 2, minStartIntervalMs: 0 })
    const started: string[] = []
    const releases: Array<() => void> = []
    for (const key of ['a', 'b', 'c', 'd']) {
      queue.enqueue({ key, run: (release) => { started.push(key); releases.push(release) } })
    }
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a', 'b'])
    expect(queue.inFlightCount).toBe(2)
    expect(queue.queuedCount).toBe(2)
    releases[0]()
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('spaces job starts by minStartIntervalMs', () => {
    const queue = new RebindQueue({ maxInFlight: 4, minStartIntervalMs: 25 })
    const started: string[] = []
    for (const key of ['a', 'b', 'c']) {
      queue.enqueue({ key, run: (release) => { started.push(key); release() } })
    }
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a'])
    vi.advanceTimersByTime(25)
    expect(started).toEqual(['a', 'b'])
    vi.advanceTimersByTime(25)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('auto-releases a job that never calls release after releaseTimeoutMs', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0, releaseTimeoutMs: 10_000 })
    const started: string[] = []
    queue.enqueue({ key: 'stuck', run: () => { started.push('stuck') } })
    queue.enqueue({ key: 'next', run: (release) => { started.push('next'); release() } })
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['stuck'])
    vi.advanceTimersByTime(10_000)
    expect(started).toEqual(['stuck', 'next'])
  })

  it('release is idempotent (double release frees one slot only)', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const started: string[] = []
    let firstRelease: (() => void) | null = null
    queue.enqueue({ key: 'a', run: (release) => { started.push('a'); firstRelease = release } })
    queue.enqueue({ key: 'b', run: (release) => { started.push('b'); release() } })
    queue.enqueue({ key: 'c', run: () => { started.push('c') } })
    vi.advanceTimersByTime(0)
    firstRelease!()
    firstRelease!()
    vi.advanceTimersByTime(0)
    // 'b' started and self-released -> 'c' starts; the double release of 'a'
    // must not have freed a phantom second slot before 'b' completed.
    expect(started).toEqual(['a', 'b', 'c'])
    expect(queue.inFlightCount).toBe(1) // 'c' never releases
  })

  it('dedups by key while queued or in-flight', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const runs: string[] = []
    queue.enqueue({ key: 'pane-1:attach', run: () => { runs.push('first') } })
    queue.enqueue({ key: 'pane-1:attach', run: () => { runs.push('dup') } })
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['first'])
    expect(queue.queuedCount).toBe(0)
  })

  it('getRebindQueue returns a singleton reset by resetRebindQueueForTests', () => {
    const first = getRebindQueue()
    expect(getRebindQueue()).toBe(first)
    resetRebindQueueForTests()
    expect(getRebindQueue()).not.toBe(first)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/lib/rebind-queue.test.ts`
Expected: FAIL — `Cannot find module '@/lib/rebind-queue'` (or equivalent resolve error).

- [ ] **Step 3: Implement the module**

Create `src/lib/rebind-queue.ts`:

```ts
/**
 * RebindQueue -- paces "session rebind" work for HIDDEN panes so that a
 * reconnect/restart with many background panes does not stampede the server
 * (F8 / P1.11). Cheap rebind frames (freshAgent.create / freshAgent.attach)
 * are enqueued here when the owning pane is hidden; visible panes bypass the
 * queue entirely.
 *
 * Defaults mirror the server-side spawn gate from PR #532
 * (crates/freshell-ws/src/spawn_gate.rs: 4 concurrent, 10s permit timeout).
 * Restore creates bypass the server rate limiter, so this modest client-side
 * stagger is sufficient pacing.
 */

export interface RebindJob {
  /** Dedup key, e.g. `freshagent:<paneId>:attach`. */
  key: string
  /** Runs when a slot opens. MUST eventually call release() (auto-released
   *  after releaseTimeoutMs as a backstop). */
  run: (release: () => void) => void
}

interface RebindQueueOptions {
  maxInFlight?: number
  releaseTimeoutMs?: number
  minStartIntervalMs?: number
}

export class RebindQueue {
  private readonly maxInFlight: number
  private readonly releaseTimeoutMs: number
  private readonly minStartIntervalMs: number
  private readonly queued: RebindJob[] = []
  private readonly inFlightKeys = new Set<string>()
  private lastStartAt = Number.NEGATIVE_INFINITY
  private pumpTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RebindQueueOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 4
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? 10_000
    this.minStartIntervalMs = options.minStartIntervalMs ?? 25
  }

  get inFlightCount(): number {
    return this.inFlightKeys.size
  }

  get queuedCount(): number {
    return this.queued.length
  }

  enqueue(job: RebindJob): void {
    if (this.inFlightKeys.has(job.key)) return
    if (this.queued.some((queued) => queued.key === job.key)) return
    this.queued.push(job)
    this.schedulePump(0)
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpTimer) return
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      this.pump()
    }, delayMs)
  }

  private pump(): void {
    while (this.queued.length > 0 && this.inFlightKeys.size < this.maxInFlight) {
      const now = Date.now()
      const wait = this.lastStartAt + this.minStartIntervalMs - now
      if (wait > 0) {
        this.schedulePump(wait)
        return
      }
      const job = this.queued.shift()!
      this.lastStartAt = now
      this.start(job)
    }
  }

  private start(job: RebindJob): void {
    this.inFlightKeys.add(job.key)
    let released = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const release = () => {
      if (released) return
      released = true
      if (timeout) clearTimeout(timeout)
      this.inFlightKeys.delete(job.key)
      this.schedulePump(0)
    }
    timeout = setTimeout(release, this.releaseTimeoutMs)
    job.run(release)
  }
}

let singleton: RebindQueue | null = null

export function getRebindQueue(): RebindQueue {
  if (!singleton) singleton = new RebindQueue()
  return singleton
}

export function resetRebindQueueForTests(): void {
  singleton = null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/lib/rebind-queue.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Lint + typecheck the new module**

Run: `npm run lint && npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rebind-queue.ts test/unit/client/lib/rebind-queue.test.ts
git commit -m "feat(client): add RebindQueue to pace hidden-pane rebinds"
```

---

### Task 3: FreshAgentView — hidden panes ATTACH on reconnect; hydration deferred to reveal

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (attach effect :1113–1126, attach-reconnect handler :1128–1138, plus three new refs/effects near the existing ref block ~:664)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx` (new)

**Interfaces:**
- Consumes: `getRebindQueue()`, `RebindJob` from Task 2 (`import { getRebindQueue } from '@/lib/rebind-queue'`).
- Produces (relied on by Task 4): in-component refs `hiddenRef: React.MutableRefObject<boolean | undefined>`, `pendingRevealRefreshRef: React.MutableRefObject<boolean>`, `pendingRebindReleaseRef: React.MutableRefObject<(() => void) | null>`, and the reveal-refresh effect. Job keys: `` `freshagent:${paneId}:attach` `` and (Task 4) `` `freshagent:${paneId}:create` ``.

Current behavior (verbatim guards being removed): the attach effect early-returns on `if (!paneContent.sessionId || hidden) return` and the reconnect handler on `if (hidden || !paneContent.sessionId) return` — so a background tab's fresh-agent pane never re-attaches after a reconnect until reveal. Note the pane-refresh path (:997–1000) already sends `freshAgent.attach` while hidden, so "hidden never attaches" is not an invariant we'd be breaking.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`. Scaffolding rule: copy the module-mock preamble (the `vi.hoisted()` ws mock, the `vi.mock('@/lib/ws-client', ...)`, the partial `vi.mock('@/lib/api', ...)` with `importActual` spread, and any heavy-child mocks) and the base pane-content fixture / store composition **from the existing `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`** (its ws mock lives at lines ~20–40; its store-backed render helper at ~109). If a render fails on an unmocked heavy import, mirror the corresponding `vi.mock` line from that donor file. Then add:

```tsx
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { resetRebindQueueForTests } from '@/lib/rebind-queue'
// ... donor preamble: wsMock (send/onMessage/onReconnect), api mock, store builder,
// basePaneContent fixture (a FreshAgentPaneContent with provider 'claude',
// sessionType/createRequestId/status fields exactly as the donor's fixture) ...

function attachFramesSent() {
  return wsMock.send.mock.calls
    .map(([frame]: [{ type?: string }]) => frame)
    .filter((frame: { type?: string }) => frame?.type === 'freshAgent.attach')
}

function fireReconnect() {
  // Every registered onReconnect callback, newest-first registration order.
  for (const call of wsMock.onReconnect.mock.calls) {
    act(() => { call[0]() })
  }
}

describe('FreshAgentView hidden-pane rebind (F8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    wsMock.send.mockClear()
    wsMock.onReconnect.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a HIDDEN pane with a sessionId subscribes to reconnect and re-attaches', () => {
    const paneContent = { ...basePaneContent, sessionId: 'sess-1', status: 'idle' }
    renderView({ paneContent, hidden: true })
    // Rebind subscription must exist even while hidden:
    expect(wsMock.onReconnect).toHaveBeenCalled()
    wsMock.send.mockClear()
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) }) // drain the rebind queue spacing
    const attaches = attachFramesSent()
    expect(attaches.length).toBeGreaterThanOrEqual(1)
    expect(attaches[0]).toMatchObject({ type: 'freshAgent.attach', sessionId: 'sess-1' })
  })

  it('a HIDDEN pane attaches on mount (session rebind is visibility-independent)', () => {
    const paneContent = { ...basePaneContent, sessionId: 'sess-2', status: 'idle' }
    renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    expect(attachFramesSent().length).toBeGreaterThanOrEqual(1)
  })

  it('reveal after a hidden reconnect performs only surface hydration (no duplicate attach)', () => {
    const paneContent = { ...basePaneContent, sessionId: 'sess-3', status: 'idle' }
    const { rerender } = renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) })
    const attachCountWhileHidden = attachFramesSent().length
    expect(attachCountWhileHidden).toBeGreaterThanOrEqual(1)
    // Reveal:
    rerenderView(rerender, { paneContent, hidden: false })
    act(() => { vi.advanceTimersByTime(500) })
    // No NEW attach frame on reveal -- the session was already rebound.
    expect(attachFramesSent().length).toBe(attachCountWhileHidden)
  })

  it('reconnect while hidden defers snapshot refresh to reveal', async () => {
    // getFreshAgentThreadSnapshot is mocked in the donor preamble; capture its
    // call count. The initial mount fetch may run -- measure the DELTA around
    // the reconnect edge.
    const paneContent = { ...basePaneContent, sessionId: 'sess-4', status: 'idle' }
    const { rerender } = renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    const callsBeforeReconnect = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(callsBeforeReconnect)
    rerenderView(rerender, { paneContent, hidden: false })
    act(() => { vi.advanceTimersByTime(500) })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeReconnect)
  })
})
```

(`renderView` / `rerenderView` are thin wrappers around the donor's store-backed render helper, extended to pass the `hidden` prop through to `<FreshAgentView tabId paneId paneContent hidden />` — the donor helper does not currently pass `hidden` at all; add the prop parameter there or inline the `<Provider><FreshAgentView .../></Provider>` render in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`
Expected: FAIL — first test fails at `expect(wsMock.onReconnect).toHaveBeenCalled()` or at zero attach frames, because both effects early-return on `hidden`.

- [ ] **Step 3: Implement**

In `src/components/fresh-agent/FreshAgentView.tsx`:

3a. Add the import at the top with the other `@/lib` imports:

```tsx
import { getRebindQueue } from '@/lib/rebind-queue'
```

3b. Near the existing ref block (`createSentRef` is declared at ~:664), add:

```tsx
  // F8 hidden-pane rebind: mirror `hidden` into a ref for use inside queued
  // jobs and ws callbacks (same pattern as TerminalView's hiddenRef).
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])
  // Snapshot refresh owed at next reveal (set when a reconnect happens hidden).
  const pendingRevealRefreshRef = useRef(false)
  // Release callback for an in-flight queued CREATE rebind (Task 4 wires the
  // ack; declared here so both attach + create paths share one ref).
  const pendingRebindReleaseRef = useRef<(() => void) | null>(null)
```

3c. Replace the ATTACH effect (currently :1113–1126) with:

```tsx
  useEffect(() => {
    if (!paneContent.sessionId) return
    const sendAttach = () => {
      const current = paneContentRef.current
      if (!current.sessionId) return
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage(buildFreshAgentAttachMessage(current, cwd))
    }
    if (hiddenRef.current) {
      // Hidden: cheap session rebind still happens, but paced through the
      // rebind queue so 20 background panes do not stampede the server.
      getRebindQueue().enqueue({
        key: `freshagent:${paneId}:attach`,
        run: (release) => {
          sendAttach()
          // attach has no ack frame -- hold the slot briefly for spacing.
          setTimeout(release, 100)
        },
      })
    } else {
      sendAttach()
    }
  }, [
    freshOpenCodeRouteCwd,
    paneId,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionRef?.provider,
    paneContent.sessionRef?.sessionId,
    paneContent.sessionType,
    sendFreshAgentMessage,
  ])
```

Notes: `hidden` is deliberately REMOVED from the guard AND the dep array — reveal must not re-fire this effect (that is exactly the "reveal performs only surface hydration" contract; the session was already rebound while hidden). `freshOpenCodeRouteCwd` stays in deps so a cwd change still re-attaches (unchanged behavior), but the send reads the ref so a queued job uses fresh values.

3d. Replace the ATTACH-reconnect handler (currently :1128–1138) with:

```tsx
  useEffect(() => {
    if (!paneContent.sessionId) return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (!current.sessionId) return
      const sendAttach = () => {
        const latest = paneContentRef.current
        if (!latest.sessionId) return
        const cwd = getFreshOpenCodeRouteCwd(latest, { sessionCwd: freshOpenCodeRouteCwdRef.current })
        sendFreshAgentMessage(buildFreshAgentAttachMessage(latest, cwd))
      }
      if (hiddenRef.current) {
        getRebindQueue().enqueue({
          key: `freshagent:${paneId}:attach`,
          run: (release) => {
            sendAttach()
            setTimeout(release, 100)
          },
        })
        // Surface hydration (HTTP transcript snapshot fetch) is EXPENSIVE --
        // defer it until reveal instead of fetching for every hidden pane.
        pendingRevealRefreshRef.current = true
      } else {
        sendAttach()
        scheduleSnapshotRefresh()
      }
    })
  }, [paneId, paneContent.sessionId, scheduleSnapshotRefresh, sendFreshAgentMessage, ws])
```

3e. Add the reveal-refresh effect immediately after 3d:

```tsx
  // F8: consume the deferred snapshot refresh on reveal.
  useEffect(() => {
    if (hidden) return
    if (!pendingRevealRefreshRef.current) return
    pendingRevealRefreshRef.current = false
    scheduleSnapshotRefresh()
  }, [hidden, scheduleSnapshotRefresh])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`
Expected: PASS (all 4).

- [ ] **Step 5: Run the existing FreshAgentView suite for regressions**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/`
Expected: PASS. If an existing test asserted "no attach while hidden", update it to the new contract (attach IS sent while hidden, via the queue) — that is the intended behavior change of this lane.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx
git commit -m "fix(client): hidden fresh-agent panes re-attach on reconnect, hydration deferred to reveal"
```

---

### Task 4: FreshAgentView — hidden panes CREATE/re-create (restart recovery) through the rebind queue

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (create effect :1067–1091, create-reconnect handler :1093–1111, pane-refresh create branch :~1001, `ws.onMessage` table :1140–1277)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx` (extend)

**Interfaces:**
- Consumes: `getRebindQueue()` (Task 2); `hiddenRef` / `pendingRebindReleaseRef` (Task 3); existing `createSentRef`, `registerFreshAgentCreate`, `buildCreateMessage`, `paneContentRef`.
- Produces: after an abrupt restart, a hidden fresh-agent pane whose `.lost` recovery (:1534–1563, already un-gated) mints a new `createRequestId` now actually SENDS `freshAgent.create` without reveal. `createSentRef` semantics unchanged (reset on `createRequestId` change at :828–832).

Why this is safe: `freshAgent.create` spawns a sidecar process, so hidden creates are the storm risk — every hidden create goes through the queue (max 4 in-flight, released on the `freshAgent.created` / create-failed ack or the 10s backstop). The server has no rate limit on `freshAgent.*` (verified read-only: `crates/freshell-ws/src/create_limit.rs` covers `terminal.create` only), so this client pacing is the only pacing. The transport already replays `inFlightCreates` on reconnect (`src/lib/ws-client.ts:194–205`), which is visibility-blind — precedent that hidden creates already happen at the transport layer.

- [ ] **Step 1: Write the failing tests**

Append to `FreshAgentView.hidden-rebind.test.tsx`:

```tsx
describe('FreshAgentView hidden-pane create rebind (F8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    wsMock.send.mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  function createFramesSent() {
    return wsMock.send.mock.calls
      .map(([frame]: [{ type?: string }]) => frame)
      .filter((frame: { type?: string }) => frame?.type === 'freshAgent.create')
  }

  it('a HIDDEN pane in status creating sends freshAgent.create (restart recovery)', () => {
    const paneContent = {
      ...basePaneContent,
      sessionId: undefined,
      status: 'creating',
      createRequestId: 'req-hidden-1',
    }
    renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    const creates = createFramesSent()
    expect(creates.length).toBe(1)
    expect(creates[0]).toMatchObject({ type: 'freshAgent.create', requestId: 'req-hidden-1' })
  })

  it('hidden creates are paced: N panes never exceed 4 un-acked in-flight creates', () => {
    // Render 6 hidden panes sharing the mocked ws. None receives a
    // freshAgent.created ack, so the queue must hold creates 5 and 6 back
    // until the 10s auto-release backstop.
    for (let i = 0; i < 6; i++) {
      renderView({
        paneContent: {
          ...basePaneContent,
          sessionId: undefined,
          status: 'creating',
          createRequestId: `req-storm-${i}`,
        },
        paneId: `pane-storm-${i}`,
        hidden: true,
      })
    }
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(4)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(createFramesSent().length).toBe(6)
  })

  it('the freshAgent.created ack releases the queue slot', () => {
    for (let i = 0; i < 5; i++) {
      renderView({
        paneContent: {
          ...basePaneContent,
          sessionId: undefined,
          status: 'creating',
          createRequestId: `req-ack-${i}`,
        },
        paneId: `pane-ack-${i}`,
        hidden: true,
      })
    }
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(4)
    // Deliver the created ack for the first pane through every registered
    // onMessage handler (mirror the freshAgent.created frame shape used by
    // the donor FreshAgentView.test.tsx created-frame fixture).
    act(() => {
      for (const call of wsMock.onMessage.mock.calls) {
        call[0]({ type: 'freshAgent.created', requestId: 'req-ack-0', sessionId: 'sess-ack-0' })
      }
    })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`
Expected: the three new tests FAIL — zero `freshAgent.create` frames while hidden (create effect early-returns on `hidden`).

- [ ] **Step 3: Implement**

In `src/components/fresh-agent/FreshAgentView.tsx`:

3a. Replace the CREATE effect (currently :1067–1091) with:

```tsx
  useEffect(() => {
    if (paneContent.sessionId) return
    if (paneContent.restoreError) return
    if (
      paneContent.status !== 'creating'
      && paneContent.status !== 'starting'
      && !paneContent.sessionRef
    ) return
    if (createSentRef.current) return
    createSentRef.current = true
    const runCreate = (release?: () => void) => {
      const current = paneContentRef.current
      if (current.sessionId) {
        release?.()
        return
      }
      registerFreshAgentCreate(dispatch, current.createRequestId, {
        sessionType: current.sessionType,
        provider: current.provider,
        resumeSessionId: current.resumeSessionId,
        sessionRef: current.sessionRef,
        cwd: current.initialCwd,
      })
      if (release) pendingRebindReleaseRef.current = release
      sendFreshAgentMessage(buildCreateMessage(current))
    }
    if (hiddenRef.current) {
      getRebindQueue().enqueue({
        key: `freshagent:${paneId}:create`,
        run: runCreate,
      })
    } else {
      runCreate()
    }
  }, [
    buildCreateMessage,
    dispatch,
    paneId,
    paneContent,
    sendFreshAgentMessage,
  ])
```

(`hidden` removed from guard and deps; `createSentRef` is set at ENQUEUE time so the effect stays one-shot per `createRequestId` exactly as before — the render-phase reset at :828–832 is untouched.)

3b. Replace the CREATE-reconnect handler (currently :1093–1111) with:

```tsx
  useEffect(() => {
    if (paneContent.sessionId || !createSentRef.current) return
    if (paneContent.status !== 'creating' && paneContent.status !== 'starting') return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (current.sessionId) return
      if (current.status !== 'creating' && current.status !== 'starting') return
      const resend = (release?: () => void) => {
        const latest = paneContentRef.current
        if (latest.sessionId) {
          release?.()
          return
        }
        if (release) pendingRebindReleaseRef.current = release
        sendFreshAgentMessage(buildCreateMessage(latest))
      }
      if (hiddenRef.current) {
        getRebindQueue().enqueue({ key: `freshagent:${paneId}:create`, run: resend })
      } else {
        resend()
      }
    })
  }, [
    buildCreateMessage,
    paneId,
    paneContent.sessionId,
    paneContent.status,
    sendFreshAgentMessage,
    ws,
  ])
```

3c. In the pane-refresh-request effect (:987–1014), change the create-branch condition from

```tsx
    } else if (!hidden && (current.status === 'creating' || current.status === 'starting')) {
```

to

```tsx
    } else if (current.status === 'creating' || current.status === 'starting') {
```

and remove `hidden` from that effect's dep array (it is no longer referenced).

3d. Wire the ack release. Define next to `sendFreshAgentMessage` (~:754):

```tsx
  const releasePendingRebind = useCallback(() => {
    const release = pendingRebindReleaseRef.current
    pendingRebindReleaseRef.current = null
    release?.()
  }, [])
```

Then in the `ws.onMessage` dispatch table (:1140–1277), add `releasePendingRebind()` as the FIRST statement of (i) the branch handling the `freshAgent.created` frame for this pane's `createRequestId`, and (ii) the branch handling the create-failure frame (the one that feeds `pendingCreateFailure` / `clearPendingCreateFailure`). Add `releasePendingRebind` to that effect's dep array. Do not change anything else in the table. (The queue's 10s auto-release backstop covers a lost ack.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`
Expected: PASS (all 7 across Tasks 3+4).

- [ ] **Step 5: Regression sweep of the fresh-agent + client suites**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/rebind-queue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx
git commit -m "fix(client): hidden fresh-agent panes create/re-create via paced rebind queue"
```

---

### Task 5: TerminalView — hidden defer sites register for background hydration (attach without reveal)

**Files:**
- Modify: `src/components/TerminalView.tsx` (two edits: `terminal.created` hidden branch :3833–3840; `runRefreshAttach` hidden branch :2609–2617)
- Test: `test/unit/client/components/TerminalView.hidden-rebind.test.tsx` (new)

**Interfaces:**
- Consumes: existing `registerForBackgroundHydration()` (`TerminalView.tsx:2273–2282`) and the background hydration effect (:2689–2709) that attaches with `priority: 'background'`; existing `getHydrationQueue()` from `src/lib/hydration-queue.ts` (strict one-at-a-time — this IS the terminal-side stagger; no rebind-queue usage here).
- Produces: after `terminal.created` arrives while hidden, or after an explicit refresh detaches while hidden, the pane is queued for background hydration and gets a real `terminal.attach` without reveal. Reveal on an already-`live` pane performs only layout fit (existing :2660 guard `deferred.mode === 'waiting_for_geometry'` — pinned by a test below).

Background (the defect, verbatim from HEAD): sites (c) `onReconnect`+hidden (:4352) and (d) main-effect+hidden (:4400) already call `registerForBackgroundHydration()`, but site (a) `terminal.created`+hidden (:3833–3840) and site (b) `runRefreshAttach`+hidden (:2609–2617) do NOT — they set `waiting_for_geometry`, send no attach frame, and wait for reveal. Site (b) is worse: it already sent `terminal.detach` at :2607, so the pane is actively detached server-side. Meanwhile the server's idle reaper kills detached+running+quiet terminals after 15 minutes (`crates/freshell-ws/.../registry.rs:368` read-only) — a hidden wedged pane can be GC'd before reveal.

**PR #532 hazards to preserve (verify via the launchRetry suite in Step 5):**
1. `terminal.created` keeps calling `cancelCreateRetryTimer()` (:3755) — do not touch.
2. Hidden panes attaching earlier means `launchAttempt.attachReady` (set by `terminal.attach.ready`, :3722–3727) can now become `true` for hidden panes — that makes their launch-time INVALID_TERMINAL_ID classification match VISIBLE panes (reconnect-mint path instead of bounded launch retry). This is the intended convergence; the launchRetry tests must still pass unmodified.
3. Do not modify `retryLaunchAfterInvalidTerminal`, `scheduleCreateRetry`, or the `failedDuringLaunch` gate (:4135–4162).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/components/TerminalView.hidden-rebind.test.tsx`. Scaffolding rule: copy the module-mock preamble from `test/unit/client/components/TerminalView.visibility.test.tsx` — the `vi.hoisted()` ws mock (:12–17), the `vi.mock('@/lib/ws-client', ...)` (:57–65), its xterm/addon-fit/terminal-runtime mocks, and its `createStore()` composition (:83–90: `tabs`, `panes`, `settings`, `connection`, `sessionActivity` reducers) plus its terminal pane-content fixture and `<Provider><TerminalView tabId paneId paneContent hidden /></Provider>` render helper. Additionally mock the hydration queue:

```tsx
const hydrationMocks = vi.hoisted(() => {
  const registered: Array<{ tabId: string; paneId: string; trigger: () => void }> = []
  return {
    registered,
    queue: {
      register: vi.fn((entry: { tabId: string; paneId: string; trigger: () => void }, _options?: unknown) => {
        registered.push(entry)
      }),
      unregister: vi.fn(),
      onActiveTabReady: vi.fn(),
      onActiveTabChanged: vi.fn(),
      onHydrationComplete: vi.fn(),
    },
  }
})

vi.mock('@/lib/hydration-queue', () => ({
  getHydrationQueue: () => hydrationMocks.queue,
}))
```

(Check TerminalView's actual import specifier for `getHydrationQueue` with `grep -n "hydration-queue" src/components/TerminalView.tsx` and use that exact path in the `vi.mock`.)

Tests:

```tsx
function sentFrames(type: string) {
  return wsMocks.send.mock.calls
    .map(([frame]: [{ type?: string }]) => frame)
    .filter((frame: { type?: string }) => frame?.type === type)
}

function deliverWsMessage(frame: Record<string, unknown>) {
  act(() => {
    for (const call of wsMocks.onMessage.mock.calls) {
      call[0](frame)
    }
  })
}

describe('TerminalView hidden-pane rebind (F8)', () => {
  beforeEach(() => {
    wsMocks.send.mockClear()
    hydrationMocks.queue.register.mockClear()
    hydrationMocks.registered.length = 0
  })

  it('terminal.created while HIDDEN registers for background hydration and attaches when triggered', () => {
    // Pane starts in status 'creating' with no terminalId, hidden.
    renderTerminalView({
      paneContent: { ...baseTerminalContent, terminalId: undefined, status: 'creating', createRequestId: 'req-1' },
      hidden: true,
    })
    // The create is sent even while hidden (existing behavior).
    expect(sentFrames('terminal.create').length).toBeGreaterThanOrEqual(1)
    // Server acks the create. Mirror the terminal.created frame shape used in
    // TerminalView.lifecycle.test.tsx.
    deliverWsMessage({ type: 'terminal.created', requestId: 'req-1', terminalId: 'term-1', streamId: 'stream-1' })
    // THE FIX: hidden pane must now be registered for background hydration.
    expect(hydrationMocks.queue.register).toHaveBeenCalled()
    const entry = hydrationMocks.registered.at(-1)!
    // When the hydration queue grants the slot, a real attach frame goes out.
    act(() => { entry.trigger() })
    const attaches = sentFrames('terminal.attach')
    expect(attaches.length).toBeGreaterThanOrEqual(1)
    expect(attaches.at(-1)).toMatchObject({ terminalId: 'term-1' })
  })

  it('reveal after background rebind performs only surface hydration (no second attach when live)', () => {
    const { rerender } = renderTerminalView({
      paneContent: { ...baseTerminalContent, terminalId: undefined, status: 'creating', createRequestId: 'req-2' },
      hidden: true,
    })
    deliverWsMessage({ type: 'terminal.created', requestId: 'req-2', terminalId: 'term-2', streamId: 'stream-2' })
    act(() => { hydrationMocks.registered.at(-1)!.trigger() })
    // Complete the attach so deferred mode becomes 'live'. Mirror the
    // terminal.attach.ready frame shape used in TerminalView.lifecycle.test.tsx.
    deliverWsMessage({ type: 'terminal.attach.ready', terminalId: 'term-2', lastSeq: 0 })
    const attachesBeforeReveal = sentFrames('terminal.attach').length
    rerenderTerminalView(rerender, {
      paneContent: { ...baseTerminalContent, terminalId: 'term-2', status: 'running', createRequestId: 'req-2' },
      hidden: false,
    })
    // The reveal effect requires mode === 'waiting_for_geometry' to attach;
    // a live pane only gets a layout fit.
    expect(sentFrames('terminal.attach').length).toBe(attachesBeforeReveal)
  })
})
```

If the `terminal.created` / `terminal.attach.ready` frames need more fields to pass the component's handler guards, copy the exact fixture frames from `TerminalView.lifecycle.test.tsx` — do not invent fields.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx`
Expected: test 1 FAILS at `expect(hydrationMocks.queue.register).toHaveBeenCalled()` — the created-while-hidden branch never registers. (Test 2 may incidentally fail at the same point; that's fine for RED.)

- [ ] **Step 3: Implement (two 1-line insertions)**

3a. In the `terminal.created` handler's hidden branch (currently :3833–3840), after `setIsAttaching(false)`:

```tsx
            if (hiddenRef.current) {
              deferredAttachStateRef.current = {
                mode: 'waiting_for_geometry',
                pendingIntent: 'viewport_hydrate',
                pendingSinceSeq: 0,
                pendingReason: 'terminal_created',
              }
              setIsAttaching(false)
              // F8: a hidden pane still owes the server an attach. Drive it
              // through the background hydration queue (one-at-a-time stagger)
              // instead of waiting for reveal -- otherwise the terminal sits
              // detached server-side and is idle-reaped after 15 minutes.
              registerForBackgroundHydration()
            } else {
```

3b. In `runRefreshAttach`'s hidden branch (currently :2609–2617), after `setIsAttaching(false)`:

```tsx
        if (hiddenRef.current) {
          currentAttachRef.current = null
          deferredAttachStateRef.current = {
            mode: 'waiting_for_geometry',
            pendingIntent: 'viewport_hydrate',
            pendingSinceSeq: 0,
            pendingReason: 'explicit_refresh',
          }
          setIsAttaching(false)
          // F8: the detach was already sent above -- re-arm the attach via the
          // background hydration queue so a hidden refresh cannot strand the
          // pane detached until reveal.
          registerForBackgroundHydration()
        } else {
```

Nothing else changes. `registerForBackgroundHydration` (defined at :2273 as a component-level `useCallback`) is in scope at both sites; it self-dedups via `hydrationRegisteredRef`. The reveal effect (:2655–2687) already unregisters on reveal, and the background effect (:2690–2709) already no-ops if the pane became visible — no interaction changes needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx`
Expected: PASS (both).

- [ ] **Step 5: PR #532 + lifecycle regression sweep**

Run: `npm run test:vitest -- run test/unit/components/TerminalView.launchRetry.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx`
(If the launchRetry path 404s, locate it: `git ls-files | grep launchRetry` — the file was added by PR #532 and may live under `test/unit/client/components/`.)
Expected: PASS with zero modifications to those files. If launchRetry fails, the change broke #532 semantics — revert and re-approach; do NOT edit the launchRetry tests.

- [ ] **Step 6: Full TerminalView suite**

Run: `npm run test:vitest -- run test/unit/client/components/ -t 'TerminalView'` — or simply `npm run test:vitest -- run test/unit/client/components/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.hidden-rebind.test.tsx
git commit -m "fix(client): hidden terminal panes attach via background hydration after create/refresh"
```

---

### Task 6: E2E — hidden panes rebind across an abrupt restart without reveal

**Files:**
- Create: `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register the new spec in `RUST_ONLY_SPECS` and the `rust-chromium` project's `testMatch`, exactly like the existing `/restore-contract-wall-rust\.spec\.ts$/` entry)
- Test: the new spec itself + the existing wall entry

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts`) — `start()`, `restartAbrupt()`, `stop()`, ephemeral ports; `TestHarness`; fake sidecar fixture `test/e2e-browser/fixtures/fake-claude-sidecar.mjs`.
- Produces: e2e proof of the user story: multi-tab layout (visible + hidden terminal + hidden fresh-agent), SIGKILL restart, hidden panes rebound WITHOUT reveal (asserted via harness Redux state, which only updates when the server round-trips create/attach acks to this client — i.e. server-side rebind evidence), then reveal shows correct content/status instantly, and a busy-at-restart hidden pane un-wedges without reveal.

Per this suite's convention (documented in `restore-contract-wall-rust.spec.ts`'s header), helpers are COPIED into the spec, not imported from sibling specs. Copy these helpers verbatim from `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`: `bootWall`, `selectShellIfPickerShowing`, `createTabViaRest`, `restApiHeaders`, `waitForWsReady`, `seedWallConfig`, `installFakeCli`, `createFreshclaudePane` (and its transitive helpers). Known gotcha to carry over: with >1 tab mounted, `.xterm` locators match HIDDEN tabs' still-mounted terminals — always use `.xterm:visible` (the wall spec documents this at :1390–1396).

- [ ] **Step 1: Write the failing spec**

Create `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts` with the copied helpers plus these three tests (bodies complete; helper bodies copied from the wall spec):

```ts
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '../helpers/fixtures'
import { RustServer } from '../helpers/rust-server'
import { TestHarness } from '../helpers/test-harness'
// ... copied helpers: bootWall, selectShellIfPickerShowing, createTabViaRest,
// restApiHeaders, waitForWsReady, seedWallConfig, installFakeCli,
// createFreshclaudePane, FAKE_CLAUDE_SIDECAR_SOURCE ...

test.describe('hidden-pane rebind (F8 / P1.11)', () => {
  test('hidden BUSY terminal pane un-wedges after abrupt restart without reveal', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const hiddenTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId ?? null, { timeout: 20_000 })
        .not.toBeNull()
      const terminalIdBefore = (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId as string

      // Make the pane BUSY: run a long-lived foreground command.
      await page.locator('.xterm:visible').first().click()
      await page.keyboard.type('sleep 500')
      await page.keyboard.press('Enter')

      // Hide it: a second tab becomes active.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)

      // SIGKILL + revive. Do NOT touch the hidden tab.
      await server.restartAbrupt()
      await waitForWsReady(page)

      // Session rebind WITHOUT reveal: new terminalId + status running.
      await expect
        .poll(async () => {
          const content = (await harness.getPaneLayout(hiddenTabId))?.content
          const tid = content?.terminalId ?? null
          return tid && tid !== terminalIdBefore && content?.status === 'running' ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // Reveal and verify live content promptly (attach already happened in
      // the background -- reveal is surface work only).
      await revealTab(page, harness, hiddenTabId)
      await expect(page.locator('.xterm:visible').first()).toBeVisible()
      // A live shell prompt renders within the reveal budget; the pane must
      // NOT show the blocking creating spinner.
      await expect
        .poll(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.status, { timeout: 10_000 })
        .toBe('running')
    } finally {
      await server.stop()
    }
  })

  test('hidden fresh-agent pane recovers after abrupt restart without reveal', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const argvLog = path.join(os.tmpdir(), `freshell-e2e-claude-argv-${Date.now()}.jsonl`)
    const { server, harness, info } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE, FAKE_CLAUDE_ARGV_LOG: argvLog },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Create a freshclaude pane in the current tab (helper copied from the wall).
      const freshTabId = (await harness.getActiveTabId())!
      await createFreshclaudePane(page, harness)
      const sessionIdBefore: string = await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content?.sessionId ?? null, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content?.sessionId)

      // Hide it behind a new shell tab.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)

      await server.restartAbrupt()
      await waitForWsReady(page)

      // TARGET CONTRACT (F8): WITHOUT reveal, the hidden fresh-agent pane's
      // session recovers to a usable state. Harness state only reaches this
      // shape when the server has round-tripped attach/create for this pane.
      await expect
        .poll(async () => {
          const leaf = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))
          const status = leaf?.content?.status ?? null
          const sessionId = leaf?.content?.sessionId ?? null
          const usable = sessionId && ['connected', 'idle', 'running'].includes(status)
          return usable ? `${sessionId}:${status}` : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // Reveal: transcript surface hydrates and the composer is usable.
      await revealTab(page, harness, freshTabId)
      await expect
        .poll(async () => {
          const leaf = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))
          return ['connected', 'idle', 'running'].includes(leaf?.content?.status ?? '')
        }, { timeout: 15_000 })
        .toBe(true)
      void sessionIdBefore // recovery may resume the same session or mint a new one; usability is the contract
    } finally {
      await server.stop()
    }
  })

})
```

`revealTab` helper (add to the spec):

```ts
/** Reveal a hidden tab by clicking its tab strip button; falls back to a
 *  harness dispatch if the locator misses. Verify the action name first:
 *  `grep -n "setActiveTab" src/store/tabsSlice.ts`. */
async function revealTab(page: Page, harness: TestHarness, tabId: string): Promise<void> {
  const tabButton = page.locator(`[data-tab-id="${tabId}"]`)
  if (await tabButton.count()) {
    await tabButton.first().click()
  } else {
    await page.evaluate((id) => {
      ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
    }, tabId)
  }
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
}
```

Before writing, verify the tab-strip DOM hook and action name (`grep -n "data-tab-id\|setActiveTab" src/components/ src/store/tabsSlice.ts -r`) and use whichever exists; if the reducer action is named differently (e.g. `tabs/setActive`), use the real name.

Also verify `findFreshAgentLeaf` — copy it from the wall spec (:~506 region, layout tree walkers).

- [ ] **Step 2: Register the spec + build, then run to verify current state**

In `test/e2e-browser/playwright.config.ts`, add `/hidden-pane-rebind-rust\.spec\.ts$/` to `RUST_ONLY_SPECS` and to the `rust-chromium` project's `testMatch` array (mirror the wall spec's two entries exactly).

Run:
```bash
npm run build:client
npm run test:e2e -- --project=rust-chromium specs/hidden-pane-rebind-rust.spec.ts
```
Expected: with Tasks 3–5 already merged into the branch, tests 1 and 2 should PASS (green proof of the feature). If this spec had been written before Tasks 3–5 it would be red — if either test FAILS now, treat it as a real defect in the implementation tasks and fix there, not by weakening assertions.

Contingency for test 2 (fresh-agent): if the hidden pane never leaves `exited`/lost state, the client is not reacting to the server's response to `freshAgent.attach` for a dead session. Diagnose read-only: `readServerLogs(info.logsDir)` and `grep -rn "freshAgent.attach" crates/freshell-freshagent/src/ crates/freshell-ws/src/` to learn the exact error/lost frame the server sends, then handle that frame in `FreshAgentView`'s `ws.onMessage` table by dispatching the existing `markSessionLost` path (client-only change, in scope — the `.lost` recovery at :1534–1563 then re-creates with resume). If the server sends NOTHING for a dead-session attach, STOP and report (a server change would be required, which this lane must not make).

- [ ] **Step 3: Run the wall's hidden-pane entry (must stay green; nothing to un-pin)**

Run: `npm run test:e2e -- --project=rust-chromium specs/restore-contract-wall-rust.spec.ts -g 'hidden-pane rebind'`
Expected: PASS. Note: the spec's tasking says "un-pin the hidden-pane expected-fail entry if it now passes" — it ALREADY passes and is ALREADY un-pinned on main (`restore-contract-wall-rust.spec.ts:2107` carries a `PREDICTED-FAIL P1.11 (F8) but OBSERVED GREEN` comment and no `test.fail(...)`). There is no pin to remove; the required action is proving it still passes, which this step does. Do not edit that file.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): hidden-pane rebind across abrupt restart without reveal"
```

---

### Task 7: Full verification, push, report (NO PR)

**Files:**
- Create/Modify: none (fixes only if verification fails)

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch `fix/hidden-pane-rebind` + proof summary.

- [ ] **Step 1: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS (jsx-a11y included; no new warnings-as-errors).

- [ ] **Step 2: Coordinated full suite**

Run: `FRESHELL_TEST_SUMMARY="hidden-pane-rebind final check" npm test`
Expected: PASS. Queue politely on the shared gate if held (5 sibling lanes are running; waiting is expected).

- [ ] **Step 3: E2E sweep of the touched surface**

```bash
npm run build:client
npm run test:e2e -- --project=rust-chromium specs/hidden-pane-rebind-rust.spec.ts specs/restore-contract-wall-rust.spec.ts
```
Expected: the new spec PASSES; the wall spec's pinned entries stay expected-fail and its green entries (including `hidden-pane rebind` at :2107) stay green. An UNEXPECTED PASS of a pinned wall entry would hard-fail — if that happens, it means this lane incidentally fixed a pinned item; follow the wall's FLIP INSTRUCTION (delete that one `test.fail(...)` line) and re-run.

- [ ] **Step 4: Scope-fence audit**

Run: `git diff --stat origin/main...HEAD`
Expected touched files ONLY: `docs/plans/2026-07-25-hidden-pane-rebind.md`, `src/lib/rebind-queue.ts`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/components/TerminalView.tsx`, `test/unit/client/lib/rebind-queue.test.ts`, `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`, `test/unit/client/components/TerminalView.hidden-rebind.test.tsx`, `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts`, `test/e2e-browser/playwright.config.ts` (plus, only if the Task 6 contingency fired, the `FreshAgentView` onMessage addition already listed). NOTHING under `crates/`, `src/store/persistMiddleware.ts`, or `src/store/tab-registry-snapshot.ts`.

- [ ] **Step 5: Push and STOP (PR policy: not approved)**

```bash
git push -u origin fix/hidden-pane-rebind
```
Then STOP — do NOT run `gh pr create`. Report: branch name, the head commit SHA, and proof (baseline run, unit suite result, e2e spec results, wall entry green, lint/typecheck clean).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- Hidden fresh-agent panes excluded from create/attach/reconnect (:1068, :1094, :1114, :1129) → Tasks 3 & 4 remove all four gates (plus the :1001 refresh-branch gate).
- Hidden terminal deferred-attach only re-drives on reveal → Task 5 registers the two orphaned defer sites with the background hydration queue.
- Split cheap session rebind from expensive surface hydration → Task 3 (snapshot fetch deferred to reveal; attach frames always), Task 5 (attach via background queue; reveal does layout-only when live).
- Rebind storms / stagger aligned with server limits → Task 2 queue (maxInFlight 4 = spawn gate width, 10s release backstop = gate permit timeout, 25ms spacing); terminal creates deliberately unchanged (restore-bypass + server FIFO spawn gate already pace them; touching create timing risks PR #532 semantics).
- Mount reality investigated → hidden panes are mounted (CSS-only); per-pane effects are the honest home; `src/App.tsx` recovery driver already hidden-agnostic and untouched (documented in Architecture).
- TDD unit tests red-first for all four named behaviors → Task 3 (hidden attach on reconnect; reveal = surface-only), Task 4 (hidden create after restart census recovery; stagger caps in-flight), Task 2 (queue caps), Task 5 (terminal created-while-hidden attaches; reveal-when-live = no attach).
- E2E with own RustServer/ephemeral ports/restartAbrupt, hidden panes verified without reveal then revealed; busy pane un-wedges → Task 6.
- Un-pin wall entry if it now passes → nothing to un-pin (entry :2107 is already green and unpinned on main); Task 6 Step 3 proves it stays green.
- PR policy / scope fence / coordinator gate / a11y lint → Global Constraints + Tasks 1 and 7.

**1b. No silent deferrals:** every requirement lands as production behavior proven by the Task 6 e2e against a real (fixture-owned) Rust server with fake CLI/sidecar fixtures — fakes are used only as the agent-binary stand-ins the e2e suite always uses; no client stub substitutes for the rebind behavior itself. The one genuine unknown (server's reply to `freshAgent.attach` for a dead session) has an explicit in-scope contingency and an explicit STOP-and-report if it turns out to need a server change. No known-limitations section exists.

**2. Placeholder scan:** no TBD/TODO/"handle edge cases" steps; every code step shows code. Two deliberate "copy from donor file" scaffolding instructions (test-mock preambles, wall-spec helpers) reference concrete named files/lines and follow that suite's own copy-not-import convention; the novel test bodies and all production code are written out in full.

**3. Type consistency:** `RebindJob`/`RebindQueue`/`getRebindQueue`/`resetRebindQueueForTests` names match across Tasks 2/3/4; job keys `` `freshagent:${paneId}:attach` `` / `` `freshagent:${paneId}:create` `` consistent; `hiddenRef`/`pendingRevealRefreshRef`/`pendingRebindReleaseRef` declared in Task 3, consumed in Task 4; Task 5 uses only pre-existing component symbols (`registerForBackgroundHydration`, `deferredAttachStateRef`, `hiddenRef`, `setIsAttaching`).
