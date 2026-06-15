import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const mockState = vi.hoisted(() => ({
  homeDir: process.env.TEMP || process.env.TMP || '/tmp',
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => mockState.homeDir,
    },
    homedir: () => mockState.homeDir,
  }
})

import { ConfigStore } from '../../../server/config-store'

describe('config-store fresh-agent settings compatibility', () => {
  let tempDir: string
  let configDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'config-store-fresh-agent-'))
    mockState.homeDir = tempDir
    configDir = path.join(tempDir, '.freshell')
    configPath = path.join(configDir, 'config.json')
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function writeConfigWithSettings(settings: Record<string, unknown>) {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(configPath, JSON.stringify({
      version: 1,
      settings,
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }))
  }

  it('loads stored config with both aliases as canonical freshAgent only', async () => {
    await writeConfigWithSettings({
      agentChat: {
        defaultPlugins: ['/legacy/plugin'],
        providers: {
          freshcodex: { effort: 'high' },
        },
      },
      freshAgent: {
        defaultPlugins: [],
        providers: {
          freshcodex: { style: 'serif' },
        },
      },
    })

    const config = await new ConfigStore().load()

    expect(config.settings.freshAgent.defaultPlugins).toEqual([])
    expect(config.settings.freshAgent.providers.freshcodex).toEqual({ style: 'serif', effort: 'high' })
    expect('agentChat' in config.settings).toBe(false)

    const persisted = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as { settings: Record<string, unknown> }
    expect(persisted.settings.freshAgent).toMatchObject({
      defaultPlugins: [],
      providers: {
        freshcodex: { style: 'serif', effort: 'high' },
      },
    })
    expect(persisted.settings.agentChat).toBeUndefined()
  })

  it('preserves canonical empty plugins and field-merges canonical provider partials over legacy values', async () => {
    await writeConfigWithSettings({
      agentChat: {
        defaultPlugins: ['/legacy/plugin'],
        providers: {
          freshcodex: { style: 'sans', effort: 'high' },
        },
      },
      freshAgent: {
        defaultPlugins: [],
        providers: {
          freshcodex: { style: 'serif' },
        },
      },
    })

    const settings = await new ConfigStore().getSettings()

    expect(settings.freshAgent.defaultPlugins).toEqual([])
    expect(settings.freshAgent.providers.freshcodex).toEqual({ style: 'serif', effort: 'high' })
    expect('agentChat' in settings).toBe(false)
  })
})
