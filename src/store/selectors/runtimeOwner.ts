/**
 * kata b8ke: runtime-owner divergence selectors.
 *
 * Panes are observers of one global runtime per canonical
 * (provider, sessionId). `selectPaneOwnerDivergence` answers the question
 * every convergence consumer asks: "does the session this pane holds now
 * belong to a DIFFERENT kind of runtime?" — null when the session has no
 * owner record, the record is vacant, or the owner kind MATCHES the pane
 * kind (same-mode multi-device attachment stays untouched). Both
 * directions diverge (round-1 review): a fresh-agent pane observing a
 * terminal owner AND a terminal pane observing a fresh-agent owner.
 *
 * The divergence result RETAINS the transition state (round-3 review F15):
 * handoff-started is NOT a live target — no Attach action until the
 * committed owner event, and a terminal target with no terminalId renders
 * handoff-in-progress, never "connected" content without a runtime.
 *
 * Component-subscription discipline: subscribe to the RECORD via
 * `selectSessionRuntimeOwner` (a stable store reference) and derive the
 * divergence locally with `derivePaneOwnerDivergence` — a selector
 * returning a fresh divergence object per call would re-render on every
 * store notification. `selectPaneOwnerDivergence` composes both for
 * non-subscription consumers (the reconcile gate, tests).
 */
import type { SessionLocator } from '@shared/ws-protocol'
import type { RootState } from '@/store/store'
import type { RuntimeOwnerRecord } from '@/store/freshAgentTypes'

export type { RuntimeOwnerRecord }

export type PaneOwnerDivergence = {
  /** The owner record's kind — the divergent owner's kind, the FENCED
   *  PRIOR's kind, or 'vacant' for a fenced record with no prior (b8ke
   *  R4-7: a fenced-vacant record drives the typed recovery state; the
   *  kind never matches a pane so the blocked card renders for both
   *  kinds). */
  ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
  /** The owner record's transition at fold time — handoff-started is not a live target. */
  transition: RuntimeOwnerRecord['transition']
  terminalId?: string
  generation: number
  /**
   * b8ke R3-5: present when the record is FENCED (no live writer exists —
   * the ownerKind names the fenced prior). Present for BOTH pane kinds:
   * every pane holding the sessionRef shows the typed recovery state, not
   * a false committed owner or an old-kind continuation.
   */
  fencedReason?: string
  /**
   * b8ke R5-3: present while a lifecycle transition is IN PROGRESS (the
   * record's transition is handoff-started — a live handoff broadcast, or
   * the ready-replay fold of starting/handoff/stopping). The pane is
   * TRANSITION-BLOCKED for EVERY pane kind: no attach actions, no
   * polling/scheduling resumption until the transition's committed,
   * failed, or released frame supersedes it — even when the ownerKind
   * matches the pane.
   */
  inProgress?: boolean
}

export type PaneOwnerKind = 'fresh-agent' | 'terminal'

export type PaneOwnerIdentityInput = {
  paneKind: PaneOwnerKind
  provider?: string
  sessionRef?: SessionLocator
  sessionId?: string
}

/** The observed (epoch, generation) pair a fenced lifecycle send carries. */
export type ObservedOwnerFence = { epoch: number; generation: number }

/**
 * The owner map read is deliberately optional-chained (the
 * `state.freshAgent?.sessions` precedent): App-level folds run against
 * deliberately partial stores in App unit tests.
 */
function runtimeOwnersMap(state: RootState): Record<string, RuntimeOwnerRecord> {
  return state.freshAgent?.runtimeOwners ?? {}
}

