import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillPersistedLayoutMachineId, classifyPersistedLayoutHealth, STALE_LAYOUT_MS } from '@/lib/recovery/layout-health'
import { LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, LAYOUT_STORAGE_KEY, MACHINE_ID_STORAGE_KEY } from '@/store/storage-keys'
import {
  hashPersistedLayoutRaw,
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
  LAYOUT_FRESH_AGENT_MIGRATION_ID,
} from '@/store/persistedState'

const NOW = 1_760_000_000_000
const VALID_CLAUDE_SESSION_ID = '11111111-2222-4333-8444-555555555555'

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

  // Duplicate/empty identity corruption (delta review round 1, finding 3):
  // the raw-count, membership, and active-reference checks all pass on
  // aliased ids, so a corrupt cache classifies healthy unless uniqueness
  // is checked explicitly. Legit flushes can never produce duplicates
  // (reducers mint unique non-empty ids) — duplicates are corruption by
  // definition. Empty tab ids are unreachable (zTab requires min(1), so
  // salvage drops the row and the raw-count check catches it); empty pane
  // leaf ids ARE reachable (paneTreeValidation only checks
  // typeof id === 'string' and the zod layouts schema passes trees
  // through as z.unknown).
  it('returns corrupt when the parsed tabs contain a duplicate tab id', () => {
    const envelope = healthyEnvelope('machine-1')
    const tabsSection = envelope.tabs as { tabs: Array<Record<string, unknown>> }
    tabsSection.tabs = [...tabsSection.tabs, { ...tabsSection.tabs[0] }]
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when one layout tree carries a duplicate pane leaf id', () => {
    const envelope = healthyEnvelope('machine-1')
    const editorContent = () => ({ kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true })
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: editorContent() },
          { type: 'leaf', id: 'pane-a', content: editorContent() },
        ],
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a layout tree carries an empty pane leaf id (reachable per the persisted shape)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': { type: 'leaf', id: '', content: { kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = ''
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  // e1r1 review finding 2: the alias check covered LEAF ids only, so a
  // tree with distinct leaves but two same-ID nested splits classified
  // healthy — and the renderer throws on it: collectSurfaceOrder throws
  // `Duplicate split ID` (pane-surface-layout.ts:47, consumed by
  // StablePaneLayout.tsx:97 during render), stranding the tab in its
  // error boundary until the layout is manually replaced. Split ids and
  // leaf ids are minted from the same globally-unique nanoid space
  // (panesSlice.ts splitPane/addPane: `id: nanoid()` / `paneId = nanoid()`),
  // so ANY duplicated node id — split or leaf — is corruption by
  // definition. Empty split ids are reachable in the persisted raw shape
  // exactly like empty leaf ids (isPaneSplitNodeShape only requires
  // `typeof id === 'string'`, and the zod layouts schema passes trees
  // through as z.unknown).
  it('returns corrupt when a layout tree has two nested splits sharing one id (distinct leaves — the renderer throws Duplicate split ID)', () => {
    const envelope = healthyEnvelope('machine-1')
    const editorContent = () => ({ kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true })
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-dup',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'split',
            id: 'split-dup',
            direction: 'vertical',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: editorContent() },
              { type: 'leaf', id: 'pane-b', content: editorContent() },
            ],
          },
          { type: 'leaf', id: 'pane-c', content: editorContent() },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a layout tree carries an empty split id (reachable: isPaneSplitNodeShape only requires typeof id === string)', () => {
    const envelope = healthyEnvelope('machine-1')
    const editorContent = () => ({ kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true })
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: '',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: editorContent() },
          { type: 'leaf', id: 'pane-b', content: editorContent() },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a leaf id aliases a split id (all node ids share one globally-unique mint space)', () => {
    const envelope = healthyEnvelope('machine-1')
    const editorContent = () => ({ kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true })
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'shared-id',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'shared-id', content: editorContent() },
          { type: 'leaf', id: 'pane-b', content: editorContent() },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'shared-id'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  // Content-salvage classification (delta review round 2, finding 3):
  // parsePersistedLayoutRaw silently strips malformed DURABLE pane-content
  // fields BEFORE tree validation (normalizeTerminalContent destructures
  // sessionRef out and re-adds it only when
  // migrateLegacyTerminalDurableState accepts it — persistedState.ts:231-261),
  // so a pane whose sessionRef fails sanitizeSessionRef rehydrates WITHOUT
  // its durable identity while every tree-level check passes. The
  // classifier pairs RAW and PARSED leaf contents by pane id: a raw
  // top-level content key the parse dropped is corruption — the pane would
  // reopen as a FRESH session, so the own-snapshot rebuild must run.
  it('returns corrupt when a terminal pane content holds a sessionRef the content schema drops (the reviewer\u2019s exact case: invalid terminal sessionRef)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: {
          kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
          sessionRef: { provider: 'claude', sessionId: '' },
        },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns healthy when the same envelope carries a VALID terminal sessionRef', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: {
          kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
          sessionRef: { provider: 'claude', sessionId: '11111111-2222-4333-8444-555555555555' },
        },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('returns healthy when normalization ADDS a field the raw content lacks (legacy claude terminal content migrates resumeSessionId into sessionRef)', () => {
    // Raw: no sessionRef key at all; parse fills sessionRef from the
    // canonical resumeSessionId (persistedState.ts:115-158). resumeSessionId
    // itself is destructured out (:238) — a verified migration exemption:
    // current flushes strip it (persistMiddleware.ts:261), so its presence
    // is legacy-only and its durable value lands in parsed.sessionRef.
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: {
          kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'creating',
          resumeSessionId: '11111111-2222-4333-8444-555555555555',
        },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('returns healthy for a model-pinned freshopencode pane whose model the parser migrates into modelSelection', () => {
    // The FreshAgentModelDialog write shape (model + modelSelection,
    // FreshAgentModelDialog.tsx:348-372): the parse migrates freshopencode
    // model into modelSelection and drops the model key
    // (persistedState.ts:316-333) — a verified migration exemption, not
    // silent salvage.
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'cr-fa',
          status: 'idle',
          model: 'gpt-5.2',
          modelSelection: { kind: 'exact', modelId: 'gpt-5.2' },
        },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('prefers the durable pre-migration evidence sidecar over the stored raw when one is present (e2r4 finding 1)', () => {
    // The sanitized stored envelope is its own healthy truth — its raw
    // carries no key the parse drops. But the sidecar still holds the
    // ORIGINAL pre-rewrite envelope whose invalid terminal sessionRef the
    // boot migration stripped, so the cross-boot comparison the
    // process-local capture cannot make after a reload still classifies
    // the layout corrupt.
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
    const originalEnvelope = healthyEnvelope('machine-1')
    ;(originalEnvelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: {
          kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
          sessionRef: { provider: 'claude', sessionId: '' },
        },
      },
    }
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, JSON.stringify(originalEnvelope))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
    localStorage.removeItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })
})

