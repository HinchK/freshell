import { useEffect } from 'react'
import type { MutableRefObject } from 'react'

export type TerminalTextReader = () => string[]
const readers = new Map<string, TerminalTextReader>()

export function registerTerminalTextReader(terminalId: string, reader: TerminalTextReader): () => void {
  readers.set(terminalId, reader)
  return () => {
    if (readers.get(terminalId) === reader) readers.delete(terminalId)
  }
}
export function getTerminalTextSnapshot(terminalId: string): string[] | null {
  const reader = readers.get(terminalId)
  return reader ? reader() : null
}
export function resetTerminalTextRegistryForTests(): void {
  readers.clear()
}

export type XtermLike = {
  buffer: {
    active: {
      length: number
      viewportY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

export function readXtermTail(term: XtermLike, maxLines: number): string[] {
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - maxLines)
  const out: string[] = []
  for (let y = start; y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return out
}

export function useTerminalTextRegistration(
  terminalId: string | undefined,
  termRef: MutableRefObject<XtermLike | null>,
  maxLines = 12,
): void {
  useEffect(() => {
    if (!terminalId) return
    return registerTerminalTextReader(terminalId, () => {
      const term = termRef.current
      return term ? readXtermTail(term, maxLines) : []
    })
  }, [terminalId, termRef, maxLines])
}
