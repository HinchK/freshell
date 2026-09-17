import { useCallback, useEffect, useMemo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  computeMinimapLayout,
  MINIMAP_RAIL_BOTTOM_INSET_PX,
  type MinimapLayout,
} from './shared/transcript-minimap-layout'
import type { TranscriptMeasurement } from './shared/transcript-measurement'

const ARIA_LABEL_MAX_LENGTH = 60
const TOOLTIP_MAX_LENGTH = 120

function truncatePrompt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

export type FreshAgentTranscriptMinimapProps = {
  /** The transcript's scroll container: owns the turn landmarks and geometry. */
  scrollerRef: { current: HTMLDivElement | null }
  /** The transcript's SINGLE shared landmark sweep result — the same
   *  measurement that feeds the glom chip. Null when the scroller is missing. */
  measurement: TranscriptMeasurement | null
  /** Requests a fresh shared sweep. Fired by this component's ResizeObservers
   *  (article-level and pane-level resize); the transcript owns the sweep. */
  onRemeasure: () => void
  /** Content signature; a change re-subscribes child observation (new articles). */
  transcriptSignature: string
}

/**
 * ChatGPT-style scroll minimap for the fresh-agent transcript: one tick per
 * user prompt (proportional to transcript length), a hover/focus prompt
 * preview, click-to-jump, and a band marking the visible region. Presentational
 * on top of the transcript's shared landmark sweep: geometry arrives via the
 * `measurement` prop; the only work this component owns is its two
 * ResizeObserver subscriptions, which request re-measurement through
 * `onRemeasure` — so unmounting it (the show/hide setting, pane teardown)
 * removes exactly its own work while the glom chip keeps its data.
 */
export function FreshAgentTranscriptMinimap({
  scrollerRef,
  measurement,
  onRemeasure,
  transcriptSignature,
}: FreshAgentTranscriptMinimapProps) {
  const layout = useMemo<MinimapLayout | null>(() => {
    if (!measurement) return null
    const railHeight = measurement.clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX
    // Hidden when the content fits the viewport or the rail has no room; also
    // the state jsdom sits in by default (zero geometry), which keeps the
    // rest of the transcript suite free of minimap buttons.
    if (measurement.scrollHeight <= measurement.clientHeight || railHeight <= 0) return null
    return computeMinimapLayout({
      scrollHeight: measurement.scrollHeight,
      viewportHeight: measurement.clientHeight,
      scrollTop: measurement.scrollTop,
      railHeight,
      landmarks: measurement.landmarks,
    })
  }, [measurement])

  // Observe every direct child of the scroller, not just turn articles: the
  // rolled-back-history disclosure section (and any caption) sits outside the
  // articles, and its expand/collapse changes scrollHeight without touching
  // transcriptSignature (derived only from displayTurns) or the scroller's
  // own border box. Re-subscribed per signature so new articles are observed
  // and stale ones released.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    Array.from(scroller.children).forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef, transcriptSignature])

  // Pane resize: the scroller's border box changes with no scroll event, no
  // signature change, and no child resize — request a fresh sweep.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef])

  const handleTickClick = useCallback((index: number) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-turn-index="${index}"]`)
    // Optional call: jsdom has no scrollIntoView — the glom chip guards the
    // same way. The resulting scroll event flips atBottom false via the
    // transcript's existing onScroll handler, so stick-to-bottom disengages.
    el?.scrollIntoView?.({ block: 'start' })
  }, [scrollerRef])

  if (!layout) return null

  return (
    <div
      className="fresh-agent-minimap pointer-events-none absolute right-2 top-0 z-30 w-3"
      style={{ bottom: MINIMAP_RAIL_BOTTOM_INSET_PX }}
      role="group"
      aria-label="Transcript minimap"
    >
      <div
        data-testid="transcript-minimap-viewport"
        aria-hidden="true"
        className="pointer-events-none absolute right-0 w-full rounded-sm bg-foreground/10"
        style={{ top: layout.viewport.top, height: layout.viewport.height }}
      />
      {layout.ticks.map((tick) => {
        const firstLine = tick.label.split('\n')[0]
        return (
          <Tooltip key={tick.index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="fresh-agent-minimap-tick pointer-events-auto absolute left-0 w-full rounded-sm bg-muted-foreground/40 transition-colors hover:bg-primary focus-visible:bg-primary"
                style={{ top: tick.top, height: tick.height }}
                aria-label={`Jump to prompt: ${truncatePrompt(firstLine, ARIA_LABEL_MAX_LENGTH)}`}
                onClick={() => handleTickClick(tick.index)}
              />
            </TooltipTrigger>
            <TooltipContent
              side={tick.top < layout.railHeight * 0.25 ? 'bottom' : 'top'}
              align="end"
              className="max-w-64 whitespace-pre-wrap break-words"
            >
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
