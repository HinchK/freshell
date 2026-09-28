import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, {
  addTab,
  hydrateTabs,
  removeTab,
  setTabNameSource,
  type Tab,
} from '@/store/tabsSlice'
import panesReducer, {
  initLayout,
  splitPane,
  addPane,
  closePane,
  swapPanes,
  setActivePane,
  markPaneClosing,
  clearPaneClosing,
  updatePaneContent,
  removeLayout,
  mergePaneContent,
  restoreLayout,
  hydratePanes,
} from '@/store/panesSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import { sessionNameLifecycleMiddleware } from '@/store/sessionNameLifecycleMiddleware'
import {
  selectTabDisplayName,
  selectTabNameSourcePaneId,
} from '@/store/selectors/sessionNameSelectors'
import type { SessionNameUpdate, SessionNameRef } from '@shared/session-names'
import type { RootState } from '@/store/store'
import type { PaneContent } from '@/store/paneTypes'

// Unified agent names (Task 6): the stable-tab-ownership lifecycle. The plan's
// "Stable tab ownership" section is the contract under test — a session-owned
// tab keeps ONE stable source pane across focus, activity, split/add, swaps
// (the pointer follows CONTENT identity, only when the swap actually
// landed), refused swap/close (the pointer never moves), source loss (the
// deterministic first remaining scoped leaf takes over once), and the
// initial-content-choice resolution (scoped ⇒ session; real non-agent ⇒
// legacy; a picker stays unresolved until its first actual content).

function agentTerminal(sessionId: string, createRequestId: string): PaneContent {
  return {
    kind: 'terminal',
    mode: 'claude',
    createRequestId,
    status: 'creating',
    sessionRef: { provider: 'claude', sessionId },
  } as PaneContent
}

function browserContent(): PaneContent {
  return { kind: 'browser', browserInstanceId: 'b-1', url: 'https://example.com', devToolsOpen: false }
}

function editorContent(): PaneContent {
  return {
    kind: 'editor',
    filePath: '/tmp/a.ts',
    language: 'typescript',
    readOnly: false,
    content: '',
    viewMode: 'source',
    wordWrap: true,
  }
}

function shellTerminal(): PaneContent {
  return { kind: 'terminal', mode: 'shell', createRequestId: 'crid-shell', status: 'creating' } as PaneContent
}

function pickerContent(): PaneContent {
  return { kind: 'picker' }
}

function nameUpdate(ref: SessionNameRef, name: string, revision: number): SessionNameUpdate {
  return {
    record: {
      ref,
      name,
      source: 'manual',
      revision,
    },
    documentGeneration: revision,
    redirects: [],
    changed: true,
  }
}

function buildStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessionNames: sessionNamesReducer,
      tabRegistry: tabRegistryReducer,
    },
    middleware: (getDefault) => getDefault().concat(sessionNameLifecycleMiddleware),
  })
}

type Store = ReturnType<typeof buildStore>

function tabOf(store: Store, tabId: string): Tab | undefined {
  return store.getState().tabs.tabs.find((t) => t.id === tabId)
}

function display(store: Store, tabId: string): string {
  return selectTabDisplayName(store.getState() as unknown as RootState, tabId)
}

const REF_A: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-a' }
const REF_B: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-b' }
const REF_A2: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-a-2' }

/** Create a tab whose original pane is scoped agent A at pane `p-a`. */
function createAgentTab(store: Store, tabId = 'tab-1') {
  store.dispatch(addTab({ id: tabId, title: 'Original' }))
  store.dispatch(initLayout({
    tabId,
    paneId: 'p-a',
    content: agentTerminal('sess-a', 'crid-a'),
  }))
  return tabId
}

