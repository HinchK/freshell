import { findPaneForSession } from '@/lib/session-utils'
import { openSessionTab, setActiveTab } from '@/store/tabsSlice'
import { setActivePane } from '@/store/panesSlice'
import type { AppDispatch, RootState } from '@/store/store'

export interface ResumeTarget {
  provider: string
  sessionId: string
  cwd?: string
  sessionType?: string
  title?: string
  firstUserMessage?: string
}

/**
 * Resume a session in a tab following the sidebar's dedup convention:
 * if a pane already holds the session, focus it; otherwise open a new
 * focused tab running the correct agent with the FULL session id.
 */
export function resumeSessionInTab(
  state: RootState,
  dispatch: AppDispatch,
  target: ResumeTarget,
  onNavigate?: (view: 'terminal') => void,
): { deduped: boolean } {
  const existing = findPaneForSession(
    state,
    { provider: target.provider, sessionId: target.sessionId },
    state.connection.serverInstanceId,
  )
  if (existing) {
    dispatch(setActiveTab(existing.tabId))
    if (existing.paneId) {
      dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
    }
    onNavigate?.('terminal')
    return { deduped: true }
  }
  dispatch(
    openSessionTab({
      sessionId: target.sessionId,
      provider: target.provider,
      sessionType: target.sessionType ?? target.provider,
      cwd: target.cwd,
      title: target.title,
      firstUserMessage: target.firstUserMessage,
    }),
  )
  onNavigate?.('terminal')
  return { deduped: false }
}
