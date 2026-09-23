/**
 * Wedge-backstop: the "Agent appears stuck" card for terminal-mode agent
 * panes — the terminal-mode twin of the freshcodex wedged-sidecar deadman
 * card (FreshAgentView.tsx). Purely presentational: the gate (agent-mode,
 * running, a stuck entry present) and the kill+restart actions live in
 * TerminalView. A11y contract: role="alert" + semantic buttons with
 * non-empty accessible names (mirrors the freshcodex card).
 */

interface Props {
  mode: string
  onRestart: () => void
  onStartFresh: () => void
}

export function TerminalStuckCard({ mode, onRestart, onStartFresh }: Props) {
  return (
    <div
      role="alert"
      data-testid="terminal-stuck-card"
      className="flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span>Agent appears stuck — no agent output for a while.</span>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
          aria-label={`Restart the ${mode} agent and resume this conversation`}
          onClick={onRestart}
        >
          Restart agent
        </button>
        <button
          type="button"
          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
          aria-label="Start a fresh conversation"
          onClick={onStartFresh}
        >
          Start fresh conversation
        </button>
      </div>
    </div>
  )
}
