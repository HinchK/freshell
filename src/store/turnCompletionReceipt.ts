import type { Middleware } from '@reduxjs/toolkit'
import { isWindowFocused } from '@/lib/window-focus'
import { recordTerminalIdle, recordTurnComplete } from './turnCompletionSlice'
import type { RootState } from './store'

/**
 * DR5-3 (delta round 5): stamp the `watched` witness bit at EVENT-RECEIPT
 * time — synchronously in the store path that queues the event (the dispatch
 * boundary every completion dispatch crosses, whichever lane it arrives on:
 * the fresh-agent WS thunks, the terminal idle edge, the terminal BEL path).
 *
 * The receipt-time inputs — the CURRENT window focus + visibility (DOM) and
 * the CURRENT active tab (store state) — are read at the dispatch, so the
 * classification reflects the user's attention at the moment the ending
 * HAPPENED. The notification hook (`useTurnCompletionNotifications`) then
 * consumes the stamped bit when its passive effect drains the queued event
 * instead of recomputing: a focus or active-tab change between receipt and
 * the drain (React's passive effects run after paint, potentially frames
 * later) must never re-classify an ending that already happened.
 *
 * The stamp applies only when the dispatch did not already carry one (the
 * payload field is optional — a bare store without this middleware queues
 * UNWITNESSED events, the fail-loud direction).
 */
export const turnCompletionReceiptMiddleware: Middleware =
  (store) => (next) => (action) => {
    if (
      (recordTurnComplete.match(action) || recordTerminalIdle.match(action)) &&
      action.payload &&
      action.payload.watched === undefined
    ) {
      const state = store.getState() as RootState
      const watched =
        isWindowFocused() && state.tabs?.activeTabId === action.payload.tabId
      return next({
        ...(action as object),
        payload: { ...action.payload, watched },
      })
    }
    return next(action)
  }
