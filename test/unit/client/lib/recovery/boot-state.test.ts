import { describe, it, expect, beforeEach } from 'vitest'
import { computeHadPersistedLayout } from '@/lib/recovery/boot-state'

// Delta round 3, finding 1: the boot's "had persisted layout" signal reads
// THIS window's per-window layout key and backup (freshell.layout.v3.<id>
// and ...<id>.bak), not the origin-wide legacy keys.
const WINDOW_ID = 'client-boot-state-tests'
const OWN_LAYOUT_KEY = `freshell.layout.v3.${WINDOW_ID}`
const OWN_LAYOUT_BAK_KEY = `freshell.layout.v3.${WINDOW_ID}.bak`

const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null })

describe('computeHadPersistedLayout', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.setItem('freshell.tabs.client-instance-id.v1', WINDOW_ID)
  })

  it('empty-never: no layout keys at all -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({}))).toBe(false)
  })

  it('empty-cleared: only unrelated keys survive a clear -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.device-id.v2': 'dev' }))).toBe(false)
  })

  it('the pre-change legacy key alone no longer counts for a fresh per-window boot (another window\u2019s envelope is not THIS window\u2019s layout)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3': '{"tabs":[{"id":"t1"}]}' }))).toBe(false)
  })

  it('populated: the window\u2019s own layout key present -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ [OWN_LAYOUT_KEY]: '{"tabs":[{"id":"t1"}]}' }))).toBe(true)
  })

  it('deliberately emptied: the window\u2019s own layout key present with zero tabs -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ [OWN_LAYOUT_KEY]: '{"tabs":[]}' }))).toBe(true)
  })

  it('the window\u2019s own backup key alone counts as persisted layout', () => {
    expect(computeHadPersistedLayout(store({ [OWN_LAYOUT_BAK_KEY]: '{}' }))).toBe(true)
  })
})

describe('hadPersistedLayoutAtBoot capture', () => {
  it('is captured at module import time, before later writes', async () => {
    localStorage.clear()
    sessionStorage.clear()
    const { hadPersistedLayoutAtBoot } = await import('@/lib/recovery/boot-state?fresh=' + Date.now())
    localStorage.setItem(OWN_LAYOUT_KEY, '{"tabs":[{"id":"auto"}]}') // simulates auto-tab persist
    expect(hadPersistedLayoutAtBoot).toBe(false)
  })
})
