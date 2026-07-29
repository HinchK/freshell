import { describe, expect, it } from 'vitest'
import { MINI_CAPS } from '@/deck/fake-deck-device'
import {
  drawRing, fitLabel, iconLayout, renderKey, truncateTitle,
  APPROVE_COLOR, ACTIVE_COLOR, DISABLED_ACTION_COLOR,
  TILE_BG, TILE_FILL_GREEN, BAR_TOP_BORDER, DOT_GREEN, DOT_BLUE, DOT_SIZE,
} from '@/deck/tile-renderer'
import type { Ctx2D, IconSource } from '@/deck/tile-renderer'
import type { KeySpec } from '@/deck/frame'

type Rect = { x: number; y: number; w: number; h: number; style: string }
type Text = { text: string; x: number; y: number; style: string; font: string }
type Img = { x: number; y: number; w: number; h: number }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
  const images: Img[] = []
  const ctx = {
    fillStyle: '#000000' as string,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) })
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, style: String(this.fillStyle), font: this.font })
    },
    drawImage(_src: CanvasImageSource, x: number, y: number, w: number, h: number) {
      images.push({ x, y, w, h })
    },
    measureText(t: string) { return { width: t.length * 6 } as TextMetrics },
    getImageData() { return { data: new Uint8ClampedArray(width * height * 4) } as ImageData },
  } as unknown as Ctx2D
  return { ctx, rects, texts, images }
}

describe('title fitting', () => {
  it('truncateTitle caps at 10 chars with ellipsis', () => {
    expect(truncateTitle('short')).toBe('short')
    expect(truncateTitle('exactly-10')).toBe('exactly-10')
    expect(truncateTitle('longer-than-ten')).toBe('longer-th…')
  })
  it('fitLabel pixel-fits with ellipsis', () => {
    const measure = (t: string) => t.length * 6
    expect(fitLabel(measure, 'abcdef', 100)).toBe('abcdef')
    expect(fitLabel(measure, 'abcdefghij', 30)).toBe('abcd…')
  })
})

describe('drawRing', () => {
  it('paints width nested 1px frames at the given inset', () => {
    const { ctx, rects } = recordingCtx(80, 80)
    drawRing(ctx, 80, 80, '#3b82f6', 2, 1)
    // each 1px frame = 4 rects (top, bottom, left, right) => 8 rects
    expect(rects).toHaveLength(8)
    expect(rects.every((r) => r.style === '#3b82f6')).toBe(true)
    // first frame at offset 1: top strip spans full width at y=1
    expect(rects[0]).toMatchObject({ x: 1, y: 1, w: 78, h: 1 })
  })
})

const tabSpec = (over: Partial<Extract<KeySpec, { kind: 'tab' }>> = {}): KeySpec => ({
  kind: 'tab', tabId: 't1', title: 'build',
  active: false, fill: 'none', dot: null, icons: [], ...over,
})

function renderTab(spec: KeySpec, getIcon?: IconSource) {
  let captured: ReturnType<typeof recordingCtx> | null = null
  const factory = (w: number, h: number) => {
    captured = recordingCtx(w, h)
    return captured.ctx
  }
  const out = renderKey(spec, MINI_CAPS, factory, getIcon)
  const { rects, texts, images } = captured!
  return { out, rects, texts, images }
}

