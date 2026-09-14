import { describe, expect, it, vi } from 'vitest'
import {
  closeElectronGracefully,
  cleanupElectronFixture,
  stopExactCapturedProcess,
  type ElectronFixtureCleanupDeps,
} from '../../e2e-electron/electron-fixture-cleanup.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function expectCleanupFailure(operation: Promise<void>, pattern: RegExp): Promise<void> {
  try {
    await operation
    throw new Error('expected fixture cleanup to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.some((failure) => {
      const cause = (failure as Error & { cause?: unknown }).cause
      return pattern.test(String(failure)) || pattern.test(String(cause))
    })).toBe(true)
  }
}

describe('cleanupElectronFixture', () => {
  it('rejects a hung graceful-close contract within its explicit budget', async () => {
    const close = deferred()
    await expect(closeElectronGracefully(
      { close: () => close.promise },
      1,
      async () => {},
    )).rejects.toThrow(/graceful Electron shutdown timed out/i)
  })

  it('closes Electron before proving the owned Rust server and removing HOME', async () => {
    const order: string[] = []
    const deps: ElectronFixtureCleanupDeps = {
      app: { close: vi.fn(async () => { order.push('app.close') }) },
      stopServer: vi.fn(async () => { order.push('server.stop-and-verify') }),
      removeHome: vi.fn(async () => { order.push('home.remove') }),
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
      stopServer: vi.fn(async () => { order.push('server.stop-and-verify') }),
      removeHome: vi.fn(async () => { order.push('home.remove') }),
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

    await expectCleanupFailure(cleanupElectronFixture({
      app: { close: () => close.promise },
      electronProcess,
      stopServer,
      gracefulCloseTimeoutMs: 1,
      forceCloseTimeoutMs: 1,
      sleep: async () => {},
    }), /graceful Electron shutdown timed out/i)

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

    await expect(stopExactCapturedProcess(child, 1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })).rejects.toThrow(/did not exit/i)
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('reports a missing captured process as containment evidence, not a TypeError', async () => {
    await expect(stopExactCapturedProcess(undefined, 1, async () => {})).rejects.toThrow(/no captured process/i)
  })

  it('retains a graceful-close failure while continuing exact-server and HOME cleanup', async () => {
    const order: string[] = []
    const deps: ElectronFixtureCleanupDeps = {
      app: { close: vi.fn(async () => { throw new Error('close protocol failed') }) },
      stopServer: vi.fn(async () => { order.push('server.stop-and-verify') }),
      removeHome: vi.fn(async () => { order.push('home.remove') }),
    }

    await expectCleanupFailure(cleanupElectronFixture(deps), /closing Electron/i)
    expect(order).toEqual(['server.stop-and-verify', 'home.remove'])
  })
})
