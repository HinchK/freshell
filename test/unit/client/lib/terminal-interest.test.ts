import { describe, expect, it, vi } from 'vitest'
import { createInterestPublisher, selectTerminalInterest, type InterestPane, type InterestState } from '@/lib/terminal-interest'
import { getClientLogLevel, setClientLogLevel } from '@/lib/client-logger'
const leaf = (id: string, terminalId: string): InterestPane => ({ type: 'leaf', id, content: { kind: 'terminal', terminalId } })
function state(): InterestState {
  return { tabs: { activeTabId: 'tab' }, panes: {
    layouts: { tab: { type: 'split', id: 'root', children: [leaf('a', 'A'), leaf('b', 'B')] } },
    activePane: { tab: 'a' }, zoomedPane: {},
  } }
}
describe('terminal presentation interest', () => {
  it('distinguishes focused, visible, and hidden without changing the layout', () => {
    const input = state()
    expect(selectTerminalInterest(input, false)).toEqual({ focusedTerminalId: 'A', visibleTerminalIds: ['A', 'B'], claimedTerminalIds: ['A', 'B'] })
    expect(selectTerminalInterest(input, true)).toEqual({ focusedTerminalId: null, visibleTerminalIds: [], claimedTerminalIds: ['A', 'B'] })
    expect(input).toEqual(state())
  })
  it('reflects zoom without creating another attachment', () => {
    const input = state(); input.panes.zoomedPane = { tab: 'b' }
    expect(selectTerminalInterest(input, false)).toEqual({ focusedTerminalId: 'B', visibleTerminalIds: ['B'], claimedTerminalIds: ['A', 'B'] })
  })
  it('aggregates multiple panes showing the same terminal', () => {
    const input = state(); input.panes.layouts.tab = { type: 'split', id: 'root', children: [leaf('a', 'A'), leaf('b', 'A')] }
    expect(selectTerminalInterest(input, false)).toEqual({ focusedTerminalId: 'A', visibleTerminalIds: ['A'], claimedTerminalIds: ['A'] })
  })

  // ── Hidden-pane lifetime claims (responsive-terminal-restore WS1) ──

  it('claims every terminal across ALL tab layouts, including hidden tabs', () => {
    const input = state()
    input.panes.layouts['tab-hidden-1'] = { type: 'leaf', id: 'c', content: { kind: 'terminal', terminalId: 'C' } }
    input.panes.layouts['tab-hidden-2'] = { type: 'split', id: 'root2', children: [leaf('d', 'D'), leaf('e', 'E')] }
    expect(selectTerminalInterest(input, false)).toEqual({
      focusedTerminalId: 'A',
      visibleTerminalIds: ['A', 'B'],
      claimedTerminalIds: ['A', 'B', 'C', 'D', 'E'],
    })
  })

  it('skips panes without a terminal id (creating, picker, non-terminal kinds)', () => {
    const input = state()
    input.panes.layouts['tab-hidden-1'] = {
      type: 'leaf',
      id: 'c',
      content: { kind: 'terminal', terminalId: undefined },
    } as unknown as InterestPane
    expect(selectTerminalInterest(input, false)).toEqual({
      focusedTerminalId: 'A',
      visibleTerminalIds: ['A', 'B'],
      claimedTerminalIds: ['A', 'B'],
    })
  })

  it('refuses the whole snapshot when a hidden layout is cyclic or oversized', () => {
    // A cyclic layout anywhere must refuse the whole snapshot (the server
    // keeps the last accepted state) rather than misclassify terminals.
    const cyclic: InterestPane = { type: 'split', id: 'root-c', children: [] } as unknown as InterestPane
    cyclic.children = [leaf('x', 'X'), cyclic]
    const input = state()
    input.panes.layouts['tab-hidden-1'] = cyclic
    expect(selectTerminalInterest(input, false)).toBeNull()
  })

  it('keeps failed sends retryable and reasserts state after ready', () => {
    const sent: unknown[] = []; let allowed = false
    const publisher = createInterestPublisher({
      read: () => selectTerminalInterest(state(), false),
      send: (snapshot) => { if (!allowed) return false; sent.push(snapshot); return true },
      scheduleTask: () => () => {},
    })
    publisher.flushNow(); allowed = true; publisher.flushNow(); publisher.flushNow()
    expect(sent).toHaveLength(1)
    publisher.invalidate(); publisher.flushNow(true); expect(sent).toHaveLength(2)
    publisher.dispose(); publisher.flushNow(true); expect(sent).toHaveLength(2)
  })

  it('keeps the server on the last accepted snapshot when the selector refuses, and logs it', () => {
    let refused = false
    const sent: unknown[] = []
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const previousLevel = getClientLogLevel()
    setClientLogLevel('debug')
    const publisher = createInterestPublisher({
      read: () => (refused ? null : selectTerminalInterest(state(), false)),
      send: (snapshot) => { sent.push(snapshot); return true },
      scheduleTask: () => () => {},
    })
    publisher.flushNow()
    expect(sent).toHaveLength(1)
    refused = true
    publisher.flushNow(true) // forced flush still must not send a null/empty state
    expect(sent).toHaveLength(1)
    expect(debugSpy).toHaveBeenCalled()
    debugSpy.mockRestore()
    setClientLogLevel(previousLevel)
  })
})
