import { describe, expect, it, vi } from 'vitest'
import { cleanupOwnedFixtureHome } from '../../e2e-electron/owned-fixture-home.js'

describe('cleanupOwnedFixtureHome', () => {
  it('retains a foreign fixture HOME when exact child containment fails', async () => {
    const containmentFailure = new Error('captured foreign Rust server port remains bound')
    const containOwner = vi.fn(async () => {
      throw containmentFailure
    })
    const removeHome = vi.fn(async () => {})

    await expect(cleanupOwnedFixtureHome({ containOwner, removeHome })).rejects.toBe(containmentFailure)

    expect(containOwner).toHaveBeenCalledOnce()
    expect(removeHome).not.toHaveBeenCalled()
  })

  it('removes a foreign fixture HOME only after exact child containment succeeds', async () => {
    const order: string[] = []
    const containOwner = vi.fn(async () => {
      order.push('contained')
    })
    const removeHome = vi.fn(async () => {
      order.push('home-removed')
    })

    await cleanupOwnedFixtureHome({ containOwner, removeHome })

    expect(order).toEqual(['contained', 'home-removed'])
  })
})
