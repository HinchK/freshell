import type { DeckCapabilities } from './deck-device'
import type { DeckAction, KeySpec, RingColor } from './frame'

// Canvas draw layer: converts a KeySpec into an RGBA pixel buffer via an
// injectable 2D-context factory (jsdom returns null from getContext, so tests
// always inject a fake context; defaultCtxFactory is runtime-only).

export type Ctx2D = Pick<CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'getImageData'> & {
  fillStyle: string | CanvasGradient | CanvasPattern
  font: string
  textBaseline: CanvasTextBaseline
}
export type CtxFactory = (width: number, height: number) => Ctx2D
export type KeyRenderer = (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray
export type StripRenderer = (text: string, width: number, height: number) => Uint8ClampedArray

export const PREVIEW_BG = '#0a0a0a'
export const PREVIEW_TEXT_COLOR = '#a8a8a8'
export const PREVIEW_FONT_SIZE = 11
export const PREVIEW_LINE_HEIGHT = 13
export const PREVIEW_CHAR_WIDTH = 5.5
export const PREVIEW_LEFT_MARGIN = 3
export const BANNER_HEIGHT = 20
export const BANNER_FILL = 'rgba(0,0,0,0.667)'
export const TITLE_FONT_SIZE = 16
export const RING_COLORS: Record<Exclude<RingColor, null>, string> = {
  amber: '#f59e0b',
  green: '#22c55e',
  blue: '#3b82f6',
}
export const ACTIVE_COLOR = '#ffffff'
export const STOP_COLOR = '#ef4444'
export const APPROVE_COLOR = '#22c55e'
export const DISABLED_ACTION_COLOR = '#555555'
export const CONTROL_BG = '#101036'
export const CONTROL_DIM = '#8888aa'
export const EMPTY_BG = '#000000'
export const STRIP_FONT_SIZE = 22
export const MAX_TITLE_CHARS = 10

export function previewGeometry(width: number, height: number): { lines: number; columns: number } {
  return {
    lines: Math.max(1, Math.floor((height - BANNER_HEIGHT - 2) / PREVIEW_LINE_HEIGHT) + 1),
    columns: Math.max(1, Math.floor((width - PREVIEW_LEFT_MARGIN) / PREVIEW_CHAR_WIDTH)),
  }
}

export function cropPreviewLines(lines: string[], maxLines: number, maxColumns: number): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.slice(-maxLines).map((l) => l.slice(0, maxColumns))
}

export function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

export function fitLabel(measure: (t: string) => number, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text
  let t = text
  while (t.length > 0 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1)
  return `${t}…`
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

function drawTab(
  ctx: Ctx2D, w: number, h: number,
  spec: Extract<KeySpec, { kind: 'tab' }>,
): void {
  ctx.fillStyle = PREVIEW_BG
  ctx.fillRect(0, 0, w, h)

  const { lines, columns } = previewGeometry(w, h)
  const body = cropPreviewLines(spec.previewLines, lines, columns)
  ctx.font = `${PREVIEW_FONT_SIZE}px monospace`
  ctx.textBaseline = 'top'
  ctx.fillStyle = PREVIEW_TEXT_COLOR
  const baseY = h - body.length * PREVIEW_LINE_HEIGHT - 2
  body.forEach((line, i) => {
    if (line.trim() === '') return
    ctx.fillText(line, PREVIEW_LEFT_MARGIN, baseY + i * PREVIEW_LINE_HEIGHT)
  })

  ctx.fillStyle = BANNER_FILL
  ctx.fillRect(0, 0, w, BANNER_HEIGHT)

  ctx.font = `${TITLE_FONT_SIZE}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 4)
  drawCenteredText(ctx, label, w, 2)

  const ringColor = spec.ring ? RING_COLORS[spec.ring] : null
  if (ringColor && spec.active) {
    drawRing(ctx, w, h, ringColor, 3, 0)
    drawRing(ctx, w, h, ACTIVE_COLOR, 2, 3)
  } else if (ringColor) {
    drawRing(ctx, w, h, ringColor, 4, 0)
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

export function renderKey(spec: KeySpec, caps: DeckCapabilities, createCtx: CtxFactory): Uint8ClampedArray {
  const w = caps.keyPixelWidth
  const h = caps.keyPixelHeight
  const ctx = createCtx(w, h)
  switch (spec.kind) {
    case 'empty':
      ctx.fillStyle = EMPTY_BG
      ctx.fillRect(0, 0, w, h)
      break
    case 'tab':
      drawTab(ctx, w, h, spec)
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
