import { describe, it, expect, afterEach } from 'vitest'
import {
  recordPaneFocusBeforeUnmount,
  shouldFocusPaneOnEligibleMount,
  resetPaneFocusOwnershipForTests,
} from '@/lib/pane-focus-ownership'

describe('pane-focus-ownership', () => {
  afterEach(() => {
    resetPaneFocusOwnershipForTests()
    document.body.innerHTML = ''
  })

  it('unknown pane ids default to may-focus (fresh creation UX unchanged)', () => {
    expect(shouldFocusPaneOnEligibleMount('never-seen')).toBe(true)
  })

  it('records "owned" when focus is inside the pane subtree at unmount time', () => {
    document.body.innerHTML = `<div data-pane-id="p1"><input id="i1"></div>`
    const input = document.getElementById('i1') as HTMLInputElement
    input.focus()
    recordPaneFocusBeforeUnmount('p1')
    expect(shouldFocusPaneOnEligibleMount('p1')).toBe(true)
  })

  it('records "not owned" when focus is outside the pane subtree (e.g. in app chrome)', () => {
    document.body.innerHTML = `
      <div data-pane-id="p2"><input id="i2"></div>
      <nav><input id="sidebar-filter"></nav>`
    const chrome = document.getElementById('sidebar-filter') as HTMLInputElement
    chrome.focus()
    recordPaneFocusBeforeUnmount('p2')
    expect(shouldFocusPaneOnEligibleMount('p2')).toBe(false)
  })

  it('records nothing when the pane root is absent (bare unit renders / already detaching)', () => {
    // no [data-pane-id="p3"] in the document
    recordPaneFocusBeforeUnmount('p3')
    expect(shouldFocusPaneOnEligibleMount('p3')).toBe(true) // still unknown/default
  })

  it('records "not owned" when nothing is focused (body)', () => {
    document.body.innerHTML = `<div data-pane-id="p4"><input id="i4"></div>`
    expect(document.activeElement).toBe(document.body)
    recordPaneFocusBeforeUnmount('p4')
    expect(shouldFocusPaneOnEligibleMount('p4')).toBe(false)
  })
})
