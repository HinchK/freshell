/**
 * App-bound Electron acceptance: Electron owns one Rust child and does not
 * interfere with another process started from the same binary.
 *
 * This fixture deliberately uses ports allocated by the OS, never the live
 * self-hosted port. The foreign process is stopped by its own captured handle
 * during cleanup.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupElectronFixture,
  closeElectronGracefully,
  stopExactCapturedProcess,
} from './electron-fixture-cleanup.js'
import { cleanupOwnedFixtureHome } from './owned-fixture-home.js'
import { withBoundedFixtureRequest } from './bounded-fixture-request.js'
import { parseSsListeningPidsForPort } from './ss-listener-parser.js'
import { isolatedElectronHomeEnv } from './fixture-home-env.js'
import { launchChooserViteArgs, waitForCapturedViteReady } from './launch-chooser-vite.js'
import { allocateDistinctFixturePorts } from './fixture-ports.js'
import {
  forceStopExactOwnedServerAndVerify,
  isPortFree,
  verifyOwnedServerStopped,
  waitForPidGone,
  type OwnershipProofContext,
  type OwnedServerReceipt,
} from './owned-server-teardown.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const VITE_ROOT = path.join(PROJECT_ROOT, 'node_modules')
const RUST_BINARY = path.join(
  PROJECT_ROOT,
  'target',
  'release',
  process.platform === 'win32' ? 'freshell-server.exe' : 'freshell-server',
)
const CLIENT_DIR = path.join(PROJECT_ROOT, 'dist', 'client')
const OWNERSHIP_COMMAND_TIMEOUT_MS = 1_000

function requireElectronE2eBuildId(): string {
  const buildId = process.env.FRESHELL_ELECTRON_E2E_BUILD_ID
  if (!buildId || !/^[0-9a-f]{40}$/.test(buildId)) {
    throw new Error('Electron E2E requires the exact-client-build preflight; run npm run test:e2e:electron')
  }
  return buildId
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not determine an ephemeral port'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForHealth(port: number, token: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await withBoundedFixtureRequest(
        `http://127.0.0.1:${port}/api/server-info`,
        { headers: { 'x-auth-token': token } },
        { deadline },
        async (response) => ({
          ok: response.ok,
          status: response.status,
          info: response.ok ? ((await response.json()) as Record<string, unknown>) : undefined,
        }),
      )
      if (result.ok && result.info) {
        const info = result.info
        if (info.runtime === 'rust' && typeof info.commit === 'string' && info.commit.length > 0) {
          return info
        }
        lastError = new Error('server-info did not contain Rust build provenance')
      } else {
        lastError = new Error(`server-info returned ${result.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Rust server: ${String(lastError)}`)
}

async function waitForWindowUrl(app: ElectronApplication, pattern: RegExp): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const window of app.windows()) {
      if (!pattern.test(window.url())) continue
      try {
        await window.evaluate(() => true)
        return window
      } catch {
        // The chooser can still be closing while the main window is created.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Electron window matching ${pattern}`)
}

function startLaunchChooserDevServer(port: number): ChildProcess {
  return spawn(process.execPath, [...launchChooserViteArgs(VITE_ROOT, PROJECT_ROOT, port)], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    },
    // Readiness is proved from this exact process's Vite output; do not use
    // a generic HTTP probe that a foreign process could satisfy.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function directChildPids(parentPid: number): number[] {
  const result = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], {
    encoding: 'utf8',
  }) as { status: number; stdout: string }
  if (result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function executablePath(pid: number): string | undefined {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return undefined
  }
}

async function waitForOwnedChild(parentPid: number, expectedBinary: string): Promise<number> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const pid = directChildPids(parentPid).find((candidate) => executablePath(candidate) === expectedBinary)
    if (pid !== undefined) return pid
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Rust child of Electron PID ${parentPid}`)
}

async function waitForCapturedChildExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`captured Electron PID ${child.pid ?? 'unknown'} remained alive after graceful close`)
}

async function stopCapturedFixtureProcess(
  name: string,
  child: ChildProcess,
  port?: number,
): Promise<void> {
  await stopExactCapturedProcess(child, 5_000, (ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  if (port !== undefined && !(await isPortFree(port))) {
    throw new Error(`captured ${name} port ${port} is still bound`)
  }
}

function sameResolvedPath(actual: string, expected: string): boolean {
  try {
    return fs.realpathSync(actual) === fs.realpathSync(expected)
  } catch {
    return false
  }
}

function splitNulSeparatedFile(filePath: string): string[] {
  return fs.readFileSync(filePath).toString('utf8').split('\0').filter(Boolean)
}

/**
 * A PID alone is not stable across a forced-stop wait. Pair it with the
 * kernel-assigned process creation identity and re-read it before every
 * signal so a recycled numeric PID can never receive fixture cleanup.
 */
