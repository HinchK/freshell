import { describe, expect, it, vi } from 'vitest'
import {
  closeElectronGracefully,
  cleanupElectronFixture,
  stopExactCapturedProcess,
  type ElectronFixtureCleanupDeps,
} from '../../e2e-electron/electron-fixture-cleanup.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function expectCleanupFailure(operation: Promise<void>, pattern: RegExp): Promise<void> {
  try {
    await operation
    throw new Error('expected fixture cleanup to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect(
      (error as AggregateError).errors.some((failure) => {
        const cause = (failure as Error & { cause?: unknown }).cause
        return pattern.test(String(failure)) || pattern.test(String(cause))
      }),
    ).toBe(true)
  }
}

describe('cleanupElectronFixture', () => {
  it('rejects a hung graceful-close contract within its explicit budget', async () => {
    const close = deferred()
    await expect(closeElectronGracefully({ close: () => close.promise }, 1)).rejects.toThrow(
      /graceful Electron shutdown timed out/i,
    )
  })

  it('cancels timeout handles after graceful close and exact-child containment settle', async () => {
    const never = deferred()
    const cancel = vi.fn()
    const createTimeout = vi.fn(() => ({ promise: never.promise, cancel }))

    await closeElectronGracefully({ close: async () => {} }, 20_000, createTimeout)
    expect(cancel).toHaveBeenCalledOnce()

    const child = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        child.signalCode = signal
        return true
      }),
    }
    await stopExactCapturedProcess(child, 5_000, async () => {})
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('closes Electron before proving the owned Rust server and removing HOME', async () => {
    const order: string[] = []
    const deps: ElectronFixtureCleanupDeps = {
      app: {
        close: vi.fn(async () => {
          order.push('app.close')
        }),
      },
      stopServer: vi.fn(async () => {
        order.push('server.stop-and-verify')
      }),
      removeHome: vi.fn(async () => {
        order.push('home.remove')
      }),
    }

    await expect(cleanupElectronFixture(deps)).resolves.toBeUndefined()

    expect(order).toEqual(['app.close', 'server.stop-and-verify', 'home.remove'])
  })

  it('contains a hung graceful close, still proves/removes fixture resources, and preserves the failure', async () => {
    const close = deferred()
    const order: string[] = []
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        order.push(`electron.${signal}`)
        electronProcess.signalCode = signal
        return true
      }),
    }
    const deps: ElectronFixtureCleanupDeps = {
      app: { close: vi.fn(() => close.promise) },
      electronProcess,
      stopServer: vi.fn(async () => {
        order.push('server.stop-and-verify')
      }),
      removeHome: vi.fn(async () => {
        order.push('home.remove')
      }),
      gracefulCloseTimeoutMs: 1,
      forceCloseTimeoutMs: 1,
      sleep: async () => {},
    }

    await expectCleanupFailure(cleanupElectronFixture(deps), /graceful Electron shutdown timed out/i)

    expect(order).toEqual(['electron.SIGTERM', 'server.stop-and-verify', 'home.remove'])
    expect(electronProcess.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('escalates only the captured child when SIGTERM does not exit it, then recognizes SIGKILL signal exit', async () => {
    const close = deferred()
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') electronProcess.signalCode = 'SIGKILL'
        return true
      }),
    }
    const stopServer = vi.fn().mockResolvedValue(undefined)

    await expectCleanupFailure(
      cleanupElectronFixture({
        app: { close: () => close.promise },
        electronProcess,
        stopServer,
        gracefulCloseTimeoutMs: 1,
        forceCloseTimeoutMs: 1,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        },
      }),
      /graceful Electron shutdown timed out/i,
    )

    expect(electronProcess.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(electronProcess.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(stopServer).toHaveBeenCalledOnce()
  })

  it('fails containment when the exact captured child resists both signals', async () => {
    const child = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    }

    await expect(
      stopExactCapturedProcess(child, 1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }),
    ).rejects.toThrow(/did not exit/i)
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('stops polling after resistant-child containment fails', async () => {
    const child = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    }
    let activeTimers = 0
    const sleep = vi.fn(
      (ms: number) =>
        new Promise<void>((resolve) => {
          activeTimers += 1
          setTimeout(
            () => {
              activeTimers -= 1
              resolve()
            },
            Math.min(ms, 1),
          )
        }),
    )

    await expect(stopExactCapturedProcess(child, 1, sleep)).rejects.toThrow(/did not exit/i)
    const pollsAtReturn = sleep.mock.calls.length
    expect(activeTimers).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(activeTimers).toBe(0)
    expect(sleep).toHaveBeenCalledTimes(pollsAtReturn)
  })

  it('reports a missing captured process as containment evidence, not a TypeError', async () => {
    await expect(stopExactCapturedProcess(undefined, 1, async () => {})).rejects.toThrow(/no captured process/i)
  })

  it('retains a graceful-close failure while successful exact Electron containment permits server and HOME cleanup', async () => {
    const order: string[] = []
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        order.push(`electron.${signal}`)
        electronProcess.signalCode = signal
        return true
      }),
    }
    const deps: ElectronFixtureCleanupDeps = {
      app: {
        close: vi.fn(async () => {
          throw new Error('close protocol failed')
        }),
      },
      electronProcess,
      stopServer: vi.fn(async () => {
        order.push('server.stop-and-verify')
      }),
      removeHome: vi.fn(async () => {
        order.push('home.remove')
      }),
    }

    await expectCleanupFailure(cleanupElectronFixture(deps), /closing Electron/i)
    expect(order).toEqual(['electron.SIGTERM', 'server.stop-and-verify', 'home.remove'])
  })

  it('contains the exact Electron child after app.close rejects and still cleans server and HOME', async () => {
    const order: string[] = []
    const child = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        order.push(`child.${signal}`)
        child.signalCode = signal
        return true
      }),
    }
    await expectCleanupFailure(
      cleanupElectronFixture({
        app: {
          close: async () => {
            throw new Error('Playwright transport lost')
          },
        },
        electronProcess: child,
        stopServer: async () => {
          order.push('server')
        },
        removeHome: async () => {
          order.push('home')
        },
        sleep: async () => {},
      }),
      /Playwright transport lost/i,
    )
    expect(order).toEqual(['child.SIGTERM', 'server', 'home'])
  })

  it('tells app-bound server cleanup that parent close failed so a surviving Rust child is contained before HOME removal', async () => {
    const close = deferred()
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        electronProcess.signalCode = signal
        return true
      }),
    }
    const contexts: unknown[] = []
    const removeHome = vi.fn(async () => {})

    await expectCleanupFailure(
      cleanupElectronFixture({
        app: { close: () => close.promise },
        electronProcess,
        stopServer: async (context) => {
          contexts.push(context)
        },
        removeHome,
        gracefulCloseTimeoutMs: 1,
        forceCloseTimeoutMs: 1,
        sleep: async () => {},
      }),
      /graceful Electron shutdown timed out/i,
    )

    expect(contexts).toEqual([{ gracefulCloseFailed: true }])
    expect(removeHome).toHaveBeenCalledOnce()
  })

  it('keeps HOME intact and aggregates failures when forced parent-close cleanup cannot prove the owned Rust child stopped', async () => {
    const close = deferred()
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        electronProcess.signalCode = signal
        return true
      }),
    }
    const removeHome = vi.fn(async () => {})

    await expectCleanupFailure(
      cleanupElectronFixture({
        app: { close: () => close.promise },
        electronProcess,
        stopServer: async () => {
          throw new Error('Rust PID remained alive after SIGKILL')
        },
        removeHome,
        gracefulCloseTimeoutMs: 1,
        forceCloseTimeoutMs: 1,
        sleep: async () => {},
      }),
      /Rust PID remained alive after SIGKILL/i,
    )

    expect(removeHome).not.toHaveBeenCalled()
  })

  it('keeps HOME intact when exact Electron containment fails even if owned Rust cleanup succeeds', async () => {
    const close = deferred()
    const order: string[] = []
    const electronProcess = {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        order.push(`electron.${signal}`)
        return true
      }),
    }
    const removeHome = vi.fn(async () => { order.push('home') })

    await expectCleanupFailure(
      cleanupElectronFixture({
        app: { close: () => close.promise },
        electronProcess,
        stopServer: async () => { order.push('server') },
        removeHome,
        gracefulCloseTimeoutMs: 1,
        forceCloseTimeoutMs: 1,
        sleep: async () => {},
      }),
      /containing the captured Electron process/i,
    )

    expect(order).toEqual(['electron.SIGTERM', 'electron.SIGKILL', 'server'])
    expect(removeHome).not.toHaveBeenCalled()
  })
})
