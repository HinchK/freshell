#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
} from './lib/package-manager.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')

export interface ElectronDevPrerequisitePaths {
  serverBinary: string
  clientDir: string
  clientIndex: string
  mcpEntry: string
}

export interface ElectronDevPrerequisitePhase {
  command: string
  args: string[]
  viaShell?: boolean
}

export type ElectronDevCommandRunner = (
  phase: ElectronDevPrerequisitePhase,
  cwd: string,
) => void

export interface ElectronDevSpawnOptions {
  cwd: string
  shell: boolean
  stdio: 'inherit'
  windowsHide: boolean
}

export interface ElectronDevSpawnResult {
  error?: Error
  signal: NodeJS.Signals | null
  status: number | null
}

export type ElectronDevSpawn = (
  command: string,
  args: string[],
  options: ElectronDevSpawnOptions,
) => ElectronDevSpawnResult

const defaultSpawn: ElectronDevSpawn = (command, args, options) =>
  spawnSync(command, args, options)

const ELECTRON_DEV_SCRIPTS = ['prebuild', 'build:client', 'build:tools', 'build:rust'] as const

export interface BuildElectronDevPrerequisitePhaseOptions {
  projectRoot?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export function buildElectronDevPrerequisitePhases(
  managerCommand?: string,
  options: BuildElectronDevPrerequisitePhaseOptions = {},
): ElectronDevPrerequisitePhase[] {
  if (managerCommand !== undefined) {
    return ELECTRON_DEV_SCRIPTS.map((script) => ({ command: managerCommand, args: ['run', script] }))
  }
  const projectRoot = options.projectRoot ?? PROJECT_ROOT
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const manager = detectProjectManager(projectRoot).manager
  return ELECTRON_DEV_SCRIPTS.map((script) => {
    const resolved = resolveManagerCommand({
      manager,
      args: buildRunScriptArgs(manager, script, []),
      env,
      platform,
    })
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.viaShell === true ? { viaShell: true } : {}),
    }
  })
}

export function resolveElectronDevPrerequisitePaths(
  projectRoot: string = PROJECT_ROOT,
  platform: NodeJS.Platform = process.platform,
): ElectronDevPrerequisitePaths {
  const root = path.resolve(projectRoot)
  const executable = platform === 'win32' ? 'freshell-server.exe' : 'freshell-server'
  const clientDir = path.join(root, 'dist', 'client')

  return {
    serverBinary: path.join(root, 'target', 'release', executable),
    clientDir,
    clientIndex: path.join(clientDir, 'index.html'),
    mcpEntry: path.join(root, 'dist', 'tools', 'freshell-mcp', 'server.js'),
  }
}

export function runElectronDevCommand(
  phase: ElectronDevPrerequisitePhase,
  cwd: string,
  spawn: ElectronDevSpawn = defaultSpawn,
): void {
  let result: ElectronDevSpawnResult
  try {
    result = spawn(phase.command, phase.args, {
      cwd,
      shell: phase.viaShell ?? false,
      stdio: 'inherit',
      windowsHide: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${phase.command} ${phase.args.join(' ')} failed to start: ${message}`)
  }

  if (result.error) {
    throw new Error(`${phase.command} ${phase.args.join(' ')} failed to start: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`
    throw new Error(`${phase.command} ${phase.args.join(' ')} failed with ${reason}`)
  }
}

export interface RunElectronDevPrerequisitesOptions {
  projectRoot?: string
  platform?: NodeJS.Platform
  managerCommand?: string
  env?: NodeJS.ProcessEnv
  runCommand?: ElectronDevCommandRunner
  spawn?: ElectronDevSpawn
  pathExists?: (filePath: string) => boolean
}

export function runElectronDevPrerequisites({
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  managerCommand,
  env,
  runCommand: injectedCommandRunner,
  spawn: injectedSpawn = defaultSpawn,
  pathExists = existsSync,
}: RunElectronDevPrerequisitesOptions = {}): ElectronDevPrerequisitePaths {
  const root = path.resolve(projectRoot)
  const paths = resolveElectronDevPrerequisitePaths(root, platform)
  const phases = buildElectronDevPrerequisitePhases(managerCommand, {
    projectRoot: root,
    platform,
    env,
  })
  const commandRunner = injectedCommandRunner ?? ((phase: ElectronDevPrerequisitePhase, cwd: string) =>
    runElectronDevCommand(phase, cwd, injectedSpawn))

  for (const phase of phases) {
    commandRunner(phase, root)
  }

  const requiredOutputs: Array<[string, string]> = [
    ['release Rust server', paths.serverBinary],
    ['static client', paths.clientIndex],
    ['MCP tool bundle', paths.mcpEntry],
  ]
  const missingOutputs = requiredOutputs
    .filter(([, filePath]) => !pathExists(filePath))
    .map(([name, filePath]) => `${name} (${filePath})`)

  if (missingOutputs.length > 0) {
    throw new Error(`Electron dev prerequisites missing: ${missingOutputs.join(', ')}`)
  }

  return paths
}

function logError(error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'electron-dev-prerequisites',
    event: 'prerequisites_failed',
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runElectronDevPrerequisites()
  } catch (error) {
    logError(error)
    process.exitCode = 1
  }
}
