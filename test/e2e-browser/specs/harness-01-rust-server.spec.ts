import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

/**
 * HARNESS-01 self-test.
 *
 * Proves the owned Rust-server fixture end to end:
 *   1. Boots the real `freshell-server` binary, drives the actual browser UI
 *      through a shell pane, and confirms real PTY output round-trips.
 *   2. Spawns an unrelated sentinel process OUTSIDE the fixture's process
 *      group before teardown.
 *   3. restart()s the SAME owned server against the SAME isolated home/port/
 *      token and proves the reconnected client is functionally alive (a
 *      fresh command still executes) -- not just stale DOM content.
 *   4. Captures the REAL PTY shell child PID(s) (via `server.ownedChildPids()`)
 *      while the post-restart server is confirmed alive, then stop()s the
 *      fixture and proves: the server PID is dead; its OWN process-group
 *      leader is dead (`kill(-pid, ...)`, which reaches same-group
 *      descendants only -- NOT the PTY shell, which `setsid()`s into its own
 *      session/group, see `rust-server.ts`'s class doc comment); EACH
 *      captured PTY child PID is individually dead (the assertion that
 *      actually proves Rust-side reaping, since it is untouched by
 *      group-kill and would catch a regression in the server's graceful
 *      SIGTERM shutdown / `PtyTerminal` `Drop`-kill path); the port is
 *      freed; and the unrelated sentinel is still alive.
 *   5. Proves the REAL `os.homedir()/.freshell` was never created or modified.
 */

async function selectFirstShellFromPicker(page: import('@playwright/test').Page): Promise<void> {
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return

  await page.waitForTimeout(500)
  const xtermVisibleAfterWait = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisibleAfterWait) return

  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      await button.click({ timeout: 5000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    } catch {
      continue
    }
  }

  throw new Error(`No shell option was visible in the pane picker. Checked: ${shellNames.join(', ')}`)
}

/** True if a new listener can bind the port (i.e. the OS has released it). */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

