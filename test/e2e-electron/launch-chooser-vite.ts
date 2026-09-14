import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

function readinessUrl(port: number): string {
  return `http://localhost:${port}/`
}

export function launchChooserViteArgs(viteRoot: string, projectRoot: string, port: number): string[] {
  return [
    path.join(viteRoot, 'vite/bin/vite.js'),
    '--config', path.join(projectRoot, 'config/vite/vite.launch-chooser.config.ts'),
    '--port', String(port), '--strictPort',
  ]
}

/**
 * Wait for the Vite process we spawned to publish its own local readiness
 * line. A listener on the configured port alone is not evidence that this
 * child owns it: another process could have already answered there.
 */
export async function waitForCapturedViteReady(
  child: ChildProcess,
  port: number,
  timeoutMs = 30_000,
): Promise<void> {
  if (!child.stdout || !child.stderr) {
    throw new Error('captured chooser Vite has no stdout/stderr pipes for readiness proof')
  }

  await new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    const appendOutput = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-8_192)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      error ? reject(error) : resolve()
    }
    const exitedBeforeReady = (code: number | null, signal: NodeJS.Signals | null) =>
      new Error(`captured chooser Vite exited before ready (${code ?? signal ?? 'unknown'}); output: ${output || '(none)'}`)
    const onStdout = (chunk: Buffer | string) => {
      appendOutput(chunk)
      if (output.includes(readinessUrl(port))) finish()
    }
    const onStderr = (chunk: Buffer | string) => appendOutput(chunk)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(exitedBeforeReady(code, signal))
    const timer = setTimeout(() => finish(new Error(
      `captured chooser Vite did not become ready on ${port}; output: ${output || '(none)'}`,
    )), timeoutMs)

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', onExit)
    // The child can exit between spawn() and listener attachment.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(exitedBeforeReady(child.exitCode, child.signalCode))
    }
  })
}