describe('sessionNameLifecycleMiddleware — stable tab ownership', () => {
  it('a session-owned tab displays its ORIGINAL pane name across a later split, focus, and activity', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    // Split agent B in, focus it, and send activity its way.
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    store.dispatch(setActivePane({ tabId, paneId: 'p-b' }))

    // Rename through the canonical authority: only A's record exists.
    store.dispatch(receiveSessionNames([nameUpdate(REF_A, 'Alpha from A', 3)]))

    // A tab rename resolves the SOURCE pane (the original pane A), so the
    // tab display is A's canonical name — B never stole ownership by being
    // focused/active/most-recent.
    expect(display(store, tabId)).toBe('Alpha from A')
  })

  it('persists the source pointer on the tab and never moves it for focus, activity, or splits', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    store.dispatch(setActivePane({ tabId, paneId: 'p-b' }))
    store.dispatch(addPane({ tabId, newContent: browserContent() }))

    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })
    // The pointer resolves A, not the focused B.
    expect(selectTabNameSourcePaneId(store.getState() as unknown as RootState, tabId)).toBe('p-a')
  })

  it('swapPanes moves the pointer to the pane id that now holds the source content', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))

    // Swap A's and B's payloads at the fixed pane ids.
    store.dispatch(swapPanes({ tabId, paneId: 'p-a', otherId: 'p-b' }))

    // The source FOLLOWS A's content to its new pane id.
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })
    store.dispatch(receiveSessionNames([nameUpdate(REF_A, 'Alpha from A', 3)]))
    expect(display(store, tabId)).toBe('Alpha from A')
  })

  it('a REFUSED swap (pending close) never moves the pointer', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })

    // The pending-close guard refuses the identity-changing swap wholesale.
    store.dispatch(markPaneClosing({ tabId, paneId: 'p-a' }))
    store.dispatch(swapPanes({ tabId, paneId: 'p-a', otherId: 'p-b' }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })
    store.dispatch(clearPaneClosing({ tabId, paneId: 'p-a' }))

    // The same swap lands once the freeze lifts, and only then follows.
    store.dispatch(swapPanes({ tabId, paneId: 'p-a', otherId: 'p-b' }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })
  })

  it('closing the source picks the first remaining scoped leaf ONCE; no scoped leaf falls back to legacy', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))

    store.dispatch(closePane({ tabId, paneId: 'p-a' }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })

    // The deterministic successor is stable: focus/activity on the survivor
    // cannot re-derive it.
    store.dispatch(setActivePane({ tabId, paneId: 'p-b' }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })

    // With no scoped leaf left (the survivor replaced by a browser pane),
    // the tab returns to the legacy derivation.
    store.dispatch(updatePaneContent({ tabId, paneId: 'p-b', content: browserContent() }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'legacy' })
  })

  it('a same-pane conversation switch keeps the source on the logical pane and reads the new binding', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)

    // The conversation in pane p-a switches to a new durable session.
    store.dispatch(updatePaneContent({
      tabId,
      paneId: 'p-a',
      content: { ...agentTerminal('sess-a-2', 'crid-a'), createRequestId: 'crid-a' },
    }))

    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })
    store.dispatch(receiveSessionNames([nameUpdate(REF_A2, 'Second conversation', 5)]))
    expect(display(store, tabId)).toBe('Second conversation')
    // The old conversation's name never leaks into the tab.
    store.dispatch(receiveSessionNames([nameUpdate(REF_A, 'Alpha from A', 3)]))
    expect(display(store, tabId)).toBe('Second conversation')
  })

  it('replacing the source content with a non-agent follows the removal rule', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))

    // The source pane becomes a browser pane: the next scoped leaf takes over.
    store.dispatch(updatePaneContent({ tabId, paneId: 'p-a', content: browserContent() }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })

    // With no scoped leaf left, legacy derivation owns the tab.
    store.dispatch(updatePaneContent({ tabId, paneId: 'p-b', content: browserContent() }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'legacy' })
  })

  it('an explicit setTabNameSource is authoritative and survives unrelated layout churn', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    // An explicit caller (copy/recovery) pinned the pointer; churn respects it.
    store.dispatch(setTabNameSource({ tabId, nameSource: { kind: 'session', paneId: 'p-b' } }))
    store.dispatch(setActivePane({ tabId, paneId: 'p-a' }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })
  })

  it('setTabNameSource on a missing tab is a logged no-op', () => {
    const store = buildStore()
    store.dispatch(setTabNameSource({ tabId: 'nope', nameSource: { kind: 'legacy' } }))
    expect(store.getState().tabs.tabs).toHaveLength(0)
  })

  it('losing the whole layout returns a still-existing tab to legacy', () => {
    const store = buildStore()
    const tabId = createAgentTab(store)
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })
    store.dispatch(removeLayout({ tabId }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'legacy' })
    // Removing the tab itself is not a pointer transition.
    store.dispatch(removeTab(tabId))
    expect(store.getState().tabs.tabs).toHaveLength(0)
  })
})

