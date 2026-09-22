import { describe, expect, it } from 'vitest'
import { ClientMessageSchema, TerminalAttachSchema } from '@shared/ws-protocol'

describe('terminal.attach paced page-budget request (replayPageBytes)', () => {
  const attach = {
    type: 'terminal.attach',
    terminalId: 'term-1',
    intent: 'viewport_hydrate',
    cols: 80,
    rows: 24,
    attachRequestId: 'attach-1',
    replayPageBytes: 128 * 1024,
  }

  it('parses the negotiated replayPageBytes request and keeps it on the wire contract', () => {
    // The schema owns the frozen wire contract: the parsed result must
    // CARRY the field (z.object strips unknown keys, so an unregistered
    // field would silently vanish from the parsed output).
    const parsed = TerminalAttachSchema.parse(attach)
    expect(parsed.replayPageBytes).toBe(128 * 1024)
    // The client union accepts the same frame.
    expect(ClientMessageSchema.safeParse(attach).success).toBe(true)
    // The field is optional and additive: legacy attaches without it stay valid.
    const { replayPageBytes: _omitted, ...legacy } = attach
    expect(TerminalAttachSchema.safeParse(legacy).success).toBe(true)
  })

  it('rejects non-positive page-budget requests (the bound is a positive upper bound)', () => {
    expect(TerminalAttachSchema.safeParse({ ...attach, replayPageBytes: 0 }).success).toBe(false)
    expect(TerminalAttachSchema.safeParse({ ...attach, replayPageBytes: -1024 }).success).toBe(false)
    expect(TerminalAttachSchema.safeParse({ ...attach, replayPageBytes: 1.5 }).success).toBe(false)
  })
})
