// @vitest-environment node
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  startServerProcess,
  stopProcess,
  type LoggerServerProcess,
} from './logger.separation.harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
let TSX_CLI: string | undefined
const DEFAULT_TEST_TIMEOUT_MS = 120_000
// The wait only bounds file-content APPEARANCE (the assertions care about
// which filename was chosen, never about how fast). A cold `tsx` start under
// full-suite shard contention on a shared Cloud Run vCPU exceeded the old 5s
// gate (observed 2026-08-18, execution freshell-vitest-l68jz); unify at 30s.
// Since 2026-08-21 the resolved-path receipt is appended synchronously by
// createLogger(), so marker durability no longer depends on this wait — it
// only covers the stream-routed content lines.
const FILE_CONTENT_TIMEOUT_MS = 30_000
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g
const SOURCE_LOGGER_PROBE = [
  '(async () => {',
  "  process.argv = ['node', 'server/index.ts']",
  "  const { logger } = await import('./server/logger.ts')",
  // Stream-routed, process-specific proof line. Emitted at info level: the
  // tests using this probe already require info enabled because the resolved-
  // path marker is info-gated. No self-exit timer — the child idles until the
  // harness's afterEach stopProcess kills it, so the rotating stream's async
  // open always wins before the proof line must be durable (a timed exit
  // here was the exact exit-before-stream-open race that flaked the marker).
  "  logger.info('stream-write-proof instance=' + (process.env.FRESHELL_LOG_INSTANCE_ID || process.env.FRESHELL_DEBUG_STREAM_INSTANCE || 'unknown'))",
  '})()',
].join('\n')
const DIST_LOGGER_PROBE = [
  '(async () => {',
  "  process.argv = ['node', 'dist/server/index.js']",
  "  const { logger } = await import('./server/logger.ts')",
  "  logger.info('stream-write-proof instance=' + (process.env.FRESHELL_LOG_INSTANCE_ID || process.env.FRESHELL_DEBUG_STREAM_INSTANCE || 'unknown'))",
  '})()',
].join('\n')
const LOG_LEVEL_PROBE = [
  '(async () => {',
  "  const { logger } = await import('./server/logger.ts')",
  "  logger.debug('debug-level file only')",
  "  logger.info('info-level file only')",
  "  logger.warn('warn-level file only')",
  "  logger.error('error-level console and file')",
  '  setTimeout(() => process.exit(0), 50)',
  '})()',
].join('\n')

const activeProcesses: LoggerServerProcess[] = []
const activeLogDirs: string[] = []

function getTSXCLI(): string {
  if (!TSX_CLI) {
    TSX_CLI = require.resolve('tsx/cli')
  }
  return TSX_CLI
}

function parseStartupLogPayload(startupLog: string) {
  const lines = startupLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const noAnsi = line.replace(ANSI_ESCAPE_PATTERN, '')
    try {
      const parsed = JSON.parse(noAnsi)
      if (parsed.msg === 'Resolved debug log path') return parsed
    } catch {
      continue
    }
  }

  const fallbackLine = lines.find((line) => line.includes('Resolved debug log path'))
  if (!fallbackLine) return null

  return {
    debugMode: fallbackLine.match(/debugMode[:=]\s*"?([a-zA-Z-]+)"?/)?.[1],
    debugInstance: fallbackLine.match(/debugInstance[:=]\s*"?([^,"\s]+)"?/)?.[1],
  }
}

beforeAll(() => {
  TSX_CLI = undefined
})

async function withLogDir<T>(fn: (logDir: string) => Promise<T>): Promise<T> {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-issue-134-'))
  activeLogDirs.push(logDir)

  return await fn(logDir)
}

async function cleanupLogDirs() {
  await Promise.all(
    activeLogDirs.map((logDir) => fsp.rm(logDir, { recursive: true, force: true }).catch(() => {})),
  )
  activeLogDirs.length = 0
}

afterEach(async () => {
  await Promise.all(
    activeProcesses.map(async ({ process, stderrLogDir }) => {
      await stopProcess(process)
      await fsp.rm(stderrLogDir, { recursive: true, force: true }).catch(() => {})
    }),
  )
  await cleanupLogDirs()
  activeProcesses.length = 0
})

