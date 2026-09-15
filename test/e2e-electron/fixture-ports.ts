/** Allocate fixture ports without reusing a port already selected for the same fixture. */
export async function allocateDistinctFixturePorts(
  count: number,
  allocatePort: () => Promise<number>,
  maxAttempts = count * 100,
): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error('fixture port count must be a positive integer')
  const ports: number[] = []
  const allocated = new Set<number>()
  for (let attempts = 0; ports.length < count; attempts += 1) {
    if (attempts >= maxAttempts) {
      throw new Error(`could not allocate ${count} distinct fixture ports after ${maxAttempts} attempts`)
    }
    const port = await allocatePort()
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`fixture port allocator returned invalid port ${port}`)
    }
    if (allocated.has(port)) continue
    allocated.add(port)
    ports.push(port)
  }
  return ports
}
