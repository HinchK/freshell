import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  consumeTurnCompleteEvents,
  markTabAttention,
  markPaneAttention,
  markTabWatchedCompletion,
  type TurnCompleteEvent,
} from '@/store/turnCompletionSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { useNotificationSound } from '@/hooks/useNotificationSound'

const EMPTY_PENDING_EVENTS: TurnCompleteEvent[] = []

function isWindowFocused(): boolean {
  if (typeof document === 'undefined') return true
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return hasFocus && !document.hidden
}

export function useTurnCompletionNotifications() {
  const dispatch = useAppDispatch()
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const pendingEvents = useAppSelector((state) => state.turnCompletion?.pendingEvents ?? EMPTY_PENDING_EVENTS)
  const attentionDismiss = useAppSelector((state) => state.settings?.settings?.panes?.attentionDismiss ?? 'click')
  const { play } = useNotificationSound()
  const lastHandledSeqRef = useRef(0)
  const prevActiveTabIdRef = useRef(activeTabId)
  const [focused, setFocused] = useState(() => isWindowFocused())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const updateFocus = () => setFocused(isWindowFocused())
    window.addEventListener('focus', updateFocus)
    window.addEventListener('blur', updateFocus)
    document.addEventListener('visibilitychange', updateFocus)

    return () => {
      window.removeEventListener('focus', updateFocus)
      window.removeEventListener('blur', updateFocus)
      document.removeEventListener('visibilitychange', updateFocus)
    }
  }, [])

  useEffect(() => {
    if (pendingEvents.length === 0) return

    const windowFocused = isWindowFocused()
    // A turn ending the user was watching: the window is focused AND the
    // event's tab is the active tab.
    const isWatched = (event: TurnCompleteEvent) => windowFocused && activeTabId === event.tabId
    const markAttention = (event: TurnCompleteEvent) => {
      dispatch(markTabAttention({ tabId: event.tabId }))
      dispatch(markPaneAttention({ paneId: event.paneId }))
    }
    let highestHandledSeq = lastHandledSeqRef.current
    let terminalShouldPlay = false

    for (const event of pendingEvents) {
      if (event.seq <= lastHandledSeqRef.current) continue
      highestHandledSeq = Math.max(highestHandledSeq, event.seq)

      if (event.source === 'terminal') {
        // TERMINAL partition — today's behavior, unchanged: always mark tab+pane
        // attention (watched endings included), suppress only the sound when
        // watched, and coalesce the whole batch into ONE play().
        markAttention(event)
        if (isWatched(event)) {
          continue
        }
        terminalShouldPlay = true
        continue
      }

      // FRESH-AGENT partition — the unified attention rules.
      if (isWatched(event)) {
        // Watched ending: tab-strip-only mark, no sound, no attention flags
        // (attentionByTab also drives the sidebar row highlight, which must
        // stay dark for a watched ending).
        dispatch(markTabWatchedCompletion({ tabId: event.tabId }))
        continue
      }
      // Unwitnessed ending: full attention marks and one audible ring per event.
      markAttention(event)
      play()
    }

    if (highestHandledSeq > lastHandledSeqRef.current) {
      lastHandledSeqRef.current = highestHandledSeq
      dispatch(consumeTurnCompleteEvents({ throughSeq: highestHandledSeq }))
    }

    if (terminalShouldPlay) {
      play()
    }
  }, [activeTabId, dispatch, pendingEvents, play])

  // 'click' mode: clear attention only when the user *switches* to a tab that has attention.
  // If a completion arrives on the already-active tab, the indicator persists until the user
  // navigates away and back (an actual click/switch).
  useEffect(() => {
    const switched = prevActiveTabIdRef.current !== activeTabId
    prevActiveTabIdRef.current = activeTabId

    if (attentionDismiss !== 'click') return
    if (!switched || !focused || !activeTabId) return
    // Clear the tab AND every pane's green in the switched-to tab (not just the
    // active pane), so a sibling pane's header does not stay green after visiting.
    dispatch(dismissTabGreen(activeTabId))
  }, [activeTabId, attentionDismiss, dispatch, focused])

  // 'type' mode: attention is cleared by TerminalView when the user sends input.
}
