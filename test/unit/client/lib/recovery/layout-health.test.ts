import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillPersistedLayoutMachineId, classifyPersistedLayoutHealth, STALE_LAYOUT_MS } from '@/lib/recovery/layout-health'
import { MACHINE_ID_STORAGE_KEY } from '@/store/storage-keys'
import {
  hashPersistedLayoutRaw,
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_MIGRATION_ID,
} from '@/store/persistedState'

const NOW = 1_760_000_000_000
const VALID_CLAUDE_SESSION_ID = '11111111-2222-4333-8444-555555555555'

// Delta round 3, finding 1 (e3r1 finding 3 correction): the layout envelope
// and the pre-migration evidence sidecar are per-window keys derived from
// the IMMUTABLE layout-window-id (sessionStorage
// freshell.layout-window-id.v1). Every seeding site in this file targets
// THIS window's keys.
const WINDOW_ID = 'client-health-tests'
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`
const LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY = `freshell.layout.pre-migration-raw.v1.${WINDOW_ID}`

function seedWindow(): void {
  sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
}

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
  beforeEach(() => { localStorage.clear(); seedWindow() })

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

  it('treats an UNARMED unstamped (legacy) envelope as healthy — never foreign — so a natural reload keeps the layout', () => {
    // MERGED (Choice B + #774): this is the unarmed natural-reload lane. The
    // pre-merge comment framed it as the same-machine chooser re-pick, but
    // #774's pick handler now ARMS the one-shot active-selection marker on
    // every chooser pick, so the re-pick boot peeks it and classifies with
    // activeSelection:true (the armed-unstamped keep pin below); the unarmed
    // unstamped case is the ordinary reload of a remembered selection, whose
    // layout is this machine's newest truth and must be KEPT.
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('keeps an otherwise-healthy UNSTAMPED envelope under an armed active-selection marker — a same-machine chooser re-pick keeps the legacy layout (delta r4)', () => {
    // DELTA r4 (review finding 1): this pin previously codified 'foreign'
    // for the armed + unstamped + healthy-content lane — the merged-rule
    // resolution of the #774 conflict — which contradicted the ACCEPTED
    // REQUIREMENT that a chooser re-pick of the SAME machine keep a
    // healthy local layout (no forced server resync; the rebuild discards
    // the exact split arrangement and pane labels). An unstamped envelope
    // cannot PROVE machine ownership either way, so the armed marker alone
    // must not demote a healthy layout: it keeps, and the boot's healthy
    // backfill stamps it, so the next boot classifies unambiguously.
    // Accepted residual: because ownership is unprovable, a DIFFERENT
    // machine's pick during the legacy-to-stamped transition also keeps
    // the local layout — pre-upgrade-consistent (unstamped was never
    // foreign before stamps existed) and bounded to the transition: the
    // keep's backfill stamp ends the window and full foreign detection
    // resumes on the next boot.
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW, activeSelection: true })).toBe('healthy')
  })

  it('keeps a STAMPED same-machine healthy layout under an armed active-selection marker — Choice B wins the #774 boot-gate conflict', () => {
    // MERGED SEMANTICS (red-first pin): an armed marker alone must NOT
    // demote a provably-own healthy layout — the stamp is the stronger,
    // durable origin proof. The pick handler arms the marker on EVERY
    // chooser pick (#774), including a same-machine re-pick whose layout
    // is stamped-healthy; Choice B window sovereignty keeps it. Delta r4
    // extends the same keep to the UNSTAMPED legacy case (the pin above):
    // the armed marker never demotes a healthy layout — foreignness
    // requires the stamp's positive proof (a stamp naming another
    // machine).
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    seedEnvelope(healthyEnvelope('machine-1'))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW, activeSelection: true })).toBe('healthy')
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

  // Content lifecycle invariants (delta review round 3, finding 3):
  // isWellFormedPaneTree only checks createRequestId/status/mode are
  // STRINGS — empty createRequestIds, duplicate createRequestIds across
  // panes, unsupported status values, and empty modes all passed, so the
  // loader installed such content and the server later rejected the creates
  // (TerminalCreateSchema requires requestId min(1),
  // shared/ws-protocol.ts:468) or deduped duplicate request ids onto ONE
  // terminal (the single-flight create-dedupe, crates/freshell-ws/src/
  // terminal.rs:2884-2933: a create whose createRequestId already has a
  // live terminal ADOPTS it — both panes would alias onto one PTY), or the
  // loader silently minted a fresh shell/default identity
  // (persistMiddleware.ts migratePaneContent: createRequestId || nanoid(),
  // status || 'creating', mode || 'shell'). None of those are recoveries —
  // the envelope is corrupt and the own-snapshot rebuild must run.
  it('returns corrupt when a terminal pane content carries an EMPTY createRequestId (the loader would silently mint a fresh terminal identity)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: 'shell', createRequestId: '', status: 'running' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when two terminal panes share one createRequestId (the server dedupe would alias both panes onto ONE terminal)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-dup', status: 'running' } },
          { type: 'leaf', id: 'pane-b', content: { kind: 'terminal', mode: 'claude', createRequestId: 'cr-dup', status: 'running' } },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a terminal pane status is not a TerminalStatus union member (the loader installs it verbatim)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-a', status: 'bogus-status' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a terminal pane mode is an empty string (a mode-wiped CLI pane would silently reopen as a shell)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: '', createRequestId: 'cr-a', status: 'running' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('stays healthy when terminal panes carry distinct non-empty createRequestIds, union-member statuses, and non-empty modes', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-1', status: 'running' } },
          { type: 'leaf', id: 'pane-b', content: { kind: 'terminal', mode: 'claude', createRequestId: 'cr-2', status: 'creating' } },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  // e3r4 finding 2: the lifecycle invariants must also cover FRESH-AGENT
  // panes and the terminal shell. isWellFormedPaneTree only checks
  // strings, so a fresh-agent pane with an EMPTY or envelope-wide
  // DUPLICATE createRequestId or a status outside the client
  // SdkSessionStatus union passed string-only tree validation and
  // classified healthy — an empty id violates FreshAgentCreateSchema
  // (requestId z.string().min(1), shared/ws-protocol.ts:757), a
  // duplicate aliases the request-keyed pending-create routing, and a
  // bogus status without a session identity prevents FreshAgentView
  // from ever sending a create. A terminal shell outside ShellSchema
  // (shared/ws-protocol.ts:45) likewise survived loading verbatim
  // (normalizePaneContent keeps any string shell, panesSlice.ts:78) and
  // was sent in a rejected terminal.create. The fresh-agent pane's
  // "mode" fields (sessionType + provider) are already pinned by the
  // tree-level isPaneContentShape check the classifier runs first, so
  // the lifecycle layer adds the id and status invariants.
  it('returns corrupt when a fresh-agent pane content carries an EMPTY createRequestId (violates FreshAgentCreateSchema; the loader would mint a fresh identity)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: '', status: 'idle' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when two fresh-agent panes share one createRequestId (request-keyed pending-create routing would alias both panes)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-fa',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'cr-fa-dup', status: 'idle' } },
          { type: 'leaf', id: 'pane-b', content: { kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', createRequestId: 'cr-fa-dup', status: 'running' } },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a terminal pane and a fresh-agent pane share one createRequestId (both kinds mint from the same nanoid space — legit flushes never alias)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-mixed',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-shared', status: 'running' } },
          { type: 'leaf', id: 'pane-b', content: { kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode', createRequestId: 'cr-shared', status: 'idle' } },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a fresh-agent pane status is outside the SdkSessionStatus union (a bogus status without a session identity never sends a create)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'cr-fa', status: 'zombie-status' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a terminal pane shell is a nonempty value outside ShellSchema (survives loading verbatim and is sent in a rejected terminal.create)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-a', status: 'running', shell: 'fish' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('stays healthy when a terminal pane OMITS shell (absent = the loader\u2019s system default = healthy)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-a', status: 'running' },
      },
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('stays healthy for a valid fresh-agent pane (non-empty id, union-member status) alongside a terminal pane with a valid shell', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {
      'tab-a': {
        type: 'split',
        id: 'split-ok',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-term', status: 'running' } },
          { type: 'leaf', id: 'pane-b', content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'cr-fa', status: 'idle' } },
        ],
      },
    }
    ;(envelope.panes as { activePane: Record<string, string> }).activePane['tab-a'] = 'pane-a'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
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

// Delta r5 finding 1: present-but-malformed top-level envelope metadata
// (a machineId that is not a string, or a persistedAt that is not a
// number) is CORRUPTION, distinct from legitimate ABSENCE. The parse used
// to coerce both to undefined (persistedState.ts), so a corrupt envelope
// classified as unstamped legacy — healthy — and the healthy boot's stamp
// backfill then relabeled a corrupted layout from machine A as machine B,
// published onward by tab sync. The boot migration compounds it: its
// rewrite DROPS a malformed machineId and REPLACES a malformed persistedAt
// with a fresh Date.now() (storage-migration.ts migratePersistedLayout),
// so post-rewrite the sanitized current raw looks healthy and only the
// pre-migration evidence sidecar still shows the malformed value.
describe('malformed envelope metadata classifies corrupt — never silently coerced to legacy absence (delta r5 finding 1)', () => {
  beforeEach(() => { localStorage.clear(); seedWindow() })

  it('returns corrupt when machineId is present but not a string (direct parse path)', () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.machineId = 123
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when persistedAt is present but not a number (direct parse path)', () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.persistedAt = 'recently'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('stays healthy when machineId is absent while persistedAt is valid (legacy machine-id absence — direct parse path)', () => {
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('never classifies ABSENCE corrupt: an absent persistedAt keeps the pre-existing epoch fallback (stale, not corrupt — direct parse path)', () => {
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    delete envelope.persistedAt
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('stale')
  })

  it('classifies corrupt through the pre-migration evidence when the migration dropped a malformed machineId (the sanitized current raw must not slide through as healthy legacy)', () => {
    // The realistic post-rewrite shape: the migration's JSON.stringify
    // omits the undefined machineId, so the current raw is unstamped and
    // otherwise healthy — only the evidence sidecar still carries the
    // malformed stamp.
    const current = healthyEnvelope('machine-1')
    delete current.machineId
    seedEnvelope(current)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
    const original = healthyEnvelope('machine-1')
    original.machineId = 123
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, JSON.stringify(original))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
    localStorage.removeItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('classifies corrupt through the pre-migration evidence when the migration replaced a malformed persistedAt with a fresh stamp', () => {
    const current = healthyEnvelope('machine-1')
    seedEnvelope(current)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
    const original = healthyEnvelope('machine-1')
    original.persistedAt = 'recently'
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, JSON.stringify(original))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('stays healthy when the evidence envelope legitimately lacks both metadata keys (legacy absence in evidence is not corruption)', () => {
    const current = healthyEnvelope('machine-1')
    seedEnvelope(current)
    const original = healthyEnvelope('machine-1')
    delete original.machineId
    delete original.persistedAt
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, JSON.stringify(original))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('stays healthy when the evidence envelope carries valid metadata values (a string machineId and a number persistedAt)', () => {
    const current = healthyEnvelope('machine-1')
    seedEnvelope(current)
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, JSON.stringify(healthyEnvelope('machine-1')))
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
  beforeEach(() => { localStorage.clear(); seedWindow() })

  async function classifyAfterRealBoot(): Promise<PersistedLayoutHealthAfterBoot> {
    localStorage.setItem('freshell_version', '5')
    // The real boot re-runs the self-executing storage migration, whose
    // stale-envelope prune sweep (e3r1 finding 5) uses the REAL clock —
    // freeze it to this file's fixture NOW so the just-persisted envelopes
    // are not beyond-threshold. Classification below still uses opts.now.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      vi.resetModules()
      await import('@/store/storage-migration')
      const { classifyPersistedLayoutHealth: classify } = await import('@/lib/recovery/layout-health')
      return { classify: (machineId: string) => classify(machineId, { now: NOW }) }
    } finally {
      vi.useRealTimers()
    }
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
    // Delta round 3, finding 1: the marker STORAGE key is this window's
    // per-window channel suffix; the marker PAYLOAD's backupKey field stays
    // the migration-identifier constant.
    localStorage.setItem(`${LAYOUT_STORAGE_KEY}.fresh-agent-centralization-commit`, JSON.stringify({
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

  // Delta r5 finding 1 through the REAL boot order: the migration rewrite
  // drops a malformed machineId (JSON.stringify omits undefined) and
  // replaces a malformed persistedAt with Date.now(), so the sanitized
  // current raw alone looks like healthy legacy data — only the evidence
  // sidecar the rewrite mirrors can keep the malformed class corrupt.
  it('classifies corrupt when the boot migration dropped a malformed machineId stamp (the sanitized envelope must not slide through as healthy legacy)', async () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.machineId = 123
    seedEnvelope(envelope)
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('corrupt')
  })

  it('classifies corrupt when the boot migration replaced a malformed persistedAt with a fresh stamp', async () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.persistedAt = 'recently'
    seedEnvelope(envelope)
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('corrupt')
  })

  it('boots an unstamped, persistedAt-less legacy envelope healthy through the real order (the migration supplies the stamp; absence is never corruption)', async () => {
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    delete envelope.persistedAt
    seedEnvelope(envelope)
    const { classify } = await classifyAfterRealBoot()
    expect(classify('machine-1')).toBe('healthy')
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

    // The rebuild SUCCEEDS (e2r5 finding 1): the old step deleted the
    // sidecar WITHOUT persisting anything and mislabeled the
    // still-sanitized old envelope as rebuilt — a reload inside the
    // 500ms persist debounce (or a failed layout write, whose dirty
    // flags clear anyway, persistMiddleware.ts:696-704) left the old
    // envelope durable with the evidence gone, so the next boot
    // classified it healthy and permanently skipped the required
    // rebuild. The gate now ARMS the clear; a real store + the real
    // persist middleware play the rebuild's dispatches; the forced
    // flush (standing in for the rebuild's own debounced flush — the
    // real gate forces nothing, to keep the rebuild's persistence ONE
    // write) durably writes the rebuilt envelope, and only that
    // successful write consumes the armed clear.
    const boot2Module = await import('@/lib/recovery/layout-health')
    boot2Module.armPreMigrationEvidenceClear()
    const { configureStore } = await import('@reduxjs/toolkit')
    const { default: rebuiltTabsReducer, addTab } = await import('@/store/tabsSlice')
    const { panesSlice, initLayout } = await import('@/store/panesSlice')
    const { persistMiddleware } = await import('@/store/persistMiddleware')
    const { flushPersistedLayoutNow } = await import('@/store/persistControl')
    const rebuiltStore = configureStore({
      reducer: { tabs: rebuiltTabsReducer, panes: panesSlice.reducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware),
    })
    // The rebuilt pane re-attaches the durable session identity whose
    // invalid value the sanitized old envelope lost.
    rebuiltStore.dispatch(addTab({ id: 'tab-rebuilt', title: 'Rebuilt' }))
    rebuiltStore.dispatch(initLayout({
      tabId: 'tab-rebuilt',
      paneId: 'pane-rebuilt',
      content: {
        kind: 'terminal', mode: 'claude', createRequestId: 'cr-rebuilt', status: 'running',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      },
    }))
    // Reload BEFORE the flush: the evidence must still be intact — the
    // rebuilt envelope exists only in Redux, the old sanitized envelope
    // is still the durable state, and the next boot must still classify
    // corrupt and rebuild again.
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe(corruptRaw)
    rebuiltStore.dispatch(flushPersistedLayoutNow())
    // The flush durably wrote the rebuilt envelope; only now may the
    // armed clear retire the evidence.
    const rebuiltRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)!
    expect(JSON.parse(rebuiltRaw).panes.layouts['tab-rebuilt'].content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
    })
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()

    // ...and the next boot classifies the rebuilt envelope on its own raw.
    // (The next boot's forced rewrite re-mirrors the now-HEALTHY rebuilt
    // raw into the empty sidecar — by design: evidence of a healthy
    // state converges to no-drop on comparison — so classification, not
    // the sidecar's null-ness, is the assertion.)
    const boot3 = await classifyAfterRealBoot()
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

  // e3 post-cap finding 2: the migration-boot prune sweep deleted THIS
  // window's beyond-threshold envelope BEFORE the App classifier ran, so
  // a real stale boot was classified (and logged) 'absent' — the five-state
  // classification and the stale reason propagation were never exercised.
  // The sweep now spares the own key (still pruning OTHER windows'
  // abandoned keys), the classifier sees the stale envelope and the gate
  // rebuilds with reason 'stale', and only the COMPLETED decision runs the
  // deferred own-key prune.
  it('a stale own envelope SURVIVES the migration-boot sweep, classifies STALE (not absent), and is retired by the gate-time prune afterward (e3 post-cap finding 2)', async () => {
    const STALE_PERSISTED_AT = NOW - STALE_LAYOUT_MS - 1
    seedEnvelope(healthyEnvelope('machine-1', STALE_PERSISTED_AT))
    const OTHER_WINDOW_KEY = 'freshell.layout.v3.client-other-window'
    localStorage.setItem(OTHER_WINDOW_KEY, JSON.stringify(healthyEnvelope('machine-1', STALE_PERSISTED_AT)))

    const { classify } = await classifyAfterRealBoot()

    // The sweep's abandoned-key hygiene is intact: the OTHER window's
    // stale envelope was pruned at migration boot.
    expect(localStorage.getItem(OTHER_WINDOW_KEY)).toBeNull()
    // THIS window's stale envelope survived for the classifier (the
    // migration's rewrite preserves persistedAt).
    const ownRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(ownRaw).not.toBeNull()
    expect(JSON.parse(ownRaw!).persistedAt).toBe(STALE_PERSISTED_AT)
    // The classifier-then-prune ordering: the boot classifies STALE, not
    // absent — the reason the gate propagates to the rebuild.
    expect(classify('machine-1')).toBe('stale')

    // The decision completed: the gate's deferred own-key prune removes
    // the stale envelope (and its channels) afterward.
    const { pruneOwnStaleLayoutEnvelope } = await import('@/store/storage-migration')
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      pruneOwnStaleLayoutEnvelope()
    } finally {
      vi.useRealTimers()
    }
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
  })

  it('the gate-time own-key prune removes only a beyond-threshold envelope — a fresh own envelope survives it', async () => {
    seedEnvelope(healthyEnvelope('machine-1', NOW))
    await classifyAfterRealBoot()

    const { pruneOwnStaleLayoutEnvelope } = await import('@/store/storage-migration')
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      pruneOwnStaleLayoutEnvelope()
    } finally {
      vi.useRealTimers()
    }
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).not.toBeNull()
  })
})

// e2r5 review finding 1: the boot gate's evidence clear raced the persist
// debounce — clearing at the REDUX boundary stranded the sanitized old
// envelope in storage with the evidence DELETED when a reload landed inside
// the 500ms window or the flush's setItem failed (the flush clears its
// dirty flags even on failure, persistMiddleware.ts:696-704). The gate now
// ARMS the clear and the persist middleware consumes it ONLY on a
// successful layout write, so the evidence survives reloads-before-flush
// and failed writes; the next boot then still classifies corrupt and
// rebuilds again.
describe('pre-migration evidence durable boundary (e2r5 finding 1)', () => {
  beforeEach(() => { localStorage.clear(); seedWindow() })

  async function loadEvidenceModule() {
    const mod = await import('@/lib/recovery/layout-health')
    mod.resetPreMigrationEvidenceArmForTests()
    return mod
  }

  it('an armed consume clears the evidence and disarms; an un-armed consume is a no-op', async () => {
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, 'evidence')
    const mod = await loadEvidenceModule()
    // Not armed: consume never touches the evidence.
    mod.consumeArmedPreMigrationEvidenceClear()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe('evidence')
    mod.armPreMigrationEvidenceClear()
    mod.consumeArmedPreMigrationEvidenceClear()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()
    // Disarmed: a second consume can never clear FUTURE evidence.
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, 'evidence-2')
    mod.consumeArmedPreMigrationEvidenceClear()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe('evidence-2')
  })

  it('a failed evidence remove leaves the arm armed — a later consume retries the clear', async () => {
    localStorage.setItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, 'evidence')
    const mod = await loadEvidenceModule()
    mod.armPreMigrationEvidenceClear()
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      if (key === LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY) throw new Error('storage blocked')
    })
    try {
      mod.consumeArmedPreMigrationEvidenceClear()
      expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBe('evidence')
    } finally {
      removeItem.mockRestore()
    }
    mod.consumeArmedPreMigrationEvidenceClear()
    expect(localStorage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)).toBeNull()
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
  beforeEach(() => { localStorage.clear(); seedWindow() })

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
  beforeEach(() => { localStorage.clear(); seedWindow() })

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
  beforeEach(() => { localStorage.clear(); seedWindow() })

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
