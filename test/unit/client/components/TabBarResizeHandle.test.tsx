import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import TabBarResizeHandle from '@/components/TabBarResizeHandle'

afterEach(() => {
  cleanup()
})

describe('TabBarResizeHandle', () => {
  it('renders an accessible separator', () => {
    render(<TabBarResizeHandle rows={3} onRowsChange={vi.fn()} />)
    expect(screen.getByRole('separator', { name: 'Resize tab bar height' })).toBeTruthy()
    expect(screen.getByTestId('tab-bar-resize-handle')).toBeTruthy()
  })

  it('adds a row per ArrowDown press', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' })
    expect(onRowsChange).toHaveBeenCalledWith(4)
  })

  it('removes a row per ArrowUp press', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(onRowsChange).toHaveBeenCalledWith(2)
  })

  it('never goes below one row', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={1} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(onRowsChange).not.toHaveBeenCalled()
  })

  it('converts a mouse drag into row changes', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { clientY: 200 })
    fireEvent.mouseMove(document, { clientY: 268 }) // +68px = +2 rows
    fireEvent.mouseUp(document)

    expect(onRowsChange).toHaveBeenLastCalledWith(5)
  })

  it('drags back up to shrink', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { clientY: 200 })
    fireEvent.mouseMove(document, { clientY: 166 }) // -34px = -1 row
    fireEvent.mouseUp(document)

    expect(onRowsChange).toHaveBeenLastCalledWith(2)
  })
})
