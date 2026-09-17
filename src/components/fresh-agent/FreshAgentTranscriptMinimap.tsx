import { useCallback, useEffect, useRef, useState } from 'react'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { turnPlainText } from './FreshAgentTurnActions'
import {
  computeMinimapLayout,
  MINIMAP_RAIL_BOTTOM_INSET_PX,
  type MinimapLandmark,
  type MinimapLayout,
} from './shared/transcript-minimap-layout'

const ARIA_LABEL_MAX_LENGTH = 60
const TOOLTIP_MAX_LENGTH = 120

function truncatePrompt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

export type FreshAgentTranscriptMinimapProps = {
  /** The transcript's scroll container: owns the turn landmarks and geometry. */
  scrollerRef: { current: HTMLDivElement | null }
  /** The transcript's displayTurns — data-turn-index maps into this array. */
  displayTurns: FreshAgentTurn[]
  /** Content signature; a change re-measures landmark geometry. */
  transcriptSignature: string
}

/**
 * ChatGPT-style scroll minimap for the fresh-agent transcript: one tick per
 * user prompt (proportional to transcript length), a hover/focus prompt
 * preview, click-to-jump, and a band marking the visible region. Mounts as an
 * absolutely positioned overlay sibling of the scroller inside the
 * transcript's `relative` wrapper — the same pattern as the glom chip — so it
 * has zero layout impact on transcript copy in any pane style.
 */
export function FreshAgentTranscriptMinimap({
  scrollerRef,
  displayTurns,
  transcriptSignature,
}: FreshAgentTranscriptMinimapProps) {
  const [layout, setLayout] = useState<MinimapLayout | null>(null)

  const recompute = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      setLayout(null)
      return
    }
    const { scrollHeight, clientHeight, scrollTop } = scroller
    const railHeight = clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX
    // Hidden when the content fits the viewport or the rail has no room; also
    // the state jsdom sits in by default (zero geometry), which keeps the
    // rest of the transcript suite free of minimap buttons.
    if (scrollHeight <= clientHeight || railHeight <= 0) {
      setLayout(null)
      return
    }
    const scrollerTop = scroller.getBoundingClientRect().top
    const landmarks: MinimapLandmark[] = []
    scroller.querySelectorAll<HTMLElement>('[data-turn-role="user"]').forEach((el) => {
      const indexAttr = el.getAttribute('data-turn-index')
      if (indexAttr == null) return
      const index = Number(indexAttr)
      if (Number.isNaN(index)) return
      const turn = displayTurns[index]
      if (!turn) return
      const label = turnPlainText(turn)
      if (!label) return
      const rect = el.getBoundingClientRect()
      landmarks.push({
        index,
        offsetTop: rect.top - scrollerTop + scrollTop,
        height: rect.height,
        label,
      })
    })
    setLayout(computeMinimapLayout({
      scrollHeight,
      viewportHeight: clientHeight,
      scrollTop,
      railHeight,
      landmarks,
    }))
  }, [displayTurns, scrollerRef])

  // Re-measure when transcript content changes (streaming text growth flips
  // the signature), mirroring the glom chip's recompute effect — and observe
  // every turn article so content-only layout changes (tool/thinking
  // disclosure expand-collapse, font-size reflow) re-measure too: they move
  // scrollHeight and landmark offsets without touching the signature or the
  // scroller's border box. Re-subscribed per signature so new articles are
  // observed and stale ones released.
  const articleObserverRef = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    recompute()
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    articleObserverRef.current?.disconnect()
    const observer = new ResizeObserver(recompute)
    // Observe EVERY direct child of the scroller, not just turn articles:
    // the rolled-back-history disclosure section (and any caption) sits
    // outside the articles, and its expand/collapse changes scrollHeight
    // without touching transcriptSignature (derived only from displayTurns)
    // or the scroller's own border box.
    Array.from(scroller.children).forEach((el) => observer.observe(el))
    articleObserverRef.current = observer
    return () => {
      observer.disconnect()
      if (articleObserverRef.current === observer) articleObserverRef.current = null
    }
  }, [recompute, scrollerRef, transcriptSignature])

  // Re-measure on scroll and pane resize. Synchronous on purpose: the work is
  // the same order as the transcript's existing per-scroll recomputeGlom (one
  // querySelectorAll + a few rects), and a rAF hop would land the state
  // update outside act() in the jsdom suite.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', recompute, { passive: true })
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recompute)
      observer.observe(scroller)
    }
    return () => {
      scroller.removeEventListener('scroll', recompute)
      observer?.disconnect()
    }
  }, [recompute, scrollerRef])

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
              className="max-w-64 whitespace-pre-wrap"
            >
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
