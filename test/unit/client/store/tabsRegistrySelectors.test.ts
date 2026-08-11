import { describe, it, expect } from 'vitest'
import {
  deriveRemoteSessionActivity,
  selectRemoteSessionActivity,
  selectSameDeviceSessionKeys,
} from '@/store/selectors/tabsRegistrySelectors'
import type {
  RegistryPaneSnapshot,
  RegistryTabRecord,
} from '@/store/tabRegistryTypes'
import type { RootState } from '@/store/store'

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'device-1',
    deviceLabel: 'device-1',
    tabName: 'freshell',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makePane(payload: Record<string, unknown>): RegistryPaneSnapshot {
  return { paneId: 'pane-1', kind: 'terminal', payload }
}

function makeState(tabRegistry: Record<string, unknown>): RootState {
  return { tabRegistry } as unknown as RootState
}

describe('deriveRemoteSessionActivity', () => {
  it('maps pane sessionKeys to open', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'] })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('marks busySessionKeys busy while identity aliases stay open', () => {
    const record = makeRecord({
      panes: [makePane({
        sessionKeys: ['claude:s1', 'claude:s2'],
        busySessionKeys: ['claude:s1'],
      })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({
      'claude:s1': 'busy',
      'claude:s2': 'open',
    })
  })

  it('derives open from a legacy sessionRef-only payload', () => {
    const record = makeRecord({
      panes: [makePane({ sessionRef: { provider: 'claude', sessionId: 's1' } })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('lets sessionKeys take precedence over a differing legacy sessionRef', () => {
    const record = makeRecord({
      panes: [makePane({
        sessionKeys: ['claude:s1'],
        sessionRef: { provider: 'codex', sessionId: 'x9' },
      })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('lets busy win over open across devices referencing the same session', () => {
    const busyDevice = makeRecord({
      tabKey: 'device-2:tab-1',
      deviceId: 'device-2',
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const openDevice = makeRecord({
      tabKey: 'device-3:tab-1',
      deviceId: 'device-3',
      panes: [makePane({ sessionKeys: ['claude:s1'] })],
    })

    expect(deriveRemoteSessionActivity([openDevice, busyDevice])).toEqual({ 'claude:s1': 'busy' })
    expect(deriveRemoteSessionActivity([busyDevice, openDevice])).toEqual({ 'claude:s1': 'busy' })
  })

  it('ignores panes with missing, empty, or malformed identity', () => {
    const record = makeRecord({
      panes: [
        makePane({}),
        makePane({ sessionKeys: [] }),
        makePane({ busySessionKeys: [] }),
        makePane({ sessionKeys: [''] }),
        makePane({ sessionKeys: ['claude:s1', 42, null] }),
        makePane({ sessionRef: { provider: 'claude' } }),
        makePane({ sessionRef: { provider: '', sessionId: 's1' } }),
        makePane({ sessionRef: { provider: 'claude', sessionId: '' } }),
        makePane({ sessionRef: 'claude:s1' }),
      ],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('ignores panes without a well-formed payload object', () => {
    const record = makeRecord({
      panes: [
        { paneId: 'pane-1', kind: 'terminal' },
        { paneId: 'pane-2', kind: 'terminal', payload: 'claude:s1' },
      ] as unknown as RegistryPaneSnapshot[],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({})
  })

  it('returns an empty map for undefined or empty input', () => {
    expect(deriveRemoteSessionActivity(undefined)).toEqual({})
    expect(deriveRemoteSessionActivity([])).toEqual({})
  })

  it('returns an empty map for a record missing panes', () => {
    const { panes: _panes, ...withoutPanes } = makeRecord({})

    expect(deriveRemoteSessionActivity([withoutPanes as RegistryTabRecord])).toEqual({})
  })
})

describe('selectRemoteSessionActivity', () => {
  it('derives activity from state.tabRegistry.remoteOpen', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const state = makeState({ remoteOpen: [record] })

    expect(selectRemoteSessionActivity(state)).toEqual({ 'claude:s1': 'busy' })
  })

  it('ignores sameDeviceOpen records (same-device never produces rings)', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const state = makeState({ sameDeviceOpen: [record] })

    expect(selectRemoteSessionActivity(state)).toEqual({})
  })

  it('returns an empty map without the tabRegistry slice', () => {
    expect(() => selectRemoteSessionActivity({} as RootState)).not.toThrow()
    expect(selectRemoteSessionActivity({} as RootState)).toEqual({})
  })
})

describe('selectSameDeviceSessionKeys', () => {
  it('collects the key set ignoring color (busy keys included)', () => {
    const record = makeRecord({
      panes: [
        makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s2'] }),
        {
          paneId: 'pane-2',
          kind: 'terminal',
          payload: { sessionRef: { provider: 'codex', sessionId: 'c1' } },
        },
      ],
    })
    const state = makeState({ sameDeviceOpen: [record] })

    expect(selectSameDeviceSessionKeys(state)).toEqual(new Set(['claude:s1', 'claude:s2', 'codex:c1']))
  })

  it('returns an empty set without the tabRegistry slice', () => {
    let keys: Set<string> | undefined
    expect(() => {
      keys = selectSameDeviceSessionKeys({} as RootState)
    }).not.toThrow()
    expect(keys).toBeInstanceOf(Set)
    expect(keys?.size).toBe(0)
  })
})
