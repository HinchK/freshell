import net from 'node:net'

export interface OwnedServerReceipt {
  pid: number
  port: number
}

export interface OwnedServerHandle {
  stop(): Promise<void>
}

export interface OwnedServerTeardownProbes {
  waitForPidGone(pid: number): Promise<boolean>
  isPortFree(port: number): Promise<boolean>
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export async function waitForPidGone(pid: number, budgetMs = 10_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    if (!isPidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isPidAlive(pid)
}

/** True only when a fresh loopback listener can bind the fixture's exact port. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.once('error', () => resolve(false))
    listener.listen(port, '127.0.0.1', () => {
      listener.close(() => resolve(true))
    })
  })
}

/**
 * Stop the exact server the fixture spawned, then prove its exact PID and
 * bound port are gone. All probes run even if stop() fails so teardown never
 * trades cleanup completeness for error visibility.
 */
export async function stopOwnedServerAndVerify(
  server: OwnedServerHandle,
  receipt: OwnedServerReceipt,
  probes: OwnedServerTeardownProbes = { waitForPidGone, isPortFree },
): Promise<void> {
  const failures: Error[] = []

  try {
    await server.stop()
  } catch (error) {
    failures.push(new Error(`owned server PID ${receipt.pid} stop failed`, { cause: error }))
  }

  try {
    if (!await probes.waitForPidGone(receipt.pid)) {
      failures.push(new Error(`owned server PID ${receipt.pid} is still alive after stop()`))
    }
  } catch (error) {
    failures.push(new Error(`could not verify owned server PID ${receipt.pid} stopped`, { cause: error }))
  }

  try {
    if (!await probes.isPortFree(receipt.port)) {
      failures.push(new Error(`owned server port ${receipt.port} is still bound after stop()`))
    }
  } catch (error) {
    failures.push(new Error(`could not verify owned server port ${receipt.port} was released`, { cause: error }))
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `owned server teardown failed for PID ${receipt.pid}, port ${receipt.port}`)
  }
}
