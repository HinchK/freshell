import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import html2canvas from 'html2canvas'
import tabsReducer, { setActiveTab, selectTabForCapture, removeTab, addTab } from '@/store/tabsSlice'
import panesReducer, { splitPane, closePane, setActivePane } from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { captureUiScreenshot, cancelUiScreenshot, drainCaptureQueueForTests, prepareIframeCapture, restoreFocus } from '../../../src/lib/ui-screenshot'
import { getPaneSelectionSerial, paneSelectionMiddleware, wirePaneFocusOwnershipInvalidation } from '@/lib/pane-focus-ownership'
import { suspendTerminalRenderersForScreenshot } from '../../../src/lib/screenshot-capture-env'

vi.mock('html2canvas', () => ({
  default: vi.fn(),
}))

vi.mock('../../../src/lib/screenshot-capture-env', () => ({
  suspendTerminalRenderersForScreenshot: vi.fn(async () => async () => {}),
}))

const CONTEXT_MENU_PROOF_BASENAME = 'freshell-terminal-context-menu-proof.png'
const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10] as const
let contextMenuProofPath = ''
let contextMenuProofDir = ''

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const carry = crc & 1
      crc >>>= 1
      if (carry) crc ^= 0xedb88320
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function createSolidPngBase64(rgba: readonly [number, number, number, number]): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(Buffer.from([0, ...rgba]))
  const signature = Buffer.from(PNG_SIGNATURE_BYTES)
  const png = Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', idat),
    createPngChunk('IEND', Buffer.alloc(0)),
  ])

  return png.toString('base64')
}

function setRect(node: Element, width: number, height: number) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  })
}

function createRuntime() {
  return {
    dispatch: vi.fn(),
    getState: () => ({
      tabs: { activeTabId: 'tab-1' },
      panes: { activePane: {}, layouts: {} },
    }) as any,
  }
}

function createMenuStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
            terminalId: 'term-1',
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: 'linux',
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function createMenuRuntime(store: ReturnType<typeof createMenuStore>) {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
  }
}