/** True if `pid` (or its process group, when `pid` is negative) is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

test.describe('HARNESS-01: owned Rust-server fixture', () => {
  test.setTimeout(180_000)

  test('boots, survives restart, and reaps only its own process group', async ({ page }) => {
    const realFreshellDir = path.join(os.homedir(), '.freshell')
    const realFreshellStatBefore = fs.existsSync(realFreshellDir)
      ? fs.statSync(realFreshellDir)
      : null
    // DEFLAKE (f3wp refresh, evidence /tmp/f3wp-refresh/e2e-rundiag{2,3}.log
    // and e2e-run8.log): on a host running a LIVE freshell (the self-hosted
    // server, other agents), the real ~/.freshell dir mtime moves for
    // reasons entirely outside this test -- config.json atomic rewrites
    // (~60s cadence observed) bump it even while the live server's logs
    // stay quiet, so NO temporal witness makes an mtime-equality assertion
    // attributable there (a logs-mtime witness was tried and still false-
    // positived in run8). The tripwire is therefore structural now:
    // - real ~/.freshell ABSENT before the test (CI / fresh host): strict --
    //   it must still be absent after; a HOME-resolution leak would have
    //   created it, and creation is fully attributable.
    // - real ~/.freshell PRE-EXISTING (shared live host): the mtime check is
    //   unattributable noise; assert POSITIVE isolation instead (the
    //   fixture's server demonstrably wrote its boot artifacts under the
    //   isolated home) and skip the real-home check with a note.

    const server = new RustServer({ verbose: false })
    const info = await server.start()

    // The fixture must never bind the user's real port.
    expect(info.port).not.toBe(3001)

    // Positive-isolation proof, captured while the isolated HOME still
    // exists (stop() deletes it before step 5 runs): the server resolved the
    // isolated home for its env-pinned log dir and wrote its boot log there.
    const isolatedBootLogExisted = fs.existsSync(
      path.join(info.homeDir, '.freshell', 'logs', 'rust-server.jsonl'),
    )

    let sentinel: ChildProcess | null = null

    try {
      // --- (1) drive the real UI through a shell pane and prove real PTY I/O ---
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)

      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectFirstShellFromPicker(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const marker1 = `HARNESS01-MARKER-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker1}`)
      await terminal.waitForOutput(marker1, { timeout: 20_000 })

      // --- (2) spawn a sentinel OUTSIDE this fixture's process group ---
      sentinel = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      sentinel.unref()
      const sentinelPid = sentinel.pid
      if (!sentinelPid) throw new Error('sentinel failed to spawn (no pid)')
      expect(isProcessAlive(sentinelPid)).toBe(true)

      // --- (3) restart the SAME owned server against the SAME home/port/token ---
      const priorPort = info.port
      const priorPid = info.pid
      await server.restart()
      expect(server.info.port).toBe(priorPort)
      expect(server.info.homeDir).toBe(info.homeDir)
      // A genuinely fresh OS process must have a different pid than before.
      expect(server.info.pid).not.toBe(priorPid)

      await expect(async () => {
        const status = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 30_000 })

      // DEFLAKE (f3wp council round 2, optional-but-cheap): the isolation
      // proof above was captured from the FIRST boot only, so a HOME leak
      // introduced specifically by the restart cycle (e.g. a code path that
      // re-resolves HOME on restart() and gets it wrong) would be invisible
      // on a live host, where the "real ~/.freshell pre-exists" branch below
      // only checks POSITIVE isolation, never NEGATIVE (that nothing new
      // leaked into the real home during restart). Re-stat post-restart,
      // while the isolated home still exists (stop() deletes it), so the
      // fixture's own restart write is re-confirmed under the isolated home.
      const isolatedBootLogExistedAfterRestart = fs.existsSync(
        path.join(info.homeDir, '.freshell', 'logs', 'rust-server.jsonl'),
      )

      // Prove the reconnected terminal is FUNCTIONALLY alive (not just
      // showing stale pre-restart DOM content): a brand-new command must
      // still execute correctly after the client recreates/reattaches.
      // Budget note: 60s, not 20s. The assertion is unchanged (the marker
      // MUST appear); only the wait budget grew. Under a full-project run
      // this spec shares the host with ~14 parallel workers each spawning
      // rust servers (and cargo build-lock contention), and the
      // post-restart recreate/reattach round-trip was observed to
      // legitimately exceed 20s under that load (2026-07-26).
      // CORRECTED (f3wp council fix round): the earlier claim that this leg
      // was "passing comfortably in isolation" did not make it reliably
      // green under full-project load -- it still timed out at 60s in this
      // branch's own acceptance run (/tmp/deflake-logs/e2eb-10x-run10.log:1089,
      // "TimeoutError: page.waitForFunction: Timeout 60000ms exceeded"). A
      // bare timeout there is not diagnosable: it cannot distinguish a
      // wedged reattach (WS/redux never reached ready) from a dead PTY
      // (server-side child gone) from a swallowed echo (everything alive,
      // buffer just missing the marker). The catch below dumps exactly
      // that state before rethrowing. The spec-level test.setTimeout(180_000)
      // already anticipated slow full-suite runs.
      // DEFLAKE (f3wp refresh, evidence /tmp/f3wp-refresh/e2e-rundiag1.log):
      // under load the FIRST post-restart command can arrive at the PTY with
      // its HEAD truncated (buffer showed the marker's uuid TAIL plus
      // "command not found" -- the leading "echo HARNESS01-..." bytes were
      // dropped while the pane was still recreating/reattaching). The
      // contract is "the recreated pane round-trips a command", not "no
      // input byte is ever dropped mid-reattach", so retry with a DISTINCT
      // marker per attempt (a stale partial echo of attempt N can never
      // satisfy attempt N+1). NOTE: the head-truncation itself is a
      // possible product-level issue (typed input during the recreate
      // window can be silently lost) -- recorded in the verification
      // report; this loop only de-flakes the harness contract.
      let roundTripped = false
      // DEFLAKE (f3wp council round 2, B4): the prior version kept only the
      // LAST attempt's error, silently discarding earlier ones. When all 3
      // attempts fail for genuinely different reasons (e.g. attempt 1
      // head-truncated, attempt 2 wedged, attempt 3 timed out clean), the
      // final thrown diagnostic must show every attempt's failure, not just
      // the last -- otherwise the reported cause can be actively misleading
      // about what actually happened on earlier attempts.
      const attemptErrors: unknown[] = []
      for (let attempt = 1; attempt <= 3 && !roundTripped; attempt++) {
        const marker = `HARNESS01-POST-RESTART-${attempt}-${randomUUID()}`
        try {
          await terminal.executeCommand(`echo ${marker}`)
          await terminal.waitForOutput(marker, { timeout: 30_000 })
          roundTripped = true
        } catch (attemptError) {
          // eslint-disable-next-line no-console
          console.log(`[harness-01] post-restart round-trip attempt ${attempt} failed: ${attemptError}`)
          attemptErrors.push(attemptError)
        }
      }
      try {
        if (!roundTripped) {
          throw new Error(
            attemptErrors.length
              ? `post-restart round-trip failed after ${attemptErrors.length} attempt(s) -- ` +
                attemptErrors.map((err, i) => `[attempt ${i + 1}] ${err}`).join(' | ')
              : 'post-restart round-trip never attempted',
          )
        }
      } catch (error) {
        const wsReadyState = await page
          .evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() ?? '<harness missing>')
          .catch((evalError) => `<eval failed: ${evalError}>`)
        const connectionStatus = await harness.getConnectionStatus().catch((evalError) => `<eval failed: ${evalError}>`)
        const bufferTail = await terminal
          .getVisibleText()
          .then((text) => text.slice(-500))
          .catch((evalError) => `<eval failed: ${evalError}>`)
        const childPidsNow = server.ownedChildPids()
        const childLiveness = childPidsNow.length
          ? childPidsNow.map((pid) => `${pid}:${isProcessAlive(pid) ? 'alive' : 'dead'}`).join(', ')
          : '<none captured>'
        const serverPidAlive = isProcessAlive(server.info.pid)
        throw new Error(
          `post-restart marker2 wait failed -- diagnostics: ` +
            `wsReadyState=${JSON.stringify(wsReadyState)} connectionStatus=${JSON.stringify(connectionStatus)} ` +
            `serverPidAlive=${serverPidAlive} childPids=[${childLiveness}] ` +
            `bufferTail=${JSON.stringify(bufferTail)}. Original error: ${error}`,
        )
      }

      const xtermText = await page.locator('.xterm').first().textContent()
      expect(xtermText).not.toContain('[Error]')

      // --- capture the REAL PTY shell child PID(s) BEFORE stop() ---
      // `kill(-pid, ...)` cannot reach these (PTY shells `setsid()` into
      // their OWN session/group -- see `rust-server.ts`'s class doc
      // comment), so this is the only assertion below that actually proves
      // Rust-side child reaping and would catch a regression in it.
      const childPidsBeforeStop = server.ownedChildPids()
      // Non-empty, or the "each child is dead" assertion below would be
      // vacuously true even if reaping were completely broken.
      expect(childPidsBeforeStop.length).toBeGreaterThan(0)

      // --- (4) stop() and prove full process-group reap + port release ---
      const finalPid = server.info.pid
      await server.stop()

      expect(isProcessAlive(finalPid)).toBe(false)
      // Negative pid confirms the server's OWN process-group leader is dead.
      // This does NOT cover the PTY shell child -- it lives in a SEPARATE
      // session/group it created for itself, invisible to `kill(-pid, ...)`.
      expect(isProcessAlive(-finalPid)).toBe(false)
      // The PTY child reap proof: each PID captured above (real descendants
      // of the server, confirmed non-empty above) must now be dead. This is
      // reaped by the Rust server's OWN graceful SIGTERM shutdown (`Drop`
      // kill by exact PID), backstopped by the fixture's post-signal sweep
      // for the SIGKILL-escalation edge case -- either way, if Rust-side
      // child reaping regresses, this loop is what catches it.
      for (const childPid of childPidsBeforeStop) {
        expect(isProcessAlive(childPid)).toBe(false)
      }
      await expect(async () => {
        expect(await isPortFree(priorPort)).toBe(true)
      }).toPass({ timeout: 10_000 })

      // The unrelated sentinel must have survived the fixture's teardown --
      // proof that stop() reaped only its OWN process group.
      expect(isProcessAlive(sentinelPid)).toBe(true)
    } finally {
      if (sentinel?.pid && isProcessAlive(sentinel.pid)) {
        try {
          process.kill(sentinel.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      await server.stop().catch(() => {})
    }

    // --- (5) prove the REAL ~/.freshell was never created or modified ---
    const realFreshellStatAfter = fs.existsSync(realFreshellDir)
      ? fs.statSync(realFreshellDir)
      : null

    if (realFreshellStatBefore === null) {
      // Fresh host / CI: creation of the real ~/.freshell IS the leak, and
      // nothing else on the host could have created it -- fully attributable.
      expect(realFreshellStatAfter).toBeNull()
    } else {
      // Shared live host: see the rationale where realFreshellStatBefore is
      // captured -- mtime equality is unattributable here. Positive
      // isolation proof instead: the fixture's server resolved the ISOLATED
      // home for its state and the env-pinned log dir (its boot log exists
      // there), which a HOME-resolution regression would break.
      expect(realFreshellStatAfter).not.toBeNull()
      expect(isolatedBootLogExisted).toBe(true)
      // Covers the restart cycle specifically (see capture-site comment
      // above): without this, a restart-time HOME leak would be invisible
      // on exactly the hosts where this branch runs.
      expect(isolatedBootLogExistedAfterRestart).toBe(true)
      console.log(
        '[harness-01] real ~/.freshell pre-exists on this host (live freshell likely active) -- ' +
          'strict real-home mtime tripwire skipped as unattributable; isolated-home boot artifacts verified instead.',
      )
    }
  })
})
