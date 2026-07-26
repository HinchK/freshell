import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { resetRebindQueueForTests } from '@/lib/rebind-queue'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

// Claude snapshot hydration is keyed by Claude's durable UUID
// (getFreshAgentSnapshotThreadId -> getCanonicalPaneResumeSessionId gates on
// isValidClaudeSessionId), so the fixtures use UUID-format session ids.
const SESS_1 = '550e8400-e29b-41d4-a716-446655440101'
const SESS_2 = '550e8400-e29b-41d4-a716-446655440102'
const SESS_3 = '550e8400-e29b-41d4-a716-446655440103'
const SESS_4 = '550e8400-e29b-41d4-a716-446655440104'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

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

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

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
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Tab 1',
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      },
    },
  })
}

const basePaneContent: FreshAgentPaneContent = {
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-hidden-rebind',
  status: 'idle',
}

let currentStore: ReturnType<typeof createStore>

function renderView({ paneContent, hidden }: { paneContent: FreshAgentPaneContent; hidden: boolean }) {
  currentStore = createStore()
  currentStore.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: paneContent }))
  return render(
    <Provider store={currentStore}>
      <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={hidden} />
    </Provider>,
  )
}

function rerenderView(
  rerender: ReturnType<typeof render>['rerender'],
  { paneContent, hidden }: { paneContent: FreshAgentPaneContent; hidden: boolean },
) {
  rerender(
    <Provider store={currentStore}>
      <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={hidden} />
    </Provider>,
  )
}

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
    wsMock.onMessage.mockClear()
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
    // Drain pending timers + promise continuations (mocked snapshot fetches,
    // queue release timers) inside act BEFORE restoring real timers, so no
    // React work leaks past environment teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    vi.useRealTimers()
  })

  it('a HIDDEN pane with a sessionId subscribes to reconnect and re-attaches', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_1, status: 'idle' as const }
    renderView({ paneContent, hidden: true })
    // Rebind subscription must exist even while hidden:
    expect(wsMock.onReconnect).toHaveBeenCalled()
    wsMock.send.mockClear()
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) }) // drain the rebind queue spacing
    const attaches = attachFramesSent()
    expect(attaches.length).toBeGreaterThanOrEqual(1)
    expect(attaches[0]).toMatchObject({ type: 'freshAgent.attach', sessionId: SESS_1 })
  })

  it('a HIDDEN pane attaches on mount (session rebind is visibility-independent)', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_2, status: 'idle' as const }
    renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    expect(attachFramesSent().length).toBeGreaterThanOrEqual(1)
  })

  it('reveal after a hidden reconnect performs only surface hydration (no duplicate attach)', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_3, status: 'idle' as const }
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
    const paneContent = { ...basePaneContent, sessionId: SESS_4, status: 'idle' as const }
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
