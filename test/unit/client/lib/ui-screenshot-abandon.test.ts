import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import html2canvas from 'html2canvas'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import { registerTerminalCaptureHandler } from '@/lib/screenshot-capture-env'
import { paneSelectionMiddleware, resetPaneFocusOwnershipForTests } from '@/lib/pane-focus-ownership'

vi.mock('html2canvas', () => ({
  default: vi.fn(),
}))

// These tests use the REAL screenshot-capture-env module (the neighboring
// ui-screenshot.test.ts mocks it) so renderer suspension/refcount events are
// observable end-to-end.

const PNG_PREFIX = 'data:image/png;base64,'

function setRect(node: Element, width: number, height: number) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  })
}

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(paneSelectionMiddleware as never),
    preloadedState: {
      tabs: {
        tabs: [
          { id: 'tab-1', createRequestId: 'req-1', title: 'One', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 1 },
          { id: 'tab-2', createRequestId: 'req-2', title: 'Two', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 2 },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': { type: 'leaf' as const, id: 'pane-1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-1' } },
          'tab-2': { type: 'leaf' as const, id: 'pane-2', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-2' } },
        },
        activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as any,
  })
}

describe('captureUiScreenshot abandon fencing', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetAllMocks()
  })

  afterEach(() => {
    resetPaneFocusOwnershipForTests()
    document.body.innerHTML = ''
  })

  it('fences an abandoned capture: renderer resume + focus restore fire at abandonment (before the successor starts), and the successor snapshots the restored state', async () => {
    const store = createStore()
    // A third tab exists for the successor's target (agent-style background create).
    store.dispatch(addTab({ id: 'tab-3', title: 'Three', activate: false }))

    // Targets exist but start HIDDEN; a store subscription flips each to
    // visible exactly when the capture selects its tab (vis-wait then passes).
    const tab2El = document.createElement('div')
    tab2El.setAttribute('data-tab-content-id', 'tab-2')
    tab2El.style.display = 'none'
    document.body.appendChild(tab2El)
    const tab3El = document.createElement('div')
    tab3El.setAttribute('data-tab-content-id', 'tab-3')
    tab3El.style.display = 'none'
    document.body.appendChild(tab3El)
    setRect(tab2El, 200, 200)
    setRect(tab3El, 200, 200)
    const unsubscribe = store.subscribe(() => {
      for (const [id, el] of [['tab-2', tab2El], ['tab-3', tab3El]] as const) {
        if (store.getState().tabs.activeTabId === id && el.style.display === 'none') {
          el.style.display = 'block'
        }
      }
    })

    const events: string[] = []
    const detach = registerTerminalCaptureHandler('pane-1', {
      suspendWebgl: () => { events.push('suspend'); return true },
      resumeWebgl: () => { events.push('resume') },
    })

    let html2canvasCalls = 0
    let headGate!: () => void
    let succGate!: () => void
    vi.mocked(html2canvas).mockImplementation(async () => {
      html2canvasCalls += 1
      if (html2canvasCalls === 1) {
        events.push('head-render')
        await new Promise<void>((resolve) => { headGate = resolve })
        return { width: 1, height: 1, toDataURL: () => `${PNG_PREFIX}SDEWRt` } as any
      }
      if (html2canvasCalls === 2) {
        events.push('successor-render')
        await new Promise<void>((resolve) => { succGate = resolve })
        return { width: 1, height: 1, toDataURL: () => `${PNG_PREFIX}Tk9LRQ==` } as any
      }
      return undefined as any
    })

    try {
      // HEAD: target tab-2, short deadline — it moves focus (tab-1 → tab-2),
      // parks at its main render, and blows its deadline + grace while parked.
      const runtime = { dispatch: store.dispatch, getState: store.getState } as any
      const head = captureUiScreenshot({ scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() + 600 }, runtime)
      // SUCCESSOR: queued behind the head; long deadline so it survives.
      const successor = captureUiScreenshot({ scope: 'tab', tabId: 'tab-3', deadlineAtMs: Date.now() + 30_000 }, runtime)

      // At abandonment the head must be fenced: renderer resume AND the focus
      // rollback happen BEFORE the successor begins (no overlap), so the
      // successor snapshots the USER's tab-1 rather than the head's capture-2.
      await waitForEvent(() => events.includes('successor-render'), 15_000)
      expect(events[0]).toBe('suspend')
      expect(events[1]).toBe('head-render')
      // The fenced head's resume+restore fired at ABANDONMENT: the head's
      // renderer suspension was released before the successor ever rendered
      // (an unfenced old capture instead resumes at ITS OWN end — after the
      // successor's render had begun).
      expect(events.filter((e) => e === 'resume').length).toBeGreaterThanOrEqual(1)
      expect(events.indexOf('resume')).toBeLessThan(events.indexOf('successor-render'))
      // …and the store had been rolled back to the user's tab before the
      // successor snapshotted.
      expect(store.getState().tabs.activeTabId).toBe('tab-3') // successor's capture target showing

      // Let the parked renders complete; the total suspension/refcount closes.
      headGate()
      succGate()
      await Promise.all([head, successor])
      expect(events.filter((e) => e === 'suspend')).toHaveLength(2)
      expect(events.filter((e) => e === 'resume')).toHaveLength(2)
      expect(store.getState().tabs.activeTabId).toBe('tab-1') // fully rolled back
    } finally {
      unsubscribe()
      detach()
      // Parked gates must never leak across tests if an assertion above threw.
      try { headGate?.() } catch { /* unused */ }
      try { succGate?.() } catch { /* unused */ }
    }
  }, 30_000)
})

async function waitForEvent(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('event never observed')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
