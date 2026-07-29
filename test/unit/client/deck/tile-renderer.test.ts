import { describe, expect, it } from 'vitest'
import { MINI_CAPS } from '@/deck/fake-deck-device'
import {
  cropPreviewLines, drawRing, fitLabel, previewGeometry, renderKey, truncateTitle,
  RING_COLORS, ACTIVE_COLOR, DISABLED_ACTION_COLOR,
} from '@/deck/tile-renderer'
import type { Ctx2D } from '@/deck/tile-renderer'

type Rect = { x: number; y: number; w: number; h: number; style: string }
type Text = { text: string; x: number; y: number; style: string; font: string }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
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
    measureText(t: string) { return { width: t.length * 6 } as TextMetrics },
    getImageData() { return { data: new Uint8ClampedArray(width * height * 4) } as ImageData },
  } as unknown as Ctx2D
  return { ctx, rects, texts }
}

describe('previewGeometry', () => {
  it('matches the hardware-anchored values', () => {
    expect(previewGeometry(120, 120)).toEqual({ lines: 8, columns: 21 })
    expect(previewGeometry(80, 80)).toEqual({ lines: 5, columns: 14 })
    expect(previewGeometry(72, 72)).toEqual({ lines: 4, columns: 12 })
  })
})

describe('cropPreviewLines', () => {
  it('drops trailing blanks, keeps last N lines and first M columns', () => {
    const lines = ['one', 'two-is-longer-than-five', 'three', '', '   ']
    expect(cropPreviewLines(lines, 2, 5)).toEqual(['two-i', 'three'])
  })
})

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

describe('renderKey', () => {
  it('tab tile: bg, preview text, banner, title, rings (status+active widths)', () => {
    let captured: ReturnType<typeof recordingCtx> | null = null
    const factory = (w: number, h: number) => {
      captured = recordingCtx(w, h)
      return captured.ctx
    }
    const out = renderKey(
      { kind: 'tab', tabId: 't1', title: 'build', previewLines: ['$ npm test', 'PASS'], ring: 'blue', active: true },
      MINI_CAPS, factory,
    )
    expect(out).toBeInstanceOf(Uint8ClampedArray)
    const { rects, texts } = captured!
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: '#0a0a0a' })       // bg
    expect(texts.some((t) => t.text === '$ npm test' && t.style === '#a8a8a8')).toBe(true) // preview
    expect(rects.some((r) => r.y === 0 && r.h === 20 && r.style.startsWith('rgba'))).toBe(true) // banner
    expect(texts.some((t) => t.text === 'build' && t.style === '#ffffff')).toBe(true)     // title
    const blue = rects.filter((r) => r.style === RING_COLORS.blue)
    const white = rects.filter((r) => r.style === ACTIVE_COLOR && r.h <= 1)
    expect(blue).toHaveLength(3 * 4)   // 3px status ring: 3 frames x 4 rects each
    // The h <= 1 filter matches ONLY the top+bottom strips of each 1px frame (2 per
    // frame); drawRing paints verticals as single TALL rects (h = h - 2*o), which the
    // filter deliberately excludes to avoid counting anything else white on the tile.
    expect(white).toHaveLength(2 * 2)  // 2px active ring at inset 3: 2 frames x 2 horizontal strips
  })

  it('status-only tile paints a 4px ring; active-only a 3px white ring', () => {
    const make = (ring: 'green' | null, active: boolean) => {
      let cap: ReturnType<typeof recordingCtx> | null = null
      renderKey({ kind: 'tab', tabId: 't', title: 't', previewLines: [], ring, active },
        MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
      return cap!.rects
    }
    expect(make('green', false).filter((r) => r.style === RING_COLORS.green)).toHaveLength(4 * 4)
    // Same h <= 1 caveat as above: 3 frames x 2 horizontal strips each (verticals are tall rects).
    expect(make(null, true).filter((r) => r.style === ACTIVE_COLOR && r.h <= 1)).toHaveLength(3 * 2)
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
    expect(rectsFor(true).some((r) => r.style === RING_COLORS.green)).toBe(true)
  })
})
