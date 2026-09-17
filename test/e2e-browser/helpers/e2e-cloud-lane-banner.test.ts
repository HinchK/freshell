import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '../../..')

// Kata 67jt (premise-corrected): a "full e2e lane" receipt must be able to
// quote WHICH lane produced it from the run log itself. A prior campaign
// gate misread local runs (base config, no skip list) as cloud runs because
// `npm run test:e2e` silently defaults FRESHELL_E2E_BACKEND to local in
// non-interactive agent shells. This test pins the wrapper's local path:
// with the backend env unset (the exact incident condition) the run must
// announce the lane, the config in effect, and that CLOUD_SKIP_SPECS does
// not apply — before exec'ing Playwright against the BASE config.
describe('e2e-cloud wrapper lane provenance', () => {
  it('the default-local path prints a self-identifying lane banner and runs the base config', async () => {
    const stubDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cloud-stub-'))
    const argsFile = path.join(stubDir, 'npx-args.txt')
    const npxStub = path.join(stubDir, 'npx')
    await fsp.writeFile(npxStub, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      'exit 0',
    ].join('\n'))
    await fsp.chmod(npxStub, 0o755)

    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.FRESHELL_E2E_BACKEND
    env.PATH = `${stubDir}${path.delimiter}${env.PATH ?? ''}`

    const result = spawnSync('bash', [
      path.join(projectRoot, 'scripts/e2e-cloud.sh'),
      'run',
    ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 30_000 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[e2e-cloud] Running locally...')
    expect(result.stdout).toContain('test/e2e-browser/playwright.config.ts')
    expect(result.stdout).toContain('CLOUD_SKIP_SPECS does not apply')
    expect(result.stdout).toContain('backend=local; source: default')

    const npxArgs = (await fsp.readFile(argsFile, 'utf8')).split('\n').filter(Boolean)
    expect(npxArgs).toEqual([
      'playwright',
      'test',
      '--config',
      'test/e2e-browser/playwright.config.ts',
    ])
    await fsp.rm(stubDir, { recursive: true, force: true })
  })
})
