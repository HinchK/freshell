import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GlobalSetupContext } from 'vitest/node'
import { resolveManagerExecFileCommand } from './manager-command.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

interface EnsureBuiltRuntimeDeps {
  spawnSync: typeof spawnSync
  rmSync: typeof fs.rmSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

interface InstallBuiltRuntimeRefreshDeps {
  ensureBuiltRuntime: (projectRoot: string) => void
}

export function ensureBuiltRuntime(
  projectRoot: string,
  deps: EnsureBuiltRuntimeDeps = {
    spawnSync,
    rmSync: fs.rmSync,
    env: process.env,
    platform: process.platform,
  },
): void {
  const env = {
    ...deps.env,
    NODE_ENV: 'production',
  }
  const prebuild = resolveManagerExecFileCommand(['run', 'prebuild'], deps.env, deps.platform, process.execPath, projectRoot)
  deps.spawnSync(prebuild.command, prebuild.args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: prebuild.viaShell ?? false,
  })
  deps.rmSync(path.join(projectRoot, 'dist', '.env'), { force: true })
  const client = resolveManagerExecFileCommand(['run', 'build:client'], deps.env, deps.platform, process.execPath, projectRoot)
  deps.spawnSync(client.command, client.args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: client.viaShell ?? false,
  })
  deps.spawnSync('cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  })
}

export function installBuiltRuntimeRefresh(
  project: Pick<GlobalSetupContext, 'onTestsRerun'>,
  projectRoot: string,
  deps: InstallBuiltRuntimeRefreshDeps = {
    ensureBuiltRuntime: (root) => ensureBuiltRuntime(root),
  },
): void {
  deps.ensureBuiltRuntime(projectRoot)
  project.onTestsRerun(() => {
    deps.ensureBuiltRuntime(projectRoot)
  })
}

export default async function globalSetup(project: GlobalSetupContext): Promise<void> {
  installBuiltRuntimeRefresh(project, PROJECT_ROOT)
}
