import { describe, expect, it } from 'vitest'
import { MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'
import {
  ACTION_KEYS, buildFrame, clampPage, pageCount, planLayout, ringColor, stripText, visibleTabs,
} from '@/deck/frame'
import type { DeckModel } from '@/deck/deck-selectors'

const quiet = { busy: false, green: false, amber: false }
function model(n: number, activeId = 'tab-0'): DeckModel {
  return {
    activeTabId: activeId,
    tabs: Array.from({ length: n }, (_, i) => ({
      id: `tab-${i}`, title: `Tab ${i}`, active: `tab-${i}` === activeId, status: { ...quiet },
    })),
  }
}
const noPreview = () => []

describe('planLayout', () => {
  it('mini, 3 tabs: keys mode, no pager, 6 tab slots', () => {
    expect(planLayout(MINI_CAPS, 3)).toEqual({
      mode: 'keys', keyCount: 6, tabSlots: [0, 1, 2, 3, 4, 5], pagerKey: null,
      tabsPerPage: 6, useDials: false, useStrip: false,
    })
  })
  it('mini, 8 tabs: pager at key 5, 5 tabs per page', () => {
    const plan = planLayout(MINI_CAPS, 8)
    expect(plan.pagerKey).toBe(5)
    expect(plan.tabSlots).toEqual([0, 1, 2, 3, 4])
    expect(plan.tabsPerPage).toBe(5)
  })
  it('plus: full mode regardless of overflow', () => {
    const plan = planLayout(PLUS_CAPS, 20)
    expect(plan).toMatchObject({ mode: 'full', pagerKey: null, tabsPerPage: 8, useDials: true, useStrip: true })
  })
})

describe('page math', () => {
  it('pageCount and clampPage', () => {
    expect(pageCount(8, 5)).toBe(2)
    expect(pageCount(0, 5)).toBe(1)
    expect(clampPage(3, 2)).toBe(2)
    expect(clampPage(0, 2)).toBe(1)
  })
  it('visibleTabs slices by page', () => {
    expect(visibleTabs([1, 2, 3, 4, 5, 6, 7, 8], 2, 5)).toEqual([6, 7, 8])
  })
})

describe('ringColor priority', () => {
  it('amber > green > blue > none', () => {
    expect(ringColor({ busy: true, green: true, amber: true })).toBe('amber')
    expect(ringColor({ busy: true, green: true, amber: false })).toBe('green')
    expect(ringColor({ busy: true, green: false, amber: false })).toBe('blue')
    expect(ringColor(quiet)).toBeNull()
  })
})

describe('buildFrame', () => {
  it('tabs fit: all tab tiles, active flag set, rest empty', () => {
    const frame = buildFrame({ model: model(3), caps: MINI_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(frame.keys).toHaveLength(6)
    expect(frame.keys[0]).toMatchObject({ kind: 'tab', tabId: 'tab-0', title: 'Tab 0', active: true })
    expect(frame.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-2', active: false })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
    expect(frame.strip).toBeNull()
  })
  it('overflow: pager key at 5 with page/pageCount; page 2 shows the tail', () => {
    const f1 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(f1.keys[5]).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect((f1.keys[0] as { tabId: string }).tabId).toBe('tab-0')
    const f2 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 2, actionLayer: null, previewFor: noPreview })
    expect((f2.keys[0] as { tabId: string }).tabId).toBe('tab-5')
    expect(f2.keys[3]).toEqual({ kind: 'empty' })
    expect(f2.keys[5]).toEqual({ kind: 'pager', page: 2, pageCount: 2 })
  })
  it('action layer replaces the frame', () => {
    const frame = buildFrame({
      model: model(3), caps: MINI_CAPS, page: 1,
      actionLayer: { tabId: 'tab-1', approveEnabled: false, stopEnabled: true }, previewFor: noPreview,
    })
    expect(frame.keys[ACTION_KEYS.back]).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(frame.keys[ACTION_KEYS.approve]).toEqual({ kind: 'action', action: 'approve', enabled: false })
    expect(frame.keys[ACTION_KEYS.stop]).toEqual({ kind: 'action', action: 'stop', enabled: true })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
  })
  it('full mode fills the strip and never emits a pager', () => {
    const m = model(10)
    m.tabs[1].status.busy = true
    m.tabs[2].status.amber = true
    const frame = buildFrame({ model: m, caps: PLUS_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(frame.keys.every((k) => k.kind !== 'pager')).toBe(true)
    expect(frame.strip).toEqual({ text: 'Tab 0  |  page 1/2  |  1 busy  1 waiting' })
  })
})

describe('stripText', () => {
  it('uses - for no active tab and forces ASCII', () => {
    expect(stripText({ tabs: [] }, 1, 1)).toBe('-  |  page 1/1  |  0 busy  0 waiting')
    expect(stripText({ tabs: [{ title: 'café', active: true, status: { busy: false, amber: false } }] }, 1, 1))
      .toBe('caf?  |  page 1/1  |  0 busy  0 waiting')
  })
})
