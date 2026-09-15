import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer, { hydrateTabs } from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes } from '../../../../src/store/panesSlice'
import machineIdentityReducer, { setMachineReady } from '../../../../src/store/machineIdentitySlice'
import tabRecencyReducer from '../../../../src/store/tabRecencySlice'
import settingsReducer, { setLocalSettings, updateSettingsLocal } from '../../../../src/store/settingsSlice'
import tabRegistryReducer, { setTabRegistrySearchRangeDays } from '../../../../src/store/tabRegistrySlice'
import { installCrossTabSync } from '../../../../src/store/crossTabSync'
import {
  persistMiddleware,
  PERSIST_DEBOUNCE_MS,
  resetPersistFlushListenersForTests,
} from '../../../../src/store/persistMiddleware'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '../../../../src/store/browserPreferencesPersistence'
import { broadcastPersistedRaw, resetPersistBroadcastForTests } from '../../../../src/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY, MACHINE_ID_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY } from '../../../../src/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'
import { sessionMetadataKey } from '@/lib/session-metadata'

// Delta round 3, finding 1 + e3r1 findings 3/4: layout envelopes are keyed
// per window by the mint-once layout-window-id
// (freshell.layout.v3.<layoutWindowId>; e3r2 finding 1: the registry
// lease-collision rotation is the only path that remints it). Storage
// events for OTHER windows' keys run the TITLE-ONLY reconciliation path
// (no hydrateTabs, no hydratePanes — another window's arrangement never
// replaces this window's); this window's OWN key events (duplicate tabs
// before their lease-collision rotation remints their id, and the
// install-time own-envelope replacement) keep the full hydrateTabs +
// hydratePanes path.
const LAYOUT_WINDOW_ID_STORAGE_KEY = 'freshell.layout-window-id.v1'
const OWN_WINDOW_ID = 'client-crosstab-own'
const OWN_LAYOUT_KEY = `freshell.layout.v3.${OWN_WINDOW_ID}`
const REMOTE_LAYOUT_KEY = 'freshell.layout.v3.layout-window-remote'

