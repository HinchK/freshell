import { describe, it, expect, beforeEach } from 'vitest'
import { computeHadPersistedLayout } from '@/lib/recovery/boot-state'

const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null })

describe('computeHadPersistedLayout', () => {
  beforeEach(() => localStorage.clear())

  it('empty-never: no layout keys at all -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({}))).toBe(false)
  })

  it('empty-cleared: only unrelated keys survive a clear -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.device-id.v2': 'dev' }))).toBe(false)
  })

  it('populated: layout key present -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3': '{"tabs":[{"id":"t1"}]}' }))).toBe(true)
  })

  it('deliberately emptied: layout key present with zero tabs -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3': '{"tabs":[]}' }))).toBe(true)
  })

  it('backup key alone counts as persisted layout', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3.bak': '{}' }))).toBe(true)
  })
})

describe('hadPersistedLayoutAtBoot capture', () => {
  it('is captured at module import time, before later writes', async () => {
    localStorage.clear()
    const { hadPersistedLayoutAtBoot } = await import('@/lib/recovery/boot-state?fresh=' + Date.now())
    localStorage.setItem('freshell.layout.v3', '{"tabs":[{"id":"auto"}]}') // simulates auto-tab persist
    expect(hadPersistedLayoutAtBoot).toBe(false)
  })
})
