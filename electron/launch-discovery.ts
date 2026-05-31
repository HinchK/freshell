import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface HealthPayload {
  app?: string
  ok?: boolean
  version?: string
  ready?: boolean
  instanceId?: string
  startedAt?: string
  requiresAuth?: boolean
}

export interface DiscoverLocalServersOptions {
  urls: string[]
  fetchHealth?: (url: string) => Promise<HealthPayload>
}

export function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

export function buildLocalProbeUrls(config: DesktopConfig): string[] {
  const urls: string[] = []
  const add = (url: string) => {
    const normalized = normalizeServerUrl(url)
    if (isLoopbackUrl(normalized) && !urls.includes(normalized)) {
      urls.push(normalized)
    }
  }

  add(`http://localhost:${config.port}`)
  add('http://localhost:3001')

  for (let port = 3001; port <= 3010; port += 1) {
    add(`http://localhost:${port}`)
  }

  for (const server of config.knownServers ?? []) {
    add(server.url)
  }

  return urls
}

async function defaultFetchHealth(url: string): Promise<HealthPayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 750)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false }
    return await response.json() as HealthPayload
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverLocalServers(options: DiscoverLocalServersOptions): Promise<LaunchServerCandidate[]> {
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth
  const results = await Promise.all(options.urls.map(async (url) => {
    const normalized = normalizeServerUrl(url)
    try {
      const health = await fetchHealth(`${normalized}/api/health`)
      if (health.app !== 'freshell' || health.ok !== true) {
        return undefined
      }

      const parsed = new URL(normalized)
      const candidate: LaunchServerCandidate = {
        id: health.instanceId ?? normalized,
        url: normalized,
        origin: 'port-scan',
        ownership: 'detected-local',
        label: `${parsed.hostname}:${parsed.port}`,
        version: health.version,
        ready: health.ready,
        instanceId: health.instanceId,
        startedAt: health.startedAt,
        requiresAuth: health.requiresAuth ?? true,
      }
      return candidate
    } catch {
      return undefined
    }
  }))

  return results.filter((candidate): candidate is LaunchServerCandidate => candidate !== undefined)
}
