import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectProjectManager,
  resolveManagerCommand,
} from '../../scripts/lib/package-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_PROJECT_PATH = path.resolve(__dirname, '../..')

export type ManagerExecFileCommand = {
  command: string
  args: string[]
  viaShell?: boolean
}

export function resolveManagerExecFileCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  nodeExecPath = process.execPath,
  projectPath = DEFAULT_PROJECT_PATH,
): ManagerExecFileCommand {
  const manager = detectProjectManager(projectPath).manager
  return resolveManagerCommand({ manager, args, env, platform, nodeExecPath })
}
