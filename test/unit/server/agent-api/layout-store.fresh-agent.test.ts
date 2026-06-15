import { describe, expect, it } from 'vitest'

import { LayoutStore } from '../../../../server/agent-api/layout-store.js'

describe('LayoutStore fresh-agent titles', () => {
  it('derives a fresh-agent pane title from sessionType', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab-1', title: 'Fresh Agent' }],
      activeTabId: 'tab-1',
      activePane: { 'tab-1': 'pane-1' },
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            provider: 'codex',
            sessionType: 'freshcodex',
          },
        },
      },
    }, 'conn-1')

    expect(store.listPanes('tab-1')[0]?.title).toBe('Freshcodex')
  })

  it('normalizes nested legacy agent-chat leaves before storing ui layout snapshots', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab-1', title: 'Legacy Agent' }],
      activeTabId: 'tab-1',
      activePane: { 'tab-1': 'pane-agent' },
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-root',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-agent',
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
              id: 'pane-terminal',
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
    }, 'conn-1')

    const agentPane = store.getPaneSnapshot('pane-agent')
    const terminalPane = store.getPaneSnapshot('pane-terminal')

    expect(JSON.stringify(agentPane)).not.toContain('"agent-chat"')
    expect(agentPane?.paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(terminalPane?.paneContent).toMatchObject({
      kind: 'terminal',
      mode: 'shell',
    })
  })

  it('normalizes existing fresh-agent panes with bad Claude session refs before storing snapshots', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab-1', title: 'Fresh Agent' }],
      activeTabId: 'tab-1',
      activePane: { 'tab-1': 'pane-agent' },
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-agent',
          content: {
            kind: 'fresh-agent',
            provider: 'claude',
            sessionType: 'freshclaude',
            createRequestId: 'req-agent',
            status: 'idle',
            sessionRef: { provider: 'claude', sessionId: 'named-alias' },
            initialCwd: '/repo',
            showTimecodes: true,
          },
        },
      },
    }, 'conn-1')

    const agentPane = store.getPaneSnapshot('pane-agent')

    expect(agentPane?.paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      initialCwd: '/repo',
      showTimecodes: true,
    })
    expect(agentPane?.paneContent?.sessionRef).toBeUndefined()
  })
})
