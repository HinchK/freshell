// Delta round 3, finding 1 (ARCHITECTURAL): every page loaded and wrote the
// SAME origin-wide `freshell.layout.v3` key, so once two windows diverged
// the last flush replaced the only durable copy — refreshing the other
// window restored the last writer's workspace. The layout envelope (and its
// side channels — the .bak, the fresh-agent centralization backup/markers,
// and the pre-migration evidence sidecar) are now keyed per window by a
// DEDICATED mint-once layout-window-id (sessionStorage
// freshell.layout-window-id.v1 — e3r1 finding 3: decoupled from the
// MUTABLE tab-registry client id; e3r2 finding 1: the registry
// lease-collision rotation — the one moment a window's identity
// legitimately splits, i.e. a duplicated browser tab — is the ONLY path
// that remints it, so a duplicate becomes a sovereign NEW window), with
// ONE-SHOT global legacy adoption (e3r1 finding
// 2: only the FIRST fresh window ever adopts; the marker
// freshell.layout.legacy-adopted.v1 gates every later window to the
// absent → inventory-rebuild path; e3r2 finding 2: the adoption is
// claimed-then-verified — the marker is written FIRST with the claimer's
// layout-window-id and read back, and only the window whose own id
// survives copies the legacy envelope) and a stale-threshold prune sweep
// at migration boot (e3r1 finding 5: beyond-STALE_LAYOUT_MS envelopes and
// their side channels are removed so closed-window layouts cannot
// accumulate unboundedly).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const LEGACY_LAYOUT_KEY = 'freshell.layout.v3'
const LEGACY_SIDECAR_KEY = 'freshell.layout.pre-migration-raw.v1'
const LEGACY_ADOPTION_MARKER_KEY = 'freshell.layout.legacy-adopted.v1'
const LAYOUT_WINDOW_ID_STORAGE_KEY = 'freshell.layout-window-id.v1'
const TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY = 'freshell.tabs.client-instance-id.v1'
const WINDOW_A_ID = 'layout-window-a'
const WINDOW_B_ID = 'layout-window-b'
const KEY_A = `freshell.layout.v3.${WINDOW_A_ID}`
const KEY_B = `freshell.layout.v3.${WINDOW_B_ID}`
const SIDECAR_A = `freshell.layout.pre-migration-raw.v1.${WINDOW_A_ID}`
const SIDECAR_B = `freshell.layout.pre-migration-raw.v1.${WINDOW_B_ID}`

const NOW = 1_760_000_000_000
const BEYOND_STALE_MS = 8 * 24 * 60 * 60 * 1000

function envelopeFor(tabId: string, persistedAt = NOW): string {
  return JSON.stringify({
    persistedAt,
    version: 4,
    machineId: 'machine-1',
    tabs: { activeTabId: tabId, tabs: [{ id: tabId, title: tabId, createdAt: NOW, updatedAt: NOW }] },
    panes: {
      version: 7,
      layouts: { [tabId]: { type: 'leaf', id: `${tabId}-pane`, content: { kind: 'editor', filePath: `/tmp/${tabId}.md`, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } } },
      activePane: { [tabId]: `${tabId}-pane` },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  })
}

function seedWindow(id: string): void {
  sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, id)
}

async function bootFreshModules(): Promise<void> {
  vi.resetModules()
  await import('@/store/storage-migration')
}

