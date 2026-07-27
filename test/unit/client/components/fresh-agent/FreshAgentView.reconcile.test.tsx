import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, {
  applyFreshAgentReconcileAttach,
  initLayout,
  resetFreshAgentPaneForReconcileCreate,
  setReconcilePendingPanes,
} from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { useAppSelector } from '@/store/hooks'
import { resetRebindQueueForTests } from '@/lib/rebind-queue'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

// Task 9: fresh-agent VIEW leg of pane reconcile -- verdict folds drive the
// create/attach effects (epoch re-fire with the SAME createRequestId),
// freshAgent.created consumes pendingReconcile, the mount create defers
// bounded while the pane is reconcile-pending, and reconcileNotice renders
// once as a role="status" line.
//
// Harness reused from FreshAgentView.test.tsx / FreshAgentView.hidden-rebind
// .test.tsx (store-backed render so verdict folds re-render the component),
// pending-gate scaffold from TerminalView.verdict-wait.test.tsx.

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn(),
}))

// Keep the REAL module exports (RECONCILE_VERDICT_WAIT_MS is defined ONCE in
// ws-client -- never redefined here) and stub only the client accessor.
vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>()
  return {
    ...actual,
    getWsClient: () => wsMock,
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentModelCapabilities: apiMock.getFreshAgentModelCapabilities,
    setSessionMetadata: apiMock.setSessionMetadata,
  }
})

import { RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'

const tabId = 'tab-1'
const paneId = 'pane-1'
// Claude durable session ids are UUIDs (isValidClaudeSessionId gates on it).
const DURABLE = '550e8400-e29b-41d4-a716-446655440777'

const baseContent: FreshAgentPaneContent = {
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-1',
  status: 'creating',
}

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      tabs: tabsReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabs: {
        tabs: [{
          id: tabId,
          createRequestId: tabId,
          title: 'Tab 1',
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        }],
        activeTabId: tabId,
        renameRequestTabId: null,
        tombstones: [],
      },
    },
  })
}

let store: ReturnType<typeof createStore>

// Production passes paneContent selected from the store, so a store dispatch
// (e.g. a reconcile verdict fold) re-renders FreshAgentView with fresh content.
function StoreBackedFreshAgentView({ hidden }: { hidden?: boolean }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
}

function seedPendingForPane(seedTabId: string, seedPaneId: string) {
  store.dispatch(setReconcilePendingPanes({
    paneKeys: [`${seedTabId}:${seedPaneId}`],
    startedAt: Date.now(),
  }))
}

function renderFreshAgentPane(
  overrides: Partial<FreshAgentPaneContent> & { hidden?: boolean } = {},
) {
  const { hidden, ...contentOverrides } = overrides
  // The harness seeds pane content through initLayout, which runs
  // normalizePaneContent -- Task 2's fresh-agent preservation is what lets a
  // seeded pendingReconcile/reconcileNotice/reconcileEpoch reach the component.
  store.dispatch(initLayout({ tabId, paneId, content: { ...baseContent, ...contentOverrides } }))
  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView hidden={hidden} />
    </Provider>,
  )
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function sentOfType(type: string) {
  return wsMock.send.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message?.type === type)
}

function receiveWs(message: Record<string, unknown>) {
  act(() => {
    for (const call of wsMock.onMessage.mock.calls) {
      call[0](message)
    }
  })
}

function leafContent(state: ReturnType<typeof store.getState>): FreshAgentPaneContent {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
    throw new Error('Expected fresh-agent leaf content')
  }
  return layout.content
}

