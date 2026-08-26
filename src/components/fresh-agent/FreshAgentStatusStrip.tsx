import { ChevronDown } from 'lucide-react'
import type { FreshAgentContextUsage } from '@/lib/fresh-agent-context-usage'

const tokenNumber = new Intl.NumberFormat('en-US')

export type FreshAgentStatusStripProps = {
  /** Display name of the effective model, or null when none is resolved yet
   * (static table, pick-time stamp, or catalog probe) — the chip is hidden
   * rather than ever rendering a raw model id (raw ids stay tooltip-only). */
  modelLabel: string | null
  /** Short label shown ≤520px pane width; absent = long label everywhere. */
  modelLabelShort?: string
  /** Chip hover tooltip: raw model id + effort (e.g. "opus[1m] · effort high"). */
  modelTooltip: string
  /** Complete usage record, or null for the muted unknown state. */
  contextUsage: FreshAgentContextUsage | null
  onOpenModelDialog: () => void
}

// Usage is always a complete record (the helper nulls partial records), so the
// tooltip is always the exact-token form from the approved preview.
function formatTooltip(usage: FreshAgentContextUsage): string {
  return `${tokenNumber.format(usage.contextTokens)} / ${tokenNumber.format(usage.thresholdTokens)} tokens (${usage.percent}% full) — compacts at 100%`
}

export function FreshAgentStatusStrip({
  modelLabel,
  modelLabelShort,
  modelTooltip,
  contextUsage,
  onOpenModelDialog,
}: FreshAgentStatusStripProps) {
  const short = modelLabelShort ?? modelLabel ?? ''
  const severity = contextUsage === null
    ? 'unknown'
    : contextUsage.percent >= 90
      ? 'hot'
      : contextUsage.percent >= 70
        ? 'warn'
        : 'ok'
  return (
    <div className="fresh-agent-status-strip" data-severity={severity}>
      {modelLabel !== null && (
        <button
          type="button"
          className="fresh-agent-status-chip"
          title={modelTooltip}
          aria-label={`Model: ${modelLabel} — change model`}
          onClick={onOpenModelDialog}
        >
          <span className="fresh-agent-status-chip-label fresh-agent-status-chip-label-long">{modelLabel}</span>
          <span className="fresh-agent-status-chip-label fresh-agent-status-chip-label-short">{short}</span>
          <ChevronDown className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      )}
      {contextUsage ? (
        <span
          className="fresh-agent-status-context"
          role="meter"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={contextUsage.percent}
          title={formatTooltip(contextUsage)}
        >
          <span className="fresh-agent-status-context-label">context</span>
          <span className="fresh-agent-status-meter" aria-hidden="true">
            <i style={{ width: `${contextUsage.percent}%` }} />
          </span>
          <span className="fresh-agent-status-pct">{contextUsage.percent}%</span>
        </span>
      ) : (
        <span className="fresh-agent-status-context fresh-agent-status-context-unknown" title="No token data reported yet">
          context —
        </span>
      )}
    </div>
  )
}

export default FreshAgentStatusStrip
