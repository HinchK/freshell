/**
 * Parse Windows `netstat -ano -p tcp` rows conservatively. Only an exact local
 * TCP LISTENING endpoint may identify a fixture owner; WebSocket connections
 * and peer endpoints are intentionally irrelevant to ownership.
 */
export function parseNetstatListeningPidsForPort(output: string, port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid fixture port ${port}`)
  }

  const acceptedLocalEndpoints = new Set([
    `127.0.0.1:${port}`,
    `0.0.0.0:${port}`,
    `*:${port}`,
    `[::1]:${port}`,
    `[::]:${port}`,
    `:::${port}`,
  ])
  const pids = new Set<number>()

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue
    if (fields[3].toUpperCase() !== 'LISTENING') continue
    if (!acceptedLocalEndpoints.has(fields[1])) continue
    const pidField = fields[4]
    if (!/^\d+$/.test(pidField)) continue
    const pid = Number.parseInt(pidField, 10)
    if (pid > 0) pids.add(pid)
  }

  return [...pids]
}
