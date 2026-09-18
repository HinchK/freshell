import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.status = status
      this.data = data
    }
  },
}))

vi.mock('@/lib/api', () => ({ api: { post: apiMocks.post }, ApiError: apiMocks.ApiError }))

import {
  captureLegacyNameEvidence,
  captureLegacyLayoutEnvelope,
  collectLegacyPendingHandleAssignments,
  ensureLegacyNameCapturesForFlush,
  importLegacyNames,
  isLegacyNameCaptureSourceKey,
  legacyPendingNamingHandle,
  listCapturedMigrationEnvelopes,
  prepareLegacyNameImports,
  registerLegacyNameSubmitGate,
  resetLegacyNameCaptureFailureForTests,
  SESSION_NAME_MIGRATION_KEY_PREFIX,
  stripScopedPaneTitleMetadata,
  stripSessionOwnedTabFreezeFlags,
  submitPendingLegacyNameImports,
} from '@/lib/session-name-migration'
import {
  parsePersistedLayoutRaw,
} from '@/store/persistedState'
import { LAYOUT_STORAGE_KEY_PREFIX } from '@/store/window-layout-keys'

// ── fixtures ─────────────────────────────────────────────────────────────────

function scopedTerminalPane(sessionId: string): unknown {
  return {
    type: 'leaf',
    id: 'pane-1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId },
    },
  }
}

function unboundScopedPane(): unknown {
  return {
    type: 'leaf',
    id: 'pane-unbound',
    content: {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-unbound',
      terminalId: 'term-unbound',
    },
  }
}

function shellPane(): unknown {
  return {
    type: 'leaf',
    id: 'pane-shell',
    content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell' },
  }
}

function layoutEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 4,
    persistedAt: 1234,
    tabs: {
      activeTabId: 'tab-1',
      tabs: [
        { id: 'tab-1', title: 'Tab Label', titleSetByUser: true },
        { id: 'tab-shell', title: 'Shell Tab' },
      ],
    },
    panes: {
      version: 7,
      layouts: {
        'tab-1': scopedTerminalPane('sess-1'),
        'tab-shell': shellPane(),
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {
        'tab-1': { 'pane-1': 'Pane Alias' },
        'tab-shell': { 'pane-shell': 'Shell Title' },
      },
      paneTitleSetByUser: {
        'tab-1': { 'pane-1': true },
        'tab-shell': { 'pane-shell': true },
      },
    },
    ...overrides,
  })
}

function envelopeKeysIn(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) keys.push(key)
  }
  return keys
}

/** A localStorage stub that can be made to fail setItem. */
function failingStorage(): Storage & { failSetItem: (fail: boolean) => void } {
  const map = new Map<string, string>()
  const storage = {
    fail: false,
    get length() { return map.size },
    key(index: number) { return Array.from(map.keys())[index] ?? null },
    getItem(key: string) { return map.get(key) ?? null },
    setItem(key: string, value: string) {
      if ((storage as unknown as { fail: boolean }).fail) {
        throw new Error('quota')
      }
      map.set(key, value)
    },
    removeItem(key: string) { map.delete(key) },
    clear() { map.clear() },
    failSetItem(fail: boolean) { (storage as unknown as { fail: boolean }).fail = fail },
  }
  return storage as Storage & { failSetItem: (fail: boolean) => void }
}

beforeEach(() => {
  localStorage.clear()
  apiMocks.post.mockReset()
  registerLegacyNameSubmitGate(() => false)
  resetLegacyNameCaptureFailureForTests()
})

// ── capture ─────────────────────────────────────────────────────────────────

