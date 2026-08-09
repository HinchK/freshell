import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureHostListeningPorts,
  captureResourceSnapshot,
} from './leak-metrics.js'

/**
 * HARNESS-12 — unit tests for the leak/resource measurement collector.
 *
 * The collector is fixture-driven: every test builds a fabricated /proc tree
 * in a tmp dir and points `procRoot` at it, so the stat/status/fd/net parsing,
 * descendant discovery, and LISTEN-port attribution are all proven without
 * spawning processes or touching the host's real /proc (except the marked
 * real-wiring proofs at the bottom, which read only THIS test process and
 * processes it spawns itself).
 */

let tmpRoot = ''

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'leak-metrics-proc-'))
})

afterEach(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

/** Write `<procRoot>/<pid>/stat` with the given comm state ppid. */
function writeStat(procRoot: string, pid: number, comm: string, state: string, ppid: number): void {
  const dir = path.join(procRoot, String(pid))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'stat'),
    `${pid} (${comm}) ${state} ${ppid} 1 1 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0\n`,
  )
}

function writeStatus(procRoot: string, pid: number, fields: { rssKb?: number; threads?: number }): void {
  const dir = path.join(procRoot, String(pid))
  fs.mkdirSync(dir, { recursive: true })
  const lines = [`Name:\tproc-${pid}`]
  if (fields.rssKb !== undefined) lines.push(`VmRSS:\t${fields.rssKb} kB`)
  if (fields.threads !== undefined) lines.push(`Threads:\t${fields.threads}`)
  fs.writeFileSync(path.join(dir, 'status'), lines.join('\n') + '\n')
}

/** Create `<procRoot>/<pid>/fd/<name>`; sockets become real `socket:[inode]` symlinks. */
function writeFds(procRoot: string, pid: number, fds: Record<string, { socketInode?: string }>): void {
  const fdDir = path.join(procRoot, String(pid), 'fd')
  fs.mkdirSync(fdDir, { recursive: true })
  for (const [name, meta] of Object.entries(fds)) {
    const p = path.join(fdDir, name)
    if (meta.socketInode) {
      fs.symlinkSync(`socket:[${meta.socketInode}]`, p)
    } else {
      fs.writeFileSync(p, '')
    }
  }
}

/** Write a proc-style net table. Rows: [localHex, st, txHex, rxHex, inode]. */
function writeNetTable(procRoot: string, table: 'tcp' | 'tcp6', rows: Array<[string, string, string, string, string]>): void {
  const netDir = path.join(procRoot, 'net')
  fs.mkdirSync(netDir, { recursive: true })
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const body = rows.map((row, i) =>
    `   ${i}: ${row[0]} 00000000:0000 ${row[1]} ${row[2]}:${row[3]} 00:00000000 00000000  1000     0 ${row[4]} 1 0000000000000000 100 0 0 10 0`,
  )
  fs.writeFileSync(path.join(netDir, table), [header, ...body, ''].join('\n'))
}

