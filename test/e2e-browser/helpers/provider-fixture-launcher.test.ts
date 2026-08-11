// Unit tests for the HARNESS-03 provider-fixture launcher
// (`provider-fixture-launcher.ts`): the child-process inspection helper the
// hermeticity asserts are built on, and the readiness-marker contract the
// server-kind fixtures print after their listener is bound (the contract the
// Playwright scrub legs rely on when they connect).
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { childPidsOf, launchProviderFixture } from './provider-fixture-launcher.js'

function killTree(proc: ChildProcess | undefined): void {
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

describe('childPidsOf', () => {
  it('returns [] for a live process with zero children', async () => {
    // Regression reproducer for the verifier red: Linux `ps -o pid= --ppid
    // <pid>` EXITS 1 when the match set is empty, so an execFileSync-based
    // implementation throws exactly on the hermeticity success path.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' })
    try {
      expect(childPidsOf(child.pid ?? -1)).toEqual([])
    } finally {
      killTree(child)
    }
  })

  it('returns [] for a dead pid (the fixture may have already exited)', async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise<void>((resolve) => dead.on('exit', () => resolve()))
    expect(childPidsOf(dead.pid ?? -1)).toEqual([])
  })

  // Load-bearing pin: the hermeticity assertion can only FAIL loudly if
  // childPidsOf actually reports live children.
  it.skipIf(process.platform !== 'linux')('reports live children of the inspected process', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        'const { spawn } = require("node:child_process")' +
          '; spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" })' +
          '; setTimeout(() => {}, 30_000)',
      ],
      { stdio: 'ignore' },
    )
    try {
      let children: number[] = []
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        children = childPidsOf(parent.pid ?? -1)
        if (children.length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(children).toHaveLength(1)
      for (const pid of children) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // grandchild already gone
        }
      }
    } finally {
      killTree(parent)
    }
  })
})

// Readiness-marker contract: every server-kind fixture prints its
// "listening on …" line only AFTER the listener is bound, so a client built
// once the marker appears in launcher-captured stdout connects successfully.
// (The verifier's red was a spec-side connect-before-marker; these pins keep
// the fixture side of the contract the fix relies on.)
describe('fixture readiness markers (scrub environment)', () => {
  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close(() => resolve(port))
      })
    })
  }

  it('codex app-server: the "listening on" marker means the WS port accepts connections', async () => {
    const port = await freePort()
    const listen = `ws://127.0.0.1:${port}`
    const fixture = await launchProviderFixture({
      fixture: 'fake-codex-app-server.mjs',
      args: ['--listen', listen],
      scrub: true,
    })
    try {
      await fixture.waitOutput('listening on')
      const ws = new WebSocket(listen)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      ws.close()
    } finally {
      await fixture.stop()
    }
  })

  it('opencode server: the "listening on" marker means the HTTP/SSE surface answers', async () => {
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const fixture = await launchProviderFixture({
      fixture: 'fake-opencode-server.mjs',
      args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      scrub: true,
    })
    try {
      await fixture.waitOutput('listening on')
      const controller = new AbortController()
      const response = await fetch(`${base}/event`, { signal: controller.signal })
      expect(response.ok).toBe(true)
      controller.abort()
    } finally {
      await fixture.stop()
    }
  })
})
