import { describe, expect, it, vi } from 'vitest'

import { registerTerminalRequestModeBypass } from '@/components/terminal/request-mode-bypass'
import { isReplayPhantomFocusReport } from '@/lib/terminal-output-side-effects'
import {
  beginTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
  type TerminalOutputSideEffect,
} from '@/lib/terminal-output-write-scope'

describe('terminal output side-effect policy', () => {
  it('fails closed for unknown output scope', () => {
    const effects: TerminalOutputSideEffect[] = [
      'startup_reply',
      'osc52_prompt',
      'osc52_clipboard_write',
      'request_mode_reply',
      'title_update',
      'turn_complete',
      'parser_applied_checkpoint',
      'attach_completion',
      'cursor_persist',
      'link_action',
      'terminal_action',
      'local_xterm_notice',
    ]

    for (const effect of effects) {
      expect(shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: 'unknown-surface',
        effect,
        mode: 'shell',
      })).toBe(false)
    }
  })

  it('allows declared live external side effects and suppresses replay side effects', () => {
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'live',
      effect: 'startup_reply',
      mode: 'shell',
    })).toBe(true)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'live',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(true)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'startup_reply',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'local_xterm_notice',
      mode: 'shell',
    })).toBe(false)
  })

  it('uses explicit live frame context instead of an unrelated active replay write scope', () => {
    const replayScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-live-frame',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })

    try {
      expect(shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: 'surface-live-frame',
        source: 'live',
        effect: 'startup_reply',
        mode: 'opencode',
      })).toBe(true)
      expect(shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: 'surface-live-frame',
        source: 'live',
        effect: 'osc52_clipboard_write',
        mode: 'opencode',
      })).toBe(true)
      expect(shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: 'surface-live-frame',
        source: 'live',
        effect: 'turn_complete',
        mode: 'gemini',
      })).toBe(true)
      expect(shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: 'surface-live-frame',
        source: 'replay',
        effect: 'osc52_clipboard_write',
        mode: 'opencode',
      })).toBe(false)
    } finally {
      replayScope.complete()
    }
  })

  it('keeps server-authoritative turn completion for all four terminal CLIs', () => {
    // Truly-idle alerting: claude/codex/opencode/amplifier green/sound edges are
    // server-emitted (terminal.idle) — the client must not mint completions from
    // output for any of them. Other modes (custom CLIs) keep the client BEL path.
    for (const mode of ['claude', 'codex', 'opencode', 'amplifier'] as const) {
      expect(shouldAllowTerminalOutputSideEffect({
        source: 'live',
        effect: 'turn_complete',
        mode,
      })).toBe(false)
    }
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'live',
      effect: 'turn_complete',
      mode: 'gemini',
    })).toBe(true)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'turn_complete',
      mode: 'gemini',
    })).toBe(false)
  })

  it('does not send request-mode bypass replies while the submitted write scope is replay', () => {
    const disposers = [{ dispose: vi.fn() }, { dispose: vi.fn() }]
    const registerCsiHandler = vi
      .fn()
      .mockReturnValueOnce(disposers[0])
      .mockReturnValueOnce(disposers[1])
    const sendInput = vi.fn()
    const term = {
      parser: { registerCsiHandler },
      modes: { bracketedPasteMode: true },
      options: {},
      buffer: { active: { type: 'normal' as const } },
    }

    registerTerminalRequestModeBypass(term as any, sendInput, {
      terminalInstanceId: 'surface-request-mode',
    })
    const privateHandler = registerCsiHandler.mock.calls[1]?.[1]

    const replayScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-request-mode',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })
    expect(privateHandler([2004])).toBe(true)
    expect(sendInput).not.toHaveBeenCalled()
    replayScope.complete()

    const liveScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-request-mode',
      source: 'live',
      attachRequestId: 'attach-2',
      generation: 'attach-2',
      suppressExternalSideEffects: false,
    })
    expect(privateHandler([2004])).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\u001b[?2004;1$y')
    liveScope.complete()
  })
})

describe('isReplayPhantomFocusReport', () => {
  it('swallows ESC[I and ESC[O while a suppressing replay write scope is open', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 't1',
      source: 'replay',
      attachRequestId: undefined,
      generation: 'g',
      suppressExternalSideEffects: true,
    })
    try {
      expect(isReplayPhantomFocusReport('\u001b[I', 't1')).toBe(true)
      expect(isReplayPhantomFocusReport('\u001b[O', 't1')).toBe(true)
    } finally {
      scope.complete()
    }
  })

  it('passes focus reports through inside a live (non-suppressing) scope', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 't1',
      source: 'live',
      attachRequestId: undefined,
      generation: 'g',
      suppressExternalSideEffects: false,
    })
    try {
      expect(isReplayPhantomFocusReport('\u001b[I', 't1')).toBe(false)
      expect(isReplayPhantomFocusReport('\u001b[O', 't1')).toBe(false)
    } finally {
      scope.complete()
    }
  })

  it('passes focus reports through when no write scope is open', () => {
    expect(isReplayPhantomFocusReport('\u001b[I', 't1')).toBe(false)
    expect(isReplayPhantomFocusReport('\u001b[I', undefined)).toBe(false)
    expect(isReplayPhantomFocusReport('\u001b[O', 't1')).toBe(false)
  })

  it('leaves non-report bytes untouched even under a suppressing replay scope', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 't1',
      source: 'replay',
      attachRequestId: undefined,
      generation: 'g',
      suppressExternalSideEffects: true,
    })
    try {
      expect(isReplayPhantomFocusReport('a', 't1')).toBe(false)
      expect(isReplayPhantomFocusReport('\u001b[?1004h', 't1')).toBe(false)
    } finally {
      scope.complete()
    }
  })

  it('does not swallow reports for a different terminal instance', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 't1',
      source: 'replay',
      attachRequestId: undefined,
      generation: 'g',
      suppressExternalSideEffects: true,
    })
    try {
      expect(isReplayPhantomFocusReport('\u001b[I', 't2')).toBe(false)
    } finally {
      scope.complete()
    }
  })

  it('releases the swallow once the scope completes', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 't1',
      source: 'replay',
      attachRequestId: undefined,
      generation: 'g',
      suppressExternalSideEffects: true,
    })
    expect(isReplayPhantomFocusReport('\u001b[I', 't1')).toBe(true)
    scope.complete()
    expect(isReplayPhantomFocusReport('\u001b[I', 't1')).toBe(false)
  })
})
