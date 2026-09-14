#!/usr/bin/env tsx

/** Build the Electron E2E client from this checkout before launching it. */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { computeClientBuildId } from '../config/vite/build-id.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')

export function clientArtifactContainsBuildId(clientDir: string, buildId: string): boolean {
  const pending = [clientDir]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
      } else if (entry.isFile() && fs.readFileSync(entryPath, 'utf8').includes(buildId)) {
        return true
      }
    }
  }
  return false
}

export function runElectronE2ePreflight(root = PROJECT_ROOT): string {
  const buildId = computeClientBuildId(root)
  if (!/^[0-9a-f]{40}$/.test(buildId)) {
    throw new Error(`Electron E2E requires a verifiable checkout build id, received ${buildId}`)
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['run', 'build:client'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`Electron E2E client preflight failed (exit ${result.status ?? result.signal ?? 'unknown'})`)
  }

  // The launcher itself is executed from dist/electron. Rebuild it too, so
  // the chooser lifecycle under test is the source checkout paired with the
  // freshly stamped client rather than a stale compiled main process.
  const electronBuild = spawnSync(npm, ['run', 'build:electron'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (electronBuild.status !== 0) {
    throw new Error(`Electron E2E launcher preflight failed (exit ${electronBuild.status ?? electronBuild.signal ?? 'unknown'})`)
  }

  const rustBuild = spawnSync('cargo', ['build', '-p', 'freshell-server', '--locked'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (rustBuild.status !== 0) {
    throw new Error(`Electron E2E Rust preflight failed (exit ${rustBuild.status ?? rustBuild.signal ?? 'unknown'})`)
  }

  const clientDir = path.join(root, 'dist', 'client')
  if (!clientArtifactContainsBuildId(clientDir, buildId)) {
    throw new Error(`Electron E2E client artifact does not contain exact build id ${buildId}`)
  }
  return buildId
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const buildId = runElectronE2ePreflight()
  const playwright = path.join(PROJECT_ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
  const result = spawnSync(process.execPath, [playwright, 'test', '--config', 'test/e2e-electron/playwright.electron.config.ts', ...argv], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, FRESHELL_ELECTRON_E2E_BUILD_ID: buildId },
    stdio: 'inherit',
    windowsHide: true,
  })
  return result.status ?? 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