describe('sessionNameLifecycleMiddleware — initial content choice resolves ownership once', () => {
  it.each([
    ['a scoped agent pane', () => agentTerminal('sess-a', 'crid-a'), { kind: 'session', paneId: 'p-1' }],
    ['a shell pane', () => shellTerminal(), { kind: 'legacy' }],
    ['a browser pane', () => browserContent(), { kind: 'legacy' }],
    ['an editor pane', () => editorContent(), { kind: 'legacy' }],
  ])('%s names the tab', (_label, content, expected) => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-init' }))
    store.dispatch(initLayout({ tabId: 't-init', paneId: 'p-1', content: content() }))
    expect(tabOf(store, 't-init')?.nameSource).toEqual(expected)
  })

  it('an initial picker stays unresolved until its first actual content choice', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-picker' }))
    store.dispatch(initLayout({ tabId: 't-picker', paneId: 'p-1', content: pickerContent() }))
    expect(tabOf(store, 't-picker')?.nameSource).toBeUndefined()

    // Choosing the first SCOPED agent is original-pane ownership.
    store.dispatch(updatePaneContent({
      tabId: 't-picker',
      paneId: 'p-1',
      content: agentTerminal('sess-a', 'crid-a'),
    }))
    expect(tabOf(store, 't-picker')?.nameSource).toEqual({ kind: 'session', paneId: 'p-1' })

    // A later agent split does not move the pointer.
    store.dispatch(splitPane({
      tabId: 't-picker',
      paneId: 'p-1',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-2',
    }))
    expect(tabOf(store, 't-picker')?.nameSource).toEqual({ kind: 'session', paneId: 'p-1' })
  })

  it('a picker replaced by a shell resolves legacy, and a later agent never flips it', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-legacy' }))
    store.dispatch(initLayout({ tabId: 't-legacy', paneId: 'p-1', content: pickerContent() }))
    store.dispatch(updatePaneContent({
      tabId: 't-legacy',
      paneId: 'p-1',
      content: shellTerminal(),
    }))
    expect(tabOf(store, 't-legacy')?.nameSource).toEqual({ kind: 'legacy' })

    store.dispatch(splitPane({
      tabId: 't-legacy',
      paneId: 'p-1',
      direction: 'horizontal',
      newContent: agentTerminal('sess-b', 'crid-b'),
      newPaneId: 'p-2',
    }))
    expect(tabOf(store, 't-legacy')?.nameSource).toEqual({ kind: 'legacy' })
  })

  it('a legacy shell tab that gains an agent keeps its existing naming behavior', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-shell-first' }))
    store.dispatch(initLayout({ tabId: 't-shell-first', paneId: 'p-shell', content: shellTerminal() }))
    expect(tabOf(store, 't-shell-first')?.nameSource).toEqual({ kind: 'legacy' })
    store.dispatch(splitPane({
      tabId: 't-shell-first',
      paneId: 'p-shell',
      direction: 'horizontal',
      newContent: agentTerminal('sess-a', 'crid-a'),
      newPaneId: 'p-agent',
    }))
    expect(tabOf(store, 't-shell-first')?.nameSource).toEqual({ kind: 'legacy' })
    expect(selectTabNameSourcePaneId(store.getState() as unknown as RootState, 't-shell-first')).toBeNull()
  })
})

