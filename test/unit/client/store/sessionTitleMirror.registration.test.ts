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
 *
 * Unified agent names (Task 5): the mirror serves the RETAINED legacy scope
 * only — the fixture is a kilroy pane (out of scope); scoped agent panes are
 * excluded (pinned in sessionTitleMirror.test.ts).
 */
describe('production store session-title mirror registration', () => {
  it('mirrors a session-directory title through the production middleware chain', () => {
    const tabId = 'mirror-reg-tab'
    const paneId = 'mirror-reg-pane'
    const sessionId = '11111111-2222-4333-8444-555555555555'
    store.dispatch(addTab({ id: tabId, title: 'Mirror registration' }))
    store.dispatch(initLayout({
      tabId,
      paneId,
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionId,
        sessionType: 'kilroy',
        sessionRef: { provider: 'claude', sessionId },
      },
    }))
    store.dispatch(commitSessionWindowVisibleRefresh({
      surface: 'sidebar',
      projects: [{
        projectPath: '/mirror-reg',
        sessions: [{
          provider: 'claude',
          sessionId,
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
