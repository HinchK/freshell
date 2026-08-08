export interface PanePickerGridLayout {
  rowSizes: number[]
  maxCols: number
}

export function centerOutRowOrder(rowCount: number): number[] {
  const order: number[] = []
  let lo = Math.floor((rowCount - 1) / 2)
  let hi = Math.floor(rowCount / 2)
  while (order.length < rowCount) {
    if (lo === hi) {
      order.push(lo)
      lo -= 1
      hi += 1
    } else {
      order.push(lo, hi)
      lo -= 1
      hi += 1
    }
  }
  return order
}

export function distributeRows(optionCount: number, rowCount: number): number[] {
  const base = Math.floor(optionCount / rowCount)
  const rem = optionCount % rowCount
  const rows: number[] = new Array<number>(rowCount).fill(base)
  if (rowCount % 2 === 0 && rem === 1 && base >= 3) {
    rows[rowCount / 2 - 1] += 1
    rows[rowCount / 2] += 1
    rows[rowCount - 1] -= 1
    return rows
  }
  for (const row of centerOutRowOrder(rowCount).slice(0, rem)) {
    rows[row] += 1
  }
  return rows
}

export function chooseRowCount(optionCount: number, width: number, height: number): number {
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  const maxRows = optionCount >= 2 ? Math.floor(optionCount / 2) : 1
  let bestRows = 1
  let bestTile = -Infinity
  for (let r = 1; r <= maxRows; r++) {
    const tile = Math.min(w / Math.ceil(optionCount / r), h / r)
    if (tile > bestTile + 1e-6) {
      bestTile = tile
      bestRows = r
    }
  }
  return bestRows
}

export function computePanePickerLayout(
  optionCount: number,
  width: number,
  height: number,
): PanePickerGridLayout {
  const rowCount = chooseRowCount(optionCount, width, height)
  const rowSizes = distributeRows(optionCount, rowCount)
  return { rowSizes, maxCols: Math.max(...rowSizes) }
}
