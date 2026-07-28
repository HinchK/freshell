import { describe, it, expect } from 'vitest'
import repoIconsReducer, { fetchRepoIconMeta } from '@/store/repoIconsSlice'

describe('repoIconsSlice', () => {
  it('marks loading on pending', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.pending.type,
      meta: { arg: '/home/u/proj' },
    })
    expect(state.byCwd['/home/u/proj']).toEqual({ status: 'loading' })
  })

  it('stores meta on fulfilled', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.fulfilled.type,
      meta: { arg: '/home/u/proj' },
      payload: { repoRoot: '/home/u/proj', checkoutRoot: '/home/u/proj', repoName: 'proj', hasIcon: true },
    })
    expect(state.byCwd['/home/u/proj']).toEqual({
      status: 'ready',
      repoRoot: '/home/u/proj',
      checkoutRoot: '/home/u/proj',
      repoName: 'proj',
      hasIcon: true,
    })
  })

  it('falls back to cwd basename on rejection (endpoint absent, e.g. Node dev server)', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.rejected.type,
      meta: { arg: '/home/u/code/myrepo' },
      error: { message: 'Not found' },
    })
    expect(state.byCwd['/home/u/code/myrepo']).toEqual({
      status: 'error',
      hasIcon: false,
      repoName: 'myrepo',
    })
  })
})
