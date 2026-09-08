import html2canvas from 'html2canvas'
import { setActivePane } from '@/store/panesSlice'
import { selectTabForCapture } from '@/store/tabsSlice'
import { suspendTerminalRenderersForScreenshot } from '@/lib/screenshot-capture-env'
import {
  getPaneSelectionSerial,
  noteDomPaneSelection,
  paneSelectionCoordinate,
  TAB_SELECTION_COORDINATE,
  wasSelectionCoordinateTouchedSince,
} from '@/lib/pane-focus-ownership'
import type { PaneNode } from '@/store/paneTypes'
import type { AppDispatch, RootState } from '@/store/store'

const VISIBLE_WAIT_TIMEOUT_MS = 1500
const VISIBLE_WAIT_INTERVAL_MS = 50
const IFRAME_MARKER_ATTR = 'data-screenshot-iframe-marker'
const IFRAME_IMAGE_ATTR = 'data-screenshot-iframe-image'
const IFRAME_PLACEHOLDER_ATTR = 'data-screenshot-iframe-placeholder'

export type ScreenshotScope = 'pane' | 'tab' | 'view'

export type ScreenshotRequest = {
  scope: ScreenshotScope
  paneId?: string
  tabId?: string
  /** The server's request identity, so a later screenshot.cancel frame (the
   *  server gave up waiting — timeout or closed waiter) can unwind any
   *  queued/in-flight work for it. */
  requestId?: string
  /** Server-stamped absolute round-trip deadline (epoch ms). When absent
   *  (older servers), queue waits are bounded by CAPTURE_QUEUE_TTL_MS measured
   *  from when THIS client received the request. */
  deadlineAtMs?: number
}

export type ScreenshotResult = {
  ok: boolean
  mimeType?: 'image/png'
  imageBase64?: string
  width?: number
  height?: number
  changedFocus: boolean
  restoredFocus: boolean
  error?: string
}

type RuntimeContext = {
  dispatch: AppDispatch
  getState: () => RootState
}

export type FocusSnapshot = {
  /** Selection serial at capture start — any newer explicit select during the
   *  CAPTURE suspends both pane and tab restores (newer selection wins). */
  selectionSerial: number
  activeTabId: string | null
  activePaneByTab: Record<string, string>
}

type IframeReplacement =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'placeholder'; message: string; src: string }

type PreparedIframeCapture = {
  onclone: (doc: Document) => void
  cleanup: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function snapshotFocus(state: RootState): FocusSnapshot {
  return {
    selectionSerial: getPaneSelectionSerial(),
    activeTabId: state.tabs.activeTabId,
    activePaneByTab: { ...state.panes.activePane },
  }
}

function isElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = element.getBoundingClientRect()
  return rect.width >= 2 && rect.height >= 2
}

async function waitForVisibleElement(getElement: () => HTMLElement | null, timeoutMs = VISIBLE_WAIT_TIMEOUT_MS): Promise<HTMLElement | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const candidate = getElement()
    if (candidate && isElementVisible(candidate)) return candidate
    await sleep(VISIBLE_WAIT_INTERVAL_MS)
  }
  return null
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function safeIframeSrc(iframe: HTMLIFrameElement): string {
  const direct = iframe.getAttribute('src')
  if (direct && direct.trim()) return direct.trim()
  try {
    return iframe.src || 'about:blank'
  } catch {
    return 'about:blank'
  }
}

