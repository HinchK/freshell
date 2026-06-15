import { describe, expect, it } from 'vitest'

import { sanitizePaneSnapshot } from '@/components/TabsView'
import { buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
import { normalizeTabRegistryRecordsForSync } from '@/store/tabRegistrySync'
import type { PaneNode } from '@/store/paneTypes'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'

const NOW = 1_780_000_000_000

function makeRecord(overrides: Partial<RegistryTabRecord> = {}): RegistryTabRecord {
  return {
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-1',
    deviceId: 'device-1',
    deviceLabel: 'Laptop',
    tabName: 'Agent',
    status: 'open',
    revision: 1,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function legacyAgentPane(payload: Record<string, unknown>) {
  return {
    paneId: 'pane-agent',
    kind: 'agent-chat',
    payload: {
      provider: 'freshclaude',
      createRequestId: 'req-agent',
      status: 'idle',
      ...payload,
    },
  } as never
}

function freshAgentPane(payload: Record<string, unknown>) {
  return {
    paneId: 'pane-agent',
    kind: 'fresh-agent',
    payload: {
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-agent',
      status: 'idle',
      ...payload,
    },
  } as never
}

describe('client tab registry fresh-agent migration', () => {
  it('serializes live fresh-agent pane snapshots without agent-chat kinds', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-fresh',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-fresh',
        status: 'idle',
        sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000001' },
        showTools: true,
      },
    }

    const record = buildOpenTabRegistryRecord({
      tab: { id: 'tab-1', title: 'Agent', status: 'running', mode: 'claude' } as never,
      layout,
      serverInstanceId: 'srv-1',
      deviceId: 'device-1',
      deviceLabel: 'Laptop',
      updatedAt: NOW,
      revision: 1,
    })

    expect(JSON.stringify(record)).not.toContain('"agent-chat"')
    expect(record.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        sessionType: 'freshclaude',
        provider: 'claude',
        showTools: true,
      },
    })
  })

  it('normalizes incoming registry records in tabRegistrySync', () => {
    const normalized = normalizeTabRegistryRecordsForSync([
      makeRecord({
        panes: [
          legacyAgentPane({
            resumeSessionId: '00000000-0000-4000-8000-000000000002',
          }),
        ],
      }) as never,
    ])

    expect(JSON.stringify(normalized)).not.toContain('"agent-chat"')
    expect(normalized[0]?.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000002' },
      },
    })
  })

  it('normalizes reducer payloads containing legacy registry panes', () => {
    const state = tabRegistryReducer(undefined, setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [
        makeRecord({
          panes: [
            legacyAgentPane({
              sessionRef: { provider: 'claude', sessionId: 'named-alias' },
            }),
          ],
        }) as never,
      ],
      closed: [],
    }))

    expect(JSON.stringify(state.remoteOpen)).not.toContain('"agent-chat"')
    expect(state.remoteOpen[0]?.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      },
    })
  })

  it('normalizes incoming fresh-agent registry records with bad Claude session refs', () => {
    const normalized = normalizeTabRegistryRecordsForSync([
      makeRecord({
        panes: [
          freshAgentPane({
            sessionRef: { provider: 'claude', sessionId: 'named-alias' },
            resumeSessionId: '00000000-0000-4000-8000-000000000004',
            showTimecodes: true,
          }),
        ],
      }) as never,
    ])

    expect(normalized[0]?.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
        showTimecodes: true,
      },
    })
    expect(normalized[0]?.panes[0]?.payload.sessionRef).toBeUndefined()
    expect(normalized[0]?.panes[0]?.payload.resumeSessionId).toBeUndefined()
  })

  it('reopens old registry panes as fresh-agent inputs with durable identity', () => {
    const record = makeRecord()
    const content = sanitizePaneSnapshot(record, legacyAgentPane({
      resumeSessionId: '00000000-0000-4000-8000-000000000003',
    }))

    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000003' },
    })
  })

  it('reopens old registry panes with non-canonical aliases as restore-error fresh-agent inputs', () => {
    const record = makeRecord()
    const content = sanitizePaneSnapshot(record, legacyAgentPane({
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
    }))

    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect((content as { sessionRef?: unknown }).sessionRef).toBeUndefined()
  })

  it('reopens fresh-agent registry panes through durable identity instead of stale live session id', () => {
    const record = makeRecord({ serverInstanceId: 'srv-1' })
    const content = sanitizePaneSnapshot(record, freshAgentPane({
      sessionId: 'stale-live-session',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000005' },
    }), 'srv-1')

    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000005' },
    })
    expect((content as { sessionId?: unknown }).sessionId).toBeUndefined()
  })
})
