import type { ProjectGroup } from '../coding-cli/types.js'
import { hasSessionDirectorySnapshotChange } from '../session-directory/projection.js'

type SessionsSyncWs = {
  broadcastSessionsChanged: (revision: number) => void
}

/**
 * The session-directory-visible color of each project (a project with no
 * color configured is indistinguishable from a run where it never existed
 * — canonicalized the same way as `sessions-sync/diff.ts`'s
 * `(a.color || '') !== (b.color || '')`).
 */
function projectColorMap(projects: ProjectGroup[]): Map<string, string> {
  const colors = new Map<string, string>()
  for (const project of projects) {
    if (project.color) colors.set(project.projectPath, project.color)
  }
  return colors
}

function projectColorMapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [projectPath, color] of a) {
    if (b.get(projectPath) !== color) return false
  }
  return true
}

type SessionsSyncOptions = { coalesceMs?: number }

function parseCoalesceMs(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

export class SessionsSyncService {
  private last: ProjectGroup[] = []
  private hasLast = false
  private pendingTrailing: ProjectGroup[] | null = null
  private timer: NodeJS.Timeout | null = null
  private coalesceMs: number
  private revision = 0

  constructor(
    private ws: SessionsSyncWs,
    options: SessionsSyncOptions = {}
  ) {
    this.coalesceMs = parseCoalesceMs(options.coalesceMs ?? process.env.SESSIONS_SYNC_COALESCE_MS ?? 150)
  }

  publish(next: ProjectGroup[]): void {
    if (this.coalesceMs <= 0) {
      this.flush(next)
      return
    }

    if (!this.timer) {
      this.flush(next)
      this.startWindowTimer()
      return
    }

    this.pendingTrailing = next
  }

  shutdown(): void {
    this.pendingTrailing = null
    this.stopWindowTimer()
  }

  private flush(next: ProjectGroup[]): void {
    const prev = this.hasLast ? this.last : []
    // SESSION-05 (project colors): `hasSessionDirectorySnapshotChange` is
    // deliberately color-blind at the comparable-item level (pinned in
    // projection.test.ts) — but the session-directory page this broadcast
    // triggers the client to refetch is the ONLY channel that delivers
    // project colors, so a color-only change must count as a change here
    // (otherwise a recolor put through `PUT /api/project-colors` →
    // `codingCliIndexer.refresh()` publishes a snapshot this service then
    // silently dedupes away, and no other browser context re-renders).
    const changed = hasSessionDirectorySnapshotChange(prev, next)
      || !projectColorMapsEqual(projectColorMap(prev), projectColorMap(next))

    this.last = next
    this.hasLast = true

    if (!changed) {
      return
    }
    this.revision += 1
    this.ws.broadcastSessionsChanged(this.revision)
  }

  private onWindowElapsed = () => {
    this.stopWindowTimer()
    const pending = this.pendingTrailing
    this.pendingTrailing = null
    if (!pending) return

    this.flush(pending)
    this.startWindowTimer()
  }

  private startWindowTimer(): void {
    if (this.timer || this.coalesceMs <= 0) return
    this.timer = setTimeout(this.onWindowElapsed, this.coalesceMs)
  }

  private stopWindowTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
