import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export type PackageManagerKind = 'pnpm' | 'npm'

export type ManagerSelection = {
  manager: PackageManagerKind
  source: 'packageManager-field' | 'npm-lock-fallback'
}

export type ManagerCommand = {
  command: string
  args: string[]
  viaShell?: boolean
}

export type ResolveManagerOptions = {
  manager: PackageManagerKind
  args: string[]
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  nodeExecPath?: string
  envPath?: string
}

const PNPM_JS_ENTRYPOINT_PATTERN = /^pnpm.*\.(js|cjs)$/i
const JS_ENTRYPOINT_PATTERN = /\.(js|cjs)$/i
const PINNED_PNPM_REMEDIATION = 'npm install --global pnpm@10.34.5'

function isJsEntrypoint(candidate: string): boolean {
  return JS_ENTRYPOINT_PATTERN.test(candidate)
}

function isPnpmJsEntrypoint(candidate: string): boolean {
  return PNPM_JS_ENTRYPOINT_PATTERN.test(path.basename(candidate))
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function realpathOrNull(candidate: string): string | undefined {
  try {
    return realpathSync(candidate)
  } catch {
    return undefined
  }
}

function readPackageManagerField(projectPath: string): PackageManagerKind | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as {
      packageManager?: unknown
    }
    if (typeof manifest.packageManager !== 'string') {
      return undefined
    }
    const name = manifest.packageManager.split('@')[0]
    if (name === 'pnpm' || name === 'npm') {
      return name
    }
    return undefined
  } catch {
    return undefined
  }
}

export function detectProjectManager(projectPath: string): ManagerSelection {
  const fromField = readPackageManagerField(projectPath)
  if (fromField !== undefined) {
    return { manager: fromField, source: 'packageManager-field' }
  }
  return { manager: 'npm', source: 'npm-lock-fallback' }
}

export function buildRunScriptArgs(manager: PackageManagerKind, script: string, forwardedArgs: string[]): string[] {
  if (manager === 'pnpm') {
    return ['run', script, ...forwardedArgs]
  }
  return ['run', script, ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : [])]
}

export function resolveManagerCommand(options: ResolveManagerOptions): ManagerCommand {
  const nodeExecPath = options.nodeExecPath ?? process.execPath
  const platform = options.platform ?? process.platform
  if (options.manager === 'npm') {
    return resolveNpmCommand(options, platform, nodeExecPath)
  }
  return resolvePnpmCommand(options, platform, nodeExecPath)
}

function resolveNpmCommand(
  options: ResolveManagerOptions,
  platform: NodeJS.Platform,
  nodeExecPath: string,
): ManagerCommand {
  const execPath = options.env.npm_execpath
  if (typeof execPath === 'string' && isJsEntrypoint(execPath)) {
    return { command: nodeExecPath, args: [execPath, ...options.args] }
  }
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args: [...options.args] }
}

function resolvePnpmCommand(
  options: ResolveManagerOptions,
  platform: NodeJS.Platform,
  nodeExecPath: string,
): ManagerCommand {
  const ambient = options.env.npm_execpath
  if (typeof ambient === 'string') {
    if (isPnpmJsEntrypoint(ambient)) {
      return { command: nodeExecPath, args: [ambient, ...options.args] }
    }
    if (!isJsEntrypoint(ambient) && isRegularFile(ambient)) {
      return { command: ambient, args: [...options.args] }
    }
  }
  return resolvePnpmFromPath(options, platform, nodeExecPath)
}

function resolvePnpmFromPath(
  options: ResolveManagerOptions,
  platform: NodeJS.Platform,
  nodeExecPath: string,
): ManagerCommand {
  const searchPath = options.envPath ?? options.env.PATH ?? ''
  const directories = searchPath.split(path.delimiter).filter((entry) => entry.length > 0)
  if (platform === 'win32') {
    return resolvePnpmWindows(directories, options.args, nodeExecPath, searchPath)
  }
  for (const directory of directories) {
    const candidate = path.join(directory, 'pnpm')
    if (!isRegularFile(candidate)) {
      continue
    }
    const resolved = realpathOrNull(candidate) ?? candidate
    if (isJsEntrypoint(resolved)) {
      return { command: nodeExecPath, args: [resolved, ...options.args] }
    }
    return { command: resolved, args: [...options.args] }
  }
  throw missingPnpmError(searchPath)
}

function resolvePnpmWindows(
  directories: string[],
  args: string[],
  nodeExecPath: string,
  searchPath: string,
): ManagerCommand {
  for (const directory of directories) {
    const shim = path.join(directory, 'pnpm.cmd')
    if (!isRegularFile(shim)) {
      continue
    }
    const entrypoint = resolvePnpmWindowsEntrypoint(directory)
    if (entrypoint !== undefined) {
      return { command: nodeExecPath, args: [entrypoint, ...args] }
    }
    return { command: shim, args: [...args], viaShell: true }
  }
  throw missingPnpmError(searchPath)
}

function resolvePnpmWindowsEntrypoint(shimDirectory: string): string | undefined {
  const candidates = [
    path.join(shimDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(shimDirectory, 'pnpm.cjs'),
  ]
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

function missingPnpmError(searchPath: string): Error {
  return new Error(
    `Unable to resolve the pnpm executable. Searched PATH: ${searchPath || '(empty)'}. ` +
      `Install the pinned pnpm with: ${PINNED_PNPM_REMEDIATION}`,
  )
}