describe('sessionNameLifecycleMiddleware — naming identity survives store folds', () => {
  it('hydratePanes keeps pane-level naming identity through the cold-adoption normalize', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-hydrate' }))
    store.dispatch(initLayout({
      tabId: 't-hydrate',
      paneId: 'p-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        createRequestId: 'crid-h',
        status: 'creating',
        sessionRef: { provider: 'claude', sessionId: 'sess-h' },
        namingHandle: 'nh-hydrate-1',
        nameRef: { kind: 'pending', id: 'nh-hydrate-1' },
      } as PaneContent,
    }))

    const content = (store.getState().panes.layouts['t-hydrate'] as { content: PaneContent }).content
    expect(content).toMatchObject({
      namingHandle: 'nh-hydrate-1',
      nameRef: { kind: 'pending', id: 'nh-hydrate-1' },
    })

    // And through a content update merge (the updateContent shape TerminalView
    // dispatches on terminal.created).
    store.dispatch(mergePaneContent({ tabId: 't-hydrate', paneId: 'p-1', updates: { status: 'running', terminalId: 'tid-9' } }))
    const merged = (store.getState().panes.layouts['t-hydrate'] as { content: PaneContent }).content
    expect(merged).toMatchObject({
      namingHandle: 'nh-hydrate-1',
      nameRef: { kind: 'pending', id: 'nh-hydrate-1' },
      terminalId: 'tid-9',
    })
  })

  it('a restored layout keeps the naming handle even when transient runtime ids are stripped', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 't-restore' }))
    store.dispatch(restoreLayout({
      tabId: 't-restore',
      layout: {
        type: 'leaf',
        id: 'p-r',
        content: {
          kind: 'terminal',
          mode: 'claude',
          createRequestId: 'crid-r',
          status: 'creating',
          sessionRef: { provider: 'claude', sessionId: 'sess-r' },
          namingHandle: 'nh-restore-1',
          // Transient runtime id: restoreLayout's stripStaleIds removes it; the
          // handle must survive the strip.
          terminalId: 'stale-terminal',
        },
      },
      paneTitles: {},
    }))
    const content = (store.getState().panes.layouts['t-restore'] as { content: PaneContent }).content
    expect(content).toMatchObject({ namingHandle: 'nh-restore-1' })
    expect((content as { terminalId?: string }).terminalId).toBeUndefined()
  })
})

