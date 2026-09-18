import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ProcessRecord {
  pid: number
  parentPid: number
  commandLine: string
}

export interface CommandResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
}

type CommandRunner = (command: string, args: readonly string[]) => CommandResult

export interface ReadProcessSnapshotOptions {
  /**
   * Root of the Linux process table used by the spawn-free /proc fallback
   * (`<pid>/stat` for ppid, `<pid>/cmdline` for args). Default `/proc`;
   * unit tests point this at a fabricated proc tree.
   */
  procRoot?: string
  /** Delay between `ps` retry attempts. Default 250ms. */
  retryDelayMs?: number
  /**
   * Synchronous sleep between retries, injectable for tests. The public API
   * is synchronous (callers poll it in synchronous loops), so the default
   * parks the thread via Atomics.wait instead of busy-waiting.
   */
  sleep?: (ms: number) => void
}

/** 1 initial attempt + 3 bounded retries of the `ps` read. */
const PS_RETRIES = 3
const PS_RETRY_DELAY_MS = 250

function runCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function parsePositiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function commandExecutable(commandLine: string): string {
  const normalized = commandLine.replaceAll('\0', ' ').trim()
  if (!normalized) return ''

  if (normalized.startsWith('"')) {
    const closingQuote = normalized.indexOf('"', 1)
    return closingQuote === -1 ? normalized.slice(1) : normalized.slice(1, closingQuote)
  }

  return normalized.split(/\s+/, 1)[0] ?? ''
}

/**
 * Test the executable identity, rather than a substring anywhere in argv.
 * This keeps the source-runtime smoke test tied to the release artifact that
 * it is meant to start, including the `.exe` suffix used on Windows.
 */
export function isReleaseServerCommand(commandLine: string, platform: NodeJS.Platform): boolean {
  const executable = commandExecutable(commandLine).replaceAll('\\', '/')
  if (!executable) return false

  const normalized = platform === 'win32' ? executable.toLowerCase() : executable
  const suffix = platform === 'win32'
    ? 'target/release/freshell-server.exe'
    : 'target/release/freshell-server'

  return normalized === suffix || normalized.endsWith(`/${suffix}`)
}

/**
 * Return only descendants of the supplied owner, following every wrapper
 * process between npm and the Rust server. The owner itself is never returned.
 */
export function descendantPids(ownerPid: number, records: readonly ProcessRecord[]): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const record of records) {
    const children = childrenByParent.get(record.parentPid) ?? []
    children.push(record.pid)
    childrenByParent.set(record.parentPid, children)
  }

  const descendants: number[] = []
  const visited = new Set<number>([ownerPid])
  const queue = [ownerPid]
  while (queue.length > 0) {
    const parentPid = queue.shift()!
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue
      visited.add(childPid)
      descendants.push(childPid)
      queue.push(childPid)
    }
  }
  return descendants
}

/** Find the exact release server process owned by an npm-start process tree. */
export function findReleaseServerPid(
  ownerPid: number,
  records: readonly ProcessRecord[],
  platform: NodeJS.Platform,
): number | undefined {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  return descendantPids(ownerPid, records)
    .map((pid) => byPid.get(pid))
    .find((record): record is ProcessRecord => record !== undefined && isReleaseServerCommand(record.commandLine, platform))
    ?.pid
}

function parsePosixSnapshot(stdout: string): ProcessRecord[] {
  const records: ProcessRecord[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/)
    if (!match) continue
    const pid = parsePositiveInteger(match[1])
    const parentPid = parsePositiveInteger(match[2])
    if (pid === undefined || parentPid === undefined) continue
    records.push({ pid, parentPid, commandLine: match[3] ?? '' })
  }
  return records
}

function parseWindowsSnapshot(stdout: string): ProcessRecord[] {
  if (!stdout.trim()) return []
  const parsed: unknown = JSON.parse(stdout)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const records: ProcessRecord[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const pid = parsePositiveInteger(value.ProcessId)
    const parentPid = parsePositiveInteger(value.ParentProcessId)
    if (pid === undefined || parentPid === undefined) continue
    records.push({
      pid,
      parentPid,
      commandLine: typeof value.CommandLine === 'string' ? value.CommandLine : '',
    })
  }
  return records
}

