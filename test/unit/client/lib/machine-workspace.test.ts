import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecoveryInventory: vi.fn(),
}))
vi.mock('@/store/tabRegistrySync', () => ({
  getCurrentTabRegistryClientInstanceId: () => 'client-machine-test',
}))
vi.mock('@/lib/recovery/boot-state', () => ({
  bootCapturedAtMs: 1_000,
}))

import { getRecoveryInventory } from '@/lib/api'
import { restoreMachineWorkspace } from '@/lib/machine-workspace'
import tabsReducer, { addTab, setActiveTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import type { RecoveryInventory } from '@/lib/recovery/types'

const MACHINE_ID = 'machine-desktop'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
    },
  })
}

function addForeignWorkspace(store: ReturnType<typeof createStore>) {
  store.dispatch(addTab({ id: 'foreign-tab', title: 'Foreign workspace' }))
  store.dispatch(initLayout({
    tabId: 'foreign-tab',
    paneId: 'foreign-pane',
    content: { kind: 'terminal', createRequestId: 'foreign-create', status: 'creating', mode: 'shell' },
  }))
}

function inventoryFor(machineId: string): RecoveryInventory {
  return {
    recoverable: true,
    contentId: `content-${machineId}`,
    device: {
      deviceId: machineId,
      deviceLabel: 'DANDESKTOP',
      capturedAt: 2_000,
      tabs: [{
        tabKey: `${machineId}:recovered-tab`,
        tabName: 'Recovered workspace',
        panes: [{
          paneId: 'recovered-pane',
          kind: 'terminal',
          mode: 'shell',
          shell: null,
          cwd: '/work',
          payload: {},
          sessionRef: null,
          ledgerState: 'unknown',
          live: false,
        }],
      }],
    },
    otherDevices: [],
    ledgerOnly: [],
  }
}

function addRecoveredTab(inventory: RecoveryInventory, machineId: string, tabId: string, title: string) {
  inventory.device?.tabs.push({
    tabKey: `${machineId}:${tabId}`,
    tabName: title,
    panes: [{
      paneId: `${tabId}-pane`,
      kind: 'terminal',
      mode: 'shell',
      shell: null,
      cwd: '/work',
      payload: {},
      sessionRef: null,
      ledgerState: 'unknown',
      live: false,
    }],
  })
}

