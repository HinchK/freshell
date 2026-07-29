import { describe, it, expect } from 'vitest'
import { isStaleSessionIdentityMismatch } from '@/components/terminal-view-utils'

describe('isStaleSessionIdentityMismatch (rebind swap-window suppression)', () => {
  const sesB = { provider: 'opencode', sessionId: 'ses_B' }

  it('suppresses when actualSessionRef matches the pane current ref (fold already applied; stale bounce)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode', sessionId: 'ses_B' })).toBe(true)
  })

  it('does not suppress when actualSessionRef differs from the current ref (a REAL mismatch)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode', sessionId: 'ses_A' })).toBe(false)
    expect(isStaleSessionIdentityMismatch({ provider: 'opencode', sessionId: 'ses_A' }, sesB)).toBe(false)
  })

  it('does not suppress when either ref is absent or unparseable (fail toward the visible path)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, undefined)).toBe(false)
    expect(isStaleSessionIdentityMismatch(undefined, sesB)).toBe(false)
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode' })).toBe(false)
  })
})
