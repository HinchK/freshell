import { describe, expect, it } from 'vitest'
import { store } from '@/store'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import { commitSessionWindowVisibleRefresh } from '@/store/sessionsSlice'

/**
 * Registration pin: the mirror must be wired into the PRODUCTION store's
 * middleware chain (src/store/store.ts), not just hand-installed in test
 * stores. The production registration has no other test — this file is it.
 * jsdom localStorage starts empty and the slices rehydrate at module eval,
 * so the store singleton must be imported before any storage seeding.
 */
describe('production store session-title mirror registration', () => {
  it('mirrors a session-directory title through the production middleware chain', () => {
    const tabId = 'mirror-reg-tab'
    const paneId = 'mirror-reg-pane'
    store.dispatch(addTab({ id: tabId, title: 'Mirror registration' }))
    store.dispatch(initLayout({
      tabId,
      paneId,
      content: {
        kind: 'fresh-agent',
        provider: 'opencode',
        sessionId: 'mirror-reg-session',
        sessionType: 'freshopencode',
        sessionRef: { provider: 'opencode', sessionId: 'mirror-reg-session' },
      },
    }))
    store.dispatch(commitSessionWindowVisibleRefresh({
      surface: 'sidebar',
      projects: [{
        projectPath: '/mirror-reg',
        sessions: [{
          provider: 'opencode',
          sessionId: 'mirror-reg-session',
          projectPath: '/mirror-reg',
          lastActivityAt: 1_000,
          title: 'Registered mirror title',
        }],
      }],
    }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Registered mirror title')
    expect(store.getState().panes.paneTitleSetByUser[tabId]?.[paneId]).toBeFalsy()
  })
})