/**
 * The ONE canonical-session derivation every owner consumer uses:
 * `sessionRef.sessionId ?? sessionId` + provider (sessionRef's provider
 * wins — the ref is the durable identity; the pane-level provider is the
 * fallback for panes that only carry a content sessionId).
 *
 * b8ke ext F1: with the runtime-owners map the derivation CONSUMES the
 * stored rekey alias chain to the fixpoint — the Claude rollback/fork
 * rekey mirrors the canonical owner state onto the old key with
 * `aliasOf` naming the canonical id, and a pane holding the pre-rekey
 * sessionRef resolves THROUGH that chain to the pane's canonical key
 * (pre-ext the alias was parsed and stored but never consumed: panes
 * kept referencing the superseded id, saw the same-kind mirror record,
 * and never converged). The chain walk is per-provider and cycle-bounded
 * (a repeated key ends the walk — cycles are impossible by construction).
 */
export function canonicalPaneSession(
  pane: { provider?: string; sessionRef?: SessionLocator; sessionId?: string },
  runtimeOwners?: Record<string, RuntimeOwnerRecord>,
): { provider: string; sessionId: string } | undefined {
  const provider = pane.sessionRef?.provider ?? pane.provider
  const sessionId = pane.sessionRef?.sessionId ?? pane.sessionId
  if (!provider || !sessionId) return undefined
  if (!runtimeOwners) return { provider, sessionId }
  return { provider, sessionId: resolveAliasFixpoint(runtimeOwners, provider, sessionId) }
}

/**
 * b8ke ext F1: walk the stored `aliasOf` chain to the fixpoint — the
 * pane's canonical key. Bounded by the visited set (a repeated key ends
 * the walk), so a corrupt cycle can never spin.
 */
function resolveAliasFixpoint(
  runtimeOwners: Record<string, RuntimeOwnerRecord>,
  provider: string,
  sessionId: string,
): string {
  let current = sessionId
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const next = runtimeOwners[`${provider}:${current}`]?.aliasOf
    if (!next) break
    current = next
  }
  return current
}

/**
 * b8ke ext F1: [`canonicalPaneSession`] with the store's runtime-owners
 * map — the state-taking variant every store-backed pane-identity
 * consumer uses (the alias chain resolves to the pane's canonical key).
 */
export function resolveCanonicalPaneSession(
  state: RootState,
  pane: { provider?: string; sessionRef?: SessionLocator; sessionId?: string },
): { provider: string; sessionId: string } | undefined {
  return canonicalPaneSession(pane, runtimeOwnersMap(state))
}

export function selectSessionRuntimeOwner(
  state: RootState,
  provider: string,
  sessionId: string,
): RuntimeOwnerRecord | undefined {
  return runtimeOwnersMap(state)[`${provider}:${sessionId}`]
}

/** The observed fence for a canonical session: the record's (epoch, generation) pair. */
export function selectOwnerFence(
  state: RootState,
  provider: string,
  sessionId: string,
): ObservedOwnerFence | undefined {
  const record = selectSessionRuntimeOwner(state, provider, sessionId)
  return record ? { epoch: record.epoch, generation: record.generation } : undefined
}

/** `selectOwnerFence` for a pane identity — resolves the canonical session first. */
export function selectPaneOwnerFence(
  state: RootState,
  pane: { provider?: string; sessionRef?: SessionLocator; sessionId?: string },
): ObservedOwnerFence | undefined {
  const canonical = canonicalPaneSession(pane, runtimeOwnersMap(state))
  if (!canonical) return undefined
  return selectOwnerFence(state, canonical.provider, canonical.sessionId)
}

/**
 * Derive a pane's divergence from its owner record — pure, safe to call in
 * render (no store dependency; pair with a `selectSessionRuntimeOwner`
 * subscription so the record reference stays stable).
 *
 * b8ke R3-5: a FENCED record diverges for BOTH pane kinds — no live
 * writer exists (the ownerKind names the fenced prior), so every pane
 * holding the sessionRef renders the typed recovery state via
 * `fencedReason`, never a same-kind "all clear".
 *
 * b8ke focused round-4 R4-7: the fenced check comes BEFORE the vacant
 * early-return — a FENCED record whose prior is vacant (an unconfirmed
 * cleanup failure while starting from vacancy) drives the typed recovery
 * state too, instead of being suppressed as a plain vacant key.
 *
 * b8ke focused round-5 R5-3: an IN-PROGRESS lifecycle transition
 * (handoff-started) is TRANSITION-BLOCKED for EVERY pane kind — the
 * check precedes the same-kind early-return, so a pane whose kind
 * matches the record still blocks its attach/polling until the
 * transition settles, instead of resuming as if the in-progress state
 * were committed live ownership.
 */
