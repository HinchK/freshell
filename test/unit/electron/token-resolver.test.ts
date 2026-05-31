import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  extractTokenFromConfigJson,
  extractTokenFromEnv,
  resolveCandidateToken,
} from '../../../electron/token-resolver.js'
import type { DesktopConfig, LaunchServerCandidate } from '../../../electron/types.js'

function localCandidate(url = 'http://localhost:3001'): LaunchServerCandidate {
  return {
    id: url,
    url,
    origin: 'port-scan',
    ownership: 'detected-local',
    label: url,
    requiresAuth: true,
  }
}

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
    ...overrides,
  }
}

describe('token resolver', () => {
  it('extracts AUTH_TOKEN from env content', () => {
    expect(extractTokenFromEnv('AUTH_TOKEN=abc123\nPORT=3001\n')).toBe('abc123')
    expect(extractTokenFromEnv('AUTH_TOKEN="quoted-token"\n')).toBe('quoted-token')
    expect(extractTokenFromEnv('PORT=3001\n')).toBeUndefined()
  })

  it('extracts token from config json using supported keys', () => {
    expect(extractTokenFromConfigJson(JSON.stringify({ authToken: 'config-a' }))).toBe('config-a')
    expect(extractTokenFromConfigJson(JSON.stringify({ token: 'config-b' }))).toBe('config-b')
    expect(extractTokenFromConfigJson('{bad json')).toBeUndefined()
  })

  it('uses matching saved remote token first', async () => {
    const readTextFile = vi.fn()
    const token = await resolveCandidateToken({
      candidate: localCandidate('http://localhost:3001'),
      desktopConfig: config({
        remoteUrl: 'http://localhost:3001',
        remoteToken: 'saved-token',
      }),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('saved-token')
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('reads loopback token from .env when no saved token exists', async () => {
    const readTextFile = vi.fn(async (filePath: string) => {
      expect(filePath).toBe(path.join('/home/user/.freshell', '.env'))
      return 'AUTH_TOKEN=env-token\n'
    })

    const token = await resolveCandidateToken({
      candidate: localCandidate('http://127.0.0.1:3001'),
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('env-token')
  })

  it('falls back to config.json for loopback token', async () => {
    const readTextFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.env')) throw new Error('missing env')
      return JSON.stringify({ authToken: 'json-token' })
    })

    const token = await resolveCandidateToken({
      candidate: localCandidate(),
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('json-token')
  })

  it('does not read local token files for remote candidates', async () => {
    const readTextFile = vi.fn(async () => 'AUTH_TOKEN=local-token\n')

    const token = await resolveCandidateToken({
      candidate: {
        ...localCandidate('http://10.0.0.5:3001'),
        ownership: 'remote',
      },
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBeUndefined()
    expect(readTextFile).not.toHaveBeenCalled()
  })
})
