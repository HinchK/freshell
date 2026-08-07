import { TAB_BAR_ROWS_MAX, TAB_BAR_ROWS_MIN } from '@shared/settings'

/**
 * All Tailwind spacing is rem-based and the app scales the root font-size via
 * `--ui-scale` (src/index.css:16-20, written by src/hooks/useTheme.ts), so the
 * rows ⇄ height model is expressed in rem — never absolute px. The strip's
 * `pt-px` top padding is a fixed physical 1px and stays OUTSIDE the rem terms.
 */

/** Height of one tab row: TabItem is h-8 (2rem). */
export const TAB_ROW_HEIGHT_REM = 2
/** Vertical gap between wrapped rows: the strip uses gap-0.5 (0.125rem). */
export const TAB_ROW_GAP_REM = 0.125
/** One row plus its wrap gap — the row pitch. */
export const TAB_ROW_PITCH_REM = TAB_ROW_HEIGHT_REM + TAB_ROW_GAP_REM
/** Top padding of the strip: pt-px (fixed 1px, non-rem). */
export const TAB_STRIP_TOP_PADDING_PX = 1

function clampRows(rows: number): number {
  return Math.min(TAB_BAR_ROWS_MAX, Math.max(TAB_BAR_ROWS_MIN, Math.round(rows)))
}

/** Inline max-height for the strip showing `rows` full rows; rem-based so it tracks --ui-scale. */
export function tabBarRowsToMaxHeightCss(rows: number): string {
  const clamped = clampRows(rows)
  return `calc(${TAB_ROW_PITCH_REM * clamped - TAB_ROW_GAP_REM}rem + ${TAB_STRIP_TOP_PADDING_PX}px)`
}

/** Live root font-size in px; falls back to 16 when unparseable (jsdom has no --ui-scale cascade). */
export function getRootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16
}

/** One row pitch (row + gap) in px at the given root font-size — the keyboard step. */
export function tabBarRowPitchPx(rootFontSizePx: number): number {
  return TAB_ROW_PITCH_REM * rootFontSizePx
}

/** Max-height in px of the strip showing `rows` full rows at the given root font-size. */
export function tabBarRowsToMaxHeightPx(rows: number, rootFontSizePx: number): number {
  const clamped = clampRows(rows)
  return (TAB_ROW_PITCH_REM * clamped - TAB_ROW_GAP_REM) * rootFontSizePx + TAB_STRIP_TOP_PADDING_PX
}

/** Nearest row count for a strip height in px (inverse of tabBarRowsToMaxHeightPx). */
export function tabBarHeightPxToRows(px: number, rootFontSizePx: number): number {
  return clampRows(
    (px - TAB_STRIP_TOP_PADDING_PX + TAB_ROW_GAP_REM * rootFontSizePx) /
      tabBarRowPitchPx(rootFontSizePx),
  )
}

/** A strip whose scrollHeight exceeds this (at the given root font-size) renders >1 row. */
export function tabBarMultiRowThresholdPx(rootFontSizePx: number): number {
  return tabBarRowPitchPx(rootFontSizePx) + TAB_STRIP_TOP_PADDING_PX
}
