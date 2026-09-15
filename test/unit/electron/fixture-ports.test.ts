import { describe, expect, it } from 'vitest'
import { allocateDistinctFixturePorts } from '../../e2e-electron/fixture-ports.js'

describe('allocateDistinctFixturePorts', () => {
  it('retries fixture-local collisions until every allocated port is distinct', async () => {
    const candidates = [41001, 41001, 41002, 41003]
    const ports = await allocateDistinctFixturePorts(3, async () => candidates.shift()!)

    expect(ports).toEqual([41001, 41002, 41003])
  })

  it('fails instead of accepting indefinitely repeated allocator collisions', async () => {
    await expect(allocateDistinctFixturePorts(2, async () => 41001, 3)).rejects.toThrow(/distinct fixture ports/i)
  })
})
