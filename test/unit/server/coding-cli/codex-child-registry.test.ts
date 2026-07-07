import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCodexChildRegistry,
  snapshotCodexChildren,
  type CodexChildEntry,
  type CodexChildProcessLike,
} from '../../../../server/coding-cli/codex-child-registry.js'
import { CodexAppServerRuntime } from '../../../../server/coding-cli/codex-app-server/runtime.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_DIR = path.resolve(__dirname, '../../../../server')
const REGISTRY_SOURCE_PATH = path.join(SERVER_DIR, 'coding-cli', 'codex-child-registry.ts')
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

// Generous startup budget for the real-spawn integration test; mirrors runtime.test.ts (the suite
// runs with fileParallelism, so freshly-spawned sidecars are CPU-starved under load).
const REAL_STARTUP_ATTEMPT_TIMEOUT_MS = 5_000

type FakeProc = CodexChildProcessLike & EventEmitter

function makeFakeProc(pid = 7_777): FakeProc {
  const emitter = new EventEmitter() as FakeProc
  ;(emitter as { pid: number }).pid = pid
  return emitter
}

function statLine(pid: number, pgrp: number): string {
  // pid (comm) state ppid pgrp ... — comm intentionally contains a space + paren to exercise the
  // lastIndexOf(')') parse.
  return `${pid} (no de)s) S 1 ${pgrp} ${pgrp} 0 -1 4194560 100 0 0 0`
}

