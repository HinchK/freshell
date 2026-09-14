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
import tabsReducer, { addTab } from '@/store/tabsSlice'
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
      'client-machine-test',
      expect.any(Number),
      { machineId: MACHINE_ID },
    )
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
    expect(store.getState().panes.layouts['foreign-tab']).toBeUndefined()
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
