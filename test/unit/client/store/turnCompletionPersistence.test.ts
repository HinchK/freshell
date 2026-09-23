import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSIST_DEBOUNCE_MS, persistMiddleware, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import { TURN_COMPLETION_STORAGE_KEY } from '@/store/storage-keys'

async function importTurnCompletionSlice() {
  return import('@/store/turnCompletionSlice')
}

describe('turnCompletion persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    resetPersistFlushListenersForTests()
    vi.resetModules()
  })

  it('does not persist attention: a reload must witness nothing', async () => {
    const {
      default: turnCompletionReducer,
      markPaneAttention,
      markTabAttention,
    } = await importTurnCompletionSlice()
    const store = configureStore({
      reducer: {
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(markTabAttention({ tabId: 'tab-1' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-1' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || 'null')
    // Only the schema version remains — the attention maps dropped out of the
    // persisted contract ("never replay history": highlights no tabs for turn
    // ends that happened before the page loaded).
    expect(persisted).toEqual({ version: 1 })
    expect(persisted.attentionByTab).toBeUndefined()
    expect(persisted.attentionByPane).toBeUndefined()
  })

  it('never rehydrates attention from a persisted payload (legacy attention entries tolerated, not restored)', async () => {
    localStorage.setItem(TURN_COMPLETION_STORAGE_KEY, JSON.stringify({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: { 'pane-1': true },
      // Written by older builds; must be ignored, not rejected.
      lastAppliedCompletionSeqByTerminalId: { 'term-1': 4 },
    }))

    const { default: turnCompletionReducer } = await importTurnCompletionSlice()
    const state = turnCompletionReducer(undefined, { type: '@@INIT' })

    expect(state.attentionByTab).toEqual({})
    expect(state.attentionByPane).toEqual({})
    expect(state.pendingEvents).toEqual([])
  })
})
