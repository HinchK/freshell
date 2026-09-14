import { describe, expect, it, vi } from 'vitest'
import { withBoundedFixtureRequest } from '../../e2e-electron/bounded-fixture-request.js'

describe('withBoundedFixtureRequest', () => {
  it('aborts a wedged listener before its request timeout and never consumes a response', async () => {
    const consume = vi.fn(async () => true)
    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/health',
      undefined,
      { timeoutMs: 10, fetchImpl: wedgedFetch() },
      consume,
    )
    const rejection = expect(request).rejects.toThrow(/timed out after 10ms/i)

    await rejection
    expect(consume).not.toHaveBeenCalled()
  })

  it('uses the remaining outer deadline when it is shorter than the request timeout', async () => {
    const consume = vi.fn(async () => true)
    const startedAt = Date.now()
    let requestSignal: AbortSignal | undefined
    const request = withBoundedFixtureRequest(
      'http://127.0.0.1:43000/api/health',
      undefined,
      {
        timeoutMs: 1_000,
        deadline: startedAt + 100,
        fetchImpl: wedgedFetch((signal) => {
          requestSignal = signal
        }),
      },
      consume,
    )
    const rejection = expect(request).rejects.toThrow(/timed out after \d+ms/i)

    await rejection
    expect(requestSignal?.reason).toBeInstanceOf(Error)
    const timeoutMatch = (requestSignal?.reason as Error).message.match(/timed out after (\d+)ms/i)
    expect(timeoutMatch).not.toBeNull()
    expect(Number(timeoutMatch?.[1])).toBeLessThan(1_000)
    expect(consume).not.toHaveBeenCalled()
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
