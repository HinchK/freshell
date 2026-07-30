import fsp from 'node:fs/promises'
import path from 'node:path'

export interface ClaudeTranscriptHit {
  sessionId: string
  sourceFile: string
  cwd?: string
}

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Exact-id fallback for claude sessions the index cannot see (e.g. cold-start
 * skipped cwd-less transcripts). Scans <projectsDir>/<project>/<id>.jsonl.
 */
export async function locateClaudeTranscript(
  sessionId: string,
  projectsDir: string,
): Promise<ClaudeTranscriptHit | null> {
  const normalized = sessionId.toLowerCase()
  if (!UUID_ONLY_RE.test(normalized)) return null

  let entries: string[]
  try {
    entries = await fsp.readdir(projectsDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, `${normalized}.jsonl`)
    try {
      const stat = await fsp.stat(candidate)
      if (!stat.isFile()) continue
    } catch {
      continue
    }
    return {
      sessionId: normalized,
      sourceFile: candidate,
      cwd: await readCwdFromTranscript(candidate),
    }
  }
  return null
}

async function readCwdFromTranscript(filePath: string): Promise<string | undefined> {
  let head: string
  try {
    const handle = await fsp.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { cwd?: unknown }
      if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) return parsed.cwd
    } catch {
      continue // truncated tail line etc.
    }
  }
  return undefined
}
