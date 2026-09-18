// src/components/fresh-agent/shared/transcript-measurement.ts
//
// The single shared landmark sweep for the fresh-agent transcript: measures
// every user turn against the scroller ONCE per trigger and produces a
// TranscriptMeasurement consumed by BOTH the glom chip (deriveGlomTarget) and
// the minimap rail (FreshAgentTranscriptMinimap). Owned by the transcript so
// the glom chip never depends on the minimap's mount state.

import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { turnPlainText } from '../FreshAgentTurnActions'
import type { MinimapLandmark } from './transcript-minimap-layout'

export type TranscriptMeasurement = {
  /** Valid user-turn landmarks, in document order. */
  landmarks: MinimapLandmark[]
  /** Scroller geometry captured in the same pass. */
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

/** One DOM sweep: scroller geometry + one rect per valid user-turn article.
 *  Returns null when the scroller is missing. Synchronous by design (jsdom
 *  act() gate — see the plan's Global Constraints). */
export function measureTranscriptUserTurns(
  scroller: HTMLDivElement | null,
  displayTurns: readonly FreshAgentTurn[],
): TranscriptMeasurement | null {
  if (!scroller) return null
  const { scrollHeight, clientHeight, scrollTop } = scroller
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
  return { landmarks, scrollHeight, clientHeight, scrollTop }
}

/** Glom chip target: the LAST user turn (document order) above the viewport
 *  top — `offsetTop < scrollTop` is exactly the glom's historical
 *  `el.getBoundingClientRect().top < scrollerTop` condition in content
 *  coordinates, same strictness. Pure; no DOM reads. */
export function deriveGlomTarget(
  measurement: TranscriptMeasurement | null,
): { index: number; text: string } | null {
  if (!measurement) return null
  let target: { index: number; text: string } | null = null
  for (const mark of measurement.landmarks) {
    if (mark.offsetTop < measurement.scrollTop) {
      target = { index: mark.index, text: mark.label }
    }
  }
  return target
}