// e2r1 review finding 1: the content-salvage check could never fire in the
// REAL boot order. main.tsx imports the self-executing storage-migration
// BEFORE the store and App (main.tsx:8 vs :9-10), and on essentially every
// boot the fresh-agent migration marker no longer matches the stored raw
// (any tabs/panes flush changes it), so migratePersistedLayout REWRITES
// freshell.layout.v3 — and its normalizeLayoutNode strips an invalid
// terminal sessionRef from the stored raw (storage-migration.ts:160
// destructure, :175 re-add only when durableState.sessionRef is truthy)
// BEFORE classifyPersistedLayoutHealth runs (App.tsx:836, during machine
// resolution). Post-rewrite, raw and parsed BOTH lack the key → healthy.
// These tests exercise the real order: seed storage, run the actual
// migration module (fresh instance — the same self-executing side effect
// main.tsx triggers), THEN classify through a fresh classifier instance
// bound to that same migration module.
describe('classifyPersistedLayoutHealth in the real boot order (migration rewrite runs first)', () => {
  beforeEach(() => { localStorage.clear() })

  async function classifyAfterRealBoot(): Promise<PersistedLayoutHealthAfterBoot> {
    localStorage.setItem('freshell_version', '5')
    vi.resetModules()
    await import('@/store/storage-migration')
    const { classifyPersistedLayoutHealth: classify } = await import('@/lib/recovery/layout-health')
    return { classify: (machineId: string) => classify(machineId, { now: NOW }) }
  }

  type PersistedLayoutHealthAfterBoot = { classify: (machineId: string) => ReturnType<typeof classifyPersistedLayoutHealth> }

  function terminalPaneEnvelope(content: Record<string, unknown>): Record<string, unknown> {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': { type: 'leaf', id: 'pane-a', content },
    }
    return envelope
  }

  it('classifies corrupt when the boot migration rewrite stripped an invalid terminal sessionRef from the raw (the finding\u2019s exact case)', async () => {
    seedEnvelope(terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: '' },
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('corrupt')
  })

  it('classifies healthy through the same real order when the terminal sessionRef is valid (the rewrite preserves it)', async () => {
    seedEnvelope(terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('healthy')
  })

  it('classifies corrupt via the stored raw when the migration guard holds (marker matches — no rewrite this boot)', async () => {
    const envelope = terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: '' },
    })
    seedEnvelope(envelope)
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)!
    localStorage.setItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY, JSON.stringify({
      version: 1,
      migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(raw),
      migratedHash: hashPersistedLayoutRaw(raw),
      committedAt: NOW,
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('corrupt')
  })

  // Verified migration drops that must NOT classify corrupt once the
  // salvage comparison sees the pre-rewrite raw: the boot migration
  // deliberately sheds these keys, so their absence in the parsed result
  // is migration, not silent salvage.
  it('stays healthy when the migration sheds a flush-carried terminal restoreError (current-writer shape: dead_live_handle)', async () => {
    seedEnvelope(terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('healthy')
  })

  it('stays healthy for the legacy codex recovery_failed remint (announced identity shed — pinned by storage-migration tests)', async () => {
    seedEnvelope(terminalPaneEnvelope({
      kind: 'terminal', mode: 'codex', createRequestId: 'cr-c', status: 'recovery_failed',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'provider_runtime_failed' },
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('healthy')
  })

  it('stays healthy for a fresh-agent restoreError pane (identity shed with the restore-unavailable error, plus vestigial display overrides)', async () => {
    seedEnvelope(terminalPaneEnvelope({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-fa', status: 'idle',
      sessionRef: { provider: 'opencode', sessionId: 'sess-x' },
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      timelineSessionId: 'sess-x',
      cliSessionId: 'sess-x',
      showThinking: true,
    }))
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('healthy')
  })

  // e2r4 review finding 1: the pre-migration raw existed only in the
  // process-local capture (storage-migration.ts preMigrationLayoutRaw), so
  // an interrupted recovery — the rebuild failed (e.g. the inventory fetch
  // rejected) and the page reloaded — lost its corruption evidence: the
  // next boot started with the capture empty and compared the
  // already-sanitized stored envelope with itself, classifying healthy and
  // permanently bypassing the corrupt-must-rebuild behavior. The
  // migration's forced-rewrite path now mirrors the pre-rewrite raw into a
  // DEDICATED sidecar key (oldest evidence wins), the classifier prefers
  // that sidecar, and the boot gate consume-and-clears it after
  // adjudication — healthy-keep or a completed rebuild retires it, a failed
  // rebuild leaves it for the next boot's retry.
  it('e2r4 interrupted recovery: the sidecar keeps a failed-rebuild layout corrupt across boots until the rebuild succeeds', async () => {
    const corruptRaw = JSON.stringify(terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: '' },
    }))
    seedEnvelope(corruptRaw)

    // Boot 1: the migration rewrites (sanitizes) and writes the evidence
    // sidecar; classification sees the stripped sessionRef through it.
    const boot1 = await classifyAfterRealBoot()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe(corruptRaw)
    const sanitizedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)!
    expect(sanitizedRaw).not.toBe(corruptRaw)
    expect(JSON.parse(sanitizedRaw).panes.layouts['tab-a'].content.sessionRef).toBeUndefined()
    expect(boot1.classify('machine-1')).toBe('corrupt')

    // The rebuild FAILS (the gate leaves the sidecar alone) and the page
    // reloads. A flush lands between boots (the user kept using the window),
    // so the next migration's marker guard fails and the rewrite runs again
    // — this time on the already-sanitized envelope. Oldest evidence wins:
    // the sidecar must NOT be overwritten, and classification must still
    // see the ORIGINAL corrupt raw.
    const flushed = JSON.parse(sanitizedRaw)
    ;(flushed.tabs as { tabs: Array<Record<string, unknown>> }).tabs[0].title = 'After the failed rebuild'
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(flushed))
    const boot2 = await classifyAfterRealBoot()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe(corruptRaw)
    expect(boot2.classify('machine-1')).toBe('corrupt')

    // The rebuild SUCCEEDS: the gate consume-and-clears the sidecar...
    const boot2Module = await import('@/lib/recovery/layout-health')
    boot2Module.clearPreMigrationLayoutEvidence()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()

    // ...and the next boot classifies the rebuilt envelope on its own raw.
    const boot3 = await classifyAfterRealBoot()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()
    expect(boot3.classify('machine-1')).toBe('healthy')
  })

  it('e2r4 healthy path: the migration writes the sidecar, healthy-keep consume-and-clears it, and the next boot has no sidecar', async () => {
    const healthyRaw = JSON.stringify(terminalPaneEnvelope({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-a', status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
    }))
    seedEnvelope(healthyRaw)

    const boot1 = await classifyAfterRealBoot()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe(healthyRaw)
    expect(boot1.classify('machine-1')).toBe('healthy')

    const boot1Module = await import('@/lib/recovery/layout-health')
    boot1Module.clearPreMigrationLayoutEvidence()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()

    const boot2 = await classifyAfterRealBoot()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()
    expect(boot2.classify('machine-1')).toBe('healthy')
  })
})