/**
 * Read a process table using commands available on the host OS. The runner is
 * injectable so parsing and Windows behavior remain unit-testable without
 * spawning a shell or depending on a particular CI host.
 *
 * POSIX resilience (kata qesq): `spawnSync ps` allocates stdio pipes backed
 * by AF_UNIX socketpairs, which on WSL2 can exhaust under concurrent spawn
 * churn — every call then fails ENOBUFS and the smoke test terminal-fails
 * while the actual server chain is healthy. The POSIX read therefore (a)
 * retries `ps` a bounded number of times with backoff, and (b) on Linux
 * falls back to a spawn-free `/proc` reader (same `ProcessRecord[]` shape)
 * when `ps` keeps failing. The final error distinguishes "ps failed AND the
 * /proc fallback failed" from a plain failure.
 */
export function readProcessSnapshot(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = runCommand,
  opts: ReadProcessSnapshotOptions = {},
): ProcessRecord[] {
  if (platform === 'win32') {
    const result = runner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ])
    if (result.error || result.status !== 0) {
      throw new Error(`could not read Windows process table: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`)
    }
    return parseWindowsSnapshot(result.stdout ?? '')
  }

  const sleep = opts.sleep ?? defaultRetrySleep
  const retryDelayMs = opts.retryDelayMs ?? PS_RETRY_DELAY_MS
  const attempts = 1 + PS_RETRIES

  let lastPsFailure = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runner('ps', ['-eo', 'pid=,ppid=,args='])
    if (!result.error && result.status === 0) {
      return parsePosixSnapshot(result.stdout ?? '')
    }
    lastPsFailure = describeFailure(result)
    if (attempt < attempts) sleep(retryDelayMs)
  }

  if (platform === 'linux') {
    try {
      return readProcSnapshot(opts.procRoot ?? '/proc')
    } catch (procError) {
      throw new Error(
        `could not read POSIX process table: ps failed after ${attempts} attempts (${lastPsFailure}); ` +
        `/proc fallback also failed: ${errorMessage(procError)}`,
      )
    }
  }

  throw new Error(`could not read POSIX process table: ps failed after ${attempts} attempts (${lastPsFailure})`)
}

function describeFailure(result: CommandResult): string {
  if (result.error?.message) return result.error.message
  const stderr = (result.stderr ?? '').trim()
  if (stderr) return stderr
  return `exit ${result.status}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Park the thread for `ms` without busy-waiting (Node supports this on every thread). */
function defaultRetrySleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readTextIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    // Process vanished mid-scan (or never existed) — skip it.
    return null
  }
}

/** `/proc/<pid>/stat` ppid: field 4, after the comm field's LAST ')' (comm may contain spaces/parens). */
function parseStatPpid(content: string): number | undefined {
  const close = content.lastIndexOf(')')
  if (close < 0) return undefined
  const rest = content.slice(close + 1).trim().split(/\s+/)
  return parsePositiveInteger(rest[1])
}

/** `/proc/<pid>/cmdline`: NUL-separated argv (with a trailing NUL) -> one command line. */
function parseCmdline(content: string): string {
  const argv = content.split('\0')
  while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
  return argv.join(' ')
}

/**
 * Spawn-free /proc snapshot (Linux fallback): `<pid>/stat` supplies the
 * parent pid, `<pid>/cmdline` the arguments. Produces the same
 * `ProcessRecord[]` shape as the `ps` read — including the ps parser's
 * positive-pid filtering, so the two paths stay interchangeable.
 */
function readProcSnapshot(procRoot: string): ProcessRecord[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(procRoot)
  } catch (error) {
    throw new Error(`could not read /proc process table at ${procRoot}: ${errorMessage(error)}`)
  }

  const records: ProcessRecord[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = parsePositiveInteger(entry)
    if (pid === undefined) continue
    const stat = readTextIfPresent(path.join(procRoot, entry, 'stat'))
    if (stat === null) continue
    const parentPid = parseStatPpid(stat)
    if (parentPid === undefined) continue
    const cmdlineRaw = readTextIfPresent(path.join(procRoot, entry, 'cmdline'))
    records.push({ pid, parentPid, commandLine: cmdlineRaw === null ? '' : parseCmdline(cmdlineRaw) })
  }

  records.sort((a, b) => a.pid - b.pid)
  return records
}