describe('captureUiScreenshot iframe handling', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    contextMenuProofDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-terminal-context-menu-proof-'))
    contextMenuProofPath = path.join(contextMenuProofDir, CONTEXT_MENU_PROOF_BASENAME)
  })

  afterEach(async () => {
    await fs.rm(contextMenuProofDir, { recursive: true, force: true })
    contextMenuProofDir = ''
    contextMenuProofPath = ''
  })

  it('captures same-origin iframe content into screenshot clone', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="frame-a" src="/local-file?path=/tmp/canary.txt"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('frame-a') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><h1>CANARY</h1></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = target.cloneNode(true) as HTMLElement
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc)
        clonedHtml = cloneTarget.innerHTML
        return {
          width: 800,
          height: 500,
          toDataURL: () => 'data:image/png;base64,ROOTPNG',
        } as any
      }

      return {
        width: 500,
        height: 300,
        toDataURL: () => 'data:image/png;base64,IFRAMEPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(2)
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('<iframe')
    expect(iframe.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
  })

  it('captures proxy-URL iframe as image content when document is accessible', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="proxy-frame" src="/api/proxy/http/3000/"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('proxy-frame') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Proxied localhost content</p></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = target.cloneNode(true) as HTMLElement
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc)
        clonedHtml = cloneTarget.innerHTML
        return {
          width: 800,
          height: 500,
          toDataURL: () => 'data:image/png;base64,PROXYPNG',
        } as any
      }

      return {
        width: 500,
        height: 300,
        toDataURL: () => 'data:image/png;base64,IFRAMEPROXYPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('PROXYPNG')
    // The iframe should be replaced with an image, not a placeholder
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('data-screenshot-iframe-placeholder')
    expect(clonedHtml).not.toContain('<iframe')
  })

  it('uses an explicit placeholder when iframe content cannot be captured', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="frame-b" src="https://blocked.example.com/path?q=1"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('frame-b') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get: () => null,
    })

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone !== 'function') {
        throw new Error('did not expect iframe html2canvas call for inaccessible content')
      }
      const cloneDoc = document.implementation.createHTMLDocument('clone')
      const cloneTarget = target.cloneNode(true) as HTMLElement
      cloneDoc.body.appendChild(cloneTarget)
      opts.onclone(cloneDoc)
      clonedHtml = cloneTarget.innerHTML
      return {
        width: 800,
        height: 500,
        toDataURL: () => 'data:image/png;base64,ROOTPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(clonedHtml).toContain('data-screenshot-iframe-placeholder="true"')
    expect(clonedHtml).toContain('blocked.example.com')
    expect(iframe.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
  })

  it('writes a portable PNG artifact for the terminal context menu capture and verifies the captured DOM', async () => {
    const user = userEvent.setup()
    const store = createMenuStore()

    render(
      createElement(
        Provider,
        { store },
        createElement(
          ContextMenuProvider,
          {
            view: 'terminal',
            onViewChange: () => {},
            onToggleSidebar: () => {},
            sidebarCollapsed: false,
          },
          createElement(
            'div',
            {
              'data-context': ContextIds.Terminal,
              'data-tab-id': 'tab-1',
              'data-pane-id': 'pane-1',
            },
            'Terminal Content',
          ),
        ),
      ),
    )

    await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })
    setRect(document.body, 1200, 800)

    let cloneDoc: Document | null = null
    let expectedImageBase64 = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const doc = document.implementation.createHTMLDocument('clone')
        const cloneRoot = (el as HTMLElement).cloneNode(true) as HTMLElement
        doc.body.appendChild(cloneRoot)
        opts.onclone(doc)
        cloneDoc = doc
      }

      const topMenuItems = Array.from(cloneDoc?.querySelectorAll('[role="menuitem"]') ?? []).slice(0, 3)
      const topLabels = topMenuItems.map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      const allHaveIcons = topMenuItems.every((node) => node.querySelector('svg'))
      const matchesTerminalClipboardSection =
        topLabels.join('|') === 'Copy|Paste|Select all' && allHaveIcons

      expectedImageBase64 = createSolidPngBase64(
        matchesTerminalClipboardSection ? [12, 129, 54, 255] : [188, 28, 28, 255],
      )

      return {
        width: 1200,
        height: 800,
        toDataURL: () => `data:image/png;base64,${expectedImageBase64}`,
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createMenuRuntime(store) as any)
    expect(result.ok).toBe(true)
    await fs.writeFile(contextMenuProofPath, Buffer.from(result.imageBase64!, 'base64'))

    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(html2canvas).mock.calls[0]?.[0]).toBe(document.body)
    expect(result.imageBase64).toBe(expectedImageBase64)

    const clonedMenuItems = Array.from(cloneDoc!.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(clonedMenuItems.slice(0, 3)).toEqual(['Copy', 'Paste', 'Select all'])

    const topMenuItems = Array.from(cloneDoc!.querySelectorAll('[role="menuitem"]')).slice(0, 3)
    for (const node of topMenuItems) {
      expect(node.querySelector('svg')).not.toBeNull()
    }

    expect(path.basename(contextMenuProofPath)).toBe(CONTEXT_MENU_PROOF_BASENAME)

    const artifact = await fs.readFile(contextMenuProofPath)
    expect(artifact.length).toBeGreaterThan(8)
    expect(Array.from(artifact.subarray(0, 8))).toEqual([...PNG_SIGNATURE_BYTES])
  })
})

function createFocusStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(paneSelectionMiddleware as never),
    preloadedState: {
      tabs: {
        tabs: [
          { id: 'tab-1', createRequestId: 'req-1', title: 'One', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 1 },
          { id: 'tab-2', createRequestId: 'req-2', title: 'Two', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 2 },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': { type: 'leaf' as const, id: 'pane-1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-1' } },
          'tab-2': { type: 'leaf' as const, id: 'pane-2', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-2' } },
        },
        activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
        paneTitles: { 'tab-1': { 'pane-1': 'One' }, 'tab-2': { 'pane-2': 'Two' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as any,
  })
}

describe('prepareIframeCapture marker fencing', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it("an abandoned capture's cleanup restores ONLY its own markers (never the successor's)", async () => {
    document.body.innerHTML = '<div id="scope"><iframe id="fr"></iframe></div>'
    const scope = document.getElementById('scope')!
    const iframe = document.getElementById('fr') as HTMLIFrameElement
    setRect(iframe, 100, 100)
    const prepA = await prepareIframeCapture(scope, 1)
    const markerA = iframe.getAttribute('data-screenshot-iframe-marker')
    expect(markerA).toBeTruthy()
    // The successor's prep interleaves with the abandoned capture's cleanup.
    const prepB = await prepareIframeCapture(scope, 1)
    const markerB = iframe.getAttribute('data-screenshot-iframe-marker')!
    expect(markerB).not.toBe(markerA)
    prepA.cleanup() // abandoned capture ending late — must not touch B's marker
    expect(iframe.getAttribute('data-screenshot-iframe-marker')).toBe(markerB)
    // B's cleanup restores what predated B — in this overlapped crime scene
    // that is A's marker (in the un-abandoned world it is the pre-capture
    // null). A stale marker then harms nothing: the next capture re-marks.
    prepB.cleanup()
    expect(iframe.getAttribute('data-screenshot-iframe-marker')).toBe(markerA)
  })
})

describe('restoreFocus deleted-target hardening', () => {

  it('restores a still-valid snapshot and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // simulate the capture switching away
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} },
      new Set()
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    // Restores move via the serial-invisible capture action — a visible
    // restore dispatch would misread as the user's own newer selection on the
    // NEXT supersession check and co-touch coordinates it never owned.
    expect(spy.mock.calls.map(([a]) => (a as any)?.type)).toContain('tabs/selectTabForCapture')
  })

  it('restores a still-valid pane focus and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    // activePane['tab-2'] is now 'pane-2b' (splits activate by default);
    // the snapshot says pane-2 owned focus.
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(true)
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2')
  })

  it('never dispatches setActiveTab for a tab deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2'))
    store.dispatch(removeTab('tab-1'))
    const spy = vi.spyOn(store, 'dispatch') // spy AFTER setup: only restore dispatches are observed
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('never dispatches setActivePane for a pane deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    // closePane is a no-op on a root leaf, so split first, then close the
    // snapshot pane (leaving layout collapsed to the sibling leaf).
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    store.dispatch(closePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)
    const setPaneCalls = spy.mock.calls.filter(([a]) => (a as any)?.type === 'panes/setActivePane')
    expect(setPaneCalls).toHaveLength(0)
  })

  it('still restores the surviving active tab when only a pane target vanished (best-effort, reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    store.dispatch(closePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    store.dispatch(setActiveTab('tab-2')) // the capture itself switched the user away
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2'])
    )
    expect(ok).toBe(false)                                   // incomplete restore, honestly reported
    expect(store.getState().tabs.activeTabId).toBe('tab-1')  // surviving tab focus STILL restored
    const setPaneCalls = spy.mock.calls.filter(([a]) => (a as any)?.type === 'panes/setActivePane')
    expect(setPaneCalls).toHaveLength(0)                     // never toward the dead pane
  })

  it('reports false when the owning TAB is deleted inside the restore window (mid-flight race pin)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    // tab-2 exists and pane-2 is a restore target at dispatch time; the tab
    // vanishes inside restoreFocus's afterPaint window. Our rAF callback is
    // enqueued BEFORE restoreFocus's internal post-paint checks, so the
    // deletion deterministically lands in the verify window.
    requestAnimationFrame(() => { store.dispatch(removeTab('tab-2')) })
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)
  })

  it('yields the pane restore when a NEWER explicit selection landed mid-capture', async () => {
    const store = createFocusStore()
    const unwire = wirePaneFocusOwnershipInvalidation(store)
    try {
      store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
      const s0 = getPaneSelectionSerial()
      const before = { selectionSerial: s0, activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } }
      // User (or agent) explicitly selects the OTHER pane mid-capture.
      store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b', focusNudge: true }))
      const dispatchSpy = vi.spyOn(store, 'dispatch')
      const ok = await restoreFocus(
        { dispatch: store.dispatch, getState: store.getState },
        before,
        new Set(['tab-2']),
      )
      expect(ok).toBe(true) // superseded by the newer selection, not incomplete
      expect(store.getState().panes.activePane['tab-2']).toBe('pane-2b')
      expect(dispatchSpy.mock.calls.map(([a]) => (a as any)?.type)).not.toContain('panes/setActivePane')
    } finally {
      unwire()
    }
  })

  it('yields the tab restore when the user opened a NEW tab mid-capture (default-activating addTab is selection activity)', async () => {
    const store = createFocusStore()
    // The capture switched to tab-2 (capture-marker action — serial-invisible)…
    store.dispatch(selectTabForCapture('tab-2'))
    // …snapshot taken at capture start…
    const before = { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} }
    // …then the user opened a new tab mid-capture. User new-tab gestures
    // default-activate WITHOUT a setActiveTab — the serial must count addTab
    // itself (an earlier version of this test followed with an explicit
    // setActiveTab, masking the gap).
    store.dispatch(addTab({}))
    const userTab = store.getState().tabs.tabs.at(-1)!.id
    expect(store.getState().tabs.activeTabId).toBe(userTab) // addTab default-activated it
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      before,
      new Set(),
    )
    expect(ok).toBe(true)
    expect(spy.mock.calls.filter(([a]) => (a as any)?.type === 'tabs/setActiveTab').length).toBe(0)
    expect(store.getState().tabs.activeTabId).toBe(userTab)
  })

    it('yields when the user clicks the SAME tab the capture is showing (plain tab clicks count as selection)', async () => {
    const store = createFocusStore()
    // Capture moved to tab-2 (capture-marker action — invisible to the serial).
    store.dispatch(selectTabForCapture('tab-2'))
    const before = { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} }
    // User clicks tab-2 mid-capture (same tab the capture is showing).
    store.dispatch(setActiveTab('tab-2'))
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      before,
      new Set(),
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-2') // user's choice preserved
    expect(spy.mock.calls.filter(([a]) => (a as any)?.type === 'tabs/setActiveTab').length).toBe(0)
  })

  it("restores the capture's own tab switch when nothing changed mid-capture", async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // capture's own switch
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
      { tab: 'tab-2', paneByTab: new Map() },
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it("the restore's own dispatches never poison its other coordinates (restore moves are serial-invisible)", async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({
      tabId: 'tab-2',
      paneId: 'pane-2',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2b',
      activate: false,
    }))
    const before = { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } }
    // The capture's moves (serial-invisible).
    store.dispatch(selectTabForCapture('tab-2'))
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b', capture: true }))
    // User's newer selection is an unrelated BACKGROUND pane (tab-1's pane is NOT
    // visible under the capture's tab — they touched no capture coordinate).
    store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      before,
      new Set(['tab-2']),
      { tab: 'tab-2', paneByTab: new Map([['tab-2', 'pane-2b']]) },
    )
    expect(ok).toBe(true)
    // BOTH capture-owned coordinates roll back: the pane restore's own dispatch
    // must not count as the user touching the tab coordinate.
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2')
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('user pane interaction on the capture-exposed tab protects BOTH coordinates from rollback', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({
      tabId: 'tab-2',
      paneId: 'pane-2',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2b',
      activate: false,
    }))
    const before = { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } }
    // The capture exposes tab-2 and shows pane-2b.
    store.dispatch(selectTabForCapture('tab-2'))
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b', capture: true }))
    // The user clicks into pane-2b of the tab the capture is showing — they
    // are engaged with BOTH the pane AND the tab now. Rolling the tab back
    // would hide the pane they just clicked into.
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b' }))
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      before,
      new Set(['tab-2']),
      { tab: 'tab-2', paneByTab: new Map([['tab-2', 'pane-2b']]) },
    )
    expect(ok).toBe(true)
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2b') // user's pane preserved
    expect(store.getState().tabs.activeTabId).toBe('tab-2') // the tab the user engaged with preserved
  })

  it('yields ONLY the superseded coordinate when the user selected elsewhere, still restoring capture-owned background coordinates', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({
      tabId: 'tab-2',
      paneId: 'pane-2',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2b',
      activate: false,
    }))
    const before = { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } }
    // The capture's own moves (serial-invisible).
    store.dispatch(selectTabForCapture('tab-2'))
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b', capture: true }))
    // The user's newer selection is a NEW tab — it touches ONLY the tab
    // coordinate. The zoomed tab-2's active pane (a capture-owned background
    // coordinate) must STILL be restored, or tab-2 later opens on the capture's
    // pane instead of the user's.
    store.dispatch(addTab({ id: 'tab-3', title: 'Three' }))
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      before,
      new Set(['tab-2']),
      { tab: 'tab-2', paneByTab: new Map([['tab-2', 'pane-2b']]) },
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-3') // user's newer selection preserved
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2') // capture-owned background coordinate restored
  })

  it('reports false when the restore target is deleted DURING the restore window (race pin)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // capture switched away
    // Delete the restore target inside the afterPaint window: restoreFocus
    // dispatches setActiveTab('tab-1') while tab-1 still exists, then awaits
    // two animation frames; our rAF-queued removeTab runs inside that window
    // (rAF callbacks fire FIFO), so the post-paint verify must see it gone.
    requestAnimationFrame(() => { store.dispatch(removeTab('tab-1')) })
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { selectionSerial: getPaneSelectionSerial(), activeTabId: 'tab-1', activePaneByTab: {} },
      new Set()
    )
    expect(ok).toBe(false)
  })
})

