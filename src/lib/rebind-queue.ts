/**
 * RebindQueue -- paces "session rebind" work for HIDDEN panes so that a
 * reconnect/restart with many background panes does not stampede the server
 * (F8 / P1.11). Cheap rebind frames (freshAgent.create / freshAgent.attach)
 * are enqueued here when the owning pane is hidden; visible panes bypass the
 * queue entirely.
 *
 * Defaults mirror the server-side spawn gate from PR #532
 * (crates/freshell-ws/src/spawn_gate.rs: 4 concurrent, 10s permit timeout).
 * Restore creates bypass the server rate limiter, so this modest client-side
 * stagger is sufficient pacing.
 */

export interface RebindJob {
  /** Dedup key, e.g. `freshagent:<paneId>:attach`. */
  key: string
  /** Runs when a slot opens. MUST eventually call release() (auto-released
   *  after releaseTimeoutMs as a backstop). */
  run: (release: () => void) => void
}

interface RebindQueueOptions {
  maxInFlight?: number
  releaseTimeoutMs?: number
  minStartIntervalMs?: number
}

export class RebindQueue {
  private readonly maxInFlight: number
  private readonly releaseTimeoutMs: number
  private readonly minStartIntervalMs: number
  private readonly queued: RebindJob[] = []
  private readonly inFlightKeys = new Set<string>()
  private lastStartAt = Number.NEGATIVE_INFINITY
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private inPump = false

  constructor(options: RebindQueueOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 4
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? 10_000
    this.minStartIntervalMs = options.minStartIntervalMs ?? 25
  }

  get inFlightCount(): number {
    return this.inFlightKeys.size
  }

  get queuedCount(): number {
    return this.queued.length
  }

  enqueue(job: RebindJob): void {
    if (this.inFlightKeys.has(job.key)) return
    if (this.queued.some((queued) => queued.key === job.key)) return
    this.queued.push(job)
    this.schedulePump(0)
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpTimer) return
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      this.pump()
    }, delayMs)
  }

  private pump(): void {
    if (this.inPump) return  // Prevent reentrancy
    this.inPump = true
    try {
      while (this.queued.length > 0 && this.inFlightKeys.size < this.maxInFlight) {
        const now = Date.now()
        const wait = this.lastStartAt + this.minStartIntervalMs - now
        if (wait > 0) {
          this.schedulePump(wait)
          return
        }
        const job = this.queued.shift()!
        this.lastStartAt = now
        this.start(job)
      }
    } finally {
      this.inPump = false
    }
  }

  private start(job: RebindJob): void {
    this.inFlightKeys.add(job.key)
    let released = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const release = () => {
      if (released) return
      released = true
      if (timeout) clearTimeout(timeout)
      this.inFlightKeys.delete(job.key)
      // Directly call pump if not currently pumping, to handle fake timer edge case
      // where scheduled setTimeout(0) from within setTimeout callback doesn't fire
      if (!this.inPump && this.pumpTimer === null) {
        this.pump()
      } else {
        this.schedulePump(0)
      }
    }
    timeout = setTimeout(release, this.releaseTimeoutMs)
    job.run(release)
  }
}

let singleton: RebindQueue | null = null

export function getRebindQueue(): RebindQueue {
  if (!singleton) singleton = new RebindQueue()
  return singleton
}

export function resetRebindQueueForTests(): void {
  singleton = null
}
