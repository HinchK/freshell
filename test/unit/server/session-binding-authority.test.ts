import { describe, expect, it } from 'vitest'
import { SessionBindingAuthority } from '../../../server/session-binding-authority'

describe('SessionBindingAuthority', () => {
  it('rejects binding the same session key to a second terminal', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't2' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('Expected failed bind')
    expect(second.reason).toBe('session_already_owned')
    expect(second.owner).toBe('t1')
  })

  it('is idempotent when binding same provider/session to same terminal', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })

  it('rejects rebinding a terminal that already owns a different session', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's2', terminalId: 't1' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('Expected failed bind')
    expect(second.reason).toBe('terminal_already_bound')
  })

  describe('swapTerminalSession', () => {
    it('moves the session key for a bound terminal', () => {
      const authority = new SessionBindingAuthority()
      authority.bind({ provider: 'codex', sessionId: 'a', terminalId: 't1' })
      const result = authority.swapTerminalSession({
        provider: 'codex',
        terminalId: 't1',
        fromSessionId: 'a',
        toSessionId: 'b',
      })
      expect(result.ok).toBe(true)
      expect(authority.ownerForSession('codex', 'b')).toBe('t1')
      expect(authority.ownerForSession('codex', 'a')).toBeUndefined()
    })

    it('refuses when the terminal is not bound', () => {
      const authority = new SessionBindingAuthority()
      expect(authority.swapTerminalSession({
        provider: 'codex',
        terminalId: 't1',
        fromSessionId: 'a',
        toSessionId: 'b',
      }).ok).toBe(false)
    })

    it('refuses on from-session mismatch (optimistic concurrency)', () => {
      const authority = new SessionBindingAuthority()
      authority.bind({ provider: 'codex', sessionId: 'a', terminalId: 't1' })
      const result = authority.swapTerminalSession({
        provider: 'codex',
        terminalId: 't1',
        fromSessionId: 'zzz',
        toSessionId: 'b',
      })
      expect(result.ok).toBe(false)
      expect(authority.ownerForSession('codex', 'a')).toBe('t1')
    })

    it('refuses when the target session is owned by another terminal', () => {
      const authority = new SessionBindingAuthority()
      authority.bind({ provider: 'codex', sessionId: 'a', terminalId: 't1' })
      authority.bind({ provider: 'codex', sessionId: 'b', terminalId: 't2' })
      expect(authority.swapTerminalSession({
        provider: 'codex',
        terminalId: 't1',
        fromSessionId: 'a',
        toSessionId: 'b',
      }).ok).toBe(false)
    })

    it('self-swap is an ok no-op', () => {
      const authority = new SessionBindingAuthority()
      authority.bind({ provider: 'codex', sessionId: 'a', terminalId: 't1' })
      expect(authority.swapTerminalSession({
        provider: 'codex',
        terminalId: 't1',
        fromSessionId: 'a',
        toSessionId: 'a',
      }).ok).toBe(true)
      expect(authority.ownerForSession('codex', 'a')).toBe('t1')
    })
  })
})
