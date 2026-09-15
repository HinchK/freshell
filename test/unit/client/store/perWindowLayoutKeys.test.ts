// Delta round 3, finding 1 (ARCHITECTURAL): every page loaded and wrote the
// SAME origin-wide `freshell.layout.v3` key, so once two windows diverged
// the last flush replaced the only durable copy — refreshing the other
// window restored the last writer's workspace. The layout envelope (and its
// side channels — the .bak, the fresh-agent centralization backup/markers,
// and the pre-migration evidence sidecar) are now keyed per window by the
// SAME clientInstanceId the tab-registry sync uses
// (freshell.tabs.client-instance-id.v1), with one-time LEGACY adoption.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const LEGACY_LAYOUT_KEY = 'freshell.layout.v3'
const LEGACY_SIDECAR_KEY = 'freshell.layout.pre-migration-raw.v1'
const ID_STORAGE_KEY = 'freshell.tabs.client-instance-id.v1'
const WINDOW_A_ID = 'client-window-a'
const WINDOW_B_ID = 'client-window-b'
const KEY_A = `freshell.layout.v3.${WINDOW_A_ID}`
const KEY_B = `freshell.layout.v3.${WINDOW_B_ID}`
const SIDECAR_A = `freshell.layout.pre-migration-raw.v1.${WINDOW_A_ID}`
const SIDECAR_B = `freshell.layout.pre-migration-raw.v1.${WINDOW_B_ID}`

const NOW = 1_760_000_000_000

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
  sessionStorage.setItem(ID_STORAGE_KEY, id)
}

async function bootFreshModules(): Promise<void> {
  vi.resetModules()
  await import('@/store/storage-migration')
}

describe('per-window layout keys', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
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

  it('adopts a pre-change legacy envelope into the window\u2019s derived key on first boot and never deletes it from legacy', async () => {
    seedWindow(WINDOW_B_ID)
    const legacyRaw = envelopeFor('tab-adopted')
    localStorage.setItem(LEGACY_LAYOUT_KEY, legacyRaw)

    await bootFreshModules()

    const adoptedRaw = localStorage.getItem(KEY_B)
    expect(adoptedRaw, 'the derived key holds the adopted envelope').not.toBeNull()
    expect(JSON.parse(adoptedRaw!).tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-adopted'])
    // NEVER delete the legacy key: other live pre-change windows may still
    // read it, and post-change windows must not destroy migration evidence.
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY)).toBe(legacyRaw)
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
    seedWindow('client-window-fresh')
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
})