beforeEach(() => {
  activeProcesses.length = 0
  activeLogDirs.length = 0
})

async function startSourceLoggerProcess(env: NodeJS.ProcessEnv) {
  return await startServerProcess(
    [process.execPath, getTSXCLI(), '-e', SOURCE_LOGGER_PROBE],
    env,
    REPO_ROOT,
  )
}

async function startDistLoggerProcess(env: NodeJS.ProcessEnv) {
  return await startServerProcess(
    [process.execPath, getTSXCLI(), '-e', DIST_LOGGER_PROBE],
    env,
    REPO_ROOT,
  )
}

async function waitForFileContent(filePath: string, pattern: RegExp, timeoutMs = FILE_CONTENT_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastContent = ''

  while (Date.now() < deadline) {
    const content = await fsp.readFile(filePath, 'utf8').catch(() => '')
    if (content) {
      lastContent = content
      if (pattern.test(content)) return content
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 120))
  }

  throw new Error(`Timed out waiting for ${pattern} in ${filePath}. Log: ${lastContent}`)
}

describe('debug log separation', () => {
  it(
    'keeps stdout and stderr error-only while preserving debug file verbosity',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const debugLogPath = path.join(logDir, 'server-debug.jsonl')
        const proc = await startServerProcess(
          [process.execPath, getTSXCLI(), '-e', LOG_LEVEL_PROBE],
          {
            LOG_DEBUG_PATH: debugLogPath,
            NODE_ENV: 'production',
          },
          REPO_ROOT,
        )
        activeProcesses.push(proc)

        const fileContent = await waitForFileContent(debugLogPath, /error-level console and file/)
        const processOutput = readFileSync(proc.stderrLogPath, 'utf8')

        expect(processOutput).toContain('error-level console and file')
        expect(processOutput).not.toContain('Resolved debug log path')
        expect(processOutput).not.toContain('debug-level file only')
        expect(processOutput).not.toContain('info-level file only')
        expect(processOutput).not.toContain('warn-level file only')

        expect(fileContent).toContain('debug-level file only')
        expect(fileContent).toContain('info-level file only')
        expect(fileContent).toContain('warn-level file only')
        expect(fileContent).toContain('error-level console and file')
      })
    },
  )

  it(
    'dist and source launches choose different mode-specific filenames',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const devProc = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'source-mode',
            NODE_ENV: 'production',
          },
        )
        const distProc = await startDistLoggerProcess(
          {
            FRESHELL_DEBUG_STREAM_INSTANCE: 'dist-mode',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(devProc, distProc)

        const devPath = path.join(logDir, 'server-debug.development.source-mode.jsonl')
        const distPath = path.join(logDir, 'server-debug.production.dist-mode.jsonl')
        await waitForFileContent(devPath, /Resolved debug log path/)
        await waitForFileContent(distPath, /Resolved debug log path/)
        // Stream-routed proof: the marker above lands via a synchronous
        // out-of-band append, so it cannot prove the per-process rotating
        // stream actually opened and wrote to this file. Require one record
        // that went through pino's multistream in each destination instead.
        await waitForFileContent(devPath, /stream-write-proof instance=source-mode/)
        await waitForFileContent(distPath, /stream-write-proof instance=dist-mode/)

        expect(devPath).toContain('server-debug.development.source-mode.jsonl')
        expect(distPath).toContain('server-debug.production.dist-mode.jsonl')
        expect(devPath).not.toBe(distPath)
      })
    },
  )

  it(
    'concurrent launches with the same mode keep separate files',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const processA = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'concurrent-a',
            NODE_ENV: 'development',
          },
        )
        const processB = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'concurrent-b',
            NODE_ENV: 'development',
          },
        )
        activeProcesses.push(processA, processB)

        const pathA = path.join(logDir, 'server-debug.development.concurrent-a.jsonl')
        const pathB = path.join(logDir, 'server-debug.development.concurrent-b.jsonl')
        await waitForFileContent(pathA, /Resolved debug log path/)
        await waitForFileContent(pathB, /Resolved debug log path/)
        // Stream-routed proof: each concurrent process must put a record
        // through its own pino multistream, and neither file may contain the
        // other process's record.
        const contentA = await waitForFileContent(pathA, /stream-write-proof instance=concurrent-a/)
        const contentB = await waitForFileContent(pathB, /stream-write-proof instance=concurrent-b/)
        expect(contentA).not.toContain('instance=concurrent-b')
        expect(contentB).not.toContain('instance=concurrent-a')

        expect(pathA).toContain('server-debug.development.concurrent-a.jsonl')
        expect(pathB).toContain('server-debug.development.concurrent-b.jsonl')
        expect(pathA).not.toBe(pathB)
      })
    },
  )

  it(
    'explicit instance settings are respected across launch modes',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const procA = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'alpha',
            NODE_ENV: 'production',
          },
        )
        const procB = await startDistLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_DEBUG_STREAM_INSTANCE: 'ci-run-beta',
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(procA, procB)

        const pathA = path.join(logDir, 'server-debug.development.alpha.jsonl')
        const pathB = path.join(logDir, 'server-debug.production.ci-run-beta.jsonl')
        await waitForFileContent(pathA, /Resolved debug log path/)
        await waitForFileContent(pathB, /Resolved debug log path/)
        // Stream-routed proof: one record through pino's multistream per process.
        await waitForFileContent(pathA, /stream-write-proof instance=alpha/)
        await waitForFileContent(pathB, /stream-write-proof instance=ci-run-beta/)

        expect(pathA).toContain('server-debug.development.alpha.jsonl')
        expect(pathB).toContain('server-debug.production.ci-run-beta.jsonl')
      })
    },
  )

  it(
    'startup logs include resolved debug destination details',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const proc = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_MODE: 'production',
            FRESHELL_LOG_INSTANCE_ID: 'ci-run-1',
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(proc)

        const resolvedPath = path.join(logDir, 'server-debug.production.ci-run-1.jsonl')
        await waitForFileContent(resolvedPath, /Resolved debug log path/)
        expect(resolvedPath).toContain('server-debug.production.ci-run-1.jsonl')

        const startupLog = readFileSync(resolvedPath, 'utf8')
        const startupPayload = parseStartupLogPayload(startupLog)
        expect(startupPayload).not.toBeNull()
        expect(startupPayload).toMatchObject({
          debugMode: 'production',
          debugInstance: 'ci-run-1',
        })
      })
    },
  )

  it(
    'keeps the resolved-path receipt durable when the process exits immediately after import',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        // The red lever: NO post-import timer at all — the child exits on the
        // first macrotask after the import resolves, so rotating-file-stream's
        // async open can never win. Pre-fix this is 100% red on any machine;
        // post-fix the synchronous receipt makes it 100% green.
        const IMMEDIATE_EXIT_PROBE = [
          '(async () => {',
          "  process.argv = ['node', 'server/index.ts']",
          "  await import('./server/logger.ts')",
          '  process.exit(0)',
          '})()',
        ].join('\n')
        const proc = await startServerProcess(
          [process.execPath, getTSXCLI(), '-e', IMMEDIATE_EXIT_PROBE],
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'immediate-exit',
            NODE_ENV: 'development',
            // The harness does not scrub ambient LOG_LEVEL; the marker is
            // info-level, so an operator's LOG_LEVEL=warn would suppress it
            // and keep this test red. Pin the supported default instead.
            LOG_LEVEL: 'debug',
          },
          REPO_ROOT,
        )
        activeProcesses.push(proc)
        const [exitCode] = await once(proc.process, 'exit')

        const markerPath = path.join(logDir, 'server-debug.development.immediate-exit.jsonl')
        const content = await fsp.readFile(markerPath, 'utf8').catch(() => '')
        expect(content).toContain('Resolved debug log path')

        const startupPayload = parseStartupLogPayload(content)
        expect(startupPayload).not.toBeNull()
        expect(startupPayload).toMatchObject({
          debugMode: 'development',
          debugInstance: 'immediate-exit',
        })
        // The child completed the import and reached its explicit exit —
        // not a crash after the synchronous marker write.
        expect(exitCode).toBe(0)
      })
    },
  )
})
