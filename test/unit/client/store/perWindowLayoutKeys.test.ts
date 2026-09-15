// Delta round 3, finding 1 (ARCHITECTURAL): every page loaded and wrote the
// SAME origin-wide `freshell.layout.v3` key, so once two windows diverged
// the last flush replaced the only durable copy — refreshing the other
// window restored the last writer's workspace. The layout envelope (and its
// side channels — the .bak, the fresh-agent centralization backup/markers,
// and the pre-migration evidence sidecar) are now keyed per window by a
// DEDICATED IMMUTABLE layout-window-id (sessionStorage
// freshell.layout-window-id.v1 — e3r1 finding 3: decoupled from the
// MUTABLE tab-registry client id, whose lease-collision rotation must not
// move the layout key), with ONE-SHOT global legacy adoption (e3r1 finding
// 2: only the FIRST fresh window ever adopts; the marker
// freshell.layout.legacy-adopted.v1 gates every later window to the
// absent → inventory-rebuild path) and a stale-threshold prune sweep at
// migration boot (e3r1 finding 5: beyond-STALE_LAYOUT_MS envelopes and
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

  it('derives the layout key from the IMMUTABLE layout-window-id, not the mutable registry client id', async () => {
    seedWindow(WINDOW_B_ID)
    sessionStorage.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, 'client-registry-b')

    const { getWindowLayoutKey } = await import('@/store/window-layout-keys')
    const { setTabRegistryClientInstanceId } = await import('@/store/client-instance-id')

    expect(getWindowLayoutKey()).toBe(KEY_B)

    // The supported lease-collision rotation path rewrites ONLY the
    // registry id; the layout key must not follow it.
    setTabRegistryClientInstanceId('client-registry-b-rotated')
    expect(getWindowLayoutKey(), 'the layout key does not follow the registry id rotation').toBe(KEY_B)

    // And the registry id the rotation wrote is what the registry reads.
    const { getCurrentTabRegistryClientInstanceId } = await import('@/store/client-instance-id')
    expect(getCurrentTabRegistryClientInstanceId()).toBe('client-registry-b-rotated')
  })

  it('duplicate-tab scenario: a copied sessionStorage id whose REGISTRY id rotates keeps the envelope reachable across a refresh (no absent-classified rebuild)', async () => {
    // A duplicated browser tab copies BOTH sessionStorage ids. The
    // duplicate's tab-registry lease collides with the original's, so the
    // registry id ROTATES — the layout key must not, or the duplicate's
    // next refresh would classify its healthy envelope absent (or adopt
    // obsolete legacy data) and rebuild, resetting geometry.
    seedWindow(WINDOW_B_ID)
    sessionStorage.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, WINDOW_B_ID)
    localStorage.setItem(KEY_B, envelopeFor('tab-window-b'))

    const { setTabRegistryClientInstanceId } = await import('@/store/client-instance-id')
    setTabRegistryClientInstanceId('client-rotated-by-collision')

    // Refresh: fresh modules re-read sessionStorage for the layout key.
    await bootFreshModules()
    const { classifyPersistedLayoutHealth } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
    const layout = loadPersistedLayout()
    const tabIds = (layout?.tabs?.tabs as { tabs: Array<{ id: string }> } | undefined)?.tabs?.map((t) => t.id)
    expect(tabIds).toEqual(['tab-window-b'])
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

  it('a LATER fresh window (marker set) NEVER adopts: its derived key stays absent and the boot classifies absent → inventory rebuild', async () => {
    seedWindow('layout-window-later')
    localStorage.setItem(LEGACY_LAYOUT_KEY, envelopeFor('tab-legacy-first-window'))
    localStorage.setItem(LEGACY_ADOPTION_MARKER_KEY, JSON.stringify({ version: 1, adoptedAt: NOW - 1_000 }))

    await bootFreshModules()
    const { classifyPersistedLayoutHealth } = await import('@/lib/recovery/layout-health')
    const { loadPersistedLayout } = await import('@/store/persistMiddleware')

    expect(localStorage.getItem('freshell.layout.v3.layout-window-later'), 'no adoption for a later window').toBeNull()
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
    expect(loadPersistedLayout()).toBeNull()
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY), 'the legacy key is still never deleted').not.toBeNull()
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

  it('a fresh clientInstanceId with no envelope of its own and no server records classifies absent (the rebuild-from-inventory path stays sound)', async () => {
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
