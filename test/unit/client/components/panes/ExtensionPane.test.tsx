import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import extensionsReducer from '@/store/extensionsSlice'
import ExtensionPane from '@/components/panes/ExtensionPane'
import type { ExtensionPaneContent } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

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

const content: ExtensionPaneContent = { kind: 'extension', extensionName: 'sample', props: {} }

function makeStore() {
  return configureStore({
    reducer: { extensions: extensionsReducer },
    preloadedState: { extensions: { entries: [sampleExtension] } },
  })
}

function renderPane(focusEligible = true) {
  const store = makeStore()
  const utils = render(
    <Provider store={store}>
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} focusEligible={focusEligible} />
    </Provider>,
  )
  return { ...utils, store }
}

describe('ExtensionPane focus gating (agent focus neutrality)', () => {
  afterEach(() => cleanup())

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
    const { rerender, store } = renderPane(false)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    const srcBefore = iframe.getAttribute('src')
    rerender(
      <Provider store={store}>
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} focusEligible />
      </Provider>,
    )
    const after = document.querySelector('iframe') as HTMLIFrameElement
    expect(after === iframe).toBe(true) // same element — no reload
    expect(after.hasAttribute('inert')).toBe(false)
    expect(after.getAttribute('src')).toBe(srcBefore)
    expect(document.activeElement).toBe(after)
  })
})
