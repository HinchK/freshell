import { describe, expect, it } from 'vitest'

import {
  getRootFontSizePx,
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
