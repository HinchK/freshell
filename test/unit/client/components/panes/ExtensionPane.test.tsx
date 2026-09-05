import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import extensionsReducer, { updateServerStatus } from '@/store/extensionsSlice'
import ExtensionPane from '@/components/panes/ExtensionPane'
import { resetPaneFocusOwnershipForTests } from '@/lib/pane-focus-ownership'
import type { ExtensionPaneContent } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

const sampleExtension: ClientExtensionEntry = {
  name: 'sample',
  version: '1.0.0',
  label: 'Sample',
  description: '',
  category: 'client',
  url: '/index.html',
} as ClientExtensionEntry

const serverExtension: ClientExtensionEntry = {
  name: 'weatherServer',
  version: '1.0.0',
  label: 'Weather Server',
  description: '',
  category: 'server',
  url: '/',
  serverRunning: false,
} as ClientExtensionEntry

const content: ExtensionPaneContent = { kind: 'extension', extensionName: 'sample', props: {} }
const serverContent: ExtensionPaneContent = { kind: 'extension', extensionName: 'weatherServer', props: {} }

function makeStore(entries: ClientExtensionEntry[] = [sampleExtension]) {
  return configureStore({
    reducer: { extensions: extensionsReducer },
    preloadedState: { extensions: { entries } },
  })
}

function makeServerStore() {
  return makeStore([serverExtension])
}

function renderPane(focusEligible = true) {
  const store = makeStore()
  const utils = render(
    <Provider store={store}>
      {/* Bare renders carry no data-pane-id root (the Pane wrapper carries it
          in production); wrap one so ownership records can answer contains(). */}
      <div data-pane-id="pane-1">
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} focusEligible={focusEligible} />
      </div>
    </Provider>,
  )
  const rerenderWith = (next: { focusEligible?: boolean; focusEpoch?: number }) => utils.rerender(
    <Provider store={store}>
      <div data-pane-id="pane-1">
        <ExtensionPane
          tabId="tab-1"
          paneId="pane-1"
          content={content}
          focusEligible={next.focusEligible ?? focusEligible}
          focusEpoch={next.focusEpoch}
        />
      </div>
    </Provider>,
  )
  return { ...utils, store, rerenderWith }
}

describe('ExtensionPane focus gating (agent focus neutrality)', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetPaneFocusOwnershipForTests()
  })

  it('renders its iframe inert and unfocused when NOT focus-eligible', () => {
    renderPane(false)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).not.toBe(iframe)
  })

  it('focuses its iframe on mount when eligible (default) — extension content is then interactive', () => {
    renderPane(true)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(iframe)
  })

  it('removes inert and focuses the iframe on a false→true eligibility flip, without reload', () => {
    const { rerenderWith } = renderPane(false)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    const srcBefore = iframe.getAttribute('src')
    rerenderWith({ focusEligible: true })
    const after = document.querySelector('iframe') as HTMLIFrameElement
    expect(after === iframe).toBe(true) // same element — no reload
    expect(after.hasAttribute('inert')).toBe(false)
    expect(after.getAttribute('src')).toBe(srcBefore)
    expect(document.activeElement).toBe(after)
  })

  it('focuses when a server extension becomes ready AFTER the eligible mount (iframe appears without any focusEligible flip)', async () => {
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {})) // auto-start in flight
    const store = makeServerStore()
    render(
      <Provider store={store}>
        <ExtensionPane tabId="tab-1" paneId="pane-ext" content={serverContent} focusEligible />
      </Provider>,
    )
    expect(document.querySelector('iframe')).toBeNull() // "Starting extension server..."
    act(() => {
      store.dispatch(updateServerStatus({ name: 'weatherServer', serverRunning: true, serverPort: 4242 }))
    })
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.hasAttribute('inert')).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(iframe))
  })

  it('marks its iframe data-focus-locked while ineligible (feeds the focus-steal rebuff guard)', () => {
    renderPane(false)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('data-focus-locked')).toBe('true')
  })

  it('re-focuses the iframe on a focus epoch bump after a denied remount (same-target select)', () => {
    const first = renderPane(true)
    const iframe1 = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe1).toHaveFocus()
    const chrome = document.createElement('input')
    document.body.appendChild(chrome)
    chrome.focus()
    first.unmount() // records NOT owned
    const second = renderPane(true)
    expect(chrome).toHaveFocus() // denied adoption: agent split while user is in app chrome
    second.rerenderWith({ focusEpoch: 1 })
    expect(document.querySelector('iframe')).toHaveFocus()
  })
})
