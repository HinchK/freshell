import { describe, expect, it } from 'vitest'
import { store } from '@/store'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import { foldTerminalInventoryTitles } from '@/lib/terminal-inventory-titles'

/**
 * Registration pin: the terminal-inventory title replay middleware must be
 * wired into the PRODUCTION store's middleware chain
 * (src/store/store.ts), not just hand-installed in test stores — otherwise
 * a recovered pane that binds its terminalId AFTER the boot frame never
 * receives its cached registry title (delta review round 2, finding 2).
 * jsdom localStorage starts empty and the slices rehydrate at module eval,
 * so the store singleton must be imported before any storage seeding
 * (same import-order rule as sessionTitleMirror.registration.test.ts).
 */
describe('production store terminal-inventory title replay registration', () => {
  it('replays a cached inventory title through the production middleware chain when the binding action lands the terminalId', () => {
    const tabId = 'inventory-replay-reg-tab'
    const paneId = 'inventory-replay-reg-pane'
    store.dispatch(addTab({ id: tabId, title: 'Replay registration' }))
    store.dispatch(initLayout({
      tabId,
      paneId,
      content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-replay-reg', status: 'creating' },
    }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 'replay-reg-term', title: 'Registered replay title' }])).toBe(0)
    store.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'terminal', mode: 'shell', shell: 'wsl',
          createRequestId: 'cr-replay-reg', terminalId: 'replay-reg-term', status: 'running',
        },
      },
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Registered replay title')
    expect(store.getState().panes.paneTitleSetByUser[tabId]?.[paneId]).toBeFalsy()
  })
})
