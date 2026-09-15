/**
 * A resumed layout reaches the Rust server through the client mirror. A rename
 * must therefore wait for the server to positively list the exact pane before
 * PATCHing it. A PATCH response cannot distinguish a still-pending mirror from
 * a genuine missing pane, so it is deliberately never used as a poll signal.
 */

export type PaneRenameResponse =
  | { data?: { paneId?: string; tabId?: string; tabRenamed?: boolean }; message?: string }
  | null
  | undefined

type PaneMirrorResponse = {
  data?: {
    panes?: Array<{ id?: unknown }>
  }
} | null | undefined

type ApiRequestOptions = {
  signal: AbortSignal
}

export type PaneRenameResult =
  | { ok: true; response: PaneRenameResponse }
  | { ok: false; message: string }

// The layout mirror debounces its initial sync by one second. Five seconds is
// an explicit upper bound for a resumed connection, not a PATCH retry budget.
const MIRROR_READY_DEADLINE_MS = 5_000
const MIRROR_POLL_INTERVAL_MS = 200
const MIRROR_NOT_FOUND_MESSAGE = 'pane not found'
const GENERIC_FAILURE_MESSAGE = 'Failed to rename pane'

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function composeAbortSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push({ signal, listener: abort })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener)
      }
    },
  }
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortError()))

    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function sleepUntilNextMirrorProbe(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timeout)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function hasExactPaneReceipt(response: PaneMirrorResponse, paneId: string): boolean {
  return response?.data?.panes?.some((pane) => pane?.id === paneId) ?? false
}

function resultMessage(response: PaneRenameResponse): string {
  return typeof response?.message === 'string' && response.message
    ? response.message
    : GENERIC_FAILURE_MESSAGE
}

/**
 * Wait for Rust's exact `GET /api/panes?tabId` receipt, then make a single
 * rename PATCH. The caller owns the AbortSignal so a closed pane or unmounted
 * container cannot leave a delayed request updating stale UI.
 */
export async function renamePaneAfterMirrorReady(
  tabId: string,
  paneId: string,
  name: string,
  opts: {
    signal: AbortSignal
    get: (path: string, options: ApiRequestOptions) => Promise<PaneMirrorResponse>
    patch: (path: string, body: unknown, options: ApiRequestOptions) => Promise<PaneRenameResponse>
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    now?: () => number
    deadlineMs?: number
    pollIntervalMs?: number
  },
): Promise<PaneRenameResult> {
  const { signal } = opts
  const sleep = opts.sleep ?? sleepUntilNextMirrorProbe
  const now = opts.now ?? Date.now
  const deadlineMs = opts.deadlineMs ?? MIRROR_READY_DEADLINE_MS
  const pollIntervalMs = opts.pollIntervalMs ?? MIRROR_POLL_INTERVAL_MS
  const deadlineAt = now() + deadlineMs
  const mirrorPath = `/api/panes?tabId=${encodeURIComponent(tabId)}`
  const mirrorDeadlineController = new AbortController()
  let deadlineExpired = false
  let mirrorDeadlineTimer: number | undefined
  const { signal: mirrorSignal, dispose } = composeAbortSignals([signal, mirrorDeadlineController.signal])
  const stopMirrorDeadline = () => {
    if (mirrorDeadlineTimer !== undefined) {
      window.clearTimeout(mirrorDeadlineTimer)
      mirrorDeadlineTimer = undefined
    }
    dispose()
  }
  mirrorDeadlineTimer = window.setTimeout(() => {
    deadlineExpired = true
    mirrorDeadlineController.abort()
  }, deadlineMs)

  try {
    for (;;) {
      throwIfAborted(signal)
      const mirror = await awaitWithAbort(opts.get(mirrorPath, { signal: mirrorSignal }), mirrorSignal)
      throwIfAborted(signal)
      const remainingMs = deadlineAt - now()
      if (remainingMs <= 0) return { ok: false, message: MIRROR_NOT_FOUND_MESSAGE }
      if (hasExactPaneReceipt(mirror, paneId)) {
        stopMirrorDeadline()
        break
      }

      await awaitWithAbort(sleep(Math.min(pollIntervalMs, remainingMs), mirrorSignal), mirrorSignal)
    }
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (deadlineExpired) return { ok: false, message: MIRROR_NOT_FOUND_MESSAGE }
    throw error
  } finally {
    stopMirrorDeadline()
  }

  throwIfAborted(signal)
  const response = await awaitWithAbort(
    opts.patch(`/api/panes/${encodeURIComponent(paneId)}`, { name }, { signal }),
    signal,
  )
  throwIfAborted(signal)
  if (response?.data?.paneId === paneId) return { ok: true, response }
  return { ok: false, message: resultMessage(response) }
}