function assertOwnershipProofActive(context?: OwnershipProofContext): void {
  if (!context) return
  if (context.signal.aborted) throw context.signal.reason
  if (Date.now() >= context.deadline) throw new Error('ownership proof deadline expired')
}

function runBoundedOwnershipCommand(
  command: string,
  args: string[],
  context?: OwnershipProofContext,
): { status: number | null; stdout: string } {
  assertOwnershipProofActive(context)
  const remainingMs = context ? context.deadline - Date.now() : OWNERSHIP_COMMAND_TIMEOUT_MS
  const timeout = Math.min(OWNERSHIP_COMMAND_TIMEOUT_MS, remainingMs)
  if (timeout <= 0) throw new Error('ownership proof deadline expired before external command')
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    killSignal: 'SIGKILL',
  }) as { status: number | null; stdout: string; error?: Error }
  if (result.error || result.status === null) {
    throw new Error(`ownership command ${command} did not settle within ${timeout}ms`, { cause: result.error })
  }
  assertOwnershipProofActive(context)
  return result
}

function processIdentity(pid: number, context?: OwnershipProofContext): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid fixture PID ${pid}`)
  if (process.platform === 'win32') {
    const result = runBoundedOwnershipCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      context,
    )
    const ticks = result.stdout.trim()
    if (result.status !== 0 || !/^\d+$/.test(ticks)) {
      throw new Error(`could not read creation identity for fixture PID ${pid}`)
    }
    return `windows-start:${ticks}`
  }

  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const closeName = stat.lastIndexOf(')')
  const fields = stat.slice(closeName + 1).trim().split(/\s+/)
  // /proc/<pid>/stat begins with fields 3 onward after the closing name;
  // starttime is field 22, therefore index 19 in this suffix.
  const startTime = fields[19]
  if (closeName < 0 || !/^\d+$/.test(startTime ?? '')) {
    throw new Error(`could not read creation identity for fixture PID ${pid}`)
  }
  return `linux-start:${startTime}`
}

function listeningPidsForFixturePort(port: number, context?: OwnershipProofContext): number[] {
  if (process.platform === 'win32') {
    const result = runBoundedOwnershipCommand('netstat', ['-ano', '-p', 'tcp'], context)
    if (result.status !== 0) throw new Error(`could not inspect the exact fixture port ${port} with netstat`)
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') return []
      const localAddress = fields[1]
      if (!localAddress.endsWith(`:${port}`)) return []
      const pid = Number.parseInt(fields.at(-1) ?? '', 10)
      return Number.isInteger(pid) && pid > 0 ? [pid] : []
    })
  }

  const result = runBoundedOwnershipCommand('ss', ['-ltnp'], context)
  if (result.status !== 0) throw new Error(`could not inspect the exact fixture port ${port} with ss`)
  return parseSsListeningPidsForPort(result.stdout, port)
}

async function waitForFixturePortOwner(port: number): Promise<number> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const pids = listeningPidsForFixturePort(port)
    if (pids.length === 1) return pids[0]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out capturing the sole listener on fixture port ${port}`)
}

