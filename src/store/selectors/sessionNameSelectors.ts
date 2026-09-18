/**
 * Unified agent names (Task 5) — the ONLY scoped display rules.
 *
 * A scoped Claude/Codex/OpenCode pane (terminal modes claude/codex/opencode,
 * fresh types freshclaude/freshcodex/freshopencode) displays its session's
 * canonical saved name from the `sessionNames` cache; every legacy field
 * (paneTitles, paneTitleSetByUser, Tab.title, titleSetByUser, terminal
 * inventory strings) is a FALLBACK only and can never override a cached
 * canonical record. A session-owned tab resolves its stable source pane
 * (Tab.nameSource, with the single-scoped-leaf fallback until Task 6's
 * lifecycle plumbing persists the pointer) and reuses that pane's name.
 *
 * Out-of-scope panes/tabs (shell, browser, editor, kilroy, other providers)
 * keep the existing legacy derivations untouched.
 */
import { createSelector } from '@reduxjs/toolkit'
import { getPaneDisplayTitle } from '@/lib/pane-title'
import { getTabDisplayTitle } from '@/lib/tab-title'
import {
  isUnifiedAgentMode,
  sessionNameRefKey,
  type SessionNameRecord,
  type SessionNameRef,
} from '@shared/session-names'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'
import type { ClientExtensionEntry } from '@shared/extension-types'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

type SessionNamesCache = RootState['sessionNames']

/** Follow pending→durable redirects to the final ref key (chain-bounded). */
function resolveRefKey(cache: SessionNamesCache, ref: SessionNameRef): string {
  let key = sessionNameRefKey(ref)
  for (let hops = 0; hops < 8; hops += 1) {
    const redirect = cache.redirects?.[key]
    if (!redirect) break
    key = redirect.toKey
  }
  return key
}

/** The canonical record currently cached for a naming ref (redirect-resolved).
 * Guarded like its sibling selectors: a hand-built state lacking the slice
 * (or its maps) resolves to undefined instead of throwing. */
export function selectSessionNameRecord(state: RootState, ref: SessionNameRef): SessionNameRecord | undefined {
  const cache = state.sessionNames
  if (!cache?.records) return undefined
  return cache.records[resolveRefKey(cache, ref)]
}

/** The native writeback status cached for a naming ref (redirect-resolved). */
export function selectSessionNativeSync(
  state: RootState,
  ref: SessionNameRef,
): { status: string; reason?: string } | undefined {
  return state.sessionNames?.nativeSync?.[resolveRefKey(state.sessionNames, ref)]?.sync
}

function isNamedProvider(provider: string): provider is 'claude' | 'codex' | 'opencode' {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode'
}

/** The pane's naming identity: its explicit nameRef, its pre-durable naming
 * handle, or its durable session ref — in that order. */
export function resolvePaneNameRef(content: PaneContent): SessionNameRef | undefined {
  if (content.kind === 'terminal') {
    if (content.nameRef) return content.nameRef
    if (content.namingHandle) return { kind: 'pending', id: content.namingHandle }
    if (
      content.sessionRef
      && isNamedProvider(content.sessionRef.provider)
      && typeof content.sessionRef.sessionId === 'string'
      && content.sessionRef.sessionId.length > 0
    ) {
      return { kind: 'session', provider: content.sessionRef.provider, sessionId: content.sessionRef.sessionId }
    }
    return undefined
  }
  if (content.kind === 'fresh-agent') {
    if (content.nameRef) return content.nameRef
    if (content.namingHandle) return { kind: 'pending', id: content.namingHandle }
    if (
      content.sessionRef
      && isNamedProvider(content.sessionRef.provider)
      && typeof content.sessionRef.sessionId === 'string'
      && content.sessionRef.sessionId.length > 0
    ) {
      return { kind: 'session', provider: content.sessionRef.provider, sessionId: content.sessionRef.sessionId }
    }
    if (content.sessionId && isUnifiedAgentMode(undefined, content.sessionType) && isNamedProvider(content.provider)) {
      return { kind: 'session', provider: content.provider, sessionId: content.sessionId }
    }
    return undefined
  }
  return undefined
}

/** Is this pane content one of the six unified naming modes? (Kilroy — a
 * claude runtime with sessionType `kilroy` — is never scoped.) */
