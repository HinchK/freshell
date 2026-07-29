import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import {
  getTerminalTextSnapshot, readXtermTail, registerTerminalTextReader,
  resetTerminalTextRegistryForTests, useTerminalTextRegistration,
} from '@/deck/terminal-text-registry'
import type { XtermLike } from '@/deck/terminal-text-registry'

afterEach(() => resetTerminalTextRegistryForTests())

function fakeXterm(lines: string[]): XtermLike {
  return {
    buffer: {
      active: {
        length: lines.length,
        viewportY: 0,
        getLine: (y: number) => (lines[y] === undefined ? undefined : { translateToString: () => lines[y] }),
      },
    },
  }
}

describe('registry', () => {
  it('registers, reads, and unregisters readers', () => {
    const off = registerTerminalTextReader('term-1', () => ['hello'])
    expect(getTerminalTextSnapshot('term-1')).toEqual(['hello'])
    expect(getTerminalTextSnapshot('nope')).toBeNull()
    off()
    expect(getTerminalTextSnapshot('term-1')).toBeNull()
  })
})

describe('readXtermTail', () => {
  it('returns the last N buffer lines in order', () => {
    const term = fakeXterm(['a', 'b', 'c', 'd', 'e'])
    expect(readXtermTail(term, 3)).toEqual(['c', 'd', 'e'])
    expect(readXtermTail(term, 10)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('useTerminalTextRegistration', () => {
  function Probe({ terminalId, term }: { terminalId?: string; term: XtermLike | null }) {
    const ref = createRef<XtermLike | null>() as { current: XtermLike | null }
    ref.current = term
    useTerminalTextRegistration(terminalId, ref, 3)
    return null
  }
  it('registers while mounted and cleans up on unmount', () => {
    const { unmount } = render(<Probe terminalId="term-9" term={fakeXterm(['x', 'y'])} />)
    expect(getTerminalTextSnapshot('term-9')).toEqual(['x', 'y'])
    unmount()
    expect(getTerminalTextSnapshot('term-9')).toBeNull()
  })
  it('no-ops without a terminalId and tolerates a null term', () => {
    render(<Probe terminalId={undefined} term={null} />)
    expect(getTerminalTextSnapshot('undefined')).toBeNull()
    const { rerender } = render(<Probe terminalId="term-8" term={null} />)
    expect(getTerminalTextSnapshot('term-8')).toEqual([])
    rerender(<Probe terminalId="term-8" term={fakeXterm(['z'])} />)
    expect(getTerminalTextSnapshot('term-8')).toEqual(['z'])
  })
})