async function proveAppBoundRustOwnership(
  receipt: OwnedServerReceipt,
  options: {
    binary: string
    configDir: string
    home: string
    clientDir: string
    token: string
  },
  context: OwnershipProofContext,
): Promise<void> {
  assertOwnershipProofActive(context)
  if (!receipt.identity || processIdentity(receipt.pid, context) !== receipt.identity) {
    throw new Error(`captured Rust PID ${receipt.pid} no longer has its recorded process identity`)
  }
  const serverInfo = await withBoundedFixtureRequest(
    `http://127.0.0.1:${receipt.port}/api/server-info`,
    { headers: { 'x-auth-token': options.token } },
    { deadline: context.deadline, signal: context.signal },
    async (response) => {
      if (!response.ok) throw new Error(`fixture Rust server-info returned ${response.status} during ownership proof`)
      return (await response.json()) as Record<string, unknown>
    },
  )
  assertOwnershipProofActive(context)
  if (serverInfo.runtime !== 'rust') throw new Error('fixture port did not serve the expected Rust runtime')

  const listeners = listeningPidsForFixturePort(receipt.port, context)
  if (listeners.length !== 1 || listeners[0] !== receipt.pid) {
    throw new Error(`fixture port ${receipt.port} is not exclusively owned by captured Rust PID ${receipt.pid}`)
  }

  if (process.platform === 'win32') {
    if (processIdentity(receipt.pid, context) !== receipt.identity) {
      throw new Error(`captured Rust PID ${receipt.pid} changed identity during ownership proof`)
    }
    return
  }

  const executable = executablePath(receipt.pid)
  if (!executable || !sameResolvedPath(executable, options.binary)) {
    throw new Error(`captured Rust PID ${receipt.pid} does not run the expected release binary`)
  }
  let cwd: string | undefined
  try {
    cwd = fs.readlinkSync(`/proc/${receipt.pid}/cwd`)
  } catch {
    // The PID may have exited after the exact-port check; let exit and port
    // verification report that state rather than risking a signal.
    throw new Error(`could not inspect captured Rust PID ${receipt.pid} working directory`)
  }
  if (!sameResolvedPath(cwd, options.configDir)) {
    throw new Error(`captured Rust PID ${receipt.pid} does not use the fixture config directory`)
  }
  const argv = splitNulSeparatedFile(`/proc/${receipt.pid}/cmdline`)
  if (argv.length !== 1 || !sameResolvedPath(argv[0], options.binary)) {
    throw new Error(`captured Rust PID ${receipt.pid} does not have the expected release-binary argv`)
  }
  const environment = new Map(
    splitNulSeparatedFile(`/proc/${receipt.pid}/environ`).map((entry) => {
      const separator = entry.indexOf('=')
      return [entry.slice(0, separator), entry.slice(separator + 1)]
    }),
  )
  if (
    environment.get('PORT') !== String(receipt.port) ||
    environment.get('FRESHELL_HOME') !== options.home ||
    environment.get('FRESHELL_CLIENT_DIR') !== options.clientDir
  ) {
    throw new Error(`captured Rust PID ${receipt.pid} does not have the fixture port, HOME, and client environment`)
  }
  if (processIdentity(receipt.pid, context) !== receipt.identity) {
    throw new Error(`captured Rust PID ${receipt.pid} changed identity during ownership proof`)
  }
}

function exactPidProcess(pid: number) {
  return {
    pid,
    isAlive: () => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    },
    signal: (signal: NodeJS.Signals) => process.kill(pid, signal),
  }
}