describe('captureResourceSnapshot (fixture /proc)', () => {
  it('discovers the root and its full descendant tree, excluding unrelated and ghosted pids', () => {
    writeStat(tmpRoot, 1000, 'freshell-server', 'S', 1)
    writeStat(tmpRoot, 1001, 'compile (worker)', 'S', 1000)
    writeStat(tmpRoot, 1002, 'sleep', 'S', 1001)
    writeStat(tmpRoot, 2000, 'unrelated', 'S', 9)
    // Ghost: numeric dir with NO stat file (vanished mid-scan) must be excluded, not crash.
    fs.mkdirSync(path.join(tmpRoot, '2001'))

    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })

    expect(snap.rootPids).toEqual([1000])
    expect(snap.processes.map((p) => p.pid)).toEqual([1000, 1001, 1002])
    expect(snap.processCount).toBe(3)
  })

  it('parses comm containing spaces and parentheses, plus state and ppid', () => {
    writeStat(tmpRoot, 1000, 'server', 'S', 1)
    writeStat(tmpRoot, 1001, 'bash (login)', 'R', 1000)

    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })
    const child = snap.processes.find((p) => p.pid === 1001)

    expect(child).toBeDefined()
    expect(child!.comm).toBe('bash (login)')
    expect(child!.state).toBe('R')
    expect(child!.ppid).toBe(1000)
  })

  it('reads RSS (kB → bytes) and Threads from status; null when status is absent', () => {
    writeStat(tmpRoot, 1000, 'server', 'S', 1)
    writeStatus(tmpRoot, 1000, { rssKb: 51200, threads: 8 })
    writeStat(tmpRoot, 1001, 'worker', 'S', 1000)
    writeStatus(tmpRoot, 1001, { rssKb: 2048, threads: 1 })
    writeStat(tmpRoot, 1002, 'quiet', 'S', 1001) // no status file at all

    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })

    expect(snap.processes.find((p) => p.pid === 1000)!.rssBytes).toBe(51200 * 1024)
    expect(snap.processes.find((p) => p.pid === 1000)!.threads).toBe(8)
    expect(snap.processes.find((p) => p.pid === 1001)!.rssBytes).toBe(2048 * 1024)
    const quiet = snap.processes.find((p) => p.pid === 1002)!
    expect(quiet.rssBytes).toBeNull()
    expect(quiet.threads).toBeNull()
    // Totals sum only the readable values.
    expect(snap.totalRssBytes).toBe((51200 + 2048) * 1024)
    expect(snap.totalThreads).toBe(9)
  })

  it('counts fds, attributes LISTEN ports from tcp and tcp6, and attributes ESTABLISHED queue bytes', () => {
    writeStat(tmpRoot, 1000, 'server', 'S', 1)
    writeStatus(tmpRoot, 1000, { rssKb: 1024, threads: 1 })
    writeFds(tmpRoot, 1000, {
      0: {}, 1: {}, 2: {},
      10: { socketInode: '12345' }, // LISTEN 8080 (tcp)
      11: { socketInode: '12346' }, // ESTABLISHED, tx 0x40 / rx 0x80
      12: { socketInode: '12347' }, // LISTEN 9000 (tcp6)
    })
    writeStat(tmpRoot, 1001, 'shell', 'S', 1000)
    writeFds(tmpRoot, 1001, {})
    writeStat(tmpRoot, 1002, 'gone-fd', 'S', 1001) // no fd dir at all -> fdCount null
    writeNetTable(tmpRoot, 'tcp', [
      ['0100007F:1F90', '0A', '00000000', '00000000', '12345'],
      ['0100007F:1F90', '01', '00000040', '00000080', '12346'],
      ['0100007F:270F', '0A', '00000000', '00000000', '99999'], // NOT owned by any fd: attributed nowhere
    ])
    writeNetTable(tmpRoot, 'tcp6', [
      ['00000000000000000000000001000000:2328', '0A', '00000000', '00000000', '12347'],
    ])

    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })

    const root = snap.processes.find((p) => p.pid === 1000)!
    expect(root.fdCount).toBe(6)
    expect(root.listeningPorts).toEqual([8080, 9000])
    expect(root.socketQueue).toEqual({ rxBytes: 0x80, txBytes: 0x40 })

    expect(snap.processes.find((p) => p.pid === 1001)!.fdCount).toBe(0)
    expect(snap.processes.find((p) => p.pid === 1001)!.listeningPorts).toEqual([])
    expect(snap.processes.find((p) => p.pid === 1002)!.fdCount).toBeNull()

    // Snapshot-level unions/totals.
    expect(snap.listeningPorts).toEqual([8080, 9000])
    expect(snap.totalFdCount).toBe(6)
    expect(snap.totalSocketQueue).toEqual({ rxBytes: 0x80, txBytes: 0x40 })
    // processes sorted by pid
    expect(snap.processes.map((p) => p.pid)).toEqual([1000, 1001, 1002])
    expect(snap.capturedAt).toBeTruthy()
  })

  it('dedupes a LISTEN port reported in both tcp and tcp6 tables', () => {
    writeStat(tmpRoot, 1000, 'server', 'S', 1)
    writeFds(tmpRoot, 1000, { 10: { socketInode: '555' } })
    writeNetTable(tmpRoot, 'tcp', [['0100007F:1F90', '0A', '00000000', '00000000', '555']])
    writeNetTable(tmpRoot, 'tcp6', [['00000000000000000000000001000000:1F90', '0A', '00000000', '00000000', '555']])
    // Same inode in both tables must collapse to one attribution.

    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })
    expect(snap.listeningPorts).toEqual([8080])
  })

  it('copes with a missing net table (tcp6 absent) and a missing roots case', () => {
    writeStat(tmpRoot, 1000, 'server', 'S', 1)
    writeNetTable(tmpRoot, 'tcp', [['0100007F:1F90', '0A', '00000000', '00000000', '555']])
    // fd never links inode 555, so nothing is attributed; no crash on absent tcp6.
    const snap = captureResourceSnapshot([1000], { procRoot: tmpRoot })
    expect(snap.listeningPorts).toEqual([])

    // A root pid that does not exist at all snapshots to an empty tree.
    expect(captureResourceSnapshot([424242], { procRoot: tmpRoot }).processCount).toBe(0)
  })
})

describe('captureHostListeningPorts (fixture /proc)', () => {
  it('returns the sorted deduped union of LISTEN ports across tcp+tcp6 regardless of ownership', () => {
    writeNetTable(tmpRoot, 'tcp', [
      ['0100007F:1F90', '0A', '00000000', '00000000', '1'], // 8080
      ['0100007F:0BB8', '01', '00000000', '00000000', '2'], // 3000 ESTABLISHED -> excluded
    ])
    writeNetTable(tmpRoot, 'tcp6', [
      ['00000000000000000000000001000000:2328', '0A', '00000000', '00000000', '3'], // 9000
    ])
    expect(captureHostListeningPorts({ procRoot: tmpRoot })).toEqual([8080, 9000])
  })
})
