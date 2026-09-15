import type { Middleware } from '@reduxjs/toolkit'
import { updatePaneTitleBySessionRef } from './panesSlice'
import { collectPaneEntries, paneContentMatchesSessionRef } from '@/lib/pane-utils'
import type { RootState } from './store'

type TitledSessionRow = {
  provider: string
  sessionId: string
  title: string
  surface: string
  fetchSeq: number
}

const SURFACE_ORDER = ['sidebar', 'history', 'bootstrap']

/**
 * Collect every session row that currently has a title, DEDUPED by
 * `${provider}:${sessionId}`: the same session can sit in several retained
 * windows (e.g. sidebar AND history), and a later refresh of a window does
 * NOT mean its rows are fresh — the deep-page silent refresh RETAINS older
 * rows (sessionsThunks.ts:602-609 merges the fresh page-1 over the stored
 * window; deeper rows survive as the SAME objects, sessionsThunks.ts:184-204)
 * while `commitWindowPayload` stamps the whole merged window with fresh
 * lastLoadedAt/resultVersion (sessionsSlice.ts). So the winner is picked by
 * per-ROW freshness, NOT by window stamps and NOT by row activity (a title
 * override does not touch `lastActivityAt`): the greatest per-row
 * `fetchSeq` — a monotonic client-side counter stamped at the commit
 * reducer on every inserted-or-updated row (rows the merge retained keep
 * their old stamps: the field lives on the row object and both carry paths
 * preserve it — the merge passes the same objects, and normalizeProjects
 * either passes references through or spreads `...session`). No existing
 * per-row field reflects fetch recency (`SessionDirectoryItem` carries only
 * activity times, shared/read-models.ts:51-86; `revision`/`snapshotSeq`
 * are page-level) — hence the client-side counter. Tie (e.g. both rows
 * unstamped → 0) → deterministic surface order (surfaces are
 * 'sidebar' | 'history' | 'bootstrap', sessionsThunks.ts:27).
 */
function collectTitledSessionRows(sessions: RootState['sessions']): TitledSessionRow[] {
  const byKey = new Map<string, TitledSessionRow>()
  for (const [surface, sessionWindow] of Object.entries(sessions.windows ?? {})) {
    for (const project of sessionWindow?.projects ?? []) {
      for (const session of project.sessions ?? []) {
        if (!session.title) continue
        const candidate: TitledSessionRow = {
          provider: session.provider,
          sessionId: session.sessionId,
          title: session.title,
          surface,
          fetchSeq: typeof session.fetchSeq === 'number' ? session.fetchSeq : 0,
        }
        const key = `${candidate.provider}:${candidate.sessionId}`
        const existing = byKey.get(key)
        const fresherRow =
          !existing
          || candidate.fetchSeq > existing.fetchSeq
          || (candidate.fetchSeq === existing.fetchSeq
            && SURFACE_ORDER.indexOf(candidate.surface) < SURFACE_ORDER.indexOf(existing.surface))
        if (fresherRow) {
          byKey.set(key, candidate)
        }
      }
    }
  }
  return [...byKey.values()]
}

/**
 * Any pane bound to this session holding a different title? Matches the
 * same rule updatePaneTitleBySessionRef's reducer uses (fresh-agent
 * provider+sessionId; terminal content.sessionRef). A pane whose user-set
 * flag is true is NEVER a fold target — treat it as NOT differing so no
 * no-op dispatch fires for it on every refresh.
 */
function sessionTitleDiffers(panes: RootState['panes'], provider: string, sessionId: string, title: string): boolean {
  for (const [tabId, layout] of Object.entries(panes.layouts ?? {})) {
    if (!layout) continue
    for (const { paneId, content } of collectPaneEntries(layout)) {
      if (!paneContentMatchesSessionRef(content, provider, sessionId)) continue
      if (panes.paneTitleSetByUser?.[tabId]?.[paneId]) continue
      if ((panes.paneTitles?.[tabId]?.[paneId] ?? '') !== title) return true
    }
  }
  return false
}

/**
 * Pane-binding actions that can introduce or re-bind a sessionRef AFTER
 * its directory row is already loaded (the MCP/REST-created-pane symptom:
 * the row lands via sessions/*, the pane arrives later via panes/*).
 * Exact generated action-type strings, verified against panesSlice.ts
 * (slice name 'panes'; reducers initLayout, updatePaneContent,
 * materializeFreshAgentSession, mergePaneContent,
 * reconcileTerminalSessionRefByTerminalId, splitPane, addPane,
 * restoreLayout, hydratePanes, applyReconcileAttach,
 * applyFreshAgentReconcileAttach). Real binding paths for the four
 * additions: panes/splitPane — REST/MCP agent split
 * (ui-commands.ts:119-127); panes/addPane — sidebar split-open
 * (Sidebar.tsx:551-562) and tab-registry reconstruction
 * (tab-registry-open.ts:278-280); panes/restoreLayout — the
 * machine-bootstrap/recovery-offer rebuild plan loops
 * (machine-workspace.ts:95, RecoveryOfferPanel.tsx:165);
 * panes/hydratePanes — cross-window hydration (crossTabSync.ts:206-219).
 * The two reconcile-attach folds are the healthy-reload rebind path: a
 * persisted fresh-agent pane rehydrates with sessionRef only (persistence
 * strips the top-level sessionId when a canonical sessionRef exists), and
 * the pane.reconcile verdict that restores the live session id — or
 * corrects the pane onto a DIFFERENT session — must re-run the mirror.
 */
const SESSION_BINDING_PANE_ACTIONS = new Set([
  'panes/initLayout',
  'panes/updatePaneContent',
  'panes/mergePaneContent',
  'panes/materializeFreshAgentSession',
  'panes/reconcileTerminalSessionRefByTerminalId',
  'panes/splitPane',
  'panes/addPane',
  'panes/restoreLayout',
  'panes/hydratePanes',
  'panes/applyReconcileAttach',
  'panes/applyFreshAgentReconcileAttach',
])

/**
 * Session-directory titles are the canonical names for agent sessions, but
 * only the composer flow ever folded them into panes — MCP/REST-created
 * panes stayed on derived defaults forever. This middleware folds titled
 * session rows into their open panes after every sessions-state change AND
 * after the pane-binding actions above (a pane created after its row is
 * loaded must still get titled — the missed-ordering case), through
 * updatePaneTitleBySessionRef with setByUser:false (rename scope
 * contract: user renames stick; nothing durable is written; no dispatch
 * when the title already matches).
 */
export const sessionTitleMirrorMiddleware: Middleware = (store) => (next) => (action: any) => {
  const result = next(action)
  const type = action?.type
  if (typeof type === 'string' && (type.startsWith('sessions/') || SESSION_BINDING_PANE_ACTIONS.has(type))) {
    const state = store.getState() as RootState
    for (const row of collectTitledSessionRows(state.sessions)) {
      if (!sessionTitleDiffers(state.panes, row.provider, row.sessionId, row.title)) continue
      store.dispatch(updatePaneTitleBySessionRef({
        provider: row.provider,
        sessionId: row.sessionId,
        title: row.title,
        setByUser: false,
      }))
    }
  }
  return result
}
