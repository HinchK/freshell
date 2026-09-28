import { createLogger } from '@/lib/client-logger'

const log = createLogger('terminal-interest')

/** Presentation-only interest for one WebSocket connection. No attach, detach,
 * resize, input or execution state is changed by this module. */
export type TerminalInterestSnapshot = {
  focusedTerminalId: string | null
  visibleTerminalIds: string[]
  /** Hidden-pane lifetime claims (responsive-terminal-restore Workstream 1):
   *  every terminal id in every pane layout — the terminals this client wants
   *  kept alive without attaching while their panes are hidden. The wire field
   *  is negotiated (`terminalLifetimeClaimV1` echo); callers strip it when the
   *  server did not echo so an old server never sees it. */
  claimedTerminalIds?: string[]
}
export type InterestPane = {
  type: string
  id: string
  content?: { kind: string; terminalId?: string }
  children?: readonly InterestPane[]
}
export type InterestState = {
  tabs: { activeTabId: string | null | undefined }
  panes: {
    layouts: Record<string, InterestPane | undefined>
    activePane: Record<string, string | null | undefined>
    zoomedPane?: Record<string, string | null | undefined>
  }
}
export const MAX_VISIBLE_TERMINALS = 1024
/** Guard budget shared by the all-layouts walk (same order as the visible
 * walk: a cyclic/oversized layout anywhere refuses the whole snapshot). */
const MAX_LAYOUT_NODES = 8192

export function selectTerminalInterest(state: InterestState, hidden: boolean): TerminalInterestSnapshot | null {
  // Hidden-pane lifetime claims (responsive-terminal-restore WS1): every
  // terminal id in EVERY tab layout — hidden panes claim instead of
  // attaching, and visible panes' claims coexist with their attaches. One
  // guarded walk over all layouts collects both the claim set and (for the
  // active tab) the visible/focused classification.
  const claimed = new Set<string>()
  const collectClaims = (root: InterestPane | undefined): boolean => {
    const stack: InterestPane[] = []
    if (root) stack.push(root)
    const visited = new Set<InterestPane>()
    while (stack.length) {
      const node = stack.pop()!
      if (visited.has(node)) return false
      visited.add(node)
      if (visited.size > MAX_LAYOUT_NODES) return false
      if (node.type === 'leaf') {
        const terminalId = node.content?.terminalId
        if (node.content?.kind === 'terminal' && typeof terminalId === 'string' && terminalId) {
          if (terminalId.length > 512) return false
          claimed.add(terminalId)
        }
      } else if (node.children) {
        stack.push(...node.children)
      }
    }
    return true
  }
  for (const root of Object.values(state.panes.layouts)) {
    if (!collectClaims(root)) return null
  }
  // Never silently truncate claims: overflow would silently drop a wanted
  // hidden terminal into reap-eligibility.
  if (claimed.size > MAX_VISIBLE_TERMINALS) return null
  const claimedTerminalIds = [...claimed].sort()
  if (hidden || !state.tabs.activeTabId) {
    return { focusedTerminalId: null, visibleTerminalIds: [], claimedTerminalIds }
  }
  const tab = state.tabs.activeTabId
  const root = state.panes.layouts[tab]
  if (!root) return { focusedTerminalId: null, visibleTerminalIds: [], claimedTerminalIds }
  const leaves: InterestPane[] = []
  const stack = [root]
  const visited = new Set<InterestPane>()
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node)) return null
    visited.add(node)
    if (visited.size > MAX_LAYOUT_NODES) return null
    if (node.type === 'leaf') leaves.push(node)
    else if (node.children) stack.push(...node.children)
  }
  const zoom = state.panes.zoomedPane?.[tab]
  const zoomedLeaf = zoom ? leaves.find((leaf) => leaf.id === zoom) : undefined
  // Match PaneLayout: an invalid zoom identifier falls back to the full layout.
  const visibleLeaves = zoomedLeaf ? [zoomedLeaf] : leaves
  const ids = new Set<string>()
  let focusedTerminalId: string | null = null
  for (const leaf of visibleLeaves) {
    const content = leaf.content
    if (content?.kind !== 'terminal' || !content.terminalId) continue
    const terminalId = content.terminalId
    if (terminalId.length > 512) return null
    ids.add(terminalId)
    if (zoomedLeaf || leaf.id === state.panes.activePane[tab]) focusedTerminalId = terminalId
  }
  // Never silently truncate visible terminals and misclassify them as hidden.
  if (ids.size > MAX_VISIBLE_TERMINALS) return null
  return { focusedTerminalId, visibleTerminalIds: [...ids].sort(), claimedTerminalIds }
}

export type InterestPublisher = {
  schedule: () => void
  flushNow: (force?: boolean) => void
  invalidate: () => void
  dispose: () => void
}

/** Coalesce presentation churn to a task, not an animation frame. Reading at
 * flush time prevents stale layouts from being queued across rapid tab changes.
 * The sender must refuse to buffer while disconnected or not negotiated.
 * Revisions belong to the WsClient, so remounting this publisher cannot rewind
 * the revision counter on a surviving connection. */
export function createInterestPublisher(options: {
  read: () => TerminalInterestSnapshot | null
  send: (snapshot: TerminalInterestSnapshot) => boolean
  scheduleTask: (task: () => void) => (() => void)
}): InterestPublisher {
  let lastKey: string | null = null
  let cancel: (() => void) | null = null
  let disposed = false
  const flushNow = (force = false) => {
    cancel?.(); cancel = null
    if (disposed) return
    const snapshot = options.read()
    // A refused read (selector cardinality/cycle guards) must not move the
    // server off the last accepted snapshot — but it must also not be
    // silent: that state is a client-side classification problem.
    if (snapshot === null) {
      if (lastKey !== null) log.debug('selector refused snapshot; keeping last accepted state')
      return
    }
    const key = JSON.stringify(snapshot)
    if (!force && key === lastKey) return
    if (options.send(snapshot)) lastKey = key
  }
  return {
    schedule() {
      if (disposed || cancel) return
      cancel = options.scheduleTask(() => { cancel = null; flushNow() })
    },
    flushNow,
    invalidate() { lastKey = null; cancel?.(); cancel = null },
    dispose() { disposed = true; cancel?.(); cancel = null },
  }
}
