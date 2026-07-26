import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RebindQueue, getRebindQueue, resetRebindQueueForTests } from '@/lib/rebind-queue'

describe('RebindQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps concurrent in-flight jobs at maxInFlight', () => {
    const queue = new RebindQueue({ maxInFlight: 2, minStartIntervalMs: 0 })
    const started: string[] = []
    const releases: Array<() => void> = []
    for (const key of ['a', 'b', 'c', 'd']) {
      queue.enqueue({ key, run: (release) => { started.push(key); releases.push(release) } })
    }
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a', 'b'])
    expect(queue.inFlightCount).toBe(2)
    expect(queue.queuedCount).toBe(2)
    releases[0]()
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('spaces job starts by minStartIntervalMs', () => {
    const queue = new RebindQueue({ maxInFlight: 4, minStartIntervalMs: 25 })
    const started: string[] = []
    for (const key of ['a', 'b', 'c']) {
      queue.enqueue({ key, run: (release) => { started.push(key); release() } })
    }
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['a'])
    vi.advanceTimersByTime(25)
    expect(started).toEqual(['a', 'b'])
    vi.advanceTimersByTime(25)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('auto-releases a job that never calls release after releaseTimeoutMs', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0, releaseTimeoutMs: 10_000 })
    const started: string[] = []
    queue.enqueue({ key: 'stuck', run: () => { started.push('stuck') } })
    queue.enqueue({ key: 'next', run: (release) => { started.push('next'); release() } })
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['stuck'])
    vi.advanceTimersByTime(10_000)
    expect(started).toEqual(['stuck', 'next'])
  })

  it('release is idempotent (double release frees one slot only)', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const started: string[] = []
    let firstRelease: (() => void) | null = null
    queue.enqueue({ key: 'a', run: (release) => { started.push('a'); firstRelease = release } })
    queue.enqueue({ key: 'b', run: (release) => { started.push('b'); release() } })
    queue.enqueue({ key: 'c', run: () => { started.push('c') } })
    vi.advanceTimersByTime(0)
    firstRelease!()
    firstRelease!()
    vi.advanceTimersByTime(0)
    // 'b' started and self-released -> 'c' starts; the double release of 'a'
    // must not have freed a phantom second slot before 'b' completed.
    expect(started).toEqual(['a', 'b', 'c'])
    expect(queue.inFlightCount).toBe(1) // 'c' never releases
  })

  it('dedups by key while queued or in-flight', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const runs: string[] = []
    queue.enqueue({ key: 'pane-1:attach', run: () => { runs.push('first') } })
    queue.enqueue({ key: 'pane-1:attach', run: () => { runs.push('dup') } })
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['first'])
    expect(queue.queuedCount).toBe(0)
  })

  it('re-runs a key once when it was re-enqueued while IN-FLIGHT (reconnect flapping)', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const runs: string[] = []
    let heldRelease: (() => void) | null = null
    queue.enqueue({ key: 'k', run: (release) => { runs.push('first'); heldRelease = release } })
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['first'])
    // Reconnect flapping: the in-flight frame may have died with its
    // connection. This enqueue must coalesce (re-run on release), not drop.
    queue.enqueue({ key: 'k', run: (release) => { runs.push('second'); release() } })
    expect(runs).toEqual(['first'])
    heldRelease!()
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['first', 'second'])
    expect(queue.inFlightCount).toBe(0)
  })

  it('a key re-enqueued while merely QUEUED still runs only once', () => {
    const queue = new RebindQueue({ maxInFlight: 1, minStartIntervalMs: 0 })
    const runs: string[] = []
    let blockerRelease: (() => void) | null = null
    queue.enqueue({ key: 'blocker', run: (release) => { runs.push('blocker'); blockerRelease = release } })
    queue.enqueue({ key: 'k', run: (release) => { runs.push('k'); release() } })
    queue.enqueue({ key: 'k', run: (release) => { runs.push('k-dup'); release() } })
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['blocker'])
    blockerRelease!()
    vi.advanceTimersByTime(0)
    expect(runs).toEqual(['blocker', 'k'])
    expect(queue.queuedCount).toBe(0)
  })

  it('getRebindQueue returns a singleton reset by resetRebindQueueForTests', () => {
    const first = getRebindQueue()
    expect(getRebindQueue()).toBe(first)
    resetRebindQueueForTests()
    expect(getRebindQueue()).not.toBe(first)
  })
})
