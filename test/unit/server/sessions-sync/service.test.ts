import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionsSyncService } from '../../../../server/sessions-sync/service.js'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'

function createWsMocks() {
  return {
    broadcastSessionsChanged: vi.fn(),
  }
}

function createProject(path: string, lastActivityAt: number): ProjectGroup {
  return {
    projectPath: path,
    sessions: [{ provider: 'claude', sessionId: `${path}-${lastActivityAt}`, projectPath: path, lastActivityAt }],
  }
}

function createDetailedProject(
  path: string,
  session: NonNullable<ProjectGroup['sessions']>[number],
  color?: string,
): ProjectGroup {
  return {
    projectPath: path,
    sessions: [{ provider: 'claude', projectPath: path, lastActivityAt: 1, sessionId: 's1', ...session }],
    ...(color ? { color } : {}),
  }
}

describe('SessionsSyncService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes first publish immediately when coalescing is enabled', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    svc.publish(a)

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(1)

    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid publishes into one trailing flush with latest state', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const c = [createProject('/p1', 3)]

    svc.publish(a)
    svc.publish(b)
    svc.publish(c)

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(2)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(2)
  })

  it('emits one trailing publish per window while burst updates continue', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const c = [createProject('/p1', 3)]
    const d = [createProject('/p1', 4)]

    svc.publish(a)
    svc.publish(b)
    vi.advanceTimersByTime(150)

    svc.publish(c)
    svc.publish(d)
    vi.advanceTimersByTime(150)

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(3)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(3)
  })

  it('shutdown clears pending trailing timer and state', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]

    svc.publish(a)
    svc.publish(b)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    svc.shutdown()
    vi.advanceTimersByTime(1_000)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
  })

  it('disables coalescing when coalesceMs is zero', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([createProject('/p1', 1)])
    svc.publish([createProject('/p1', 2)])
    svc.publish([createProject('/p1', 3)])

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(3)
  })

  it('suppresses no-change trailing flushes (A->B->A), updates baseline, and stops timer', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const aAgain = [createProject('/p1', 1)]

    svc.publish(a)
    svc.publish(b)
    svc.publish(aAgain)

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    svc.publish(b)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(2)
  })

  it('broadcasts the same lightweight invalidation even when the changed snapshot is large', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([
      {
        projectPath: '/p1',
        sessions: Array.from({ length: 200 }, (_, index) => ({
          provider: 'claude',
          sessionId: `s-${index}`,
          projectPath: '/p1',
          lastActivityAt: index,
          summary: 'x'.repeat(2_000),
        })),
      },
    ])

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(1)
  })

  it('broadcasts only when directory-visible fields change', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy',
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedTokens: 0,
          totalTokens: 3,
        },
      }, '#f00'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy',
        tokenUsage: {
          inputTokens: 9,
          outputTokens: 9,
          cachedTokens: 9,
          totalTokens: 27,
        },
        sourceFile: '/tmp/other.jsonl',
        // SESSION-05: same color as the baseline publish — project colors
        // ARE directory-visible now (see the color-only test below), so
        // this leg must hold color constant to keep asserting that only
        // tokenUsage/sourceFile metadata is invisible.
      }, '#f00'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 101,
        title: 'Deploy',
      }, '#0f0'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 101,
        title: 'Deploy v2',
      }, '#0f0'),
    ])

    expect(ws.broadcastSessionsChanged.mock.calls).toEqual([
      [1],
      [2],
      [3],
    ])
  })

  // SESSION-05 (project colors): the session-directory page is the ONLY
  // channel that delivers a project color to the client, and it is
  // re-fetched in response to `sessions.changed` — so a color-only change
  // (no session field moves) MUST still broadcast, or other browser
  // contexts never re-render a recolored History project header. The
  // comparable-items differ alone is color-blind by design (its pinned
  // contract, see projection.test.ts); the sync service therefore ALSO
  // compares the resolved per-project color map.
  it('broadcasts on a color-only change and does not rebroadcast an unchanged color', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const uncolored = [createDetailedProject('/repo', {})]
    const colored = [createDetailedProject('/repo', {}, '#ff8800')]
    const recolored = [createDetailedProject('/repo', {}, '#00ff11')]
    const recoloredAgain = [createDetailedProject('/repo', {}, '#00ff11')]

    // Baseline publish (first publish always flushes immediately).
    svc.publish(uncolored)
    expect(ws.broadcastSessionsChanged.mock.calls).toEqual([[1]])

    // Color-only change inside the coalesce window → trailing broadcast.
    svc.publish(colored)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsChanged.mock.calls).toEqual([[1], [2]])

    // Let the post-trailing window close, then change between two SET
    // colors → immediate broadcast (no pending window).
    vi.advanceTimersByTime(151)
    svc.publish(recolored)
    expect(ws.broadcastSessionsChanged.mock.calls).toEqual([[1], [2], [3]])

    // Same color published again → no extra broadcast.
    svc.publish(recoloredAgain)
    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(3)

    // Color REMOVED from every project (config restore / sibling-server
    // edit adopting state without colors) → broadcast as well.
    svc.publish(uncolored)
    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(4)
  })
})