function truncateText(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3)}...`
}

function normalizeDataUrl(dataUrl: string): string | null {
  return dataUrl.startsWith('data:image/png;base64,') ? dataUrl : null
}

async function captureIframeReplacement(iframe: HTMLIFrameElement, scale: number): Promise<IframeReplacement> {
  const src = safeIframeSrc(iframe)
  const crossOriginMessage = 'Iframe content is not directly capturable in browser screenshots'

  try {
    const iframeDoc = iframe.contentDocument
    const iframeWin = iframe.contentWindow
    if (!iframeDoc || !iframeDoc.documentElement || !iframeWin) {
      throw new Error('iframe document unavailable')
    }

    const rect = iframe.getBoundingClientRect()
    const captureWidth = Math.max(1, Math.floor(rect.width || iframe.clientWidth || 1))
    const captureHeight = Math.max(1, Math.floor(rect.height || iframe.clientHeight || 1))

    const canvas = await html2canvas(iframeDoc.documentElement as HTMLElement, {
      backgroundColor: null,
      allowTaint: true,
      useCORS: true,
      logging: false,
      scale,
      width: captureWidth,
      height: captureHeight,
      x: iframeWin.scrollX,
      y: iframeWin.scrollY,
      scrollX: -iframeWin.scrollX,
      scrollY: -iframeWin.scrollY,
      windowWidth: captureWidth,
      windowHeight: captureHeight,
    })

    const encoded = normalizeDataUrl(canvas.toDataURL('image/png'))
    if (encoded) {
      return { kind: 'image', dataUrl: encoded }
    }
  } catch {
    // Browser iframe access is best-effort only; fall through to placeholder.
  }

  return {
    kind: 'placeholder',
    message: crossOriginMessage,
    src: truncateText(src),
  }
}

function buildIframeReplacementElement(
  doc: Document,
  iframe: HTMLIFrameElement,
  replacement: IframeReplacement,
): HTMLElement {
  const container = doc.createElement('div')
  container.className = iframe.className
  const inlineStyle = iframe.getAttribute('style')
  if (inlineStyle) {
    container.setAttribute('style', inlineStyle)
  }
  container.style.width = container.style.width || '100%'
  container.style.height = container.style.height || '100%'
  container.style.minHeight = container.style.minHeight || '1px'

  if (replacement.kind === 'image') {
    const image = doc.createElement('img')
    image.setAttribute(IFRAME_IMAGE_ATTR, 'true')
    image.src = replacement.dataUrl
    image.alt = 'Iframe screenshot content'
    image.style.width = '100%'
    image.style.height = '100%'
    image.style.display = 'block'
    image.style.objectFit = 'fill'
    container.appendChild(image)
    return container
  }

  container.setAttribute(IFRAME_PLACEHOLDER_ATTR, 'true')
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.justifyContent = 'center'
  container.style.alignItems = 'center'
  container.style.textAlign = 'center'
  container.style.background = '#f5f5f5'
  container.style.color = '#1f2937'
  container.style.padding = '12px'
  container.style.fontSize = '12px'

  const title = doc.createElement('div')
  title.textContent = replacement.message
  title.style.fontWeight = '600'
  title.style.marginBottom = '6px'
  container.appendChild(title)

  const src = doc.createElement('code')
  src.textContent = replacement.src
  src.style.fontSize = '11px'
  src.style.maxWidth = '100%'
  src.style.whiteSpace = 'normal'
  src.style.wordBreak = 'break-all'
  container.appendChild(src)

  return container
}

export async function prepareIframeCapture(target: HTMLElement, scale: number, throwIfStale?: () => void): Promise<PreparedIframeCapture> {
  const iframes = Array.from(target.querySelectorAll('iframe'))
  if (iframes.length === 0) {
    return {
      onclone: () => {},
      cleanup: () => {},
    }
  }

  const markedIframes = new Map<string, HTMLIFrameElement>()
  const previousMarkers = new Map<HTMLIFrameElement, string | null>()
  // iframe → the marker WE stamped, so cleanup restores only our own marks:
  // an abandoned capture's late cleanup must never erase the successor's.
  const ourMarkerByIframe = new Map<HTMLIFrameElement, string>()
  const replacements = new Map<string, IframeReplacement>()
  const markerPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  for (let i = 0; i < iframes.length; i += 1) {
    const iframe = iframes[i]
    const marker = `shot-iframe-${markerPrefix}-${i}`
    previousMarkers.set(iframe, iframe.getAttribute(IFRAME_MARKER_ATTR))
    iframe.setAttribute(IFRAME_MARKER_ATTR, marker)
    ourMarkerByIframe.set(iframe, marker)
    markedIframes.set(marker, iframe)
  }

  const restoreMarkers = () => {
    for (const [iframe, previous] of previousMarkers) {
      const ours = ourMarkerByIframe.get(iframe)
      // A successor capture re-stamped this marker while we were away:
      // restoring our recorded previous value would erase ITS marker.
      if (ours !== undefined && iframe.getAttribute(IFRAME_MARKER_ATTR) !== ours) continue
      if (previous === null) {
        iframe.removeAttribute(IFRAME_MARKER_ATTR)
      } else {
        iframe.setAttribute(IFRAME_MARKER_ATTR, previous)
      }
    }
  }

  try {
    for (const [marker, iframe] of markedIframes) {
      if (!isElementVisible(iframe)) continue
      // Each iframe is its own html2canvas render; the deadline gates EVERY one.
      throwIfStale?.()
      replacements.set(marker, await captureIframeReplacement(iframe, scale))
    }
  } catch (err) {
    // The caller never receives our cleanup handle when we throw — reclaim
    // the markers we already stamped so a dead pre-render capture leaves no
    // litter in the live DOM.
    restoreMarkers()
    throw err
  }

  return {
    onclone: (doc: Document) => {
      const cloneIframes = Array.from(doc.querySelectorAll(`iframe[${IFRAME_MARKER_ATTR}]`))
      for (const candidate of cloneIframes) {
        const cloneIframe = candidate as HTMLIFrameElement
        const marker = cloneIframe.getAttribute(IFRAME_MARKER_ATTR)
        if (!marker) continue
        const replacement = replacements.get(marker)
        if (!replacement) continue
        cloneIframe.replaceWith(buildIframeReplacementElement(doc, cloneIframe, replacement))
      }
    },
    cleanup: restoreMarkers,
  }
}

function findPaneElement(paneId: string): HTMLElement | null {
  const escaped = escapeSelectorValue(paneId)
  return document.querySelector(`[data-pane-shell="true"][data-pane-id="${escaped}"]`) as HTMLElement | null
}

function findTabElement(tabId: string): HTMLElement | null {
  const escaped = escapeSelectorValue(tabId)
  return document.querySelector(`[data-tab-content-id="${escaped}"]`) as HTMLElement | null
}

function findViewElement(): HTMLElement | null {
  return (document.querySelector('[data-context="global"]') as HTMLElement | null) || document.body
}

function nodeContainsPane(node: PaneNode | undefined, paneId: string): boolean {
  if (!node) return false
  if (node.type === 'leaf') return node.id === paneId
  return nodeContainsPane(node.children[0], paneId) || nodeContainsPane(node.children[1], paneId)
}

function findTabIdForPane(state: RootState, paneId: string): string | undefined {
  for (const [tabId, root] of Object.entries(state.panes.layouts)) {
    if (nodeContainsPane(root, paneId)) return tabId
  }
  return undefined
}

/** Which coordinates the capture itself moved, and to what. Consulted ONLY
 *  under supersession (a newer user selection during the capture). */
export type CaptureMoves = {
  /** The tab the capture activated (null when it never switched tabs). */
  tab: string | null
  /** tabId → the pane the capture activated there. */
  paneByTab: Map<string, string>
}

export async function restoreFocus(
  ctx: RuntimeContext,
  before: FocusSnapshot,
  paneTabsToRestore: Set<string>,
  captureMoves?: CaptureMoves,
): Promise<boolean> {
  // A newer explicit selection during the capture supersedes the restore —
  // but only for the coordinates the user actually touched. The serial is
  // bumped by selection folds (setActivePane incl. pointer activations,
  // nudgePaneFocus, setActiveTab) AND by other user gestures that move the
  // selection (default-activating addTab, keyboard tab navigation, default-
  // activating splitPane / addPane, active-close fallbacks); the capture's
  // own moves use capture:true / selectTabForCapture, which never bump it,
  // and agent folds pass activate:false.
  const superseded = getPaneSelectionSerial() !== before.selectionSerial
  // Under supersession, restore a coordinate only when the USER never touched
  // it AND it still sits exactly on the capture's own move target (a third
  // party moved it → leave it alone). This preserves the user's newer
  // selection while still rolling back capture-owned background coordinates
  // (e.g. a zoomed tab's active pane), which the all-or-nothing global check
  // used to abandon.
  const shouldRestoreTab = (state: RootState): boolean =>
    !superseded
    || (!wasSelectionCoordinateTouchedSince(TAB_SELECTION_COORDINATE, before.selectionSerial)
      && captureMoves?.tab != null
      && state.tabs.activeTabId === captureMoves.tab)
  const shouldRestorePane = (state: RootState, tabId: string): boolean =>
    !superseded
    || (!wasSelectionCoordinateTouchedSince(paneSelectionCoordinate(tabId), before.selectionSerial)
      && captureMoves?.paneByTab.get(tabId) !== undefined
      && state.panes.activePane[tabId] === captureMoves?.paneByTab.get(tabId))
  const restoredPaneTabs: string[] = []
  let restoredTab = false
  let incomplete = false
  try {
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      const state = ctx.getState()
      // Best-effort: a pane/tab deleted mid-capture can never receive focus
      // back — skip it (dispatching the restore would resurrect a dead
      // activePane entry and blank the tab's work area), mark the restore
      // incomplete, and KEEP restoring the surviving targets rather than
      // leaving the user parked on a capture-selected tab/pane.
      if (!state.tabs.tabs.some((t) => t.id === tabId)
        || !nodeContainsPane(state.panes.layouts[tabId], originalPaneId)) {
        incomplete = true
        continue
      }
      if (!shouldRestorePane(state, tabId)) continue
      if (state.panes.activePane[tabId] !== originalPaneId) {
        // Restore dispatches are capture-internal too: a real-looking pane
        // fold here would co-touch the tab coordinate (active-tab co-touch
        // rule) and veto the tab restore that follows.
        ctx.dispatch(setActivePane({ tabId, paneId: originalPaneId, capture: true }))
      }
      restoredPaneTabs.push(tabId)
    }

    if (before.activeTabId) {
      const state = ctx.getState()
      if (!state.tabs.tabs.some((t) => t.id === before.activeTabId)) {
        incomplete = true
      } else if (shouldRestoreTab(state)) {
        if (state.tabs.activeTabId !== before.activeTabId) {
          ctx.dispatch(selectTabForCapture(before.activeTabId))
        }
        restoredTab = true
      }
    }

    await afterPaint()

    const after = ctx.getState()
    if (restoredTab && before.activeTabId) {
      if (!after.tabs.tabs.some((t) => t.id === before.activeTabId)) {
        incomplete = true // deleted during the restore window
      } else if (after.tabs.activeTabId !== before.activeTabId) return false
    }
    for (const tabId of restoredPaneTabs) {
      const originalPaneId = before.activePaneByTab[tabId]
      // The OWNING TAB may have been deleted during the restore window while
      // stale pane layout/activePane entries linger (removeTab and the pane
      // cleanup are separate slices) — that must ALSO be incomplete, not true.
      if (!after.tabs.tabs.some((t) => t.id === tabId)
        || !nodeContainsPane(after.panes.layouts[tabId], originalPaneId)) {
        incomplete = true // deleted during the restore window
        continue
      }
      if (after.panes.activePane[tabId] !== originalPaneId) return false
    }
    return !incomplete
  } catch {
    return false
  }
}

// Captures mutate app-wide focus/tab state and suspend renderers, so two
// captures MUST NOT overlap: an interleaved capture's interim moves/restores
// and renderer resume boundaries interleave otherwise. Serialize captures
// client-side (capture-internal dispatches — moves AND restores — are
// serial-invisible by construction).
let captureTail: Promise<unknown> = Promise.resolve()

// Both servers drop a pending screenshot request ~10s after SENDING it
// (server/ws-handler.ts: opts.timeoutMs ?? 10_000, stamped as payload
// .deadlineAtMs; crates/freshell-server/src/screenshots.rs: SCREENSHOT_TIMEOUT)
// — and the server clock starts BEFORE the frame reaches this client. Any
// queue/execution age must therefore be measured against the stamped deadline
// (when present), never against local receipt time. When the deadline is
// absent (older servers), bound queue waits client-side:
export const CAPTURE_QUEUE_TTL_MS = 8000
// A job whose execution blows past its deadline is wedged (a hung renderer,
// html2canvas, ...). It cannot be cancelled, so the tail abandons it after a
// grace window — one stalled capture must not starve every later screenshot
// the caller might still succeed at. Abandonment is FENCED: the abandoned
// job's wind-down (renderer resume + focus rollback) is driven once, at
// abandonment, before the successor starts — never again at the job's
// eventual end, so it cannot overlap its successor's capture.
const CAPTURE_ABANDON_GRACE_MS = 2000

let captureEpoch = 0
/** epoch → exactly-once wind-down (renderer resume + focus rollback), driven
 *  at normal completion OR at abandonment, whichever comes first. */
const pendingWindDown = new Map<number, () => Promise<void>>()

function expiredDeadlineResult(): ScreenshotResult {
  return {
    ok: false,
    changedFocus: false,
    restoredFocus: false,
    error: 'screenshot request expired: past its server deadline',
  }
}

/** Server-side timeout unwind: the server already failed the waiter for this
 *  id, so any queued/in-flight capture for it must not mutate UI. Consulted
 *  entry-side AND at every staleness gate, because on a stalled client the
 *  cancel frame can arrive before its capture frame. */
const cancelledCaptures = new Set<string>()

export function cancelUiScreenshot(requestId: string): void {
  if (!requestId) return
  // Bounded: a cancel for a frame that never arrived would linger forever.
  if (cancelledCaptures.size >= 1024) cancelledCaptures.clear()
  cancelledCaptures.add(requestId)
}

function cancelledScreenshotResult(): ScreenshotResult {
  return { ok: false, changedFocus: false, restoredFocus: false, error: 'screenshot cancelled by server' }
}

/** Consume-and-check: a consumed id cannot poison a later, unrelated run. */
function consumeCancellation(requestId: string | undefined): boolean {
  if (!requestId || !cancelledCaptures.has(requestId)) return false
  cancelledCaptures.delete(requestId)
  return true
}

/** Test-only: await the capture queue until fully drained (including abandon
 *  timers and fenced wind-downs). Tests that drive parked/abandoned captures
 *  call this in afterEach so no test inherits another test's deferred tail. */
export async function drainCaptureQueueForTests(): Promise<void> {
  while (true) {
    const tail = captureTail
    await tail.catch(() => undefined)
    if (captureTail === tail) return
  }
}

export async function captureUiScreenshot(request: ScreenshotRequest, ctx: RuntimeContext): Promise<ScreenshotResult> {
  const deadlineAtMs = request.deadlineAtMs ?? (Date.now() + CAPTURE_QUEUE_TTL_MS)
  // A request cancelled BEFORE its frame even ran here must never enqueue
  // work — queueing first and fast-failing second would let the entry consume
  // eat the marker out from under the tail-scheduled job's own dequeue gate.
  if (consumeCancellation(request.requestId)) return cancelledScreenshotResult()
  const epoch = ++captureEpoch
  const job: Promise<ScreenshotResult> = captureTail.then(() => {
    if (consumeCancellation(request.requestId)) return cancelledScreenshotResult()
    if (Date.now() >= deadlineAtMs) return expiredDeadlineResult()
    return performUiScreenshotCapture(request, ctx, deadlineAtMs, epoch)
  })
  // The tail advances when the job settles — or walks past it entirely once
  // the job has blown its deadline plus grace (wedged capture, never settled).
  // Walking past it FENCES it: its wind-down runs here, not at its own end.
  captureTail = Promise.race([
    job,
    new Promise<unknown>((resolve) => setTimeout(() => {
      const wind = pendingWindDown.get(epoch)
      if (!wind) {
        resolve(undefined)
        return
      }
      // The tail advances only once the abandoned job's wind-down is fully
      // settled — the successor neither sees a half-restored selection nor
      // shares renderer suspension with the abandoned job.
      void wind().then(resolve, resolve)
    }, Math.max(0, deadlineAtMs + CAPTURE_ABANDON_GRACE_MS - Date.now()))),
  ]).then(() => undefined, () => undefined)
  // A stalled head must not park this caller past the deadline: answer with
  // the expiry result; the queued job later hits its dequeue gate and no-ops.
  const remaining = deadlineAtMs - Date.now()
  if (remaining <= 0) return expiredDeadlineResult()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<ScreenshotResult>((resolve) => {
    timer = setTimeout(() => resolve(expiredDeadlineResult()), remaining)
  })
  return Promise.race([job, expiry]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

async function performUiScreenshotCapture(request: ScreenshotRequest, ctx: RuntimeContext, deadlineAtMs: number, epoch: number): Promise<ScreenshotResult> {
  const focusBefore = snapshotFocus(ctx.getState())
  const paneTabsToRestore = new Set<string>()
  // Every capture-internal move is ALSO recorded here, keyed by what the
  // capture moved each coordinate TO — restoreFocus consults this under
  // supersession to restore only coordinates the user never touched.
  const capturePaneTargets = new Map<string, string>()
  let captureTabTarget: string | null = null
  let changedFocus = false
  let restoredFocus = false
  // The serial is sampled at snapshot time, but the renderer suspension below
  // awaits two animation frames — a user selection can land in that gap (or
  // between the tab move and the pane move). Re-check before every capture-
  // internal focus write: stomping the newer selection is worse than aborting
  // the screenshot (partial moves are handled by restoreFocus, whose serial
  // mismatch deliberately skips the rollback).
  const selectionSuperseded = () => getPaneSelectionSerial() !== focusBefore.selectionSerial
  // The stamped deadline likewise expires mid-flight: never move focus (or
  // render) for a caller the server has already failed.
  const deadlineExceeded = () => Date.now() >= deadlineAtMs
  const throwIfStale = () => {
    if (consumeCancellation(request.requestId)) throw new Error('screenshot cancelled by server')
    if (selectionSuperseded()) throw new Error('screenshot superseded by a newer user selection')
    if (deadlineExceeded()) throw new Error('screenshot aborted: exceeded its server deadline mid-capture')
  }

  const setActiveTabIfNeeded = async (tabId: string) => {
    if (ctx.getState().tabs.activeTabId === tabId) return
    throwIfStale()
    // Capture-internal: invisible to the selection serial, so it cannot void
    // the restore of a user/agent selection landing mid-capture.
    ctx.dispatch(selectTabForCapture(tabId))
    captureTabTarget = tabId
    changedFocus = true
    await afterPaint()
  }

  const setActivePaneIfNeeded = async (tabId: string, paneId: string) => {
    if (ctx.getState().panes.activePane[tabId] === paneId) return
    throwIfStale()
    // Capture-internal activation: must not bump the selection serial — the
    // restore contract attributes serial changes to user/agent selections.
    ctx.dispatch(setActivePane({ tabId, paneId, capture: true }))
    paneTabsToRestore.add(tabId)
    capturePaneTargets.set(tabId, paneId)
    changedFocus = true
    await afterPaint()
  }

  let result: Omit<ScreenshotResult, 'changedFocus' | 'restoredFocus'>

  // Exactly-once wind-down: renderer resume + focus rollback happen at normal
  // completion OR at abandonment (the fence the tail timer invokes) —
  // whichever comes first. An abandoned job that eventually settles does NOT
  // wind down a second time, so it can never overlap its successor's capture.
  // The fence is registered BEFORE renderer suspension ACQUISITION (which can
  // sit in an rAF-starved paint window in background tabs): an abandonment
  // landing mid-acquisition arms the late-resume handoff below.
  let windDownPromise: Promise<void> | null = null
  let restoreRenderersFn: (() => Promise<void>) | null = null
  let resumeAfterAcquire = false

  // User engagement reaching INTO a pane's nested iframe during a capture is
  // user selection activity — but it must be detected with platform truth:
  // nested-document engagement is a HOIST (activeElement becomes the iframe);
  // focus/focusin never fire parent-side for it (Chromium-verified, see
  // focus-steal-guard.ts). The observables are focusout on the displaced
  // element and window blur (when body was displaced). Checking after a task
  // because the activeElement reassignment is mid-flight during dispatch.
  // A hoist only counts as USER engagement when real input preceded it —
  // sequential-nav keydown landing on the parent document, or pointer
  // activity over the app. Capture-side eligibility autofocus ALSO hoists
  // programmatically (ExtensionPane focuses its iframe on a flip) but has no
  // input trail; counting it would veto this capture's own rollback.
  const INTENT_WINDOW_MS = 1500
  let lastUserIntentAtMs = -Infinity
  const noteUserIntent = () => { lastUserIntentAtMs = Date.now() }
  document.addEventListener('keydown', noteUserIntent, true)
  document.addEventListener('pointerdown', noteUserIntent, true)
  document.addEventListener('pointermove', noteUserIntent, { capture: true, passive: true })
  const checkForIframeHoist = () => {
    if (Date.now() - lastUserIntentAtMs > INTENT_WINDOW_MS) return
    const el = document.activeElement as HTMLElement | null
    if (!el || el.tagName !== 'IFRAME' || typeof el.closest !== 'function') return
    const paneHost = el.closest('[data-pane-id]') as HTMLElement | null
    if (!paneHost) return
    const tabId = (paneHost.closest('[data-tab-id]') as HTMLElement | null)
      ?.getAttribute('data-tab-id')
      ?? null
    noteDomPaneSelection(tabId, ctx.getState().tabs.activeTabId === tabId)
  }
  const onHoistSignal = () => { setTimeout(checkForIframeHoist, 0) }
  document.addEventListener('focusout', onHoistSignal)
  window.addEventListener('blur', onHoistSignal)

  // Wind-down is a SHARED PROMISE, started exactly once and joined by every
  // caller (natural completion AND the abandonment timer): whoever starts
  // second must WAIT for the in-flight restore + renderer resume, never walk
  // past it. The map entry survives until the promise fully settles so the
  // timer still finds it mid-wind-down.
  const windDown = (): Promise<void> => {
    if (!windDownPromise) {
      windDownPromise = (async () => {
        document.removeEventListener('focusout', onHoistSignal)
        window.removeEventListener('blur', onHoistSignal)
        document.removeEventListener('keydown', noteUserIntent, true)
        document.removeEventListener('pointerdown', noteUserIntent, true)
        document.removeEventListener('pointermove', noteUserIntent, true)
        // Restore Redux selection state BEFORE releasing the renderers: the
        // successor's snapshot must see the rollback, and restoreFocus dispatches
        // synchronously up to its paint await, while renderer resume only frees
        // pixels (paint-time only).
        if (changedFocus) {
          restoredFocus = await restoreFocus(ctx, focusBefore, paneTabsToRestore, {
            tab: captureTabTarget,
            paneByTab: capturePaneTargets,
          })
        }
        if (restoreRenderersFn) {
          await restoreRenderersFn()
        } else {
          resumeAfterAcquire = true
        }
      })()
      const clearEntry = () => {
        if (pendingWindDown.get(epoch) === windDown) pendingWindDown.delete(epoch)
      }
      void windDownPromise.then(clearEntry, clearEntry)
    }
    return windDownPromise
  }
  pendingWindDown.set(epoch, windDown)
  const restoreRenderers = await suspendTerminalRenderersForScreenshot()
  restoreRenderersFn = restoreRenderers
  // The fence may HAVE fired while the suspension was being acquired: hand the
  // resumer off so the balance closes exactly once.
  if (resumeAfterAcquire) await restoreRenderers()

  try {
    let target: HTMLElement | null = null

    if (request.scope === 'view') {
      target = findViewElement()
    } else if (request.scope === 'tab') {
      const tabId = request.tabId
      if (!tabId) throw new Error('tabId required for tab scope')

      target = findTabElement(tabId)
      if (!target || !isElementVisible(target)) {
        await setActiveTabIfNeeded(tabId)
        target = await waitForVisibleElement(() => findTabElement(tabId))
      }
    } else {
      const paneId = request.paneId
      if (!paneId) throw new Error('paneId required for pane scope')

      target = findPaneElement(paneId)
      if (!target || !isElementVisible(target)) {
        const targetTabId = request.tabId || findTabIdForPane(ctx.getState(), paneId)
        if (!targetTabId) throw new Error('pane tab not found')

        await setActiveTabIfNeeded(targetTabId)
        target = findPaneElement(paneId)

        if (!target || !isElementVisible(target)) {
          await setActivePaneIfNeeded(targetTabId, paneId)
          target = await waitForVisibleElement(() => findPaneElement(paneId))
        }
      }
    }

    if (!target) throw new Error('capture target not found')
    if (!isElementVisible(target)) {
      const visibleTarget = await waitForVisibleElement(() => target)
      if (!visibleTarget) throw new Error('capture target is not visible')
      target = visibleTarget
    }

    throwIfStale()
    const scale = Math.max(1, window.devicePixelRatio || 1)
    const preparedIframes = await prepareIframeCapture(target, scale, throwIfStale)
    let canvas: HTMLCanvasElement
    try {
      throwIfStale() // prep can cross the deadline — re-gate the main render
      canvas = await html2canvas(target, {
        backgroundColor: null,
        allowTaint: true,
        useCORS: true,
        logging: false,
        scale,
        onclone: (doc) => {
          preparedIframes.onclone(doc)
        },
      })
    } finally {
      preparedIframes.cleanup()
    }

    const dataUrl = canvas.toDataURL('image/png')
    const prefix = 'data:image/png;base64,'
    if (!dataUrl.startsWith(prefix)) throw new Error('failed to encode png screenshot')

    result = {
      ok: true,
      mimeType: 'image/png',
      imageBase64: dataUrl.slice(prefix.length),
      width: canvas.width,
      height: canvas.height,
    }
  } catch (err: any) {
    result = {
      ok: false,
      error: err?.message || 'failed to capture screenshot',
    }
  }

  await windDown()

  return {
    ...result,
    changedFocus,
    restoredFocus,
  }
}
