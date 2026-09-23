import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type { GlobalSetupContext } from 'vitest/node'

import { ensureBuiltRuntime, installBuiltRuntimeRefresh } from '../../../setup/e2e-browser-global-setup.js'

type RerunHandler = Parameters<GlobalSetupContext['onTestsRerun']>[0]

describe('ensureBuiltRuntime', () => {
  it('rebuilds the client and Rust runtime before helper tests', () => {
    const spawnSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltRuntime('/repo', {
      spawnSync,
      rmSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('/repo', 'dist', '.env'), { force: true })
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
  })

  it('uses the npm CLI JavaScript entrypoint on Windows when npm exposes it', () => {
    const spawnSync = vi.fn()
    const rmSync = vi.fn()
    const npmExecPath = path.join('C:\\repo', 'node_modules', 'npm', 'bin', 'npm-cli.js')

    ensureBuiltRuntime('C:\\repo', {
      spawnSync,
      rmSync,
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
      },
      platform: 'win32',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('C:\\repo', 'dist', '.env'), { force: true })
    expect(spawnSync).toHaveBeenNthCalledWith(1, process.execPath, [npmExecPath, 'run', 'prebuild'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(2, process.execPath, [npmExecPath, 'run', 'build:client'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(3, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('builds a pnpm-pinned project through its pnpm entrypoint', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-e2e-runtime-setup-'))
    const projectRoot = `${base} dir with spaces`
    fs.mkdirSync(projectRoot)
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }))
    const pnpmCjs = path.join(projectRoot, 'pnpm.cjs')
    fs.writeFileSync(pnpmCjs, '')
    const env = {
      PATH: path.join(projectRoot, 'missing-bin'),
      npm_execpath: pnpmCjs,
    }
    const spawnSync = vi.fn()
    const rmSync = vi.fn()

    try {
      ensureBuiltRuntime(projectRoot, {
        spawnSync,
        rmSync,
        env,
        platform: 'win32',
      })

      expect(rmSync).toHaveBeenCalledWith(path.join(projectRoot, 'dist', '.env'), { force: true })
      expect(spawnSync).toHaveBeenNthCalledWith(1, process.execPath, [pnpmCjs, 'run', 'prebuild'], {
        cwd: projectRoot,
        env: {
          ...env,
          NODE_ENV: 'production',
        },
        stdio: 'inherit',
        shell: false,
      })
      expect(spawnSync).toHaveBeenNthCalledWith(2, process.execPath, [pnpmCjs, 'run', 'build:client'], {
        cwd: projectRoot,
        env: {
          ...env,
          NODE_ENV: 'production',
        },
        stdio: 'inherit',
        shell: false,
      })
      expect(spawnSync).toHaveBeenNthCalledWith(3, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
        cwd: projectRoot,
        env: {
          ...env,
          NODE_ENV: 'production',
        },
        stdio: 'inherit',
      })
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('rebuilds the compiled runtime on every watch rerun', async () => {
    let rerunHandler: RerunHandler | undefined
    const ensureBuiltRuntime = vi.fn()

    installBuiltRuntimeRefresh({
      onTestsRerun(handler) {
        rerunHandler = handler
      },
    }, '/repo', {
      ensureBuiltRuntime,
    })

    expect(ensureBuiltRuntime).toHaveBeenCalledTimes(1)
    expect(ensureBuiltRuntime).toHaveBeenNthCalledWith(1, '/repo')
    expect(rerunHandler).toBeTypeOf('function')

    await rerunHandler?.([])

    expect(ensureBuiltRuntime).toHaveBeenCalledTimes(2)
    expect(ensureBuiltRuntime).toHaveBeenNthCalledWith(2, '/repo')
  })
})
