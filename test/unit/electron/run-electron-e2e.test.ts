import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clientArtifactContainsBuildId,
  playwrightExitResult,
  resolveExactElectronE2eHead,
} from '../../../scripts/run-electron-e2e.js'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true })
  }
})

describe('Electron E2E client preflight', () => {
  it('accepts only a client artifact containing the requested exact build id', () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-electron-client-preflight-'))
    temporaryPaths.push(clientDir)
    const buildId = 'a'.repeat(40)
    fs.mkdirSync(path.join(clientDir, 'assets'))
    fs.writeFileSync(path.join(clientDir, 'assets', 'index.js'), `const build = '${buildId}'`)

    expect(clientArtifactContainsBuildId(clientDir, buildId)).toBe(true)
    expect(clientArtifactContainsBuildId(clientDir, 'b'.repeat(40))).toBe(false)
  })

  it('pins builds to checkout HEAD and rejects a conflicting inherited override', () => {
    const head = 'a'.repeat(40)
    expect(resolveExactElectronE2eHead('/repo', undefined, () => head)).toBe(head)
    expect(() => resolveExactElectronE2eHead('/repo', head, () => head)).toThrow(/rejects inherited FRESHELL_BUILD_COMMIT/i)
    expect(() => resolveExactElectronE2eHead('/repo', 'b'.repeat(40), () => head)).toThrow(/rejects inherited FRESHELL_BUILD_COMMIT/i)
  })

  it('preserves a Playwright child signal instead of collapsing it into exit 1', () => {
    expect(playwrightExitResult({ status: null, signal: 'SIGTERM' })).toBe('SIGTERM')
    expect(playwrightExitResult({ status: 2, signal: null })).toBe(2)
  })
})