export function derivePaneOwnerDivergence(
  record: RuntimeOwnerRecord | undefined,
  paneKind: PaneOwnerKind,
): PaneOwnerDivergence | null {
  if (!record) return null
  if (record.fenced) {
    return {
      ownerKind: record.ownerKind,
      transition: record.transition,
      ...(record.terminalId !== undefined ? { terminalId: record.terminalId } : {}),
      generation: record.generation,
      ...(record.reason !== undefined ? { fencedReason: record.reason } : {}),
    }
  }
  if (record.transition === 'handoff-started') {
    return {
      ownerKind: record.ownerKind,
      transition: record.transition,
      ...(record.terminalId !== undefined ? { terminalId: record.terminalId } : {}),
      generation: record.generation,
      inProgress: true,
    }
  }
  if (record.ownerKind === 'vacant') return null
  if (record.ownerKind === paneKind) return null
  return {
    ownerKind: record.ownerKind,
    transition: record.transition,
    ...(record.terminalId !== undefined ? { terminalId: record.terminalId } : {}),
    generation: record.generation,
  }
}

export function selectPaneOwnerDivergence(
  state: RootState,
  pane: PaneOwnerIdentityInput,
): PaneOwnerDivergence | null {
  const canonical = canonicalPaneSession(pane, runtimeOwnersMap(state))
  if (!canonical) return null
  const record = selectSessionRuntimeOwner(state, canonical.provider, canonical.sessionId)
  return derivePaneOwnerDivergence(record, pane.paneKind)
}

/**
 * kata b8ke lifecycle-start suppression: a pane of `paneKind` must not issue
 * a create/attach (rebind) for a session the runtime-owner store now shows
 * as owned by the OTHER kind. Suppressed when the divergence is at least as
 * new as the fence the decision captured — same epoch with generation >= the
 * observed one, or a DIFFERENT epoch (a restarted server's authority beats
 * any pre-restart observation). With no captured fence, any current
 * divergence suppresses. The server-side generation fence (Task 2/4) is the
 * backstop; this is the client-side half that keeps stale scheduled
 * callbacks (rebind-queue runs, reconnect resends) from issuing
 * lifecycle-starts for old generations.
 */
export function isLifecycleStartSuperseded(
  state: RootState,
  paneKind: PaneOwnerKind,
  pane: { provider?: string; sessionRef?: SessionLocator; sessionId?: string },
  observedFence: ObservedOwnerFence | undefined,
): boolean {
  const canonical = canonicalPaneSession(pane)
  if (!canonical) return false
  const record = selectSessionRuntimeOwner(state, canonical.provider, canonical.sessionId)
  if (!record) return false
  // b8ke delta round-3 F2: a handoff IN FLIGHT supersedes EVERY lifecycle
  // start for the session — checked BEFORE the kind-equality shortcut.
  // Pre-d3, a pane whose kind matched the announced TARGET kind returned
  // false here and a delayed attach during the Handoff window slipped the
  // client-side suppression (the server-side coordinator fence is the
  // backstop; this selector is the client half that keeps stale scheduled
  // callbacks from issuing the start at all).
  if (record.transition === 'handoff-started') {
    if (!observedFence) return true
    return record.epoch !== observedFence.epoch || record.generation >= observedFence.generation
  }
  if (record.ownerKind === 'vacant' || record.ownerKind === paneKind) return false
  if (!observedFence) return true
  return record.epoch !== observedFence.epoch || record.generation >= observedFence.generation
}
