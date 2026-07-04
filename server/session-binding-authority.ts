import { makeSessionKey, type CodingCliProviderName, type SessionCompositeKey } from './coding-cli/types.js'

export type BindInput = {
  provider: CodingCliProviderName
  sessionId: string
  terminalId: string
}

export type BindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'session_already_owned'; owner: string }
  | { ok: false; reason: 'terminal_already_bound'; existing: SessionCompositeKey }

export type UnbindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'not_bound' }

export type SwapTerminalSessionInput = {
  provider: CodingCliProviderName
  terminalId: string
  fromSessionId: string
  toSessionId: string
}

export type SwapTerminalSessionResult =
  | { ok: true; fromKey: SessionCompositeKey; toKey: SessionCompositeKey }
  | { ok: false; reason: 'terminal_not_bound' }
  | { ok: false; reason: 'from_session_mismatch'; existing: SessionCompositeKey }
  | { ok: false; reason: 'target_session_already_owned'; owner: string }

export class SessionBindingAuthority {
  private bySession = new Map<SessionCompositeKey, string>()
  private byTerminal = new Map<string, SessionCompositeKey>()

  bind(input: BindInput): BindResult {
    const key = makeSessionKey(input.provider, input.sessionId)
    const owner = this.bySession.get(key)
    if (owner && owner !== input.terminalId) {
      return { ok: false, reason: 'session_already_owned', owner }
    }

    const existing = this.byTerminal.get(input.terminalId)
    if (existing && existing !== key) {
      return { ok: false, reason: 'terminal_already_bound', existing }
    }

    this.bySession.set(key, input.terminalId)
    this.byTerminal.set(input.terminalId, key)
    return { ok: true, key }
  }

  swapTerminalSession(input: SwapTerminalSessionInput): SwapTerminalSessionResult {
    const fromKey = makeSessionKey(input.provider, input.fromSessionId)
    const toKey = makeSessionKey(input.provider, input.toSessionId)
    const existing = this.byTerminal.get(input.terminalId)
    if (!existing) return { ok: false, reason: 'terminal_not_bound' }
    if (existing !== fromKey) {
      return { ok: false, reason: 'from_session_mismatch', existing }
    }

    const targetOwner = this.bySession.get(toKey)
    if (targetOwner && targetOwner !== input.terminalId) {
      return { ok: false, reason: 'target_session_already_owned', owner: targetOwner }
    }

    if (fromKey !== toKey && this.bySession.get(fromKey) === input.terminalId) {
      this.bySession.delete(fromKey)
    }
    this.bySession.set(toKey, input.terminalId)
    this.byTerminal.set(input.terminalId, toKey)
    return { ok: true, fromKey, toKey }
  }

  ownerForSession(provider: CodingCliProviderName, sessionId: string): string | undefined {
    return this.bySession.get(makeSessionKey(provider, sessionId))
  }

  sessionForTerminal(terminalId: string): SessionCompositeKey | undefined {
    return this.byTerminal.get(terminalId)
  }

  unbindTerminal(terminalId: string): UnbindResult {
    const key = this.byTerminal.get(terminalId)
    if (!key) return { ok: false, reason: 'not_bound' }

    this.byTerminal.delete(terminalId)
    if (this.bySession.get(key) === terminalId) {
      this.bySession.delete(key)
    }
    return { ok: true, key }
  }

  clearSessionOwner(provider: CodingCliProviderName, sessionId: string): void {
    const key = makeSessionKey(provider, sessionId)
    const ownerTerminalId = this.bySession.get(key)
    if (!ownerTerminalId) return
    this.bySession.delete(key)
    if (this.byTerminal.get(ownerTerminalId) === key) {
      this.byTerminal.delete(ownerTerminalId)
    }
  }
}
