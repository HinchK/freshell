/**
 * Failure-preserving Electron fixture cleanup.
 *
 * A stuck Playwright graceful close must never prevent the fixture from
 * stopping and proving its exact owned Rust server, or from removing its
 * temporary HOME. The exact Electron child is supplied by the launch helper;
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

export interface ElectronFixtureCleanupDeps {
  app?: ElectronFixtureApplication
  electronProcess?: OwnedElectronProcess
  restoreOpenExternal?: () => Promise<void>
  stopServer?: () => Promise<void>
  removeHome?: () => Promise<void>
  gracefulCloseTimeoutMs?: number
  forceCloseTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 20_000
const DEFAULT_FORCE_CLOSE_TIMEOUT_MS = 5_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function appendFailure(failures: Error[], step: string, error: unknown): void {
  failures.push(new Error(`Electron fixture cleanup failed while ${step}`, { cause: error }))
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<'settled' | 'timed-out'> {
  return Promise.race([
    operation.then(() => 'settled' as const),
    sleep(timeoutMs).then(() => 'timed-out' as const),
  ])
}

/** The product-facing graceful-quit contract used by chooser lifecycle E2E. */
export async function closeElectronGracefully(
  app: ElectronFixtureApplication,
  timeoutMs = DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  if (await settleWithin(app.close(), timeoutMs, sleep) === 'timed-out') {
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
    throw new Error('sending SIGTERM to the captured Electron process failed', { cause: error })
  }
  if (!sentTerm && !hasExited()) {
    throw new Error('the captured Electron process rejected SIGTERM')
  }

  const exitedAfterTerm = await settleWithin(
    (async () => {
      while (!hasExited()) await sleep(25)
    })(),
    timeoutMs,
    sleep,
  )
  if (exitedAfterTerm === 'settled') return

  try {
    const sentKill = process.kill('SIGKILL')
    if (!sentKill && !hasExited()) {
      throw new Error('the captured Electron process rejected SIGKILL')
    }
  } catch (error) {
    throw new Error('sending SIGKILL to the captured Electron process failed', { cause: error })
  }

  const exitedAfterKill = await settleWithin(
    (async () => {
      while (!hasExited()) await sleep(25)
    })(),
    timeoutMs,
    sleep,
  )
  if (exitedAfterKill === 'timed-out') {
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
  const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS
  const forceCloseTimeoutMs = options.forceCloseTimeoutMs ?? DEFAULT_FORCE_CLOSE_TIMEOUT_MS

  if (options.restoreOpenExternal) {
    try {
      await options.restoreOpenExternal()
    } catch (error) {
      appendFailure(failures, 'restoring shell.openExternal', error)
    }
  }

  if (options.app) {
    try {
      await closeElectronGracefully(options.app, gracefulCloseTimeoutMs, sleep)
    } catch (error) {
      appendFailure(failures, 'closing Electron', error)
      try {
        await stopExactCapturedProcess(options.electronProcess, forceCloseTimeoutMs, sleep)
      } catch (containmentError) {
        appendFailure(failures, 'containing the captured Electron process', containmentError)
      }
    }
  }

  if (options.stopServer) {
    try {
      await options.stopServer()
    } catch (error) {
      appendFailure(failures, 'stopping the owned Rust server', error)
    }
  }

  if (options.removeHome) {
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
