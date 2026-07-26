import { describe, it, expect, beforeEach } from 'vitest'
import { isDismissed, recordDismissal, getPendingOffer, setPendingOffer, clearPendingOffer } from '@/lib/recovery/dismissal'

describe('recovery dismissal persistence', () => {
  beforeEach(() => localStorage.clear())

  it('unknown contentId is not dismissed', () => expect(isDismissed('abc')).toBe(false))

  it('recordDismissal persists across module state (localStorage-backed)', () => {
    recordDismissal('abc')
    expect(isDismissed('abc')).toBe(true)
    expect(isDismissed('xyz')).toBe(false)
  })

  it('caps at 20, evicting oldest', () => {
    for (let i = 0; i < 21; i++) recordDismissal(`id-${i}`)
    expect(isDismissed('id-0')).toBe(false)
    expect(isDismissed('id-20')).toBe(true)
  })

  it('tolerates corrupt stored JSON', () => {
    localStorage.setItem('freshell.recovery.dismissed.v1', '{not json')
    expect(isDismissed('abc')).toBe(false)
    recordDismissal('abc')
    expect(isDismissed('abc')).toBe(true)
  })

  it('pending offer round-trips (with its bootAt anchor) and clears', () => {
    expect(getPendingOffer()).toBeNull()
    setPendingOffer('abc', 12345)
    expect(getPendingOffer()).toEqual({ contentId: 'abc', bootAt: 12345 })
    clearPendingOffer()
    expect(getPendingOffer()).toBeNull()
  })

  it('tolerates corrupt pending JSON', () => {
    localStorage.setItem('freshell.recovery.pending.v1', '{not json')
    expect(getPendingOffer()).toBeNull()
  })
})
