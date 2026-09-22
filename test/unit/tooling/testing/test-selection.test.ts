import { describe, expect, it } from 'vitest'

import {
  buildVitestArgs,
  createStandardTestPlan,
} from '../../../../scripts/run-standard-tests.js'
import { classifyCommand } from '../../../../scripts/testing/coordinator-command-matrix.js'

describe('Rust-first build and test selection', () => {
  it('runs client, source-runtime, Rust, and Electron phases without vacuous Vitest flags', () => {
    const plan = createStandardTestPlan({
      availableParallelism: 8,
      ci: false,
      forwardedArgs: [],
    })
    const runs = plan.stages.flat()

    expect(runs.map((run) => run.name)).toEqual([
      'client',
      'source-runtime',
      'rust',
      'electron',
    ])
    expect(runs.find((run) => run.name === 'client')?.configPath).toBe('config/vitest/vitest.config.ts')
    expect(runs.find((run) => run.name === 'source-runtime')?.script).toBe('test:source-runtime')
    expect(runs.find((run) => run.name === 'rust')?.script).toBe('test:rust')
    expect(runs.find((run) => run.name === 'electron')?.configPath).toBe('config/vitest/vitest.electron.config.ts')
    expect(buildVitestArgs({ configPath: 'config/vitest/vitest.config.ts', forwardedArgs: [] })).not.toContain('--passWithNoTests')
  })

  it('maps server and integration public commands to explicit Rust cargo phases', () => {
    const server = classifyCommand({ commandKey: 'test:server', forwardedArgs: [] })
    expect(server.kind).toBe('coordinated')
    if (server.kind === 'coordinated') {
      expect(server.phases).toEqual([{ runner: 'cargo', args: ['test', '-p', 'freshell-server', '--locked'] }])
    }

    const integration = classifyCommand({ commandKey: 'test:integration', forwardedArgs: [] })
    expect(integration.kind).toBe('coordinated')
    if (integration.kind === 'coordinated') {
      expect(integration.phases).toEqual([{ runner: 'cargo', args: ['test', '--workspace', '--tests', '--locked'] }])
    }
  })
})
