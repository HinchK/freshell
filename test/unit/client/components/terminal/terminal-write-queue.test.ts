import { describe, it, expect, vi } from 'vitest'
import { createTerminalWriteQueue } from '@/components/terminal/terminal-write-queue'

describe('createTerminalWriteQueue', () => {
  it('processes queued writes in time slices and preserves order', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      write: (chunk) => {
        writes.push(chunk)
        nowMs += 5
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A')
    queue.enqueue('B')
    queue.enqueue('C')

    expect(writes).toEqual([])

    rafCallbacks.shift()?.(16)
    expect(writes).toEqual(['A'])

    rafCallbacks.shift()?.(32)
    expect(writes).toEqual(['A', 'B'])

    rafCallbacks.shift()?.(48)
    expect(writes).toEqual(['A', 'B', 'C'])
  })

  it('clears pending queue work and cancels the scheduled frame', () => {
    const cancelFrame = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    const write = vi.fn()

    const queue = createTerminalWriteQueue({
      write,
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame,
    })

    queue.enqueue('A')
    queue.enqueue('B')
    queue.clear()

    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not schedule an extra frame when enqueueing while a continuation frame is pending', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      write: (chunk) => {
        writes.push(chunk)
        nowMs += 5
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A')
    queue.enqueue('B')

    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(16)
    expect(writes).toEqual(['A'])
    expect(rafCallbacks).toHaveLength(1)

    queue.enqueue('C')
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)
    expect(writes).toEqual(['A', 'B'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(48)
    expect(writes).toEqual(['A', 'B', 'C'])
    expect(rafCallbacks).toHaveLength(0)
  })

  it('coalesces adjacent writes and preserves write callbacks', () => {
    const writes: string[] = []
    const callbacks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.enqueue('A', () => callbacks.push('A'), { mode: 'replay' })
    queue.enqueue('B', () => callbacks.push('B'), { mode: 'replay' })
    queue.enqueue('C', undefined, { mode: 'replay' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['ABC'])
    expect(callbacks).toEqual(['A', 'B'])
  })

  it('drops queued writes from stale generations before they reach xterm', () => {
    const writes: string[] = []
    const callbacks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('attach-1')
    queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
    queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
    queue.enqueue('new', () => callbacks.push('new'), { generation: 'attach-2' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['new'])
    expect(callbacks).toEqual(['new'])
  })

  it('suppresses stale write callbacks after generation changes', () => {
    const callbacks: string[] = []
    const pendingCallbacks: Array<() => void> = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      write: (_chunk, onWritten) => {
        if (onWritten) pendingCallbacks.push(onWritten)
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('attach-1')
    queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
    rafCallbacks.shift()?.(16)

    expect(queue.hasInFlightWrites()).toBe(true)
    queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
    pendingCallbacks.shift()?.()

    expect(callbacks).toEqual([])
    expect(queue.hasInFlightWrites()).toBe(false)
  })

  it('keeps replay work on the normal frame budget', () => {
    const tasks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      write: () => {},
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueueTask(() => {
      tasks.push('A')
      nowMs += 5
    }, { mode: 'replay' })
    queue.enqueueTask(() => {
      tasks.push('B')
      nowMs += 5
    }, { mode: 'replay' })
    queue.enqueueTask(() => {
      tasks.push('C')
      nowMs += 5
    }, { mode: 'replay' })

    rafCallbacks.shift()?.(16)

    expect(tasks).toEqual(['A'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)

    expect(tasks).toEqual(['A', 'B'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(48)

    expect(tasks).toEqual(['A', 'B', 'C'])
    expect(rafCallbacks).toHaveLength(0)
  })
})