describe('renderKey', () => {
  it('no-fill tile: near-black bg, banner, white title, no rings, no dot, no preview text', () => {
    const { out, rects, texts } = renderTab(tabSpec())
    expect(out).toBeInstanceOf(Uint8ClampedArray)
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: TILE_BG })
    expect(rects.some((r) => r.y === 0 && r.h === 20 && r.style.startsWith('rgba'))).toBe(true) // banner
    expect(texts.some((t) => t.text === 'build' && t.style === '#ffffff')).toBe(true)           // title
    expect(rects.filter((r) => r.style === ACTIVE_COLOR)).toHaveLength(0)
    expect(texts.filter((t) => t.style === '#a8a8a8')).toHaveLength(0) // no preview text anywhere on the tile
  })

  it('green fill state paints the light-green background', () => {
    const { rects } = renderTab(tabSpec({ fill: 'green' }))
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: TILE_FILL_GREEN })
  })

  it('barTop state paints light-green background + 3px green border ring', () => {
    const { rects } = renderTab(tabSpec({ fill: 'barTop', active: true }))
    expect(rects[0].style).toBe(TILE_FILL_GREEN)
    expect(rects.filter((r) => r.style === BAR_TOP_BORDER).length).toBeGreaterThan(0)
    // active tab keeps its white ring nested inside the border
    expect(rects.filter((r) => r.style === ACTIVE_COLOR && r.h <= 1).length).toBeGreaterThan(0)
  })

  it('active tab without fill gets the plain white ring', () => {
    const { rects } = renderTab(tabSpec({ active: true }))
    expect(rects.filter((r) => r.style === ACTIVE_COLOR).length).toBeGreaterThan(0)
  })

  it('ready icon draws via drawImage at the centered layout slot', () => {
    const bitmap = {} as CanvasImageSource
    const { images } = renderTab(
      tabSpec({ icons: [{ url: '/i/a', letter: 'A', hue: 120, ready: true }] }),
      (url) => (url === '/i/a' ? bitmap : null),
    )
    const [slot] = iconLayout(80, 80, 1)
    expect(images).toEqual([{ x: slot.x, y: slot.y, w: slot.size, h: slot.size }])
  })

  it('unready or letter-only icon draws the hue swatch + white letter fallback', () => {
    const { rects, texts, images } = renderTab(
      tabSpec({ icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
    )
    expect(images).toHaveLength(0)
    expect(rects.some((r) => r.style === 'hsl(200, 60%, 42%)')).toBe(true)
    expect(texts.some((t) => t.text === 'B' && t.style === '#ffffff')).toBe(true)
  })

  it('status dot: green and blue variants at bottom-center; absent when null', () => {
    const green = renderTab(tabSpec({ dot: 'green' }))
    expect(green.rects.some((r) => r.style === DOT_GREEN && r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(true)
    const blue = renderTab(tabSpec({ dot: 'blue' }))
    expect(blue.rects.some((r) => r.style === DOT_BLUE && r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(true)
    const none = renderTab(tabSpec())
    expect(none.rects.some((r) => r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(false)
  })

  it('iconLayout: 1 icon centered large; 3 icons in a centered row below the banner', () => {
    const one = iconLayout(80, 80, 1)
    expect(one).toHaveLength(1)
    expect(one[0].size).toBe(30) // round(min(80, 60) * 0.5)
    expect(one[0].x).toBe(Math.round((80 - 30) / 2))
    expect(one[0].y).toBe(Math.round(20 + (60 - 30) / 2))
    const three = iconLayout(80, 80, 3)
    expect(three).toHaveLength(3)
    expect(three.every((s) => s.size === 18)).toBe(true) // round(60 * 0.3)
    expect(three[1].x - three[0].x).toBe(18 + 3)         // size + gap
  })

  it('pager key renders PAGE / n/m / NEXT > on the control background', () => {
    let cap: ReturnType<typeof recordingCtx> | null = null
    renderKey({ kind: 'pager', page: 2, pageCount: 3 }, MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
    const { rects, texts } = cap!
    expect(rects[0].style).toBe('#101036')
    expect(texts.map((t) => t.text)).toEqual(expect.arrayContaining(['PAGE', '2/3', 'NEXT >']))
  })

  it('disabled action key gets the grey ring; enabled approve gets green', () => {
    const rectsFor = (enabled: boolean) => {
      let cap: ReturnType<typeof recordingCtx> | null = null
      renderKey({ kind: 'action', action: 'approve', enabled }, MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
      return cap!.rects
    }
    expect(rectsFor(false).some((r) => r.style === DISABLED_ACTION_COLOR)).toBe(true)
    expect(rectsFor(true).some((r) => r.style === APPROVE_COLOR)).toBe(true)
  })
})
