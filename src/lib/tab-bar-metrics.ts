import { TAB_BAR_ROWS_MAX, TAB_BAR_ROWS_MIN } from '@shared/settings'

/**
 * All Tailwind spacing is rem-based and the app scales the root font-size via
 * `--ui-scale` (src/index.css:16-20, written by src/hooks/useTheme.ts), so the
 * rows ⇄ height model is expressed in rem — never absolute px. The strip's
 * `pt-px` top padding is a fixed physical 1px and stays OUTSIDE the rem terms.
 */

/** Height of one tab row: TabItem is h-8 (2rem). */
export const TAB_ROW_HEIGHT_REM = 2
/**
 * Gap between tabs: the strip uses gap-0.5 (0.125rem), which is BOTH the
 * vertical gap between wrapped rows and the horizontal gap between tabs
 * within a row (single `gap` shorthand).
 */
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

/**
 * Multirow tab width bounds. Deliberately absolute px — matching the Tailwind
 * `basis-[150px] min-w-[150px] max-w-[200px]` classes on the tab wrappers —
 * so tab WIDTHS do not scale with --ui-scale, unlike the rem-based row
 * heights above. The e2e suite asserts these exact px values at scale 1.
 */
export const MULTIROW_TAB_MIN_WIDTH_PX = 150
export const MULTIROW_TAB_MAX_WIDTH_PX = 200

/**
 * Uniform per-tab width for a wrapped (2+ row) multirow strip, or null when
 * the lock must not apply (all tabs fit on one row, or the width is unknown).
 *
 * The width is derived from the FULL rows: pack as many tabs as fit at the
 * 150px minimum, stretch them to fill the row, cap at 200px — then apply that
 * same width to every tab, so a partial last row ends short of the right edge
 * instead of stretching wider than the rows above.
 *
 * `Math.floor` guards the re-wrap knife-edge: rounding up would push a full
 * row past the container width and drop its last tab onto the next row,
 * oscillating on every ResizeObserver tick.
 *
 * Pure px math — callers pass the strip's measured content width in px (see
 * TabBar's measurement effect for the exact conservative composition) and the
 * gap in px (TAB_ROW_GAP_REM * root font-size); this function never reads the
 * DOM.
 */
export function multirowUniformTabWidthPx(
  containerWidthPx: number,
  tabCount: number,
  gapPx: number,
): number | null {
  if (containerWidthPx <= 0 || tabCount <= 0) return null
  const tabsPerFullRow = Math.max(
    1,
    Math.floor((containerWidthPx + gapPx) / (MULTIROW_TAB_MIN_WIDTH_PX + gapPx)),
  )
  if (tabCount <= tabsPerFullRow) return null
  const stretched = (containerWidthPx - (tabsPerFullRow - 1) * gapPx) / tabsPerFullRow
  return Math.max(
    MULTIROW_TAB_MIN_WIDTH_PX,
    Math.min(MULTIROW_TAB_MAX_WIDTH_PX, Math.floor(stretched)),
  )
}