describe('sessionNameLifecycleMiddleware — hydrate-delivered swaps', () => {
  // The own-key full hydrate (crossTabSync.dispatchHydrateLayoutFromPersisted)
  // is TWO folds: hydrateTabs adopts the envelope's tabs (pointer included),
  // then hydratePanes applies the envelope's layout. A pane whose identity has
  // not bound a durable session yet (pending naming handle, no sessionRef,
  // status past 'creating') takes the incoming payload, so a swap delivered
  // by the envelope really lands in the layout.
  function pendingAgentTerminal(handle: string, createRequestId: string): PaneContent {
    return {
      kind: 'terminal',
      mode: 'claude',
      createRequestId,
      status: 'running',
      namingHandle: handle,
      nameRef: { kind: 'pending', id: handle },
    } as PaneContent
  }

  /** Tab with A (nh-a) at p-a plus B (nh-b) split in at p-b; pointer p-a. */
  function createPendingAgentTab(store: Store, tabId = 'tab-1') {
    store.dispatch(addTab({ id: tabId, title: 'Original' }))
    store.dispatch(initLayout({
      tabId,
      paneId: 'p-a',
      content: pendingAgentTerminal('nh-a', 'crid-a'),
    }))
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: pendingAgentTerminal('nh-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    return tabId
  }

  /** The envelope of a window that swapped A↔B and reconciled p-a→p-b. */
  function swappedEnvelope(store: Store, tabId: string): { tab: Tab; layouts: Record<string, unknown> } {
    const tab = { ...(tabOf(store, tabId) as Tab), nameSource: { kind: 'session', paneId: 'p-b' } as Tab['nameSource'] }
    const layouts = {
      [tabId]: {
        type: 'split',
        id: 'split-h',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'p-a', content: pendingAgentTerminal('nh-b', 'crid-b') },
          { type: 'leaf', id: 'p-b', content: pendingAgentTerminal('nh-a', 'crid-a') },
        ],
      },
    }
    return { tab, layouts }
  }

  function dispatchFullHydrate(
    store: Store,
    tabId: string,
    meta: { localLayoutPersistedAt: number; remoteLayoutPersistedAt: number },
  ) {
    const { tab, layouts } = swappedEnvelope(store, tabId)
    store.dispatch({
      ...hydrateTabs({
        tabs: [tab],
        activeTabId: tabId,
        renameRequestTabId: null,
        tombstones: [],
      } as never),
      meta,
    })
    store.dispatch({
      ...hydratePanes({
        layouts,
        activePane: { [tabId]: 'p-b' },
        paneTitles: {},
        paneTitleSetByUser: {},
      } as never),
      meta,
    })
  }

  it('a hydrate-delivered swap (remote wins recency) keeps the ALREADY-CORRECT delivered pointer', () => {
    const store = buildStore()
    const tabId = createPendingAgentTab(store)
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })

    // The envelope is newer: hydrateTabs adopts its reconciled pointer p-b,
    // hydratePanes applies its swapped layout (A now at p-b, B at p-a).
    dispatchFullHydrate(store, tabId, { localLayoutPersistedAt: 1_000, remoteLayoutPersistedAt: 2_000 })

    // p-b IS the correct pointer for the delivered layout — A, the original
    // source content, lives there now. The middleware must not read the
    // delivered pointer against the STALE pre-hydrate layout and flip the
    // tab to p-a (which now holds B).
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })

    store.dispatch(receiveSessionNames([
      nameUpdate({ kind: 'pending', id: 'nh-a' }, 'Alpha from A', 3),
      nameUpdate({ kind: 'pending', id: 'nh-b' }, 'Beta from B', 4),
    ]))
    expect(display(store, tabId)).toBe('Alpha from A')
  })

  it('a hydrate-delivered swap keeps a pointer delivered over a LEGACY local pointer (no session origin to follow)', () => {
    const store = buildStore()
    // A shell-first tab: the initial content choice resolved it legacy.
    const tabId = 'tab-1'
    store.dispatch(addTab({ id: tabId, title: 'Original' }))
    store.dispatch(initLayout({
      tabId,
      paneId: 'p-a',
      content: { kind: 'terminal', mode: 'shell', createRequestId: 'crid-shell', status: 'running' } as PaneContent,
    }))
    store.dispatch(splitPane({
      tabId,
      paneId: 'p-a',
      direction: 'horizontal',
      newContent: pendingAgentTerminal('nh-b', 'crid-b'),
      newPaneId: 'p-b',
    }))
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'legacy' })

    // The envelope (remote wins recency) carries session ownership at p-b
    // plus the swapped layout; the delivered pointer must stand, not be
    // flipped to p-a (which now holds B).
    dispatchFullHydrate(store, tabId, { localLayoutPersistedAt: 1_000, remoteLayoutPersistedAt: 2_000 })

    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })
    store.dispatch(receiveSessionNames([
      nameUpdate({ kind: 'pending', id: 'nh-a' }, 'Alpha from A', 3),
      nameUpdate({ kind: 'pending', id: 'nh-b' }, 'Beta from B', 4),
    ]))
    expect(display(store, tabId)).toBe('Alpha from A')
  })

  it('the local-wins recency variant still FOLLOWS a carried pointer through a delivered swap (old-mirror shape)', () => {
    const store = buildStore()
    const tabId = createPendingAgentTab(store)
    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-a' })

    // The local tab wins recency, so hydrateTabs keeps the local pointer
    // p-a; the envelope's swapped layout still applies — this is the
    // pre-Task-6 old-mirror shape, and the pointer must follow A's content
    // to p-b exactly like a live swap.
    dispatchFullHydrate(store, tabId, { localLayoutPersistedAt: 2_000, remoteLayoutPersistedAt: 1_000 })

    expect(tabOf(store, tabId)?.nameSource).toEqual({ kind: 'session', paneId: 'p-b' })
    store.dispatch(receiveSessionNames([
      nameUpdate({ kind: 'pending', id: 'nh-a' }, 'Alpha from A', 3),
      nameUpdate({ kind: 'pending', id: 'nh-b' }, 'Beta from B', 4),
    ]))
    expect(display(store, tabId)).toBe('Alpha from A')
  })
})
