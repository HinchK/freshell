import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setLocalSettings, updateSettingsLocal } from '@/store/settingsSlice'
import tabRegistryReducer, { setTabRegistryClosedTabRetentionDays } from '@/store/tabRegistrySlice'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '@/store/browserPreferencesPersistence'
import { seedBrowserPreferencesSettingsIfEmpty } from '@/lib/browser-preferences'
import { resetPersistBroadcastForTests } from '@/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'

function createStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabRegistry: tabRegistryReducer,
    },
    middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
  })
}

describe('browserPreferencesPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('persists setLocalSettings and closed tab retention changes into the browser-preferences blob', () => {
    const store = createStore()

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
      terminal: {
        fontSize: 18,
      },
    }, { floatingActionButtonDefault: true })))
    store.dispatch(setTabRegistryClosedTabRetentionDays(14))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        terminal: {
          fontSize: 18,
        },
      },
      tabs: {
        closedTabRetentionDays: 14,
      },
    })
  })

  it('debounces updateSettingsLocal writes and flushes them on pagehide', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      sidebar: {
        sortMode: 'project',
      },
    }))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    window.dispatchEvent(new Event('pagehide'))

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('preserves the consumed seed marker when seeded settings are reset to defaults', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'light',
      },
      legacyLocalSettingsSeedApplied: true,
    }))

    const store = createStore()

    store.dispatch(setLocalSettings(resolveLocalSettings(undefined, { floatingActionButtonDefault: true })))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })

    expect(seedBrowserPreferencesSettingsIfEmpty({
      theme: 'light',
    })).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('does not write browser preferences for a skipPersist local update by itself', () => {
    const store = createStore()

    store.dispatch({
      ...updateSettingsLocal({
        sidebar: {
          collapsed: true,
        },
      }),
      meta: { skipPersist: true },
    })

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()
  })

  it('stops automatic retry loops after a storage write failure until another local change happens', () => {
    const store = createStore()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    })

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS * 5)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    store.dispatch(updateSettingsLocal({
      sidebar: {
        sortMode: 'project',
      },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS * 5)
    expect(setItemSpy).toHaveBeenCalledTimes(2)

    setItemSpy.mockRestore()
  })

  it('persists an explicit multirowTabs=false now that the default is true', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { multirowTabs: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.multirowTabs).toBe(false)
  })

  it('persists an explicit floatingActionButton=false on desktop now that the desktop default is true', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { floatingActionButton: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.floatingActionButton).toBe(false)
  })

  it('does not persist floatingActionButton when it equals the boot platform default (no poisoning on unrelated flushes)', () => {
    const store = createStore()

    // An unrelated local change triggers a full diff-vs-defaults flush. The
    // store's boot state carries the desktop platform default (true), and
    // the diff base is the SAME platform default, so the FAB key must stay
    // out of the blob (this is the canary for the mobile-boot poisoning
    // class: a spurious `true` here would show the FAB on a later mobile
    // boot of the same browser).
    store.dispatch(updateSettingsLocal({ theme: 'dark' }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.floatingActionButton).toBeUndefined()
  })

  it('never erases an explicitly saved floatingActionButton on an unrelated flush, even when it equals the active platform default (sticky explicit)', () => {
    // Model a mobile opt-in (explicit true saved by a default-off-era boot or
    // a mobile-width session) now living in a DESKTOP-width browser: the
    // store resolves true (explicit wins over the desktop default, which is
    // also true). An unrelated flush must preserve the saved key verbatim —
    // dropping it would resurrect the mobile default on the next
    // mobile-width boot of this browser, erasing a deliberate user choice.
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { panes: { floatingActionButton: true } },
    }))
    try {
      const store = createStore()

      store.dispatch(updateSettingsLocal({ theme: 'dark' }))
      vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

      const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
      expect(blob.settings?.panes?.floatingActionButton).toBe(true)
    } finally {
      localStorage.removeItem(BROWSER_PREFERENCES_STORAGE_KEY)
    }
  })

  it('persists panes.tabBarRows when it differs from the default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { tabBarRows: 5 } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.tabBarRows).toBe(5)
  })

  it('omits panes.tabBarRows at its default value', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { tabBarRows: 3, snapThreshold: 4 } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.snapThreshold).toBe(4)
    expect(blob.settings?.panes?.tabBarRows).toBeUndefined()
  })

  it('persists a freshAgent expansion opt-in to browser preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { expandThinking: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({ expandThinking: true })
    expect(bp.settings.freshAgent.expandTools).toBeUndefined()
    expect(bp.settings.freshAgent.showTimecodes).toBeUndefined()
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('persists all three freshAgent toggles when each deviates from its default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { expandThinking: true, expandTools: true, showTimecodes: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({
      expandThinking: true,
      expandTools: true,
      showTimecodes: true,
    })
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('does not persist freshAgent values that equal the defaults', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { expandThinking: false, expandTools: false, showTimecodes: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.freshAgent).toBeUndefined()
    expect(bp.settings?.agentChat).toBeUndefined()
  })

  it('persists a showTranscriptMinimap opt-out and drops it back at the default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    const optedOut = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    // Default-ON key: only the NON-default value appears in the diff-vs-defaults blob.
    expect(optedOut.settings.freshAgent).toEqual({ showTranscriptMinimap: false })

    store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: true } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    const restored = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(restored.settings?.freshAgent).toBeUndefined()
  })

  it('round-trips freshAgent expansion opt-ins through localStorage', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { expandThinking: true, expandTools: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved.settings.freshAgent).toEqual({ expandThinking: true, expandTools: true })
    expect(saved.settings.agentChat).toBeUndefined()

    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.freshAgent.expandThinking).toBe(true)
    expect(rehydrated.freshAgent.expandTools).toBe(true)
    expect(rehydrated.freshAgent.showTimecodes).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
  })

  it('ignores removed freshAgent.fontScale values', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { fontScale: 1.75 },
    } as never))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.freshAgent).toBeUndefined()
    expect(bp.settings?.agentChat).toBeUndefined()
  })

  it('drops legacy freshAgent.fontScale records when rehydrating old preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { expandTools: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    const rehydrated = resolveLocalSettings({
      ...bp.settings,
      freshAgent: { ...bp.settings.freshAgent, fontScale: 1.75 },
    } as never)
    expect(rehydrated.freshAgent.expandTools).toBe(true)
    expect('fontScale' in rehydrated.freshAgent).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
  })
})
