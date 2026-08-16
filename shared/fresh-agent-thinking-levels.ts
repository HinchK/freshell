/**
 * Canonical ordering for fresh-agent thinking/effort level ids.
 *
 * The opencode catalog probe serves each model's real levels as the `variants`
 * map keys (`/config/providers`), which arrive in whatever order the provider
 * declared. The selector's right column must present them canonically
 * low→highest: none/off < minimal < low < medium < high < xhigh < max, with
 * unknown provider-specific names (e.g. minimax-m3's `thinking`) ranked after
 * the known ones, preserving their relative served order.
 *
 * Shared by both server normalizers (Node `model-catalog.ts`, Rust
 * `catalog.rs` mirrors these ranks) and the client dialog's preselection
 * logic (last-used level else this module's `highestThinkingLevelId`).
 */
const CANONICAL_THINKING_LEVEL_RANK: Readonly<Record<string, number>> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

function isCanonical(level: string): boolean {
  return Object.prototype.hasOwnProperty.call(CANONICAL_THINKING_LEVEL_RANK, level)
}

/**
 * Stable-sort level ids canonically. Blank ids are dropped and repeats
 * deduped (first occurrence wins, keeping the stable order). Input is not
 * mutated.
 */
export function orderThinkingLevelIds(ids: readonly string[]): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique
    .map((id, index) => ({ id, index }))
    .sort((a, b) => {
      const aKnown = isCanonical(a.id)
      const bKnown = isCanonical(b.id)
      if (aKnown && bKnown) {
        const byRank =
          CANONICAL_THINKING_LEVEL_RANK[a.id] - CANONICAL_THINKING_LEVEL_RANK[b.id]
        return byRank !== 0 ? byRank : a.index - b.index
      }
      if (aKnown) return -1
      if (bKnown) return 1
      return a.index - b.index
    })
    .map(({ id }) => id)
}

/** The canonically highest level, e.g. the default preselection when the user has no MRU entry. */
export function highestThinkingLevelId(ids: readonly string[]): string | undefined {
  return orderThinkingLevelIds(ids).at(-1)
}
