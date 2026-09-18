import { getWsClient } from './ws-client'
import { markTerminalReleased } from './terminal-release-marks'
import { selectPaneOwnerFence } from '@/store/selectors/runtimeOwner'
import type { AppStore } from '@/store/store'
import type { SessionLocator } from '@shared/ws-protocol'

/**
 * Send terminal.kill for a terminal, marking it released first so the
 * detach middleware does not follow up with a redundant terminal.detach
 * when the pane reference disappears from the layouts.
 *
 * Every production terminal.kill send in the client goes through here.
 * (Test harness escape hatch sendWsMessage in App.tsx can bypass it.)
 *
 * b8ke ext r20 F2: the DELAYED-REQUEST FENCE. A kill queued while one
 * device is offline reconnects AFTER another device may have advanced
 * the generation through a handoff — the Rust server's retained-fence
 * substitution would turn the stale kill into a current one, killing the
 * NEWER owner. Every production sender that CAN know the session-owner
 * fence supplies the observed (epoch, generation) pair from the
 * runtimeOwners fence machinery, so the server's stale-pair rejection
 * refuses the reconnect-queued stale kill typed. A kill of a terminal
 * with NO session-owner record legitimately sends no pair (there is no
 * fence to observe).
 */
export function sendTerminalKill(
  terminalId: string,
  fence?: { observedEpoch?: number; observedGeneration?: number },
): void {
  markTerminalReleased(terminalId)
  const pair = fence?.observedEpoch !== undefined && fence?.observedGeneration !== undefined
    ? { observedEpoch: fence.observedEpoch, observedGeneration: fence.observedGeneration }
    : {}
  getWsClient().send({ type: 'terminal.kill', terminalId, ...pair })
}

/**
 * b8ke ext r20 F2: resolve a terminal's observed (epoch, generation)
 * pair from the runtimeOwners fence machinery — the pane/session the kill
 * targets. `undefined` when the store has no owner record for the
 * session (the no-owner kill legitimately sends no pair).
 */
export function resolveTerminalKillFence(
  store: AppStore,
  pane: { provider?: string; sessionRef?: SessionLocator; sessionId?: string },
): { observedEpoch: number; observedGeneration: number } | undefined {
  const fence = selectPaneOwnerFence(store.getState(), pane)
  if (!fence) return undefined
  return { observedEpoch: fence.epoch, observedGeneration: fence.generation }
}
