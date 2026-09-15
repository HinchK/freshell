export interface FixtureRequestTimeout {
  cancel(): void
}

export type CreateFixtureRequestTimeout = (callback: () => void, ms: number) => FixtureRequestTimeout

export interface BoundedFixtureRequestOptions {
  /** Per-request ceiling, further bounded by `deadline` when supplied. */
  timeoutMs?: number
  /** Absolute deadline owned by the surrounding fixture operation. */
  deadline?: number
  /** Cancellation owned by the surrounding fixture operation. */
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** Injectable only to prove timeout ownership without scheduler sleeps. */
  createTimeout?: CreateFixtureRequestTimeout
}

const DEFAULT_FIXTURE_REQUEST_TIMEOUT_MS = 1_000

const defaultCreateTimeout: CreateFixtureRequestTimeout = (callback, ms) => {
  const timer = setTimeout(callback, ms)
  return { cancel: () => clearTimeout(timer) }
}

/**
 * Keep an HTTP request and its response consumption within the fixture's
 * bounded lifetime. A listener that accepts TCP but never sends headers or a
 * body must not prevent finally cleanup from running.
 */
export async function withBoundedFixtureRequest<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: BoundedFixtureRequestOptions,
  consume: (response: Response) => Promise<T> | T,
): Promise<T> {
  const configuredTimeoutMs = options.timeoutMs ?? DEFAULT_FIXTURE_REQUEST_TIMEOUT_MS
  const remainingMs = options.deadline === undefined ? configuredTimeoutMs : options.deadline - Date.now()
  const timeoutMs = Math.min(configuredTimeoutMs, remainingMs)
  if (timeoutMs <= 0) throw new Error('fixture request deadline expired before it started')
  if (options.signal?.aborted) throw options.signal.reason

  const controller = new AbortController()
  const timeoutError = new Error(`fixture request timed out after ${timeoutMs}ms`)
  const abortFromOuterSignal = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortFromOuterSignal, { once: true })
  const timeout = (options.createTimeout ?? defaultCreateTimeout)(() => controller.abort(timeoutError), timeoutMs)

  try {
    const response = await (options.fetchImpl ?? fetch)(input, { ...init, signal: controller.signal })
    return await consume(response)
  } finally {
    timeout.cancel()
    options.signal?.removeEventListener('abort', abortFromOuterSignal)
  }
}
