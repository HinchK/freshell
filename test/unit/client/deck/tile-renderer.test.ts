import { describe, expect, it } from 'vitest'
import { MINI_CAPS } from '@/deck/fake-deck-device'
import {
  cropPreviewLines, drawRing, fitLabel, iconLayout, previewGeometry, renderKey, renderStrip, truncateTitle,
  APPROVE_COLOR, ACTIVE_COLOR, DISABLED_ACTION_COLOR, PREVIEW_TEXT_COLOR, PREVIEW_BG, RING_COLORS,
  TILE_BG, TILE_FILL_GREEN, BAR_TOP_BORDER, CONTROL_BG, CONTROL_DIM, STOP_COLOR,
  CONTROL_LABEL_FONT_SIZE, CONTROL_VALUE_FONT_SIZE, TITLE_FONT_SIZE, STRIP_FONT_SIZE,
} from '@/deck/tile-renderer'
import { STATUS_GREEN, STATUS_BLUE, STATUS_AMBER, STATUS_RED, STATUS_MUTED, STATUS_MUTED_DIM } from '@/deck/pane-tint-colors'
import type { Ctx2D, IconSource } from '@/deck/tile-renderer'
import { repoAvatarColor, REPO_AVATAR_FONT_RATIO } from '@/components/icons/RepoIcon'
import { DECK_FONT_STACK } from '@/deck/deck-font'
import type { KeySpec, RingColor } from '@/deck/frame'

type Rect = { x: number; y: number; w: number; h: number; style: string }
type Text = { text: string; x: number; y: number; style: string; font: string }
type Img = { x: number; y: number; w: number; h: number }
type Circle = { cx: number; cy: number; r: number; style: string }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
  const images: Img[] = []
  const circles: Circle[] = []
  let pendingArc: { cx: number; cy: number; r: number } | null = null
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
    beginPath() {
      pendingArc = null
    },
    arc(cx: number, cy: number, r: number) {
      pendingArc = { cx, cy, r }
    },
    fill() {
      if (pendingArc) circles.push({ ...pendingArc, style: String(this.fillStyle) })
      pendingArc = null
    },
    measureText(t: string) { return { width: t.length * 6 } as TextMetrics },
    getImageData() { return { data: new Uint8ClampedArray(width * height * 4) } as ImageData },
  } as unknown as Ctx2D
  return { ctx, rects, texts, images, circles }
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

const tabSpec = (over: Partial<Extract<KeySpec, { kind: 'tab'; style: 'icons' }>> = {}): KeySpec => ({
  kind: 'tab', style: 'icons', tabId: 't1', title: 'build',
  active: false, fill: 'none', paneIcons: [], icons: [], ...over,
})

function previewSpec(overrides: Partial<Extract<KeySpec, { kind: 'tab'; style: 'preview' }>> = {}): KeySpec {
  return {
    kind: 'tab' as const, style: 'preview' as const, tabId: 't1', title: 'Tab 1',
    active: false, previewLines: ['$ npm test', 'PASS'], ring: null as RingColor,
    ...overrides,
  }
}

function renderTab(spec: KeySpec, getIcon?: IconSource) {
  let captured: ReturnType<typeof recordingCtx> | null = null
  const factory = (w: number, h: number) => {
    captured = recordingCtx(w, h)
    return captured.ctx
  }
  const out = renderKey(spec, MINI_CAPS, factory, getIcon)
  const { rects, texts, images, circles } = captured!
  return { out, rects, texts, images, circles }
}

