import type { DeckCapabilities } from './deck-device'
import type { DeckModel } from './deck-selectors'
import type { TileFill, TileDot } from './tile-state'

export type RingColor = 'amber' | 'green' | 'blue' | null
export type DeckAction = 'back' | 'approve' | 'stop'
export type TileIcon = { url: string | null; letter: string; hue: number; ready: boolean }
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; tabId: string; title: string; previewLines: string[]; ring: RingColor;
      active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }
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

export function planLayout(caps: DeckCapabilities, tabCount: number): LayoutPlan {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)
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
  model: { tabs: Array<{ title: string; active: boolean; status: { busy: boolean; amber: boolean } }> },
  page: number, pages: number,
): string {
  const active = model.tabs.find((t) => t.active)
  const busy = model.tabs.filter((t) => t.status.busy).length
  const amber = model.tabs.filter((t) => t.status.amber).length
  return toAscii(`${active?.title ?? '-'}  |  page ${page}/${pages}  |  ${busy} busy  ${amber} waiting`)
}

export type FrameInputs = {
  model: DeckModel
  caps: DeckCapabilities
  page: number
  actionLayer: { tabId: string; approveEnabled: boolean; stopEnabled: boolean } | null
  iconReady: (url: string) => boolean
}

export function buildFrame({ model, caps, page, actionLayer, iconReady }: FrameInputs): FrameSpec {
  const plan = planLayout(caps, model.tabs.length)
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
  const visible = visibleTabs(model.tabs, current, plan.tabsPerPage)
  plan.tabSlots.forEach((keyIndex, slot) => {
    const tab = visible[slot]
    if (!tab) return
    keys[keyIndex] = {
      kind: 'tab', tabId: tab.id, title: tab.title,
      previewLines: [], // field dies in Task 9
      ring: ringColor(tab.status), active: tab.active,
      fill: tab.fill, dot: tab.dot,
      icons: tab.repoIcons.map((icon) => ({
        ...icon,
        ready: icon.url !== null && iconReady(icon.url),
      })),
    }
  })
  if (plan.pagerKey !== null) keys[plan.pagerKey] = { kind: 'pager', page: current, pageCount: pages }
  return { keys, strip }
}
