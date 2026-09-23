import { spawnSync as realSpawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { ensureFreshE2eBuild } from '../../../e2e-browser/global-setup.js'

describe('Playwright e2e global setup', () => {
  it('rebuilds the current client and Rust server assets instead of accepting an existing dist build', () => {
    const spawnSync = vi.fn()
    const log = vi.fn()

    ensureFreshE2eBuild('/repo', {
      spawnSync: spawnSync as unknown as typeof realSpawnSync,
      env: { PATH: '/bin' },
      platform: 'linux',
      log: { log },
    })

    expect(spawnSync).toHaveBeenNthCalledWith(1, 'npm', ['run', 'prebuild'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'npm', ['run', 'build:client'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(3, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
    expect(log).toHaveBeenNthCalledWith(1, '[e2e-setup] Building client and Rust server...')
    expect(log).toHaveBeenNthCalledWith(2, '[e2e-setup] Build complete.')
  })
})