describe('renderKey', () => {
  it('no-fill tile: near-black bg, banner, white title, no rings, no dot, no preview text', () => {
    const { out, rects, texts } = renderTab(tabSpec())
    expect(out).toBeInstanceOf(Uint8ClampedArray)
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: TILE_BG })
    expect(rects.some((r) => r.y === 0 && r.h === 20 && r.style.startsWith('rgba'))).toBe(true) // banner
    expect(texts.some((t) => t.text === 'build' && t.style === '#ffffff')).toBe(true)           // title
    expect(rects.filter((r) => r.style === ACTIVE_COLOR)).toHaveLength(0)
    expect(texts.filter((t) => t.style === PREVIEW_TEXT_COLOR)).toHaveLength(0) // no preview text anywhere on the tile
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

  it('unready or letter-only icon draws RepoIcon\'s circle avatar + centered white letter', () => {
    const { rects, texts, images, circles } = renderTab(
      tabSpec({ icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
    )
    expect(images).toHaveLength(0)
    const slot = iconLayout(80, 80, 1)[0]
    // Exact replica of RepoIcon's SVG: full-slot circle, shared color function.
    expect(circles).toEqual([
      { cx: slot.x + slot.size / 2, cy: slot.y + slot.size / 2, r: slot.size / 2, style: repoAvatarColor(200) },
    ])
    // The old square swatch is gone.
    expect(rects.some((r) => r.style === repoAvatarColor(200))).toBe(false)
    const letter = texts.find((t) => t.text === 'B')
    expect(letter?.style).toBe('#ffffff')
    // 9/16 of the diameter, weight 600 (slot.size is 30 on the 80x80 Mini -> 17px).
    expect(letter?.font).toBe(`600 ${Math.round(slot.size * REPO_AVATAR_FONT_RATIO)}px ${DECK_FONT_STACK}`)
  })

  it('no status dot: a plain icons tile draws only the background and the banner', () => {
    const { rects } = renderTab(tabSpec())
    // background + banner — nothing else (the dot used to be a third rect)
    expect(rects).toHaveLength(2)
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
    expect(rects[0].style).toBe(CONTROL_BG)
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

describe('renderKey preview style', () => {
  it('draws preview text in the preview color under the title banner', () => {
    const { texts } = renderTab(previewSpec())
    const previewTexts = texts.filter((t) => t.style === PREVIEW_TEXT_COLOR)
    expect(previewTexts.map((t) => t.text)).toEqual(['$ npm test', 'PASS'])
  })

  it('status ring + active tab draws the status ring plus the white inner ring', () => {
    const { rects } = renderTab(previewSpec({ ring: 'green', active: true }))
    expect(rects.some((r) => r.style === RING_COLORS.green)).toBe(true)
    expect(rects.some((r) => r.style === ACTIVE_COLOR)).toBe(true) // white inner ring
  })

  it('amber ring renders for a waiting-for-approval tab', () => {
    const { rects } = renderTab(previewSpec({ ring: 'amber' }))
    expect(rects.some((r) => r.style === RING_COLORS.amber)).toBe(true)
  })

  it('icons style still renders fills (dispatch regression)', () => {
    const { rects } = renderTab(tabSpec({ fill: 'green' }))
    expect(rects.some((r) => r.style === TILE_FILL_GREEN)).toBe(true) // emerald-100 green fill
  })
})

describe('fonts (Inter)', () => {
  it('icons tile: banner title and avatar letter render in 600-weight Inter', () => {
    const { texts } = renderTab(
      tabSpec({ title: 'build', icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
    )
    const title = texts.find((t) => t.text === 'build')
    expect(title?.font).toBe(`600 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`)
    const letter = texts.find((t) => t.text === 'B')
    expect(letter?.font).toContain(`px ${DECK_FONT_STACK}`)
    expect(letter?.font.startsWith('600 ')).toBe(true)
  })

  it('pager: dim labels are 400 Inter, the page count is 600 Inter', () => {
    const { texts } = renderTab({ kind: 'pager', page: 2, pageCount: 3 })
    expect(texts.find((t) => t.text === 'PAGE')?.font).toBe(`400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}`)
    expect(texts.find((t) => t.text === 'NEXT >')?.font).toBe(`400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}`)
    expect(texts.find((t) => t.text === '2/3')?.font).toBe(`600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('action key labels render in 600 Inter', () => {
    const { texts } = renderTab({ kind: 'action', action: 'approve', enabled: true })
    expect(texts.find((t) => t.text === 'APPROVE')?.font).toBe(`600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('strip text renders in 400 Inter', () => {
    let captured: ReturnType<typeof recordingCtx> | null = null
    const factory = (w: number, h: number) => {
      captured = recordingCtx(w, h)
      return captured.ctx
    }
    renderStrip('hello', 800, 100, factory)
    expect(captured!.texts.find((t) => t.text === 'hello')?.font).toBe(`400 ${STRIP_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('classic preview tile is PINNED: monospace body, sans-serif banner', () => {
    const { texts } = renderTab(previewSpec({ title: 'build', previewLines: ['$ ls'] }))
    expect(texts.find((t) => t.text === '$ ls')?.font).toBe('11px monospace')
    expect(texts.find((t) => t.text === 'build')?.font).toBe(`${TITLE_FONT_SIZE}px sans-serif`)
  })
})

describe('palette derives from the app UI tokens (mapping block in tile-renderer.ts)', () => {
  it('matches the documented app-token values', () => {
    expect(TILE_BG).toBe('#09090b')          // --background dark: hsl(240 10% 4%)
    expect(TILE_FILL_GREEN).toBe('#d1fae5')  // bg-emerald-100 (TabItem green-filled tab)
    expect(BAR_TOP_BORDER).toBe('#21c45d')   // --success: hsl(142 71% 45%)
    expect(STATUS_GREEN).toBe('#21c45d')     // text-success (pane running tint)
    expect(STATUS_BLUE).toBe('#3b82f6')      // text-blue-500 (pane busy tint)
    expect(STATUS_AMBER).toBe('#f59f0a')     // --warning: hsl(38 92% 50%) (text-warning)
    expect(STATUS_RED).toBe('#dc2828')       // --destructive light: hsl(0 72% 51%) (text-destructive)
    expect(STATUS_MUTED).toBe('#a1a1aa')     // text-muted-foreground dark: hsl(240 5% 65%)
    expect(STATUS_MUTED_DIM).toBe('rgba(161,161,170,0.4)') // text-muted-foreground/40 dark
    expect(ACTIVE_COLOR).toBe('#ffffff')     // white active ring
    expect(CONTROL_BG).toBe('#27272a')       // bg-muted dark
    expect(CONTROL_DIM).toBe('#a1a1aa')      // text-muted-foreground dark
    expect(APPROVE_COLOR).toBe('#21c45d')    // --success
    expect(STOP_COLOR).toBe('#dc2828')       // --destructive light: hsl(0 72% 51%)
  })

  it('classic previews palette is PINNED', () => {
    expect(PREVIEW_BG).toBe('#0a0a0a')
    expect(PREVIEW_TEXT_COLOR).toBe('#a8a8a8')
    expect(RING_COLORS).toEqual({ amber: '#f59e0b', green: '#22c55e', blue: '#3b82f6' })
  })
})