export function isScopedPaneContent(content: PaneContent): boolean {
  if (content.kind === 'terminal') {
    return isUnifiedAgentMode(content.mode, undefined)
  }
  if (content.kind === 'fresh-agent') {
    return isUnifiedAgentMode(content.provider, content.sessionType)
  }
  return false
}

/** A session row is scoped by provider + sessionType (fresh rows carry their
 * fresh sessionType; CLI rows carry the provider as their mode). */
export function isScopedSessionRow(provider: string | undefined, sessionType?: string): boolean {
  if (!provider) return false
  if (sessionType !== undefined && sessionType !== '') {
    return isUnifiedAgentMode(provider, sessionType)
  }
  return isUnifiedAgentMode(provider, undefined)
}

function paneExtensions(state: RootState): ClientExtensionEntry[] | undefined {
  const entries = state.extensions?.entries
  return Array.isArray(entries) && entries.length > 0 ? entries : undefined
}

/** The legacy stored-title rule (pane display): fresh-agent panes never
 * display a stored title equal to their provider label/identity. */
export function resolveStoredTitleForDisplay(
  content: PaneContent,
  storedTitle: string | undefined,
  setByUser: boolean | undefined,
): string | undefined {
  if (content.kind !== 'fresh-agent' || setByUser || !storedTitle) return storedTitle

  const normalizedStoredTitle = storedTitle.trim().toLowerCase()
  const legacyProviderTitle = getFreshAgentLabel(content.sessionType).trim().toLowerCase()
  const providerIdentity = content.sessionType.trim().toLowerCase()
  if (normalizedStoredTitle === legacyProviderTitle || normalizedStoredTitle === providerIdentity) {
    return undefined
  }

  return storedTitle
}

/** The pane's LEGACY display title (out-of-scope panes, and the immediate
 * safe fallback for scoped panes without a cached canonical record). */
export function selectPaneFallbackTitle(
  state: RootState,
  content: PaneContent,
  tabId: string,
  paneId: string,
): string {
  const storedTitle = resolveStoredTitleForDisplay(
    content,
    state.panes?.paneTitles?.[tabId]?.[paneId],
    state.panes?.paneTitleSetByUser?.[tabId]?.[paneId],
  )
  return getPaneDisplayTitle(content, storedTitle, paneExtensions(state))
}

/** The scoped pane display rule: the pane's current canonical session name
 * by its naming binding, then the legacy derived/stored fallback. Old
 * sticky flags and terminal inventory strings can never override a cached
 * canonical record. */
export function selectPaneDisplayName(state: RootState, tabId: string, paneId: string): string {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content) return ''
  if (!isScopedPaneContent(content)) {
    return selectPaneFallbackTitle(state, content, tabId, paneId)
  }
  const ref = resolvePaneNameRef(content)
  if (ref) {
    const record = selectSessionNameRecord(state, ref)
    if (record) return record.name
  }
  return selectPaneFallbackTitle(state, content, tabId, paneId)
}

/** The tab's stable naming source pane (plan "Stable tab ownership"):
 * the persisted `nameSource` pointer while its pane exists, else the
 * single-scoped-leaf fallback (Task 6 persists the pointer at every layout
 * boundary). Returns null for legacy tabs. */
export function selectTabNameSourcePaneId(state: RootState, tabId: string): string | null {
  const tab = state.tabs?.tabs?.find((candidate) => candidate.id === tabId)
  const layout = state.panes?.layouts?.[tabId]
  if (!tab || !layout) return null
  if (tab.nameSource?.kind === 'session') {
    const sourceId = tab.nameSource.paneId
    return layoutContainsPaneId(layout, sourceId) ? sourceId : null
  }
  if (tab.nameSource?.kind === 'legacy') return null
  // No persisted pointer yet: a single scoped leaf IS the original owner.
  if (layout.type === 'leaf' && isScopedPaneContent(layout.content)) {
    return layout.id
  }
  return null
}

/** Membership check for a pane id anywhere in the layout tree. */
function layoutContainsPaneId(node: PaneNode | undefined, paneId: string): boolean {
  return findPaneContent(node, paneId) !== undefined
}

