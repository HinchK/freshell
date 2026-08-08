import { describe, it, expect } from 'vitest'
import {
  centerOutRowOrder,
  distributeRows,
  chooseRowCount,
  computePanePickerLayout,
  type PanePickerGridLayout,
} from '@/lib/pane-picker-layout'

const centerOutCases: Array<[number, number[]]> = [
  [1, [0]],
  [2, [0, 1]],
  [3, [1, 0, 2]],
  [4, [1, 2, 0, 3]],
  [5, [2, 1, 3, 0, 4]],
  [6, [2, 3, 1, 4, 0, 5]],
]

describe('centerOutRowOrder', () => {
  it.each(centerOutCases)('orders %i rows center-out as %j', (rowCount, expected) => {
    expect(centerOutRowOrder(rowCount)).toEqual(expected)
  })
})

const distributeCases: Array<[number, number, number[]]> = [
  [13, 4, [3, 4, 4, 2]],
  [10, 4, [2, 3, 3, 2]],
  [10, 3, [3, 4, 3]],
  [11, 4, [3, 3, 3, 2]],
  [12, 4, [3, 3, 3, 3]],
  [14, 4, [3, 4, 4, 3]],
  [15, 4, [4, 4, 4, 3]],
  [13, 5, [2, 3, 3, 3, 2]],
  [7, 3, [2, 3, 2]],
  [7, 4, [2, 2, 2, 1]],
  [9, 4, [2, 3, 2, 2]],
  [17, 4, [4, 5, 5, 3]],
  [9, 3, [3, 3, 3]],
  [1, 1, [1]],
]

describe('distributeRows', () => {
  it.each(distributeCases)('distributeRows(%i, %i) → %j', (n, rowCount, expected) => {
    expect(distributeRows(n, rowCount)).toEqual(expected)
  })

  it('sums to n, keeps every row ≥ 1, and avoids avoidable singletons for n in 1..30, r in 1..n', () => {
    for (let n = 1; n <= 30; n++) {
      for (let r = 1; r <= n; r++) {
        const rows = distributeRows(n, r)
        const base = Math.floor(n / r)
        expect(rows.reduce((sum, row) => sum + row, 0)).toBe(n)
        for (const row of rows) {
          expect(row).toBeGreaterThanOrEqual(1)
          if (base >= 3) {
            expect(row).toBeGreaterThanOrEqual(base - 1)
          }
        }
      }
    }
  })
})

const chooseRowCountCases: Array<[number, number, number, number]> = [
  [13, 480, 400, 4],
  [13, 640, 300, 3],
  [13, 300, 500, 5],
  [10, 480, 400, 3],
  [10, 300, 500, 4],
  [13, 0, 0, 4],
  [1, 100, 100, 1],
  [3, 0, 0, 1],
  [2, 0, 0, 1],
  [4, 0, 0, 2],
  [7, 300, 500, 3],
]

describe('chooseRowCount', () => {
  it.each(chooseRowCountCases)('chooseRowCount(%i, %i, %i) → %i', (n, width, height, expected) => {
    expect(chooseRowCount(n, width, height)).toBe(expected)
  })
})

const layoutCases: Array<[number, number, number, PanePickerGridLayout]> = [
  [13, 480, 400, { rowSizes: [3, 4, 4, 2], maxCols: 4 }],
  [10, 300, 500, { rowSizes: [2, 3, 3, 2], maxCols: 3 }],
]

describe('computePanePickerLayout', () => {
  it.each(layoutCases)('computePanePickerLayout(%i, %i, %i) → %j', (n, width, height, expected) => {
    expect(computePanePickerLayout(n, width, height)).toEqual(expected)
  })

  it('never produces a row with fewer than 2 items for n in 2..20 across the dimension sweep', () => {
    const dimensions: Array<[number, number]> = [
      [0, 0],
      [480, 400],
      [300, 500],
      [640, 300],
      [100, 100],
    ]
    for (let n = 2; n <= 20; n++) {
      for (const [width, height] of dimensions) {
        const { rowSizes } = computePanePickerLayout(n, width, height)
        for (const row of rowSizes) {
          expect(row).toBeGreaterThanOrEqual(2)
        }
      }
    }
  })
})
