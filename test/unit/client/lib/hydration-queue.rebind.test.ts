import { describe, expect, it } from 'vitest'
import { createHydrationQueue } from '@/lib/hydration-queue'

function makeEntry(paneId: string, calls: string[]) {
  return { tabId: 'tab-1', paneId, trigger: () => { calls.push(paneId) } }
}

describe('hydration queue — post-startup rebind drain (F8)', () => {
  it('a bare register() after startup never triggers (documents why queueIfStarted is required)', () => {
    const queue = createHydrationQueue()
    const calls: string[] = []
    queue.onActiveTabReady('tab-1', ['tab-1']) // started = true; one-shot
    queue.register(makeEntry('pane-a', calls))
    expect(calls).toEqual([])
  })

  it('register({ queueIfStarted: true }) after startup triggers with no further events', () => {
    const queue = createHydrationQueue()
    const calls: string[] = []
    queue.onActiveTabReady('tab-1', ['tab-1'])
    queue.register(makeEntry('pane-a', calls), { queueIfStarted: true })
    expect(calls).toEqual(['pane-a'])
  })

  it('onHydrationComplete(stalePane) un-wedges the queue for later registrations', () => {
    const queue = createHydrationQueue()
    const calls: string[] = []
    queue.onActiveTabReady('tab-1', ['tab-1'])
    queue.register(makeEntry('pane-a', calls), { queueIfStarted: true }) // active, never completes (dead attach)
    queue.register(makeEntry('pane-b', calls), { queueIfStarted: true }) // held behind the wedge
    expect(calls).toEqual(['pane-a'])
    queue.onHydrationComplete('pane-a') // exactly what the Task 5 sites do first
    expect(calls).toEqual(['pane-a', 'pane-b'])
  })
})
