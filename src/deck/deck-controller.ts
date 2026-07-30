// Stateful coordinator between the Redux store and a Stream Deck device:
// store subscription -> frame diff -> paint; input dispatch; long-press action
// layer; paging; dials; idle dim; tick loop.
//
// TIMING RULE (load-bearing): ALL durations - long-press classification, action
// layer auto-close, STOP escalation window, idle dim - are computed from
// Date.now() deltas against event timestamps, NEVER from tick counts. Hidden
// tabs throttle setInterval to ~1/min (Chrome intensive throttling); tick-count
// math would inflate every duration ~120x. Timers are reconciled on
// visibilitychange and at the top of every HID input handler (HID input
// dispatch is not throttled in background tabs, so each press is an exact
// wakeup).

import type { DeckCapabilities, DeckDevice, DeckInputEvent } from './deck-device'
import type { DeckStore } from './deck-actions'
import type { DeckArrangement, KeySpec, LayoutPlan } from './frame'
import type { DeckModel, DeckTab } from './deck-selectors'
import type { RootState } from '@/store/store'
import type { DeckTileStyle } from '@shared/settings'
import { ACTION_KEYS, arrangeTabs, buildFrame, clampPage, pageCount, planLayout, resolveArrangement, visibleTabs } from './frame'
import { findApproveTarget, findStopTarget, panesForTab, selectDeckModel } from './deck-selectors'
import { executeDeckStop, focusTabFromDeck, sendDeckApproval } from './deck-actions'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { findPaneContent } from '@/lib/pane-utils'
import { getTerminalTextSnapshot } from './terminal-text-registry'
import { fetchRepoIconMeta } from '@/store/repoIconsSlice'
import { resolvePaneRepoCwd } from '@/lib/repo-icon'
import { IconImageCache, getIconImageCache } from './icon-image-cache'
import { defaultCtxFactory, renderKey as canvasRenderKey, renderStrip as canvasRenderStrip } from './tile-renderer'
import { whenDeckFontReady } from './deck-font'

