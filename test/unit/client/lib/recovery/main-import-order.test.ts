import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('boot-state capture ordering invariants (D1/A8)', () => {
  const src = readFileSync('src/main.tsx', 'utf8')

  it('storage-migration is imported before the store and App in main.tsx', () => {
    // It re-materializes freshell.layout.v3 from the
    // `.backup-before-fresh-agent-centralization` key BEFORE any capture can run —
    // which is why boot-state checks only v3 + .bak. The imports above it
    // (react, react-dom/client, react-redux) are pure library imports with no
    // localStorage side effects, so "before store/App" is the real invariant.
    const migrationIdx = src.indexOf("import '@/store/storage-migration'")
    const storeIdx = src.indexOf("from '@/store/store'")
    const appIdx = src.indexOf("from '@/App'")
    expect(migrationIdx).toBeGreaterThan(-1)
    expect(storeIdx).toBeGreaterThan(-1)
    expect(appIdx).toBeGreaterThan(-1)
    expect(migrationIdx).toBeLessThan(storeIdx)
    expect(migrationIdx).toBeLessThan(appIdx)
  })

  it('boot-state is never imported from main.tsx', () => {
    // boot-state must load AFTER migrations (it reaches the DOM via App → RecoveryOfferPanel)
    expect(src).not.toMatch(/lib\/recovery\/boot-state/)
  })
})
