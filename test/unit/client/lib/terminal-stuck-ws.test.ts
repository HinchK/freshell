import { describe, expect, it } from 'vitest'
import { TerminalStuckSchema } from '@shared/ws-protocol'

describe('terminal.stuck wire contract', () => {
  it('accepts a stuck transition frame', () => {
    const frame = { type: 'terminal.stuck' as const, terminalId: 't-1', at: 1789947521195, stuck: true }
    expect(TerminalStuckSchema.parse(frame)).toEqual(frame)
  })
  it('accepts the unstuck transition and rejects wrong shapes', () => {
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1, stuck: false }).success).toBe(true)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1 }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.idle', terminalId: 't-1', at: 1, stuck: true }).success).toBe(false)
  })
})
