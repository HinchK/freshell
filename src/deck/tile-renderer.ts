import type { DeckCapabilities } from './deck-device'
import type { DeckAction, KeySpec } from './frame'

// Canvas draw layer: converts a KeySpec into an RGBA pixel buffer via an
// injectable 2D-context factory (jsdom returns null from getContext, so tests
// always inject a fake context; defaultCtxFactory is runtime-only).

export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'getImageData' | 'drawImage'
> & { fillStyle: string | CanvasGradient | CanvasPattern; font: string; textBaseline: CanvasTextBaseline }

export type IconSource = (url: string) => CanvasImageSource | null
export type CtxFactory = (width: number, height: number) => Ctx2D
export type KeyRenderer = (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray
export type StripRenderer = (text: string, width: number, height: number) => Uint8ClampedArray

export const BANNER_HEIGHT = 20
export const BANNER_FILL = 'rgba(0,0,0,0.667)'
export const TITLE_FONT_SIZE = 16
export const ACTIVE_COLOR = '#ffffff'
export const TILE_BG = '#0a0a0a'
/** Light green fill - the tab bar's emerald attention fill, tuned for the LCD (emerald-200). */
export const TILE_FILL_GREEN = '#a7f3d0'
/** The tab bar's bar-on-top green (--success, hsl(142 71% 45%)). */
export const BAR_TOP_BORDER = '#21c45d'
/** Status dot: the tab bar's icon tint colors (text-success / text-blue-500). */
export const DOT_GREEN = '#21c45d'
export const DOT_BLUE = '#3b82f6'
export const DOT_SIZE = 8
export const ICON_GAP = 3
export const STOP_COLOR = '#ef4444'
export const APPROVE_COLOR = '#22c55e'
export const DISABLED_ACTION_COLOR = '#555555'
export const CONTROL_BG = '#101036'
export const CONTROL_DIM = '#8888aa'
export const EMPTY_BG = '#000000'
export const STRIP_FONT_SIZE = 22
export const MAX_TITLE_CHARS = 10

export function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

export function fitLabel(measure: (t: string) => number, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text
  let t = text
  while (t.length > 0 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1)
  return `${t}…`
}

/** Centered icon slots in the area below the title banner. */
export function iconLayout(w: number, h: number, count: number): Array<{ x: number; y: number; size: number }> {
  if (count <= 0) return []
  const areaTop = BANNER_HEIGHT
  const areaH = h - areaTop
  const scale = count === 1 ? 0.5 : 0.3
  const size = Math.round(Math.min(w, areaH) * scale)
  const rowW = count * size + (count - 1) * ICON_GAP
  const x0 = Math.round((w - rowW) / 2)
  const y = Math.round(areaTop + (areaH - size) / 2)
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (size + ICON_GAP), y, size }))
}

export function drawRing(ctx: Ctx2D, w: number, h: number, color: string, width: number, inset = 0): void {
  ctx.fillStyle = color
  for (let i = 0; i < width; i++) {
    const o = inset + i
    ctx.fillRect(o, o, w - 2 * o, 1) // top
    ctx.fillRect(o, h - 1 - o, w - 2 * o, 1) // bottom
    ctx.fillRect(o, o, 1, h - 2 * o) // left
    ctx.fillRect(w - 1 - o, o, 1, h - 2 * o) // right
  }
}

function drawCenteredText(ctx: Ctx2D, text: string, w: number, y: number): void {
  const x = (w - ctx.measureText(text).width) / 2
  ctx.fillText(text, x, y)
}

const ACTION_LABELS: Record<DeckAction, string> = { back: 'BACK', approve: 'APPROVE', stop: 'STOP' }
const ACTION_RING: Record<DeckAction, string> = { back: ACTIVE_COLOR, approve: APPROVE_COLOR, stop: STOP_COLOR }

