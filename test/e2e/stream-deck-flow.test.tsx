// E2E flow suite for the Stream Deck stack: full user journeys through the
// REAL Redux store + REAL DeckController + fake transport (FakeDeckDevice).
// Only ws-client is mocked (to record outbound frames); renderers are
// spec-encoding stubs because jsdom has no real canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
import freshAgentReducer, { addPermissionRequest } from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer, { upsertClaudeActivity } from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer from '@/store/settingsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { FakeDeckDevice, PLUS_CAPS } from '@/deck/fake-deck-device'
import type { DeckCapabilities } from '@/deck/deck-device'
import { DeckController } from '@/deck/deck-controller'
import type { KeySpec } from '@/deck/frame'
import { registerTerminalTextReader, resetTerminalTextRegistryForTests } from '@/deck/terminal-text-registry'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

type DeckStoreOpts = {
  tabs?: number // tab count (t1..tN), default 2
  busy?: string[] // terminalIds marked busy via claudeActivity
  attention?: Record<string, boolean> // attentionByTab seed
  freshAgentTab?: number // 1-based tab index hosting the fresh-agent pane (session s1)
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
}

// Local extraction of the deck-controller unit-suite fixture builder: tabs
// t1..tN, terminal leaf panes p1..pN with terminalId term-N (mode 'claude');
// freshAgentTab makes that tab a fresh-agent pane bound to session s1.
function makeDeckStore(opts: DeckStoreOpts = {}) {
  const tabCount = opts.tabs ?? 2
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
  }))
  const layouts: Record<string, unknown> = {}
  const activePane: Record<string, string> = {}
  for (let i = 1; i <= tabCount; i++) {
    const isAgent = opts.freshAgentTab === i
    layouts[`t${i}`] = {
      type: 'leaf', id: `p${i}`,
      content: isAgent
        ? { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: `c${i}`, status: 'running' }
        : { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: 'running', mode: 'claude' },
    }
    activePane[`t${i}`] = `p${i}`
  }
  const busyByTerminalId = Object.fromEntries(
    (opts.busy ?? []).map((terminalId) => [terminalId, { terminalId, phase: 'busy', updatedAt: 1 }]),
  )
  return configureStore({
    reducer,
    preloadedState: {
      tabs: { tabs, activeTabId: 't1', renameRequestTabId: null, tombstones: [] },
      panes: {
        layouts, activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: {
        byTerminalId: busyByTerminalId,
        lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {},
      },
      turnCompletion: {
        seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [],
        attentionByTab: opts.attention ?? {}, attentionByPane: {},
      },
      freshAgent: {
        sessions: opts.freshAgentTab
          ? {
              [s1Key]: {
                sessionKey: s1Key, threadId: 's1', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1',
                status: opts.freshAgentRunning ? 'running' : 'idle', streamingActive: false,
                pendingPermissions: opts.pendingPermissions ?? {}, pendingQuestions: {},
              },
            }
          : {},
        pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
      },
    } as never,
  })
}

// Spec-encoding renderer + decoder: the "pixels" are the KeySpec JSON, so
// tests can decode exactly what landed on the fake device.
function encodeSpec(spec: KeySpec): Uint8ClampedArray {
  return new TextEncoder().encode(JSON.stringify(spec)) as unknown as Uint8ClampedArray
}
function decodeKey(device: FakeDeckDevice, key: number): KeySpec | null {
  const buf = device.keyImages.get(key)
  return buf ? JSON.parse(new TextDecoder().decode(buf as unknown as Uint8Array)) : null
}
function decodeStrip(device: FakeDeckDevice): string | null {
  return device.stripImage ? new TextDecoder().decode(device.stripImage.rgba as unknown as Uint8Array) : null
}

type DeckSettings = { brightness: number; idleBrightness: number; idleTimeoutSeconds: number }
const defaultSettings = (): DeckSettings => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 })

let activeController: DeckController | null = null

function setup(opts: DeckStoreOpts = {}, caps?: DeckCapabilities, settings: () => DeckSettings = defaultSettings) {
  const store = makeDeckStore(opts)
  const device = new FakeDeckDevice(caps)
  const controller = new DeckController({
    store: store as never,
    device,
    renderKey: (spec) => encodeSpec(spec),
    renderStrip: (text) => new TextEncoder().encode(text) as unknown as Uint8ClampedArray,
    settings,
  })
  controller.start()
  activeController = controller
  return { store, device, controller }
}

function holdKey(device: FakeDeckDevice, keyIndex: number, ms: number) {
  device.emit({ type: 'keyDown', keyIndex })
  vi.advanceTimersByTime(ms)
  device.emit({ type: 'keyUp', keyIndex })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sendMock.mockClear()
})
afterEach(() => {
  activeController?.stop()
  activeController = null
  resetTerminalTextRegistryForTests()
  vi.useRealTimers()
})

