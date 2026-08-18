export type TerminalOutputSource = 'live' | 'replay'

export type TerminalOutputSideEffect =
  | 'startup_reply'
  | 'osc52_prompt'
  | 'osc52_clipboard_write'
  | 'request_mode_reply'
  | 'title_update'
  | 'turn_complete'
  | 'parser_applied_checkpoint'
  | 'attach_completion'
  | 'cursor_persist'
  | 'link_action'
  | 'terminal_action'
  | 'local_xterm_notice'

export type TerminalOutputWriteContext = {
  terminalInstanceId: string
  source: TerminalOutputSource
  attachRequestId: string | undefined
  generation: string
  suppressExternalSideEffects: boolean
}

const activeScopes = new Map<string, TerminalOutputWriteContext[]>()

export function getTerminalOutputWriteScope(
  terminalInstanceId: string | undefined,
): TerminalOutputWriteContext | null {
  if (!terminalInstanceId) return null
  const stack = activeScopes.get(terminalInstanceId)
  if (!stack || stack.length === 0) return null
  return stack[stack.length - 1]
}

export function beginTerminalOutputWriteScope(
  context: TerminalOutputWriteContext,
): { complete: () => void } {
  let stack = activeScopes.get(context.terminalInstanceId)
  if (!stack) {
    stack = []
    activeScopes.set(context.terminalInstanceId, stack)
  }
  stack.push(context)
  let completed = false
  return {
    complete: () => {
      if (completed) return
      completed = true
      const index = stack.indexOf(context)
      if (index !== -1) {
        stack.splice(index, 1)
      }
      if (stack.length === 0) {
        activeScopes.delete(context.terminalInstanceId)
      }
    },
  }
}

export { shouldAllowTerminalOutputSideEffect } from './terminal-output-side-effects.js'
