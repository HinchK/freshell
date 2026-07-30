import type { DeckKeyLayout } from '@shared/settings'
import type { DeckCapabilities } from './deck-device'
import type { DeckModel, DeckTab, TilePaneIcon } from './deck-selectors'
import type { TileFill } from './tile-state'
import { PANE_TINT_COLORS } from './pane-tint-colors'
import { providerIconDataUrl } from './provider-icon-svg'

export type RingColor = 'amber' | 'green' | 'blue' | null
export type DeckAction = 'back' | 'approve' | 'stop'
export type TileIcon = { url: string | null; letter: string; hue: number; ready: boolean }
export type TilePaneIconSpec = TilePaneIcon & { ready: boolean }
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; style: 'icons'; tabId: string; title: string; active: boolean; fill: TileFill; paneIcons: TilePaneIconSpec[]; icons: TileIcon[] }
  | { kind: 'tab'; style: 'preview'; tabId: string; title: string; active: boolean; previewLines: string[]; ring: RingColor }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
export type StripSpec = { text: string } | null
export type FrameSpec = { keys: KeySpec[]; strip: StripSpec }

export const ACTION_KEYS: Record<DeckAction, number> = { back: 0, approve: 1, stop: 2 }

export type LayoutPlan = {
  mode: 'full' | 'keys'
  keyCount: number
  tabSlots: number[]
  pagerKey: number | null
  tabsPerPage: number
  useDials: boolean
  useStrip: boolean
}

export type DeckArrangement = 'standard' | 'reversed'

/** Smallest decks (<= 6 keys, e.g. the 6-key Mini) default to the reversed
 * "newest first" arrangement under keyLayout 'auto'; larger decks keep the
 * status-sorted standard. */
export const AUTO_REVERSED_MAX_KEYS = 6

export function resolveArrangement(keyLayout: DeckKeyLayout, keyCount: number): DeckArrangement {
  if (keyLayout === 'newest-first') return 'reversed'
  if (keyLayout === 'status-sorted') return 'standard'
  return keyCount <= AUTO_REVERSED_MAX_KEYS ? 'reversed' : 'standard'
}

/** Reversed = strictly reverse tab-bar order (newest first while tabs are
 * unreordered; after a manual reorder or cross-device order sync it mirrors
 * the reversed tab bar) with NO status sorting, so key positions are
 * deterministic and muscle-memory-stable (status still shows via
 * fills/icons/rings). Standard keeps the model's order: status-sorted for
 * status-icons, raw tab-bar order for previews. */
export function arrangeTabs(tabs: DeckTab[], arrangement: DeckArrangement): DeckTab[] {
  if (arrangement !== 'reversed') return tabs
  return [...tabs].sort((a, b) => b.tabIndex - a.tabIndex)
}

export function planLayout(caps: DeckCapabilities, tabCount: number, arrangement: DeckArrangement = 'standard'): LayoutPlan {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)
  if (arrangement === 'reversed') {
    const full = caps.dialCount >= 2 && caps.hasTouchStrip
    return {
      mode: full ? 'full' : 'keys',
      keyCount: caps.keyCount,
      // Pager ALWAYS reserved at top-left (key 0) — even when all tabs fit —
      // so tab positions never shift as the tab count crosses capacity.
      tabSlots: range(caps.keyCount - 1).map((i) => i + 1),
      pagerKey: 0,
      tabsPerPage: caps.keyCount - 1,
      useDials: full,
      useStrip: caps.hasTouchStrip,
    }
  }
  if (caps.dialCount >= 2 && caps.hasTouchStrip) {
    return {
      mode: 'full', keyCount: caps.keyCount, tabSlots: range(caps.keyCount),
      pagerKey: null, tabsPerPage: caps.keyCount, useDials: true, useStrip: true,
    }
  }
  if (tabCount > caps.keyCount) {
    return {
      mode: 'keys', keyCount: caps.keyCount, tabSlots: range(caps.keyCount - 1),
      pagerKey: caps.keyCount - 1, tabsPerPage: caps.keyCount - 1,
      useDials: false, useStrip: caps.hasTouchStrip,
    }
  }
  return {
    mode: 'keys', keyCount: caps.keyCount, tabSlots: range(caps.keyCount),
    pagerKey: null, tabsPerPage: caps.keyCount, useDials: false, useStrip: caps.hasTouchStrip,
  }
}

