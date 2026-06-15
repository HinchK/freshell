import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import { createTabsRegistryStore, type TabsRegistryStore } from '../../../../server/tabs-registry/store.js'
import { TabRegistryRecordSchema, type RegistryTabRecord } from '../../../../server/tabs-registry/types.js'

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
      provider: 'claude',
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

async function replace(store: TabsRegistryStore, records: RegistryTabRecord[]) {
  return store.replaceClientSnapshot({
    deviceId: 'device-1',
    deviceLabel: 'Laptop',
    clientInstanceId: 'window-1',
    snapshotRevision: 1,
    records,
  })
}

describe('server tabs registry fresh-agent migration', () => {
  let tempDir: string
  let store: TabsRegistryStore

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-fresh-agent-'))
    store = await createTabsRegistryStore(tempDir, { now: () => NOW })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('parses legacy agent-chat registry records as fresh-agent records', () => {
    const parsed = TabRegistryRecordSchema.parse(makeRecord({
      panes: [
        legacyAgentPane({
          resumeSessionId: '00000000-0000-4000-8000-000000000001',
        }),
      ],
    }) as never)

    expect(JSON.stringify(parsed)).not.toContain('"agent-chat"')
    expect(parsed.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000001' },
      },
    })
  })

  it('normalizes legacy records before persistence and before query results are served', async () => {
    await replace(store, [
      makeRecord({
        panes: [
          legacyAgentPane({
            sessionRef: { provider: 'claude', sessionId: 'named-alias' },
          }),
        ],
      }) as never,
    ])

    const result = await store.query({
      deviceId: 'device-2',
      clientInstanceId: 'window-2',
      closedTabRetentionDays: 30,
    })

    expect(JSON.stringify(result)).not.toContain('"agent-chat"')
    expect(result.remoteOpen[0]?.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      },
    })
  })

  it('normalizes fresh-agent records with bad Claude session refs before persistence and query', async () => {
    await replace(store, [
      makeRecord({
        panes: [
          freshAgentPane({
            sessionRef: { provider: 'claude', sessionId: 'named-alias' },
            resumeSessionId: '00000000-0000-4000-8000-000000000004',
            showTools: true,
          }),
        ],
      }) as never,
    ])

    const result = await store.query({
      deviceId: 'device-2',
      clientInstanceId: 'window-2',
      closedTabRetentionDays: 30,
    })

    expect(result.remoteOpen[0]?.panes[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
        showTools: true,
      },
    })
    expect(result.remoteOpen[0]?.panes[0]?.payload.sessionRef).toBeUndefined()
    expect(result.remoteOpen[0]?.panes[0]?.payload.resumeSessionId).toBeUndefined()
  })
})
