import { describe, expect, it, vi } from 'vitest'
import { renamePaneAfterMirrorReady } from '@/lib/pane-rename'

const mirrorWithoutPane = { status: 'ok', data: { panes: [] } }
const mirrorWithPane = { status: 'ok', data: { panes: [{ id: 'pane-1' }] } }
const renameOk = { status: 'ok', data: { paneId: 'pane-1', tabId: 'tab-1' }, message: 'pane renamed' }

function options(overrides: Partial<Parameters<typeof renamePaneAfterMirrorReady>[3]> = {}) {
  let now = 0
  const signal = new AbortController().signal
  return {
    signal,
    get: vi.fn().mockResolvedValue(mirrorWithPane),
    patch: vi.fn().mockResolvedValue(renameOk),
    sleep: vi.fn(async (ms: number) => {
      now += ms
    }),
    now: () => now,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('renamePaneAfterMirrorReady', () => {
  it('waits for a positive receipt beyond the former 1.4s window before making one rename PATCH', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValueOnce(mirrorWithoutPane)
      .mockResolvedValue(mirrorWithPane)
    const opts = options({ get })

    const result = await renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', opts)

    expect(result.ok).toBe(true)
    expect(get).toHaveBeenCalledTimes(9)
    expect(opts.sleep).toHaveBeenCalledTimes(8)
    expect(opts.sleep.mock.calls.map(([delay]) => delay)).toEqual([200, 200, 200, 200, 200, 200, 200, 200])
    expect(opts.patch).toHaveBeenCalledTimes(1)
    const mirrorSignal = get.mock.calls[0]?.[1]?.signal
    expect(mirrorSignal).toBeInstanceOf(AbortSignal)
    expect(mirrorSignal).not.toBe(opts.signal)
    expect(opts.patch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'Ops desk' }, { signal: opts.signal })
  })

  it('surfaces pane-not-found promptly after a positive exact pane receipt without a second PATCH', async () => {
    const opts = options({
      patch: vi.fn().mockResolvedValue({ status: 'ok', message: 'pane not found' }),
    })

    const result = await renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', opts)

    expect(result).toEqual({ ok: false, message: 'pane not found' })
    expect(opts.get).toHaveBeenCalledTimes(1)
    expect(opts.patch).toHaveBeenCalledTimes(1)
    expect(opts.sleep).not.toHaveBeenCalled()
  })

  it('surfaces ordinary rename responses and HTTP failures without polling or retrying the PATCH', async () => {
    const ordinary = options({
      patch: vi.fn().mockResolvedValue({ status: 'ok', message: 'name too long' }),
    })

    await expect(renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', ordinary))
      .resolves.toEqual({ ok: false, message: 'name too long' })
    expect(ordinary.patch).toHaveBeenCalledTimes(1)
    expect(ordinary.sleep).not.toHaveBeenCalled()

    const rejected = options({ patch: vi.fn().mockRejectedValue(new Error('network down')) })
    await expect(renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', rejected))
      .rejects.toThrow('network down')
    expect(rejected.patch).toHaveBeenCalledTimes(1)

    const mirrorRejected = options({ get: vi.fn().mockRejectedValue(new Error('mirror unavailable')) })
    await expect(renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', mirrorRejected))
      .rejects.toThrow('mirror unavailable')
    expect(mirrorRejected.patch).not.toHaveBeenCalled()
  })

  it('reports a missing pane after the bounded mirror-readiness deadline without PATCHing', async () => {
    const opts = options({
      get: vi.fn().mockResolvedValue(mirrorWithoutPane),
      deadlineMs: 600,
      pollIntervalMs: 200,
    })

    await expect(renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', opts))
      .resolves.toEqual({ ok: false, message: 'pane not found' })
    expect(opts.get).toHaveBeenCalledTimes(4)
    expect(opts.sleep).toHaveBeenCalledTimes(3)
    expect(opts.patch).not.toHaveBeenCalled()
  })

  it('returns pane not found at the default deadline when the first mirror GET never settles', async () => {
    vi.useFakeTimers()
    try {
      let receivedSignal: AbortSignal | undefined
      const get = vi.fn((_: string, { signal }: { signal: AbortSignal }) => {
        receivedSignal = signal
        return new Promise<typeof mirrorWithoutPane>(() => {})
      })
      const patch = vi.fn().mockResolvedValue(renameOk)
      const result = renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', options({ get, patch }))

      await vi.advanceTimersByTimeAsync(5_001)

      await expect(result).resolves.toEqual({ ok: false, message: 'pane not found' })
      expect(receivedSignal?.aborted).toBe(true)
      expect(patch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms the mirror deadline after an exact receipt so an in-flight PATCH can complete', async () => {
    vi.useFakeTimers()
    try {
      const pendingPatch = deferred<typeof renameOk>()
      const patch = vi.fn((_: string, __: unknown, { signal }: { signal: AbortSignal }) => {
        expect(signal.aborted).toBe(false)
        return pendingPatch.promise
      })
      const caller = new AbortController()
      const result = renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', options({
        signal: caller.signal,
        patch,
      }))

      await vi.advanceTimersByTimeAsync(0)
      expect(patch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_001)
      expect(caller.signal.aborted).toBe(false)

      pendingPatch.resolve(renameOk)
      await expect(result).resolves.toEqual({ ok: true, response: renameOk })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an in-flight mirror GET without issuing later requests or a PATCH', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      const pendingGet = deferred<typeof mirrorWithPane>()
      let receivedSignal: AbortSignal | undefined
      const get = vi.fn((_: string, { signal }: { signal: AbortSignal }) => {
        receivedSignal = signal
        return pendingGet.promise
      })
      const patch = vi.fn().mockResolvedValue(renameOk)
      const result = renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', options({
        signal: caller.signal,
        get,
        patch,
      }))

      caller.abort()
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(receivedSignal?.aborted).toBe(true)

      pendingGet.resolve(mirrorWithPane)
      await vi.advanceTimersByTimeAsync(250)
      expect(get).toHaveBeenCalledTimes(1)
      expect(patch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an in-flight PATCH with the caller signal and cannot later return success', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      const pendingPatch = deferred<typeof renameOk>()
      let receivedSignal: AbortSignal | undefined
      const patch = vi.fn((_: string, __: unknown, { signal }: { signal: AbortSignal }) => {
        receivedSignal = signal
        return pendingPatch.promise
      })
      const result = renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', options({
        signal: caller.signal,
        patch,
      }))

      await vi.advanceTimersByTimeAsync(0)
      expect(patch).toHaveBeenCalledTimes(1)
      caller.abort()
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(receivedSignal).toBe(caller.signal)
      expect(receivedSignal?.aborted).toBe(true)

      pendingPatch.resolve(renameOk)
      await vi.advanceTimersByTimeAsync(250)
      expect(patch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the mirror wait on abort before issuing a PATCH', async () => {
    const controller = new AbortController()
    const sleep = vi.fn((_: number, signal: AbortSignal) => new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const opts = options({ signal: controller.signal, get: vi.fn().mockResolvedValue(mirrorWithoutPane), sleep })
    const result = renamePaneAfterMirrorReady('tab-1', 'pane-1', 'Ops desk', opts)

    await Promise.resolve()
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(opts.get).toHaveBeenCalledWith('/api/panes?tabId=tab-1', { signal: expect.any(AbortSignal) })
    expect(opts.get.mock.calls[0]?.[1]?.signal.aborted).toBe(true)
    expect(opts.patch).not.toHaveBeenCalled()
  })
})