function drawTab(ctx: Ctx2D, w: number, h: number, spec: Extract<KeySpec, { kind: 'tab' }>, getIcon: IconSource): void {
  // 1. Background mirrors the tab bar state: no fill / green fill / barTop (fill + border below).
  ctx.fillStyle = spec.fill === 'none' ? TILE_BG : TILE_FILL_GREEN
  ctx.fillRect(0, 0, w, h)

  // 2. Centered repo icons; letter avatar while loading, on failure, or when the repo has no icon.
  const slots = iconLayout(w, h, spec.icons.length)
  spec.icons.forEach((icon, i) => {
    const { x, y, size } = slots[i]
    const bitmap = icon.url && icon.ready ? getIcon(icon.url) : null
    if (bitmap) {
      // ALWAYS pass explicit destination width AND height: dimensionless (viewBox-only)
      // SVGs draw blank without them (verified headless Chromium 145; the server serves
      // dimensionless SVGs first-class - repo_icon_detect.rs:51-52). Never call the
      // 3-arg drawImage(image, dx, dy) form anywhere in this module.
      ctx.drawImage(bitmap, x, y, size, size)
      return
    }
    // Letter avatar (canvas analogue of RepoIcon's SVG circle): hue swatch + white letter.
    ctx.fillStyle = `hsl(${icon.hue}, 60%, 42%)`
    ctx.fillRect(x, y, size, size)
    ctx.font = `600 ${Math.round(size * 0.6)}px sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#ffffff'
    const letterWidth = ctx.measureText(icon.letter).width
    ctx.fillText(icon.letter, Math.round(x + (size - letterWidth) / 2), Math.round(y + size * 0.2))
  })

  // 3. Status dot: the tab bar's green/blue icon-tint states, visible on the deck.
  if (spec.dot) {
    ctx.fillStyle = spec.dot === 'green' ? DOT_GREEN : DOT_BLUE
    ctx.fillRect(Math.round((w - DOT_SIZE) / 2), h - DOT_SIZE - 5, DOT_SIZE, DOT_SIZE)
  }

  // 4. Title banner across the top (unchanged treatment).
  ctx.fillStyle = BANNER_FILL
  ctx.fillRect(0, 0, w, BANNER_HEIGHT)
  ctx.font = `${TITLE_FONT_SIZE}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 4)
  drawCenteredText(ctx, label, w, 2)

  // 5. Borders/rings: barTop green border; white ring marks the active tab.
  if (spec.fill === 'barTop') {
    drawRing(ctx, w, h, BAR_TOP_BORDER, 3, 0)
    if (spec.active) drawRing(ctx, w, h, ACTIVE_COLOR, 2, 3)
  } else if (spec.active) {
    drawRing(ctx, w, h, ACTIVE_COLOR, 3, 0)
  }
}

function drawPager(
  ctx: Ctx2D, w: number, h: number,
  spec: Extract<KeySpec, { kind: 'pager' }>,
): void {
  ctx.fillStyle = CONTROL_BG
  ctx.fillRect(0, 0, w, h)
  ctx.textBaseline = 'top'

  ctx.font = '11px sans-serif'
  ctx.fillStyle = CONTROL_DIM
  drawCenteredText(ctx, 'PAGE', w, 2)

  ctx.font = '15px sans-serif'
  ctx.fillStyle = ACTIVE_COLOR
  drawCenteredText(ctx, `${spec.page}/${spec.pageCount}`, w, (h - 15) / 2)

  ctx.font = '11px sans-serif'
  ctx.fillStyle = CONTROL_DIM
  drawCenteredText(ctx, 'NEXT >', w, h - 11 - 4)
}

function drawAction(
  ctx: Ctx2D, w: number, h: number,
  spec: Extract<KeySpec, { kind: 'action' }>,
): void {
  ctx.fillStyle = CONTROL_BG
  ctx.fillRect(0, 0, w, h)

  ctx.font = '15px sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  drawCenteredText(ctx, ACTION_LABELS[spec.action], w, (h - 15) / 2)

  drawRing(ctx, w, h, spec.enabled ? ACTION_RING[spec.action] : DISABLED_ACTION_COLOR, 3, 0)
}

export function renderKey(
  spec: KeySpec,
  caps: DeckCapabilities,
  createCtx: CtxFactory,
  getIcon: IconSource = () => null,
): Uint8ClampedArray {
  const w = caps.keyPixelWidth
  const h = caps.keyPixelHeight
  const ctx = createCtx(w, h)
  switch (spec.kind) {
    case 'empty':
      ctx.fillStyle = EMPTY_BG
      ctx.fillRect(0, 0, w, h)
      break
    case 'tab':
      drawTab(ctx, w, h, spec, getIcon)
      break
    case 'pager':
      drawPager(ctx, w, h, spec)
      break
    case 'action':
      drawAction(ctx, w, h, spec)
      break
  }
  return ctx.getImageData(0, 0, w, h).data
}

export function renderStrip(text: string, width: number, height: number, createCtx: CtxFactory): Uint8ClampedArray {
  const ctx = createCtx(width, height)
  ctx.fillStyle = EMPTY_BG
  ctx.fillRect(0, 0, width, height)
  ctx.font = `${STRIP_FONT_SIZE}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  drawCenteredText(ctx, text, width, (height - STRIP_FONT_SIZE) / 2)
  return ctx.getImageData(0, 0, width, height).data
}

export function defaultCtxFactory(width: number, height: number): Ctx2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable (defaultCtxFactory is runtime-only; inject a CtxFactory in tests)')
  return ctx
}
