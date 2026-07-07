import fs from 'node:fs'
import { logger } from '../logger.js'

// Stage 1a (plan §6): in-memory registry of live codex children (app-server sidecar wrappers and
// codex resume ptys) so `process.on('exit')` can synchronously best-effort SIGKILL any process
// group that graceful teardown did not confirm dead.
//
// Invariants (plan §2):
// - I3: never signal an unregistered process. The group-kill primitive below has exactly ONE
//   caller (`reapSync`), and `reapSync` is referenced only from the `'exit'` binding — both are
//   enforced structurally by test/unit/server/coding-cli/codex-child-registry.test.ts.
// - I4: nothing here may throw out of an exit path or block boot. Every reap step is per-entry
//   try/catch'd; registration is a Map write.
//
// Platform gating: the negative-pid group kill and the /proc identity re-check are Linux-only
// (consistent with `assertUnixSidecarSupport` in codex-app-server/runtime.ts). On win32 (and any
// non-Linux platform) register/deregister still track entries, but `reapSync` does nothing.

export type CodexChildKind = 'app-server' | 'resume-pty'

export type CodexChildEntry = {
  /** Direct child pid (app-server wrapper pid, or the resume pty's pid). */
  pid: number
  /** Process group id. Both child kinds are spawned as group/session leaders, so pgid == pid. */
  pgid: number
  kind: CodexChildKind
}

export type CodexChildRegistryLogger = {
  warn: (fields: Record<string, unknown>, message: string) => void
}

export type CodexChildExitHandlerOptions = {
  /**
   * Routes SIGHUP into the existing graceful shutdown path (index.ts `shutdown()`, idempotent via
   * `isShuttingDown`). Invoked with the literal reason 'SIGHUP'.
   */
  requestShutdown: (signal: string) => void
}

/** Minimal process surface, injectable for hermetic tests. */
export type CodexChildProcessLike = {
  pid: number
  on: (event: string, listener: (...args: any[]) => void) => unknown
}

export type CodexChildRegistryDeps = {
  platform?: NodeJS.Platform
  /** Sync read used for /proc/self/stat (own pgid) and /proc/<pid>/cmdline (identity re-check). */
  readFileSync?: (filePath: string) => Buffer
  /** The raw signal syscall. Only `killProcessGroupSync` may invoke it with a negative pid. */
  killSync?: (pid: number, signal: NodeJS.Signals) => void
  proc?: CodexChildProcessLike
  log?: CodexChildRegistryLogger
}

export type CodexChildRegistry = {
  register: (entry: CodexChildEntry) => void
  deregister: (pid: number) => boolean
  snapshot: () => CodexChildEntry[]
  reapSync: () => void
  installExitHandlers: (options: CodexChildExitHandlerOptions) => void
}

/** Parses the pgrp field (field 5) of a `/proc/<pid>/stat` line; comm may contain spaces/parens. */
function parseStatPgid(stat: string): number | null {
  const closeParen = stat.lastIndexOf(')')
  if (closeParen === -1) return null
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  const pgrp = Number(fields[2])
  return Number.isInteger(pgrp) ? pgrp : null
}

