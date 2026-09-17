// src/components/fresh-agent/shared/transcript-minimap-layout.ts
//
// Pure geometry for the fresh-agent transcript minimap rail: maps measured
// user-turn landmarks (content coordinates) onto tick rects inside the rail,
// plus the band marking the currently visible region. Kept free of DOM and
// React so it is exhaustively unit-testable without jsdom geometry mocks.

/** Minimum rendered tick height, px — keeps every prompt clickable at sane
 * densities; under density the effective minimum thins below it (sub-pixel
 * allowed) so no prompt is ever dropped or stacked on another. */
export const MINIMAP_MIN_TICK_HEIGHT_PX = 3
/** Rail bottom inset, px. Clears the serif/mono bottom-right scroll-to-bottom
 * button (`src/index.css` `.fresh-agent-scroll-bottom` overrides) in every
 * pane style with one code path — in the default sans style the button is
 * bottom-centered and never overlaps the right edge anyway. */
export const MINIMAP_RAIL_BOTTOM_INSET_PX = 48

export type MinimapLandmark = {
  /** Index into the transcript's displayTurns (the article's data-turn-index). */
  index: number
  /** Distance from the top of the scrollable content, px. */
  offsetTop: number
  /** Rendered height of the turn article, px. */
  height: number
  /** Prompt preview text (turnPlainText of the user turn). */
  label: string
}

export type MinimapTick = {
  index: number
  label: string
  /** Distance from the rail top, px. */
  top: number
  /** Tick height, px (>= the density-thinned minimum). */
  height: number
}

export type MinimapViewportBand = {
  top: number
  height: number
}

export type MinimapLayout = {
  ticks: MinimapTick[]
  viewport: MinimapViewportBand
  /** Echoes the input railHeight for consumers (e.g. the tooltip side rule). */
  railHeight: number
}

export function computeMinimapLayout(input: {
  scrollHeight: number
  viewportHeight: number
  scrollTop: number
  railHeight: number
  landmarks: readonly MinimapLandmark[]
}): MinimapLayout {
  if (input.scrollHeight <= 0 || input.railHeight <= 0) {
    return { ticks: [], viewport: { top: 0, height: 0 }, railHeight: 0 }
  }
  const scale = input.railHeight / input.scrollHeight
  // Under density the minimum tick height thins — sub-pixel allowed, no pixel
  // floor — so every prompt keeps a DISTINCT slot: two ticks never share a
  // y-range, so no tick ever occludes another's paint or hit-test.
  const effectiveMinTickHeight = Math.min(
    MINIMAP_MIN_TICK_HEIGHT_PX,
    input.railHeight / Math.max(1, input.landmarks.length),
  )

  const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop || a.index - b.index)
  const heights = sorted.map((mark) => Math.min(
    input.railHeight,
    Math.max(effectiveMinTickHeight, mark.height * scale),
  ))
  const proportionalTops = sorted.map((mark) => mark.offsetTop * scale)

  // Cluster layout: a tick with room keeps its EXACT proportional top;
  // colliding ticks form groups packed by abut from the group's anchor
  // (first member's proportional top, raised to the previous group's end,
  // clamped to railHeight - height). A later tick joins the group when it
  // cannot start at or after the group's packed end — it overlaps
  // proportionally, or the rail-bottom clamp would push it back into the
  // group. Non-final groups provably fit before the next group's anchor;
  // only the final group may overflow, and it scales its member heights to
  // end exactly at the rail bottom while keeping its anchor — late prompts
  // stay near the rail bottom, never reset to the top. Every tick keeps a
  // distinct slot; no two ticks ever share a y-range.
  const tops: number[] = new Array(sorted.length)
  let i = 0
  while (i < sorted.length) {
    const anchor = Math.min(
      Math.max(proportionalTops[i], i === 0 ? 0 : tops[i - 1] + heights[i - 1]),
      Math.max(0, input.railHeight - heights[i]),
    )
    const group: number[] = [i]
    let packed = heights[i]
    while (i + group.length < sorted.length) {
      const next = i + group.length
      const nextStart = Math.min(
        proportionalTops[next],
        Math.max(0, input.railHeight - heights[next]),
      )
      if (nextStart >= anchor + packed - 1e-9) break
      group.push(next)
      packed += heights[next]
    }
    let groupHeights = group.map((k) => heights[k])
    const span = input.railHeight - anchor
    if (packed > span + 1e-9) {
      const factor = span / packed
      groupHeights = groupHeights.map((h) => h * factor)
      group.forEach((k, j) => { heights[k] = groupHeights[j] })
    }
    let cursor = anchor
    group.forEach((k, j) => {
      tops[k] = cursor
      cursor += groupHeights[j]
    })
    i += group.length
  }

  const ticks = sorted.map((mark, k) => ({
    index: mark.index,
    label: mark.label,
    top: tops[k],
    height: heights[k],
  }))

  const bandHeight = Math.min(
    input.railHeight,
    Math.max(MINIMAP_MIN_TICK_HEIGHT_PX, input.viewportHeight * scale),
  )
  const maxScroll = Math.max(0, input.scrollHeight - input.viewportHeight)
  const clampedScrollTop = Math.min(Math.max(input.scrollTop, 0), maxScroll)
  const fraction = maxScroll > 0 ? clampedScrollTop / maxScroll : 0
  const bandTop = fraction * (input.railHeight - bandHeight)

  return { ticks, viewport: { top: bandTop, height: bandHeight }, railHeight: input.railHeight }
}
