import type { LaunchFailure } from '@/store/paneTypes'

/**
 * Typed recoverable launch-failure card (kata b8ke) — the stuck-card
 * pattern (role="alert", real buttons, aria-labels). Rendered by
 * TerminalView when the pane carries a typed `launchFailure` (a create
 * refusal with the additive owner fields); the frozen xterm notice still
 * happens for the byte-frozen wire-text contract, this card adds the
 * recoverable actions.
 */
export function TerminalLaunchFailureCard({ failure, onRetry, onAttach, onOpenFresh }: {
  failure: LaunchFailure
  onRetry: () => void
  onAttach?: () => void
  onOpenFresh?: () => void
}) {
  return (
    <div
      role="alert"
      data-testid="terminal-launch-failure-card"
      aria-label={`Launch failed: ${failure.code}`}
      className="pointer-events-auto absolute inset-x-0 top-0 z-20 m-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span>{failureTitle(failure)}</span>
      <div className="flex shrink-0 gap-2">
        {failure.terminalId !== undefined && onAttach !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Attach to running session"
            onClick={onAttach}
          >
            Attach to running session
          </button>
        ) : null}
        {failure.retryable ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Retry launch"
            onClick={onRetry}
          >
            Retry launch
          </button>
        ) : null}
        {failure.ownerKind === 'fresh-agent' && onOpenFresh !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Open as Fresh Agent"
            onClick={onOpenFresh}
          >
            Open as Fresh Agent
          </button>
        ) : null}
      </div>
    </div>
  )
}

function failureTitle(failure: LaunchFailure): string {
  if (failure.ownerKind === 'fresh-agent') {
    return 'This session is open as a Fresh Agent pane on the server.'
  }
  if (failure.ownerKind === 'terminal') {
    return failure.message
  }
  return failure.message
}
