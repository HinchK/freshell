import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const payload = JSON.parse(process.argv[2] ?? '{}')
const behaviorMap = JSON.parse(process.env.FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR ?? '{}')
const captureFile = process.env.FRESHELL_TEST_COORDINATOR_CAPTURE_FILE
const behavior = behaviorMap[payload.selector] ?? behaviorMap.default ?? {}

if (captureFile) {
  await fs.mkdir(path.dirname(captureFile), { recursive: true }).catch(() => {})
  await fs.appendFile(
    captureFile,
    `${JSON.stringify({
      selector: payload.selector,
      command: payload.command,
      args: payload.args,
      pid: process.pid,
      active: process.env.FRESHELL_TEST_COORDINATOR_ACTIVE,
    })}\n`,
  )
}

if (behavior.spawnDescendant) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore',
  })
  if (captureFile) {
    await fs.appendFile(
      captureFile,
      `${JSON.stringify({
        selector: payload.selector,
        role: 'descendant',
        pid: descendant.pid ?? null,
      })}\n`,
    )
  }
}

if (behavior.stdout) {
  process.stdout.write(String(behavior.stdout))
}

if (behavior.stderr) {
  process.stderr.write(String(behavior.stderr))
}

if (typeof behavior.holdMs === 'number' && behavior.holdMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, behavior.holdMs))
}

if (behavior.signal) {
  process.kill(process.pid, String(behavior.signal))
  await new Promise(() => {})
}

process.exit(Number.isInteger(behavior.exitCode) ? behavior.exitCode : 0)
