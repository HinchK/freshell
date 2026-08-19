import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'

/**
 * Pushes the sidebar's `showSubagents` preference to the server
 * (`sessions.prefs`). The server's per-connection registry (amplifier
 * watch reduction: subagent rescan cadence) is connection-scoped, so we
 * re-send on every reconnect. `ws.send` queues until the connection is
 * ready, so the first send during boot/order is safe.
 */
export const subagentInterestMiddleware: Middleware = (store) => {
  let lastSent: boolean | null = null

  const sendCurrent = () => {
    const interested =
      (store.getState() as { settings?: { settings?: { sidebar?: { showSubagents?: boolean } } } })
        .settings?.settings?.sidebar?.showSubagents === true
    if (interested === lastSent) return
    lastSent = interested
    getWsClient().send({ type: 'sessions.prefs', includeSubagents: interested })
  }

  getWsClient().onReconnect(() => {
    lastSent = null
    sendCurrent()
  })

  return (next) => (action) => {
    const result = next(action)
    sendCurrent()
    return result
  }
}