describe('captureUiScreenshot newer-selection supersession', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    // Full reset — clearAllMocks leaves mockImplementation(+once queues) in
    // place, and another test's orphaned once-impl/html2canvas body otherwise
    // leaks into the capture-path outcomes these tests assert on.
    vi.resetAllMocks()
    // Restore the module-factory defaults the capture path relies on: renderer
    // suspension resolves to a no-op restore, and html2canvas returns
    // undefined (the capture then fails its encode step — the baseline these
    // tests build their scenarios on).
    vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementation(async () => async () => {})
  })

  afterEach(async () => {
    // Queue discipline: capture tails defer their final settlement behind
    // deadline + abandon timers (~decade seconds). Drain before the NEXT test
    // starts so nothing inherits this one's leftover slot.
    await drainCaptureQueueForTests()
  })

  it('never moves the active tab when a newer user selection landed during renderer suspension', async () => {
    const store = createFocusStore()
    // The user re-selects their current tab WHILE the capture suspends WebGL
    // renderers (the awaited window between the focus snapshot and the first
    // capture-internal focus write).
    vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementationOnce(async () => {
      store.dispatch(setActiveTab('tab-1'))
      return async () => {}
    })
    const result = await captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2' },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/superseded/)
    expect(store.getState().tabs.activeTabId).toBe('tab-1') // user's selection not stomped
    expect(result.changedFocus).toBe(false)
  })

  it('never moves the active pane when a newer user selection lands between the capture tab and pane moves', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({
      tabId: 'tab-2',
      paneId: 'pane-2',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2b',
    })) // setup only — completes before the capture snapshot
    // Interpose: the user clicks pane-2b AFTER the capture's tab switch but
    // BEFORE its pane switch.
    let intercepted = false
    const dispatch = (action: any) => {
      const result = store.dispatch(action)
      if (!intercepted && (action as any)?.type === 'tabs/selectTabForCapture') {
        intercepted = true
        store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2b' }))
      }
      return result
    }
    const result = await captureUiScreenshot(
      { scope: 'pane', tabId: 'tab-2', paneId: 'pane-2' },
      { dispatch, getState: store.getState } as any,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/superseded/)
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2b') // user's pane preserved
  })

  it('serializes concurrent captures end-to-end (a second capture starts only after the first fully restores)', async () => {
    const store = createFocusStore()
    // Interleaving captures corrupt one another: the other's interim moves and
    // restores look like user selections to the supersession checks, and the
    // renderer suspension is not overlap-safe. Captures MUST queue.
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const suspendMock = vi.mocked(suspendTerminalRenderersForScreenshot)
    suspendMock.mockImplementationOnce(async () => {
      await firstGate
      return async () => {}
    })
    let secondSuspendCalled = false
    suspendMock.mockImplementationOnce(async () => {
      secondSuspendCalled = true
      return async () => {}
    })
    const first = captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2' },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    const second = captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2' },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    await new Promise((resolve) => setTimeout(resolve, 10)) // let micro/macrotasks run
    expect(secondSuspendCalled).toBe(false) // second capture is still queued
    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondSuspendCalled).toBe(true)
    expect(firstResult.error).toBeDefined() // jsdom has no real tab targets
    expect(secondResult.error).toBeDefined()
    expect(store.getState().tabs.activeTabId).toBe('tab-1') // user's selection survives both captures
  })

  it('expires a capture whose server-stamped deadline already passed at dequeue (first-in-queue included)', async () => {
    const store = createFocusStore()
    const result = await captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() - 1 },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/deadline/)
    expect(vi.mocked(suspendTerminalRenderersForScreenshot)).not.toHaveBeenCalled()
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('aborts mid-capture before any focus write once the server-stamped deadline elapses', async () => {
    const store = createFocusStore()
    // The renderer suspension (real frames on a busy main thread) eats the
    // remaining deadline; the capture must NOT move focus afterwards.
    vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return async () => {}
    })
    const result = await captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() + 60 },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/deadline/)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(result.changedFocus).toBe(false)
  })

  it('resolves a queued capture at its deadline even when the capture ahead stalls forever', async () => {
    const store = createFocusStore()
    let releaseHead: ((restore: () => Promise<void>) => void) | undefined
    const suspendMock = vi.mocked(suspendTerminalRenderersForScreenshot)
    let first: Promise<any> | undefined
    try {
      suspendMock.mockImplementationOnce(
        () => new Promise((resolve) => { releaseHead = resolve }), // head parks until released
      )
      first = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      // A loaded box can backlog this test's head behind a previous test's tail:
      // proceed only once the head is actually parked inside its suspension.
      await waitFor(() => expect(suspendMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
      const second = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() + 120 },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/deadline/)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
    } finally {
      // Drain the tail for subsequent tests REGARDLESS of outcome: release the
      // head and let it fail its (absent-DOM) target lookup on its own.
      releaseHead?.(async () => {})
      await first?.catch(() => undefined)
    }
  })

  it('a capture that never settles neither starves LATER captures nor blocks them past its own deadline', async () => {
    const store = createFocusStore()
    document.body.innerHTML = '<div data-tab-content-id="tab-2" id="tab2-el"></div>'
    setRect(document.getElementById('tab2-el')!, 200, 200)
    let releaseHead: ((restore: () => Promise<void>) => void) | undefined
    const suspendMock = vi.mocked(suspendTerminalRenderersForScreenshot)
    suspendMock.mockImplementationOnce(
      () => new Promise((resolve) => { releaseHead = resolve }), // head parks until released
    )
    let first: Promise<any> | undefined
    let second: Promise<any> | undefined
    try {
      first = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() + 60 },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      await waitFor(() => expect(suspendMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
      // The tail abandons the wedged head once ITS deadline + grace elapse, so
      // the next capture runs instead of expiring in starvation. Its own
      // deadline is deliberately generous-but-bounded so timer drift on a
      // loaded box can't flip the race.
      second = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs: Date.now() + 4000 },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(second.error).not.toMatch(/deadline/)
      expect(second.error).not.toMatch(/expired/)
      expect(suspendMock).toHaveBeenCalledTimes(2)
    } finally {
      // Release the abandoned head so it cannot linger into later tests' tails.
      releaseHead?.(async () => {})
      await Promise.allSettled([first, second])
    }
  })

  it('the deadline gates EVERY render: expiry during iframe preparation stops the remaining iframe renders and the main render', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `
      <div data-tab-content-id="tab-2">
        <iframe id="fr1" title="one"></iframe>
        <iframe id="fr2" title="two"></iframe>
      </div>`
    setRect(document.querySelector('[data-tab-content-id="tab-2"]')!, 300, 200)
    setRect(document.getElementById('fr1')!, 100, 100)
    setRect(document.getElementById('fr2')!, 100, 100)
    let html2canvasCalls = 0
    vi.mocked(html2canvas).mockImplementation(async () => {
      html2canvasCalls += 1
      if (html2canvasCalls === 1) {
        // The first iframe render is mid-flight; the deadline elapses NOW —
        // the gate before iframe #2 (and the main render) must stop the rest.
        vi.setSystemTime(Date.now() + 5000)
      }
      return undefined as any
    })
    // Fake the clock: the deadline is fixed at job START; time "passes" only
    // inside the first iframe render — startup latency on a loaded box cannot
    // preempt the scenario. Real-time expiry-race slack is deliberately wide.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const deadlineAtMs = Date.now() + 500
      const result = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/deadline/)
      expect(html2canvasCalls).toBe(1) // no iframe #2, no main render
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
      // Markers stamped before the thrown deadline are reclaimed: a capture
      // that dies inside preparation must not litter the live DOM — later
      // captures re-mark, and stale markers would survive every one.
      expect(document.getElementById('fr1')!.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
      expect(document.getElementById('fr2')!.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires queued captures that outlived the server request window instead of mutating the UI after the caller already failed', async () => {
    const store = createFocusStore()
    // Visible tab-2 element: the first capture completes without focus moves
    // or visibility waits (which depend on Date.now — faked below).
    document.body.innerHTML = '<div data-tab-content-id="tab-2" id="tab2-el"></div>'
    setRect(document.getElementById('tab2-el')!, 200, 200)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      const suspendMock = vi.mocked(suspendTerminalRenderersForScreenshot)
      suspendMock.mockImplementationOnce(async () => {
        await firstGate
        return async () => {}
      })
      const first = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      // Let the FIRST job start and pass its own staleness check at T0 (it is
      // gated inside the renderer suspension; a loaded box can backlog its
      // start behind a previous test's tail).
      await waitFor(() => expect(vi.mocked(suspendTerminalRenderersForScreenshot)).toHaveBeenCalledTimes(1), { timeout: 10_000 })
      // The second capture queues. Before the first releases, time passes
      // beyond the servers' ~10s pending-request timeout — its caller has
      // already received failure.
      const second = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      vi.setSystemTime(Date.now() + 9000)
      releaseFirst()
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult).toBeDefined()
      expect(secondResult.ok).toBe(false)
      expect(secondResult.error).toMatch(/past its server deadline/)
      // The expired job never ran: no renderer suspension, no focus mutation.
      expect(suspendMock).toHaveBeenCalledTimes(1)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('user engagement reaching INTO an iframe of the capture-exposed pane keeps both coordinates (Chromium: hoist fires focusout on the displaced element)', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `
      <div data-pane-shell="true" data-tab-id="tab-2" data-pane-id="pane-2">
        <input id="url-field" placeholder="Enter URL...">
      </div>
      <div data-tab-content-id="tab-2" style="display:none" id="tab2-target"></div>`
    const shell = document.querySelector('[data-pane-shell]')!
    const iframe = document.createElement('iframe')
    iframe.title = 'Framed page'
    shell.appendChild(iframe)
    const urlField = document.getElementById('url-field')!
    const tabEl = document.getElementById('tab2-target')!
    setRect(tabEl, 300, 200)
    const unsubscribe = store.subscribe(() => {
      if (store.getState().tabs.activeTabId !== 'tab-2') return
      tabEl.style.display = 'block'
      // The user is already in the pane's URL field when the capture is
      // showing…
      urlField.focus()
    })
    try {
      const capturing = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      await waitFor(() => expect(store.getState().tabs.activeTabId).toBe('tab-2'), { timeout: 10_000 })
      // …and then moves INTO the embedded page. Real user engagement always
      // has an input event land on the parent document first: sequential-nav
      // keydown (Tab focus chain) or pointer motion over the pane. Capture-side
      // eligibility autofocus never has one — that is the classifier's ground
      // truth distinguishing user engagement from programmatic iframe focus.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }))
      // The parent sees the displacement: focusout on the URL field,
      // activeElement becomes the iframe.
      iframe.focus()
      const result = await capturing
      await waitFor(() => expect(store.getState().tabs.activeTabId).toBe('tab-2'), { timeout: 10_000 })
      expect(result.changedFocus).toBe(true)
      expect(store.getState().tabs.activeTabId).toBe('tab-2') // user stayed on the tab they were engaging
    } finally {
      unsubscribe()
    }
  })

  it('in-pane INPUT focus during the capture never reads as user selection (only genuine in-iframe engagement does)', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `
      <div data-pane-shell="true" data-tab-id="tab-2" data-pane-id="pane-2">
        <input id="url-field" placeholder="Enter URL...">
      </div>
      <div data-tab-content-id="tab-2" style="display:none" id="tab2-target"></div>`
    const urlField = document.getElementById('url-field')!
    const tabEl = document.getElementById('tab2-target')!
    setRect(tabEl, 300, 200)
    // The capture's eligibility flip arrives → a component programmatically
    // focuses its own surface (capture-induced, NOT the user).
    const unsubscribe = store.subscribe(() => {
      if (store.getState().tabs.activeTabId !== 'tab-2') return
      tabEl.style.display = 'block'
      urlField.focus()
    })
    try {
      const result = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(result.changedFocus).toBe(true)
      expect(result.restoredFocus).toBe(true)
      expect(store.getState().tabs.activeTabId).toBe('tab-1') // full rollback — no supersession misfire
    } finally {
      unsubscribe()
    }
  })

  it('programmatic eligibility autofocus of a nested iframe during the capture never reads as user engagement', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `
      <div data-pane-shell="true" data-tab-id="tab-2" data-pane-id="pane-2">
        <input id="url-field" placeholder="Enter URL...">
      </div>
      <div data-tab-content-id="tab-2" style="display:none" id="tab2-target"></div>`
    const shell = document.querySelector('[data-pane-shell]')!
    const iframe = document.createElement('iframe')
    iframe.title = 'Extension content'
    shell.appendChild(iframe)
    const urlField = document.getElementById('url-field')!
    const tabEl = document.getElementById('tab2-target')!
    setRect(tabEl, 300, 200)
    // ExtensionPane behavior on an eligibility flip: focus shifts INTO the
    // extension frame programmatically, with NO preceding user input event.
    // The hoist is real (activeElement becomes the iframe, focusout fires on
    // the displaced field) but it is capture-induced — the rollback must hold.
    const unsubscribe = store.subscribe(() => {
      if (store.getState().tabs.activeTabId !== 'tab-2') return
      tabEl.style.display = 'block'
      urlField.focus()
      iframe.focus()
    })
    try {
      const result = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(result.changedFocus).toBe(true)
      expect(result.restoredFocus).toBe(true)
      expect(store.getState().tabs.activeTabId).toBe('tab-1') // full rollback
    } finally {
      unsubscribe()
    }
  })

  it('a server screenshot.cancel for an in-flight capture aborts it at the next gate', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `<div data-tab-content-id="tab-2" style="display:none" id="tab2-target"></div>`
    const tabEl = document.getElementById('tab2-target')!
    setRect(tabEl, 300, 200)
    const unsubscribe = store.subscribe(() => {
      if (store.getState().tabs.activeTabId !== 'tab-2') return
      tabEl.style.display = 'block'
      // The server already timed out the requester and pushes a cancel frame —
      // capture work that could only answer a dead request unwinds immediately.
      cancelUiScreenshot('req-cancelled')
    })
    try {
      const result = await captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', requestId: 'req-cancelled' },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/cancelled by server/)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
    } finally {
      unsubscribe()
    }
  })

  it('a cancel landing before its capture frame aborts at receipt (late-delivery ordering)', async () => {
    const store = createFocusStore()
    document.body.innerHTML = `<div data-tab-content-id="tab-2" id="tab2-el"></div>`
    setRect(document.getElementById('tab2-el')!, 200, 200)
    // Delivery ordering is not guaranteed for a stalling client: the cancel
    // can precede its capture frame. The receipt-side gate must still fail it.
    cancelUiScreenshot('req-early')
    const result = await captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2', requestId: 'req-early' },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cancelled by server/)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    // The fast-cancel must not leave a tail-scheduled job that still runs the
    // capture afterwards (the entry consume would have eaten the marker out
    // from under the dequeue gate): drain fully, then prove nothing moved.
    await drainCaptureQueueForTests()
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(vi.mocked(suspendTerminalRenderersForScreenshot)).not.toHaveBeenCalled()
  })

  it('the successor waits for an in-flight wind-down — the abandon timer never walks past restore/resume', async () => {
    const store = createFocusStore()
    document.body.innerHTML = '<div data-tab-content-id="tab-2" id="tab2-el"></div>'
    setRect(document.getElementById('tab2-el')!, 200, 200)
    const events: string[] = []
    let releaseResume!: () => void
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve })
    const suspendMock = vi.mocked(suspendTerminalRenderersForScreenshot)
    let suspensionCount = 0
    suspendMock.mockImplementation(async () => {
      const n = ++suspensionCount
      events.push(`suspend-begin:${n}`)
      return async () => {
        events.push(`resume-begin:${n}`)
        if (n === 1) await resumeGate // first wind-down held mid-restore/resume
        events.push(`resume-end:${n}`)
      }
    })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    let first: Promise<any> | undefined
    let second: Promise<any> | undefined
    try {
      const t0 = Date.now()
      first = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs: t0 + 1_000 },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      second = captureUiScreenshot(
        { scope: 'tab', tabId: 'tab-2', deadlineAtMs: t0 + 60_000 },
        { dispatch: store.dispatch, getState: store.getState } as any,
      )
      // Virtual time sweeps past the caller expiry (t+1000) and the abandon
      // timer (deadline + 2s grace, t0+3000). The first job completes its
      // capture phase and parks in its gated wind-down DURING this sweep.
      await vi.advanceTimersByTimeAsync(4000)
      expect(events).toContain('resume-begin:1')
      expect(events).not.toContain('resume-end:1')
      // INVARIANT: suspension #2 may only begin after #1's wind-down ended —
      // neither the natural-completion nor the timer side may walk past it.
      expect(events).not.toContain('suspend-begin:2')
      releaseResume()
      await vi.advanceTimersByTimeAsync(600)
      expect(events).toContain('resume-end:1')
      expect(events).toContain('suspend-begin:2')
    } finally {
      releaseResume?.()
      await Promise.allSettled([first, second])
      vi.useRealTimers()
    }
  })

  it('still performs the focus move and restores it when no newer selection intervenes', async () => {
    const store = createFocusStore()
    // No DOM tab elements exist, so the capture fails target lookup AFTER
    // moving — the move/restore ladder is what this pins.
    const result = await captureUiScreenshot(
      { scope: 'tab', tabId: 'tab-2' },
      { dispatch: store.dispatch, getState: store.getState } as any,
    )
    expect(store.getState().tabs.activeTabId).toBe('tab-1') // restored
    expect(result.changedFocus).toBe(true)
    expect(result.restoredFocus).toBe(true)
  })
})