describe('crossTabSync', () => {
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, OWN_WINDOW_ID)
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    sessionStorage.removeItem(LAYOUT_WINDOW_ID_STORAGE_KEY)
    vi.restoreAllMocks()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('hydrates OWN-key tabs (duplicate-tab flush) but preserves the local active tab when it still exists', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 't2',
        tabs: [
          { id: 't1', title: 'T1', createdAt: 1 },
          { id: 't2', title: 'T2', createdAt: 2 },
          { id: 't3', title: 'T3', createdAt: 3 },
        ],
      },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
  })

  it('hydrates OWN-key panes (duplicate-tab flush) but preserves the local activePane when it still exists', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
            { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
          ],
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},

    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-remote',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
              { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-b' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    expect(store.getState().panes.layouts['tab-1']?.id).toBe('split-remote')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-a')
  })

  it('preserves canonical resume identity when an OWN-key flush (duplicate tab) rehydrates a fresh-agent pane', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-a',
            status: 'idle',
            resumeSessionId: '123e4567-e89b-42d3-a456-426614174000',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-a',
              status: 'idle',
              resumeSessionId: 'not-a-canonical-id',
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBe('123e4567-e89b-42d3-a456-426614174000')
  })

  it('drops incoming Codex runtime fields when the local pane already has a canonical sessionRef (OWN-key flush)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-a',
            status: 'running',
            terminalId: 'term-local',
            serverInstanceId: 'srv-local',
            streamId: 'stream-local',
            sessionRef: {
              provider: 'codex',
              sessionId: 'thread-1',
            },
            codexDurability: {
              schemaVersion: 1,
              state: 'durable',
              durableThreadId: 'thread-1',
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-b',
              status: 'running',
              terminalId: 'term-remote',
              serverInstanceId: 'srv-remote',
              streamId: 'stream-remote',
              sessionRef: {
                provider: 'codex',
                sessionId: 'thread-old',
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content).toMatchObject({
      createRequestId: 'req-a',
      status: 'running',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-1',
      },
      terminalId: 'term-local',
      serverInstanceId: 'srv-local',
      streamId: 'stream-local',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-1',
      },
    })
  })

  it('keeps a locally rebound sessionRef when a stale tab broadcast still carries the old sessionId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local pane was rebound (server-authoritative) to new-id.
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-a',
            status: 'running',
            terminalId: 'term-local',
            sessionRef: {
              provider: 'codex',
              sessionId: 'new-id',
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    // A stale tab flushes a layout that still carries the superseded old-id.
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-a',
              status: 'running',
              terminalId: 'term-local',
              sessionRef: {
                provider: 'codex',
                sessionId: 'old-id',
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'new-id',
    })
  })

  it('dedupes identical title-only payloads delivered via both storage and BroadcastChannel', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      const cleanup = installCrossTabSync(storeLike as any)

      const raw = JSON.stringify({
        version: 3,
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      })
      window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))

      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: REMOTE_LAYOUT_KEY, raw, sourceId: 'other' } })

      const titleOnlyCalls = dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'panes/hydratePaneTitles')
      expect(titleOnlyCalls).toHaveLength(1)

      cleanup()
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  it('evicts the retained raw on a removal storage event — a removed-then-recreated key reprocesses instead of deduping forever', () => {
    // e3r2 finding 3: lastProcessedRawByKey retained one complete
    // serialized layout per observed window; removal events
    // (newValue === null — what the stale-envelope prune sweep's
    // cross-document key removals look like) fell through the string
    // check, so pruned blobs accumulated for the life of the window and a
    // removed-then-recreated key replaying identical bytes was deduped as
    // already-processed.
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }
    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    const titleOnlyDispatchCount = () =>
      dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'panes/hydratePaneTitles').length

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount()).toBe(1)

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount(), 'an identical replay is deduped').toBe(1)

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: null }))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount(), 'the removal event evicted the retained blob — the re-created key reprocesses').toBe(2)
  })

  it('hydrates browser-preference changes from storage events', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: remoteRaw,
    }))

    expect(store.getState().settings.localSettings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('hydrates browser-preference changes from BroadcastChannel messages', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      cleanups.push(installCrossTabSync(store as any))

      MockBC.instance?.onmessage?.({
        data: {
          type: 'persist',
          key: BROWSER_PREFERENCES_STORAGE_KEY,
          raw: JSON.stringify({
            settings: {
              theme: 'dark',
            },
            tabs: {
              searchRangeDays: 90,
            },
          }),
          sourceId: 'other-tab',
        },
      })

      expect(store.getState().settings.settings.theme).toBe('dark')
      expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  it('preserves authoritative remote sidebar collapse through a later unrelated local write', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      settings: {
        sidebar: {
          collapsed: true,
        },
      },
    })

    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, remoteRaw)

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: remoteRaw,
    }))

    expect(store.getState().settings.settings.sidebar.collapsed).toBe(true)

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          collapsed: true,
        },
      },
    })
  })

  it('ignores empty browser-preference writes for Redux local settings and search range', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))
    store.dispatch(setTabRegistrySearchRangeDays(365))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({}),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('applies sparse browser-preference resets when previously persisted settings or search range are removed', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
      },
      tabs: {
        searchRangeDays: 365,
      },
    }))

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
    })))
    store.dispatch(setTabRegistrySearchRangeDays(365))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({}),
    }))

    expect(store.getState().settings.settings.theme).toBe('system')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('merges tab recency sidecar events without rewriting layout or echoing the sidecar', () => {
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, tabRecency: tabRecencyReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch({
      ...hydrateTabs({
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Tab 1',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      } as any),
      meta: { skipPersist: true },
    })
    store.dispatch({
      ...hydratePanes({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      } as any),
      meta: { skipPersist: true },
    })

    cleanups.push(installCrossTabSync(store as any))
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    window.dispatchEvent(new StorageEvent('storage', {
      key: TAB_RECENCY_STORAGE_KEY,
      newValue: JSON.stringify({
        version: 1,
        paneLastInputAt: {
          'pane-1': 1_740_000_059_999,
        },
      }),
    }))

    expect(store.getState().tabRecency.paneLastInputAt['pane-1']).toBe(1_740_000_000_000)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).not.toHaveBeenCalledWith(OWN_LAYOUT_KEY, expect.any(String))
    expect(setItemSpy).not.toHaveBeenCalledWith(TAB_RECENCY_STORAGE_KEY, expect.any(String))
  })

  it('merges tab recency sidecars by max and persists pruned local terminal panes', () => {
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, tabRecency: tabRecencyReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
            status: 'running',
            mode: 'shell',
            createdAt: 1,
          }],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
          tombstones: [],
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'split',
              id: 'root',
              direction: 'horizontal',
              sizes: [50, 50],
              children: [
                {
                  type: 'leaf',
                  id: 'pane-local',
                  content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' },
                },
                {
                  type: 'split',
                  id: 'right',
                  direction: 'vertical',
                  sizes: [50, 50],
                  children: [
                    {
                      type: 'leaf',
                      id: 'pane-shared',
                      content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shared', status: 'running' },
                    },
                    {
                      type: 'leaf',
                      id: 'pane-remote',
                      content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-remote', status: 'running' },
                    },
                  ],
                },
              ],
            } as any,
          },
          activePane: { 'tab-1': 'pane-local' },
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
        tabRecency: {
          paneLastInputAt: {
            'pane-local': 1_740_000_120_000,
            'pane-shared': 1_740_000_120_000,
          },
        },
      } as any,
    })

    cleanups.push(installCrossTabSync(store as any))
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    window.dispatchEvent(new StorageEvent('storage', {
      key: TAB_RECENCY_STORAGE_KEY,
      newValue: JSON.stringify({
        version: 1,
        paneLastInputAt: {
          'pane-shared': 1_740_000_000_000,
          'pane-remote': 1_740_000_060_000,
          'pane-stale': 1_740_000_180_000,
        },
      }),
    }))

    expect(store.getState().tabRecency.paneLastInputAt).toEqual({
      'pane-local': 1_740_000_120_000,
      'pane-remote': 1_740_000_060_000,
      'pane-shared': 1_740_000_120_000,
    })
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).not.toHaveBeenCalledWith(OWN_LAYOUT_KEY, expect.any(String))
    expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      paneLastInputAt: {
        'pane-local': 1_740_000_120_000,
        'pane-remote': 1_740_000_060_000,
        'pane-shared': 1_740_000_120_000,
      },
    })
  })

  it('merges remote browser-preference writes without clobbering dirty local settings', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({
        settings: {
          theme: 'system',
          sidebar: {
            sortMode: 'project',
          },
        },
        tabs: {
          searchRangeDays: 365,
        },
      }),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('merges remote browser-preference writes without treating resolved defaults from setLocalSettings as dirty', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
    })))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({
        settings: {
          theme: 'system',
          sidebar: {
            sortMode: 'project',
          },
        },
        tabs: {
          searchRangeDays: 365,
        },
      }),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('preserves local terminalId when remote layout lacks it', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal has been created (has terminalId)
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote state arrives WITHOUT terminalId (stale data from before creation)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'creating',
              // NO terminalId
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))

    // Local terminalId should be preserved
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.terminalId).toBe('local-terminal-123')
    expect(content.status).toBe('running')
  })

  it('preserves local reconnection state when remote has stale createRequestId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal just regenerated createRequestId after INVALID_TERMINAL_ID
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-new',
            status: 'creating',
            // No terminalId — reconnecting
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote: stale state with old createRequestId and old terminalId
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-old',
              status: 'running',
              terminalId: 'stale-terminal-id',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))

    // Local reconnection state must be preserved — stale remote must not overwrite
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.createRequestId).toBe('req-new')
    expect(content.status).toBe('creating')
    expect(content.terminalId).toBeUndefined()
  })

  it('propagates exit state from an OWN-key flush (duplicate tab) even when local has terminalId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal is running with terminalId
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    // Remote: terminal has exited (no terminalId, status: exited)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'exited',
              // NO terminalId — terminal exited
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    // Exit state should propagate — local should NOT keep stale terminalId
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.status).toBe('exited')
    expect(content.terminalId).toBeUndefined()
  })

  it('does not crash on a malformed OTHER-window pane layout (corrupted localStorage) — the title-only path ignores it', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: valid terminal pane
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote state: malformed split with missing children
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-bad',
            direction: 'horizontal',
            sizes: [50, 50],
            // children is missing entirely — corrupted data
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))

    // Should not throw — malformed remote data is ignored and local state wins.
    expect(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))
    }).not.toThrow()

    expect(store.getState().panes.layouts['tab-1']).toEqual({
      type: 'leaf',
      id: 'pane-1',
      content: expect.objectContaining({
        kind: 'terminal',
        terminalId: 'local-terminal-123',
        createRequestId: 'req-1',
        status: 'running',
      }),
    })
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')
    expect(store.getState().panes.paneTitles['tab-1']).toEqual({ 'pane-1': 'Local shell title' })
    expect(store.getState().panes.paneTitleSetByUser['tab-1']).toEqual({ 'pane-1': true })
  })

  it('preserves local resumeSessionId when an OWN-key flush has a different session for the same createRequestId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: Claude pane creating with SESSION_A
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-1',
            status: 'creating',
            resumeSessionId: 'session-A',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    // Remote: same createRequestId but different resumeSessionId (from another tab)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 'remote-terminal-456',
              resumeSessionId: 'session-B',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    // Local resumeSessionId must NOT be overwritten by the incoming flush
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.resumeSessionId).toBe('session-A')
    // Other incoming fields (lifecycle progress) should still be accepted
    expect(content.terminalId).toBe('remote-terminal-456')
    expect(content.status).toBe('running')
  })

  it('does not permanently dedupe: an identical payload hydrates again once the SAME key\u2019s raw changed in between', () => {
    // Delta round 3: with per-window keys the dedupe map is per storage
    // key. The pinned property survives in the per-key idiom — this
    // window's own flush (a different key) can no longer re-arm ANOTHER
    // window's dedupe entry; only that key's own raw change does.
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw1 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: { 't1': { 'p1': 'Title one' } }, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw1 }))

    const raw2 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1 changed remotely', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: { 't1': { 'p1': 'Title two' } }, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw2 }))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw1 }))

    const titleOnlyCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'panes/hydratePaneTitles')
    expect(titleOnlyCalls).toHaveLength(3)
  })

  it('marks this window\u2019s own-key broadcast as processed without hydrating (the local flush path)', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    // persistMiddleware broadcasts the window's own flush; the in-process
    // listener records the raw in the dedupe map (a later identical
    // STORAGE event for the same key is deduped) and never hydrates.
    broadcastPersistedRaw(OWN_LAYOUT_KEY, raw)

    let hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(0)

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: raw }))
    hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(0)
  })

  it('hydrates both tabs and panes from a single OWN-key combined layout event (duplicate-tab flush)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    const layoutRaw = JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: 'T1', mode: 'shell' },
          { id: 't2', title: 'T2', mode: 'shell' },
        ],
      },
      panes: {
        version: 6,
        layouts: {
          't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
          't2': { type: 'leaf', id: 'p2', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r2', status: 'running' } },
        },
        activePane: { 't1': 'p1', 't2': 'p2' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: layoutRaw }))

    // Both tabs and panes should be hydrated from the single combined event
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts).toHaveProperty('t1')
    expect(store.getState().panes.layouts).toHaveProperty('t2')
  })

  it('rejects a stale OWN-key rebroadcast that would overwrite a newer canonical durable id', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const staleSessionRefId = '00000000-0000-4000-8000-000000000111'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 100,
        resumeSessionId: canonicalSessionId,
        sessionMetadataByKey: {
          [sessionMetadataKey('claude', canonicalSessionId)]: {
            sessionType: 'freshclaude',
            firstUserMessage: 'Continue locally',
          },
        },
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
            resumeSessionId: canonicalSessionId,
            sessionRef: {
              provider: 'claude',
              sessionId: canonicalSessionId,
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 100,
          resumeSessionId: canonicalSessionId,
          sessionMetadataByKey: {
            [sessionMetadataKey('claude', canonicalSessionId)]: {
              sessionType: 'freshclaude',
              firstUserMessage: 'Continue locally',
            },
          },
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: canonicalSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: canonicalSessionId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 150,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Remote stale title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 999,
          resumeSessionId: 'named-resume',
          sessionMetadataByKey: {
            [sessionMetadataKey('claude', 'named-resume')]: {
              sessionType: 'freshclaude',
              firstUserMessage: 'Remote stale resume',
            },
          },
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: 'named-resume',
              sessionRef: {
                provider: 'claude',
                sessionId: staleSessionRefId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
    expect(paneContent.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    expect(tab?.sessionMetadataByKey).toEqual(expect.objectContaining({
      [sessionMetadataKey('claude', canonicalSessionId)]: expect.objectContaining({
        sessionType: 'freshclaude',
      }),
    }))
    expect(tab?.sessionMetadataByKey).not.toHaveProperty(sessionMetadataKey('claude', 'named-resume'))
  })

  it('keeps newer local FreshClaude pane state when a stale OWN-key rebroadcast is canonicalized during hydration', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000654'
    const staleSessionRefId = '00000000-0000-4000-8000-000000000222'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 200,
        resumeSessionId: canonicalSessionId,
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: 'sdk-local-current',
            createRequestId: 'req-local-current',
            status: 'running',
            resumeSessionId: canonicalSessionId,
            sessionRef: {
              provider: 'claude',
              sessionId: canonicalSessionId,
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 200,
          resumeSessionId: canonicalSessionId,
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-local-current',
              createRequestId: 'req-local-current',
              status: 'running',
              resumeSessionId: canonicalSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: canonicalSessionId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 150,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Remote stale title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 150,
          resumeSessionId: 'named-resume',
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-remote-stale',
              createRequestId: 'req-remote-stale',
              status: 'starting',
              resumeSessionId: 'named-resume',
              sessionRef: {
                provider: 'claude',
                sessionId: staleSessionRefId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
    expect(paneContent.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    expect(paneContent.sessionId).toBe('sdk-local-current')
    expect(paneContent.createRequestId).toBe('req-local-current')
    expect(paneContent.status).toBe('running')
  })

  it('keeps comparing OWN-key hydration against the current authoritative local timestamp after a stale payload was already processed', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 100,
        resumeSessionId: canonicalSessionId,
        sessionMetadataByKey: {
          [sessionMetadataKey('claude', canonicalSessionId)]: {
            sessionType: 'freshclaude',
            firstUserMessage: 'Continue locally',
          },
        },
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
            resumeSessionId: canonicalSessionId,
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 100,
          resumeSessionId: canonicalSessionId,
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: canonicalSessionId,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', {
      key: OWN_LAYOUT_KEY,
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 150,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Remote stale title 1',
            status: 'running',
            mode: 'claude',
            createdAt: 1,
            updatedAt: 999,
            resumeSessionId: 'named-resume',
          }],
        },
        panes: {
          version: 6,
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'fresh-agent',
                sessionType: 'freshclaude',
                provider: 'claude',
                createRequestId: 'req-1',
                status: 'idle',
                resumeSessionId: 'named-resume',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    let tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.title).toBe('Local canonical title')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: OWN_LAYOUT_KEY,
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 175,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Remote stale title 2',
            status: 'running',
            mode: 'claude',
            createdAt: 1,
            updatedAt: 1000,
            resumeSessionId: 'named-resume',
          }],
        },
        panes: {
          version: 6,
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'fresh-agent',
                sessionType: 'freshclaude',
                provider: 'claude',
                createRequestId: 'req-1',
                status: 'idle',
                resumeSessionId: 'named-resume',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.title).toBe('Local canonical title')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
  })

  // Machine-stamp guard (delta review round 1, finding 1): the layout
  // storage key and broadcast channel are origin-wide, so a window on
  // another machine can hydrate its stamped layout into this page unless
  // the receiving page compares the stamp against its OWN selected
  // machine (persistMiddleware's selectStampMachineId source: store
  // slice first, remembered-selection fallback).
  function seedLocalTabsAndPanes(store: ReturnType<typeof configureStore>) {
    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-local',
          content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' },
        } as any,
      },
      activePane: { 'tab-1': 'pane-local' },
      paneTitles: {},
    }))
  }

  function stampedRemoteRaw(machineId: string | undefined, tabIds: string[] = ['t1', 't2', 't3']): string {
    return JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      ...(machineId !== undefined ? { machineId } : {}),
      tabs: {
        activeTabId: tabIds[tabIds.length - 1],
        tabs: tabIds.map((id, index) => ({ id, title: id.toUpperCase(), createdAt: index + 1 })),
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-remote',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-local', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' } },
              { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-b' },
        paneTitles: { 'tab-1': { 'pane-local': 'Stamped remote title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  function machineReadyAction(machineId: string) {
    return setMachineReady({
      machine: { id: machineId, label: machineId, createdAt: 1, lastSeenAt: 1 },
      mode: 'server-managed',
    })
  }

  it('delivers a matching machine-stamped OTHER-window layout\u2019s pane TITLES only — no tabs, no trees, no active pane (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['tab-1']?.id, 'the local leaf tree is not replaced by the remote split').toBe('pane-local')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  it('ignores a machine-stamped incoming layout from a different machine — no title delivery at all', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-OTHER') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect((store.getState().panes.layouts['tab-1'] as any)?.content?.createRequestId).toBe('req-local')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBeUndefined()
  })

  it('delivers an unstamped (legacy) OTHER-window layout\u2019s pane titles — the stamp guard never counts unstamped foreign', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw() }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id, 'no tree adoption cross-window').toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  it('ignores a machine-stamped incoming layout when the receiving page has no selected machine id at all', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBeUndefined()
  })

  it('guards by the remembered machine selection when the store slice has not resolved yet (getSelectedMachineId fallback)', () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-OTHER', ['t1', 't2', 't4']) }))
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  // ── Delta round 3, finding 1: the per-window prefix subscription ──
  //
  // The storage-event/broadcast subscription must observe the layout-key
  // PREFIX (freshell.layout.v3.<layoutWindowId>), not one exact key: events
  // from OTHER windows' per-window keys run the TITLE-ONLY path with ALL
  // its guards (machine-stamp guard first, persistedAt recency, user-set
  // precedence).
  it('delivers pane TITLES from ANOTHER window\u2019s per-window key (prefix subscription) without adopting its tabs', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{ id: 't1', title: 'T1', createdAt: 1 }],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: { 't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } } as any },
      activePane: { 't1': 'p1' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      tabs: { activeTabId: 't2', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }, { id: 't2', title: 'T2', createdAt: 2 }] },
      panes: {
        version: 6,
        layouts: { 't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } } },
        activePane: {},
        paneTitles: { 't1': { 'p1': 'Title from other window' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.layout-window-9', newValue: remoteRaw }))

    expect(store.getState().panes.paneTitles['t1']?.['p1']).toBe('Title from other window')
    expect(store.getState().tabs.tabs.map((t) => t.id), 'the other window\u2019s t2 is not adopted').toEqual(['t1'])
  })

  it('ignores storage events for reserved layout-family keys (the .bak and the fresh-agent centralization backup/marker keys)', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.bak', newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.backup-before-fresh-agent-centralization', newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: `freshell.layout.v3.${OWN_WINDOW_ID}.bak`, newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3', newValue: raw }))

    const layoutDispatches = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs' || a?.type === 'panes/hydratePanes' || a?.type === 'panes/hydratePaneTitles')
    expect(layoutDispatches).toHaveLength(0)
  })

  it('filters own-key writes on the broadcast channel path but keeps marking them processed', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      cleanups.push(installCrossTabSync(storeLike as any))

      const raw = JSON.stringify({
        version: 3,
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      })
      // A cross-source broadcast carrying OUR OWN key must not hydrate (the
      // own key is only ever this window's envelope; production never sees
      // this shape, the filter is defensive).
      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: OWN_LAYOUT_KEY, raw, sourceId: 'other-source' } })

      const hydrateCalls = dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'tabs/hydrateTabs' || a?.type === 'panes/hydratePaneTitles')
      expect(hydrateCalls).toHaveLength(0)
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  // Delta round 3, finding 2 (belt-and-braces): slices rehydrate at module
  // init; cross-tab sync installs only at machine-ready. If the window's OWN
  // envelope raw changed between module-load and install (possible only from
  // the migration or same-window writers — with per-window keys, cross-window
  // replacement is impossible), install must process the change as an
  // incoming hydrate event instead of silently marking it processed.
  it('hydrates at install when the own envelope was replaced between module-load and sync install', async () => {
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, 'client-stale-install')
    const ownKey = 'freshell.layout.v3.client-stale-install'
    // persistedAt must be real-clock-fresh: the fresh module realm below
    // re-runs the self-executing storage migration (pulled in through the
    // persistMiddleware import chain), whose stale-envelope prune sweep
    // (e3r1 finding 5) would remove a 1970-era fixture envelope before
    // the module-init loaders can read it.
    const stampBase = Date.now()
    const envelopeX = JSON.stringify({
      persistedAt: stampBase,
      version: 3,
      tabs: { activeTabId: 'tab-load-time', tabs: [{ id: 'tab-load-time', title: 'Loaded at module init', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    const envelopeY = JSON.stringify({
      persistedAt: stampBase + 1_000,
      version: 3,
      tabs: { activeTabId: 'tab-replacement', tabs: [{ id: 'tab-replacement', title: 'Replaced before install', createdAt: 2 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    localStorage.setItem(ownKey, envelopeX)
    // The module-init loaders of the pre-change code read the bare legacy
    // key — seed it too so the RED failure isolates the staleness behavior
    // (the loaders DID see X) rather than the key naming.
    localStorage.setItem('freshell.layout.v3', envelopeX)

    vi.resetModules()
    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: freshTabsReducer } = await import('@/store/tabsSlice')
    const { default: freshPanesReducer } = await import('@/store/panesSlice')
    const { installCrossTabSync: freshInstallCrossTabSync } = await import('@/store/crossTabSync')
    const { resetPersistFlushListenersForTests: freshResetFlushListeners } = await import('@/store/persistMiddleware')
    freshResetFlushListeners()

    const store = freshConfigureStore({
      reducer: { tabs: freshTabsReducer, panes: freshPanesReducer },
    })
    // The module-init rehydration loaded X (through whichever key the
    // CURRENT code reads).
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-load-time'])

    // The envelope is replaced AFTER module-load, BEFORE sync install.
    localStorage.setItem(ownKey, envelopeY)

    const cleanup = freshInstallCrossTabSync(store as any)
    cleanups.push(cleanup)

    // NOT silently marked processed: the replacement HYDRATED at install —
    // the incoming-hydrate path is the existing MERGE (hydrateTabs unions
    // by tab id with the recency/reconcile guards), so the replacement's
    // tab lands in state; a silent mark would have left ONLY the loaded X.
    const tabs = store.getState().tabs.tabs
    expect(tabs.map((t) => t.id)).toContain('tab-replacement')
    expect(tabs.find((t) => t.id === 'tab-replacement')?.title).toBe('Replaced before install')
  })

  // ── e3r1 finding 4: cross-window events are TITLE-ONLY ──
  //
  // Another window's normal flush must never add/reorder this window's
  // tabs, replace pane trees/content, move the active pane, or clear
  // ephemeral pane state (zoom) — the approved divergence tradeoff says
  // two windows on the same machine may keep divergent arrangements
  // indefinitely. Only the Task-7 pane-title reconciliation (recency +
  // user-set rules, hydrate-pane-metadata-merge.ts) applies, for panes
  // that exist in BOTH envelopes.

  function seedLocalWorkspace(store: ReturnType<typeof configureStore>): void {
    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        't1': {
          type: 'split',
          id: 'split-local',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
            { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://local.example', devToolsOpen: false } },
          ],
        } as any,
      },
      activePane: { 't1': 'pane-a' },
      paneTitles: { 't1': { 'pane-a': 'Local title' } },
      paneTitleSetByUser: {},
    }))
    store.dispatch({ type: 'panes/toggleZoom', payload: { tabId: 't1', paneId: 'pane-b' } })
  }

  function newerRemoteFullLayoutRaw(persistedAt: number): string {
    return JSON.stringify({
      version: 3,
      persistedAt,
      tabs: {
        activeTabId: 't3',
        tabs: [
          { id: 't3', title: 'T3', createdAt: 3 },
          { id: 't1', title: 'T1 remote', createdAt: 1 },
        ],
      },
      panes: {
        version: 6,
        layouts: {
          't1': {
            type: 'split',
            id: 'split-remote',
            direction: 'vertical',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-remote', status: 'running', terminalId: 'term-remote' } },
              { type: 'leaf', id: 'pane-remote-only', content: { kind: 'browser', url: 'https://remote.example', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 't1': 'pane-remote-only' },
        paneTitles: { 't1': { 'pane-a': 'Remote newer title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  it('does NOT adopt another window\u2019s NEWER full-layout flush: no tabs added/reordered, no pane tree replaced, zoom and focus stay local', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))
    const zoomBefore = store.getState().panes.zoomedPane['t1']

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().tabs.tabs.map((t) => t.id), 'no remote tab added or reorder').toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['t1']?.id, 'the local tree is not replaced').toBe('split-local')
    expect((store.getState().panes.layouts['t1'] as any).children.map((c: any) => c.id)).toEqual(['pane-a', 'pane-b'])
    expect((store.getState().panes.layouts['t1'] as any).children[0].content.createRequestId, 'the local terminal content is not replaced').toBe('req-a')
    expect(store.getState().panes.activePane['t1']).toBe('pane-a')
    expect(store.getState().panes.zoomedPane['t1'], 'another window\u2019s flush does not clear this window\u2019s zoom').toBe(zoomBefore)
    expect(store.getState().panes.zoomedPane['t1']).toBe('pane-b')
  })

  it('applies another window\u2019s NEWER pane titles to matching panes per the Task-7 rules (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the newer remote title applies to the shared pane').toBe('Remote newer title')
    expect(store.getState().panes.paneTitleSetByUser['t1']?.['pane-a'] ?? false).toBeFalsy()
    expect(store.getState().panes.paneTitles['t1']?.['pane-b'], 'panes not carried by the remote envelope keep their local titles').toBeUndefined()
    expect(store.getState().panes.paneTitles['t1']?.['pane-remote-only'], 'titles for panes that do not exist locally never land').toBeUndefined()
  })

  it('does not apply another window\u2019s OLDER pane titles (recency guard on the title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    // The receiver's own envelope stamp (2_000) is what the recency
    // comparison uses as the local side; seed it BEFORE install so the
    // dedupe seeding captures it as currentLocalLayoutPersistedAt.
    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }, { id: 't2', title: 'T2', createdAt: 2 }] },
      panes: {
        version: 6,
        layouts: {},
        activePane: {},
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(1_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'an older remote title never overwrites').toBe('Local title')
  })

  it('keeps user-set pane titles against another window\u2019s NEWER flush (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)
    store.dispatch({
      type: 'panes/updatePaneTitle',
      payload: { tabId: 't1', paneId: 'pane-a', title: 'User keeps this', setByUser: true },
    })

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('User keeps this')
    expect(store.getState().panes.paneTitleSetByUser['t1']?.['pane-a']).toBe(true)
  })

  it('the divergence pin: successive other-window flushes never move this window\u2019s arrangement', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(3_000) }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['t1']?.id).toBe('split-local')
    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('Remote newer title')
  })
})
