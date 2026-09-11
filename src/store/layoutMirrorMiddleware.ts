import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'

const INITIAL_LAYOUT_SYNC_DEBOUNCE_MS = 1000
const LAYOUT_SYNC_DEBOUNCE_MS = 200

function buildTabFallbackSessionRef(tab: {
  sessionRef?: { provider?: string; sessionId?: string }
}): { provider: string; sessionId: string } | undefined {
  const provider = tab.sessionRef?.provider
  const sessionId = tab.sessionRef?.sessionId
  if (!provider || !sessionId) return undefined
  return { provider, sessionId }
}

/**
 * kata b8ke Task 10: the server's `ui.command { command: "layout.resync" }`
 * handshake dispatches this action. The middleware resets its `lastPayload`
 * dedupe gate and re-sends the current layout IMMEDIATELY (not debounced) —
 * the server's respawn/attach resolution polls a bounded window for the pane
 * this client knows about but whose sync missed the mirror debounce.
 */
export const FORCE_LAYOUT_RESYNC = 'layoutMirror/forceLayoutResync'

export const forceLayoutResync = () => ({ type: FORCE_LAYOUT_RESYNC } as const)

export const layoutMirrorMiddleware: Middleware = (store) => {
  let lastPayload = ''
  let timer: number | undefined
  let hasSentInitialPayload = false

  return (next) => (action) => {
    const forceResync = (action as { type?: string })?.type === FORCE_LAYOUT_RESYNC
    if (forceResync) {
      // Bypass the dedupe gate: the point is re-sending an UNCHANGED layout.
      lastPayload = ''
    }
    const result = next(action)
    const state = store.getState() as any
    const payload = {
      type: 'ui.layout.sync',
      tabs: state.tabs.tabs.map((t: any) => {
        const fallbackSessionRef = buildTabFallbackSessionRef(t)
        return {
          id: t.id,
          title: t.title,
          ...(fallbackSessionRef ? { fallbackSessionRef } : {}),
        }
      }),
      activeTabId: state.tabs.activeTabId,
      layouts: state.panes.layouts,
      activePane: state.panes.activePane,
      paneTitles: state.panes.paneTitles || {},
      paneTitleSetByUser: state.panes.paneTitleSetByUser || {},
    }
    const serialized = JSON.stringify(payload)
    if (serialized === lastPayload) return result
    lastPayload = serialized

    if (forceResync) {
      // The server's re-sync handshake polls a bounded window: send NOW,
      // through the same reliable-send path, not on the debounce.
      if (timer) window.clearTimeout(timer)
      hasSentInitialPayload = true
      getWsClient().send({ ...payload, timestamp: Date.now() })
      return result
    }

    if (timer) window.clearTimeout(timer)
    const debounceMs = hasSentInitialPayload
      ? LAYOUT_SYNC_DEBOUNCE_MS
      : INITIAL_LAYOUT_SYNC_DEBOUNCE_MS
    timer = window.setTimeout(() => {
      hasSentInitialPayload = true
      getWsClient().send({ ...payload, timestamp: Date.now() })
    }, debounceMs)

    return result
  }
}
