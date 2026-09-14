import { describe, expect, it, vi } from 'vitest'
import {
  forceStopExactOwnedServerAndVerify,
  stopOwnedServerAndVerify,
} from '../../e2e-electron/owned-server-teardown.js'

describe('stopOwnedServerAndVerify', () => {
  it('surfaces a stop failure after still checking the exact owned PID and port', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('SIGTERM failed'))
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expect(
      stopOwnedServerAndVerify({ stop }, { pid: 4242, port: 4243 }, { waitForPidGone, isPortFree }),
    ).rejects.toThrow(/owned server teardown failed for PID 4242, port 4243/)

    expect(stop).toHaveBeenCalledOnce()
    expect(waitForPidGone).toHaveBeenCalledWith(4242)
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('accepts teardown only after the exact owned PID and port are gone', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn().mockResolvedValue(true)
    const isPortFree = vi.fn().mockResolvedValue(true)

    await expect(
      stopOwnedServerAndVerify({ stop }, { pid: 4242, port: 4243 }, { waitForPidGone, isPortFree }),
    ).resolves.toBeUndefined()
  })

  it('contains a still-running exact app-bound Rust PID after parent containment, then proves PID and port release', async () => {
    const order: string[] = []
    const process = {
      pid: 4242,
      alive: true,
      isAlive: vi.fn(() => process.alive),
      signal: vi.fn((signal: NodeJS.Signals) => {
        order.push(`signal:${signal}`)
        process.alive = false
        return true
      }),
    }
    const proveOwnership = vi.fn(async () => {
      order.push('ownership')
    })
    const waitForPidGone = vi.fn(async () => !process.alive)
    const isPortFree = vi.fn(async () => !process.alive)

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => {} },
        1,
      ),
    ).resolves.toBeUndefined()

    expect(order).toEqual(['ownership', 'signal:SIGTERM'])
    expect(proveOwnership).toHaveBeenCalledWith({ pid: 4242, port: 4243 })
    expect(waitForPidGone).toHaveBeenCalledWith(4242)
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('preserves ownership, PID, and port failures without signaling an unproven PID', async () => {
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn(() => true),
    }
    const proveOwnership = vi.fn().mockRejectedValue(new Error('expected Rust binary was not present'))
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => {} },
        1,
      ),
    ).rejects.toThrow(/forced owned server teardown failed/i)

    expect(process.signal).not.toHaveBeenCalled()
    expect(waitForPidGone).toHaveBeenCalledWith(4242)
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })
})