describe('FreshAgentView reconcile fold drive (Task 9)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    store = createStore()
    wsMock.send.mockReset()
    wsMock.onMessage.mockReset()
    wsMock.onReconnect.mockReset()
    wsMock.onMessage.mockImplementation(() => () => {})
    wsMock.onReconnect.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentModelCapabilities.mockReset()
    apiMock.post.mockReset()
    apiMock.setSessionMetadata.mockReset()
    apiMock.post.mockResolvedValue({ title: null, source: 'none' })
    apiMock.setSessionMetadata.mockResolvedValue(undefined)
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Claude summary',
      capabilities: { send: true, interrupt: true, fork: true },
      diffs: [],
      worktrees: [],
      turns: [],
    })
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [],
    })
  })

  afterEach(async () => {
    // Drain pending timers + promise continuations inside act BEFORE
    // restoring real timers, so no React work leaks past teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    cleanup()
    vi.useRealTimers()
  })

  it('a respawn fold on a mounted pane re-sends freshAgent.create with the server-named ref and the SAME createRequestId', async () => {
    // Mount in 'creating' so the initial create CONSUMES createSentRef, then
    // land the created ack -- the pane is now live with the same
    // createRequestId. Only the reconcileEpoch bump can re-arm the create
    // effect after the fold (council rule 2: the id is never re-minted).
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', createRequestId: 'req-1' })
    await flush() // initial mount consumed createSentRef
    expect(sentOfType('freshAgent.create')).toHaveLength(1)
    receiveWs({ type: 'freshAgent.created', requestId: 'req-1', sessionId: 'live-1', sessionType: 'freshclaude', provider: 'claude', runtimeProvider: 'claude' })
    await flush()
    act(() => {
      store.dispatch(resetFreshAgentPaneForReconcileCreate({
        tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE },
      }))
    })
    await flush()
    const creates = sentOfType('freshAgent.create')
    expect(creates).toHaveLength(2) // the fold re-fired the create effect
    const last = creates[creates.length - 1]
    expect(last.requestId).toBe('req-1')
    expect(last.resumeSessionId).toBe(DURABLE)
    expect(last.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })

  it('an attach fold sends freshAgent.attach and no create', async () => {
    seedPendingForPane(tabId, paneId) // gate the mount create so the fold decides
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    act(() => {
      store.dispatch(applyFreshAgentReconcileAttach({ tabId, paneId, sessionRef: { provider: 'claude', sessionId: DURABLE } }))
    })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0)
    const attach = sentOfType('freshAgent.attach').find((m) => m.sessionId === DURABLE)!
    expect(attach).toBeTruthy()
    // claude's attach_durable_id reads ONLY resumeSessionId/sessionRef (claude.rs:866-872):
    // the durable MUST ride those fields or a resumable session answers lost_session_frame.
    expect(attach.resumeSessionId).toBe(DURABLE)
    expect(attach.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })

  it('the mount create defers while reconcile-pending and falls back after the bound', async () => {
    seedPendingForPane(tabId, paneId)
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILE_VERDICT_WAIT_MS + 50)
    })
    expect(sentOfType('freshAgent.create')).toHaveLength(1)
  })

  it('freshAgent.created clears pendingReconcile', async () => {
    renderFreshAgentPane({ status: 'creating', pendingReconcile: 'respawn', createRequestId: 'req-1' })
    await flush()
    receiveWs({ type: 'freshAgent.created', requestId: 'req-1', sessionId: 's-1', sessionType: 'freshclaude', provider: 'claude', runtimeProvider: 'claude' })
    await flush()
    expect(leafContent(store.getState()).pendingReconcile).toBeUndefined()
  })

  it('reconcileNotice renders once as role=status and is cleared', async () => {
    renderFreshAgentPane({ sessionId: 'live-1', status: 'connected', reconcileNotice: 'Reconciled: attached to the corrected session.' })
    // The notice renders synchronously on mount (getByRole, not findByRole:
    // waitFor does not advance vitest fake timers, so a missing element would
    // stall the full test timeout instead of failing fast).
    expect(screen.getByRole('status')).toHaveTextContent(/corrected/i)
    // The notice is a timed one-shot (5s visible, then cleared) -- advance
    // past the dismiss window and verify it was consumed from the store.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_050)
    })
    expect(leafContent(store.getState()).reconcileNotice).toBeUndefined()
  })

  it('a HIDDEN pane composes with the pending gate: nothing enqueues pre-verdict, the fold-driven create enqueues via the rebind queue', async () => {
    // A12 composition coverage (the one interaction no existing suite touches):
    // hidden pane + pending seeded -> the create effect returns BEFORE the
    // hiddenRef enqueue branch, so the rebind queue stays empty;
    // dispatch resetFreshAgentPaneForReconcileCreate (fold) -> pending cleared,
    // epoch bumps, effect re-fires -> the create ENQUEUES (not direct-send) and
    // the queue's pacing contract (<=4 un-acked) still governs it.
    seedPendingForPane(tabId, paneId)
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', hidden: true, sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0) // nothing enqueued, nothing sent
    act(() => {
      store.dispatch(resetFreshAgentPaneForReconcileCreate({ tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE } }))
    })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100) // rebind-queue pacing tick
    })
    expect(sentOfType('freshAgent.create')).toHaveLength(1) // enqueued then paced out, same createRequestId
  })
})
