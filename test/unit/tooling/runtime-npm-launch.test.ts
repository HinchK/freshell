// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn,
}))

import { main as runSourceRuntimeTests } from '../../../scripts/testing/run-source-runtime-tests.js'
import { main as runStandardTests } from '../../../scripts/run-standard-tests.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawn.mockReset()
})

describe('runtime test script subprocesses', () => {
  function mockSpawnResolvingChildren(): void {
    spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        if (command.endsWith('.cmd')) child.emit('error', new Error('spawn EINVAL'))
        else child.emit('exit', 0, null)
      })
      return child
    })
  }

  function launchedSpecs(): Array<{ command: unknown; args: unknown; windowsHide: unknown }> {
    return spawn.mock.calls.map(([command, args, options]) => ({
      command,
      args,
      windowsHide: options?.windowsHide,
    }))
  }

  it('launches the source-runtime prerequisite builder using the npm JavaScript entrypoint on native Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    vi.stubEnv('npm_execpath', npmCli)
    mockSpawnResolvingChildren()

    expect(await runSourceRuntimeTests([])).toBe(0)
    expect(launchedSpecs()).toContainEqual({
      command: process.execPath,
      args: expect.arrayContaining([npmCli, 'run']),
      windowsHide: true,
    })
  })

  it('launches the standard source-runtime phase through the detected pnpm entrypoint on native Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // POSIX-style path so path.basename recognizes the pnpm entrypoint on every
    // test platform; Windows basename accepts forward slashes too.
    const pnpmCjs = '/opt/freshell-test-bin/pnpm.cjs'
    vi.stubEnv('npm_execpath', pnpmCjs)
    mockSpawnResolvingChildren()

    expect(await runStandardTests(['test/integration/tooling/source-runtime-rust.test.ts'])).toBe(0)
    expect(launchedSpecs()).toContainEqual({
      command: process.execPath,
      args: [
        pnpmCjs,
        'run',
        'test:source-runtime',
        'test/integration/tooling/source-runtime-rust.test.ts',
      ],
      windowsHide: true,
    })
  })
})
