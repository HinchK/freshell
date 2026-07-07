import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { logger } from '../logger.js'
import {
  countCodexQuarantinedRecords,
  hasDueCodexReaperRetries,
  reapOrphanedCodexAppServerSidecars,
  rescanCodexReaperQuarantine,
} from './codex-app-server/runtime.js'

// Stage 1c observability (plan §7.5): one structured `codex-log-db:` line at boot and then hourly,
// plus the hourly retry of pending reaper records and the quarantine rescan trigger.
//
// STRICTLY read-only over codex state: `fs.stat` on the WAL and a `/proc/*/fd` readlink scan. This
// module MUST NOT open the SQLite database and MUST NOT signal any process (I1/I3). Every path is
// try/catch'd: the monitor can never throw, crash the server, or block boot (I4).

export const CODEX_LOG_DB_FILENAME = 'logs_2.sqlite'
/** Warn once the WAL exceeds this size (≈ weeks of margin before the ~5 GB launch-wedge cliff). */
export const CODEX_LOG_DB_WAL_WARN_BYTES = 500 * 1024 * 1024
/** Warn once this many processes hold the log DB open (~2 per pane; normal is tens, not hundreds). */
export const CODEX_LOG_DB_HOLDER_WARN_THRESHOLD = 64
export const CODEX_OBSERVABILITY_INTERVAL_MS = 60 * 60 * 1000

export type CodexObservabilityLogger = {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

const defaultLog: CodexObservabilityLogger = logger.child({ component: 'codex-observability' })

export type CodexReaperMaintenanceOptions = {
  serverInstanceId: string
  metadataDir?: string
  terminateGraceMs?: number
  log?: CodexObservabilityLogger
}

export type CodexObservabilityOptions = CodexReaperMaintenanceOptions & {
  codexHome?: string
  procRoot?: string
  intervalMs?: number
  walWarnBytes?: number
  holderWarnThreshold?: number
  env?: NodeJS.ProcessEnv
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim()
  return fromEnv ? fromEnv : path.join(os.homedir(), '.codex')
}

export function resolveCodexLogDbPath(codexHome: string): string {
  return path.join(codexHome, CODEX_LOG_DB_FILENAME)
}

async function statWalBytes(walPath: string): Promise<number> {
  try {
    return (await fsp.stat(walPath)).size
  } catch {
    return 0 // missing or unreadable WAL reads as empty; the monitor never throws
  }
}

// Counts processes holding the log DB (or its -wal/-shm siblings) open via a read-only /proc fd
// readlink scan. Unreadable fd tables (EACCES, exited mid-scan) are skipped, never fatal.
export async function countCodexLogDbHolders(dbPath: string, procRoot = '/proc'): Promise<number> {
  let entries: string[]
  try {
    entries = await fsp.readdir(procRoot)
  } catch {
    return 0
  }
  let holders = 0
  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return
    const fdDir = path.join(procRoot, entry, 'fd')
    let fds: string[]
    try {
      fds = await fsp.readdir(fdDir)
    } catch {
      return
    }
    for (const fd of fds) {
      let target: string
      try {
        target = await fsp.readlink(path.join(fdDir, fd))
      } catch {
        continue
      }
      if (target === dbPath || target.startsWith(`${dbPath}-`)) {
        holders += 1
        return
      }
    }
  }))
  return holders
}

export type CodexLogDbStatus = {
  walBytes: number
  holders: number
  quarantined: number
  warned: boolean
}

export async function emitCodexLogDbStatus(
  options: Partial<CodexObservabilityOptions> = {},
): Promise<CodexLogDbStatus | null> {
  const log = options.log ?? defaultLog
  try {
    const codexHome = options.codexHome ?? resolveCodexHome(options.env)
    const dbPath = path.resolve(resolveCodexLogDbPath(codexHome))
    const walPath = `${dbPath}-wal`
    const [walBytes, holders, quarantined] = await Promise.all([
      statWalBytes(walPath),
      countCodexLogDbHolders(dbPath, options.procRoot ?? '/proc'),
      countCodexQuarantinedRecords(options.metadataDir),
    ])
    const walWarnBytes = options.walWarnBytes ?? CODEX_LOG_DB_WAL_WARN_BYTES
    const holderWarnThreshold = options.holderWarnThreshold ?? CODEX_LOG_DB_HOLDER_WARN_THRESHOLD
    const warned = walBytes > walWarnBytes || holders > holderWarnThreshold
    const fields = { walBytes, holders, quarantined, walPath, dbPath }
    const message = `codex-log-db: wal_bytes=${walBytes} holders=${holders} quarantined=${quarantined}`
    if (warned) {
      log.warn(fields, message)
    } else {
      log.info(fields, message)
    }
    return { walBytes, holders, quarantined, warned }
  } catch (error) {
    try {
      log.warn({ err: error }, 'codex-log-db observability probe failed')
    } catch {
      // the monitor never throws
    }
    return null
  }
}

// Hourly maintenance (plan §7.3–.5): trigger the quarantine rescan and, when any retry-in-place
// record's time-based backoff window has elapsed (or a quarantined record was just promoted),
// re-run the reaper. The per-boot reap attempt always runs at startup; backoff gates only this
// hourly cadence and the reaper's log escalation.
export async function runCodexReaperMaintenanceTick(options: CodexReaperMaintenanceOptions): Promise<void> {
  const log = options.log ?? defaultLog
  try {
    const { promotedRecords } = await rescanCodexReaperQuarantine(options.metadataDir)
    const due = await hasDueCodexReaperRetries(options.metadataDir)
    if (promotedRecords.length === 0 && !due) return
    await reapOrphanedCodexAppServerSidecars({
      serverInstanceId: options.serverInstanceId,
      ...(options.metadataDir !== undefined ? { metadataDir: options.metadataDir } : {}),
      ...(options.terminateGraceMs !== undefined ? { terminateGraceMs: options.terminateGraceMs } : {}),
    })
  } catch (error) {
    try {
      log.warn({ err: error }, 'codex reaper hourly retry tick failed')
    } catch {
      // the monitor never throws
    }
  }
}

export type CodexObservabilityHandle = { stop(): void }

// Started from server/index.ts at boot. Emits one status line immediately, then hourly on an
// unref()'d interval timer (it can never hold the process open). Fully fail-open.
export function startCodexObservability(options: CodexObservabilityOptions): CodexObservabilityHandle {
  let timer: NodeJS.Timeout | null = null
  const tick = async (): Promise<void> => {
    await emitCodexLogDbStatus(options)
    await runCodexReaperMaintenanceTick(options)
  }
  try {
    void tick()
    timer = setInterval(() => {
      void tick()
    }, options.intervalMs ?? CODEX_OBSERVABILITY_INTERVAL_MS)
    timer.unref()
  } catch (error) {
    try {
      const log = options.log ?? defaultLog
      log.warn({ err: error }, 'failed to start codex observability')
    } catch {
      // the monitor never throws
    }
  }
  return {
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
