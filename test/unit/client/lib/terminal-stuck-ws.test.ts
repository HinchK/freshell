import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { TerminalStuckSchema } from '@shared/ws-protocol'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { updatePaneContent } from '@/store/panesSlice'
import terminalLifecycleReducer, {
  clearTerminalLifecycle,
  clearTerminalStuckIfOtherTerminal,
  recordTerminalStuck,
  selectStuckEntryFrom,
} from '@/store/terminalLifecycleSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { applyTerminalStuck } from '@/store/turnCompletionThunks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

describe('terminal.stuck wire contract', () => {
  it('accepts a stuck transition frame', () => {
    const frame = { type: 'terminal.stuck' as const, terminalId: 't-1', at: 1789947521195, stuck: true }
    expect(TerminalStuckSchema.parse(frame)).toEqual(frame)
  })
  it('accepts the unstuck transition and rejects wrong shapes', () => {
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1, stuck: false }).success).toBe(true)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1 }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.idle', terminalId: 't-1', at: 1, stuck: true }).success).toBe(false)
  })
  it('mirrors TerminalIdleSchema refinements (carried Task 2 review Nit-2): non-empty terminalId, non-negative integer at', () => {
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: '', at: 1, stuck: true }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: -1, stuck: true }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1.5, stuck: true }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 0, stuck: false }).success).toBe(true)
  })
})

// ── Client fold (wedge-backstop Task 4) ──
// Harness mirrors fresh-agent-ws.test.ts's createFreshAgentPaneStore (the
// action-recording middleware pin): a real panes layout so the fold resolves
// the owning pane via selectTabPaneByTerminalId, plus a turnCompletion
// reducer so a (hypothetical, forbidden) completion dispatch would land in
// real state — the no-fabrication pin would catch it.

const TAB = 'tab-stuck-fold'
const PANE = 'pane-stuck-fold'
const REQ = 'req-stuck-fold'

function makeFoldStore(seenActionTypes: string[] = []) {
  const actionRecorder = () => (next: (action: unknown) => unknown) => (action: { type?: string }) => {
    if (typeof action.type === 'string') seenActionTypes.push(action.type)
    return next(action)
  }
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: REQ,
    terminalId: 't-1',
    status: 'running',
    mode: 'opencode',
    shell: 'system',
  }
  const root: PaneNode = { type: 'leaf', id: PANE, content: paneContent }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      terminalLifecycle: terminalLifecycleReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB, mode: 'opencode', status: 'running', title: 'Opencode',
          titleSetByUser: false, createRequestId: REQ,
        }],
        activeTabId: TAB,
      },
      panes: { layouts: { [TAB]: root }, activePane: { [TAB]: PANE }, paneTitles: {} },
      terminalLifecycle: { byPaneId: {}, stuckAtByPaneId: {} },
    } as any,
    middleware: (getDefault) => getDefault().prepend(actionRecorder),
  })
}

describe('terminal.stuck client fold (applyTerminalStuck)', () => {
  it('folds terminal.stuck true into stuckAtByPaneId for the owning pane and dispatches no turnCompletion action', () => {
    const actionTypes: string[] = []
    const store = makeFoldStore(actionTypes)

    store.dispatch(applyTerminalStuck({
      type: 'terminal.stuck',
      terminalId: 't-1',
      at: 123,
      stuck: true,
    }) as any)

    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE))
      .toEqual({ at: 123, terminalId: 't-1' })
    // The stuck flag is SURFACE-ONLY: it must never fabricate a completion
    // edge (green/sound) — the freshcodex deadman contract.
    expect(actionTypes.filter((type) => type.startsWith('turnCompletion/'))).toHaveLength(0)
  })

  it('folds terminal.stuck false by clearing the pane entry', () => {
    const store = makeFoldStore()
    store.dispatch(recordTerminalStuck({ paneId: PANE, terminalId: 't-1', at: 123 }))

    store.dispatch(applyTerminalStuck({
      type: 'terminal.stuck',
      terminalId: 't-1',
      at: 200,
      stuck: false,
    }) as any)

    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
  })

  it('ignores frames for unknown terminal ids (no pane resolution) and frames the tightened schema rejects', () => {
    const store = makeFoldStore()

    store.dispatch(applyTerminalStuck({
      type: 'terminal.stuck',
      terminalId: 't-unknown',
      at: 123,
      stuck: true,
    }) as any)
    expect(store.getState().terminalLifecycle.stuckAtByPaneId).toEqual({})

    // Schema-rejected frames (empty terminalId / negative non-integer at)
    // must never record — even when some pane could be resolved.
    store.dispatch(applyTerminalStuck({ type: 'terminal.stuck', terminalId: '', at: 123, stuck: true }) as any)
    store.dispatch(applyTerminalStuck({ type: 'terminal.stuck', terminalId: 't-1', at: -5, stuck: true }) as any)
    expect(store.getState().terminalLifecycle.stuckAtByPaneId).toEqual({})
  })

  it('clearing terminal lifecycle (relaunch) drops the stuck entry', () => {
    const store = makeFoldStore()
    store.dispatch(recordTerminalStuck({ paneId: PANE, terminalId: 't-1', at: 123 }))

    store.dispatch(clearTerminalLifecycle({ paneId: PANE }))

    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
  })

  it('adoption of a different terminalId clears a stale stuck entry and a re-flag re-records (self-healing pin)', () => {
    const store = makeFoldStore()
    store.dispatch(recordTerminalStuck({ paneId: PANE, terminalId: 'T0', at: 100 }))

    // The terminal.created fold's clear-on-adoption (TerminalView dispatches
    // exactly this when the pane adopts a new terminalId).
    store.dispatch(clearTerminalStuckIfOtherTerminal({ paneId: PANE, terminalId: 'T1' }))
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()

    // The created fold also bound the pane to the new terminal — mirror it
    // so the next stuck frame resolves this pane.
    const adopted = {
      ...((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content),
      terminalId: 'T1',
    }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: adopted }))

    // A genuinely wedged replacement re-flags via the next sweep broadcast:
    store.dispatch(applyTerminalStuck({
      type: 'terminal.stuck',
      terminalId: 'T1',
      at: 300,
      stuck: true,
    }) as any)
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE))
      .toEqual({ at: 300, terminalId: 'T1' })
  })
})