describe('per-window layout keys', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    // The prune sweep (e3r1 finding 5) runs at every migration boot with the
    // REAL clock, so a fixed NOW from 2025 would classify every fixture
    // envelope as beyond-stale and prune it. Freeze the clock to the
    // fixtures' NOW so "persisted now" means NOW.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a reload of the non-last-writer window restores ITS OWN envelope, not the last writer\u2019s (the reviewer\u2019s exact case)', async () => {
    // Two diverged windows under the OLD shared-key design: the shared key
    // holds the LAST writer's envelope (window A's), while window B's own
    // state lives under its per-window key. Window B reloads and must come
    // back to B's workspace.
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-from-window-a'))
    localStorage.setItem(KEY_B, envelopeFor('tab-from-window-b'))

    await bootFreshModules()
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    const layout = loadPersistedLayout()
    const tabIds = (layout?.tabs?.tabs as { tabs: Array<{ id: string }> } | undefined)?.tabs?.map((t) => t.id)
    expect(tabIds).toEqual(['tab-from-window-b'])
  })

  it('window B\u2019s flush writes ONLY window B\u2019s key — window A\u2019s key and the legacy key stay untouched', async () => {
    seedWindow(WINDOW_B_ID)
    const rawA = envelopeFor('tab-from-window-a')
    localStorage.setItem(KEY_A, rawA)

    vi.resetModules()
    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: freshTabsReducer, addTab } = await import('@/store/tabsSlice')
    const { panesSlice, initLayout } = await import('@/store/panesSlice')
    const { persistMiddleware } = await import('@/store/persistMiddleware')
    const { flushPersistedLayoutNow } = await import('@/store/persistControl')

    const store = freshConfigureStore({
      reducer: { tabs: freshTabsReducer, panes: panesSlice.reducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })
    store.dispatch(addTab({ id: 'tab-b-local', title: 'B local' }))
    store.dispatch(initLayout({
      tabId: 'tab-b-local',
      paneId: 'pane-b-local',
      content: { kind: 'editor', filePath: '/tmp/b.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
    }))
    store.dispatch(flushPersistedLayoutNow())

    const rawB = localStorage.getItem(KEY_B)
    expect(rawB, 'the flush wrote the window\u2019s OWN derived key').not.toBeNull()
    expect(JSON.parse(rawB!).tabs.tabs.map((t: { id: string }) => t.id)).toContain('tab-b-local')
    expect(localStorage.getItem(KEY_A), 'window A\u2019s key is untouched by B\u2019s flush').toBe(rawA)
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the bare legacy key is never written post-adoption').toBeNull()
  })

  it('derives the layout key from the layout-window-id, not the registry client id — the raw registry setter never remints the layout id', async () => {
    seedWindow(WINDOW_B_ID)
    sessionStorage.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, 'client-registry-b')

    const { getWindowLayoutKey } = await import('@/store/window-layout-keys')
    const { setTabRegistryClientInstanceId } = await import('@/store/client-instance-id')

    expect(getWindowLayoutKey()).toBe(KEY_B)

    // The low-level registry setter moves ONLY the registry id; the layout
    // key follows the layout-window-id, which is reminted exclusively by
    // the lease-collision rotation path (pinned in tabRegistrySync.test.ts
    // and the duplicate-tab divergence test below).
    setTabRegistryClientInstanceId('client-registry-b-rotated')
    expect(getWindowLayoutKey(), 'the layout key does not follow the raw registry id write').toBe(KEY_B)

    // And the registry id the setter wrote is what the registry reads.
    const { getCurrentTabRegistryClientInstanceId } = await import('@/store/client-instance-id')
    expect(getCurrentTabRegistryClientInstanceId()).toBe('client-registry-b-rotated')
  })

  it('duplicate-tab divergence contract (e3r2 finding 1): the lease-collision rotation remints the layout-window-id — the ORIGINAL keeps its envelope, the duplicate\'s fresh key classifies absent and rebuilds', async () => {
    // A duplicated browser tab COPIES both sessionStorage ids, so before
    // the collision resolves the two tabs share one layout key and either
    // tab's flush fully hydrates the other (the crossTabSync own-key
    // path), with the last writer replacing the shared envelope on every
    // refresh. The lease-collision rotation — the one moment a window's
    // identity legitimately splits — ALSO remints the layout-window-id
    // (exercised here through the REAL rotation path,
    // startTabRegistrySync + the lease channel): the duplicate becomes a
    // sovereign NEW window whose derived key is absent (refresh →
    // inventory rebuild), while the ORIGINAL's id and envelope stay
    // untouched (refresh → healthy keep). sessionStorage copies diverge
    // at duplication (HTML webstorage §12.2.2: each window has its own
    // individual copy), so the duplicate's remint write cannot reach the
    // original's copy. The registry id rotates too — that is the
    // pre-existing lease contract.
    const sharedRegistryClientId = 'client-shared-before-rotation'
    seedWindow(WINDOW_B_ID)
    sessionStorage.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, sharedRegistryClientId)
    localStorage.setItem(KEY_B, envelopeFor('tab-original-window'))

    const { startTabRegistrySync } = await import('@/store/tabRegistrySync')
    class LeaseChannel {
      static instance: LeaseChannel | null = null
      onmessage: ((event: { data: any }) => void) | null = null
      postMessage = vi.fn()
      constructor() {
        LeaseChannel.instance = this
      }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', LeaseChannel)
    vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon: vi.fn(() => true) })
    try {
      const stop = startTabRegistrySync({
        getState: () => ({
          tabs: { tabs: [], activeTabId: null, tombstones: [] },
          panes: { layouts: {}, activePane: {} },
          tabRecency: { paneLastInputAt: {} },
          tabRegistry: {
            deviceId: 'device-1',
            deviceLabel: 'label-1',
            localClosed: {},
            closedTabRetentionDays: 30,
            searchRangeDays: 30,
          },
          connection: { serverInstanceId: 'srv-test' },
        }),
        dispatch: () => {},
        subscribe: () => () => {},
      } as any, {
        state: 'ready',
        onMessage: () => () => {},
        onReconnect: () => () => {},
      } as any)

      const initialClaim = LeaseChannel.instance!.postMessage.mock.calls[0][0]
      LeaseChannel.instance!.onmessage?.({
        data: {
          type: 'tabs-registry-client-active',
          clientInstanceId: sharedRegistryClientId,
          leaseId: 'original-window',
          claimantLeaseId: initialClaim.leaseId,
        },
      })

      const duplicateLayoutWindowId = sessionStorage.getItem(LAYOUT_WINDOW_ID_STORAGE_KEY)
      expect(duplicateLayoutWindowId, 'the rotation reminted the layout-window-id').not.toBe(WINDOW_B_ID)
      expect(duplicateLayoutWindowId).toMatch(/^layout-window-/)
      expect(sessionStorage.getItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY), 'the registry id rotated too (the pre-existing lease contract)').not.toBe(sharedRegistryClientId)
      expect(localStorage.getItem(`freshell.layout.v3.${duplicateLayoutWindowId}`), 'the duplicate\'s new derived key is absent (boot classifies absent)').toBeNull()
      expect(JSON.parse(localStorage.getItem(KEY_B)!).tabs.tabs.map((t: { id: string }) => t.id), 'the ORIGINAL\'s envelope under the shared key is untouched').toEqual(['tab-original-window'])
      stop()
    } finally {
      vi.unstubAllGlobals()
    }

    // The duplicate's refresh: fresh modules read the reminted id.
    await bootFreshModules()
    const { classifyPersistedLayoutHealth } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
    expect(loadPersistedLayout()).toBeNull()

    // The original's refresh: its sessionStorage copy still holds the
    // shared id, and its envelope survived the duplicate's rotation.
    seedWindow(WINDOW_B_ID)
    await bootFreshModules()
    const { classifyPersistedLayoutHealth: classifyOriginal } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout: loadOriginal } = await import('@/store/persistMiddleware')

    expect(classifyOriginal('machine-1', { now: NOW })).toBe('healthy')
    const layout = loadOriginal()
    const tabIds = (layout?.tabs?.tabs as { tabs: Array<{ id: string }> } | undefined)?.tabs?.map((t) => t.id)
    expect(tabIds).toEqual(['tab-original-window'])
  })

  it('a fresh context mints the layout-window-id exactly once and it is stable across calls', async () => {
    // Module isolation: the in-memory mint cache survives across this
    // file's tests, so a fresh mint needs a fresh module realm.
    vi.resetModules()
    const { getWindowLayoutKey, getLayoutWindowId } = await import('@/store/window-layout-keys')

    const firstKey = getWindowLayoutKey()
    const firstId = getLayoutWindowId()
    expect(firstKey).toBe(`freshell.layout.v3.${firstId}`)
    expect(getWindowLayoutKey()).toBe(firstKey)
    expect(getLayoutWindowId()).toBe(firstId)
    expect(sessionStorage.getItem(LAYOUT_WINDOW_ID_STORAGE_KEY)).toBe(firstId)
    expect(firstId, 'the minted id never contains dots (reserved-suffix collision)').not.toContain('.')
  })

  it('e3r3 finding 3: a remint whose setItem is rejected stays authoritative in memory — repeated getters keep the reminted id over the stale stored id', async () => {
    // A duplicated tab COPIES the layout-window-id in sessionStorage, so
    // at the lease-collision rotation the duplicate remints. When that
    // remint's setItem FAILS (quota edge), storage keeps the STALE copied
    // id — the getter must never re-read storage over the established
    // remint, or both tabs share one layout key again (the exact
    // lease-collision recovery the rotation exists to fix).
    seedWindow(WINDOW_B_ID)
    vi.resetModules()
    const { getLayoutWindowId, getWindowLayoutKey, remintLayoutWindowId } = await import('@/store/window-layout-keys')

    // The context first adopts the stored (copied) id, as at real boot.
    expect(getLayoutWindowId()).toBe(WINDOW_B_ID)

    // setItem rejects from here on (jsdom's Storage is a Proxy that
    // defeats vi.spyOn — stub the global with a forwarding stub).
    const realSessionStorage = sessionStorage
    const rejecting = new Proxy(realSessionStorage, {
      get(target, prop) {
        if (prop === 'setItem') {
          return () => { throw new Error('QuotaExceededError (test)') }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    vi.stubGlobal('sessionStorage', rejecting)
    try {
      const reminted = remintLayoutWindowId()
      expect(reminted).not.toBe(WINDOW_B_ID)
      expect(getLayoutWindowId(), 'the reminted id is authoritative, not the stale stored id').toBe(reminted)
      expect(getLayoutWindowId(), 'repeated getter calls keep the reminted id').toBe(reminted)
      expect(getWindowLayoutKey()).toBe(`freshell.layout.v3.${reminted}`)
      expect(realSessionStorage.getItem(LAYOUT_WINDOW_ID_STORAGE_KEY), 'the storage write genuinely failed — the stale copied id is still stored').toBe(WINDOW_B_ID)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the FIRST fresh window adopts the legacy envelope into its derived key AND sets the one-shot global marker', async () => {
    seedWindow(WINDOW_B_ID)
    const legacyRaw = envelopeFor('tab-adopted')
    localStorage.setItem(LEGACY_LAYOUT_KEY, legacyRaw)

    await bootFreshModules()

    const adoptedRaw = localStorage.getItem(KEY_B)
    expect(adoptedRaw, 'the derived key holds the adopted envelope').not.toBeNull()
    expect(JSON.parse(adoptedRaw!).tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-adopted'])
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY)).toBe(legacyRaw)
    expect(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY), 'adoption set the one-shot marker').not.toBeNull()
  })

  it('a LATER fresh window (marker set by a foreign claimer) NEVER adopts: its derived key stays absent and the boot classifies absent → inventory rebuild', async () => {
    seedWindow('layout-window-later')
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy-first-window'))
    localStorage.setItem(LEGACY_ADOPTION_MARKER_KEY, JSON.stringify({
      version: 1,
      ownerId: 'layout-window-first-claimer',
      adoptedAt: NOW - 1_000,
    }))

    await bootFreshModules()
    const { classifyPersistedLayoutHealth } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    expect(localStorage.getItem('freshell.layout.v3.layout-window-later'), 'no adoption for a later window').toBeNull()
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
    expect(loadPersistedLayout()).toBeNull()
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the legacy key is still never deleted').not.toBeNull()
  })

  it('e3r2 finding 2 (claim-then-verify): the winning adoption claim stamps the claimer\'s layout-window-id into the one-shot marker', async () => {
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-adopted'))

    await bootFreshModules()

    const marker = JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!)
    expect(marker.ownerId, 'the claim is attributed to the window that adopted').toBe(WINDOW_B_ID)
    expect(localStorage.getItem(KEY_B), 'the verified claimer copied the legacy envelope').not.toBeNull()
  })

  it('e3r2 finding 2 (claim-then-verify): a foreign claim that wins storage before our read-back skips the copy entirely', async () => {
    // Two windows boot simultaneously right after the upgrade: both pass
    // the absent checks, both claim. localStorage is last-writer-wins, so
    // the OTHER window's claim can replace ours between our write and our
    // read-back — the verify step must see the foreign ownerId and skip
    // adoption (this window's key stays absent → boot rebuilds from the
    // inventory — the safe outcome). The serialization boundary this
    // exercises: HTML promises NO storage mutex — each single
    // getItem/setItem is atomic against the shared map, but the spec says
    // authors "are encouraged to assume that there is no locking
    // mechanism" for the interaction across agent clusters
    // (webstorage.html §12.1), so a write→read pair from one script can
    // interleave with another renderer process's write. (jsdom's Storage
    // is a Proxy that defeats vi.spyOn — the interleave is simulated by
    // stubbing the localStorage global with a forwarding Proxy that
    // lands the foreign claim immediately after the marker write.)
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy'))
    const realStorage = localStorage
    const foreignClaim = JSON.stringify({
      version: 1,
      ownerId: 'layout-window-other-window',
      adoptedAt: NOW - 1,
    })
    const intercepted = new Proxy(realStorage, {
      get(target, prop) {
        if (prop === 'setItem') {
          return (key: string, value: string) => {
            target.setItem(key, value)
            if (key === LEGACY_ADOPTION_MARKER_KEY) {
              target.setItem(LEGACY_ADOPTION_MARKER_KEY, foreignClaim)
            }
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    vi.stubGlobal('localStorage', intercepted)

    try {
      await bootFreshModules()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(localStorage.getItem(KEY_B), 'the losing window never copies the legacy envelope').toBeNull()
    expect(JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!).ownerId, 'the winner\'s claim survives intact').toBe('layout-window-other-window')
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the legacy key is still never deleted').not.toBeNull()
  })

  // ── e3r4 finding 1: claim → copy → confirm-commit ──
  //
  // The claim/read-back protocol was not exclusive: the
  // A-write → A-read → B-write → B-read interleave let both windows read
  // back their own id and both adopt. And the marker was committed BEFORE
  // the layout copy, so a quota/write failure at the copy permanently
  // consumed the one-shot and blocked every later window from adopting.
  // The protocol is now: claim (tentative marker) → read-back → copy →
  // post-copy re-verify (confirm-commit). A failed copy rolls the claim
  // back; a lost post-copy re-verify discards the copied key (absent →
  // own-snapshot rebuild). HTML webstorage has no atomic test-and-set
  // (webstorage.html §12.1: "authors are encouraged to assume that there
  // is no locking mechanism"), so a residual double-adopt window remains
  // — pinned and documented in the third test below. The complete future
  // mechanism is navigator.locks (Web Locks API).

  function forwardingProxy(storage: Storage, hook: (prop: string, fn: (...args: any[]) => unknown) => (...args: any[]) => unknown): Storage {
    return new Proxy(storage, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (typeof value === 'function') {
          const bound = (value as (...args: unknown[]) => unknown).bind(target)
          return hook(String(prop), bound as (...args: any[]) => unknown)
        }
        return value
      },
    }) as unknown as Storage
  }

  it('e3r4 finding 1 (copy-failure rollback): a failed legacy copy does NOT consume the one-shot marker — the claim rolls back and a later window can adopt', async () => {
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy'))

    // setItem for THIS window's derived key throws (quota): the copy
    // fails AFTER the claim was written.
    const rejecting = forwardingProxy(localStorage, (prop, fn) => {
      if (prop !== 'setItem') return fn
      return (key: string, value: string) => {
        if (key === KEY_B) throw new Error('QuotaExceededError (test)')
        return fn(key, value)
      }
    })
    vi.stubGlobal('localStorage', rejecting)
    try {
      await bootFreshModules()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(localStorage.getItem(KEY_B), 'the failed copy left no envelope').toBeNull()
    expect(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY), 'the claim rolled back — the one-shot is NOT consumed').toBeNull()

    // The one-shot survives for a later fresh window.
    seedWindow('layout-window-later')
    await bootFreshModules()
    expect(localStorage.getItem('freshell.layout.v3.layout-window-later'), 'a later window adopts after the rolled-back claim').not.toBeNull()
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the legacy key is still never deleted').not.toBeNull()
  })

  it('e3r4 finding 1 (post-copy re-verify): the A/A/B/B interleave converges to exactly ONE adopter — B keeps, A discards and takes the absent path', async () => {
    // The reviewer's exact named interleave: A-write → A-read → B-write →
    // B-read — both windows read back their own id and both copy. Window
    // A boots with B's claim landing right after A's copy (inside the
    // interleave window), so A's post-copy re-verify must see B's claim.
    seedWindow(WINDOW_A_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy'))
    const claimB = JSON.stringify({ version: 1, ownerId: WINDOW_B_ID, adoptedAt: NOW })
    const foreignClaimLandsAfterOurCopy = forwardingProxy(localStorage, (prop, fn) => {
      if (prop !== 'setItem') return fn
      return (key: string, value: string) => {
        const result = fn(key, value)
        if (key === KEY_A) fn(LEGACY_ADOPTION_MARKER_KEY, claimB)
        return result
      }
    })
    vi.stubGlobal('localStorage', foreignClaimLandsAfterOurCopy)
    try {
      await bootFreshModules()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(localStorage.getItem(KEY_A), 'window A discarded its copied envelope after losing the claim').toBeNull()
    expect(JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!).ownerId).toBe(WINDOW_B_ID)

    // Window B's side of the same interleave: B passed the marker-absent
    // check BEFORE A claimed (that is what A/A/B/B means), so B's boot
    // replays that check against a null marker, then claims/copies.
    seedWindow(WINDOW_B_ID)
    let markerAbsentCheckReplayed = false
    const bSideSeesPreClaimMarker = forwardingProxy(localStorage, (prop, fn) => {
      if (prop !== 'getItem') return fn
      return (key: string, ...rest: unknown[]) => {
        const value = fn(key, ...rest) as string | null
        if (key === LEGACY_ADOPTION_MARKER_KEY && !markerAbsentCheckReplayed && value !== null) {
          markerAbsentCheckReplayed = true
          return null
        }
        return value
      }
    })
    vi.stubGlobal('localStorage', bSideSeesPreClaimMarker)
    try {
      await bootFreshModules()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(localStorage.getItem(KEY_B), 'window B — the surviving claimant — keeps the adopted envelope').not.toBeNull()
    expect(localStorage.getItem(KEY_A), 'exactly one adopter: window A stays absent (own-snapshot rebuild)').toBeNull()
    expect(JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!).ownerId).toBe(WINDOW_B_ID)
  })

  it('e3r4 finding 1 (documented residual): when the claim survives our re-verify BEFORE a foreign claimant\u2019s write lands, both windows adopt the SAME shared legacy envelope — the irreducible bound without an atomic test-and-set', async () => {
    // The residual, documented rather than silently ignored: A completes
    // claim → read → copy → re-verify with NO foreign write in between
    // (the claim legitimately survived); B — which had already passed the
    // absent checks — then claims, reads back its own id, copies, and
    // re-verifies its own id. Both keep identical copies of the SAME
    // shared legacy envelope: the worst case equals the pre-upgrade
    // shared-envelope behavior for exactly those two simultaneously
    // booting windows; every later window is still gated by the
    // marker-present check. HTML webstorage has no atomic test-and-set —
    // each single getItem/setItem is atomic against the shared map, but
    // the spec promises no locking across agent clusters
    // (webstorage.html §12.1). navigator.locks (Web Locks API) is the
    // complete future mechanism; this path deliberately stays
    // dependency-free.
    seedWindow(WINDOW_A_ID)
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy'))
    await bootFreshModules()
    expect(localStorage.getItem(KEY_A), 'window A adopted cleanly (no interleaving)').not.toBeNull()
    expect(JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!).ownerId).toBe(WINDOW_A_ID)

    seedWindow(WINDOW_B_ID)
    let markerAbsentCheckReplayed = false
    const bSideSeesPreClaimMarker = forwardingProxy(localStorage, (prop, fn) => {
      if (prop !== 'getItem') return fn
      return (key: string, ...rest: unknown[]) => {
        const value = fn(key, ...rest) as string | null
        if (key === LEGACY_ADOPTION_MARKER_KEY && !markerAbsentCheckReplayed && value !== null) {
          markerAbsentCheckReplayed = true
          return null
        }
        return value
      }
    })
    vi.stubGlobal('localStorage', bSideSeesPreClaimMarker)
    try {
      await bootFreshModules()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(localStorage.getItem(KEY_B), 'the residual: B also adopts — both hold the SAME shared legacy envelope').not.toBeNull()
    expect(
      JSON.parse(localStorage.getItem(KEY_A)!).tabs.tabs.map((t: { id: string }) => t.id),
      'window A\u2019s earlier adoption is untouched (its flow had already completed)',
    ).toEqual(['tab-legacy'])
    expect(JSON.parse(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)!).ownerId, 'the last claimant wins the marker').toBe(WINDOW_B_ID)
  })

  it('the single-window upgrade path adopts exactly once: a second boot neither re-adopts nor rewrites the legacy envelope', async () => {
    seedWindow(WINDOW_B_ID)
    const legacyRaw = envelopeFor('tab-adopted')
    localStorage.setItem(LEGACY_LAYOUT_KEY, legacyRaw)

    await bootFreshModules()
    const markerAfterFirstBoot = localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)
    expect(markerAfterFirstBoot).not.toBeNull()

    await bootFreshModules()
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the legacy envelope is byte-identical after the second boot').toBe(legacyRaw)
    expect(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)).toBe(markerAfterFirstBoot)

    // A THIRD, different fresh window still cannot adopt: the marker is
    // global and one-shot.
    seedWindow('layout-window-third')
    await bootFreshModules()
    expect(localStorage.getItem('freshell.layout.v3.layout-window-third')).toBeNull()
  })

  it('the version-bump wipe keeps the one-shot adoption marker (migration keep list)', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem(LEGACY_ADOPTION_MARKER_KEY, JSON.stringify({ version: 1, adoptedAt: NOW }))
    localStorage.setItem('freshell.legacy-junk.v1', 'wiped')

    await bootFreshModules()

    expect(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)).not.toBeNull()
    expect(localStorage.getItem('freshell.legacy-junk.v1')).toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('5')
  })

  it('does not re-adopt: a window that already has its own derived key ignores the legacy key on later boots', async () => {
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(KEY_B, envelopeFor('tab-own-b'))
    // A pre-change window wrote the legacy key AFTER this window had already
    // adopted (deploy-transition state): the legacy key must never replace a
    // window's own envelope.
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy-late-writer', NOW + 5_000))

    await bootFreshModules()
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    const layout = loadPersistedLayout()
    const tabIds = (layout?.tabs?.tabs as { tabs: Array<{ id: string }> } | undefined)?.tabs?.map((t) => t.id)
    expect(tabIds).toEqual(['tab-own-b'])
    // The late legacy write survives for any pre-change window — adoption is
    // strictly absent-derived-key → copy.
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY)).not.toBeNull()
  })

  it('the pre-migration evidence sidecar is per-window: two windows\u2019 migrations never cross-contaminate evidence', async () => {
    // Window A boots first: its rewrite mirrors A's pre-rewrite raw into
    // A's OWN sidecar (oldest evidence wins, per window).
    seedWindow(WINDOW_A_ID)
    localStorage.setItem(KEY_A, envelopeFor('tab-window-a'))
    await bootFreshModules()
    const sidecarAAfterFirstBoot = localStorage.getItem(SIDECAR_A)
    expect(sidecarAAfterFirstBoot, 'window A\u2019s migration wrote A\u2019s sidecar').not.toBeNull()

    // Window B boots next in the same origin: its migration must write B's
    // OWN sidecar and leave A's evidence (and the pre-change shared sidecar
    // key) alone.
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(KEY_B, envelopeFor('tab-window-b'))
    await bootFreshModules()

    const sidecarB = localStorage.getItem(SIDECAR_B)
    expect(sidecarB, 'window B\u2019s migration wrote B\u2019s sidecar').not.toBeNull()
    expect(JSON.parse(sidecarB!).tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-window-b'])
    expect(localStorage.getItem(SIDECAR_A)).toBe(sidecarAAfterFirstBoot)
    expect(localStorage.getItem(LEGACY_SIDECAR_KEY), 'the pre-change shared sidecar key is never written again').toBeNull()
  })

  it('the version-bump wipe spares every window\u2019s derived key, backup, and sidecar (prefix keep-list)', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem('freshell.auth-token', 'token-123')
    const rawA = envelopeFor('tab-window-a')
    const rawB = envelopeFor('tab-window-b')
    localStorage.setItem(KEY_A, rawA)
    localStorage.setItem(KEY_B, rawB)
    localStorage.setItem(`${KEY_A}.bak`, rawA)
    localStorage.setItem(SIDECAR_A, 'evidence-a')
    localStorage.setItem(SIDECAR_B, 'evidence-b')
    localStorage.setItem('freshell.legacy-junk.v1', 'wiped')

    await bootFreshModules()

    expect(localStorage.getItem(KEY_A)).toBe(rawA)
    expect(localStorage.getItem(KEY_B)).toBe(rawB)
    expect(localStorage.getItem(`${KEY_A}.bak`)).toBe(rawA)
    expect(localStorage.getItem(SIDECAR_A)).toBe('evidence-a')
    expect(localStorage.getItem(SIDECAR_B)).toBe('evidence-b')
    expect(localStorage.getItem('freshell.legacy-junk.v1')).toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('5')
  })

  it('a fresh layout-window id with no envelope of its own and no server records classifies absent (the rebuild-from-inventory path stays sound)', async () => {
    seedWindow('layout-window-fresh')
    // No derived key, no legacy key: the boot must leave the window without
    // an envelope — never adopt another window's key or the shared
    // fresh-agent backup.
    localStorage.setItem(KEY_A, envelopeFor('tab-window-a'))
    localStorage.setItem('freshell.layout.v3.backup-before-fresh-agent-centralization', envelopeFor('tab-from-shared-backup'))

    await bootFreshModules()
    const { classifyPersistedLayoutHealth } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
    expect(loadPersistedLayout()).toBeNull()
  })

  // ── e3r1 finding 5: the stale-threshold prune sweep at migration boot ──
  //
  // Fresh contexts mint new layout-window-ids with no close/expiry path, so
  // closed-window envelopes (and their side channels) would accumulate
  // unboundedly until quota exhaustion breaks persistence. The migration
  // boot now enumerates layout-prefix keys and removes those whose
  // envelope persistedAt is older than STALE_LAYOUT_MS (7 days — the same
  // threshold the health gate uses to classify stale → rebuild anyway).

  it('prunes a beyond-threshold derived envelope AND its side channels at migration boot; a fresh envelope survives', async () => {
    seedWindow(WINDOW_B_ID)
    const staleRaw = envelopeFor('tab-stale-window', NOW - BEYOND_STALE_MS)
    const freshRaw = envelopeFor('tab-window-b', NOW)
    localStorage.setItem(KEY_A, staleRaw)
    localStorage.setItem(`${KEY_A}.bak`, staleRaw)
    localStorage.setItem(`${KEY_A}.backup-before-fresh-agent-centralization`, staleRaw)
    localStorage.setItem(`${KEY_A}.fresh-agent-centralization-commit`, staleRaw)
    localStorage.setItem(`${KEY_A}.fresh-agent-centralization-pending`, staleRaw)
    localStorage.setItem(SIDECAR_A, 'stale-evidence')
    localStorage.setItem(KEY_B, freshRaw)
    localStorage.setItem(SIDECAR_B, 'fresh-evidence')

    await bootFreshModules()

    expect(localStorage.getItem(KEY_A), 'the stale derived envelope is pruned').toBeNull()
    expect(localStorage.getItem(`${KEY_A}.bak`), 'the pruned envelope\u2019s backup goes too').toBeNull()
    expect(localStorage.getItem(`${KEY_A}.backup-before-fresh-agent-centralization`)).toBeNull()
    expect(localStorage.getItem(`${KEY_A}.fresh-agent-centralization-commit`)).toBeNull()
    expect(localStorage.getItem(`${KEY_A}.fresh-agent-centralization-pending`)).toBeNull()
    expect(localStorage.getItem(SIDECAR_A), 'the pruned window\u2019s pre-migration evidence sidecar goes too').toBeNull()
    expect(localStorage.getItem(KEY_B), 'the fresh envelope survives the sweep').not.toBeNull()
    expect(localStorage.getItem(SIDECAR_B)).toBe('fresh-evidence')
  })

  it('prunes a beyond-threshold LEGACY envelope and the legacy channels under the same age rule', async () => {
    seedWindow(WINDOW_B_ID)
    const staleLegacyRaw = envelopeFor('tab-legacy-stale', NOW - BEYOND_STALE_MS)
    localStorage.setItem(LEGACY_LAYOUT_KEY, staleLegacyRaw)
    localStorage.setItem('freshell.layout.v3.bak', staleLegacyRaw)
    localStorage.setItem('freshell.layout.v3.backup-before-fresh-agent-centralization', staleLegacyRaw)
    localStorage.setItem('freshell.layout.v3.fresh-agent-centralization-commit', staleLegacyRaw)
    localStorage.setItem('freshell.layout.v3.fresh-agent-centralization-pending', staleLegacyRaw)
    localStorage.setItem(LEGACY_SIDECAR_KEY, 'stale-legacy-evidence')

    await bootFreshModules()

    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the stale legacy envelope is pruned').toBeNull()
    expect(localStorage.getItem('freshell.layout.v3.bak')).toBeNull()
    expect(localStorage.getItem('freshell.layout.v3.backup-before-fresh-agent-centralization')).toBeNull()
    expect(localStorage.getItem('freshell.layout.v3.fresh-agent-centralization-commit')).toBeNull()
    expect(localStorage.getItem('freshell.layout.v3.fresh-agent-centralization-pending')).toBeNull()
    expect(localStorage.getItem(LEGACY_SIDECAR_KEY)).toBeNull()
    // The stale legacy was pruned BEFORE adoption could copy it: no
    // adoption ran, so the one-shot marker was never spent.
    expect(localStorage.getItem(LEGACY_ADOPTION_MARKER_KEY)).toBeNull()
    expect(localStorage.getItem(KEY_B), 'the fresh window adopted nothing').toBeNull()
  })

  it('keeps an envelope whose age cannot be determined (unparseable or unstamped persistedAt) — the health gate owns corrupt classification', async () => {
    seedWindow(WINDOW_B_ID)
    localStorage.setItem(KEY_A, '{corrupted-envelope')
    localStorage.setItem('freshell.layout.v3.layout-window-unstamped', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't', tabs: [{ id: 't', title: 't', createdAt: 1 }] },
      panes: { version: 7, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    }))

    await bootFreshModules()

    expect(localStorage.getItem(KEY_A), 'unparseable envelopes are kept (age unknown)').not.toBeNull()
    expect(localStorage.getItem('freshell.layout.v3.layout-window-unstamped'), 'unstamped persistedAt is kept (age unknown)').not.toBeNull()
  })
})
