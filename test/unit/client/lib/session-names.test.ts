import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.status = status
      this.data = data
    }
  },
}))

vi.mock('@/lib/api', () => ({ api: { post: apiMocks.post, patch: apiMocks.patch }, ApiError: apiMocks.ApiError }))

import {
  bootstrapSessionNames,
  renameSessionName,
} from '@/lib/session-names'
import type { SessionNameUpdate } from '@shared/session-names'

function sessionRef(sessionId: string) {
  return { kind: 'session' as const, provider: 'claude' as const, sessionId }
}

function pendingRef(id: string) {
  return { kind: 'pending' as const, id }
}

function acceptedUpdate(name: string, revision: number): SessionNameUpdate {
  return {
    record: { ref: sessionRef('s1'), name, source: 'manual', revision },
    documentGeneration: 10,
    redirects: [],
    changed: true,
  }
}

describe('bootstrapSessionNames', () => {
  beforeEach(() => {
    apiMocks.post.mockReset()
  })

  it('POSTs the read batch and returns the parsed updates', async () => {
    const update = acceptedUpdate('Booted name', 2)
    apiMocks.post.mockResolvedValueOnce({ names: [update] })

    const updates = await bootstrapSessionNames([sessionRef('s1')])

    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    expect(apiMocks.post).toHaveBeenCalledWith('/api/session-names/read', { refs: [sessionRef('s1')] }, expect.anything())
    expect(updates).toEqual([update])
  })

  it('chunks refs into batches of at most 100 per request', async () => {
    const firstNames = Array.from({ length: 100 }, (_, i) => acceptedUpdate(`n${i}`, 1))
    const restNames = Array.from({ length: 50 }, (_, i) => acceptedUpdate(`n${100 + i}`, 1))
    apiMocks.post
      .mockResolvedValueOnce({ names: firstNames })
      .mockResolvedValueOnce({ names: restNames })

    const refs = Array.from({ length: 150 }, (_, i) => sessionRef(`s${i}`))
    const updates = await bootstrapSessionNames(refs)

    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    const [firstPath, firstBody] = apiMocks.post.mock.calls[0]
    const [secondPath, secondBody] = apiMocks.post.mock.calls[1]
    expect(firstPath).toBe('/api/session-names/read')
    expect(secondPath).toBe('/api/session-names/read')
    expect((firstBody as { refs: unknown[] }).refs).toHaveLength(100)
    expect((secondBody as { refs: unknown[] }).refs).toHaveLength(50)
    expect(updates).toHaveLength(150)
  })

  it('returns updates for missing refs silently (the server omits unknown refs)', async () => {
    apiMocks.post.mockResolvedValueOnce({ names: [] })

    const updates = await bootstrapSessionNames([pendingRef('unknown-handle')])
    expect(updates).toEqual([])
  })

  it('propagates an abort signal to the request', async () => {
    const controller = new AbortController()
    apiMocks.post.mockImplementation((_path: string, _body: unknown, options: { signal?: AbortSignal }) => {
      expect(options?.signal?.aborted).toBe(false)
      return Promise.resolve({ names: [] })
    })
    await bootstrapSessionNames([sessionRef('s1')], { signal: controller.signal })
    expect(apiMocks.post).toHaveBeenCalled()
  })
})

describe('renameSessionName', () => {
  beforeEach(() => {
    apiMocks.patch.mockReset()
  })

  it('PATCHes the canonical rename route with the full request body', async () => {
    const update = acceptedUpdate('Renamed by user', 3)
    apiMocks.patch.mockResolvedValueOnce(update)

    const result = await renameSessionName({
      target: sessionRef('s1'),
      name: 'Renamed by user',
      nameIntent: 'user',
      ifRevision: 2,
    })

    expect(apiMocks.patch).toHaveBeenCalledWith(
      '/api/session-names',
      {
        target: sessionRef('s1'),
        name: 'Renamed by user',
        nameIntent: 'user',
        ifRevision: 2,
      },
      expect.anything(),
    )
    expect(result).toEqual(update)
  })

  it('retains the server error code and accepted record on a conflict', async () => {
    apiMocks.patch.mockRejectedValue(new apiMocks.ApiError(409, 'conflict: another rename won', {
      error: 'NAME_REVISION_CONFLICT',
      message: 'another rename won',
      sessionName: {
        record: {
          ref: { kind: 'session', provider: 'claude', sessionId: 's1' },
          name: 'Other browser name',
          source: 'manual',
          revision: 5,
        },
        documentGeneration: 40,
        redirects: [],
        changed: true,
      },
      nameRef: { kind: 'session', provider: 'claude', sessionId: 's1' },
    }))

    await expect(renameSessionName({ target: sessionRef('s1'), name: 'Loser', nameIntent: 'user' }))
      .rejects.toMatchObject({
        status: 409,
        serverCode: 'NAME_REVISION_CONFLICT',
      })
    try {
      await renameSessionName({ target: sessionRef('s1'), name: 'Loser', nameIntent: 'user' })
    } catch (error: any) {
      // The accepted record survives for the error UI.
      expect(error.acceptedUpdate?.record.name).toBe('Other browser name')
      expect(error.acceptedUpdate?.record.revision).toBe(5)
    }
  })
})
