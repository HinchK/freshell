// Pure per-tab tile classification for the Stream Deck tiles.
// Mirrors the tab bar's visual states (src/components/TabItem.tsx):
//   bar-on-top  <-> active tab with attention        -> fill 'barTop'
//   green fill  <-> inactive tab with attention      -> fill 'green'
//   green icon  <-> a running, non-busy pane         -> dot 'green'
//   blue icon   <-> any busy pane                    -> dot 'blue'
// Sort priority (spec): barTop, greenFill, greenIcon, blueIcon, rest.

export type TileFill = 'barTop' | 'green' | 'none'
export type TileDot = 'green' | 'blue' | null

export type TabStatusFlags = {
  /** Any pane in the tab is busy (getBusyPaneIdsForTab). */
  busy: boolean
  /** Turn-complete attention (turnCompletion.attentionByTab), gated on tabAttentionStyle !== 'none'. */
  attention: boolean
  /** Any non-busy pane with effective status 'running' (TabItem.tsx:135-147). */
  greenIcon: boolean
}

export function tileFill(active: boolean, flags: TabStatusFlags): TileFill {
  if (flags.attention) return active ? 'barTop' : 'green'
  return 'none'
}

export function tileDot(flags: TabStatusFlags): TileDot {
  if (flags.busy) return 'blue'
  if (flags.greenIcon) return 'green'
  return null
}

/** 0 bar-on-top, 1 green-filled, 2 green-icon, 3 blue-icon, 4 rest. Busy dominates greenIcon. */
export function tilePriority(active: boolean, flags: TabStatusFlags): number {
  if (flags.attention) return active ? 0 : 1
  if (flags.busy) return 3
  if (flags.greenIcon) return 2
  return 4
}
