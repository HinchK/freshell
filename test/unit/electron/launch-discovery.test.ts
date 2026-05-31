import { describe, expect, it, vi } from 'vitest'
import {
  buildLocalProbeUrls,
  discoverLocalServers,
  isLoopbackUrl,
  normalizeServerUrl,
} from '../../../electron/launch-discovery.js'
import type { DesktopConfig } from '../../../electron/types.js'

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

describe('launch discovery', () => {
  it('normalizes server URLs by trimming trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:3001/')).toBe('http://localhost:3001')
    expect(normalizeServerUrl('http://localhost:3001///')).toBe('http://localhost:3001')
  })

  it('recognizes only loopback URLs as local token-readable URLs', () => {
    expect(isLoopbackUrl('http://localhost:3001')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:3001')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:3001')).toBe(true)
    expect(isLoopbackUrl('http://10.0.0.5:3001')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })

  it('builds unique local probe URLs from config port, defaults, range, and known local servers', () => {
    const urls = buildLocalProbeUrls(config({
      port: 3004,
      knownServers: [
        { url: 'http://localhost:3002', label: 'Known local' },
        { url: 'http://10.0.0.5:3001', label: 'Remote VPN' },
      ],
    }))

    expect(urls[0]).toBe('http://localhost:3004')
    expect(urls).toContain('http://localhost:3001')
    expect(urls).toContain('http://localhost:3010')
    expect(urls).toContain('http://localhost:3002')
    expect(urls).not.toContain('http://10.0.0.5:3001')
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('returns only healthy Freshell servers', async () => {
    const fetchHealth = vi.fn(async (url: string) => {
      if (url === 'http://localhost:3001/api/health') {
        return {
          ok: true,
          app: 'freshell',
          version: '0.7.0',
          ready: true,
          instanceId: 'local-a',
          startedAt: '2026-05-24T18:00:00.000Z',
          requiresAuth: true,
        }
      }
      if (url === 'http://localhost:3002/api/health') {
        return { ok: true, app: 'not-freshell' }
      }
      throw new Error('ECONNREFUSED')
    })

    const candidates = await discoverLocalServers({
      urls: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
      fetchHealth,
    })

    expect(candidates).toEqual([
      {
        id: 'local-a',
        url: 'http://localhost:3001',
        origin: 'port-scan',
        ownership: 'detected-local',
        label: 'localhost:3001',
        version: '0.7.0',
        ready: true,
        instanceId: 'local-a',
        startedAt: '2026-05-24T18:00:00.000Z',
        requiresAuth: true,
      },
    ])
  })
})
