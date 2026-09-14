/**
 * Failure-preserving Electron fixture cleanup.
 *
 * A stuck Playwright graceful close must never prevent the fixture from
 * stopping and proving its exact owned Rust server. Temporary HOME is removed
 * only after server teardown succeeds, so a surviving Rust child never runs
 * against deleted fixture state. The exact Electron child is supplied by the launch helper;
 * this module never searches for or signals a process by name, port, or group.
 */

export interface ElectronFixtureApplication {
  close(): Promise<void>
}

export interface OwnedElectronProcess {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
}

export interface CancellableTimeout {
  promise: Promise<void>
  cancel(): void
}

export type CreateCancellableTimeout = (ms: number) => CancellableTimeout

export interface ElectronFixtureServerCleanupContext {
  /** The app's graceful shutdown rejected or timed out before teardown. */
  gracefulCloseFailed: boolean
}

export interface ElectronFixtureCleanupDeps {
  app?: ElectronFixtureApplication
  electronProcess?: OwnedElectronProcess
  restoreOpenExternal?: () => Promise<void>
  stopServer?: (context: ElectronFixtureServerCleanupContext) => Promise<void>
  removeHome?: () => Promise<void>
  gracefulCloseTimeoutMs?: number
  forceCloseTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  createTimeout?: CreateCancellableTimeout
}

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 20_000
const DEFAULT_FORCE_CLOSE_TIMEOUT_MS = 5_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const defaultCreateTimeout: CreateCancellableTimeout = (ms) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

function appendFailure(failures: Error[], step: string, error: unknown): void {
  failures.push(
    new Error(`Electron fixture cleanup failed while ${step}`, {
      cause: error,
    }),
  )
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
  createTimeout: CreateCancellableTimeout = defaultCreateTimeout,
): Promise<'settled' | 'timed-out'> {
  const timeout = createTimeout(timeoutMs)
  try {
    return await Promise.race([
      operation.then(() => 'settled' as const),
      timeout.promise.then(() => 'timed-out' as const),
    ])
  } finally {
    timeout.cancel()
  }
}

/**
 * Poll an exact captured child within one bounded call stack. Unlike a raced
 * background loop, every sleep is awaited before this helper returns.
 */
async function waitForCapturedProcessExit(
  hasExited: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / 25) + 1)
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (hasExited()) return true
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    await sleep(Math.min(25, remainingMs))
  }
  return hasExited()
}

/** The product-facing graceful-quit contract used by chooser lifecycle E2E. */
export async function closeElectronGracefully(
  app: ElectronFixtureApplication,
  timeoutMs = DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
  createTimeout: CreateCancellableTimeout = defaultCreateTimeout,
): Promise<void> {
  if ((await settleWithin(app.close(), timeoutMs, createTimeout)) === 'timed-out') {
    throw new Error(`graceful Electron shutdown timed out after ${timeoutMs}ms`)
  }
}

/** Stop and prove only a process handle captured by this fixture. */
export async function stopExactCapturedProcess(
  process: OwnedElectronProcess | undefined,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (!process) throw new Error('no captured process is available for exact-child containment')
  const hasExited = () => process.exitCode !== null || process.signalCode !== null
  if (hasExited()) return

  let sentTerm = false
  try {
    sentTerm = process.kill('SIGTERM')
  } catch (error) {
    throw new Error('sending SIGTERM to the captured Electron process failed', {
      cause: error,
    })
  }
  if (!sentTerm && !hasExited()) {
    throw new Error('the captured Electron process rejected SIGTERM')
  }

  if (await waitForCapturedProcessExit(hasExited, timeoutMs, sleep)) return

  try {
    const sentKill = process.kill('SIGKILL')
    if (!sentKill && !hasExited()) {
      throw new Error('the captured Electron process rejected SIGKILL')
    }
  } catch (error) {
    throw new Error('sending SIGKILL to the captured Electron process failed', {
      cause: error,
    })
  }

  if (!(await waitForCapturedProcessExit(hasExited, timeoutMs, sleep))) {
    throw new Error(`captured Electron process did not exit within ${timeoutMs}ms after SIGKILL`)
  }
}

/**
 * Attempt every teardown step in the safe order and report all failures.
 * A timeout remains a test failure even after the owned Electron process is
 * contained, so forced termination can never turn a graceful-quit regression
 * into a passing E2E test.
 */
export async function cleanupElectronFixture(options: ElectronFixtureCleanupDeps): Promise<void> {
  const failures: Error[] = []
  const sleep = options.sleep ?? defaultSleep
  const createTimeout = options.createTimeout ?? defaultCreateTimeout
  const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS
  const forceCloseTimeoutMs = options.forceCloseTimeoutMs ?? DEFAULT_FORCE_CLOSE_TIMEOUT_MS
  let gracefulCloseFailed = false
  let electronContainmentSucceeded = true
  let serverTeardownSucceeded = true

  if (options.restoreOpenExternal) {
    try {
      await options.restoreOpenExternal()
    } catch (error) {
      appendFailure(failures, 'restoring shell.openExternal', error)
    }
  }

  if (options.app) {
    try {
      await closeElectronGracefully(options.app, gracefulCloseTimeoutMs, createTimeout)
    } catch (error) {
      gracefulCloseFailed = true
      appendFailure(failures, 'closing Electron', error)
    }

    // Playwright's close promise resolving is not an exit receipt for the
    // launch-owned child. The handle is exact (rather than a PID lookup), so
    // this is a bounded no-op after a normal exit and TERM→KILL containment
    // only when that same captured process still reports live.
    if (options.electronProcess) {
      try {
        await stopExactCapturedProcess(options.electronProcess, forceCloseTimeoutMs, sleep)
      } catch (containmentError) {
        electronContainmentSucceeded = false
        appendFailure(failures, 'containing the captured Electron process', containmentError)
      }
    }
  }

  if (options.stopServer) {
    try {
      await options.stopServer({ gracefulCloseFailed })
    } catch (error) {
      serverTeardownSucceeded = false
      appendFailure(failures, 'stopping the owned Rust server', error)
    }
  }

  // Do not delete the profile beneath either a surviving app-bound Rust child
  // or a captured Electron process whose exact containment was not proven.
  if (options.removeHome && electronContainmentSucceeded && serverTeardownSucceeded) {
    try {
      await options.removeHome()
    } catch (error) {
      appendFailure(failures, 'removing the temporary HOME', error)
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Electron fixture cleanup failed')
  }
}
