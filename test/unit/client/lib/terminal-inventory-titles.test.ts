import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { foldTerminalInventoryTitles } from '@/lib/terminal-inventory-titles'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle } from '@/store/panesSlice'

function seedTerminalPane(store: ReturnType<typeof buildStore>, tabId: string, paneId: string, terminalId: string) {
  store.dispatch(addTab({ id: tabId, title: tabId }))
  store.dispatch(initLayout({
    tabId, paneId,
    content: { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId, createRequestId: `cr-${terminalId}`, status: 'running' },   // 'running' — a real TerminalStatus (src/store/types.ts:1) for an anchored pane, per paneSessionTitleSync.test.ts's terminal fixtures
  }))
}

function buildStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
}

describe('foldTerminalInventoryTitles', () => {
  it('writes the inventory title into the matching pane (auto source, not user-set)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    const n = foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Renamed by sweep' }])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Renamed by sweep')
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBeFalsy()
  })

  it('never overwrites a user-set pane title (and does not count it as a fold)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'My own name', setByUser: true }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Sweep title' }])).toBe(0)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('My own name')
  })

  it('skips rows without a title and terminals with no matching pane', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9' }, { terminalId: 't-unknown', title: 'X' }])).toBe(0)
  })

  it('does not dispatch when the pane title already equals the inventory title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Same', setByUser: false }))
    const before = store.getState()
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Same' }])).toBe(0)
    expect(store.getState().panes).toBe(before.panes)
  })

  it('folds every differing row in one call', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-a', 'pane-a', 't-a-9')
    seedTerminalPane(store, 'tab-b', 'pane-b', 't-b-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-a', paneId: 'pane-a', title: 'A title', setByUser: false }))
    const n = foldTerminalInventoryTitles(store, [
      { terminalId: 't-a-9', title: 'A title' },
      { terminalId: 't-b-9', title: 'B title' },
    ])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-b']['pane-b']).toBe('B title')
  })
})
