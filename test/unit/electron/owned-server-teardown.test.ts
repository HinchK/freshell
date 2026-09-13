import { describe, expect, it, vi } from 'vitest'
import { stopOwnedServerAndVerify } from '../../e2e-electron/owned-server-teardown.js'

describe('stopOwnedServerAndVerify', () => {
  it('surfaces a stop failure after still checking the exact owned PID and port', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('SIGTERM failed'))
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expect(stopOwnedServerAndVerify(
      { stop },
      { pid: 4242, port: 4243 },
      { waitForPidGone, isPortFree },
    )).rejects.toThrow(/owned server teardown failed for PID 4242, port 4243/)

    expect(stop).toHaveBeenCalledOnce()
    expect(waitForPidGone).toHaveBeenCalledWith(4242)
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('accepts teardown only after the exact owned PID and port are gone', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn().mockResolvedValue(true)
    const isPortFree = vi.fn().mockResolvedValue(true)

    await expect(stopOwnedServerAndVerify(
      { stop },
      { pid: 4242, port: 4243 },
      { waitForPidGone, isPortFree },
    )).resolves.toBeUndefined()
  })
})
