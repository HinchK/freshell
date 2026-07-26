import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage BEFORE importing slices (persistMiddleware reads it at import time)
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

import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, {
  initLayout,
  updatePaneContent,
  restoreLayout,
} from '../../../../src/store/panesSlice'
import type { PanesState } from '../../../../src/store/panesSlice'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
  resetPersistedLayoutCacheForTests,
} from '../../../../src/store/persistMiddleware'
import type { FreshAgentPaneContent, PaneContentInput, PaneNode } from '../../../../src/store/paneTypes'

function emptyState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

/** Read the fresh-agent leaf content back out of state.layouts[tabId]. */
function leafContent(state: PanesState, tabId: string): FreshAgentPaneContent {
  const root = state.layouts[tabId]
  if (!root || root.type !== 'leaf' || root.content.kind !== 'fresh-agent') {
    throw new Error(`expected fresh-agent leaf for tab ${tabId}`)
  }
  return root.content
}

/** Same read on the restoreLayout path — named per the restore assertions it serves. */
function restoredLeafContent(state: PanesState, tabId: string): FreshAgentPaneContent {
  return leafContent(state, tabId)
}

/** Build a single-leaf layout with the given fresh-agent content (same cast trick as the model test). */
function leafWith(content: Record<string, unknown>): PaneNode {
  return { type: 'leaf', id: 'pane-1', content } as PaneNode
}

/**
 * Store + persistMiddleware setup copied from
 * test/unit/client/store/panesSlice.reconcile.test.ts:214-251 with a
 * fresh-agent leaf swapped in. Returns the persisted leaf from localStorage.
 */
async function persistLeafWithContent(
  content: Record<string, unknown>,
): Promise<{ content: Record<string, unknown> & { sessionRef?: { sessionId?: string } } }> {
  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })

  store.dispatch(addTab({ mode: 'shell' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, paneId: 'p1', content: content as PaneContentInput }))

  vi.runAllTimers()

  const raw = localStorage.getItem('freshell.layout.v3')
  if (!raw) throw new Error('nothing persisted to freshell.layout.v3')
  const parsed = JSON.parse(raw)
  const leaf = parsed.panes.layouts[tabId]
  if (!leaf || leaf.type !== 'leaf') throw new Error('expected persisted leaf')
  return leaf
}

describe('fresh-agent reconcile volatile fields', () => {
  const initialState = emptyState()

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

  it('the fold trio survives initLayout normalization on fresh-agent leaves (RED gate)', () => {
    // RED on base: normalizePaneContent's fresh-agent branch enumerates its
    // output fields (no rest spread) and silently drops all three.
    const state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(3)
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileNotice).toBe('x')
  })

  it('the fold trio survives updatePaneContent normalization (live patch path, RED gate)', () => {
    // RED on base for the same reason. This is the path the created-ack patch,
    // session.materialized patches, and Task 14's nudge flow through (:1378) —
    // preserving here is what stops unrelated patches wiping fold state.
    let state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'req-1', status: 'connected' },
    }))
    state = panesReducer(state, updatePaneContent({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        ...leafContent(state, 'tab-1'),
        reconcileEpoch: 1, pendingReconcile: 'fresh', reconcileNotice: 'n',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(1)
    expect(content.pendingReconcile).toBe('fresh')
    expect(content.reconcileNotice).toBe('n')
  })

  it('restoreLayout strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent leaves', () => {
    // GREEN ON BASE — but vacuously (normalizePaneContent drops the trio before
    // stripStaleIds is even consulted). NOT part of the red gate. After Step 3
    // preserves the trio in normalizePaneContent, THIS test is what proves the
    // stripStaleIds edit: it is then the only thing keeping volatile fold state
    // out of restored layouts.
    const state = panesReducer(initialState, restoreLayout({
      tabId: 'tab-1',
      layout: leafWith({
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      }),
    }))
    const content = restoredLeafContent(state, 'tab-1')
    expect('reconcileEpoch' in content).toBe(false)
    expect('pendingReconcile' in content).toBe(false)
    expect('reconcileNotice' in content).toBe(false)
    expect(content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('persistence strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent panes', async () => {
    // GREEN ON BASE — regression coverage only, NOT part of the red gate.
    // persistMiddleware's kind-agnostic stripTransientSessionFields (:245-268)
    // already strips these three fields for fresh-agent panes (A19 destructure).
    const persisted = await persistLeafWithContent({
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'req-1', status: 'connected',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
      reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
    })
    expect('reconcileEpoch' in persisted.content).toBe(false)
    expect('pendingReconcile' in persisted.content).toBe(false)
    expect('reconcileNotice' in persisted.content).toBe(false)
    expect(persisted.content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
