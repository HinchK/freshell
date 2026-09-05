import { describe, it, expect, afterEach } from 'vitest'
import {
  recordPaneFocusBeforeUnmount,
  resolveRecordedFocusTarget,
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

  it('remembers WHICH element owned focus and re-resolves it inside a new subtree (descriptor restore)', () => {
    document.body.innerHTML = `<div data-pane-id="p5"><input aria-label="Terminal search"></div>`
    const search = document.querySelector('[aria-label="Terminal search"]') as HTMLInputElement
    search.focus()
    recordPaneFocusBeforeUnmount('p5')
    // Simulate leaf→split remount: fresh subtree, same pane id.
    document.body.innerHTML = `<div data-pane-id="p5"><div class="split-inner"><input aria-label="Terminal search"></div></div>`
    const restored = resolveRecordedFocusTarget('p5')
    expect(restored).toBe(document.querySelector('[aria-label="Terminal search"]'))
  })

  it('returns no restore target when the pane did not own focus', () => {
    document.body.innerHTML = `<div data-pane-id="p6"><input aria-label="Terminal search"></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p6')
    expect(resolveRecordedFocusTarget('p6')).toBeNull()
  })

  it('returns no restore target when the element did not come back (transient in-pane UI)', () => {
    document.body.innerHTML = `<div data-pane-id="p7"><input aria-label="Transient thing"></div>`
    ;(document.querySelector('[aria-label="Transient thing"]') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p7')
    document.body.innerHTML = `<div data-pane-id="p7"><p>remounted without it</p></div>`
    expect(resolveRecordedFocusTarget('p7')).toBeNull()
  })

  it('trims the OLDEST entries beyond the cap instead of wiping the map', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    for (let i = 0; i < 513; i++) {
      const root = document.createElement('div')
      root.setAttribute('data-pane-id', `p-${i}`)
      document.body.appendChild(root)
    }
    for (let i = 0; i < 513; i++) recordPaneFocusBeforeUnmount(`p-${i}`)
    // 513 inserts cross the 512 cap. A whole-map clear would ALSO erase the
    // newest record (p-512), letting its immediate remount focus as "unknown" —
    // exactly the chrome-steal the record exists to prevent. Only p-0 (oldest)
    // may be evicted.
    expect(shouldFocusPaneOnEligibleMount('p-0')).toBe(true) // evicted → unknown
    expect(shouldFocusPaneOnEligibleMount('p-1')).toBe(false) // retained
    expect(shouldFocusPaneOnEligibleMount('p-512')).toBe(false) // newest must survive
  })
})
