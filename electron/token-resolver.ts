import fsp from 'fs/promises'
import path from 'path'
import { isLoopbackUrl, normalizeServerUrl } from './launch-discovery.js'
import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface ResolveCandidateTokenOptions {
  candidate: LaunchServerCandidate
  desktopConfig: DesktopConfig
  configDir: string
  readTextFile?: (filePath: string) => Promise<string>
}

export function extractTokenFromEnv(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^AUTH_TOKEN=(.*)$/)
    if (!match) continue

    const raw = match[1].trim()
    return raw.replace(/^"(.*)"$/, '$1')
  }

  return undefined
}

export function extractTokenFromConfigJson(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { authToken?: unknown; token?: unknown }
    if (typeof parsed.authToken === 'string' && parsed.authToken.length > 0) {
      return parsed.authToken
    }
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token
    }
  } catch {
    return undefined
  }

  return undefined
}

async function readOptional(
  filePath: string,
  readTextFile: (filePath: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return await readTextFile(filePath)
  } catch {
    return undefined
  }
}

export async function resolveCandidateToken(
  options: ResolveCandidateTokenOptions,
): Promise<string | undefined> {
  const readTextFile = options.readTextFile ?? ((filePath: string) => fsp.readFile(filePath, 'utf-8'))
  const candidateUrl = normalizeServerUrl(options.candidate.url)
  const remoteUrl = options.desktopConfig.remoteUrl
    ? normalizeServerUrl(options.desktopConfig.remoteUrl)
    : undefined

  if (remoteUrl === candidateUrl && options.desktopConfig.remoteToken) {
    return options.desktopConfig.remoteToken
  }

  if (!isLoopbackUrl(candidateUrl)) {
    return undefined
  }

  const envContent = await readOptional(path.join(options.configDir, '.env'), readTextFile)
  const envToken = envContent ? extractTokenFromEnv(envContent) : undefined
  if (envToken) return envToken

  const configContent = await readOptional(path.join(options.configDir, 'config.json'), readTextFile)
  return configContent ? extractTokenFromConfigJson(configContent) : undefined
}
