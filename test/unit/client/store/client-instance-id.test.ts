// e3r1 finding 6: the registry client id's in-memory fallback was not used
// when sessionStorage.getItem succeeds-with-null but setItem FAILS
// (quota-exhausted sessionStorage) — every call minted a DIFFERENT id. The
// id must be minted once and cached in memory regardless of write success,
// so repeated calls return the same id for the context's lifetime and a
// full persistence flush writes + broadcasts under ONE key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const LAYOUT_KEY_PREFIX = 'freshell.layout.v3.'

/** Quota simulation idiom (browserPreferencesPersistence.test.ts:132):
 * intercept at the Storage PROTOTYPE so every access path throws, but only
 * for sessionStorage — localStorage keeps writing (the flush test must
 * still be able to persist). */
function simulateQuotaExhaustedSessionStorage(): void {
  const originalSetItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (this === window.sessionStorage) {
      throw new DOMException('session storage quota exceeded', 'QuotaExceededError')
    }
    return originalSetItem.call(this, key, value)
  })
}

describe('client-instance-id (stable id under sessionStorage write failure)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ONE stable id for the context lifetime when sessionStorage writes fail and nothing is stored', async () => {
    simulateQuotaExhaustedSessionStorage()

    vi.resetModules()
    const { getCurrentTabRegistryClientInstanceId } = await import('@/store/client-instance-id')

    const first = getCurrentTabRegistryClientInstanceId()
    expect(first).toBeTruthy()
    expect(getCurrentTabRegistryClientInstanceId(), 'second call returns the same id').toBe(first)
    expect(getCurrentTabRegistryClientInstanceId(), 'third call returns the same id').toBe(first)
    expect(sessionStorage.getItem('freshell.tabs.client-instance-id.v1')).toBeNull()
  })

  it('a full persistence flush under the same quota condition writes and broadcasts under ONE layout key', async () => {
    simulateQuotaExhaustedSessionStorage()

    vi.resetModules()
    const { configureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, addTab } = await import('@/store/tabsSlice')
    const { panesSlice, initLayout } = await import('@/store/panesSlice')
    const { persistMiddleware, resetPersistFlushListenersForTests } = await import('@/store/persistMiddleware')
    const { flushPersistedLayoutNow } = await import('@/store/persistControl')
    const { onPersistBroadcast, resetPersistBroadcastForTests } = await import('@/store/persistBroadcast')
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()

    const broadcastKeys: string[] = []
    const unsubscribe = onPersistBroadcast((msg) => {
      if (msg.key.startsWith(LAYOUT_KEY_PREFIX) && !msg.key.slice(LAYOUT_KEY_PREFIX.length).includes('.')) {
        broadcastKeys.push(msg.key)
      }
    })

    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesSlice.reducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })
    store.dispatch(addTab({ id: 'tab-quota', title: 'Quota flush' }))
    store.dispatch(initLayout({
      tabId: 'tab-quota',
      paneId: 'pane-quota',
      content: { kind: 'editor', filePath: '/tmp/quota.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
    }))
    store.dispatch(flushPersistedLayoutNow())

    const writtenLayoutKeys = new Set(
      Object.keys(localStorage).filter((key) => key.startsWith(LAYOUT_KEY_PREFIX) && !key.slice(LAYOUT_KEY_PREFIX.length).includes('.')),
    )
    expect(writtenLayoutKeys.size).toBe(1)
    expect(broadcastKeys, 'the broadcast carries exactly the key that was written').toEqual([...writtenLayoutKeys])

    unsubscribe()
  })
})
