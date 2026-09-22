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

  it('accepts integer-valued number spellings the wire can carry (2048.0, 2e3)', () => {
    // E2R1 finding 3 parity pin: JSON has one number type, so 2048.0 and
    // 2e3 arrive as float-spelled JSON and parse to integer-VALUED JS
    // numbers. The Zod contract accepts their value as an integer — the
    // Rust lossy deserializer must accept and validate them the same
    // way, never silently drop the requested bound to the server
    // default. This pins the TS side of that parity; the Rust side is
    // pinned in crates/freshell-protocol/tests/roundtrip.rs.
    const floatSpelled = JSON.parse(
      '{"type":"terminal.attach","terminalId":"term-1","intent":"viewport_hydrate","cols":80,"rows":24,"attachRequestId":"attach-1","replayPageBytes":2048.0}',
    )
    expect(TerminalAttachSchema.parse(floatSpelled).replayPageBytes).toBe(2048)
    const exponentSpelled = JSON.parse(
      '{"type":"terminal.attach","terminalId":"term-1","intent":"viewport_hydrate","cols":80,"rows":24,"attachRequestId":"attach-1","replayPageBytes":2e3}',
    )
    expect(TerminalAttachSchema.parse(exponentSpelled).replayPageBytes).toBe(2000)
    // A fractional value stays rejected (its value is not an integer).
    const fractional = JSON.parse(
      '{"type":"terminal.attach","terminalId":"term-1","intent":"viewport_hydrate","cols":80,"rows":24,"attachRequestId":"attach-1","replayPageBytes":1.5}',
    )
    expect(TerminalAttachSchema.safeParse(fractional).success).toBe(false)
  })
})
