import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, {
  applyReconcileAttach,
  clearReconcilePendingPane,
  setReconcilePendingPanes,
} from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { paneKeyFor } from '@/lib/pane-reconcile'

// Task 8: view-level pre-verdict create wait (reload-path race, terminal leg).
// A hydrated pane that is reconcile-pending must NOT fire its mount-time
// terminal.create until its verdict folds -- bounded by
// RECONCILE_VERDICT_WAIT_MS, then falling back to the legacy eager create.
// The attach branch is NEVER gated. The reconnect re-drive is gated too
// (V3 caveat: mid-window WS flap).
//
// Mounting scaffold copied from TerminalView.session-reserved.test.tsx.

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const reconnectHandlers = new Set<() => void>()
  const send = vi.fn()
  const connect = vi.fn().mockResolvedValue(undefined)
  const onMessage = vi.fn((handler: (msg: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn((handler: () => void) => {
    reconnectHandlers.add(handler)
    return () => reconnectHandlers.delete(handler)
  })
  return {
    send,
    connect,
    onMessage,
    onReconnect,
    emit(msg: any) {
      for (const handler of [...messageHandlers]) handler(msg)
    },
    fireReconnect() {
      for (const handler of [...reconnectHandlers]) handler()
    },
    reset() {
      messageHandlers.clear()
      reconnectHandlers.clear()
      send.mockReset()
      connect.mockClear()
      onMessage.mockClear()
      onReconnect.mockClear()
    },
  }
})

// Keep the REAL module exports (RECONCILE_VERDICT_WAIT_MS is defined ONCE in
// ws-client -- never redefined here) and stub only the client accessor.
vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>()
  return {
    ...actual,
    getWsClient: () => ({
      send: wsHarness.send,
      connect: wsHarness.connect,
      onMessage: wsHarness.onMessage,
      onReconnect: wsHarness.onReconnect,
    }),
  }
})

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn((_data: string, cb?: () => void) => cb?.())
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

import TerminalView from '@/components/TerminalView'
import { RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'

const TAB_ID = 'tab1'
const PANE_ID = 'p1'
const PANE_KEY = paneKeyFor(TAB_ID, PANE_ID)

function paneContentWith(overrides: Partial<TerminalPaneContent> = {}): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'cr-1',
    status: 'creating',
    mode: 'shell',
    shell: 'system',
    initialCwd: '/tmp',
    ...overrides,
  }
}

function buildStore(paneContent: TerminalPaneContent) {
  const root: PaneNode = { type: 'leaf', id: PANE_ID, content: paneContent }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB_ID,
          mode: paneContent.mode,
          status: paneContent.status,
          title: 'Terminal',
          titleSetByUser: false,
          createRequestId: paneContent.createRequestId,
        }],
        activeTabId: TAB_ID,
      },
      panes: {
        layouts: { [TAB_ID]: root },
        activePane: { [TAB_ID]: PANE_ID },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    } as any,
  })
}

async function flushEffects() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Production passes paneContent selected from the store, so a store dispatch
// (e.g. a reconcile verdict fold) re-renders TerminalView with fresh content.
function ConnectedTerminalView() {
  const content = useSelector((state: any) => {
    const layout = state.panes.layouts[TAB_ID] as { type: 'leaf'; content: TerminalPaneContent }
    return layout.content
  })
  return <TerminalView tabId={TAB_ID} paneId={PANE_ID} paneContent={content} />
}

function seedPendingForPane(store: ReturnType<typeof buildStore>) {
  store.dispatch(setReconcilePendingPanes({ paneKeys: [PANE_KEY], startedAt: Date.now() }))
}

async function renderTerminalPane(
  overrides: Partial<TerminalPaneContent>,
  { pending = false }: { pending?: boolean } = {},
) {
  const store = buildStore(paneContentWith(overrides))
  if (pending) seedPendingForPane(store)
  render(
    <Provider store={store}>
      <ConnectedTerminalView />
    </Provider>
  )
  await flushEffects()
  return { store }
}

function sentOfType(type: string) {
  return wsHarness.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === type)
}

describe('TerminalView pre-verdict create wait (reload-path race, terminal leg)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsHarness.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('defers the mount create while the pane is reconcile-pending', async () => {
    await renderTerminalPane({ terminalId: undefined, status: 'creating' }, { pending: true })
    expect(sentOfType('terminal.create')).toHaveLength(0)
  })

  it('an attach verdict fold drives attach without any create', async () => {
    const { store } = await renderTerminalPane({ terminalId: undefined, status: 'creating' }, { pending: true })
    act(() => {
      store.dispatch(applyReconcileAttach({ tabId: TAB_ID, paneId: PANE_ID, terminalId: 'term-9' }))
    })
    await flushEffects()
    expect(sentOfType('terminal.create')).toHaveLength(0)
    expect(sentOfType('terminal.attach').some((m) => m.terminalId === 'term-9')).toBe(true)
  })

  it('falls back to the legacy create after RECONCILE_VERDICT_WAIT_MS', async () => {
    await renderTerminalPane({ terminalId: undefined, status: 'creating' }, { pending: true })
    expect(sentOfType('terminal.create')).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILE_VERDICT_WAIT_MS + 50)
    })
    const creates = sentOfType('terminal.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].requestId).toBe('cr-1') // same createRequestId, never re-minted
  })

  it('a pane with a live terminalId attaches immediately even while pending', async () => {
    await renderTerminalPane({ terminalId: 'term-1', status: 'running' }, { pending: true })
    expect(sentOfType('terminal.attach')).toHaveLength(1)
    expect(sentOfType('terminal.create')).toHaveLength(0)
  })

  it('a mid-window reconnect does NOT fire the ungated re-drive while the pane is reconcile-pending', async () => {
    const { store } = await renderTerminalPane({ terminalId: undefined, status: 'creating' }, { pending: true })
    wsHarness.fireReconnect()
    await flushEffects()
    expect(sentOfType('terminal.create')).toHaveLength(0)

    // Release the gate: the effect re-fires (reconcilePendingSince is a dep)
    // and the legacy drive proceeds -- same createRequestId, never re-minted.
    act(() => {
      store.dispatch(clearReconcilePendingPane({ paneKey: PANE_KEY }))
    })
    await flushEffects()
    const afterClear = sentOfType('terminal.create')
    expect(afterClear).toHaveLength(1)
    expect(afterClear[0].requestId).toBe('cr-1')

    // A later reconnect now re-drives too (pane still unanchored) -- the
    // legacy re-drive path is intact once the pending window is gone.
    wsHarness.fireReconnect()
    await flushEffects()
    const afterReconnect = sentOfType('terminal.create')
    expect(afterReconnect).toHaveLength(2)
    expect(afterReconnect[1].requestId).toBe('cr-1')
  })

  it('capability off / pane not in the request: behavior identical to today (eager create)', async () => {
    // No pending entry seeded -- the map has no entry for this pane.
    await renderTerminalPane({ terminalId: undefined, status: 'creating' })
    const creates = sentOfType('terminal.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].requestId).toBe('cr-1')
  })
})
