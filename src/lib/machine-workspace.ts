import { getRecoveryInventory } from '@/lib/api'
import { bootCapturedAtMs } from '@/lib/recovery/boot-state'
import { buildRecoveryPlan } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'
import { addTerminalRestoreRequestId, armRecoveredLiveTerminalTarget } from '@/lib/terminal-restore'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { clearTabRegistryLocalClosed } from '@/store/tabRegistrySlice'
import { clearTabsForMachine, addTab, setActiveTab } from '@/store/tabsSlice'
import { clearPanesForMachine, restoreLayout, setPaneCrashTrace } from '@/store/panesSlice'
import type { CrashTrace, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

type MachineWorkspaceStore = {
  dispatch: (action: any) => unknown
  getState: () => Pick<RootState, 'panes' | 'tabs'>
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

type CrashTraceDecoration = {
  tabId: string
  paneId: string
  mode: string
  createRequestId: string
  crashTrace: CrashTrace
}

function collectLocalCrashTraceDecorations(state: Pick<RootState, 'panes'>): CrashTraceDecoration[] {
  const decorations: CrashTraceDecoration[] = []
  const walk = (tabId: string, node: PaneNode | undefined): void => {
    if (!node) return
    if (node.type === 'leaf') {
      const { content } = node
      if (content.kind === 'terminal' && content.crashTrace) {
        decorations.push({
          tabId,
          paneId: node.id,
          mode: content.mode,
          createRequestId: content.createRequestId,
          crashTrace: content.crashTrace,
        })
      }
      return
    }
    for (const child of node.children) walk(tabId, child)
  }
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) walk(tabId, layout)
  return decorations
}

function reapplyMatchingCrashTraceDecorations(
  store: MachineWorkspaceStore,
  decorations: CrashTraceDecoration[],
): void {
  for (const decoration of decorations) {
    const layout = store.getState().panes.layouts[decoration.tabId]
    const findMatchingPane = (node: PaneNode | undefined): boolean => {
      if (!node) return false
      if (node.type === 'leaf') {
        const { content } = node
        return node.id === decoration.paneId
          && content.kind === 'terminal'
          && content.mode === decoration.mode
          && content.createRequestId === decoration.createRequestId
      }
      return findMatchingPane(node.children[0]) || findMatchingPane(node.children[1])
    }
    if (findMatchingPane(layout)) {
      store.dispatch(setPaneCrashTrace({
        tabId: decoration.tabId,
        paneId: decoration.paneId,
        crashTrace: decoration.crashTrace,
      }))
    }
  }
}

function assertInventoryIsScopedToMachine(inventory: RecoveryInventory, machineId: string): void {
  const inventoryMachineId = inventory.device?.deviceId
  if (inventoryMachineId && inventoryMachineId !== machineId) {
    throw new Error(
      `Refusing recovery for ${inventoryMachineId}: the selected machine is ${machineId}`,
    )
  }
}

export type RestoreMachineWorkspaceOptions = {
  /**
   * True when the machine was ACTIVELY chosen this boot (the chooser pick's
   * one-shot sessionStorage marker). An active choice may be adopting a
   * different machine over a foreign local cache, so a NON-recoverable
   * inventory still clears local state (the chosen machine's empty truth
   * wins). Absent/false — the remembered-selection reload path — keeps the
   * rehydrated local layout when nothing foreign is recoverable.
   */
  activeSelection?: boolean
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
  // The recovery endpoint treats clientInstanceId as an opaque exclusion key.
  // The general recovery offer passes the real id so it cannot offer the page
  // its own already-loaded state. Machine bootstrap is different: local state
  // is about to be replaced, and a reload keeps the same sessionStorage id.
  // A reserved, non-client prefix therefore includes that window's last
  // durable snapshot without changing the normal recovery-offer contract.
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
  const priorActiveTabId = store.getState().tabs.activeTabId
  // Crash traces are a deliberate local-only UI decoration. Capture exactly
  // that decoration before replacing the local cache; the server inventory
  // remains authoritative for every recovered workspace field.
  const localCrashTraceDecorations = collectLocalCrashTraceDecorations(store.getState())
  const recoveredTabIds = new Set(plans.map((plan) => plan.tabId))

  // bb58dc001 follow-up (reload-safety): the recovery inventory EXCLUDES the
  // requester's own generations by design (D2 — a live client owns its own
  // data). When nothing foreign is recoverable and this boot did NOT
  // actively choose the machine (a natural reload of a remembered
  // selection), the rehydrated local layout IS this machine's newest truth —
  // keep it. Destroying it here blanked the workspace on every same-tab
  // reload, and the destructive persist bypass then wiped the localStorage
  // cache too. An active choice keeps the clear: a freshly chosen machine
  // with no durable workspace must still clear a foreign machine's stale
  // cache. A RECOVERABLE inventory always replaces (the machine's newest
  // cross-client truth wins on every path).
  if (inventory.recoverable || options.activeSelection === true) {
    // These are local cache actions, not tab/pane closes. Sync is still gated,
    // so no blank or mixed-machine snapshot can reach the server mid-replace.
    store.dispatch(clearTabsForMachine())
    store.dispatch(clearPanesForMachine())
    store.dispatch(clearTabRegistryLocalClosed())
  }

  for (const plan of plans) {
    store.dispatch(addTab({ id: plan.tabId, title: plan.title }))
    store.dispatch(restoreLayout({
      tabId: plan.tabId,
      layout: plan.layout,
      paneTitles: plan.paneTitles,
      // The inventory is scoped to this selected machine and the plan already
      // chose only valid snapshot IDs. Preserve that durable pane identity;
      // ordinary and cross-device restore callers intentionally omit this.
      preserveCreateRequestIds: true,
    }))
    for (const target of plan.liveTerminalReattach ?? []) {
      armRecoveredLiveTerminalTarget(plan.tabId, target.paneId, target.terminalId)
    }
  }
  // A local trace follows only the exact same terminal identity on this
  // machine. In particular, a new create request or a different terminal mode
  // cannot inherit a stale "crashed and resumed" notice.
  reapplyMatchingCrashTraceDecorations(store, localCrashTraceDecorations)
  if (priorActiveTabId && recoveredTabIds.has(priorActiveTabId)) {
    store.dispatch(setActiveTab(priorActiveTabId))
  }
  armTerminalRestores(store.getState(), plans.map((plan) => plan.tabId))
  return { restoredTabs: plans.length }
}
