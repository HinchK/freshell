import { afterEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_LOG_DB_WAL_WARN_BYTES,
  countCodexLogDbHolders,
  emitCodexLogDbStatus,
  resolveCodexHome,
  runCodexReaperMaintenanceTick,
  startCodexObservability,
} from '../../../../server/coding-cli/codex-observability.js'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    tempDirs.delete(dir)
    await fsp.rm(dir, { recursive: true, force: true })
  }))
})

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-obs-'))
  tempDirs.add(dir)
  return dir
}

function createLogSpy() {
  return { info: vi.fn(), warn: vi.fn() }
}

async function makeCodexHomeFixture(walBytes: number): Promise<{ codexHome: string; dbPath: string; walPath: string }> {
  const codexHome = await makeTempDir()
  const dbPath = path.join(codexHome, 'logs_2.sqlite')
  const walPath = `${dbPath}-wal`
  await fsp.writeFile(dbPath, 'not-a-real-db')
  await fsp.writeFile(walPath, Buffer.alloc(walBytes))
  return { codexHome, dbPath, walPath }
}

// Builds a fake /proc root: each key is a pid whose fd dir contains symlinks to the given targets.
async function makeProcFixture(pidFdTargets: Record<string, string[]>): Promise<string> {
  const procRoot = await makeTempDir()
  for (const [pid, targets] of Object.entries(pidFdTargets)) {
    const fdDir = path.join(procRoot, pid, 'fd')
    await fsp.mkdir(fdDir, { recursive: true })
    for (const [index, target] of targets.entries()) {
      await fsp.symlink(target, path.join(fdDir, String(index + 3)))
    }
  }
  await fsp.mkdir(path.join(procRoot, 'not-a-pid'), { recursive: true })
  return procRoot
}

function buildValidOwnershipRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    ownershipId: 'obs-pending',
    serverInstanceId: 'srv-previous',
    ownerServerPid: 999_999_999,
    terminalId: null,
    generation: null,
    wsUrl: 'ws://127.0.0.1:1',
    wrapperPid: 999_999_998,
    processGroupId: 999_999_997,
    wrapperIdentity: { commandLine: ['codex'], cwd: '/tmp', startTimeTicks: 1 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('codex-observability resolveCodexHome', () => {
  it('resolves the codex home from CODEX_HOME or falls back to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/custom/home' } as NodeJS.ProcessEnv)).toBe('/custom/home')
    expect(resolveCodexHome({ CODEX_HOME: '  ' } as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'))
    expect(resolveCodexHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'))
  })

  it('keeps the documented 500 MB WAL warn threshold', () => {
    expect(CODEX_LOG_DB_WAL_WARN_BYTES).toBe(500 * 1024 * 1024)
  })
})

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('codex-observability monitor', () => {
  it('emits the codex-log-db status line with WAL size, holder count and quarantine count', async () => {
    const { codexHome, dbPath, walPath } = await makeCodexHomeFixture(2048)
    const procRoot = await makeProcFixture({
      '101': ['/tmp/unrelated-file', dbPath],
      '102': [walPath],
      '103': ['/tmp/unrelated-file'],
    })
    const metadataDir = await makeTempDir()
    const quarantineDir = path.join(metadataDir, 'quarantine')
    await fsp.mkdir(quarantineDir, { recursive: true })
    await fsp.writeFile(path.join(quarantineDir, 'stale.json'), '{}')
    await fsp.writeFile(path.join(quarantineDir, 'stale.json.note.json'), '{}')

    const log = createLogSpy()
    const status = await emitCodexLogDbStatus({ codexHome, metadataDir, procRoot, log })

    expect(status).toEqual({ walBytes: 2048, holders: 2, quarantined: 1, warned: false })
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ walBytes: 2048, holders: 2, quarantined: 1 }),
      'codex-log-db: wal_bytes=2048 holders=2 quarantined=1',
    )
  })

  it('warns when wal_bytes exceeds the threshold', async () => {
    const { codexHome } = await makeCodexHomeFixture(4096)
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({}),
      log,
      walWarnBytes: 1024,
    })

    expect(status?.warned).toBe(true)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('warns when the holder count exceeds the threshold', async () => {
    const { codexHome, dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({
      '201': [dbPath],
      '202': [dbPath],
    })
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot,
      log,
      holderWarnThreshold: 1,
    })

    expect(status).toEqual({ walBytes: 0, holders: 2, quarantined: 0, warned: true })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('never throws when the codex home, metadata dir and proc root are all missing', async () => {
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome: '/nonexistent/codex-home',
      metadataDir: '/nonexistent/metadata',
      procRoot: '/nonexistent/proc',
      log,
    })

    expect(status).toEqual({ walBytes: 0, holders: 0, quarantined: 0, warned: false })
  })

  it('holds no file descriptor on the sqlite files after probing (read-only monitor)', async () => {
    const { codexHome, dbPath } = await makeCodexHomeFixture(1024)
    const log = createLogSpy()

    await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({ '301': [dbPath] }),
      log,
    })

    const fds = await fsp.readdir('/proc/self/fd')
    const targets = await Promise.all(fds.map((fd) => fsp.readlink(`/proc/self/fd/${fd}`).catch(() => '')))
    expect(targets.filter((target) => target.startsWith(dbPath))).toEqual([])
  })

  it('ignores unreadable fd directories in the holder scan', async () => {
    const { dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({ '401': [dbPath] })
    // A pid dir without an fd subdirectory (readdir will fail for it).
    await fsp.mkdir(path.join(procRoot, '402'), { recursive: true })

    expect(await countCodexLogDbHolders(dbPath, procRoot)).toBe(1)
  })
})

