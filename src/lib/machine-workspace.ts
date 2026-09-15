import { getRecoveryInventory } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { bootCapturedAtMs } from '@/lib/recovery/boot-state'
import { buildRecoveryPlan } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'
import { addTerminalRestoreRequestId, armRecoveredLiveTerminalTarget } from '@/lib/terminal-restore'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { clearTabRegistryLocalClosed } from '@/store/tabRegistrySlice'
import { clearTabsForMachine, addTab } from '@/store/tabsSlice'
import { clearPanesForMachine, restoreLayout } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

const log = createLogger('machine-workspace')

type MachineWorkspaceStore = {
  dispatch: (action: any) => unknown
  getState: () => Pick<RootState, 'panes'>
}

const MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX = 'machine-bootstrap:'

function armTerminalRestores(state: Pick<RootState, 'panes'>, tabIds: string[]): void {
  const walk = (node: PaneNode | undefined): void => {
    if (!node) return
    if (node.type === 'leaf') {
      if (node.content.kind === 'terminal' && node.content.sessionRef && node.content.createRequestId) {
        addTerminalRestoreRequestId(node.content.createRequestId)
      }
      return
    }
    for (const child of node.children) walk(child)
  }
  for (const tabId of tabIds) walk(state.panes.layouts[tabId])
}

function assertInventoryIsScopedToMachine(inventory: RecoveryInventory, machineId: string): void {
  const inventoryMachineId = inventory.device?.deviceId
  if (inventoryMachineId && inventoryMachineId !== machineId) {
    throw new Error(
      `Refusing recovery for ${inventoryMachineId}: the selected machine is ${machineId}`,
    )
  }
}

export type RestoreMachineWorkspaceReason = 'absent' | 'corrupt' | 'foreign' | 'stale'

export type RestoreMachineWorkspaceOptions = {
  /** Why this boot is rebuilding instead of keeping the local layout. */
  reason?: RestoreMachineWorkspaceReason
}

/**
 * Hydrate the selected machine's durable workspace before the websocket and
 * tabs.sync are allowed to start. The server must honor the additive
 * `machineId` inventory scope; checking the returned device id again keeps a
 * stale server from restoring an arbitrary other machine into a fresh client.
 */
export async function restoreMachineWorkspace(
  store: MachineWorkspaceStore,
  machineId: string,
  options: RestoreMachineWorkspaceOptions = {},
): Promise<{ restoredTabs: number }> {
  log.info('rebuilding machine workspace from server inventory', {
    reason: options.reason,
    machineId,
  })
  // The recovery endpoint treats clientInstanceId as an opaque exclusion key.
  // The general recovery offer passes the real id so it cannot offer the page
  // its own already-loaded state. Machine bootstrap is different: a rebuild
  // WANTS the window's own last durable snapshot included, and a reload keeps
  // the same sessionStorage id. A reserved, non-client prefix therefore
  // includes that window's last snapshot without changing the normal
  // recovery-offer contract.
  const bootstrapExclusionId =
    `${MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX}${getCurrentTabRegistryClientInstanceId()}`
  const inventory = await getRecoveryInventory(
    bootstrapExclusionId,
    Math.max(0, Date.now() - bootCapturedAtMs),
    { machineId },
  )
  assertInventoryIsScopedToMachine(inventory, machineId)
  const plans = inventory.recoverable
    ? buildRecoveryPlan(inventory, { preserveIdsForMachine: machineId })
    : []

  // These are local cache actions, not tab/pane closes. Sync is still gated,
  // so no blank or mixed-machine snapshot can reach the server mid-replace.
  store.dispatch(clearTabsForMachine())
  store.dispatch(clearPanesForMachine())
  store.dispatch(clearTabRegistryLocalClosed())

  for (const plan of plans) {
    store.dispatch(addTab({ id: plan.tabId, title: plan.title }))
    store.dispatch(restoreLayout({
      tabId: plan.tabId,
      layout: plan.layout,
      paneTitles: plan.paneTitles,
    }))
    for (const target of plan.liveTerminalReattach ?? []) {
      armRecoveredLiveTerminalTarget(plan.tabId, target.paneId, target.terminalId)
    }
  }
  armTerminalRestores(store.getState(), plans.map((plan) => plan.tabId))
  return { restoredTabs: plans.length }
}
