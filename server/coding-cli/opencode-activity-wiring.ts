import { OpencodeActivityTracker } from './opencode-activity-tracker.js'
import { OpencodeSessionController } from './opencode-session-controller.js'
import type { OpencodeRootResolution } from './providers/opencode.js'
import type { OpencodeServerEndpoint } from '../local-port.js'
import type { BindSessionResult, TerminalRecord } from '../terminal-registry.js'
import type { SessionBindingReason } from '../terminal-stream/registry-events.js'

type OpencodeActivityRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => TerminalRecord | undefined | null
  bindSession: (
    terminalId: string,
    provider: 'opencode',
    sessionId: string,
    reason?: SessionBindingReason,
  ) => BindSessionResult
  rebindSession: (
    terminalId: string,
    provider: 'opencode',
    sessionId: string,
    reason?: SessionBindingReason,
  ) => BindSessionResult
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

function getEndpoint(record: TerminalRecord): OpencodeServerEndpoint | undefined {
  return record.mode === 'opencode' ? record.opencodeServer : undefined
}

export function wireOpencodeActivityTracker(input: {
  registry: OpencodeActivityRegistry
  fetchImpl?: typeof fetch
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  random?: () => number
  resolveOpencodeSessionRoots?: (sessionIds: readonly string[]) => Promise<OpencodeRootResolution>
  onAssociated?: (event: { terminalId: string; sessionId: string }) => void
  onTurnComplete?: (event: { terminalId: string; sessionId: string; at: number }) => void
}) {
  const tracker = new OpencodeActivityTracker({
    fetchImpl: input.fetchImpl,
    now: input.now,
    setTimeoutFn: input.setTimeoutFn,
    clearTimeoutFn: input.clearTimeoutFn,
    random: input.random,
    resolveOpencodeSessionRoots: input.resolveOpencodeSessionRoots,
  })
  const controller = new OpencodeSessionController({
    tracker,
    registry: input.registry,
  })

  const startTracking = (record: TerminalRecord) => {
    const endpoint = getEndpoint(record)
    if (!endpoint || record.status !== 'running') return
    tracker.trackTerminal({
      terminalId: record.terminalId,
      endpoint,
    })
  }

  const onCreated = (record: TerminalRecord) => {
    startTracking(record)
  }

  const onExit = (event: { terminalId?: string }) => {
    if (!event.terminalId) return
    tracker.untrackTerminal({ terminalId: event.terminalId })
  }

  const onAssociated = (event: { terminalId: string; sessionId: string }) => {
    input.onAssociated?.(event)
  }

  const onTurnComplete = (event: { terminalId: string; sessionId: string; at: number }) => {
    input.onTurnComplete?.(event)
  }

  input.registry.on('terminal.created', onCreated)
  input.registry.on('terminal.exit', onExit)
  controller.on('associated', onAssociated)
  tracker.on('turn.complete', onTurnComplete)

  for (const listed of input.registry.list()) {
    const record = input.registry.get(listed.terminalId)
    if (!record) continue
    startTracking(record)
  }

  return {
    tracker,
    controller,
    dispose(): void {
      input.registry.off('terminal.created', onCreated)
      input.registry.off('terminal.exit', onExit)
      controller.off('associated', onAssociated)
      tracker.off('turn.complete', onTurnComplete)
      controller.dispose()
      tracker.dispose()
    },
  }
}
