// @vitest-environment node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { detectProjectManager } from '../../../../scripts/lib/package-manager.js'
import { publicCommandDisplay } from '../../../../scripts/testing/test-coordinator.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..')

describe('publicCommandDisplay', () => {
  it('renders this repo\'s commands with pnpm and no forwarded-argument separator', () => {
    expect(detectProjectManager(REPO_ROOT).manager).toBe('pnpm')
    expect(publicCommandDisplay('test', [])).toBe('pnpm test')
    expect(publicCommandDisplay('test:unit', ['test/unit/client/app.test.ts'])).toBe(
      'pnpm run test:unit test/unit/client/app.test.ts',
    )
  })

  it('keeps the legacy npm rendering with the separator for npm contexts', () => {
    expect(publicCommandDisplay('test', [], 'npm')).toBe('npm test')
    expect(publicCommandDisplay('test:vitest', ['run', 'x.test.ts'], 'npm')).toBe(
      'npm run test:vitest -- run x.test.ts',
    )
  })
})
