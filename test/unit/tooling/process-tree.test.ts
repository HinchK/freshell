import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findReleaseServerPid,
  readProcessSnapshot,
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
 * POSIX read resilience (kata qesq): on WSL2, `spawnSync ps` uses stdio pipes
 * backed by AF_UNIX socketpairs; under concurrent spawn churn on a long-uptime
 * VM the socket pool exhausts and EVERY call fails ENOBUFS, terminal-failing
 * the source-runtime smoke while the actual server chain is healthy. The POSIX
 * read must retry with backoff, then fall back to a spawn-free /proc reader,
 * and its final error must distinguish "ps failed AND /proc failed".
 */
describe('readProcessSnapshot POSIX resilience (WSL2 AF_UNIX pool exhaustion)', () => {
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

  /** ENOBUFS-shaped failure exactly like spawnSync's stdio-pipe exhaustion. */
  const enoBufferResult = (): CommandResult => ({
    status: null,
    error: Object.assign(new Error('spawnSync ps ENOBUFS'), { code: 'ENOBUFS' }),
  })

  it('retries ps on ENOBUFS spawn errors, then reads the same snapshot shape from /proc', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    const calls: Array<{ command: string; args: string }> = []
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', (command, args) => {
      calls.push({ command, args: args.join(' ') })
      return enoBufferResult()
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(calls).toHaveLength(4) // 1 initial attempt + 3 bounded retries
    expect(calls.every((call) => call.command === 'ps' && call.args === '-eo pid=,ppid=,args=')).toBe(true)
    expect(sleeps).toEqual([250, 250, 250])
    expect(records).toEqual(expectedTreeRecords)
  })

  it('stops retrying and uses the ps table once ps succeeds', () => {
    let attempts = 0
    const sleeps: number[] = []
    const records = readProcessSnapshot('linux', () => {
      attempts += 1
      return attempts < 3 ? enoBufferResult() : { status: 0, stdout: psStdoutForTree }
    }, { procRoot, sleep: (ms) => sleeps.push(ms) })

    expect(attempts).toBe(3)
    expect(sleeps).toEqual([250, 250])
    expect(records).toEqual(expectedTreeRecords)
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
    ).toThrowError(/ps failed after 4 attempts \(spawnSync ps ENOBUFS\).*\/proc fallback also failed/)
  })

  it('off Linux, a failing ps reports only the ps failure (no /proc fallback)', () => {
    for (const entry of treeEntries) writeProcEntry(entry.pid, entry.comm, entry.ppid, entry.argv)

    expect(() =>
      readProcessSnapshot('darwin', () => enoBufferResult(), { procRoot, sleep: () => {} }),
    ).toThrowError(/ps failed after 4 attempts \(spawnSync ps ENOBUFS\)/)
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
