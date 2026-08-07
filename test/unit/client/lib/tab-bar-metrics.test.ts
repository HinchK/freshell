import { describe, expect, it } from 'vitest'

import {
  getRootFontSizePx,
  multirowUniformTabWidthPx,
  tabBarHeightPxToRows,
  tabBarMultiRowThresholdPx,
  tabBarRowPitchPx,
  tabBarRowsToMaxHeightCss,
  tabBarRowsToMaxHeightPx,
} from '@/lib/tab-bar-metrics'

describe('tab-bar-metrics', () => {
  it('emits a rem-based calc() max-height for a row count ((2.125n - 0.125)rem + 1px)', () => {
    expect(tabBarRowsToMaxHeightCss(1)).toBe('calc(2rem + 1px)')
    expect(tabBarRowsToMaxHeightCss(3)).toBe('calc(6.25rem + 1px)')
    expect(tabBarRowsToMaxHeightCss(5)).toBe('calc(10.5rem + 1px)')
  })

  it('clamps the row count to the allowed range', () => {
    expect(tabBarRowsToMaxHeightCss(0)).toBe('calc(2rem + 1px)')
    expect(tabBarRowsToMaxHeightCss(99)).toBe('calc(21.125rem + 1px)')
    expect(tabBarRowsToMaxHeightPx(0, 16)).toBe(33)
    expect(tabBarRowsToMaxHeightPx(99, 16)).toBe(339)
  })

  it('computes px heights from an explicit root font-size (default and 1.25 scale)', () => {
    expect(tabBarRowsToMaxHeightPx(1, 16)).toBe(33)
    expect(tabBarRowsToMaxHeightPx(2, 16)).toBe(67)
    expect(tabBarRowsToMaxHeightPx(3, 16)).toBe(101)
    expect(tabBarRowsToMaxHeightPx(5, 16)).toBe(169)
    expect(tabBarRowsToMaxHeightPx(3, 20)).toBe(126) // uiScale 1.25 => 20px root
  })

  it('is inverted by tabBarHeightPxToRows at any scale', () => {
    for (const rootPx of [16, 20]) {
      for (const rows of [1, 2, 3, 5, 10]) {
        expect(tabBarHeightPxToRows(tabBarRowsToMaxHeightPx(rows, rootPx), rootPx)).toBe(rows)
      }
    }
  })

  it('rounds a mid-drag height to the nearest row', () => {
    expect(tabBarHeightPxToRows(117, 16)).toBe(3)
    expect(tabBarHeightPxToRows(118, 16)).toBe(4)
  })

  it('clamps heights outside the range', () => {
    expect(tabBarHeightPxToRows(-50, 16)).toBe(1)
    expect(tabBarHeightPxToRows(10_000, 16)).toBe(10)
  })

  it('keyboard step is exactly one row pitch at the given scale', () => {
    expect(tabBarRowPitchPx(16)).toBe(34)
    expect(tabBarRowPitchPx(20)).toBe(42.5)
  })

  it('multi-row threshold sits strictly between one and two rows at any scale', () => {
    for (const rootPx of [16, 20]) {
      const oneRowScrollHeight = 2 * rootPx + 1 // h-8 + pt-px
      const twoRowScrollHeight = 4.125 * rootPx + 1 // 2 rows + 1 gap + pt-px
      expect(tabBarMultiRowThresholdPx(rootPx)).toBeGreaterThan(oneRowScrollHeight)
      expect(tabBarMultiRowThresholdPx(rootPx)).toBeLessThan(twoRowScrollHeight)
    }
  })

  it('falls back to a 16px root when the computed font-size is unparseable (jsdom)', () => {
    expect(getRootFontSizePx()).toBe(16)
  })
})

describe('multirowUniformTabWidthPx', () => {
  const GAP = 2 // TAB_ROW_GAP_REM (0.125rem) at the 16px default root

  it('returns null when all tabs fit on a single row', () => {
    // 1000px strip, 2px gap: floor((1000 + 2) / 152) = 6 tabs per full row.
    expect(multirowUniformTabWidthPx(1000, 1, GAP)).toBeNull()
    expect(multirowUniformTabWidthPx(1000, 6, GAP)).toBeNull()
  })

  it('locks wrapped tabs to the full-row width', () => {
    // 6 tabs per full row: (1000 - 5*2) / 6 = 165.
    expect(multirowUniformTabWidthPx(1000, 7, GAP)).toBe(165)
    // The width comes from the container, not the tab count.
    expect(multirowUniformTabWidthPx(1000, 20, GAP)).toBe(165)
  })

  it('floors fractional widths so a full row never overflows', () => {
    // (1003 - 5*2) / 6 = 165.5 -> 165.
    expect(multirowUniformTabWidthPx(1003, 7, GAP)).toBe(165)
  })

  it('caps the locked width at 200px', () => {
    // 2 tabs per full row: (450 - 2) / 2 = 224 -> capped to 200.
    expect(multirowUniformTabWidthPx(450, 3, GAP)).toBe(200)
  })

  it('never returns less than the 150px minimum', () => {
    // Degenerate 120px strip: 1 tab per row at raw width 120 -> clamped to 150,
    // matching the CSS min-width floor (the tab overflows, same as today).
    expect(multirowUniformTabWidthPx(120, 2, GAP)).toBe(150)
  })

  it('returns null for unmeasured or empty strips', () => {
    expect(multirowUniformTabWidthPx(0, 10, GAP)).toBeNull() // jsdom / pre-layout
    expect(multirowUniformTabWidthPx(-5, 10, GAP)).toBeNull()
    expect(multirowUniformTabWidthPx(1000, 0, GAP)).toBeNull()
  })

  it('is gap-aware for scaled roots', () => {
    // At a 20px root, gap-0.5 is 2.5px: floor((1000 + 2.5) / 152.5) = 6 per row,
    // (1000 - 5*2.5) / 6 = 164.58 -> 164.
    expect(multirowUniformTabWidthPx(1000, 8, 2.5)).toBe(164)
  })

  it('locked width preserves the full-row packing (no re-wrap knife-edge)', () => {
    for (let width = 320; width <= 2000; width += 7) {
      const tabsPerFullRow = Math.floor((width + GAP) / (150 + GAP))
      const locked = multirowUniformTabWidthPx(width, tabsPerFullRow + 1, GAP)
      expect(locked).not.toBeNull()
      // A full row of locked tabs still fits in the strip...
      expect(tabsPerFullRow * locked! + (tabsPerFullRow - 1) * GAP).toBeLessThanOrEqual(width)
      // ...and one more locked tab would not fit on that row.
      expect((tabsPerFullRow + 1) * locked! + tabsPerFullRow * GAP).toBeGreaterThan(width)
    }
  })
})