export function pageCount(tabCount: number, tabsPerPage: number): number {
  return Math.max(1, Math.ceil(tabCount / Math.max(1, tabsPerPage)))
}
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pages))
}
export function visibleTabs<T>(tabs: T[], page: number, tabsPerPage: number): T[] {
  const start = (page - 1) * tabsPerPage
  return tabs.slice(start, start + tabsPerPage)
}

export function ringColor(status: { busy: boolean; green: boolean; amber: boolean }): RingColor {
  if (status.amber) return 'amber'
  if (status.green) return 'green'
  if (status.busy) return 'blue'
  return null
}

function toAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?')
}

export function stripText(
  model: { tabs: Array<{ title: string; active: boolean; busy: boolean; attention: boolean; pendingApproval: boolean }> },
  page: number, pages: number,
): string {
  const active = model.tabs.find((t) => t.active)
  const busyCount = model.tabs.filter((t) => t.busy).length
  // "waiting" = needs attention (turn complete) OR waiting for approval — each tab once.
  const waitingCount = model.tabs.filter((t) => t.attention || t.pendingApproval).length
  return toAscii(`${active?.title ?? '-'}  |  page ${page}/${pages}  |  ${busyCount} busy  ${waitingCount} waiting`)
}

export type FrameInputs = {
  model: DeckModel
  caps: DeckCapabilities
  page: number
  actionLayer: { tabId: string; approveEnabled: boolean; stopEnabled: boolean } | null
  iconReady: (url: string) => boolean
  /** Live terminal tail for a tab; only invoked for terminal-previews style. */
  previewFor: (tabId: string) => string[]
}

export function buildFrame({ model, caps, page, actionLayer, iconReady, previewFor }: FrameInputs): FrameSpec {
  const arrangement = resolveArrangement(model.keyLayout, caps.keyCount)
  const plan = planLayout(caps, model.tabs.length, arrangement)
  const pages = pageCount(model.tabs.length, plan.tabsPerPage)
  const keys: KeySpec[] = Array.from({ length: plan.keyCount }, () => ({ kind: 'empty' as const }))
  const strip: StripSpec = plan.useStrip ? { text: stripText(model, clampPage(page, pages), pages) } : null

  if (actionLayer) {
    keys[ACTION_KEYS.back] = { kind: 'action', action: 'back', enabled: true }
    if (plan.keyCount > ACTION_KEYS.approve)
      keys[ACTION_KEYS.approve] = { kind: 'action', action: 'approve', enabled: actionLayer.approveEnabled }
    if (plan.keyCount > ACTION_KEYS.stop)
      keys[ACTION_KEYS.stop] = { kind: 'action', action: 'stop', enabled: actionLayer.stopEnabled }
    return { keys, strip }
  }

  const current = clampPage(page, pages)
  const visible = visibleTabs(arrangeTabs(model.tabs, arrangement), current, plan.tabsPerPage)
  plan.tabSlots.forEach((keyIndex, slot) => {
    const tab = visible[slot]
    if (!tab) return
    keys[keyIndex] =
      model.tileStyle === 'terminal-previews'
        ? {
            kind: 'tab', style: 'preview', tabId: tab.id, title: tab.title, active: tab.active,
            previewLines: previewFor(tab.id),
            ring: ringColor({ busy: tab.busy, green: tab.attention, amber: tab.pendingApproval }),
          }
        : {
            kind: 'tab', style: 'icons', tabId: tab.id, title: tab.title, active: tab.active,
            fill: tab.fill,
            // Readiness must live IN the spec: the controller's repaint() skips
            // keys whose JSON is unchanged, so the decode completing has to flip
            // a spec field to trigger the repaint — same mechanism as the repo
            // icons below. iconReady (bitmapFor in production) also STARTS the
            // async load on first miss, so the first frame kicks off the fetch.
            // The URL is recomputed, never stored: providerIconDataUrl is
            // memoized, and the spec stays small (no multi-KB data URLs).
            paneIcons: tab.paneIcons.map((icon) => ({
              ...icon,
              ready: iconReady(providerIconDataUrl(icon.provider, PANE_TINT_COLORS[icon.tint])),
            })),
            icons: tab.repoIcons.map((icon) => ({
              ...icon,
              ready: icon.url !== null && iconReady(icon.url),
            })),
          }
  })
  if (plan.pagerKey !== null) keys[plan.pagerKey] = { kind: 'pager', page: current, pageCount: pages }
  return { keys, strip }
}
