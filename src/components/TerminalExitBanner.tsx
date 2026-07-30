// Lane D1: loud exited-pane presentation for coding-agent terminals.
// - recovering notice (server-driven auto-resume in flight) + cancel
// - error bar + Relaunch after the pane settles exited (non-zero exit)
// - persistent, dismissible crash trace after a successful auto-resume
//   (kata znhn item 1 — replaces the ephemeral 'resumed' strip).
// Pure presentational: props in, callbacks out — TerminalView owns the render
// conditions and the relaunch dispatch.
import type { AutoResumeNotice } from '../store/terminalLifecycleSlice'
import type { CrashTrace } from '../store/paneTypes'

export interface TerminalExitBannerProps {
  mode: string
  exitCode: number | null
  notice: AutoResumeNotice | null
  crashTrace: CrashTrace | null
  settledDead: boolean
  onRelaunch: () => void
  onCancelAutoResume: () => void
  onDismissCrashTrace: () => void
}

export function TerminalExitBanner({
  mode,
  exitCode,
  notice,
  crashTrace,
  settledDead,
  onRelaunch,
  onCancelAutoResume,
  onDismissCrashTrace,
}: TerminalExitBannerProps) {
  if (notice) {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {notice.exitCode}) — auto-resuming, attempt {notice.attempt}/{notice.maxAttempts}
        </span>
        <button
          type="button"
          aria-label={`Cancel auto-resume for ${mode}`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onCancelAutoResume}
        >
          Stop
        </button>
      </div>
    )
  }
  if (settledDead) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/15 px-3 py-1.5 text-sm text-destructive"
      >
        <span>process exited{exitCode !== null ? ` (code ${exitCode})` : ''}</span>
        <button
          type="button"
          aria-label={`Relaunch ${mode} session`}
          className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
          onClick={onRelaunch}
        >
          Relaunch
        </button>
      </div>
    )
  }
  if (crashTrace) {
    const d = new Date(crashTrace.resumedAtMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return (
      <div
        role="status"
        data-testid="crash-trace"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {crashTrace.exitCode}) &amp; auto-resumed at {hh}:{mm}
        </span>
        <button
          type="button"
          aria-label={`Dismiss ${mode} crash notice`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onDismissCrashTrace}
        >
          Dismiss
        </button>
      </div>
    )
  }
  return null
}
