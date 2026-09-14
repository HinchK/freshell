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
    sleep: vi.fn(async (ms: number, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal)
      now += ms
    }),
    now: () => now,
    ...overrides,
  }
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
    expect(get).toHaveBeenCalledWith('/api/panes?tabId=tab-1', { signal: opts.signal })
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
    expect(opts.get).toHaveBeenCalledWith('/api/panes?tabId=tab-1', { signal: controller.signal })
    expect(opts.patch).not.toHaveBeenCalled()
  })
})