// e2r2 review findings 1+2: the verified-drop exemption set was keyed on
// the PRE-migration content kind (legacy agent-chat panes were never
// exempt, so the fixture-shaped legacy layouts classify corrupt → forced
// rebuild losing geometry/titles) and was value-INSENSITIVE (an empty or
// garbage legacy value was exempted even when the migration consumed
// nothing and produced no durable product — the pane reopened as a fresh
// session or with a default model while classifying healthy).
describe('verified migration exemptions: agent-chat kinds + value sensitivity (e2r2 findings 1-2)', () => {
  beforeEach(() => { localStorage.clear() })

  const CANONICAL_A = '00000000-0000-4000-8000-000000000121'
  const CANONICAL_B = '00000000-0000-4000-8000-000000000122'
  const CANONICAL_C = '00000000-0000-4000-8000-000000000123'

  function seedPaneLayout(content: Record<string, unknown>): void {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': { type: 'leaf', id: 'pane-a', content },
    }
    seedEnvelope(envelope)
  }

  function seedSplitPaneLayout(contents: Record<string, Record<string, unknown>>): void {
    const leaves = Object.entries(contents).map(([paneId, content]) => ({
      type: 'leaf' as const, id: paneId, content,
    }))
    const buildTree = (
      nodes: Array<{ type: 'leaf'; id: string; content: Record<string, unknown> }>,
    ): unknown => {
      if (nodes.length === 1) return nodes[0]
      const mid = Math.floor(nodes.length / 2)
      return {
        type: 'split',
        id: `split-${nodes[0].id}-${nodes[nodes.length - 1].id}`,
        direction: 'horizontal',
        sizes: [50, 50],
        children: [buildTree(nodes.slice(0, mid)), buildTree(nodes.slice(mid))],
      }
    }
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = { 'tab-a': buildTree(leaves) }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = leaves[0].id
    seedEnvelope(envelope)
  }

  it('classifies the legacy agent-chat fixture shapes healthy (the fresh-agent centralization migration is a verified rewrite, not salvage)', () => {
    // The exact shapes persisted-state.fresh-agent.test.ts pins as VALID
    // legacy migrations: vestigial showThinking/showTools, a
    // timelineSessionId, a cliSessionId, and a non-canonical sessionRef
    // alias — each deliberately removed by the agent-chat rewrite while
    // the durable identity converts into the parsed sessionRef/restoreError.
    seedSplitPaneLayout({
      'pane-ac-resume': {
        kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-ac-1', status: 'idle',
        resumeSessionId: CANONICAL_A, showThinking: false, showTools: true, showTimecodes: true,
      },
      'pane-ac-timeline': {
        kind: 'agent-chat', provider: 'kilroy', createRequestId: 'req-ac-2', status: 'idle',
        timelineSessionId: CANONICAL_B,
      },
      'pane-ac-cli': {
        kind: 'agent-chat', provider: 'claude', createRequestId: 'req-ac-3', status: 'idle',
        cliSessionId: CANONICAL_C,
      },
      'pane-ac-alias': {
        kind: 'agent-chat', provider: 'claude', createRequestId: 'req-ac-4', status: 'idle',
        sessionRef: { provider: 'claude', sessionId: 'named-alias' },
      },
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('classifies a legacy fresh-agent pane with timelineSessionId/cliSessionId and NO restoreError healthy (the ids migrate into sessionRef)', () => {
    // A healthy legacy fresh-agent pane carried its Claude UUID in the
    // timeline/cli id slots; the migration consumes them into the durable
    // sessionRef (fresh-agent.ts:325-335) with no restoreError involved.
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'req-fa-tl', status: 'idle',
      timelineSessionId: CANONICAL_A, cliSessionId: CANONICAL_B,
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('classifies the legacy codex recovery_failed remint shape healthy (the remint drops the dead terminalId and announces the rewrite)', () => {
    // The exact shape storage-migration.test.ts:291-345 pins as the valid
    // legacy migration: the remint destructures the failed recovery's dead
    // terminalId out (persistedState.ts:120-125 via :245; boot side
    // storage-migration.ts:110-115 via :162) and replaces the status with
    // 'error' + a fresh invalid_legacy_restore_target — the drop is the
    // documented migration, not silent salvage.
    seedPaneLayout({
      kind: 'terminal', mode: 'codex', createRequestId: 'req-old', status: 'recovery_failed',
      terminalId: 'term-old',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      initialCwd: '/repo',
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it.each([
    ['an empty string', ''],
    ['a non-string', 42],
  ])('classifies corrupt when a legacy terminal resumeSessionId (%s) is dropped without its migration product', (_label, resumeSessionId) => {
    // Value sensitivity: migrateLegacyTerminalDurableState discards an
    // empty/non-string resumeSessionId and produces NEITHER a sessionRef
    // NOR a restoreError (session-contract.ts:132-134) — the pane would
    // reopen as a fresh session while the old code exempted the drop.
    seedPaneLayout({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-rs', status: 'creating',
      resumeSessionId,
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it.each([
    ['a non-string', 42],
    ['a blank string', '   '],
  ])('classifies corrupt when a freshopencode model value (%s) is dropped without modelSelection', (_label, model) => {
    // Value sensitivity: normalizeFreshAgentPaneModelSelection produces no
    // modelSelection for a non-string/blank legacy model (paneTypes.ts:27-35,
    // :48-56) — the pane would reopen with the default model while the old
    // code exempted the drop.
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-model', status: 'idle', model,
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it.each([
    ['a plain string', 'dead handle'],
    ['an empty object', {}],
  ])('classifies corrupt when a terminal restoreError (%s) is dropped — only a VALID error\u2019s shed is the documented migration', (_label, restoreError) => {
    // Value sensitivity: readRestoreError rejects the value
    // (persistedState.ts:140-149) and the parse drops it with no
    // replacement — a garbage error verdict is silent salvage, not a
    // documented shed of a real RESTORE_UNAVAILABLE error.
    seedPaneLayout({
      kind: 'terminal', mode: 'claude', createRequestId: 'cr-re', status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      restoreError,
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('stays healthy when the freshopencode stale-default model is dropped without modelSelection (the documented deliberate drop)', () => {
    // persisted-state.fresh-agent.test.ts:233-254 pins this migration
    // outcome: the stale DeepSeek default is deliberately NOT carried into
    // modelSelection — the drop has no product BY DESIGN
    // (paneTypes.ts:37, :48-55).
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-stale', status: 'idle',
      model: 'opencode-go/deepseek-v4-flash',
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('stays corrupt when a fresh-agent timelineSessionId produces no durable product (value sensitivity of the id exemptions)', () => {
    // An empty-string timelineSessionId is consumed as an empty
    // resumeSessionId → migrateLegacyFreshAgentDurableState returns {}
    // (fresh-agent.ts:168-170) — dropped with neither sessionRef nor
    // restoreError.
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'cr-fa-empty-tl', status: 'idle',
      timelineSessionId: '',
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })
})

// e2r3 review finding 1: salvage detection was keyed on key PRESENCE only.
// normalizeFreshAgentContent ALWAYS re-adds the modelSelection key
// (persistedState.ts:242-251) — with value undefined when
// normalizeFreshAgentPaneModelSelection discards a schema-invalid raw
// selection (FreshAgentModelSelectionSchema,
// fresh-agent-model-capabilities.ts:29-32, is a strict discriminated union
// on kind ∈ {tracked, exact} whose modelId is z.string().trim().min(1)),
// so key-presence classification called the pane healthy although the
// parse silently discarded the selected model and the pane would reopen
// with the default model. The salvage rule must be VALUE-level:
// parsed-EFFECTIVE keys are the keys whose value is not undefined (raw
// JSON values are never undefined), and a raw key whose parsed-effective
// value is absent is a DROP subject to the same verified exemption set.
// e2r3 review finding 2: the stale-default exemption compared the raw
// value EXACTLY while the canonical normalizer TRIMS before comparing
// (paneTypes.ts:52, normalizeFreshAgentPaneModelSelection) — a padded
// legacy default was deliberately normalized away (no modelSelection
// product) yet classified corrupt, forcing a needless rebuild that lost
// geometry/titles.
describe('value-level salvage rule + trimmed stale-default exemption (e2r3 findings 1-2)', () => {
  beforeEach(() => { localStorage.clear() })

  function seedPaneLayout(content: Record<string, unknown>): void {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': { type: 'leaf', id: 'pane-a', content },
    }
    seedEnvelope(envelope)
  }

  it.each([
    ['an unknown kind discriminator', { kind: 'bogus', modelId: 'm' }],
    ['a missing modelId', { kind: 'exact' }],
    ['an empty modelId', { kind: 'exact', modelId: '' }],
  ])('classifies corrupt when a freshopencode pane holds a schema-invalid durable modelSelection (%s) with no legacy model', (_label, modelSelection) => {
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-badsel', status: 'idle',
      modelSelection,
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('classifies healthy when the freshopencode pane holds a VALID durable modelSelection (the parsed-effective value survives)', () => {
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-goodsel', status: 'idle',
      modelSelection: { kind: 'exact', modelId: 'gpt-5.2' },
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('stays healthy when a schema-invalid modelSelection is salvaged by a usable legacy model (the migration product exists)', () => {
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-legacymodel', status: 'idle',
      model: 'gpt-5.2',
      modelSelection: { kind: 'bogus', modelId: 'm' },
    })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('stays healthy when the stale freshopencode default arrives PADDED — the exemption mirrors the normalizer\u2019s trim (paneTypes.ts:52)', () => {
    seedPaneLayout({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      createRequestId: 'cr-oc-stale-pad', status: 'idle',
      model: ' opencode-go/deepseek-v4-flash ',
    })
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
