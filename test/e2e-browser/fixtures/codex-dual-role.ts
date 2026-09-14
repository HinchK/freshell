import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const FAKE_CODEX_APP_SERVER = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Install a DUAL-ROLE `codex` binary into `binDir`: argv containing
 * `app-server` routes to the shared fake app-server; everything else execs
 * the given terminal fake (`terminalSource`, an .mjs path). Returns the shim
 * path (to be set as CODEX_CMD).
 *
 * Required by the Rust server's codex terminal lane v2: the lane boots a
 * `codex app-server` sidecar FIRST, spawned from the SAME CODEX_CMD. A
 * terminal-only fake exits 0 instantly on that spawn (stdin is /dev/null),
 * so every codex pane create fails PTY_SPAWN_FAILED ("codex app-server
 * exited before listening: exit status: 0"). Any rust e2e spec that creates
 * a codex TERMINAL pane must use this helper (or an equivalent shim — see
 * restore-contract-wall-rust's installDualRoleCodex, which additionally
 * overrides CODEX_HOME for rollout writes).
 */
export async function installDualRoleCodexCli(
  binDir: string,
  terminalSource: string,
  terminalEnv?: Record<string, string>,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  const terminalEnvExtra = JSON.stringify(terminalEnv ?? {})
  const script = `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const argv = process.argv.slice(2)
const appServer = argv.includes('app-server')
const target = appServer ? ${JSON.stringify(FAKE_CODEX_APP_SERVER)} : ${JSON.stringify(terminalSource)}
const childEnv = appServer ? process.env : { ...process.env, ...${terminalEnvExtra} }
const child = spawn(process.execPath, [target, ...argv], { stdio: 'inherit', env: childEnv })
let stopping = false
let killTimer

function stopChild(signal) {
  if (stopping) return
  stopping = true
  if (child.exitCode !== null) return
  // The shim owns this exact ChildProcess. Forwarding only to it is portable
  // and cannot accidentally signal the parent Vitest process or a sibling
  // fixture, unlike a process-group signal.
  try {
    child.kill(signal)
  } catch {
    return
  }
  killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // The exact child exited between the observation and the escalation.
      }
    }
  }, 1_000)
  killTimer.unref()
}

function clearSignalHandlers() {
  if (killTimer) clearTimeout(killTimer)
  process.off('SIGTERM', onSigterm)
  process.off('SIGINT', onSigint)
  process.off('SIGHUP', onSighup)
}

function onSigterm() { stopChild('SIGTERM') }
function onSigint() { stopChild('SIGINT') }
function onSighup() { stopChild('SIGHUP') }

process.once('SIGTERM', onSigterm)
process.once('SIGINT', onSigint)
process.once('SIGHUP', onSighup)

child.once('error', () => {
  clearSignalHandlers()
  process.exitCode = 1
})

child.once('exit', (code) => {
  clearSignalHandlers()
  process.exitCode = code ?? 1
})
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}