describe('Stream Deck e2e flows (fake transport, real store)', () => {
  it('tabs appear on keys with titles, previews, and rings', () => {
    registerTerminalTextReader('term-1', () => ['$ npm test', 'PASS'])
    const { device } = setup({
      tabs: 3,
      busy: ['term-1'],
      attention: { t2: true },
      freshAgentTab: 3,
      pendingPermissions: { r1: { requestId: 'r1' } },
    })
    // Status-priority sort: t2 attention (greenFill) < t3 waiting fresh-agent
    // (greenIcon) < t1 busy (blueIcon), so busy t1 lands after the others.
    expect(decodeKey(device, 0)).toEqual({
      kind: 'tab', tabId: 't2', title: 'tab2', previewLines: [], ring: 'green', active: false,
      fill: 'green', dot: 'green', icons: [],
    })
    expect(decodeKey(device, 1)).toEqual({
      kind: 'tab', tabId: 't3', title: 'tab3', previewLines: [], ring: 'amber', active: false,
      fill: 'none', dot: 'green', icons: [],
    })
    expect(decodeKey(device, 2)).toEqual({
      // previewLines is always [] since Task 8 (field dies in Task 9); the
      // registered term-1 reader above is deliberately ignored.
      kind: 'tab', tabId: 't1', title: 'tab1', previewLines: [], ring: 'blue', active: true,
      fill: 'none', dot: 'blue', icons: [],
    })
  })

  it('press focuses the tab in this browser', () => {
    const { store, device } = setup({ tabs: 3, attention: { t2: true } })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    // t2 has attention (greenFill) so it sorts to key 0; after focus+dismiss
    // all tabs are greenIcon again and t2 repaints at key 1 in tab-bar order
    holdKey(device, 0, 100)
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t2')
    expect(state.turnCompletion.attentionByTab.t2).toBeFalsy()
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', active: true, ring: null })
  })

  it('ring colors track state changes', () => {
    const { store, device } = setup({ tabs: 3, freshAgentTab: 3 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', ring: null })
    store.dispatch(upsertClaudeActivity({ terminals: [{ terminalId: 'term-1', phase: 'busy', updatedAt: 1 }] }))
    // busy t1 (blueIcon) sorts after the green-icon tabs -> key 2
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't1', ring: 'blue' })
    store.dispatch(markTabAttention({ tabId: 't1' }))
    // green outranks blue even while the tab is still busy; active+attention
    // (barTop) sorts t1 back to key 0
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', ring: 'green' })
    store.dispatch(addPermissionRequest({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r9',
    }))
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't3', ring: 'amber' })
  })

  it('overflow paging with wrap on the 6-key profile', () => {
    const { device } = setup({ tabs: 8 })
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    device.press(5)
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 2, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't6' })
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't8' })
    expect(decodeKey(device, 3)).toEqual({ kind: 'empty' })
    device.press(5)
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
  })

  it('long-press APPROVE sends the exact allow frame and closes the layer', () => {
    const { device } = setup({ freshAgentTab: 2, pendingPermissions: { r1: { requestId: 'r1' } } })
    holdKey(device, 1, 600)
    expect(decodeKey(device, 0)).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: true })
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: false })
    device.press(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    })
    expect(frame.decision).toEqual({ behavior: 'allow' })
    expect('updatedInput' in frame.decision).toBe(false)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
  })

  it('STOP with escalation on a terminal pane; abandoned layer auto-closes', () => {
    const { device } = setup({ busy: ['term-1'] })
    // busy t1 (blueIcon) sorts after green-icon t2 -> t1 lands on key 1
    holdKey(device, 1, 600)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
    // second STOP within the 5s escalation window -> Ctrl+C
    holdKey(device, 1, 600)
    device.press(2)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
    // a layer left open auto-closes after the 10s timeout
    holdKey(device, 1, 600)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
    vi.advanceTimersByTime(10_500)
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't1' })
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('idle dim & wake: dims after the timeout, wakes on press without swallowing it', () => {
    const { store, device } = setup(
      { tabs: 2 }, undefined,
      () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 1 }),
    )
    vi.advanceTimersByTime(1_500)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    holdKey(device, 1, 100)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('Deck+ dials and strip: cycle, page clamp, strip text, touch wake', () => {
    const { store, device } = setup(
      { tabs: 10, busy: ['term-1'], freshAgentTab: 2, pendingPermissions: { r1: { requestId: 'r1' } } },
      PLUS_CAPS,
      () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 1 }),
    )
    // no pager key on the dial profile: all 8 keys are tab tiles.
    // Sorted order: busy t1 (blueIcon) lands last, so page 1 shows t2..t9.
    for (let k = 0; k < PLUS_CAPS.keyCount; k++) {
      expect(decodeKey(device, k)).toMatchObject({ kind: 'tab', tabId: `t${k + 2}` })
    }
    expect(decodeStrip(device)).toBe('tab1  |  page 1/2  |  1 busy  1 waiting')
    // dial 0 cycles the active tab and wraps in both directions
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // wraps first -> last
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t1') // wraps last -> first
    // dial 1 pages, clamped at the last page (sorted list: [t2..t10, t1])
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 1 })
    expect(decodeStrip(device)).toContain('page 2/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't10' })
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 1 })
    expect(decodeStrip(device)).toContain('page 2/2') // clamped
    device.emit({ type: 'dialPress', dialIndex: 1 })
    expect(decodeStrip(device)).toContain('page 1/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2' })
    // touchTap while dimmed restores brightness
    vi.advanceTimersByTime(1_500)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    device.emit({ type: 'touchTap' })
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
  })

  it('graceful teardown: stop() clears the device and halts repainting', () => {
    const { store, device, controller } = setup({ tabs: 2 })
    expect(device.keyImages.size).toBeGreaterThan(0)
    controller.stop()
    expect(device.cleared).toBe(true)
    expect(device.keyImages.size).toBe(0)
    const brightnessCalls = device.brightnessHistory.length
    store.dispatch(markTabAttention({ tabId: 't1' }))
    vi.advanceTimersByTime(5_000)
    expect(device.keyImages.size).toBe(0) // no repaints after stop
    expect(device.stripImage).toBeNull()
    expect(device.brightnessHistory.length).toBe(brightnessCalls)
  })
})
