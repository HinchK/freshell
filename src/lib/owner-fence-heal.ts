import { applyRuntimeOwnerFenceRefresh } from '@/store/freshAgentSlice'
import { resolveCanonicalPaneSession } from '@/store/selectors/runtimeOwner'

/**
 * The byte-frozen server contract prefix of a stale-observed-generation
 * refusal (the terminal.rs stale arms' frozen message) — the create-scope
 * fast-path discriminator: a refusal carrying the pair AND this prefix
 * proves the request's own observed pair is stale.
 */
export const STALE_REFUSAL_MESSAGE_PREFIX =
  'Session ownership moved on (stale observed generation)'

export type RefusalFencePair = { ownerEpoch?: number; ownerGeneration?: number }

/**
 * The single pair-validity guard: a typed refusal's CURRENT (epoch,
 * generation) is present (both fields typed numbers). Only typed
 * ownership refusals carry the pair on the wire, so its presence doubles
 * as the routing key for every refusal-fold consumer (the TerminalView
 * branches, the background-row subscription); the fold helper itself is
 * the single enforcement point.
 */
export function hasRefusalFencePair(pair: RefusalFencePair): pair is Required<RefusalFencePair> {
  return typeof pair.ownerEpoch === 'number' && typeof pair.ownerGeneration === 'number'
}

/**
 * Fold a typed refusal's CURRENT (epoch, generation) into the pane's
 * runtimeOwners record. The fold key is CANONICALIZED from the pane-like
 * target (the same state-taking resolveCanonicalPaneSession the fence
 * reads use), so aliased/rekeyed sessions fold onto the record the next
 * claim actually reads. Merge-only by construction (the reducer
 * preserves ownerKind/transition/terminalId/aliasOf). Returns true when a
 * fold was DISPATCHED — the reducer may itself no-op when no record
 * exists (plan-review round 3, finding 3: the return reports the dispatch
 * decision, not the state change).
 */
export function foldRefusalFencePair(
  dispatch: (action: ReturnType<typeof applyRuntimeOwnerFenceRefresh>) => void,
  state: Parameters<typeof resolveCanonicalPaneSession>[0],
  paneLike: Parameters<typeof resolveCanonicalPaneSession>[1],
  pair: RefusalFencePair,
): boolean {
  if (!hasRefusalFencePair(pair)) return false
  const canonical = resolveCanonicalPaneSession(state, paneLike)
  if (!canonical) return false
  dispatch(applyRuntimeOwnerFenceRefresh({
    provider: canonical.provider,
    sessionId: canonical.sessionId,
    epoch: pair.ownerEpoch,
    generation: pair.ownerGeneration,
  }))
  return true
}
