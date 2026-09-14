/**
 * Parse `ss -ltnp` output conservatively. The local endpoint is the fourth
 * whitespace-separated column; peer endpoints and arbitrary text must never
 * satisfy an ownership proof for the fixture port.
 */
export function parseSsListeningPidsForPort(output: string, port: number): number[] {
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
    if (fields.length < 5 || fields[0].toUpperCase() !== 'LISTEN') continue
    if (!acceptedLocalEndpoints.has(fields[3])) continue
    for (const match of line.matchAll(/\bpid=(\d+)\b/g)) {
      const pid = Number.parseInt(match[1], 10)
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
  }

  return [...pids]
}
