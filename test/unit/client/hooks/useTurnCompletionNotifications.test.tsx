import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer, {
  recordTurnComplete,
  recordTerminalIdle,
  clearTabAttention,
  clearPaneAttention,
} from '@/store/turnCompletionSlice'
import { paneSelectionMiddleware } from '@/lib/pane-focus-ownership'
import { useTurnCompletionNotifications } from '@/hooks/useTurnCompletionNotifications'
import type { Tab, AttentionDismiss } from '@/store/types'

const playSound = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: playSound }),
}))

function TestComponent() {
  useTurnCompletionNotifications()
  return null
}

function createStore(activeTabId = 'tab-1', attentionDismiss: AttentionDismiss = 'click') {
  const now = Date.now()
  const tabs: Tab[] = [
    {
      id: 'tab-1',
      createRequestId: 'req-1',
      title: 'Tab 1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      createdAt: now,
    },
    {
      id: 'tab-2',
      createRequestId: 'req-2',
      title: 'Tab 2',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      createdAt: now,
    },
  ]

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    // The app store clears watched-completion marks on tab (re)activation via
    // this middleware — the watched-clear cases dispatch selection actions the
    // same way the app does.
    middleware: (getDefault) => getDefault().concat(paneSelectionMiddleware as never),
    preloadedState: {
      tabs: {
        tabs,
        activeTabId,
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'cr-1', status: 'running', mode: 'shell' } },
          'tab-2': {
            type: 'split',
            id: 'split-2',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'cr-2', status: 'running', mode: 'shell' } },
              { type: 'leaf', id: 'pane-3', content: { kind: 'terminal', createRequestId: 'cr-3', status: 'running', mode: 'shell' } },
            ],
          },
        },
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      },
      settings: {
        settings: {
          ...defaultSettings,
          panes: { ...defaultSettings.panes, attentionDismiss },
        },
        loaded: true,
      },
      turnCompletion: {
        seq: 0,
        lastAtByTerminalId: {},
        lastIdleAtByTerminalId: {},
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
        watchedCompletionByTab: {},
      },
    },
  })
}

describe('useTurnCompletionNotifications', () => {
  let hasFocus = true
  let hidden = false
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')

  beforeEach(() => {
    playSound.mockClear()
    hasFocus = true
    hidden = false

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })

    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => hasFocus,
    })
  })

  afterEach(() => {
    cleanup()

    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    }

    if (originalHasFocus) {
      Object.defineProperty(document, 'hasFocus', originalHasFocus)
    }
  })

  describe('fresh-agent partition (recordTurnComplete)', () => {
    it('background completion: marks tab+pane attention and rings once', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
      })

      await waitFor(() => {
        expect(playSound).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    it('background completion marks pane attention alongside tab attention', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
    })

    it('watched completion (focused window + active tab): marks ONLY the tab strip, no sound', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      // The watched mark replaces the attention marks — attentionByTab also
      // drives the sidebar row highlight, which must stay dark for a watched
      // ending (and never light sibling sessions of a split tab).
      expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
      expect(playSound).not.toHaveBeenCalled()
    })

    it('active-tab completion rings when the window is unfocused', async () => {
      hasFocus = false
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      })

      await waitFor(() => {
        expect(playSound).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    it('does not drop completion when focus state transitions before blur listener updates (type mode)', async () => {
      const store = createStore('tab-1', 'type')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        hasFocus = false
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      })

      await waitFor(() => {
        expect(playSound).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    it('mixed burst: the watched-tab event is silent, exactly one ring for the background event', async () => {
      const store = createStore('tab-1', 'type')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 200 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      // Only the background event rings (the watched one is silent).
      expect(playSound).toHaveBeenCalledTimes(1)
      expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
    })

    it('double-background burst rings once per event (two plays)', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-3', terminalId: 'term-3', at: 200 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      // Every unwitnessed fresh-agent event rings — no batch coalescing.
      expect(playSound).toHaveBeenCalledTimes(2)
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-3']).toBe(true)
    })

    it('watched mark clears when the user navigates away and back', async () => {
      const store = createStore('tab-1', 'click')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBe(true)
      })

      // Navigate away — the mark survives the away leg alone.
      act(() => {
        store.dispatch(setActiveTab('tab-2'))
      })
      expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBe(true)

      // Come back — re-activation clears the watched mark.
      act(() => {
        store.dispatch(setActiveTab('tab-1'))
      })
      expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBeUndefined()
    })

    it('attention persists in type mode after switching tabs', async () => {
      hasFocus = false
      const store = createStore('tab-1', 'type')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      })

      // Regain focus — in 'type' mode, attention should persist (only typing clears it)
      act(() => {
        hasFocus = true
        window.dispatchEvent(new Event('focus'))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      })
    })

    it('clearTabAttention/clearPaneAttention actions clear attention state', async () => {
      hasFocus = false
      const store = createStore('tab-1', 'click')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      // Unwitnessed completion on the active tab (window unfocused) — full attention.
      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
      })

      act(() => {
        store.dispatch(clearTabAttention({ tabId: 'tab-1' }))
        store.dispatch(clearPaneAttention({ paneId: 'pane-1' }))
      })

      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
    })

    it('click mode: attention persists through window blur/focus cycle without tab switch', async () => {
      hasFocus = false
      const store = createStore('tab-2', 'click')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      })

      // Regain focus without switching tabs — attention should persist
      act(() => {
        hasFocus = true
        window.dispatchEvent(new Event('focus'))
      })

      // Give React a chance to flush effects
      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      })
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
    })

    it('click mode: switching to a tab with attention clears both tab and pane attention', async () => {
      const store = createStore('tab-1', 'click')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      // Background split tab completes on the NON-active pane (pane-3) as well as pane-2.
      act(() => {
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
        store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-3', terminalId: 'term-3', at: 100 }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      })
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-3']).toBe(true)

      // Simulate switching to tab-2 (as TabBar click would)
      act(() => {
        store.dispatch(setActiveTab('tab-2'))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
      })
      // BOTH panes clear on switch-in — not just the active one (Fresh-Eyes round 3).
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-3']).toBeUndefined()
    })
  })

  describe('terminal partition (recordTerminalIdle) — today\'s behavior, unchanged', () => {
    it('watched idle edge: marks tab+pane attention always, sound suppressed', async () => {
      const store = createStore('tab-1', 'click')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTerminalIdle({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 't-1', at: 1_000, reason: 'grace' }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      // Watched TERMINAL endings still mark attentionByTab+attentionByPane.
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBe(true)
      expect(store.getState().turnCompletion.watchedCompletionByTab['tab-1']).toBeUndefined()
      expect(playSound).not.toHaveBeenCalled()
    })

    it('background idle edge: marks attention and rings', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTerminalIdle({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 't-2', at: 1_000, reason: 'grace' }))
      })

      await waitFor(() => {
        expect(playSound).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    it('terminal burst keeps ONE coalesced play per batch (watched event still marks attention)', async () => {
      const store = createStore('tab-1')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>
      )

      act(() => {
        store.dispatch(recordTerminalIdle({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 't-1', at: 1_000, reason: 'grace' }))
        store.dispatch(recordTerminalIdle({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 't-2', at: 2_000, reason: 'grace' }))
      })

      await waitFor(() => {
        expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
      })

      // The whole terminal batch coalesces into exactly ONE play() call.
      expect(playSound).toHaveBeenCalledTimes(1)
      // The watched terminal ending still marks tab+pane attention.
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBe(true)
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })
  })
})
