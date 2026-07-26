// Boot-state variant: this file mocks hadPersistedLayoutAtBoot to TRUE (the boot
// found a persisted layout, so nothing was lost). Split from the main test file
// because the boot-state capture is a module constant — one mock per module graph.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecoveryInventory: vi.fn(),
}))
vi.mock('@/lib/recovery/boot-state', () => ({
  computeHadPersistedLayout: () => true,
  hadPersistedLayoutAtBoot: true, // this boot HAD a layout
  bootCapturedAtMs: 1000,
}))
vi.mock('@/store/tabRegistrySync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentTabRegistryClientInstanceId: () => 'client-me',
}))

import { getRecoveryInventory } from '@/lib/api'
import { RecoveryOfferPanel } from '@/components/RecoveryOfferPanel'
import { setPendingOffer } from '@/lib/recovery/dismissal'
import type { RecoveryInventory } from '@/lib/recovery/types'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'

function makeTestStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
}

const INVENTORY: RecoveryInventory = {
  recoverable: true,
  contentId: 'cid-1',
  device: {
    deviceId: 'd',
    deviceLabel: 'l',
    capturedAt: 1,
    tabs: [
      {
        tabKey: 'k',
        tabName: 'work',
        panes: [
          {
            paneId: 'p1',
            kind: 'terminal',
            mode: 'claude',
            shell: null,
            cwd: '/w',
            payload: {},
            sessionRef: { provider: 'claude', sessionId: 'S2' },
            ledgerState: 'bound',
            live: false,
          },
        ],
      },
    ],
  },
  otherDevices: [],
  ledgerOnly: [],
}

describe('RecoveryOfferPanel with a persisted layout at boot', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(getRecoveryInventory).mockReset()
  })

  afterEach(() => cleanup())

  it('renders nothing and never fetches when there is no pending offer (D1)', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    // Give any (wrongly scheduled) fetch a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(getRecoveryInventory)).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('re-offers a pending offer, anchoring bootAgoMs to the ORIGINAL boot (D2)', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const pendingBootAt = 500
    setPendingOffer('cid-1', pendingBootAt)
    const t0 = Date.now()
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalledTimes(1)
    const [clientInstanceId, bootAgoMs] = vi.mocked(getRecoveryInventory).mock.calls[0]
    expect(clientInstanceId).toBe('client-me')
    // Anchored to the pending offer's bootAt (500), NOT this module-load's
    // bootCapturedAtMs (1000): expected ~ t0 - 500, with test-jitter slack.
    expect(Math.abs(bootAgoMs - (t0 - pendingBootAt))).toBeLessThan(200)
  })
})
