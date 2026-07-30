import { describe, expect, it, vi } from 'vitest'
import { MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'
import {
  ACTION_KEYS, arrangeTabs, buildFrame, clampPage, pageCount, planLayout, resolveArrangement, ringColor, stripText, visibleTabs,
} from '@/deck/frame'
import type { DeckModel, DeckTab } from '@/deck/deck-selectors'
import { providerIconDataUrl } from '@/deck/provider-icon-svg'
import { PANE_TINT_COLORS } from '@/deck/pane-tint-colors'

function makeDeckTab(over: Partial<DeckTab> & Pick<DeckTab, 'id' | 'title'>): DeckTab {
  return {
    active: false, busy: false, attention: false, pendingApproval: false, fill: 'none', dot: null,
    priority: 4, tabIndex: 0, repoIcons: [], paneIcons: [], ...over,
  }
}
function model(n: number, activeId = 'tab-0'): DeckModel {
  return {
    activeTabId: activeId,
    tileStyle: 'status-icons',
    // Existing tests document the STANDARD arrangement explicitly; 'auto' resolution and the reversed arrangement have dedicated tests.
    keyLayout: 'status-sorted' as const,
    tabs: Array.from({ length: n }, (_, i) =>
      makeDeckTab({ id: `tab-${i}`, title: `Tab ${i}`, active: `tab-${i}` === activeId, tabIndex: i })),
  }
}
const noIcon = () => false
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

describe('resolveArrangement', () => {
  it('auto resolves reversed on <= 6 keys and standard on larger decks', () => {
    expect(resolveArrangement('auto', 6)).toBe('reversed')
    expect(resolveArrangement('auto', 8)).toBe('standard')
  })
  it('explicit values override auto regardless of key count', () => {
    expect(resolveArrangement('newest-first', 8)).toBe('reversed')
    expect(resolveArrangement('status-sorted', 6)).toBe('standard')
  })
})

describe('arrangeTabs', () => {
  it('reversed returns strictly reverse tab-bar order, ignoring priority', () => {
    const tabs = [
      makeDeckTab({ id: 'a', title: 'a', tabIndex: 0, priority: 4 }),
      makeDeckTab({ id: 'b', title: 'b', tabIndex: 1, priority: 0 }),
      makeDeckTab({ id: 'c', title: 'c', tabIndex: 2, priority: 2 }),
    ]
    expect(arrangeTabs(tabs, 'reversed').map((t) => t.id)).toEqual(['c', 'b', 'a'])
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']) // input not mutated
  })
  it('standard returns the input order untouched', () => {
    const tabs = [makeDeckTab({ id: 'a', title: 'a', tabIndex: 0 }), makeDeckTab({ id: 'b', title: 'b', tabIndex: 1 })]
    expect(arrangeTabs(tabs, 'standard')).toBe(tabs)
  })
})

describe('planLayout reversed arrangement', () => {
  it('mini reversed: pager reserved at key 0 even when tabs fit, 5 tabs per page', () => {
    expect(planLayout(MINI_CAPS, 3, 'reversed')).toEqual({
      mode: 'keys', keyCount: 6, tabSlots: [1, 2, 3, 4, 5], pagerKey: 0, tabsPerPage: 5,
      useDials: false, useStrip: false,
    })
  })
  it('plus reversed: pager at key 0 with dials and strip still active', () => {
    expect(planLayout(PLUS_CAPS, 2, 'reversed')).toEqual({
      mode: 'full', keyCount: 8, tabSlots: [1, 2, 3, 4, 5, 6, 7], pagerKey: 0, tabsPerPage: 7,
      useDials: true, useStrip: true,
    })
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

describe('buildFrame', () => {
  it('tabs fit: all tab tiles, active flag set, rest empty', () => {
    const frame = buildFrame({ model: model(3), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(frame.keys).toHaveLength(6)
    expect(frame.keys[0]).toMatchObject({ kind: 'tab', tabId: 'tab-0', title: 'Tab 0', active: true })
    expect(frame.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-2', active: false })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
    expect(frame.strip).toBeNull()
  })
  it('overflow: pager key at 5 with page/pageCount; page 2 shows the tail', () => {
    const f1 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f1.keys[5]).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect((f1.keys[0] as { tabId: string }).tabId).toBe('tab-0')
    const f2 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 2, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect((f2.keys[0] as { tabId: string }).tabId).toBe('tab-5')
    expect(f2.keys[3]).toEqual({ kind: 'empty' })
    expect(f2.keys[5]).toEqual({ kind: 'pager', page: 2, pageCount: 2 })
  })
  it('action layer replaces the frame', () => {
    const frame = buildFrame({
      model: model(3), caps: MINI_CAPS, page: 1,
      actionLayer: { tabId: 'tab-1', approveEnabled: false, stopEnabled: true }, iconReady: noIcon, previewFor: noPreview,
    })
    expect(frame.keys[ACTION_KEYS.back]).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(frame.keys[ACTION_KEYS.approve]).toEqual({ kind: 'action', action: 'approve', enabled: false })
    expect(frame.keys[ACTION_KEYS.stop]).toEqual({ kind: 'action', action: 'stop', enabled: true })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
  })
  it('buildFrame carries fill/paneIcons/icons onto tab keys, with iconReady resolving readiness', () => {
    const model: DeckModel = {
      activeTabId: 't1',
      tileStyle: 'status-icons',
      keyLayout: 'status-sorted' as const,
      tabs: [makeDeckTab({
        id: 't1', title: 'alpha', active: true, fill: 'barTop', dot: 'green',
        paneIcons: [{ provider: 'claude', tint: 'green' }],
        repoIcons: [
          { url: '/api/repo-icon?cwd=%2Fr%2Fa', letter: 'A', hue: 120 },
          { url: null, letter: 'B', hue: 200 },
        ],
      })],
    }
    const frame = buildFrame({
      model, caps: MINI_CAPS, page: 1, actionLayer: null,
      iconReady: (url) => url === '/api/repo-icon?cwd=%2Fr%2Fa',
      previewFor: noPreview,
    })
    expect(frame.keys[0]).toMatchObject({
      kind: 'tab', tabId: 't1', fill: 'barTop',
      paneIcons: [{ provider: 'claude', tint: 'green', ready: false }],
      icons: [
        { url: '/api/repo-icon?cwd=%2Fr%2Fa', letter: 'A', hue: 120, ready: true },
        { url: null, letter: 'B', hue: 200, ready: false },
      ],
    })
  })
  it('pane icon readiness is stamped from iconReady using the tinted data URL', () => {
    const m: DeckModel = {
      activeTabId: 't1', tileStyle: 'status-icons', keyLayout: 'status-sorted' as const,
      tabs: [makeDeckTab({ id: 't1', title: 'alpha', active: true, paneIcons: [{ provider: 'claude', tint: 'green' }] })],
    }
    const url = providerIconDataUrl('claude', PANE_TINT_COLORS.green)
    const asked: string[] = []
    const build = (ready: boolean) => buildFrame({
      model: m, caps: MINI_CAPS, page: 1, actionLayer: null,
      iconReady: (u) => { asked.push(u); return ready }, previewFor: noPreview,
    })
    const before = build(false)
    // buildFrame consults iconReady with the EXACT URL the renderer will pass to
    // getIcon — in production that call (bitmapFor) also STARTS the async load.
    expect(asked).toContain(url)
    expect(before.keys[0]).toMatchObject({ paneIcons: [{ provider: 'claude', tint: 'green', ready: false }] })
    const after = build(true)
    expect(after.keys[0]).toMatchObject({ paneIcons: [{ provider: 'claude', tint: 'green', ready: true }] })
    // The decode flips the spec JSON — this is what un-skips the controller's per-key diff.
    expect(JSON.stringify(after.keys[0])).not.toBe(JSON.stringify(before.keys[0]))
  })
  it('full mode fills the strip and never emits a pager', () => {
    const m = model(10)
    m.tabs[1].busy = true
    m.tabs[2].attention = true
    const frame = buildFrame({ model: m, caps: PLUS_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(frame.keys.every((k) => k.kind !== 'pager')).toBe(true)
    expect(frame.strip).toEqual({ text: 'Tab 0  |  page 1/2  |  1 busy  1 waiting' })
  })
})

describe('buildFrame reversed', () => {
  const reversedModel = (n: number) => ({ ...model(n), keyLayout: 'newest-first' as const })

  it('newest-first on the mini: pager on key 0, last tab on key 1, older tabs on page 2', () => {
    const m = reversedModel(7) // tabs tab-0 .. tab-6 in tab-bar order
    const f1 = buildFrame({ model: m, caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f1.keys[0]).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    expect(f1.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-6' }) // newest = last in the bar
    expect(f1.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-5' })
    expect(f1.keys[5]).toMatchObject({ kind: 'tab', tabId: 'tab-2' })
    const f2 = buildFrame({ model: m, caps: MINI_CAPS, page: 2, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f2.keys[0]).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 })
    expect(f2.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-1' })
    expect(f2.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-0' })
    expect(f2.keys[3]).toEqual({ kind: 'empty' })
  })

  it('pager renders 1/1 and stays reserved when all tabs fit', () => {
    const f = buildFrame({ model: reversedModel(3), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f.keys[0]).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(f.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-2' })
  })

  it('auto on the mini resolves reversed; auto on the plus stays standard', () => {
    const auto = (n: number) => ({ ...model(n), keyLayout: 'auto' as const })
    const mini = buildFrame({ model: auto(2), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(mini.keys[0]).toMatchObject({ kind: 'pager' })
    const plus = buildFrame({ model: auto(2), caps: PLUS_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(plus.keys[0]).toMatchObject({ kind: 'tab', tabId: 'tab-0' }) // full mode, no pager
  })
})

const quiet = { busy: false, green: false, amber: false }

describe('ringColor priority', () => {
  it('amber > green > blue > none', () => {
    expect(ringColor({ busy: true, green: true, amber: true })).toBe('amber')
    expect(ringColor({ busy: true, green: true, amber: false })).toBe('green')
    expect(ringColor({ busy: true, green: false, amber: false })).toBe('blue')
    expect(ringColor(quiet)).toBeNull()
  })
})

describe('buildFrame tile styles', () => {
  it('status-icons model yields icons-style tab specs and never calls previewFor', () => {
    const previewFor = vi.fn(() => ['nope'])
    const frame = buildFrame({ model: model(2), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor })
    expect(frame.keys[0]).toMatchObject({ kind: 'tab', style: 'icons' })
    expect(previewFor).not.toHaveBeenCalled()
  })

  it('terminal-previews model yields preview-style specs with lines and ring', () => {
    const m = model(2)
    m.tileStyle = 'terminal-previews'
    m.tabs[0].busy = true
    m.tabs[1].pendingApproval = true
    const frame = buildFrame({
      model: m, caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon,
      previewFor: (tabId) => [`preview of ${tabId}`],
    })
    expect(frame.keys[0]).toMatchObject({
      kind: 'tab', style: 'preview', previewLines: ['preview of tab-0'], ring: 'blue',
    })
    expect(frame.keys[1]).toMatchObject({ kind: 'tab', style: 'preview', ring: 'amber' })
  })
})

describe('stripText', () => {
  it('uses - for no active tab and forces ASCII', () => {
    expect(stripText({ tabs: [] }, 1, 1)).toBe('-  |  page 1/1  |  0 busy  0 waiting')
    expect(stripText({ tabs: [{ title: 'café', active: true, busy: false, attention: false }] }, 1, 1))
      .toBe('caf?  |  page 1/1  |  0 busy  0 waiting')
  })
  it('stripText counts busy and waiting from tab flags', () => {
    const model = {
      activeTabId: 't1',
      tabs: [
        makeDeckTab({ id: 't1', title: 'alpha', active: true, busy: true }),
        makeDeckTab({ id: 't2', title: 'beta', attention: true }),
        makeDeckTab({ id: 't3', title: 'gamma' }),
      ],
    }
    expect(stripText(model, 1, 1)).toContain('1 busy  1 waiting')
  })

  it('stripText counts a pending-approval tab as waiting', () => {
    const m = model(3)
    m.tabs[1].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('1 waiting')
  })

  it('stripText counts waiting as the union of attention and pending approval', () => {
    const m = model(3)
    m.tabs[0].attention = true
    m.tabs[1].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('2 waiting')
  })

  it('a tab that both needs attention and awaits approval counts once', () => {
    const m = model(2)
    m.tabs[0].attention = true
    m.tabs[0].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('1 waiting')
  })
})