describe('legacy-name capture', () => {
  it('captures every supported raw source under its own per-importId envelope key', () => {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    localStorage.setItem('freshell.layout.v3', layoutEnvelope()) // legacy bare
    localStorage.setItem('freshell.layout.v3.bak', layoutEnvelope()) // legacy backup
    localStorage.setItem('freshell.layout.v3.window-a.bak', layoutEnvelope())
    localStorage.setItem('freshell.layout.pre-migration-raw.v1.window-a', layoutEnvelope())
    localStorage.setItem('freshell.tabs.v2', layoutEnvelope())
    localStorage.setItem('freshell.panes.v2', layoutEnvelope())
    // Non-sources never captured.
    localStorage.setItem('freshell.layout.v3.window-a.fresh-agent-centralization-commit', '{}')
    localStorage.setItem('freshell.browser-preferences.v1', '{}')

    const evidence = captureLegacyNameEvidence(localStorage)

    expect(evidence).toHaveLength(7)
    const envelopes = listCapturedMigrationEnvelopes(localStorage)
    expect(envelopes).toHaveLength(7)
    for (const envelope of envelopes) {
      expect(localStorage.getItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.${envelope.importId}`))
        .toBe(JSON.stringify(envelope))
    }
    // The raw bytes are preserved verbatim.
    expect(envelopes.map((envelope) => envelope.storageKey).sort()).toEqual([
      'freshell.layout.pre-migration-raw.v1.window-a',
      'freshell.layout.v3',
      'freshell.layout.v3.bak',
      'freshell.layout.v3.window-a',
      'freshell.layout.v3.window-a.bak',
      'freshell.panes.v2',
      'freshell.tabs.v2',
    ])
  })

  it('is idempotent — running twice never duplicates envelopes', () => {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    captureLegacyNameEvidence(localStorage)
    const first = listCapturedMigrationEnvelopes(localStorage)
    const evidence = captureLegacyNameEvidence(localStorage)
    expect(evidence).toHaveLength(first.length)
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(first.length)
  })

  it('is retry-stable: the same source keeps its importId; a changed raw gets a NEW envelope and the original bytes survive', () => {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    captureLegacyNameEvidence(localStorage)
    const first = listCapturedMigrationEnvelopes(localStorage)
    expect(first).toHaveLength(1)

    // Same bytes: no change.
    captureLegacyNameEvidence(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toEqual(first)

    // Changed bytes (a sanitized flush): the original envelope is never
    // overwritten — a new immutable envelope joins it.
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope({ persistedAt: 9999 }))
    captureLegacyNameEvidence(localStorage)
    const after = listCapturedMigrationEnvelopes(localStorage)
    expect(after).toHaveLength(2)
    expect(after.map((envelope) => envelope.raw)).toContain(layoutEnvelope())
  })

  it('two starting windows never overwrite each other (per-importId keys, no shared blob)', () => {
    // Two independent storage realms model two windows of one origin.
    const windowA = failingStorage()
    const windowB = failingStorage()
    windowA.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    windowB.setItem('freshell.layout.v3.window-b', layoutEnvelope({ persistedAt: 5 }))

    captureLegacyNameEvidence(windowA)
    captureLegacyNameEvidence(windowB)

    const a = listCapturedMigrationEnvelopes(windowA)
    const b = listCapturedMigrationEnvelopes(windowB)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].importId).not.toBe(b[0].importId)
    // A second window's capture cannot clobber the first's envelope.
    const aFirst = `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${a[0].importId}`
    expect(windowA.getItem(aFirst)).toBe(JSON.stringify(a[0]))
  })

  it('keeps the source and stays retryable when an envelope write fails', () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    const storage = failingStorage()
    storage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    storage.failSetItem(true)
    expect(() => captureLegacyNameEvidence(storage)).not.toThrow()
    // The source is untouched.
    expect(storage.getItem('freshell.layout.v3.window-a')).toBe(layoutEnvelope())
    // A retry once writable succeeds.
    storage.failSetItem(false)
    captureLegacyNameEvidence(storage)
    expect(listCapturedMigrationEnvelopes(storage)).toHaveLength(1)
  })

  it('gates the persistence flush on capture success — a failing capture defers, the retry recaptures and clears', () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    const storage = failingStorage()
    storage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    // Healthy: an O(1) yes with nothing pending.
    expect(ensureLegacyNameCapturesForFlush(storage)).toBe(true)

    // The boot capture fails (quota): the gate must defer the flush while
    // the uncaptured legacy bytes still sit in their source key.
    storage.failSetItem(true)
    captureLegacyNameEvidence(storage)
    expect(ensureLegacyNameCapturesForFlush(storage)).toBe(false)
    expect(storage.getItem('freshell.layout.v3.window-a')).toBe(layoutEnvelope())

    // The write heals: the gate's re-capture lands the envelope FIRST,
    // then reports the flush safe (the legacy bytes are now backed up).
    storage.failSetItem(false)
    expect(ensureLegacyNameCapturesForFlush(storage)).toBe(true)
    const envelopes = listCapturedMigrationEnvelopes(storage)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].storageKey).toBe('freshell.layout.v3.window-a')
    expect(envelopes[0].raw).toBe(layoutEnvelope())
    // And the recovered gate stays O(1) healthy.
    expect(ensureLegacyNameCapturesForFlush(storage)).toBe(true)
  })

  it('captures an OLD envelope delivered later via crossTabSync before sanitization, and submits only through the ready gate', async () => {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    const foreignRaw = layoutEnvelope({ persistedAt: 42 })
    // Gate closed: captured, no submit.
    captureLegacyLayoutEnvelope('freshell.layout.v3.window-b', foreignRaw)
    expect(listCapturedMigrationEnvelopes(localStorage).map((e) => e.storageKey))
      .toContain('freshell.layout.v3.window-b')
    expect(apiMocks.post).not.toHaveBeenCalled()
    // Gate open: the pending evidence (including the mid-session capture)
    // submits.
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    registerLegacyNameSubmitGate(() => true)
    captureLegacyLayoutEnvelope('freshell.layout.v3.window-c', layoutEnvelope({ persistedAt: 77 }))
    // The fire-and-forget submit runs on the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(apiMocks.post).toHaveBeenCalled()
  })
})

// ── prepare ─────────────────────────────────────────────────────────────────

describe('legacy-name candidate preparation', () => {
  it('extracts flagged pane and source-tab candidates and bare automatic labels with their claims', () => {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    captureLegacyNameEvidence(localStorage)
    const imports = prepareLegacyNameImports(
      listCapturedMigrationEnvelopes(localStorage).map((e) => ({
        storageKey: e.storageKey, raw: e.raw,
      })),
    )
    expect(imports).toHaveLength(1)
    const candidates = imports[0].candidates
    // The flagged pane alias claims legacy-flag protection.
    const pane = candidates.find((c) => c.scope === 'pane')
    expect(pane).toMatchObject({
      name: 'Pane Alias',
      source: 'legacy_protected',
      protectionEvidence: 'legacy_flag',
      target: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
    })
    // The user-flagged tab label claims legacy protection for the
    // naming-source session (the first leaf is scoped here).
    const tab = candidates.find((c) => c.scope === 'source_tab')
    expect(tab).toMatchObject({
      name: 'Tab Label',
      source: 'legacy_protected',
      protectionEvidence: 'legacy_flag',
      target: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
    })
    // The shell pane/tab never produced a candidate.
    expect(candidates.find((c) => c.name === 'Shell Title')).toBeUndefined()
    expect(candidates.find((c) => c.name === 'Shell Tab')).toBeUndefined()
    // No candidate ever carries an explicitRenameAt (no trustworthy time in
    // legacy data — and never the envelope's updatedAt).
    expect(candidates.every((c) => c.explicitRenameAt === undefined)).toBe(true)
  })

  it('maps one source-tab label only to its naming-source session — a shell-first tab keeps its label recovery-only', () => {
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't', tabs: [{ id: 't', title: 'Mixed Tab Label', titleSetByUser: true }] },
      panes: {
        version: 7,
        layouts: {
          t: {
            type: 'split',
            children: [shellPane(), scopedTerminalPane('sess-late')],
          },
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
    })
    const imports = prepareLegacyNameImports([{ storageKey: 'freshell.layout.v3.window-a', raw }])
    expect(imports).toHaveLength(0)
  })

  it('derives a retry-stable legacy-pending namingHandle for an unbound scoped pane and persists the assignment', () => {
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't', tabs: [{ id: 't', title: 'Pre Identity' }] },
      panes: {
        version: 7,
        layouts: { t: unboundScopedPane() },
        paneTitles: { t: { 'pane-unbound': 'Named Before Identity' } },
        paneTitleSetByUser: { t: { 'pane-unbound': true } },
      },
    })
    localStorage.setItem('freshell.layout.v3.window-a', raw)
    captureLegacyNameEvidence(localStorage)
    const evidence = listCapturedMigrationEnvelopes(localStorage)
      .map((e) => ({ storageKey: e.storageKey, raw: e.raw }))

    const assignments = collectLegacyPendingHandleAssignments(evidence)
    expect(assignments).toHaveLength(1)
    expect(assignments[0].namingHandle).toBe(legacyPendingNamingHandle({
      storageKey: 'freshell.layout.v3.window-a',
      windowId: 'window-a',
      paneId: 'pane-unbound',
      createRequestId: 'req-unbound',
    }))
    expect(JSON.parse(assignments[0].namingHandle)).toEqual([
      'legacy-pending', 'freshell.layout.v3.window-a', 'window-a', 'pane-unbound', 'req-unbound',
    ])

    // The candidate targets the derived pending handle.
    const imports = prepareLegacyNameImports(evidence)
    expect(imports[0].candidates[0].target).toEqual({
      kind: 'pending',
      id: assignments[0].namingHandle,
    })
    // Retry stability: re-derivation produces the same handle.
    expect(collectLegacyPendingHandleAssignments(evidence)[0].namingHandle)
      .toBe(assignments[0].namingHandle)
  })

  it('yields no candidates from a corrupted envelope and chunks oversized envelopes at 100 candidates', () => {
    expect(prepareLegacyNameImports([
      { storageKey: 'freshell.layout.v3.corrupt', raw: '{not json' },
    ])).toEqual([])

    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    })
    const imports = prepareLegacyNameImports([
      { storageKey: 'freshell.layout.v3.window-big', raw },
    ])
    expect(imports).toHaveLength(2)
    expect(imports[0].candidates).toHaveLength(100)
    expect(imports[1].candidates).toHaveLength(50)
    expect(imports[0].importId).not.toBe(imports[1].importId)
  })
})

// ── submit ──────────────────────────────────────────────────────────────────

describe('legacy-name import submission', () => {
  function seedPending(): void {
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    captureLegacyNameEvidence(localStorage)
  }

  it('submits pending imports, marks acknowledged ids, and skips acknowledged evidence', async () => {
    seedPending()
    apiMocks.post.mockResolvedValue({
      acknowledged: ['c-1'],
      names: [],
    })
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    const body = apiMocks.post.mock.calls[0][1] as { importId: string }
    // Acknowledged: a second submit is a no-op.
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it('marks candidate-free envelopes acknowledged (nothing to import) without a request', async () => {
    localStorage.setItem('freshell.layout.v3.window-a', '{corrupt')
    captureLegacyNameEvidence(localStorage)
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('keeps a failed submit pending for retry (never acknowledges, never clears evidence)', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    seedPending()
    apiMocks.post.mockRejectedValue(new Error('network down'))
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('network down')
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(1)
    // Retry once the server answers.
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
  })

  it('acknowledges a deterministic 400 locally (it can never succeed on retry)', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the rejection path logs
    seedPending()
    apiMocks.post.mockRejectedValue(new apiMocks.ApiError(400, 'Invalid request'))
    await submitPendingLegacyNameImports()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it('retires an oversized envelope after its chunked imports acknowledge (no endless re-submit)', async () => {
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    localStorage.setItem('freshell.layout.v3.window-big', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    }))
    captureLegacyNameEvidence(localStorage)
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })

    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    // Both chunks acknowledged → the envelope is fully retired: a second
    // ready edge never re-submits it.
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
  })

  it('a failed later chunk keeps the envelope pending and resubmits only the unacknowledged chunks', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 250; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    localStorage.setItem('freshell.layout.v3.window-chunked', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    }))
    captureLegacyNameEvidence(localStorage)
    const base = listCapturedMigrationEnvelopes(localStorage)[0].importId
    const postedImportIds = () =>
      apiMocks.post.mock.calls.map(([, body]) => (body as { importId: string }).importId)

    // Chunk 0 of 3 succeeds; chunk 1 fails transiently (a non-400 error —
    // network/5xx — which must stay retryable).
    apiMocks.post.mockImplementation(async (_url: string, body: unknown) => {
      const importId = (body as { importId: string }).importId
      if (importId === `${base}--1`) throw new Error('transient network failure')
      return { acknowledged: [], names: [] }
    })
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('transient network failure')
    expect(postedImportIds()).toEqual([`${base}--0`, `${base}--1`])

    // The envelope is still pending — chunk 0's success must NOT retire
    // it — so the next ready edge resubmits ONLY the unacknowledged
    // chunks (chunk 0 replays as a per-candidate no-op, so it is not
    // even sent).
    apiMocks.post.mockClear()
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    expect(postedImportIds()).toEqual([`${base}--1`, `${base}--2`])

    // Every chunk is now acknowledged → the envelope retires: a further
    // ready edge sends nothing.
    apiMocks.post.mockClear()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(1)
  })

  it('pairs chunks to envelopes by evidence — an importId containing "--" never breaks the retirement bookkeeping', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    // A captured envelope whose id contains `--` (a legal nanoid pair —
    // seen in a real coordinated run): the chunk ids become
    // `edge--case--0/1`, and the envelope↔chunk pairing must still hold.
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    })
    localStorage.setItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.edge--case`, JSON.stringify({
      version: 1,
      importId: 'edge--case',
      storageKey: 'freshell.layout.v3.window-dash',
      raw,
      capturedAt: 1,
    }))

    // Chunk 0 succeeds, chunk 1 fails transiently: the envelope (whose id
    // a `--`-split heuristic would mangle) must STAY pending.
    apiMocks.post.mockImplementation(async (_url: string, body: unknown) => {
      const importId = (body as { importId: string }).importId
      if (importId === 'edge--case--1') throw new Error('transient network failure')
      return { acknowledged: [], names: [] }
    })
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('transient network failure')
    // Still pending: the next ready edge resubmits only the missing chunk.
    apiMocks.post.mockClear()
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    const posted = apiMocks.post.mock.calls.map(([, body]) => (body as { importId: string }).importId)
    expect(posted).toEqual(['edge--case--1'])
    // Fully acknowledged → retired: nothing further is sent.
    apiMocks.post.mockClear()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('importLegacyNames posts the migration envelope to the import endpoint', async () => {
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await importLegacyNames([
      { version: 1, importId: 'i-1', evidence: [], candidates: [] },
    ])
    expect(apiMocks.post).toHaveBeenCalledWith(
      '/api/session-names/import',
      { version: 1, importId: 'i-1', evidence: [], candidates: [] },
    )
  })
})

// ── the one client sanitizer ─────────────────────────────────────────────────

describe('the one client sanitizer', () => {
  it('strips scoped pane titles/flags while preserving out-of-scope entries verbatim', () => {
    const { paneTitles, paneTitleSetByUser } = stripScopedPaneTitleMetadata(
      {
        'tab-1': scopedTerminalPane('sess-1'),
        'tab-shell': shellPane(),
      },
      {
        'tab-1': { 'pane-1': 'Pane Alias' },
        'tab-shell': { 'pane-shell': 'Shell Title' },
      },
      {
        'tab-1': { 'pane-1': true },
        'tab-shell': { 'pane-shell': true },
      },
    )
    expect(paneTitles).toEqual({ 'tab-shell': { 'pane-shell': 'Shell Title' } })
    expect(paneTitleSetByUser).toEqual({ 'tab-shell': { 'pane-shell': true } })
  })

  it('strips a session-owned tab freeze flag but keeps the title projection and legacy tabs verbatim', () => {
    const [sessionOwned, legacy] = stripSessionOwnedTabFreezeFlags([
      { id: 't1', title: 'Projection', titleSetByUser: true, nameSource: { kind: 'session', paneId: 'p1' } },
      { id: 't2', title: 'Legacy', titleSetByUser: true },
    ])
    expect(sessionOwned).toEqual({ id: 't1', title: 'Projection', nameSource: { kind: 'session', paneId: 'p1' } })
    expect(legacy).toEqual({ id: 't2', title: 'Legacy', titleSetByUser: true })
  })

  it('gates the persisted parse: scoped aliases never re-enter state, identity and source pointers survive', () => {
    const parsed = parsePersistedLayoutRaw(JSON.stringify({
      version: 4,
      persistedAt: 9,
      tabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: 'Old Tab Title', titleSetByUser: true, nameSource: { kind: 'session', paneId: 'p1' } },
          { id: 't2', title: 'Legacy Tab', titleSetByUser: true },
        ],
      },
      panes: {
        version: 7,
        layouts: {
          t1: {
            type: 'leaf',
            id: 'p1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              sessionRef: { provider: 'claude', sessionId: 'sess-1' },
              nameRef: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
              namingHandle: 'h1',
            },
          },
          t2: shellPane(),
        },
        activePane: { t1: 'p1' },
        paneTitles: { t1: { p1: 'Scoped Alias' }, t2: { 'pane-shell': 'Shell Title' } },
        paneTitleSetByUser: { t1: { p1: true }, t2: { 'pane-shell': true } },
      },
    }))
    expect(parsed).not.toBeNull()
    // Scoped aliases dropped at parse…
    expect(parsed!.panes.paneTitles).toEqual({ t2: { 'pane-shell': 'Shell Title' } })
    expect(parsed!.panes.paneTitleSetByUser).toEqual({ t2: { 'pane-shell': true } })
    // …while identity, the source pointer and projections survive.
    const content = (parsed!.panes.layouts.t1 as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'sess-1' })
    expect(content.nameRef).toEqual({ kind: 'session', provider: 'claude', sessionId: 'sess-1' })
    expect(content.namingHandle).toBe('h1')
    const sessionOwned = parsed!.tabs.tabs.find((t) => t.id === 't1')!
    expect(sessionOwned.title).toBe('Old Tab Title')
    expect(sessionOwned.titleSetByUser).toBeUndefined()
    expect(sessionOwned.nameSource).toEqual({ kind: 'session', paneId: 'p1' })
    const legacy = parsed!.tabs.tabs.find((t) => t.id === 't2')!
    expect(legacy.titleSetByUser).toBe(true)
  })
})

// ── capture-source taxonomy ──────────────────────────────────────────────────

describe('capture-source key taxonomy', () => {
  it('accepts the supported raw sources and rejects everything else', () => {
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3.bak')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3.window-a')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3.window-a.bak')).toBe(true)
    expect(isLegacyNameCaptureSourceKey(`${LAYOUT_STORAGE_KEY_PREFIX}.window-a.backup-before-fresh-agent-centralization`)).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.pre-migration-raw.v1.window-a')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.tabs.v2')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.panes.v2')).toBe(true)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3.window-a.fresh-agent-centralization-commit')).toBe(false)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.v3.window-a.fresh-agent-centralization-pending')).toBe(false)
    expect(isLegacyNameCaptureSourceKey('freshell.session-names.migration.v1.abc')).toBe(false)
    expect(isLegacyNameCaptureSourceKey('freshell.browser-preferences.v1')).toBe(false)
    expect(isLegacyNameCaptureSourceKey('freshell.layout.legacy-adopted.v1')).toBe(false)
  })
})
