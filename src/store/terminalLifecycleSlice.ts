// Ephemeral crash/auto-resume presentation state (Lane D1). Deliberately a
// separate slice: pane persistence shapes are owned by Lane D4 and the
// persistMiddleware strip is a denylist — a new pane field would persist by
// default. (Two layers, both true: store.ts allowlists which SLICES persist;
// within an allowlisted slice, the strip deny-removes pane FIELDS.) This
// slice is never added to that allowlist, so it is never persisted.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface TerminalExitRecord { exitCode: number; at: number }
export interface AutoResumeNotice {
  kind: 'recovering' | 'resumed'
  attempt: number
  maxAttempts: number
  exitCode: number
  at: number
}

export interface PaneLifecycleEntry {
  lastTerminalId?: string
  exit?: TerminalExitRecord
  notice?: AutoResumeNotice
  /** Settle frame record (znhn item 3) — resumeCycles is present only for
   * flap-circuit-breaker settles and feeds the "crashed N times" banner. */
  settle?: { resumeCycles?: number }
}

interface TerminalLifecycleState {
  byPaneId: Record<string, PaneLifecycleEntry>
}

const initialState: TerminalLifecycleState = { byPaneId: {} }

const entry = (state: TerminalLifecycleState, paneId: string) =>
  (state.byPaneId[paneId] ??= {})

const slice = createSlice({
  name: 'terminalLifecycle',
  initialState,
  reducers: {
    // Dispatched by the pane's own terminal.exit handler BEFORE it clears
    // paneContent.terminalId (TerminalView.tsx:4141-4148) — this is the only
    // moment both paneId and the dying terminalId are simultaneously known.
    recordTerminalExit(state, a: PayloadAction<{ paneId: string; terminalId: string; exitCode: number; at: number }>) {
      const e = entry(state, a.payload.paneId)
      e.lastTerminalId = a.payload.terminalId
      e.exit = { exitCode: a.payload.exitCode, at: a.payload.at }
      // Fresh-eyes fix: an exit is always NEWER truth than any notice. Without
      // this, the exhaustion path (last crash -> settle, which emits no frame)
      // leaves the previous 'resumed' notice masking the role=alert error bar
      // — a success-toned banner on a dead pane. Clearing here makes the alert
      // show immediately on the final crash; a genuine in-flight resume
      // re-sets the notice when its `recovering` frame lands (which always
      // follows the exit, per Task 5's emit order).
      delete e.notice
      // Stale-settle leak fix (validated A15): a new crash must never inherit
      // an earlier breaker settle's resumeCycles, or the alert would read
      // "crashed N times — auto-resume paused" on a non-breaker crash.
      delete e.settle
    },
    recordAutoResumeRecovering(state, a: PayloadAction<{ paneId: string; attempt: number; maxAttempts: number; exitCode: number; at: number }>) {
      const { paneId, ...n } = a.payload
      entry(state, paneId).notice = { kind: 'recovering', ...n }
    },
    foldTerminalReplacement(state, a: PayloadAction<{ paneId: string; newTerminalId: string; exitCode: number; attempt: number; maxAttempts: number; at: number }>) {
      const { paneId, newTerminalId } = a.payload
      const e = entry(state, paneId)
      delete e.exit // pane is alive again — no error bar
      // znhn item 1: the ephemeral 'resumed' strip is retired — the
      // persistent crash trace on pane content is the post-resume indicator.
      delete e.notice
      // Stale-settle leak fix (validated A15, pairs with recordTerminalExit).
      delete e.settle
      e.lastTerminalId = newTerminalId
    },
    // Settle frame (terminal.status status:'exited') — the deterministic
    // replacement for the old 30s TTL guess (znhn item 3).
    recordAutoResumeSettled(
      state,
      action: PayloadAction<{ paneId: string; resumeCycles?: number }>
    ) {
      const { paneId, resumeCycles } = action.payload
      // Settle frames are redelivered by design (the cancel handler's
      // immediate frame + the hub's post-sleep re-emit). Bail before
      // touching the draft (entry() materializes missing entries — itself
      // a state change) so a redelivery keeps the same state reference and
      // subscribers see no change — not merely value-idempotent.
      const existing = state.byPaneId[paneId]
      if (
        existing !== undefined
        && existing.notice === undefined
        && existing.settle !== undefined
        && existing.settle.resumeCycles === resumeCycles
      ) return
      const e = entry(state, paneId)
      delete e.notice
      e.settle = resumeCycles !== undefined ? { resumeCycles } : {}
    },
    // D-3 backstop (validated): the settle/replaced frames are fire-and-forget
    // on a bounded broadcast (no replay; lagged receivers are force-closed),
    // so every missed-frame path necessarily passes through a WS reconnect.
    // Clearing stale recovering notices on reconnect makes a lying notice
    // impossible; frames stay the primary mechanism. No TTL returns.
    clearRecoveringNotices(state) {
      for (const e of Object.values(state.byPaneId)) {
        if (e?.notice?.kind === 'recovering') delete e.notice
      }
    },
    clearTerminalLifecycle(state, a: PayloadAction<{ paneId: string }>) {
      delete state.byPaneId[a.payload.paneId]
    },
  },
})

export const {
  recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement,
  recordAutoResumeSettled, clearRecoveringNotices, clearTerminalLifecycle,
} = slice.actions
export default slice.reducer

// Selectors tolerate an absent slice state (`s?.`): many pre-existing client
// tests build partial Redux stores without this reducer and render
// TerminalView, which calls these on every render. Mirrors the defensive
// access convention of paneRuntimeActivity consumers
// (`s.paneRuntimeActivity?.byPaneId ?? EMPTY`). Production stores always
// include the reducer (store.ts), so this never changes runtime behavior.
export const selectExitRecordFrom = (s: TerminalLifecycleState | undefined, paneId: string) => s?.byPaneId[paneId]?.exit
export const selectLastTerminalIdFrom = (s: TerminalLifecycleState | undefined, paneId: string) => s?.byPaneId[paneId]?.lastTerminalId
// No TTL (znhn item 3): notices are frame-driven — cleared by settle frames,
// terminal.replaced folds, terminal.exit, or the reconnect backstop.
export const selectActiveNoticeFrom = (s: TerminalLifecycleState | undefined, paneId: string) =>
  s?.byPaneId[paneId]?.notice
// Root-state wrappers — match the RootState typing convention of the sibling
// selectors in this directory (see turnCompletionSlice.ts for the pattern):
export const selectExitRecord = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectExitRecordFrom(root.terminalLifecycle, paneId)
export const selectActiveNotice = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectActiveNoticeFrom(root.terminalLifecycle, paneId)
export const selectResumeCycles = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  root.terminalLifecycle?.byPaneId[paneId]?.settle?.resumeCycles
