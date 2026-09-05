import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { requestPaneRefresh, setActivePane } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import BrowserPane from '@/components/panes/BrowserPane'
import { resetPaneFocusOwnershipForTests, wirePaneFocusOwnershipInvalidation, isPaneFocusRestorePendingForTests } from '@/lib/pane-focus-ownership'

// Mock clipboard
vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(),
}))

// Mock pane-action-registry to avoid side effects
vi.mock('@/lib/pane-action-registry', () => ({
  registerBrowserActions: vi.fn(() => () => {}),
}))

// Mock API for port forwarding
vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ forwardedPort: 45678 }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

import { api } from '@/lib/api'

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      paneRuntimeActivity: {
        byPaneId: {},
      },
    },
  })

function renderBrowserPane(
  props: Partial<React.ComponentProps<typeof BrowserPane>> = {},
  store = createMockStore(),
) {
  const defaultProps = {
    paneId: 'pane-1',
    tabId: 'tab-1',
    browserInstanceId: 'browser-1',
    url: '',
    devToolsOpen: false,
    ...props,
  }
  return {
    ...render(
      <Provider store={store}>
        <BrowserPane {...defaultProps} />
      </Provider>,
    ),
    store,
  }
}

describe('BrowserPane', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    cleanup()
    resetPaneFocusOwnershipForTests()
  })

  function setWindowHostname(hostname: string) {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname },
      writable: true,
      configurable: true,
    })
  }

  describe('rendering', () => {
    it('renders URL input and navigation buttons', () => {
      renderBrowserPane()

      expect(screen.getByPlaceholderText('Enter URL...')).toBeInTheDocument()
      expect(screen.getByTitle('Back')).toBeInTheDocument()
      expect(screen.getByTitle('Forward')).toBeInTheDocument()
    })

    it('shows empty state when no URL is set', () => {
      renderBrowserPane({ url: '' })

      expect(screen.getByText('Enter a URL to browse')).toBeInTheDocument()
    })

    it('renders iframe when URL is provided', () => {
      const { store } = renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
      expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
        source: 'browser',
      })
    })

    it('shows dev tools panel when devToolsOpen is true', () => {
      renderBrowserPane({ url: 'https://example.com', devToolsOpen: true })

      expect(screen.getByText('Developer Tools')).toBeInTheDocument()
    })

    it('hides dev tools panel when devToolsOpen is false', () => {
      renderBrowserPane({ url: 'https://example.com', devToolsOpen: false })

      expect(screen.queryByText('Developer Tools')).not.toBeInTheDocument()
    })
  })

  describe('navigation', () => {
    it('navigates when Enter is pressed in URL input', () => {
      renderBrowserPane()

      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      // Should add https:// protocol
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('preserves http:// protocol when specified', async () => {
      setWindowHostname('localhost')
      renderBrowserPane()

      const input = screen.getByPlaceholderText('Enter URL...')
      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        fireEvent.change(input, { target: { value: 'http://localhost:4000' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Localhost URLs are proxied through Freshell's HTTP proxy (handles WSL2/Docker)
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
    })

    it('syncs input and history when url prop changes externally', () => {
      const store = createMockStore()
      const baseProps = {
        paneId: 'pane-1',
        tabId: 'tab-1',
        devToolsOpen: false,
      }

      const { rerender } = render(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://first.example.com" />
        </Provider>,
      )

      const input = screen.getByPlaceholderText('Enter URL...') as HTMLInputElement
      expect(input.value).toBe('https://first.example.com')
      expect(screen.getByTitle('Back')).toBeDisabled()

      rerender(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://second.example.com" />
        </Provider>,
      )

      expect((screen.getByPlaceholderText('Enter URL...') as HTMLInputElement).value).toBe('https://second.example.com')
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://second.example.com')
      expect(screen.getByTitle('Back')).not.toBeDisabled()

      fireEvent.click(screen.getByTitle('Back'))

      expect((screen.getByPlaceholderText('Enter URL...') as HTMLInputElement).value).toBe('https://first.example.com')
      expect(iframe!.getAttribute('src')).toBe('https://first.example.com')
    })

    it('clears navigation state when url prop is externally cleared', () => {
      const store = createMockStore()
      const baseProps = {
        paneId: 'pane-1',
        tabId: 'tab-1',
        devToolsOpen: false,
      }

      const { rerender } = render(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://example.com" />
        </Provider>,
      )

      rerender(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="" />
        </Provider>,
      )

      const input = screen.getByPlaceholderText('Enter URL...') as HTMLInputElement
      expect(input.value).toBe('')
      expect(screen.getByText('Enter a URL to browse')).toBeInTheDocument()
      expect(screen.getByTitle('Back')).toBeDisabled()
      expect(screen.getByTitle('Forward')).toBeDisabled()
    })
  })

  describe('refresh requests', () => {
    function createBrowserStore() {
      return configureStore({
        reducer: {
          panes: panesReducer,
          settings: settingsReducer,
          paneRuntimeActivity: paneRuntimeActivityReducer,
        },
        preloadedState: {
          panes: {
            layouts: {
              'tab-1': {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'browser',
                  browserInstanceId: 'browser-1',
                  url: 'https://example.com',
                  devToolsOpen: false,
                },
              },
            },
            activePane: { 'tab-1': 'pane-1' },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: {},
          },
          paneRuntimeActivity: {
            byPaneId: {},
          },
        },
      })
    }

    it('reloads the live iframe when a matching refresh request arrives', async () => {
      const store = createBrowserStore()
      renderBrowserPane({ url: 'https://example.com' }, store)

      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      expect(iframe).toBeTruthy()

      const reload = vi.fn()
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { location: { reload } },
      })

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
      })

      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
    })

    it('retries a failed forwarded page when a matching refresh request arrives without an iframe', async () => {
      const store = createBrowserStore()
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ forwardedPort: 45678 })

      await act(async () => {
        // Use https: URL — http: uses same-origin proxy, not TCP forwarding
        renderBrowserPane({ url: 'https://localhost:3000' }, store)
      })

      await waitFor(() => {
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
      })

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(2)
      })
      await waitFor(() => {
        expect(screen.queryByText('Failed to connect')).not.toBeInTheDocument()
      })
      // Protocol preserved — TCP forward passes bytes verbatim
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://192.168.1.100:45678/')
      expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
    })
  })

  describe('runtime activity', () => {
    it('marks the pane idle after iframe load succeeds', () => {
      const { store } = renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      fireEvent.load(iframe)

      expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
        source: 'browser',
        phase: 'idle',
      })
    })

    it('marks the pane as error when port forwarding fails for https: URL', async () => {
      setWindowHostname('remote-host')
      vi.mocked(api.post).mockRejectedValueOnce(new Error('forward failed'))
      // Use https: — http: uses same-origin proxy, not TCP forwarding
      const { store } = renderBrowserPane({ url: 'https://127.0.0.1:3000' })

      await waitFor(() => {
        expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
          source: 'browser',
          phase: 'error',
        })
      })
    })

    it('marks remote localhost forwarding as busy while the proxy request is pending', async () => {
      setWindowHostname('remote-host')
      let resolveForward: ((value: { forwardedPort: number }) => void) | null = null
      vi.mocked(api.post).mockReturnValueOnce(new Promise((resolve) => {
        resolveForward = resolve
      }))
      // Use https: — http: uses same-origin proxy, not TCP forwarding
      const { store } = renderBrowserPane({ url: 'https://127.0.0.1:3000' })

      expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
        source: 'browser',
        phase: 'forwarding',
      })

      await act(async () => {
        resolveForward?.({ forwardedPort: 45678 })
      })
    })
  })

  describe('file:// URL handling', () => {
    it('converts file:// URLs to /local-file API endpoint', () => {
      renderBrowserPane({ url: 'file:///home/user/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('/home/user/index.html'),
      )
    })

    it('keeps Windows drive file URLs compatible with local-file path resolution', () => {
      renderBrowserPane({ url: 'file:///C:/Users/user/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('C:/Users/user/index.html'),
      )
    })

    it('maps non-localhost file URL hostnames to UNC-style paths', () => {
      renderBrowserPane({ url: 'file://server/share/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('//server/share/index.html'),
      )
    })
  })

  describe('port forwarding for remote access', () => {
    it('proxies http: localhost URLs through HTTP proxy when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')

      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000' })
      })

      // http: localhost URLs use the same-origin HTTP proxy, not TCP forwarding
      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
    })

    it('proxies http://127.0.0.1 URLs through HTTP proxy when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')

      await act(async () => {
        renderBrowserPane({ url: 'http://127.0.0.1:8080' })
      })

      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/8080/')
      })
    })

    it('preserves path and query when proxying http: localhost URLs remotely', async () => {
      setWindowHostname('10.0.0.5')

      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000/api/data?q=test' })
      })

      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/api/data?q=test')
      })
    })

    it('preserves https: protocol for forwarded https: localhost URLs', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000/app' })
      })

      expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 3000 })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Protocol preserved — TCP proxy passes bytes verbatim (including TLS handshake)
        expect(iframe!.getAttribute('src')).toBe('https://192.168.1.100:45678/app')
      })
    })

    it('proxies localhost URLs through HTTP proxy when accessing locally', async () => {
      setWindowHostname('localhost')
      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000' })
      })

      // No TCP port forward needed — uses HTTP proxy instead
      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Routed through Freshell's HTTP proxy (handles WSL2/Docker networking)
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
    })

    it('does not request port forwarding for non-localhost URLs', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'https://example.com' })

      expect(api.post).not.toHaveBeenCalled()

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('does not request port forwarding for file:// URLs when remote', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'file:///home/user/index.html' })

      expect(api.post).not.toHaveBeenCalled()

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('/home/user/index.html'),
      )
    })

    it('shows connecting state while port forward is pending for https: URL', async () => {
      setWindowHostname('192.168.1.100')
      let resolveForward!: (value: { forwardedPort: number }) => void
      vi.mocked(api.post).mockReturnValue(
        new Promise((resolve) => {
          resolveForward = resolve
        }),
      )

      renderBrowserPane({ url: 'https://localhost:3000' })

      // Should show connecting state (no iframe yet)
      expect(screen.getByText(/Connecting/i)).toBeInTheDocument()
      expect(document.querySelector('iframe')).toBeNull()

      // Resolve the forward
      await act(async () => {
        resolveForward({ forwardedPort: 45678 })
      })

      // Now the iframe should appear
      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('https://192.168.1.100:45678/')
      })
    })

    it('clears forwarding state when navigating to a non-forward URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockReturnValue(new Promise(() => {}))

      renderBrowserPane({ url: 'https://localhost:3000' })

      expect(screen.getByText(/Connecting/i)).toBeInTheDocument()

      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.queryByText(/Connecting/i)).not.toBeInTheDocument()
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('https://example.com')
      })
    })

    it('releases port forward when navigating away from a forwarded URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000' })
      })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
      })

      // Navigate away
      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(api.delete).toHaveBeenCalledWith('/api/proxy/forward/3000')
      })
    })

    it('shows error when port forwarding fails for https: URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockRejectedValue(
        new Error('Failed to create port forward'),
      )

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000' })
      })

      await waitFor(() => {
        // Use exact string to avoid matching the description which also contains "Failed to connect"
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })
    })

    it('clears loading state when port forwarding fails for https: URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockRejectedValue(new Error('Connection refused'))

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000' })
      })

      await waitFor(() => {
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })

      // Toolbar should show Refresh (not Stop), meaning isLoading is false
      expect(screen.getByTitle('Refresh')).toBeInTheDocument()
      expect(screen.queryByTitle('Stop')).not.toBeInTheDocument()
    })

    it('retries port forwarding when Try Again is clicked after failure', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000' })
      })

      await waitFor(() => {
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })

      expect(api.post).toHaveBeenCalledTimes(1)

      // Click Try Again
      await act(async () => {
        fireEvent.click(screen.getByText('Try Again'))
      })

      // Should have made a second API call
      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(2)
      })

      // Should now show the iframe (https: protocol preserved through TCP forward)
      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('https://192.168.1.100:45678/')
      })
    })
  })

  describe('focus gating', () => {
    it('focuses the URL input for an empty-url pane that owns focus (default)', () => {
      renderBrowserPane({ url: '' })
      expect(screen.getByPlaceholderText('Enter URL...')).toHaveFocus()
    })

    it('does not focus the URL input when focusEligible is false', () => {
      renderBrowserPane({ url: '', focusEligible: false })
      expect(screen.getByPlaceholderText('Enter URL...')).not.toHaveFocus()
    })

    it('marks the iframe inert when NOT focus-eligible (page content cannot programmatically steal focus)', () => {
      renderBrowserPane({ url: 'https://example.com', focusEligible: false })
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.hasAttribute('inert')).toBe(true)
    })

    it('does NOT set inert when the pane owns focus (default) — content stays interactive', () => {
      renderBrowserPane({ url: 'https://example.com' })
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.hasAttribute('inert')).toBe(false)
    })

    it('removes inert on a false→true eligibility flip (explicit select) without reloading the iframe', () => {
      const { rerender, store } = renderBrowserPane({ url: 'https://example.com', focusEligible: false })
      const iframe = document.querySelector('iframe')
      expect(iframe!.hasAttribute('inert')).toBe(true)
      const srcBefore = iframe!.getAttribute('src')
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} focusEligible />
        </Provider>,
      )
      const iframeAfter = document.querySelector('iframe')
      expect(iframeAfter === iframe).toBe(true) // same element — no reload
      expect(iframeAfter!.hasAttribute('inert')).toBe(false)
      expect(iframeAfter!.getAttribute('src')).toBe(srcBefore)
    })

    it('REAL split-swap commit order (new subtree renders before old cleanup): chrome keeps focus, iframe stays locked', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      // Mount autofocus claims the pane root; the user then moves to app chrome.
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      // Single commit: wrapping div added → pane-1 subtree deleted + recreated —
      // React renders the new tree BEFORE the old subtree's layout cleanups
      // write the ownership record. A render-time adoption read would latch
      // "unknown → allowed" and steal chrome's focus; post-commit reads deny it.
      first.rerender(
        <Provider store={first.store}>
          <div>
            <div data-pane-id="pane-2"><input aria-label="sibling" /></div>
            <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} />
          </div>
        </Provider>,
      )
      const iframe = document.querySelector('iframe')!
      expect(iframe.hasAttribute('inert')).toBe(true)
      expect(iframe.getAttribute('data-focus-locked')).toBe('true')
      expect(chrome).toHaveFocus()
    })

    it('locks the iframe on an ownership-DENIED eligible remount (active pane, user in app chrome)', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      // Mount autofocus claims the pane root (own-focus); the user then moves
      // to app chrome, so the teardown record is owned:false.
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      first.unmount()
      const second = renderBrowserPane({ url: 'https://example.com' })
      const iframe = document.querySelector('iframe')
      expect(iframe!.hasAttribute('inert')).toBe(true)
      expect(iframe!.getAttribute('data-focus-locked')).toBe('true')
      // …and chrome keeps focus (no yank-back from the denied remount).
      expect(chrome).toHaveFocus()
      second.unmount()
    })

    it('pointerdown on a denied-remount pane UNLOCKS the iframe (click-to-wake recovery) without stealing focus', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      first.unmount()
      renderBrowserPane({ url: 'https://example.com' }) // denied remount → locked
      const iframe = document.querySelector('iframe')!
      expect(iframe.hasAttribute('inert')).toBe(true)
      const root = iframe.closest('[data-pane-id="pane-1"]') as HTMLElement
      fireEvent.pointerDown(root)
      expect(iframe.hasAttribute('inert')).toBe(false)
      expect(iframe.getAttribute('data-focus-locked')).toBeNull()
      // Unlock does not yank focus — the browser default for the click does.
      expect(chrome).toHaveFocus()
    })

    it('focuses the pane root on mount for a loaded pane that owns focus', () => {
      renderBrowserPane({ url: 'https://example.com' })
      const root = document.querySelector('[data-pane-id="pane-1"]')
      expect(root).toHaveFocus()
    })

    it('does not focus a loaded pane while ineligible, but on the later false→true flip (explicit select)', () => {
      const { rerender, store } = renderBrowserPane({ url: 'https://example.com', focusEligible: false })
      const iframe = document.querySelector('iframe')
      const root = document.querySelector('[data-pane-id="pane-1"]')
      expect(iframe).not.toBeNull()
      expect(root).not.toHaveFocus()
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} focusEligible />
        </Provider>,
      )
      expect(root).toHaveFocus()
    })

    it('remount WITHOUT prior focus ownership keeps focus where the user left it (agent split while user is in app chrome)', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
      // User moved into application chrome without changing activePane.
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      expect(chrome).toHaveFocus()
      // Leaf→split remount destroys and recreates the pane's React subtree.
      first.unmount()
      renderBrowserPane({ url: 'https://example.com' })
      expect(chrome).toHaveFocus()
      expect(document.querySelector('[data-pane-id="pane-1"]')).not.toHaveFocus()
    })

    it('remount WITH prior focus ownership restores the pane focus (matches user-split UX and the e2e split contract)', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      const root = document.querySelector('[data-pane-id="pane-1"]')
      expect(root).toHaveFocus()
      first.unmount()
      renderBrowserPane({ url: 'https://example.com' })
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
    })

    it('pin: navigation never yanks focus (url change is not a focus event)', () => {
      const { rerender, store } = renderBrowserPane({ url: 'https://example.com' })
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      expect(chrome).toHaveFocus()
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://other.example.com" devToolsOpen={false} focusEligible />
        </Provider>,
      )
      expect(chrome).toHaveFocus()
    })

    it('a denied remount still focuses on a later explicit eligibility flip (switch away and back)', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      first.unmount()
      const { rerender, store } = renderBrowserPane({ url: 'https://example.com' })
      expect(chrome).toHaveFocus() // denied adoption: agent split while user is in app chrome
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} focusEligible={false} />
        </Provider>,
      )
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} focusEligible />
        </Provider>,
      )
      // Explicit-select flips ALWAYS bypass the ownership gate — a denied
      // remount must not strand the pane unfocused forever.
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
    })

    it('a remount restores focus to the EXACT element that held it (URL input), not the default target', async () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
      // User clicked into the URL field of the loaded pane…
      const urlInput = screen.getByPlaceholderText('Enter URL...')
      urlInput.focus()
      expect(urlInput).toHaveFocus()
      // …then an agent split remounts the subtree.
      first.unmount()
      renderBrowserPane({ url: 'https://example.com' })
      // Default mount focus lands on the pane root; the recorded descriptor
      // then re-resolves and refocuses the URL input (rAF + macrotask — poll,
      // do not sleep: jsdom rAF lands late under pool load).
      await waitFor(() => expect(screen.getByPlaceholderText('Enter URL...')).toHaveFocus(), { timeout: 2000 })
    })

    it('a remount restores focus to the EMBEDDED iframe when the user was inside the page (descriptor: sole iframe)', async () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      iframe.focus()
      expect(iframe).toHaveFocus()
      first.unmount()
      renderBrowserPane({ url: 'https://example.com' })
      // Default mount focus lands on the pane root; the descriptor restore
      // then refocuses the iframe (rAF + macrotask — poll, do not sleep).
      await waitFor(() => expect(document.querySelector('iframe')).toHaveFocus(), { timeout: 2000 })
    })

    it('restores focus for a Redux-INACTIVE pane that held DOM focus via keyboard (split must not drop it to body)', async () => {
      // Pane shells are keyboard-focusable without changing activePane; focus
      // via Tab never dispatches setActivePane.
      const first = renderBrowserPane({ url: 'https://example.com', focusEligible: false })
      const shell = document.querySelector('[data-pane-id="pane-1"]') as HTMLElement
      shell.focus()
      expect(shell).toHaveFocus()
      first.unmount()
      renderBrowserPane({ url: 'https://example.com', focusEligible: false })
      // The content focus effect early-returns (ineligible); the record-driven
      // restore must still hand focus back to the replacement shell.
      await waitFor(
        () => expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus(),
        { timeout: 2000 },
      )
    })

    it('burst splits preserve the pre-split focus target (descriptor survives intermediate remounts)', async () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      const urlInput = screen.getByPlaceholderText('Enter URL...')
      urlInput.focus()
      first.unmount() // records the URL input
      const second = renderBrowserPane({ url: 'https://example.com' }) // default root focus; restore pending
      // Second split lands BEFORE the restore fires.
      second.unmount() // must NOT overwrite the URL descriptor with the artifact focus
      renderBrowserPane({ url: 'https://example.com' })
      await waitFor(() => expect(screen.getByPlaceholderText('Enter URL...')).toHaveFocus(), { timeout: 2000 })
    })

    it('a restore in flight YIELDS to a newer explicit selection (split, then immediately select elsewhere)', async () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      const urlInput = screen.getByPlaceholderText('Enter URL...')
      urlInput.focus()
      first.unmount() // records the URL input
      const { store } = renderBrowserPane({ url: 'https://example.com' }) // adoption allowed; restore scheduled
      const unwire = wirePaneFocusOwnershipInvalidation(store)
      try {
        // The agent immediately selects elsewhere before the restore fires —
        // the selection must win; the restore must not drag focus back.
        // (focusNudge: mirrors the pane.select fold's epoch path.)
        act(() => {
          store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-2', focusNudge: true }))
        })
        // The window fired (pending spent)…
        await waitFor(() => expect(isPaneFocusRestorePendingForTests('pane-1')).toBe(false))
        // …but it yielded to the newer selection: URL input never grabbed focus.
        expect(screen.getByPlaceholderText('Enter URL...')).not.toHaveFocus()
      } finally {
        unwire()
      }
    })

    it('an explicit re-select of the ALREADY-active pane (focus epoch bump) focuses a denied remount', () => {
      const first = renderBrowserPane({ url: 'https://example.com' })
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      first.unmount() // records NOT owned (chrome holds focus)
      const { rerender, store } = renderBrowserPane({ url: 'https://example.com' })
      expect(chrome).toHaveFocus() // denied adoption (recorded not-owned)
      // Same-target select produces no eligibility transition; PaneContainer
      // forwards the bumped epoch — simulate that hand-off via the prop.
      rerender(
        <Provider store={store}>
          <BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://example.com" devToolsOpen={false} focusEligible focusEpoch={1} />
        </Provider>,
      )
      expect(document.querySelector('[data-pane-id="pane-1"]')).toHaveFocus()
    })
  })
})
