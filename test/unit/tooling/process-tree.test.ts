import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findReleaseServerPid,
  readProcessSnapshot,
  runCommand,
  type CommandResult,
} from '../../../scripts/testing/process-tree.js'

describe('process tree ownership', () => {
  it('finds a release Rust server below a Windows npm wrapper', () => {
    const records = [
      { pid: 4100, parentPid: 4000, commandLine: 'C:\\Program Files\\nodejs\\npm.cmd start' },
      { pid: 4200, parentPid: 4100, commandLine: 'C:\\repo\\node_modules\\.bin\\tsx.cmd scripts/start-rust-server.ts target/release/freshell-server' },
      { pid: 4300, parentPid: 4200, commandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567' },
      { pid: 4400, parentPid: 9999, commandLine: 'C:\\other\\target\\release\\freshell-server.exe --port 9999' },
    ]

    expect(findReleaseServerPid(4000, records, 'win32')).toBe(4300)
  })

  it('parses the Windows process table through the injected command runner', () => {
    const records = readProcessSnapshot('win32', (command, args) => {
      expect(command).toBe('powershell.exe')
      expect(args.join(' ')).toContain('Get-CimInstance Win32_Process')
      return {
        status: 0,
        stdout: JSON.stringify({
          ProcessId: 4300,
          ParentProcessId: 4200,
          CommandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567',
        }),
      }
    })

    expect(records).toEqual([{
      pid: 4300,
      parentPid: 4200,
      commandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567',
    }])
  })
})

/**
 * POSIX read resilience (kata qesq, corrected diagnosis — fresh-eyes review
 * of b2bbded15): the recorded `spawnSync ps ENOBUFS` failures were NOT
 * "WSL2 AF_UNIX socketpair exhaustion". They were Node's spawnSync default
 * 1 MiB maxBuffer overflowing when the full-table ps output grows past the
 * limit under process churn: spawnSync reports exactly `spawnSync <cmd>
 * ENOBUFS` (status null, child SIGTERM'd) on output overflow — reproduced
 * with `spawnSync head -c 2000000 /dev/zero` → "spawnSync head ENOBUFS".
 * runCommand now passes a 16 MiB maxBuffer, the retry loop retries only
 * genuinely transient spawn errors (never ENOENT-class), and the Linux
 * spawn-free /proc fallback stays as defense-in-depth — observable via a
 * stderr warning. The final error must distinguish "ps failed AND /proc
 * failed".
 */
describe('readProcessSnapshot POSIX resilience (ps output over spawnSync 1 MiB maxBuffer)', () => {
  let tmpRoot = ''
  let procRoot = ''

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-tree-proc-'))
    procRoot = path.join(tmpRoot, 'proc')
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** Write a fabricated `<procRoot>/<pid>/stat` + `cmdline` pair. */
  function writeProcEntry(pid: number, comm: string, ppid: number, argv: readonly string[]): void {
    const dir = path.join(procRoot, String(pid))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'stat'),
      `${pid} (${comm}) S ${ppid} 1 1 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0\n`,
    )
    fs.writeFileSync(path.join(dir, 'cmdline'), argv.length > 0 ? `${argv.join('\0')}\0` : '')
  }

  /** The same npm → wrapper → server chain expressed for both read paths. */
  const treeEntries: ReadonlyArray<{ pid: number; comm: string; ppid: number; argv: readonly string[] }> = [
    { pid: 4100, comm: 'npm', ppid: 4000, argv: ['npm', 'start'] },
    { pid: 4200, comm: 'bash', ppid: 4100, argv: ['/bin/bash', '-c', 'npm start'] },
    { pid: 4300, comm: 'freshell-server', ppid: 4200, argv: ['/repo/target/release/freshell-server', '--port', '4567'] },
    { pid: 4400, comm: 'freshell-server', ppid: 9999, argv: ['/unrelated/target/release/freshell-server', '--port', '9999'] },
    // comm with spaces AND parentheses must not fool the ppid field parse.
    { pid: 4500, comm: 'bash (login)', ppid: 4400, argv: ['bash', '-l'] },
  ]

  const psStdoutForTree = treeEntries
    .map(({ pid, ppid, argv }) => `${pid} ${ppid} ${argv.join(' ')}`)
    .join('\n')

  const expectedTreeRecords = treeEntries.map(({ pid, ppid, argv }) => ({
    pid,
    parentPid: ppid,
    commandLine: argv.join(' '),
  }))

  /**
   * ENOBUFS-shaped spawn failure — the exact error spawnSync reports when
   * output exceeds maxBuffer (the recorded real-world failure mode).
   */
  const enoBufferResult = (): CommandResult => ({
    status: null,
    error: Object.assign(new Error('spawnSync ps ENOBUFS'), { code: 'ENOBUFS' }),
  })

  /** ENOENT-shaped spawn failure — `ps` is not installed; permanent, never retried. */
  const enoentResult = (): CommandResult => ({
    status: null,
    error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }),
  })

  it.skipIf(process.platform === 'win32')(
    'gives spawnSync a 16 MiB maxBuffer: 2 MiB of child output (past the old 1 MiB default) reads clean',
    () => {
      // Real-spawn pin of the corrected mechanism. Without the maxBuffer
      // option this is the reviewer's exact reproduction of the recorded
      // failure: status null, child SIGTERM'd, error "spawnSync head
      // ENOBUFS". A full-table `ps` on a busy host produces exactly this
      // shape once its output passes 1 MiB.
      const result = runCommand('head', ['-c', '2000000', '/dev/zero'])
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout?.length).toBe(2_000_000)
    },
  )

  it('retries transient ps spawn errors (ENOBUFS) once, then reads the same snapshot shape from /proc', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    const calls: Array<{ command: string; args: string }> = []
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', (command, args) => {
      calls.push({ command, args: args.join(' ') })
      return enoBufferResult()
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(calls).toHaveLength(2) // 1 initial attempt + 1 bounded transient retry
    expect(calls.every((call) => call.command === 'ps' && call.args === '-eo pid=,ppid=,args=')).toBe(true)
    expect(sleeps).toEqual([250])
    expect(records).toEqual(expectedTreeRecords)
  })

  it('does not retry permanent ENOENT spawn errors — one attempt, then the /proc fallback', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    const calls: Array<{ command: string; args: string }> = []
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', (command, args) => {
      calls.push({ command, args: args.join(' ') })
      return enoentResult()
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(calls).toEqual([{ command: 'ps', args: '-eo pid=,ppid=,args=' }])
    expect(sleeps).toEqual([])
    expect(records).toEqual(expectedTreeRecords)
  })

  it('stops retrying and uses the ps table once ps succeeds', () => {
    let attempts = 0
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', () => {
      attempts += 1
      return attempts === 1 ? enoBufferResult() : { status: 0, stdout: psStdoutForTree }
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(attempts).toBe(2)
    expect(sleeps).toEqual([250])
    expect(records).toEqual(expectedTreeRecords)
  })

  it('honors the retryDelayMs option between retry attempts', () => {
    let attempts = 0
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', () => {
      attempts += 1
      return attempts === 1 ? enoBufferResult() : { status: 0, stdout: psStdoutForTree }
    }, { procRoot, retryDelayMs: 125, sleep: (ms) => sleeps.push(ms) })

    expect(attempts).toBe(2)
    expect(sleeps).toEqual([125])
    expect(records).toEqual(expectedTreeRecords)
  })

  it('warns on stderr (with the ps failure) when the /proc fallback rescues a failed ps read', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)
    const writes: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })

    try {
      // A healthy ps read never warns.
      const healthy = readProcessSnapshot('linux', () => ({ status: 0, stdout: psStdoutForTree }), {
        procRoot,
        sleep: () => {},
      })
      expect(healthy).toEqual(expectedTreeRecords)
      expect(writes).toEqual([])

      // A rescued read warns exactly once, carrying the last ps failure.
      const rescued = readProcessSnapshot('linux', () => enoentResult(), { procRoot, sleep: () => {} })
      expect(rescued).toEqual(expectedTreeRecords)
      expect(writes).toHaveLength(1)
      expect(writes[0]).toContain('spawnSync ps ENOENT')
      expect(writes[0]).toContain('/proc fallback')
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('skips pids that vanish mid-scan (missing stat or cmdline file)', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)
    // 4600: stat readable, cmdline already gone — exited between the two reads.
    fs.mkdirSync(path.join(procRoot, '4600'), { recursive: true })
    fs.writeFileSync(path.join(procRoot, '4600', 'stat'), `4600 (bash) S 4100 1 1 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0\n`)
    // 4700: cmdline still present, stat gone — reaped before we read it.
    fs.mkdirSync(path.join(procRoot, '4700'), { recursive: true })
    fs.writeFileSync(path.join(procRoot, '4700', 'cmdline'), 'bash\x00-l\x00')

    const records = readProcessSnapshot('linux', () => enoBufferResult(), { procRoot, sleep: () => {} })

    expect(records).toEqual(expectedTreeRecords)
  })

  it('keeps a present-but-empty cmdline as an empty command line (kernel-thread shape)', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)
    writeProcEntry(4800, 'kworker/0:1', 2, [])

    const records = readProcessSnapshot('linux', () => enoBufferResult(), { procRoot, sleep: () => {} })

    expect(records).toEqual([...expectedTreeRecords, { pid: 4800, parentPid: 2, commandLine: '' }])
  })

  it('produces the identical snapshot shape from ps and from the /proc fallback', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    const fromPs = readProcessSnapshot('linux', () => ({ status: 0, stdout: psStdoutForTree }), {
      procRoot,
      sleep: () => {},
    })
    const fromProcFallback = readProcessSnapshot('linux', () => enoBufferResult(), {
      procRoot,
      sleep: () => {},
    })

    expect(fromProcFallback).toEqual(fromPs)
  })

  it('fails with a distinguished error when ps AND the /proc fallback both fail', () => {
    expect(() =>
      readProcessSnapshot('linux', () => enoBufferResult(), {
        procRoot: path.join(tmpRoot, 'proc-that-does-not-exist'),
        sleep: () => {},
      }),
    ).toThrowError(/ps failed after 2 attempts \(spawnSync ps ENOBUFS\).*\/proc fallback also failed/)
  })

  it('off Linux, a failing ps reports only the ps failure (no /proc fallback)', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    expect(() =>
      readProcessSnapshot('darwin', () => enoBufferResult(), { procRoot, sleep: () => {} }),
    ).toThrowError(/ps failed after 2 attempts \(spawnSync ps ENOBUFS\)/)
  })

  it('does not retry or sleep when the first ps read succeeds', () => {
    let attempts = 0
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', () => {
      attempts += 1
      return { status: 0, stdout: psStdoutForTree }
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(attempts).toBe(1)
    expect(sleeps).toEqual([])
    expect(records).toEqual(expectedTreeRecords)
  })
})