function makeHarness(overrides: {
  platform?: NodeJS.Platform
  ownPgid?: number | 'unreadable'
  procPid?: number
  files?: Record<string, string>
} = {}) {
  const procPid = overrides.procPid ?? 7_777
  const files = new Map<string, string>(Object.entries(overrides.files ?? {}))
  if (overrides.ownPgid !== 'unreadable') {
    files.set('/proc/self/stat', statLine(procPid, overrides.ownPgid ?? 4_242))
  }
  const kills: Array<{ pid: number; signal: string }> = []
  const readFileSync = vi.fn((filePath: string): Buffer => {
    const content = files.get(filePath)
    if (content === undefined) {
      const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return Buffer.from(content)
  })
  const killSync = vi.fn((pid: number, signal: NodeJS.Signals) => {
    kills.push({ pid, signal })
  })
  const log = { warn: vi.fn() }
  const proc = makeFakeProc(procPid)
  const registry = createCodexChildRegistry({
    platform: overrides.platform ?? 'linux',
    readFileSync,
    killSync,
    proc,
    log,
  })
  return { registry, kills, killSync, readFileSync, log, proc, files }
}

function entry(pid: number, kind: CodexChildEntry['kind'] = 'app-server', pgid = pid): CodexChildEntry {
  return { pid, pgid, kind }
}

describe('codex child registry', () => {
  describe('registration lifecycle', () => {
    it('registers, snapshots, and deregisters entries', () => {
      const { registry } = makeHarness()
      registry.register(entry(100, 'app-server'))
      registry.register(entry(200, 'resume-pty'))

      expect(registry.snapshot()).toEqual([
        { pid: 100, pgid: 100, kind: 'app-server' },
        { pid: 200, pgid: 200, kind: 'resume-pty' },
      ])

      expect(registry.deregister(100)).toBe(true)
      expect(registry.snapshot()).toEqual([{ pid: 200, pgid: 200, kind: 'resume-pty' }])
      expect(registry.deregister(100)).toBe(false)
    })

    it('is safe to double-register the same pid (latest registration wins)', () => {
      const { registry } = makeHarness()
      registry.register(entry(100, 'app-server'))
      registry.register({ pid: 100, pgid: 100, kind: 'resume-pty' })

      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'resume-pty' }])
    })

    it('refuses invalid pids and pgids (never track -1/0/1)', () => {
      const { registry, log } = makeHarness()
      registry.register({ pid: 0, pgid: 100, kind: 'app-server' })
      registry.register({ pid: -3, pgid: 100, kind: 'app-server' })
      registry.register({ pid: 1.5, pgid: 100, kind: 'app-server' })
      registry.register({ pid: 100, pgid: -1, kind: 'app-server' })
      registry.register({ pid: 100, pgid: 0, kind: 'app-server' })
      registry.register({ pid: 100, pgid: 1, kind: 'app-server' })

      expect(registry.snapshot()).toEqual([])
      expect(log.warn).toHaveBeenCalledTimes(6)
    })

    it('snapshot returns copies (mutation cannot corrupt the registry)', () => {
      const { registry } = makeHarness()
      registry.register(entry(100))
      const snap = registry.snapshot()
      snap[0].pgid = -1
      snap.pop()
      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
    })
  })

  describe('reapSync', () => {
    it('SIGKILLs only registered entries whose /proc identity still looks like codex', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/100/cmdline', '/usr/local/bin/codex\0resume\0abc\0')
      // pid 200 has no /proc entry (already gone); pid 300 was reused by a non-codex process.
      files.set('/proc/300/cmdline', '/bin/bash\0')
      registry.register(entry(100, 'app-server'))
      registry.register(entry(200, 'resume-pty'))
      registry.register(entry(300, 'resume-pty'))

      registry.reapSync()

      expect(kills).toEqual([{ pid: -100, signal: 'SIGKILL' }])
      // The pass drains the registry: a second reap is a no-op.
      expect(registry.snapshot()).toEqual([])
      registry.reapSync()
      expect(kills).toHaveLength(1)
    })

    it('never signals our own process group or our own pid group', () => {
      const { registry, kills, files } = makeHarness({ ownPgid: 4_242, procPid: 7_777 })
      files.set('/proc/555/cmdline', 'codex\0')
      files.set('/proc/556/cmdline', 'codex\0')
      registry.register({ pid: 555, pgid: 4_242, kind: 'app-server' }) // own pgid
      registry.register({ pid: 556, pgid: 7_777, kind: 'app-server' }) // our pid's group

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('signals nothing when our own pgid cannot be proven', () => {
      const { registry, kills, files } = makeHarness({ ownPgid: 'unreadable' })
      files.set('/proc/100/cmdline', 'codex\0')
      registry.register(entry(100))

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('is a no-op on win32 (register/deregister still track)', () => {
      const { registry, kills, readFileSync } = makeHarness({ platform: 'win32' })
      registry.register(entry(100))

      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
      registry.reapSync()
      expect(kills).toEqual([])
      expect(readFileSync).not.toHaveBeenCalled()
      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
    })

    it('never throws out of the exit path and keeps reaping after a kill failure', () => {
      const { registry, killSync, kills, files } = makeHarness()
      files.set('/proc/100/cmdline', 'codex\0')
      files.set('/proc/200/cmdline', 'codex\0')
      killSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      })
      registry.register(entry(100))
      registry.register(entry(200))

      expect(() => registry.reapSync()).not.toThrow()
      // First kill threw; the second entry was still processed.
      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })
  })

  describe('installExitHandlers', () => {
    it("binds 'exit' to reapSync itself, routes SIGHUP to shutdown, and observes uncaught exceptions", () => {
      const { registry, proc, log } = makeHarness()
      const requestShutdown = vi.fn()

      registry.installExitHandlers({ requestShutdown })

      expect(proc.listeners('exit')).toEqual([registry.reapSync])
      expect(proc.listenerCount('SIGHUP')).toBe(1)
      expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1)

      proc.emit('SIGHUP')
      expect(requestShutdown).toHaveBeenCalledExactlyOnceWith('SIGHUP')

      proc.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException')
      expect(log.warn).toHaveBeenCalledTimes(1)
      // Observe-only: the monitor must not trigger shutdown or reap.
      expect(requestShutdown).toHaveBeenCalledTimes(1)
    })

    it('is idempotent (double install binds once)', () => {
      const { registry, proc } = makeHarness()
      registry.installExitHandlers({ requestShutdown: vi.fn() })
      registry.installExitHandlers({ requestShutdown: vi.fn() })

      expect(proc.listenerCount('exit')).toBe(1)
      expect(proc.listenerCount('SIGHUP')).toBe(1)
      expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1)
    })
  })

  describe('structural I3 assertion (plan §6 acceptance #2)', () => {
    const source = fs.readFileSync(REGISTRY_SOURCE_PATH, 'utf8')

    it('the group-kill primitive is the only negative-pid signal and has exactly one caller: reapSync', () => {
      // Exactly one negative-pid kill in the module, and it lives inside killProcessGroupSync.
      const negativeKills = source.match(/killSync\(\s*-/g) ?? []
      expect(negativeKills).toHaveLength(1)
      expect(source.match(/process\.kill\(\s*-/g)).toBeNull()

      const primitiveBody = source.slice(
        source.indexOf('function killProcessGroupSync'),
        source.indexOf('function reapSync'),
      )
      expect(primitiveBody).toContain("killSync(-pgid, 'SIGKILL')")

      // killProcessGroupSync appears exactly twice: its definition and its single call site…
      const references = source.match(/killProcessGroupSync\(/g) ?? []
      expect(references).toHaveLength(2)
      // …and the call site is inside reapSync's body.
      const reapBody = source.slice(
        source.indexOf('function reapSync'),
        source.indexOf('function installExitHandlers'),
      )
      expect(reapBody.match(/killProcessGroupSync\(/g)).toHaveLength(1)
    })

    it("reapSync is never invoked directly and is referenced only by the 'exit' binding", () => {
      // No direct invocation anywhere in the module (the definition is the only `reapSync(` token).
      const invocations = source.match(/(?<!function )reapSync\(/g) ?? []
      expect(invocations).toEqual([])
      // Exactly one handler registration passes reapSync, and it is the 'exit' binding.
      expect(source.match(/,\s*reapSync\)/g)).toHaveLength(1)
      expect(source).toContain("proc.on('exit', reapSync)")
    })

    it('no other server module invokes reapSync', () => {
      const offenders: string[] = []
      const walk = (dir: string): void => {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, dirent.name)
          if (dirent.isDirectory()) {
            if (dirent.name === 'node_modules') continue
            walk(fullPath)
            continue
          }
          if (!dirent.name.endsWith('.ts')) continue
          if (fullPath === REGISTRY_SOURCE_PATH) continue
          const content = fs.readFileSync(fullPath, 'utf8')
          // Invocation, or importing the exported reapSync binding (comments may legitimately
          // *mention* reapSync when documenting the exit path).
          const invokes = /\breapSync\(/.test(content)
          const importsBinding = /\{[^}]*\breapSync\b[^}]*\}\s*from\s*'[^']*codex-child-registry/.test(content)
          if (invokes || importsBinding) {
            offenders.push(fullPath)
          }
        }
      }
      walk(SERVER_DIR)
      expect(offenders).toEqual([])
    })
  })

  describe('wiring (source-level)', () => {
    it('runtime.ts registers at spawn and deregisters only on confirmed group death', () => {
      const runtimeSource = fs.readFileSync(path.join(SERVER_DIR, 'coding-cli', 'codex-app-server', 'runtime.ts'), 'utf8')
      expect(runtimeSource).toContain("registerCodexChild({ pid: child.pid, pgid: child.pid, kind: 'app-server' })")
      // Deregistration is gated on teardownOwnedProcessGroup's confirmed-death result…
      expect(runtimeSource).toContain('if (confirmedGone) deregisterCodexChild(ownership.metadata.wrapperPid)')
      // …and the wrapper-exit handler does NOT deregister (grandchildren can outlive the wrapper).
      const wrapperExitBody = runtimeSource.slice(
        runtimeSource.indexOf('private attachChildExitHandler'),
        runtimeSource.indexOf('private async stopActiveChild'),
      )
      expect(wrapperExitBody).not.toContain('deregisterCodexChild')
    })

    it('terminal-registry.ts registers codex ptys at both spawn sites and deregisters in onExit', () => {
      const registrySource = fs.readFileSync(path.join(SERVER_DIR, 'terminal-registry.ts'), 'utf8')
      const registrations = registrySource.match(
        /registerCodexChild\(\{ pid: ptyProc\.pid, pgid: ptyProc\.pid, kind: 'resume-pty' \}\)/g,
      ) ?? []
      expect(registrations).toHaveLength(2)
      // The primary spawn site registers codex panes only.
      expect(registrySource).toContain("if (opts.mode === 'codex' && ptyProc.pid) {")
      // Both spawn-site onExit handlers deregister; kill() never does (it only sends a signal).
      const deregistrations = registrySource.match(/deregisterCodexChild\(ptyProc\.pid\)/g) ?? []
      expect(deregistrations).toHaveLength(2)
      const killBody = registrySource.slice(
        registrySource.indexOf('kill(terminalId: string'),
        registrySource.indexOf('private markCodexRecoveryFinalClose'),
      )
      expect(killBody).not.toContain('deregisterCodexChild')
    })

    it('index.ts installs the bindings once and arms an unref()d 15s hard-exit timer in shutdown()', () => {
      const indexSource = fs.readFileSync(path.join(SERVER_DIR, 'index.ts'), 'utf8')
      expect(indexSource.match(/installCodexChildExitHandlers\(\{/g)).toHaveLength(1)
      expect(indexSource).toContain('const SHUTDOWN_HARD_EXIT_TIMEOUT_MS = 15_000')
      expect(indexSource).toContain('hardExitTimer.unref()')
      expect(indexSource).toContain('process.exit(1)\n    }, SHUTDOWN_HARD_EXIT_TIMEOUT_MS)')
    })
  })
})

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('codex child registry runtime integration', () => {
  const runtimes = new Set<CodexAppServerRuntime>()
  const tempDirs = new Set<string>()

  afterEach(async () => {
    await Promise.all([...runtimes].map(async (runtime) => {
      runtimes.delete(runtime)
      await runtime.shutdown()
    }))
    await Promise.all([...tempDirs].map(async (dir) => {
      tempDirs.delete(dir)
      await fsp.rm(dir, { recursive: true, force: true })
    }))
  })

  it('registers the app-server group at spawn and deregisters on confirmed teardown', async () => {
    const metadataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-child-registry-'))
    tempDirs.add(metadataDir)
    const runtime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_SERVER_PATH],
      metadataDir,
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
    })
    runtimes.add(runtime)

    const ready = await runtime.ensureReady()

    expect(snapshotCodexChildren()).toContainEqual({
      pid: ready.processPid,
      pgid: ready.processPid,
      kind: 'app-server',
    })

    await runtime.shutdown()

    expect(snapshotCodexChildren().some((child) => child.pid === ready.processPid)).toBe(false)
  })
})
