import process from 'node:process'
import fsp from 'node:fs/promises'

import { PHASE_WATCHDOG_EXIT_CODE, spawnAndWait } from '../../../scripts/testing/coordinator-upstream.js'

const fixturePath = process.argv[2]
const sentinelPath = process.argv[3]

let observedChildPid: number | undefined

const exitCode = await spawnAndWait(
  process.execPath,
  [fixturePath, JSON.stringify({ selector: 'driver-child' })],
  {
    ...process.env,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({ default: { holdMs: 60_000 } }),
  },
  false,
  // Simulate the lost-completion class: the OS-level liveness answer is
  // "gone" while the child is really alive for a full minute, so the native
  // exit callback cannot arrive to close the handle during the case.
  { livenessProbe: (pid) => { observedChildPid = pid; return false } },
)

if (exitCode !== PHASE_WATCHDOG_EXIT_CODE) {
  await fsp.writeFile(sentinelPath, JSON.stringify({ status: 'DRIVER_UNEXPECTED_EXIT', exitCode })).catch(() => {})
  process.exit(1)
}

// Sentinel file, not stdout: the fixture child inherits this process's
// stdio, so a pipe-based DONE signal would couple the driver's observable
// completion to the child's much-later death.
await fsp.writeFile(sentinelPath, JSON.stringify({ status: 'DRIVER_DONE', childPid: observedChildPid }))

// No explicit process.exit: with the settled child's handle unreferenced,
// the event loop drains and this process terminates on its own while the
// child is still alive. A leaked ChildProcess handle would keep this
// process wedged until the child's 60s hold expires — the e2e case's 10s
// prompt-exit bound fails exactly that regression.