export function createCodexChildRegistry(deps: CodexChildRegistryDeps = {}): CodexChildRegistry {
  const platform = deps.platform ?? process.platform
  const readFileSync = deps.readFileSync ?? ((filePath: string) => fs.readFileSync(filePath))
  const killSync = deps.killSync ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const proc = deps.proc ?? (process as CodexChildProcessLike)
  const log = deps.log ?? logger.child({ component: 'codex-child-registry' })

  const children = new Map<number, CodexChildEntry>()
  let handlersInstalled = false

  function register(entry: CodexChildEntry): void {
    // Guards (I3): only well-formed, signalable-in-principle entries are ever tracked. pgid <= 1
    // would make the exit-time kill(-pgid) hit "every process" (-1) / "own group" (0) / init (1).
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || !Number.isInteger(entry.pgid) || entry.pgid <= 1) {
      log.warn({ entry }, 'Refusing to register codex child with invalid pid/pgid')
      return
    }
    // Double-registration of the same pid is safe: latest registration wins (plan §6 idempotency).
    children.set(entry.pid, { pid: entry.pid, pgid: entry.pgid, kind: entry.kind })
  }

  function deregister(pid: number): boolean {
    return children.delete(pid)
  }

  function snapshot(): CodexChildEntry[] {
    return [...children.values()].map((entry) => ({ ...entry }))
  }

  /**
   * THE group-kill primitive. I3 (structural): its only caller is `reapSync`, which itself runs
   * only from the `'exit'` binding installed by `installExitHandlers`.
   */
  function killProcessGroupSync(pgid: number): void {
    killSync(-pgid, 'SIGKILL')
  }

  /**
   * Synchronous best-effort reap of still-registered codex process groups, for `process.on('exit')`.
   * After a graceful shutdown the registry has been drained (children deregistered on confirmed
   * group death / pty exit), so this is a no-op.
   *
   * Residual pgid-reuse window (accepted, plan §6): the sync cmdline re-check narrows — but cannot
   * close — the check-then-kill race. Between reading /proc/<pid>/cmdline and kill(-pgid) the pid
   * could exit and the pgid be reused. This is narrower than signalling blindly but wider than the
   * async reaper's fresh ownership classification (runtime.ts classifyOwnedProcessGroup); at
   * process-death time there is no async alternative.
   */
  function reapSync(): void {
    try {
      // Linux-only: negative-pid group kill semantics plus the /proc identity re-check. On win32
      // (and darwin, which lacks /proc) this is a documented no-op.
      if (platform !== 'linux') return

      // Never signal our own process group. If we cannot prove our own pgid, refuse to signal
      // anything (fail towards not signalling — I3 over reap completeness).
      let ownPgid: number | null = null
      try {
        ownPgid = parseStatPgid(readFileSync('/proc/self/stat').toString('utf8'))
      } catch {
        ownPgid = null
      }
      if (ownPgid === null) return

      for (const [pid, entry] of [...children]) {
        try {
          children.delete(pid)
          const { pgid } = entry
          // Guards (I3): only registered pgids; never -1/0/1, our own pid's group, or our own pgid.
          if (!Number.isInteger(pgid) || pgid <= 1) continue
          if (pgid === proc.pid || pgid === ownPgid) continue

          // Cheap sync identity re-check: the registered pid must still be a codex process. A read
          // failure means the process is gone (nothing to reap); a non-codex cmdline means the pid
          // was reused (never signal it).
          let cmdline: string
          try {
            cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8')
          } catch {
            continue
          }
          if (!cmdline.includes('codex')) continue

          killProcessGroupSync(pgid)
        } catch {
          // Best-effort per entry: an exit path must never throw (I4).
        }
      }
    } catch {
      // Never throw out of an exit path (I4).
    }
  }

  function installExitHandlers(options: CodexChildExitHandlerOptions): void {
    if (handlersInstalled) return
    handlersInstalled = true
    // 'exit' handlers must be synchronous; reapSync is. This is the ONLY binding that may
    // reference reapSync (I3, enforced structurally by the unit test).
    proc.on('exit', reapSync)
    // SIGHUP joins the existing graceful shutdown path (idempotent via isShuttingDown in index.ts).
    proc.on('SIGHUP', () => options.requestShutdown('SIGHUP'))
    // Observe/log ONLY: uncaughtException default-fatal semantics stay untouched; the fatal path
    // then runs 'exit' -> reapSync.
    proc.on('uncaughtExceptionMonitor', (error: unknown, origin: unknown) => {
      try {
        log.warn({ err: error, origin }, 'Uncaught exception observed; codex children will be reaped on exit')
      } catch {
        // Observability must never alter fatal-exception semantics.
      }
    })
  }

  return { register, deregister, snapshot, reapSync, installExitHandlers }
}

const defaultRegistry = createCodexChildRegistry()

export const registerCodexChild: CodexChildRegistry['register'] = defaultRegistry.register
export const deregisterCodexChild: CodexChildRegistry['deregister'] = defaultRegistry.deregister
export const snapshotCodexChildren: CodexChildRegistry['snapshot'] = defaultRegistry.snapshot
export const reapSync: CodexChildRegistry['reapSync'] = defaultRegistry.reapSync
export const installCodexChildExitHandlers: CodexChildRegistry['installExitHandlers'] =
  defaultRegistry.installExitHandlers
