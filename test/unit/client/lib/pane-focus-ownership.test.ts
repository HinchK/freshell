import { describe, it, expect, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout, removeLayout, setActivePane } from '@/store/panesSlice'
import {
  recordPaneFocusBeforeUnmount,
  resolveRecordedFocusTarget,
  schedulePaneFocusRestore,
  shouldFocusPaneOnEligibleMount,
  shouldRecordSuppressAutofocus,
  wirePaneFocusOwnershipInvalidation,
  isPaneFocusRestorePendingForTests,
  resetPaneFocusOwnershipForTests,
} from '@/lib/pane-focus-ownership'

describe('pane-focus-ownership', () => {
  let unsubscribe: (() => void) | null = null
  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
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

  it('describes a sole embedded iframe (no aria/test/placeholder attributes) so embedded-page focus restores', () => {
    document.body.innerHTML = `<div data-pane-id="p8"><iframe title="Browser content"></iframe></div>`
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.focus()
    recordPaneFocusBeforeUnmount('p8')
    document.body.innerHTML = `<div data-pane-id="p8"><div><iframe title="Browser content"></iframe></div></div>`
    expect(resolveRecordedFocusTarget('p8')).toBe(document.querySelector('iframe'))
  })

  it('refreshing an existing record moves it to newest before cap eviction (true LRU)', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    for (let i = 0; i < 512; i++) {
      const root = document.createElement('div')
      root.setAttribute('data-pane-id', `q-${i}`)
      document.body.appendChild(root)
    }
    for (let i = 0; i < 512; i++) recordPaneFocusBeforeUnmount(`q-${i}`)
    // Re-record the oldest pane — it just unmounted again, so its record is
    // FRESH and must not be the first eviction victim.
    recordPaneFocusBeforeUnmount('q-0')
    // Cross the cap once.
    const extra = document.createElement('div')
    extra.setAttribute('data-pane-id', 'q-512')
    document.body.appendChild(extra)
    recordPaneFocusBeforeUnmount('q-512')
    expect(shouldFocusPaneOnEligibleMount('q-0')).toBe(false) // refreshed record survives
    expect(shouldFocusPaneOnEligibleMount('q-1')).toBe(true) // actual oldest evicted → unknown
    expect(shouldFocusPaneOnEligibleMount('q-512')).toBe(false) // newest survives
  })

  it('describes the pane ROOT itself when the shell held focus (:scope sentinel)', () => {
    document.body.innerHTML = `<div data-pane-id="p9" tabindex="-1"><input></div>`
    const root = document.querySelector('[data-pane-id="p9"]') as HTMLElement
    root.focus()
    expect(document.activeElement).toBe(root)
    recordPaneFocusBeforeUnmount('p9')
    document.body.innerHTML = `<div data-pane-id="p9" tabindex="-1"><input></div>`
    expect(resolveRecordedFocusTarget('p9')).toBe(document.querySelector('[data-pane-id="p9"]'))
  })

  it('falls back to the title attribute for title-only controls (pin: title candidate is reached)', () => {
    document.body.innerHTML = `<div data-pane-id="p10"><span title="Sole title" tabindex="-1"></span><iframe></iframe></div>`
    const titled = document.querySelector('[title="Sole title"]') as HTMLElement
    titled.focus()
    recordPaneFocusBeforeUnmount('p10')
    document.body.innerHTML = `<div data-pane-id="p10"><span title="Sole title" tabindex="-1"></span><iframe></iframe></div>`
    expect(resolveRecordedFocusTarget('p10')?.getAttribute('title')).toBe('Sole title')
  })

  it('does NOT overwrite the pre-split descriptor while a restore is in flight (burst splits)', async () => {
    document.body.innerHTML = `<div data-pane-id="p11"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p11')
    // Mount schedules a restore; descriptor is now protected…
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div>`
    const cancel = schedulePaneFocusRestore('p11')
    // …and a second teardown inside the burst must not overwrite with the
    // intermediate frame's focus (here: root-focused remount artifact).
    const root2 = document.querySelector('[data-pane-id="p11"]') as HTMLElement
    root2.focus()
    recordPaneFocusBeforeUnmount('p11')
    cancel()
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div>`
    expect(resolveRecordedFocusTarget('p11')).toBe(document.querySelector('input'))
    // After the restore fires, pending clears and the next teardown records fresh.
    const cancel2 = schedulePaneFocusRestore('p11')
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p11')).toBe(false))
    cancel2()
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p11')
    expect(shouldFocusPaneOnEligibleMount('p11')).toBe(false)
  })

  it('refuses to restore into a hidden tab', () => {
    document.body.innerHTML = `<div data-pane-id="p12" tabindex="-1"></div>`
    const root = document.querySelector('[data-pane-id="p12"]') as HTMLElement
    root.focus()
    recordPaneFocusBeforeUnmount('p12')
    document.body.innerHTML = `<div class="tab-hidden"><div data-pane-id="p12" tabindex="-1"></div></div>`
    expect(resolveRecordedFocusTarget('p12')).toBeNull()
  })

  it('never throws on user-derived multiline attribute text; the element falls through to null', () => {
    document.body.innerHTML = `<div data-pane-id="p13"></div>`
    const root = document.querySelector('[data-pane-id="p13"]')!
    const btn = document.createElement('button')
    btn.setAttribute('aria-label', 'glom\nthis multiline message')
    root.appendChild(btn)
    btn.focus()
    expect(() => recordPaneFocusBeforeUnmount('p13')).not.toThrow()
    // aria-label candidate unparseable, title/data-context absent → no descriptor
    expect(resolveRecordedFocusTarget('p13')).toBeNull()
  })

  it('restore yields to a NEWER explicit selection (user click or scripted select)', async () => {
    const store = configureStore({ reducer: { panes: panesReducer } })
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    // Establish an existing activePane entry so the later select is a real change.
    store.dispatch(initLayout({ tabId: 'tab-x', paneId: 'p20', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p20')
    schedulePaneFocusRestore('p20')
    // The newer selection lands elsewhere (focus follows it) before the window fires.
    const selected = document.createElement('input')
    document.body.appendChild(selected)
    selected.focus()
    // Explicit selection arrives inside the restore window (serial bumps).
    store.dispatch(setActivePane({ tabId: 'tab-x', paneId: 'pane-else' }))
    // The fire ran (window spent)…
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p20')).toBe(false))
    // …but the newer selection kept focus; the restore yielded.
    expect(document.activeElement).toBe(selected)
    // The window is spent: pending cleared, later teardown records fresh.
    const chrome = document.createElement('input')
    document.body.appendChild(chrome)
    chrome.focus()
    recordPaneFocusBeforeUnmount('p20')
    expect(shouldFocusPaneOnEligibleMount('p20')).toBe(false)
  })

  it('a background tab create (activePane addition) does NOT void an unrelated pending restore', async () => {
    const store = configureStore({ reducer: { panes: panesReducer } })
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-a', paneId: 'p20', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p20')
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    schedulePaneFocusRestore('p20')
    // Focus-neutral background creation: a NEW tab's activePane addition must
    // not read as selection activity for an existing pane.
    store.dispatch(initLayout({ tabId: 'tab-bg', paneId: 'p-bg', content: { kind: 'terminal', mode: 'shell' } }))
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p20')).toBe(false))
    expect(document.querySelector('input')).toHaveFocus() // restore fired, not voided
  })

  it('close-time records linger but a reopen (pane id re-appearing) forgets them', () => {
    const store = configureStore({ reducer: { panes: panesReducer } })
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'p21', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p21"></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p21')
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(false)
    // Removal alone does NOT forget: React's teardown re-record lands AFTER
    // the store update, and its record intentionally lingers (LRU-bounded).
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    recordPaneFocusBeforeUnmount('p21') // layout-cleanup order: after removeLayout
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(false)
    // Re-appearing in any layout (e.g. reopened tab keeping leaf ids) forgets.
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'p21', content: { kind: 'terminal', mode: 'shell' } }))
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(true) // forgotten → fresh mount focus
  })

  it('restore abandons a descriptor that is no longer UNIQUE in the rebuilt subtree', () => {
    document.body.innerHTML = `<div data-pane-id="p30"><button aria-label="Go"></button></div>`
    ;(document.querySelector('button') as HTMLElement).focus()
    recordPaneFocusBeforeUnmount('p30')
    // Remount introduced a second identical control (e.g. split/resize) —
    // resolving to a first-match guess could steal focus for a sibling.
    document.body.innerHTML = `<div data-pane-id="p30"><button aria-label="Go">a</button><button aria-label="Go">b</button></div>`
    expect(resolveRecordedFocusTarget('p30')).toBeNull()
    expect(shouldRecordSuppressAutofocus('p30')).toBe(false)
  })

  it('removals of OTHER tab entries are not selection activity (cross-tab sync must not void a restore)', async () => {
    const store = configureStore({ reducer: { panes: panesReducer } })
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-a', paneId: 'p31', content: { kind: 'terminal', mode: 'shell' } }))
    store.dispatch(initLayout({ tabId: 'tab-b', paneId: 'p-b', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p31"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p31')
    document.body.innerHTML = `<div data-pane-id="p31"><input placeholder="Enter URL..."></div>`
    schedulePaneFocusRestore('p31')
    // Another tab's layout removal (close elsewhere / hydrate delta) must not cancel the restore.
    store.dispatch(removeLayout({ tabId: 'tab-b' }))
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p31')).toBe(false))
    expect(document.querySelector('input')).toHaveFocus()
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
