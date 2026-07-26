import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage BEFORE importing slices
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes, initLayout, updatePaneContent } from '../../../../src/store/panesSlice'
import {
  loadPersistedPanes,
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
  resetPersistedLayoutCacheForTests,
} from '../../../../src/store/persistMiddleware'

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })
}

describe('createRequestId stability across hydrate', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedPanesCacheForTests()
    resetPersistedLayoutCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydratePanes inherits the local createRequestId when the incoming terminal pane lacks one', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab1',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'stable-key-1',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab1'] as any).id

    // Incoming (remote) copy of the SAME pane, but the field was dropped by
    // the producer. status:'exited' biases mergeTerminalState toward the
    // incoming node (exit state propagates from remote — crossTabSync.test.ts
    // 'propagates exit state from remote even when local has terminalId').
    store.dispatch(hydratePanes({
      layouts: {
        tab1: {
          type: 'leaf', id: paneId,
          content: { kind: 'terminal', mode: 'shell', shell: 'system', status: 'exited' },
        },
      },
      activePane: { tab1: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    } as any))

    const leaf = store.getState().panes.layouts['tab1'] as any
    expect(leaf.content.createRequestId).toBe('stable-key-1')
  })

  it('hydratePanes inherits the local createRequestId when the incoming fresh-agent pane lacks one', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab2',
      content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        status: 'idle', createRequestId: 'stable-key-fa',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab2'] as any).id

    store.dispatch(hydratePanes({
      layouts: {
        tab2: {
          type: 'leaf', id: paneId,
          content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', status: 'idle' },
        },
      },
      activePane: { tab2: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    } as any))

    const leaf = store.getState().panes.layouts['tab2'] as any
    expect(leaf.content.createRequestId).toBe('stable-key-fa')
  })

  it('boot hydrate preserves the persisted createRequestId byte-for-byte (lock-in)', () => {
    const store1 = makeStore()
    store1.dispatch(initLayout({
      tabId: 'tab3',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'persisted-key-3',
      } as any,
    }))
    vi.runAllTimers() // flush persist debounce to localStorage

    // Simulate a fresh page load: reset the module caches, re-read storage.
    resetPersistedPanesCacheForTests()
    resetPersistedLayoutCacheForTests()
    const persisted = loadPersistedPanes()
    const leaf = (persisted as any).layouts['tab3']
    expect(leaf.content.createRequestId).toBe('persisted-key-3')
  })

  it('a genuinely new pane (no persisted key, no previous) mints a createRequestId', () => {
    const store = makeStore()
    store.dispatch(initLayout({ tabId: 'tab4', content: { kind: 'terminal', mode: 'shell' } as any }))
    const leaf = store.getState().panes.layouts['tab4'] as any
    expect(typeof leaf.content.createRequestId).toBe('string')
    expect(leaf.content.createRequestId.length).toBeGreaterThan(0)
  })

  it('updatePaneContent MINTS a fresh key for key-less same-kind content (resume-path rotation preserved)', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab5',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'rotate-me-5',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab5'] as any).id

    // Mirrors the resume/repair dispatchers (tabsSlice.ts:668
    // repairExistingTabLayout; ContextMenuProvider.tsx:949 reopen-in-pane):
    // buildResumeContent output never carries createRequestId, and those
    // paths RELY on the reducer minting a fresh key so TerminalView's create
    // effect (keyed on terminalContent?.createRequestId) re-fires and drives
    // the resume create. The hydrate-scoped inherit must NOT leak here.
    store.dispatch(updatePaneContent({
      tabId: 'tab5',
      paneId,
      content: {
        kind: 'terminal', mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: 'sess-resume-5' },
      } as any,
    }))

    const leaf = store.getState().panes.layouts['tab5'] as any
    expect(typeof leaf.content.createRequestId).toBe('string')
    expect(leaf.content.createRequestId.length).toBeGreaterThan(0)
    expect(leaf.content.createRequestId).not.toBe('rotate-me-5')
  })
})
