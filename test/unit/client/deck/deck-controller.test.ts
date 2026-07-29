import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
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

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

type StoreOpts = {
  tabCount?: number
  claudeBusy?: boolean
  attention?: Record<string, boolean>
  freshAgentTab?: boolean // makes t2 a fresh-agent pane bound to session s1
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
}

// Mirrors the Task 3 fixture builder, parameterized by tab count: tabs t1..tN,
// terminal leaf panes p1..pN with terminalId term-N (mode 'claude'); when
// freshAgentTab is set, t2 becomes a fresh-agent pane bound to session s1.
function makeStore(opts: StoreOpts = {}) {
  const tabCount = opts.tabCount ?? 2
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
  }))
  const layouts: Record<string, unknown> = {}
  const activePane: Record<string, string> = {}
  for (let i = 1; i <= tabCount; i++) {
    const isAgent = !!opts.freshAgentTab && i === 2
    layouts[`t${i}`] = {
      type: 'leaf', id: `p${i}`,
      content: isAgent
        ? { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: `c${i}`, status: 'running' }
        : { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: 'running', mode: 'claude' },
    }
    activePane[`t${i}`] = `p${i}`
  }
  return configureStore({
    reducer,
    preloadedState: {
      tabs: { tabs, activeTabId: 't1', renameRequestTabId: null, tombstones: [] },
      panes: {
        layouts, activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: { byTerminalId: opts.claudeBusy ? { 'term-1': { phase: 'busy' } } : {} },
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

// Spec-recording renderer: encodes the KeySpec JSON into the pixel buffer so
// tests can decode exactly what landed on the device.
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

const settings = () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 })

let activeController: DeckController | null = null

function setup(opts: StoreOpts = {}, caps?: DeckCapabilities) {
  const store = makeStore(opts)
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

function longPress(device: FakeDeckDevice, key: number) {
  device.emit({ type: 'keyDown', keyIndex: key })
  vi.advanceTimersByTime(600)
  device.emit({ type: 'keyUp', keyIndex: key })
}

function shortPress(device: FakeDeckDevice, key: number) {
  device.emit({ type: 'keyDown', keyIndex: key })
  vi.advanceTimersByTime(100)
  device.emit({ type: 'keyUp', keyIndex: key })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sendMock.mockClear()
})
afterEach(() => {
  activeController?.stop()
  activeController = null
  vi.useRealTimers()
})

describe('DeckController', () => {
  it('paints tab tiles in tab order with active ring and asserts brightness on start', () => {
    const { device } = setup()
    expect(device.brightnessHistory[0]).toBe(100)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', title: 'tab1', active: true, ring: null })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', title: 'tab2', active: false })
    expect(decodeKey(device, 2)).toEqual({ kind: 'empty' })
    expect(decodeKey(device, 5)).toEqual({ kind: 'empty' })
  })

  it('short press focuses the tab in the browser and dismisses green', () => {
    const { store, device } = setup({ attention: { t2: true } })
    // t2 has attention (priority 1) so it sorts ahead of green-icon t1 -> key 0
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2', ring: 'green', active: false })
    shortPress(device, 0)
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t2')
    expect(state.turnCompletion.attentionByTab.t2).toBeFalsy()
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', active: true, ring: null })
  })

  it('store changes repaint only changed keys', () => {
    const { store, device } = setup()
    device.keyImages.clear()
    store.dispatch(markTabAttention({ tabId: 't1' }))
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', ring: 'green' })
    expect(device.keyImages.has(1)).toBe(false)
    expect(device.keyImages.has(2)).toBe(false)
  })

  it('overflow paging: pager press advances and wraps', () => {
    const { device } = setup({ tabCount: 8 })
    // MINI: 6 keys -> 5 tab slots + pager at key 5; 8 tabs -> 2 pages
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

  it('long press opens the action layer; BACK closes; 10s auto-closes', () => {
    const { device } = setup()
    longPress(device, 0)
    expect(decodeKey(device, 0)).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: false })
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: false })
    device.press(0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    longPress(device, 0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
    vi.advanceTimersByTime(10_500)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
  })

  it('APPROVE sends the allow frame without updatedInput and closes the layer', () => {
    const { device } = setup({ freshAgentTab: true, pendingPermissions: { r1: { requestId: 'r1' } } })
    longPress(device, 1)
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: true })
    device.press(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
      requestId: 'r1', decision: { behavior: 'allow' },
    })
    expect('updatedInput' in frame.decision).toBe(false)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
  })

  it('disabled APPROVE press keeps the layer open', () => {
    const { device } = setup({ freshAgentTab: true })
    longPress(device, 1)
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: false })
    device.press(1)
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'action', action: 'approve' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('STOP on a busy terminal sends ESC, then Ctrl+C within 5s', () => {
    const { device } = setup({ claudeBusy: true })
    // busy t1 (priority 3) sorts after green-icon t2 -> t1 lands on key 1
    longPress(device, 1)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
    // second stop within the 5s escalation window -> Ctrl+C
    longPress(device, 1)
    device.press(2)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
  })

  it('STOP on a busy fresh-agent pane sends freshAgent.interrupt, never terminal.input', () => {
    const { device } = setup({ freshAgentTab: true, freshAgentRunning: true })
    longPress(device, 1)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toEqual({
      type: 'freshAgent.interrupt', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    // escalation applies only to terminals: a second stop is still an interrupt frame
    longPress(device, 1)
    device.press(2)
    for (const call of sendMock.mock.calls) {
      expect(call[0].type).not.toBe('terminal.input')
    }
  })

  it('idle dim after timeout and wake on key press (wake does not swallow the press)', () => {
    const { store, device } = setup()
    vi.advanceTimersByTime(300_000)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    shortPress(device, 1)
    expect(device.brightnessHistory).toContain(10)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('dials on PLUS: dial 0 cycles with wrap, dial 1 pages with clamp, strip updates', () => {
    const { store, device } = setup({ tabCount: 10 }, PLUS_CAPS)
    expect(decodeStrip(device)).toContain('page 1/2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // wrap-around
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 5 })
    expect(decodeStrip(device)).toContain('page 2/2') // clamped to last page
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't9' })
    device.emit({ type: 'dialPress', dialIndex: 1 })
    expect(decodeStrip(device)).toContain('page 1/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    device.emit({ type: 'dialPress', dialIndex: 0 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // re-focus current active tab
  })
})