export type DeckControllerOptions = {
  store: DeckStore & { subscribe(cb: () => void): () => void }
  device: DeckDevice
  renderKey?: (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray
  renderStrip?: (text: string, width: number, height: number) => Uint8ClampedArray
  settings: () => { brightness: number; idleBrightness: number; idleTimeoutSeconds: number; tileStyle: DeckTileStyle }
  now?: () => number
  iconCache?: IconImageCache
  /** Injectable font-ready hook (defaults to whenDeckFontReady); tests drive it directly. */
  fontReady?: (onReady: () => void) => () => void
}

/** What a key displayed at press-down - snapshotted so re-sorts can't retarget a press. */
type PressTarget = { kind: 'pager' } | { kind: 'tab'; tabId: string } | { kind: 'none' }

export const LONG_PRESS_MS = 500
export const ACTION_LAYER_TIMEOUT_MS = 10_000
export const STOP_ESCALATE_MS = 5_000
export const TICK_MS = 500
// Deliberate exception to the file's TIMING RULE: this is a refresh cadence, not a
// duration — under background setInterval throttling previews simply refresh slower.
export const PREVIEW_REFRESH_TICKS = 6 // previews re-checked every 3s

export class DeckController {
  private readonly store: DeckControllerOptions['store']
  private readonly device: DeckDevice
  private readonly renderKeyFn: (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray
  private readonly renderStripFn: (text: string, width: number, height: number) => Uint8ClampedArray
  private readonly settings: DeckControllerOptions['settings']
  private readonly now: () => number
  private readonly iconCache: IconImageCache

  private page = 1
  private actionLayer: { tabId: string; openedAt: number } | null = null
  private pressedAt = new Map<number, { at: number; target: PressTarget }>()
  private lastStopAt = new Map<string, number>() // per paneId
  private lastActivityAt = 0
  private dimmed = false
  private lastPaintedSpecs: string[] = []
  private lastStripText: string | null = null
  private tickCount = 0
  private lastModelJson: string | null = null
  private lastTabsPerPage: number | null = null

  private unsubscribeStore: (() => void) | null = null
  private unsubscribeInput: (() => void) | null = null
  private unsubscribeIcons: (() => void) | null = null
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onVisibilityChange: (() => void) | null = null

  private readonly fontReady: (onReady: () => void) => () => void
  private cancelFontWait: (() => void) | null = null

  constructor(options: DeckControllerOptions) {
    this.store = options.store
    this.device = options.device
    this.iconCache = options.iconCache ?? getIconImageCache()
    this.renderKeyFn = options.renderKey ??
      ((spec, caps) => canvasRenderKey(spec, caps, defaultCtxFactory, (url) => this.iconCache.bitmapFor(url)))
    this.renderStripFn = options.renderStrip ?? ((text, width, height) => canvasRenderStrip(text, width, height, defaultCtxFactory))
    this.settings = options.settings
    this.now = options.now ?? (() => Date.now())
    this.fontReady = options.fontReady ?? whenDeckFontReady
  }

  start(): void {
    this.lastActivityAt = this.now()
    void this.device.setBrightness(this.settings().brightness)
    this.repaint()
    this.probeRepoIcons()
    this.unsubscribeIcons = this.iconCache.subscribe(() => this.repaint())
    this.cancelFontWait = this.fontReady(() => {
      // A font load changes no KeySpec, so the JSON diff (repaint(), line ~148)
      // would paint nothing: invalidate the caches to force a real repaint in Inter.
      this.lastPaintedSpecs = []
      this.lastStripText = null
      this.repaint()
    })
    this.unsubscribeStore = this.store.subscribe(() => this.onStoreChange())
    this.unsubscribeInput = this.device.onInput((event) => this.handleInput(event))
    this.intervalId = setInterval(() => this.tick(), TICK_MS)
    this.onVisibilityChange = () => {
      // Catch-up pass: reconcile Date.now-based duties the throttled interval missed.
      if (document.visibilityState === 'visible') this.tick()
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  stop(): void {
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    this.unsubscribeInput?.()
    this.unsubscribeInput = null
    this.unsubscribeIcons?.()
    this.unsubscribeIcons = null
    this.cancelFontWait?.()
    this.cancelFontWait = null
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      this.onVisibilityChange = null
    }
    void this.device.clear()
  }

  // --- painting ---

  private repaint(pre?: { model: DeckModel; modelJson: string }): void {
    const state = this.store.getState()
    const model = pre?.model ?? selectDeckModel(state)
    this.lastModelJson = pre?.modelJson ?? JSON.stringify(model)
    const caps = this.device.capabilities
    const { plan } = this.layout(model)
    this.lastTabsPerPage = plan.tabsPerPage
    const pages = pageCount(model.tabs.length, plan.tabsPerPage)
    this.page = clampPage(this.page, pages)
    const frame = buildFrame({
      model,
      caps,
      page: this.page,
      actionLayer: this.actionLayerInputs(state),
      // bitmapFor both reports readiness and requests the load - first paint
      // of a tile with an unloaded icon starts the fetch.
      iconReady: (url) => this.iconCache.bitmapFor(url) !== null,
      previewFor: (tabId) => this.previewFor(state, tabId),
    })
    let painted = false
    frame.keys.forEach((spec, keyIndex) => {
      const json = JSON.stringify(spec)
      if (this.lastPaintedSpecs[keyIndex] === json) return
      this.lastPaintedSpecs[keyIndex] = json
      void this.device.setKeyImage(keyIndex, this.renderKeyFn(spec, caps))
      painted = true
    })
    if (frame.strip && frame.strip.text !== this.lastStripText) {
      this.lastStripText = frame.strip.text
      const { touchStripPixelWidth: w, touchStripPixelHeight: h } = caps
      void this.device.setTouchStripImage(this.renderStripFn(frame.strip.text, w, h), w, h)
      painted = true
    }
    if (painted) this.noteActivity() // repaint activity wakes from dim
  }

  private actionLayerInputs(state: RootState): { tabId: string; approveEnabled: boolean; stopEnabled: boolean } | null {
    if (!this.actionLayer) return null
    const tabId = this.actionLayer.tabId
    return {
      tabId,
      approveEnabled: findApproveTarget(state, tabId) !== null,
      stopEnabled: findStopTarget(state, tabId) !== null,
    }
  }

  private previewFor(state: RootState, tabId: string): string[] {
    const paneId = state.panes.activePane[tabId]
    const layout = state.panes.layouts[tabId]
    if (!paneId || !layout) return []
    const content = findPaneContent(layout, paneId)
    if (content && content.kind === 'terminal' && content.terminalId) {
      return getTerminalTextSnapshot(content.terminalId) ?? []
    }
    return []
  }

  /**
   * Probe repo-icon meta for every distinct resolved cwd of the tabs we render.
   * Deliberately UN-gated by settings.panes.repoIconsOnTabs (Design decision 7:
   * deck tiles always show their center glyph). Double-probing alongside a
   * mounted TabBar is harmless - the thunk self-dedupes (repoIconsSlice.ts:36-40).
   */
  private probeRepoIcons(): void {
    const state = this.store.getState()
    const terminalMetaById = state.terminalMeta.byTerminalId
    const cwds = new Set<string>()
    for (const tab of state.tabs.tabs) {
      for (const entry of panesForTab(state, tab)) {
        const cwd = resolvePaneRepoCwd(entry.content, tab, terminalMetaById)
        if (cwd) cwds.add(cwd)
      }
    }
    for (const cwd of cwds) {
      if (!state.repoIcons.byCwd[cwd]) this.store.dispatch(fetchRepoIconMeta(cwd))
    }
  }

  // --- store subscription ---

  private onStoreChange(): void {
    const state = this.store.getState()
    // Probe BEFORE the model-JSON bail-out: the store events that first make a
    // cwd resolvable (upsertTerminalMeta/setTerminalMetaSnapshot) do NOT change
    // the model JSON (icons stay [] until meta AND repoIcons both exist), so a
    // probe placed after the bail-out would never fire in the TabBar-less
    // leader scenario this probe exists for. It cannot loop: the thunk's
    // synchronous pending entry makes the byCwd guard skip that cwd on the
    // re-entrant store change.
    this.probeRepoIcons()
    // ORDERING (load-bearing): compare the model JSON BEFORE any xterm buffer
    // reads - previewFor is only invoked by repaint, which we skip entirely
    // when the model is unchanged.
    const model = selectDeckModel(state)
    const modelJson = JSON.stringify(model)
    if (modelJson === this.lastModelJson) return
    const { plan } = this.layout(model)
    if (this.lastTabsPerPage !== null && plan.tabsPerPage !== this.lastTabsPerPage) this.page = 1
    this.page = clampPage(this.page, pageCount(model.tabs.length, plan.tabsPerPage))
    this.repaint({ model, modelJson })
  }

  // --- input ---

  private handleInput(event: DeckInputEvent): void {
    // Reconcile Date.now-based duties first: HID input is an exact wakeup even
    // when the tab is hidden and the tick interval is throttled.
    this.dutyChecks()
    switch (event.type) {
      case 'keyDown':
        this.pressedAt.set(event.keyIndex, { at: this.now(), target: this.resolveKeyTarget(event.keyIndex) })
        this.noteActivity()
        break
      case 'keyUp':
        this.handleKeyUp(event.keyIndex)
        break
      case 'dialRotate':
        this.handleDialRotate(event.dialIndex, event.ticks)
        break
      case 'dialPress':
        this.handleDialPress(event.dialIndex)
        break
      case 'touchTap':
        this.noteActivity()
        break
    }
  }

  /** Single source of arrangement truth for this device: plan + ordered tabs.
   * buildFrame derives the same pair internally from model.keyLayout + caps,
   * so painting and press targeting stay mirror images. */
  private layout(model: DeckModel): { arrangement: DeckArrangement; plan: LayoutPlan; tabs: DeckTab[] } {
    const arrangement = resolveArrangement(model.keyLayout, this.device.capabilities.keyCount)
    return {
      arrangement,
      plan: planLayout(this.device.capabilities, model.tabs.length, arrangement),
      tabs: arrangeTabs(model.tabs, arrangement),
    }
  }

  /** What this key DISPLAYS right now - captured at press-down so re-sorts can't retarget a press. */
  private resolveKeyTarget(keyIndex: number): PressTarget {
    const model = selectDeckModel(this.store.getState())
    const { plan, tabs } = this.layout(model)
    if (plan.pagerKey !== null && keyIndex === plan.pagerKey) return { kind: 'pager' }
    const slot = plan.tabSlots.indexOf(keyIndex)
    if (slot === -1) return { kind: 'none' }
    const pages = pageCount(model.tabs.length, plan.tabsPerPage)
    const tab = visibleTabs(tabs, clampPage(this.page, pages), plan.tabsPerPage)[slot]
    return tab ? { kind: 'tab', tabId: tab.id } : { kind: 'none' }
  }

  private handleKeyUp(keyIndex: number): void {
    const press = this.pressedAt.get(keyIndex)
    this.pressedAt.delete(keyIndex)
    this.noteActivity()
    if (press === undefined) return // unmatched release
    if (this.actionLayer) {
      this.handleActionKey(keyIndex)
      return
    }
    const duration = this.now() - press.at
    if (press.target.kind === 'pager') {
      const model = selectDeckModel(this.store.getState())
      const { plan } = this.layout(model)
      const pages = pageCount(model.tabs.length, plan.tabsPerPage)
      this.page = this.page >= pages ? 1 : this.page + 1
      this.repaint()
      return
    }
    if (press.target.kind !== 'tab') return
    const tabId = press.target.tabId
    const model = selectDeckModel(this.store.getState())
    if (!model.tabs.some((tab) => tab.id === tabId)) return // tab closed mid-press
    if (duration >= LONG_PRESS_MS) {
      this.actionLayer = { tabId, openedAt: this.now() }
      this.repaint()
    } else {
      focusTabFromDeck(this.store, tabId)
      this.repaint() // optimistic immediacy; store subscription repaints too
    }
  }

  private handleActionKey(keyIndex: number): void {
    const layer = this.actionLayer
    if (!layer) return
    const state = this.store.getState()
    if (keyIndex === ACTION_KEYS.back) {
      this.closeActionLayer()
      return
    }
    if (keyIndex === ACTION_KEYS.approve) {
      const target = findApproveTarget(state, layer.tabId)
      if (!target) return // disabled: stay open
      sendDeckApproval(target)
      if (state.settings.settings.panes.attentionDismiss === 'click') {
        this.store.dispatch(dismissTabGreen(layer.tabId))
      }
      this.closeActionLayer()
      return
    }
    if (keyIndex === ACTION_KEYS.stop) {
      const target = findStopTarget(state, layer.tabId)
      if (!target) return // disabled: stay open
      const escalate = target.kind === 'terminal' && this.withinStopWindow(target.paneId)
      executeDeckStop(target, escalate)
      if (target.kind === 'terminal') this.lastStopAt.set(target.paneId, this.now())
      this.closeActionLayer()
    }
    // other keys ignored
  }

  private withinStopWindow(paneId: string): boolean {
    const last = this.lastStopAt.get(paneId)
    return last !== undefined && this.now() - last < STOP_ESCALATE_MS
  }

  private closeActionLayer(): void {
    this.actionLayer = null
    this.repaint()
  }

  // --- dials & touch ---

  private handleDialRotate(dialIndex: number, ticks: number): void {
    this.noteActivity()
    const state = this.store.getState()
    const model = selectDeckModel(state)
    const { plan, tabs } = this.layout(model)
    if (!plan.useDials) return
    if (dialIndex === 0) {
      const n = tabs.length
      if (n === 0) return
      const idx = tabs.findIndex((t) => t.id === model.activeTabId)
      const next = ((((idx === -1 ? 0 : idx) + ticks) % n) + n) % n
      focusTabFromDeck(this.store, tabs[next].id)
      return
    }
    if (dialIndex === 1) {
      this.page = clampPage(this.page + ticks, pageCount(model.tabs.length, plan.tabsPerPage))
      this.repaint()
    }
  }

  private handleDialPress(dialIndex: number): void {
    this.noteActivity()
    const state = this.store.getState()
    const model = selectDeckModel(state)
    const { plan } = this.layout(model)
    if (!plan.useDials) return
    if (dialIndex === 0) {
      if (model.activeTabId) focusTabFromDeck(this.store, model.activeTabId)
      return
    }
    if (dialIndex === 1) {
      this.page = 1
      this.repaint()
    }
  }

  // --- tick loop & idle dim ---

  private dutyChecks(): void {
    const t = this.now()
    if (this.actionLayer && t - this.actionLayer.openedAt >= ACTION_LAYER_TIMEOUT_MS) {
      this.closeActionLayer()
    }
    const { idleBrightness, idleTimeoutSeconds } = this.settings()
    if (idleTimeoutSeconds > 0 && !this.dimmed && t - this.lastActivityAt >= idleTimeoutSeconds * 1000) {
      this.dimmed = true
      void this.device.setBrightness(idleBrightness)
    }
  }

  private tick(): void {
    this.dutyChecks()
    if (this.settings().tileStyle !== 'terminal-previews') return
    this.tickCount++
    if (this.tickCount % PREVIEW_REFRESH_TICKS === 0) this.repaint() // picks up xterm buffer changes
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now()
    if (this.dimmed) {
      this.dimmed = false
      void this.device.setBrightness(this.settings().brightness)
    }
  }
}
