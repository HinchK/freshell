import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relFromThisTest: string): string {
  const url = new URL(relFromThisTest, import.meta.url)
  return fs.readFileSync(fileURLToPath(url), 'utf8')
}

describe('Client entrypoint', () => {
  it('does not use React.StrictMode (xterm double-mount breaks)', () => {
    const src = readSource('../../../src/main.tsx')
    expect(src).not.toMatch(/React\\.StrictMode/)
  })

  it('initializes client perf logging at bootstrap', () => {
    const src = readSource('../../../src/main.tsx')
    expect(src).toMatch(/initClientPerfLogging/)
    expect(src).toMatch(/initClientPerfLogging\(\)/)
  })

  // Unified agent names (Task 7): the legacy-name capture is a
  // side-effect-only synchronous module — it must run BEFORE
  // `@/store/storage-migration` (which can rewrite the layout keys), the
  // store imports (whose slice initial states load them), and App — or the
  // raw legacy labels could be cleared before they are preserved.
  it('imports the legacy-name capture before the storage migrations and store', () => {
    const src = readSource('../../../src/main.tsx')
    const captureIndex = src.indexOf("import '@/lib/session-name-migration'")
    const migrationIndex = src.indexOf("import '@/store/storage-migration'")
    const storeIndex = src.indexOf("import { store } from '@/store/store'")
    expect(captureIndex).toBeGreaterThanOrEqual(0)
    expect(migrationIndex).toBeGreaterThan(captureIndex)
    expect(storeIndex).toBeGreaterThan(migrationIndex)
  })

  it('never lets the capture module reach the Redux store through its imports', () => {
    const src = readSource('../../../src/lib/session-name-migration.ts')
    expect(src).not.toMatch(/@\/store\/store/)
    expect(src).not.toMatch(/from ['"]@\/store\/(tabsSlice|panesSlice|sessionNamesSlice)/)
  })
})
