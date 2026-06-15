import { describe, it, expect } from 'vitest'
import { UiLayoutSyncSchema } from '../../../server/agent-api/layout-schema'

describe('UiLayoutSyncSchema', () => {
  it('accepts layout sync payloads', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
        fallbackSessionRef: {
          provider: 'codex',
          sessionId: 'older-open',
        },
      }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.tabs[0]?.fallbackSessionRef).toEqual({
      provider: 'codex',
      sessionId: 'older-open',
    })
  })

  it('rejects fallbackSessionRef values that smuggle server locality into canonical identity', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
        fallbackSessionRef: {
          provider: 'codex',
          sessionId: 'older-open',
          serverInstanceId: 'srv-local',
        },
      }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts fresh-agent pane payloads in synchronized layouts', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{ id: 'tab_a', title: 'alpha' }],
      activeTabId: 'tab_a',
      layouts: {
        tab_a: {
          type: 'leaf',
          id: 'pane_a',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
          },
        },
      },
      activePane: { tab_a: 'pane_a' },
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })

    expect(parsed.success).toBe(true)
  })

  it('normalizes legacy agent-chat leaves in nested split layout sync payloads', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{ id: 'tab_a', title: 'alpha' }],
      activeTabId: 'tab_a',
      layouts: {
        tab_a: {
          type: 'split',
          id: 'split-root',
          direction: 'horizontal',
          sizes: [55, 45],
          children: [
            {
              type: 'leaf',
              id: 'pane_agent',
              content: {
                kind: 'agent-chat',
                provider: 'freshclaude',
                createRequestId: 'req-agent',
                status: 'idle',
                resumeSessionId: '00000000-0000-4000-8000-000000000001',
              },
            },
            {
              type: 'leaf',
              id: 'pane_terminal',
              content: {
                kind: 'terminal',
                createRequestId: 'req-terminal',
                status: 'running',
                mode: 'shell',
              },
            },
          ],
        },
      },
      activePane: { tab_a: 'pane_agent' },
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const raw = JSON.stringify(parsed.data.layouts.tab_a)
    expect(raw).not.toContain('"agent-chat"')
    expect(parsed.data.layouts.tab_a.children[0].content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
  })
})