test.describe('Electron app-bound Rust server', () => {
  test('resolves the launch chooser from this checkout', () => {
    expect(VITE_ROOT).toBe(path.join(PROJECT_ROOT, 'node_modules'))
    expect(fs.existsSync(path.join(VITE_ROOT, 'vite/bin/vite.js'))).toBe(true)
  })

  test('authenticates Rust server-info and stops only its exact child', async () => {
    expect(fs.existsSync(RUST_BINARY)).toBe(true)
    expect(fs.existsSync(CLIENT_DIR)).toBe(true)
    const expectedBuildId = requireElectronE2eBuildId()

    const [appPort, chooserPort, foreignPort] = await allocateDistinctFixturePorts(3, findFreePort)

    const appHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-electron-rust-'))
    const foreignHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-electron-foreign-'))
    const appConfigDir = path.join(appHome, '.freshell')
    const foreignConfigDir = path.join(foreignHome, '.freshell')
    await fsp.mkdir(appConfigDir, { recursive: true })
    await fsp.mkdir(foreignConfigDir, { recursive: true })

    const appToken = `electron-app-bound-${Date.now()}`
    const foreignToken = `electron-foreign-${Date.now()}`
    await fsp.writeFile(path.join(appConfigDir, '.env'), `AUTH_TOKEN=${appToken}\n`)
    await fsp.writeFile(path.join(foreignConfigDir, '.env'), `AUTH_TOKEN=${foreignToken}\n`)
    await fsp.writeFile(
      path.join(appConfigDir, 'desktop.json'),
      JSON.stringify({
        serverMode: 'app-bound',
        port: appPort,
        knownServers: [],
        // Force the chooser so this test starts the configured app-bound server
        // rather than auto-connecting to another developer's local server.
        alwaysAskOnLaunch: true,
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: false,
        minimizeToTray: true,
        setupCompleted: true,
      }),
    )

    let app: ElectronApplication | undefined
    let foreign: ChildProcess | undefined
    let chooserDevServer: ChildProcess | undefined
    let appServerPid: number | undefined
    let appServerReceipt: OwnedServerReceipt | undefined
    let electronProcess: ChildProcess | undefined
    try {
      foreign = spawn(RUST_BINARY, [], {
        cwd: foreignConfigDir,
        env: {
          ...process.env,
          PORT: String(foreignPort),
          AUTH_TOKEN: undefined,
          FRESHELL_HOME: foreignHome,
          FRESHELL_CLIENT_DIR: CLIENT_DIR,
        },
        stdio: 'ignore',
      })
      const foreignInfo = await waitForHealth(foreignPort, foreignToken)
      expect(foreignInfo.commit).toBe(expectedBuildId)
      expect(foreignInfo.buildDirty).toBe(false)

      // In development Electron loads the chooser from Vite. Start only that
      // fixture here; the Rust server serves the main client from disk.
      chooserDevServer = startLaunchChooserDevServer(chooserPort)
      await waitForCapturedViteReady(chooserDevServer, chooserPort)

      app = await electron.launch({
        args: [PROJECT_ROOT],
        cwd: PROJECT_ROOT,
        env: {
          ...isolatedElectronHomeEnv(process.env, appHome),
          ELECTRON_DEV: '1',
          FRESHELL_ELECTRON_TEST_CHOOSER_PORT: String(chooserPort),
          FRESHELL_ELECTRON_TEST_NO_LOCAL_DISCOVERY: '1',
          NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
        },
      })
      electronProcess = app.process()
      const mainPage = await app.firstWindow()
      await mainPage.waitForLoadState('domcontentloaded')
      const chooser = mainPage.getByRole('heading', {
        name: 'Choose Freshell server',
      })
      await expect(chooser).toBeVisible({ timeout: 30_000 })
      await mainPage.getByRole('button', { name: 'Start local' }).click()
      const appPage = await waitForWindowUrl(app, new RegExp(`^http://localhost:${appPort}(?:[/?#]|$)`))
      await appPage.waitForLoadState('domcontentloaded')
      await expect(appPage.locator('text=New Tab').first()).toBeVisible({
        timeout: 30_000,
      })

      const electronPid = app.process().pid
      if (electronPid === undefined) throw new Error('Electron process did not expose a PID')
      const appInfo = await waitForHealth(appPort, appToken)
      expect(appInfo.runtime).toBe('rust')
      expect(appInfo.commit).toBe(expectedBuildId)
      expect(appInfo.buildDirty).toBe(false)
      appServerPid =
        process.platform === 'win32'
          ? await waitForFixturePortOwner(appPort)
          : await waitForOwnedChild(electronPid, RUST_BINARY)
      appServerReceipt = { pid: appServerPid, port: appPort, identity: processIdentity(appServerPid) }

      await closeElectronGracefully(app)
      await waitForCapturedChildExit(electronProcess)
      app = undefined
      await verifyOwnedServerStopped(appServerReceipt)

      // The same-path foreign Rust server must remain available after the app
      // closes. Cleanup below stops it through its captured ChildProcess.
      await expect
        .poll(async () => {
          try {
            return await withBoundedFixtureRequest(
              `http://127.0.0.1:${foreignPort}/api/health`,
              undefined,
              {},
              (response) => response.ok,
            )
          } catch {
            return false
          }
        })
        .toBe(true)
    } finally {
      const failures: Error[] = []
      try {
        await cleanupElectronFixture({
          app,
          electronProcess,
          stopServer: async ({ gracefulCloseFailed }) => {
            if (!appServerReceipt) {
              if (!(await isPortFree(appPort)))
                throw new Error(`Electron app-owned Rust port ${appPort} is still bound without an ownership receipt`)
              return
            }
            if (gracefulCloseFailed) {
              await forceStopExactOwnedServerAndVerify(exactPidProcess(appServerReceipt.pid), appServerReceipt, {
                proveOwnership: (receipt, context) =>
                  proveAppBoundRustOwnership(receipt, {
                    binary: RUST_BINARY,
                    configDir: appConfigDir,
                    home: appHome,
                    clientDir: CLIENT_DIR,
                    token: appToken,
                  }, context),
                waitForPidGone,
                isPortFree,
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              })
              return
            }
            await verifyOwnedServerStopped(appServerReceipt)
          },
          removeHome: () => fsp.rm(appHome, { recursive: true, force: true }),
        })
      } catch (error) {
        failures.push(error as Error)
      }
      if (chooserDevServer) {
        try {
          await stopCapturedFixtureProcess('chooser', chooserDevServer)
        } catch (error) {
          failures.push(new Error('app-bound fixture cleanup failed while stopping chooser', { cause: error }))
        }
      }

      if (foreign) {
        try {
          await cleanupOwnedFixtureHome({
            containOwner: () => stopCapturedFixtureProcess('foreign Rust server', foreign, foreignPort),
            removeHome: () => fsp.rm(foreignHome, { recursive: true, force: true }),
          })
        } catch (error) {
          failures.push(new Error('app-bound fixture cleanup failed while containing foreign Rust server and removing HOME', { cause: error }))
        }
      } else {
        // No foreign child was captured, so no process can still own this HOME.
        try {
          await fsp.rm(foreignHome, { recursive: true, force: true })
        } catch (error) {
          failures.push(new Error('app-bound fixture cleanup failed while removing foreign HOME', { cause: error }))
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'app-bound Electron fixture cleanup failed')
    }
  })
})
