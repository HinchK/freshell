import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { launchChooserViteArgs, waitForCapturedViteReady } from '../../e2e-electron/launch-chooser-vite.js'

class CapturedViteChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

describe('app-bound chooser Vite ownership', () => {
  it('uses the fixture-selected strict port, so a foreign 5175 responder cannot be accepted', () => {
    const args = launchChooserViteArgs('/fixture/node_modules', '/fixture', 45123)
    expect(args).toContain('--strictPort')
    expect(args).toContain('--port')
    expect(args).toContain('45123')
    expect(args).not.toContain('5175')
  })

  it('accepts only readiness emitted by the captured child for the selected port', async () => {
    const child = new CapturedViteChild()
    const ready = waitForCapturedViteReady(child as unknown as ChildProcess, 45123, 1_000)
    child.stdout.write('  ➜  Local:   http://localhost:45123/\n')
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects an exiting captured child even if a foreign responder could answer the old port', async () => {
    const child = new CapturedViteChild()
    const ready = waitForCapturedViteReady(child as unknown as ChildProcess, 45123, 1_000)
    child.stdout.write('  ➜  Local:   http://localhost:5175/\n')
    child.exitCode = 1
    child.emit('exit', 1, null)
    await expect(ready).rejects.toThrow('captured chooser Vite exited before ready (1)')
  })
})
