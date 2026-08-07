import { useCallback, useEffect, useRef } from 'react'

import { PaneDivider } from '@/components/panes'
import {
  getRootFontSizePx,
  tabBarHeightPxToRows,
  tabBarRowPitchPx,
  tabBarRowsToMaxHeightPx,
} from '@/lib/tab-bar-metrics'

interface TabBarResizeHandleProps {
  /** Currently persisted visible row count. */
  rows: number
  /** Called with the new clamped row count whenever a drag/keypress crosses a row boundary. */
  onRowsChange: (rows: number) => void
}

/**
 * Hover splitter sitting just below the multirow tab bar's bottom edge. Converts
 * PaneDivider's incremental pixel deltas into whole-row changes. All px math reads
 * the live root font-size so it stays correct under any --ui-scale.
 */
export default function TabBarResizeHandle({ rows, onRowsChange }: TabBarResizeHandleProps) {
  // Accumulated height in px during an active drag; null when idle.
  const dragPxRef = useRef<number | null>(null)
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  const handleResize = useCallback((delta: number) => {
    const rootPx = getRootFontSizePx()
    const base = dragPxRef.current ?? tabBarRowsToMaxHeightPx(rowsRef.current, rootPx)
    const next = base + delta
    dragPxRef.current = next
    const nextRows = tabBarHeightPxToRows(next, rootPx)
    if (nextRows !== rowsRef.current) {
      rowsRef.current = nextRows
      onRowsChange(nextRows)
    }
  }, [onRowsChange])

  const handleResizeEnd = useCallback(() => {
    dragPxRef.current = null
  }, [])

  return (
    <div
      // Bottom-only overlay: sits entirely BELOW the bar's bottom edge, over the top
      // 12px of the pane area. A straddling position (translate-y-1/2) would cover the
      // bottom ~6px of every bottom-row tab and steal their click/close/drag pointerdown.
      className="absolute inset-x-0 bottom-0 z-30 translate-y-full"
      data-testid="tab-bar-resize-handle"
    >
      <PaneDivider
        direction="vertical"
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        keyboardStep={tabBarRowPitchPx(getRootFontSizePx())}
        ariaLabel="Resize tab bar height"
      />
    </div>
  )
}