/** Find a pane's content anywhere in the tab's layout tree (by pane id). */
function findPaneContent(node: PaneNode | undefined, paneId: string): PaneContent | undefined {
  if (!node) return undefined
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : undefined
  }
  return findPaneContent(node.children[0], paneId) ?? findPaneContent(node.children[1], paneId)
}

/** The scoped tab display rule: a session-owned tab displays its source
 * pane's canonical session name when one is cached; without a record it
 * keeps the legacy tab display (mirrored tab.title / derived title) as the
 * immediate safe fallback. Legacy tabs keep the existing derivation. */
export function selectTabDisplayName(state: RootState, tabId: string): string {
  const tab = state.tabs?.tabs?.find((candidate) => candidate.id === tabId)
  if (!tab) return ''
  const sourcePaneId = selectTabNameSourcePaneId(state, tabId)
  if (sourcePaneId) {
    const content = findPaneContent(state.panes?.layouts?.[tabId], sourcePaneId)
    if (content && isScopedPaneContent(content)) {
      const ref = resolvePaneNameRef(content)
      const record = ref ? selectSessionNameRecord(state, ref) : undefined
      if (record) return record.name
    }
  }
  return getTabDisplayTitle(tab, state.panes?.layouts?.[tabId], state.panes?.paneTitles?.[tabId], paneExtensions(state))
}

/** The session display rule for directory/history/sidebar surfaces. */
export function selectSessionDisplayName(state: RootState, ref: SessionNameRef, fallback: string): string {
  const record = selectSessionNameRecord(state, ref)
  return record?.name ?? fallback
}

/** The rename capture (stale-input protection): the pane's naming target and
 * its last-known revision at edit start. `ref` is undefined when nothing
 * resolves — callers then send no capture guards and the server's own
 * resolution decides. */
export function resolvePaneRenameCapture(
  state: RootState,
  tabId: string,
  paneId: string,
): { ref: SessionNameRef | undefined; revision: number | undefined } {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content || !isScopedPaneContent(content)) {
    return { ref: undefined, revision: undefined }
  }
  const ref = resolvePaneNameRef(content)
  if (!ref) return { ref: undefined, revision: undefined }
  return { ref, revision: selectSessionNameRecord(state, ref)?.revision }
}

/** The pane's native writeback status (display/status only). */
export function selectPaneNativeSync(
  state: RootState,
  tabId: string,
  paneId: string,
): { status: string; reason?: string } | undefined {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content || !isScopedPaneContent(content)) return undefined
  const ref = resolvePaneNameRef(content)
  if (!ref) return undefined
  return selectSessionNativeSync(state, ref)
}

/**
 * Memoized per-tab display-name map for tab-strip consumers (TabBar and the
 * registry summaries): recomputes only when one of its stable slice
 * references changes, never per render.
 */
export const selectTabDisplayTitles = createSelector(
  (state: RootState) => state.tabs?.tabs,
  (state: RootState) => state.panes,
  (state: RootState) => state.sessionNames,
  (state: RootState) => state.extensions?.entries,
  (tabs, panes, sessionNames, extensions) => {
    const state = {
      tabs: { tabs: tabs ?? [] },
      panes,
      sessionNames,
      extensions: { entries: extensions },
    } as unknown as RootState
    const out: Record<string, string> = {}
    for (const tab of tabs ?? []) {
      out[tab.id] = selectTabDisplayName(state, tab.id)
    }
    return out
  },
)

/**
 * The session-owned tabs' canonical names only (empty for legacy tabs) —
 * registry summaries overlay exactly these, never re-deriving a legacy
 * tab's title.
 */
export const selectScopedTabDisplayTitles = createSelector(
  (state: RootState) => state.tabs?.tabs,
  (state: RootState) => state.panes,
  (state: RootState) => state.sessionNames,
  (state: RootState) => state.extensions?.entries,
  (tabs, panes, sessionNames, extensions) => {
    const state = {
      tabs: { tabs: tabs ?? [] },
      panes,
      sessionNames,
      extensions: { entries: extensions },
    } as unknown as RootState
    const out: Record<string, string> = {}
    for (const tab of tabs ?? []) {
      const sourcePaneId = selectTabNameSourcePaneId(state, tab.id)
      if (sourcePaneId) {
        out[tab.id] = selectPaneDisplayName(state, tab.id, sourcePaneId)
      }
    }
    return out
  },
)
