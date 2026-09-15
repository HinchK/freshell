import { updatePaneTitleByTerminalId } from '@/store/panesSlice'
import type { RootState } from '@/store'

type FoldStore = {
  getState: () => Pick<RootState, 'panes'>
  dispatch: (action: any) => unknown
}
type InventoryRow = { terminalId?: string; title?: string }

/** Does any pane bound to this terminal hold a title that differs?
 * Carries the owning tabId through the walk so the title comparison can
 * read paneTitles[tabId][paneId]. A pane whose user-set flag is true is
 * NEVER a fold target — treat it as NOT differing so the fold count only
 * reports real folds and no no-op dispatch fires for it on every refresh. */
function paneTitleDiffersForTerminal(panes: RootState['panes'], terminalId: string, title: string): boolean {
  for (const [tabId, layout] of Object.entries(panes.layouts ?? {})) {
    if (!layout) continue
    const walk = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const n = node as { type?: string; id?: string; content?: { kind?: string; terminalId?: string }; children?: unknown[] }
      if (n.type === 'leaf') {
        if (n.content?.kind === 'terminal' && n.content.terminalId === terminalId) {
          if (panes.paneTitleSetByUser?.[tabId]?.[n.id ?? '']) return false
          if (((panes.paneTitles?.[tabId]?.[n.id ?? '']) ?? '') !== title) return true
        }
        return false
      }
      return (n.children ?? []).some(walk)
    }
    if (walk(layout)) return true
  }
  return false
}

/**
 * Fold terminal.inventory rows' titles into pane titles. The server sends
 * the inventory on EVERY connection, so this closes the refresh hole where
 * the edge-triggered terminal.title.updated push was missed and nothing
 * re-delivered the current registry title. All writes go through
 * updatePaneTitleByTerminalId with setByUser:false — user renames stick.
 * Returns the number of dispatched folds (churn-free: rows whose panes
 * already hold the title dispatch nothing, and user-set panes are skipped
 * entirely so they are never dispatched or counted).
 */
export function foldTerminalInventoryTitles(store: FoldStore, terminals: InventoryRow[] | undefined): number {
  let dispatched = 0
  for (const row of terminals ?? []) {
    const terminalId = row?.terminalId
    const title = row?.title
    if (!terminalId || !title) continue
    if (!paneTitleDiffersForTerminal(store.getState().panes, terminalId, title)) continue
    store.dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: false }))
    dispatched += 1
  }
  return dispatched
}
