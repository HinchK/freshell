/**
 * HARNESS-04 — freshell-side session overrides.
 *
 * Mirrors the SERVER-side semantics of `applyOverride`
 * (`server/coding-cli/session-indexer.ts`) so the corpus's expectations say
 * what the wire will actually show:
 *  - `deleted: true`  → session never appears (expectation becomes 'absent',
 *    title/summary stripped — nothing is indexed onto the wire)
 *  - `archived: true` → still listed, flagged `archived` (sorts last)
 *  - title/summary overrides win (`titleSource:'user'` ⇒ unconditional win
 *    even over provider-generated titles)
 */

import type { CorpusSessionExpectation } from './types.js'

export interface SessionOverrideEntry {
  titleOverride?: string
  titleSource?: 'user' | 'ai' | 'first-message' | 'dir'
  summaryOverride?: string
  deleted?: boolean
  archived?: boolean
  createdAtOverride?: number
}

export function applySessionOverride(
  exp: CorpusSessionExpectation,
  override: SessionOverrideEntry,
): void {
  if (override.deleted) {
    exp.visibility = 'absent'
    delete exp.title
    delete exp.summary
    delete exp.createdAt
    return
  }
  if (override.titleOverride) exp.title = override.titleOverride
  if (override.summaryOverride) exp.summary = override.summaryOverride
  if (override.archived) exp.archived = true
  if (override.createdAtOverride !== undefined) {
    exp.createdAt = Math.floor(override.createdAtOverride)
  }
}
