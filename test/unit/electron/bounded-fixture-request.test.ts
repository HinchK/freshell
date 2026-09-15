import { describe, expect, it, vi } from 'vitest'
import {
  withBoundedFixtureRequest,
  type CreateFixtureRequestTimeout,
} from '../../e2e-electron/bounded-fixture-request.js'

describe('withBoundedFixtureRequest', () => {
  it('aborts a wedged listener before its request timeout and never consumes a response', async () => {
    const consume = vi.fn(async () => true)
    const timeouts = createManualTimeouts()
    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/health',
      undefined,
      { timeoutMs: 10, fetchImpl: wedgedFetch(), createTimeout: timeouts.create },
      consume,
    )
    const rejection = expect(request).rejects.toThrow(/timed out after 10ms/i)

    timeouts.fire()
    await rejection
    expect(consume).not.toHaveBeenCalled()
  })

  it('uses the remaining outer deadline when it is shorter than the request timeout', async () => {
    const consume = vi.fn(async () => true)
    const timeouts = createManualTimeouts()
    let requestSignal: AbortSignal | undefined
    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/health',
      undefined,
      {
        timeoutMs: 1_000,
        deadline: Date.now() + 100,
        createTimeout: timeouts.create,
        fetchImpl: wedgedFetch((signal) => {
          requestSignal = signal
        }),
      },
      consume,
    )
    const rejection = expect(request).rejects.toThrow(/timed out after \d+ms/i)

    timeouts.fire()
    await rejection
    expect(requestSignal?.reason).toBeInstanceOf(Error)
    const timeoutMatch = (requestSignal?.reason as Error).message.match(/timed out after (\d+)ms/i)
    expect(timeoutMatch).not.toBeNull()
    expect(Number(timeoutMatch?.[1])).toBeLessThan(1_000)
    expect(consume).not.toHaveBeenCalled()
  })

  it('keeps the timeout alive while a resolved response body stalls', async () => {
    const timeouts = createManualTimeouts()
    let requestSignal: AbortSignal | undefined
    let bodyConsumptionStarted!: () => void
    const bodyStarted = new Promise<void>((resolve) => {
      bodyConsumptionStarted = resolve
    })
    const json = vi.fn(
      () =>
        new Promise<unknown>((_, reject) => {
          bodyConsumptionStarted()
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
        }),
    )
    const fetchImpl = vi.fn(async (_: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return { json } as unknown as Response
    }) as unknown as typeof fetch

    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/server-info',
      undefined,
      { timeoutMs: 25, fetchImpl, createTimeout: timeouts.create },
      (response) => response.json(),
    )
    const rejection = expect(request).rejects.toThrow(/timed out after 25ms/i)

    await bodyStarted
    timeouts.fire()

    await rejection
    expect(json).toHaveBeenCalledOnce()
    expect(requestSignal?.aborted).toBe(true)
  })

  it('forwards an outer abort reason promptly', async () => {
    const outer = new AbortController()
    const timeouts = createManualTimeouts()
    let fetchStarted!: () => void
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve
    })
    const outerReason = new Error('fixture teardown requested cancellation')
    const fetchImpl = vi.fn((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        if (!init?.signal) throw new Error('bounded fixture request did not provide an AbortSignal')
        fetchStarted()
        init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/server-info',
      undefined,
      { signal: outer.signal, fetchImpl, createTimeout: timeouts.create },
      async () => true,
    )
    const rejection = expect(request).rejects.toBe(outerReason)

    await started
    outer.abort(outerReason)

    await rejection
    expect(timeouts.cancel).toHaveBeenCalledOnce()
  })

  it('cleans up its owned timer and outer abort listener after success', async () => {
    const outer = new AbortController()
    const timeouts = createManualTimeouts()
    let requestSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return {} as Response
    }) as unknown as typeof fetch

    await expect(
      withBoundedFixtureRequest(
        'http://127.0.0.1:43000/api/health',
        undefined,
        { signal: outer.signal, fetchImpl, createTimeout: timeouts.create },
        async () => true,
      ),
    ).resolves.toBe(true)

    expect(timeouts.cancel).toHaveBeenCalledOnce()
    timeouts.fire()
    outer.abort(new Error('late outer cancellation'))
    await Promise.resolve()

    expect(requestSignal?.aborted).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

function wedgedFetch(captureSignal?: (signal: AbortSignal) => void): typeof fetch {
  return ((_: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      if (!init?.signal) throw new Error('bounded fixture request did not provide an AbortSignal')
      captureSignal?.(init.signal)
      init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as typeof fetch
}

function createManualTimeouts(): {
  create: CreateFixtureRequestTimeout
  cancel: ReturnType<typeof vi.fn>
  fire(): void
} {
  let callback: (() => void) | undefined
  let cancelled = false
  const cancel = vi.fn(() => {
    cancelled = true
  })
  return {
    create: (nextCallback) => {
      callback = nextCallback
      return { cancel }
    },
    cancel,
    fire: () => {
      if (!cancelled) callback?.()
    },
  }
}