describe('restoreMachineWorkspace', () => {
  beforeEach(() => {
    vi.mocked(getRecoveryInventory).mockReset()
  })

  it('replaces local state with only the selected machine scoped workspace before sync can start', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(getRecoveryInventory).toHaveBeenCalledWith(
      'machine-bootstrap:client-machine-test',
      expect.any(Number),
      { machineId: MACHINE_ID },
    )
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['recovered-tab'])
    expect(store.getState().panes.layouts['recovered-tab']?.id).toBe('recovered-pane')
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
    expect(store.getState().panes.layouts['foreign-tab']).toBeUndefined()
  })

  it('preserves snapshot createRequestIds through the same-machine restore reducer for terminals and every fresh-agent variant', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    const recoveredTab = inventory.device!.tabs[0]
    recoveredTab.panes = [
      {
        paneId: 'terminal-pane',
        kind: 'terminal',
        mode: 'shell',
        shell: null,
        cwd: '/work',
        payload: {
          createRequestId: 'server-terminal-create-request-id',
          terminalId: 'stale-terminal-id',
          status: 'running',
        },
        sessionRef: null,
        ledgerState: 'unknown',
        live: false,
      },
      ...([
        ['freshclaude', 'claude'],
        ['kilroy', 'claude'],
        ['freshcodex', 'codex'],
        ['freshopencode', 'opencode'],
      ] as const).map(([sessionType, provider]) => ({
        paneId: `${sessionType}-pane`,
        kind: 'fresh-agent',
        mode: sessionType,
        shell: null,
        cwd: '/work',
        payload: {
          sessionType,
          provider,
          createRequestId: `server-${sessionType}-create-request-id`,
          sessionId: `stale-${sessionType}-session`,
          status: 'running',
          serverInstanceId: 'stale-server',
        },
        sessionRef: null,
        ledgerState: 'unknown' as const,
        live: false,
      })),
    ]
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    const layout = store.getState().panes.layouts['recovered-tab']
    if (!layout) throw new Error('expected recovered layout')
    const leaves: Record<string, import('@/store/paneTypes').PaneContent> = {}
    const collectLeaves = (node: typeof layout): void => {
      if (node.type === 'leaf') {
        leaves[node.id] = node.content
        return
      }
      collectLeaves(node.children[0])
      collectLeaves(node.children[1])
    }
    collectLeaves(layout)

    const terminal = leaves['terminal-pane']
    if (terminal?.kind !== 'terminal') throw new Error('expected recovered terminal')
    expect(terminal.createRequestId).toBe('server-terminal-create-request-id')
    expect(terminal.terminalId).toBeUndefined()
    expect(terminal.status).toBe('creating')

    for (const sessionType of ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']) {
      const content = leaves[`${sessionType}-pane`]
      if (content?.kind !== 'fresh-agent') throw new Error(`expected recovered ${sessionType}`)
      expect(content.createRequestId).toBe(`server-${sessionType}-create-request-id`)
      expect(content.sessionId).toBeUndefined()
      expect(content.serverInstanceId).toBeUndefined()
      expect(content.status).toBe('creating')
    }
  })

  it('preserves a still-recovered active tab across machine workspace replacement', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].tabKey = `${MACHINE_ID}:tab-a`
    inventory.device!.tabs[0].tabName = 'Tab A'
    inventory.device!.tabs[0].panes[0].paneId = 'tab-a-pane'
    addRecoveredTab(inventory, MACHINE_ID, 'tab-b', 'Tab B')
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    store.dispatch(addTab({ id: 'tab-a', title: 'Cached Tab A' }))
    store.dispatch(addTab({ id: 'tab-b', title: 'Cached Tab B' }))
    store.dispatch(setActiveTab('tab-a'))

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
    expect(store.getState().tabs.activeTabId).toBe('tab-a')
  })

  it('keeps the deterministic restored-tab fallback when the prior active tab is absent', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].tabKey = `${MACHINE_ID}:tab-a`
    inventory.device!.tabs[0].tabName = 'Tab A'
    inventory.device!.tabs[0].panes[0].paneId = 'tab-a-pane'
    addRecoveredTab(inventory, MACHINE_ID, 'tab-b', 'Tab B')
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)
    addForeignWorkspace(store)

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
    expect(store.getState().tabs.activeTabId).toBe('tab-b')
  })

  it('refuses an unscoped foreign recovery response and preserves the current cache', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor('machine-garage'))

    await expect(restoreMachineWorkspace(store, MACHINE_ID)).rejects.toThrow(/machine-garage/i)
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Foreign workspace'])
  })

  it('clears stale local state when the ACTIVELY CHOSEN machine has no durable workspace', async () => {
    // The chooser-pick lane: the user just picked this machine, so the local
    // layout may be a DIFFERENT machine's stale cache — a non-recoverable
    // inventory (the chosen machine has no durable workspace) must clear it.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      recoverable: false,
      contentId: 'empty',
      device: null,
      otherDevices: [],
      ledgerOnly: [],
    })

    await restoreMachineWorkspace(store, MACHINE_ID, { activeSelection: true })

    expect(store.getState().tabs.tabs).toEqual([])
    expect(store.getState().panes.layouts).toEqual({})
  })

  it('keeps the rehydrated local layout when nothing foreign is recoverable on a remembered-machine reload', async () => {
    // The bb58dc001 reload regression: the inventory EXCLUDES the requester's
    // own generations by design (D2 — a live client owns its own data), so a
    // same-tab reload of a single-client machine sees recoverable:false with
    // its own layout rehydrated from localStorage. That layout IS this
    // machine's newest truth — destroying it blanked the workspace on every
    // F5 (and the destructive persist bypass then wiped the localStorage
    // cache too). It must survive when the boot did not actively choose the
    // machine.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      recoverable: false,
      contentId: 'empty',
      device: null,
      otherDevices: [],
      ledgerOnly: [],
    })

    const result = await restoreMachineWorkspace(store, MACHINE_ID)

    expect(result.restoredTabs).toBe(0)
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Foreign workspace'])
    expect(store.getState().panes.layouts['foreign-tab']).toBeDefined()
  })

  it('still converges to a recoverable foreign generation on a remembered-machine reload', async () => {
    // Reload with a NEWER foreign generation on the machine: the restore still
    // replaces the local layout with the machine's newest cross-client truth.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    const result = await restoreMachineWorkspace(store, MACHINE_ID)

    expect(result.restoredTabs).toBe(1)
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
  })
})
