import { describe, it, expect } from 'vitest'
import { reconcileFreshNotice, RECONCILE_NOTICE_FRESH_BY_RACE } from '@/store/panesSlice'

describe('reconcileFreshNotice', () => {
  it('fresh_by_race renders the loud resumable-loss breadcrumb', () => {
    expect(reconcileFreshNotice('fresh_by_race')).toBe(RECONCILE_NOTICE_FRESH_BY_RACE)
    // The restart-contract-wall probes /couldn't be resumed|could not be
    // resumed|fresh session/i — the breadcrumb must match it.
    expect(RECONCILE_NOTICE_FRESH_BY_RACE).toMatch(/couldn't be resumed/i)
    expect(RECONCILE_NOTICE_FRESH_BY_RACE).toMatch(/fresh session/i)
  })
  it('other reasons keep the generic machine-coded notice', () => {
    expect(reconcileFreshNotice('no_recoverable_identity')).toBe(
      'Started fresh (no_recoverable_identity).',
    )
  })
})