describeWithLinuxProc('codex-observability reaper maintenance tick', () => {
  it('re-runs the reaper only when a pending record is due under the time-based backoff', async () => {
    const metadataDir = await makeTempDir()
    const recordPath = path.join(metadataDir, 'pending.json')
    await fsp.writeFile(recordPath, JSON.stringify(buildValidOwnershipRecord()), { mode: 0o600 })

    // Not due: the last attempt just happened (interval for a young record is one hour).
    const now = Date.now()
    await fsp.writeFile(`${recordPath}.reaper.json`, JSON.stringify({
      firstSeen: new Date(now - 60_000).toISOString(),
      attempts: 1,
      lastAttempt: new Date(now).toISOString(),
    }), { mode: 0o600 })
    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })
    await expect(fsp.stat(recordPath)).resolves.toBeDefined()

    // Due: the last attempt was two hours ago. The record's owner is dead and its group is gone,
    // so the re-run reaps it exactly like the boot pass would.
    await fsp.writeFile(`${recordPath}.reaper.json`, JSON.stringify({
      firstSeen: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      attempts: 1,
      lastAttempt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    }), { mode: 0o600 })
    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })
    await expect(fsp.stat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never throws when the metadata dir is missing', async () => {
    await expect(runCodexReaperMaintenanceTick({
      serverInstanceId: 'srv-tick',
      metadataDir: '/nonexistent/metadata',
      log: createLogSpy(),
    })).resolves.toBeUndefined()
  })
})

describeWithLinuxProc('codex-observability lifecycle', () => {
  it('emits a boot status line, ticks on the interval, and stop() clears the timer', async () => {
    const { codexHome } = await makeCodexHomeFixture(0)
    const metadataDir = await makeTempDir()
    const log = createLogSpy()

    const handle = startCodexObservability({
      serverInstanceId: 'srv-obs',
      codexHome,
      metadataDir,
      procRoot: await makeProcFixture({}),
      intervalMs: 20,
      log,
    })

    const deadline = Date.now() + 5_000
    while (log.info.mock.calls.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(log.info.mock.calls.length).toBeGreaterThanOrEqual(2)

    handle.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const callsAfterStop = log.info.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(log.info.mock.calls.length).toBe(callsAfterStop)
  })
})
