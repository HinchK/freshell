/**
 * TEST-ONLY E2E SEAM (default-off; ships inert) — the-usual delta round 6,
 * Path B of the browser-level stale-refusal healing coverage.
 *
 * NOT a product feature. This seam exists solely so the e2e
 * (fence-freeze-stale-refusal-heal-rust.spec.ts) can DETERMINISTICALLY
 * stage the "client missed the ownership broadcast" condition — the one
 * client-side state whose healing the typed stale-refusal fence fold
 * serves: a pane holding a STALE observed (epoch, generation) pair while
 * the server's record moved on.
 *
 * Why a seam is required (the investigation's citations): a client that
 * was OFFLINE across the ownership change is NOT stageable — every
 * (re)connect resets and re-folds the server's authoritative
 * runtimeOwners replay from the ready frame (src/lib/fresh-agent-ws.ts
 * `foldReadyRuntimeOwners`, called from src/App.tsx's ready handler; the
 * server builds the replay from `ownership.snapshot_records()` on EVERY
 * handshake — crates/freshell-ws/src/lib.rs, and
 * `snapshot_records_replay_owner_state_and_released_keys_as_vacant` in
 * crates/freshell-ownership). The only remaining real stale-pair window is
 * the in-flight race — the pair advances between the pane's send-time
 * fence read and the server's claim adjudication — which cannot be staged
 * deterministically from a browser. The seam manufactures exactly that
 * race's client-side state (a stale pair over an otherwise-current owner
 * record) by dropping the ONE frame class whose pair the pane would have
 * folded: the commit-to-Live (`handoff-committed`) runtimeOwner
 * BROADCASTS (the terminal lane emits them at the create-settle and
 * attach-claim points — crates/freshell-ws/src/terminal.rs's
 * `broadcast_owner_frame(..., "handoff-committed")`).
 *
 * Scope discipline (the brief's Path B contract):
 * - ONLY the App-level BROADCAST fold is gated (src/App.tsx's
 *   `session.runtimeOwner` case). The typed-refusal fence fold
 *   (src/lib/owner-fence-heal.ts), the terminal.created owner-trio fold
 *   (TerminalView's direct `applyRuntimeOwner` dispatch), and the
 *   ready-replay folds ALL keep working under the flag — they are the
 *   healing paths the e2e must observe.
 * - ONLY `handoff-committed` frames are skipped. The vacant `released`
 *   broadcasts still fold: the killed-session recovery affordance (the
 *   pane's vacantRecovery bar) renders from the vacant record, and a
 *   blanket broadcast skip would manufacture a client-side state no real
 *   missed-frame condition produces (a pane believing a dead terminal is
 *   still the live owner — the exit fan and the owner record would
 *   disagree, and the very Reopen door the e2e drives would not render).
 * - Default-off and byte-identical in production: without the flag the
 *   predicate is constant-false and the App fold path is unchanged.
 *
 * Enable per-page (one device) with `?__freshellFreezeFence=1`.
 */
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'

/** The URL query flag that arms the seam for that page load. */
export const FENCE_FREEZE_QUERY_FLAG = '__freshellFreezeFence'

let cachedActive: boolean | undefined

function readFlagFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has(FENCE_FREEZE_QUERY_FLAG)
  } catch {
    return false
  }
}

/** True when the page was loaded with the seam's query flag (read once). */
export function fenceFreezeSeamActive(): boolean {
  if (cachedActive === undefined) cachedActive = readFlagFromLocation()
  return cachedActive
}

/**
 * The App broadcast-fold gate: true when the seam must DROP this
 * `session.runtimeOwner` broadcast frame (flag armed AND the frame is a
 * commit-to-Live transition). Every other frame folds normally.
 */
export function shouldSkipRuntimeOwnerBroadcastFold(
  msg: Pick<SessionRuntimeOwnerMessage, 'transition'>,
): boolean {
  return fenceFreezeSeamActive() && msg.transition === 'handoff-committed'
}

/** Test-only toggle for the cached flag read (unit tests + the e2e use the URL). */
export function _setFenceFreezeSeamForTests(active: boolean): void {
  cachedActive = active
}
