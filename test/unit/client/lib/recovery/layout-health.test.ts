import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillPersistedLayoutMachineId, classifyPersistedLayoutHealth, STALE_LAYOUT_MS } from '@/lib/recovery/layout-health'
import { LAYOUT_STORAGE_KEY, MACHINE_ID_STORAGE_KEY } from '@/store/storage-keys'

const NOW = 1_760_000_000_000

function seedEnvelope(raw: unknown): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw))
}

function healthyEnvelope(machineId: string, persistedAt = NOW): Record<string, unknown> {
  return {
    persistedAt,
    version: 4,
    machineId,
    tabs: { activeTabId: 'tab-a', tabs: [{ id: 'tab-a', title: 'A', createdAt: NOW, updatedAt: NOW }] },
    panes: {
      layouts: { 'tab-a': { type: 'leaf', id: 'pane-a', content: { kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } } },
      activePane: { 'tab-a': 'pane-a' },
      paneTitles: { 'tab-a': { 'pane-a': 'A notes' } },
      paneTitleSetByUser: { 'tab-a': { 'pane-a': true } },
    },
    tombstones: [],
  }
}

describe('classifyPersistedLayoutHealth', () => {
  beforeEach(() => { localStorage.clear() })

  it('returns absent when no layout is persisted', () => {
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
  })

  it('returns absent when the envelope parses but holds zero tabs and zero panes', () => {
    seedEnvelope({ persistedAt: NOW, version: 4, tabs: { activeTabId: null, tabs: [] }, panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} }, tombstones: [] })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
  })

  it('returns corrupt when the stored envelope does not parse', () => {
    seedEnvelope('{ not json')
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when any persisted layout tree is malformed (valid tab + broken pane tree)', () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.panes = {
      ...(envelope.panes as Record<string, unknown>),
      layouts: { 'tab-a': {} },   // {} fails isWellFormedPaneTree — the loader drops it and rehydrates a default pane
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when parse-level salvage dropped an invalid tab (one valid tab + one invalid tab in the raw)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const envelope = healthyEnvelope('machine-1')
      const tabsSection = envelope.tabs as { activeTabId: string; tabs: Array<Record<string, unknown>> }
      tabsSection.tabs = [
        ...tabsSection.tabs,
        { title: 'missing id' },   // fails zTab — salvageTabs drops it while the valid tab survives parsing
      ]
      seedEnvelope(envelope)
      expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('returns corrupt when a persisted tab has no matching layout entry (the loader reconstructs a default pane)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {}
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a layout entry names a nonexistent tab (the loader drops the orphaned layout)', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { layouts: Record<string, unknown> }
    panes.layouts['tab-ghost'] = { type: 'leaf', id: 'pane-ghost', content: { kind: 'editor', filePath: '/tmp/ghost.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a non-empty-tabs envelope has no valid activeTabId (the loader silently substitutes the first tab, tabsSlice.ts:260-265)', () => {
    const envelope = healthyEnvelope('machine-1')
    const tabsSection = envelope.tabs as { activeTabId: string | null }
    tabsSection.activeTabId = 'tab-does-not-exist'   // dangling: not among the parsed tab ids
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when activePane names a pane that is not a leaf of that tab\u2019s layout (dangling focus)', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { activePane: Record<string, string> }
    panes.activePane['tab-a'] = 'pane-not-in-layout'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a tab\u2019s activePane entry is missing entirely', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { activePane: Record<string, string> }
    delete panes.activePane['tab-a']
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns foreign when the stamp names a different machine', () => {
    seedEnvelope(healthyEnvelope('machine-OTHER'))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('foreign')
  })

  it('returns healthy when the stamp matches and the layout is fresh', () => {
    seedEnvelope(healthyEnvelope('machine-1'))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('returns stale when persistedAt is older than STALE_LAYOUT_MS', () => {
    seedEnvelope(healthyEnvelope('machine-1', NOW - STALE_LAYOUT_MS - 1))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('stale')
  })

  it('treats an unstamped (legacy) envelope as healthy — never foreign — so a same-machine chooser re-pick keeps the layout', () => {
    // The accepted tradeoff pinned as a test: the re-pick persists its
    // selection before the reload (App.tsx:557-560), so resolution sees
    // remembered == resolved; the envelope is unstamped legacy data assumed
    // local, classifies healthy, and the layout is KEPT (no rebuild).
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })
})

describe('backfillPersistedLayoutMachineId', () => {
  beforeEach(() => { localStorage.clear() })

  it('stamps a healthy legacy (unstamped) envelope once machine identity resolves — with NO store action dispatched', () => {
    // The boot moment the finding pins: identity resolved, persist
    // middleware not dirty (machine-resolution actions never mark
    // tabsDirty/panesDirty, persistMiddleware.ts:719-751), so nothing else
    // would ever restamp a terminal-free healthy layout.
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    const rawBefore = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!) as Record<string, unknown>
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(true)
    const stamped = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!) as { machineId?: string }
    expect(stamped.machineId).toBe('machine-1')
    // everything else is preserved — no layout mutation:
    expect(stamped.tabs).toEqual(rawBefore.tabs)
    expect(stamped.panes).toEqual(rawBefore.panes)
    expect(stamped.persistedAt).toEqual(rawBefore.persistedAt)
  })

  it('does not rewrite an already-stamped envelope (idempotent — content byte-identical)', () => {
    seedEnvelope(healthyEnvelope('machine-1'))
    const before = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(false)
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(before)   // no write at all
  })

  it('leaves an unparseable envelope alone (no write, no throw)', () => {
    seedEnvelope('{ not json')
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(false)
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{ not json')
  })
})
