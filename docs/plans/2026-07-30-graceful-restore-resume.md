# Graceful Restore/Resume — design spec

**Date:** 2026-07-30 · **Status:** PROPOSED (design only, no code) · **Baseline:** main @ `4baf8e56` (post-S5 merge `4d99b3c3`, managed codex launch default ON) · **Origin:** bounce-risk analysis of the S5 flag flip; user mandate below.

---

## 1. Mandate

> "It is absolutely unacceptable that we have a code path that fails to resume and instead yells at the user. This should be graceful, and the user should never see any issues with errors only as a symptom of unanticipatable failure."

Operationalized:

- **ANTICIPATABLE CONTENTION** — restart storms, sidecar-planning budget exhaustion, spawn-gate queue timeouts, slow cold starts — must **never** surface as user-facing errors or dead panes. It is known-finite work; the correct behavior is *queue, show progress, finish*.
- **UNANTICIPATABLE FAILURE** — binary missing, corrupt/absent rollout, missing canonical identity, repeated post-spawn crash — **may** surface, loudly, with an actionable message and a recovery affordance.

**Reconciliation with A18 (fail-loud over silent fallback):** this SHARPENS, not contradicts, A18. Fail-loud exists to prevent *silent divergence and corruption masquerading as success*. A bounded queue with visible progress and logging is not a silent fallback — nothing diverges, nothing is hidden, the work completes or fails loudly for a *real* reason. "The queue was busy" was never the failure class A18 was written for. The flap breaker's bounded-and-loud discipline (user ruling 2026-07-27) is untouched: *repeated crash* remains loud.

---

## 2. Problem — the four verified failure surfaces

All anchors re-verified against main @ `4baf8e56` on 2026-07-30.

### F1 — Sidecar planning budget: fail-fast death

`crates/freshell-codex/src/launch_lifecycle.rs:457-458` — `CODEX_SIDECAR_PLAN_CONCURRENCY = 2`, `CODEX_SIDECAR_PLAN_WAIT = 30s`. `plan_create_with_retry` (`:508-530`) races the semaphore against a 30s timeout and on loss returns:

```
CodexLaunchError::Failed("codex sidecar planning budget exhausted; too many concurrent codex launches")
```

This propagates through `plan_codex_managed_launch` in `handle_create` (`crates/freshell-ws/src/terminal.rs:2014-2029`) as `error{code: PTY_SPAWN_FAILED}` → the client renders **"[Restore failed] …"** (`src/components/TerminalView.tsx:3282, 4713`). In a ≥5-codex-tab restore storm, tabs 3+ die visibly. The doc comment at `:453` records this as "D-C-REVISIT — RESOLVED": fail-fast was chosen to prevent ~226s plan-hold stacking. That resolution predates the mandate and the flag flip; this spec supersedes it (§9.2).

### F2 — Restore-creates hold a spawn-gate permit across codex planning

`crates/freshell-ws/src/create_gate.rs:62-188` (`spawn_gated_restore_create`): the permit is acquired (`:74`, timeout = `create_protect.spawn_timeout_ms`) and held across the **whole** `handle_create` (`:145-164`) — which *includes* codex planning (sidecar spawn + proxy start, seconds each; up to 30s budget wait; 5-attempt initial retry budget). Gate config: **4 permits, 64 queue cap, 10s queue timeout** (`crates/freshell-ws/src/create_limit.rs:47-49`; env knobs `:64-66`).

Consequence: two codex restores planning = 2 of 4 permits pinned for seconds-to-tens-of-seconds; two more codex restores occupy the remaining permits waiting on the plan budget; **shell/claude/opencode restores queue behind them and die at the 10s timeout** — cross-mode starvation of the cheap by the expensive.

The permit-hold-across-settle itself is correct and hard-won (the da5d9b5c prior-art bug, `create_gate.rs:39-51`); the defect is *what* is inside the hold, not the hold.

### F3 — No retry for failed restore-creates

The auto-resume hub consumes `CrashEvent`s produced by PTY exit hooks only (`crates/freshell-ws/src/auto_resume.rs:12-17, 99-111` — `finish_pty_exit` → `build_pty_exit_hook`). A restore-create that fails **before a PTY exists** (F1, F2, spawn error) emits no CrashEvent and is invisible to the hub. There is no server-side retry; the client's 2s `RATE_LIMITED` ladder (~38s patience, `create_limit.rs:38`, `create_dedupe.rs:364`) retries only `RATE_LIMITED`, not `PTY_SPAWN_FAILED`. The manual resume button is unmerged (`.worktrees/resume-button`). Result: identity survives (ledger row intact) but the pane is dead until the user reopens it from the sidebar.

### F4 — Client has no "resuming" state

A pending restore renders nothing meaningful; a failed one renders the `[Restore failed]` banner / `restoreError` card immediately (`TerminalView.tsx:3282`, `src/lib/pane-reconcile.ts:259-262`). There is no queued/progress placeholder. (Precedent exists: the auto-resume lane already drives transient client state via `recordAutoResumeRecovering`/`recordAutoResumeSettled`, `src/store/terminalLifecycleSlice.ts:60,77`.)

---

## 3. Failure taxonomy

Every path a restore-create can fail today, classified. **Bold** = violates the mandate as shipped.

| # | Failure | Today's surface | Class | Required disposition |
|---|---------|-----------------|-------|----------------------|
| T1 | Plan budget exhausted (2 concurrent / 30s) | **`PTY_SPAWN_FAILED` "codex sidecar planning budget exhausted…"** (`launch_lifecycle.rs:523` → `terminal.rs:2026`) | Anticipatable contention | Queue with progress; never dies |
| T2 | Spawn-gate `Timeout` (10s) | **`PTY_SPAWN_FAILED` "Timed out waiting for a terminal spawn slot"** (`terminal.rs:3486-3489`) | Anticipatable contention | Restore class waits (cancel-aware), no timeout death |
| T3 | Spawn-gate `QueueFull` (cap 64) | `RATE_LIMITED` "Too many terminal.create requests" (`terminal.rs:3483-3485`) — client ladder retries ~38s, **then surfaces** | Anticipatable contention (backpressure) | Keep `RATE_LIMITED` mapping (ladder absorbs); becomes near-unreachable once F2 fix drains the queue fast; storm > cap+ladder covered by S3 retry |
| T4 | Sidecar spawn flake (proxy/app-server transient) exhausting the 5-attempt initial budget | **`PTY_SPAWN_FAILED`** (via `plan_codex_managed_launch`) | Anticipatable-transient | Server-side retry with backoff (hub, S3); loud only after exhaustion |
| T5 | Slow cold start (many sidecars serially planning) | No user-visible state → **looks hung** | Anticipatable contention | Progress frames + client placeholder |
| T6 | codex binary missing / ENOENT / bad config | `PTY_SPAWN_FAILED` → `provider_runtime_failed` card (`pane-reconcile.ts:354,509`) | **Unanticipatable** | Loud immediately (no retry — deterministic) |
| T7 | Rollout artifact missing/corrupt | `durable_artifact_missing` (`pane-reconcile.ts:323,476`; `TerminalView.tsx:4899`) | **Unanticipatable** | Loud (correct today) |
| T8 | No canonical identity | `missing_canonical_identity` (`pane-reconcile.ts:332,485`) | **Unanticipatable** | Loud (correct today) |
| T9 | Repeated post-spawn crash | Auto-resume ladder → flap breaker → settle exited (`auto_resume.rs:30-38`) | **Unanticipatable** | Loud after bounded retries (correct today — do not touch) |
| T10 | Dead live handle on reconnect | `dead_live_handle` (`TerminalView.tsx:4705`) | **Unanticipatable** | Loud (correct today) |
| T11 | Disconnect/shutdown mid-restore | Silent abandon (`create_gate.rs:76-86,111-137`) | Neither (no user) | Correct today; extended to drain the new queues |

**Taxonomy conflation bug:** T1/T2/T4 arrive at the client as the same `PTY_SPAWN_FAILED` used for T6, so contention *masquerades as provider runtime failure* — the client cannot distinguish "wait" from "broken" even if it wanted to. Fixing the taxonomy on the wire is part of the design (§5).

---

## 4. Design

Four pillars, ordered by leverage. The through-line is the **D-GATE-SOFT precedent**: *degrade, never kill* — extended from "the gate may not kill a live pane" to "contention may not kill a restore."

### P1 — Move codex planning OUT of the spawn-gate permit scope (fixes F2)

Restore path: in `spawn_gated_restore_create` (`create_gate.rs:72`), before `state.spawn_gate.acquire`, run a new **prepare phase**:

```rust
// crates/freshell-ws/src/terminal.rs (new seam, extracted from handle_create)
pub(crate) struct PreparedLaunch {
    pub resume_session_id: Option<String>,     // sessionRef-first derivation, terminal.rs:1667-1682
    pub codex_launch: Option<CodexTerminalLaunch>,
}
pub(crate) async fn prepare_launch(
    create: &TerminalCreate, state: &WsState,
) -> Result<PreparedLaunch, PrepareError>;
```

`handle_create` gains an `Option<PreparedLaunch>` parameter: `Some` on the restore path (skip inline planning), `None` on the interactive path (plan inline, exactly today's behavior — interactive creates don't ride `spawn_gated_restore_create` and a single interactive codex create holding its permit during planning is not the storm problem).

**Invariant change to handle:** today "at gate rejection nothing has been materialized" (`create_gate.rs:88-93`). With pre-planning, a `Cancelled`/rejected/shutdown exit after prepare holds a live sidecar+proxy. Every early-exit arm in `spawn_gated_restore_create` must discard the prepared launch (sidecar teardown — reuse the failed-spawn cleanup that `handle_create`'s own error arm already performs). This is a small, enumerable set: the 4 early returns at `:76-86, :87-107, :111-120, :125-137`.

Effect: permits are held only for PTY-spawn→settle (fast, mode-uniform). **Cross-mode starvation is eliminated structurally** — shell/claude restores no longer queue behind codex planning at all.

### P2 — Plan budget: queue for restore class, don't die (fixes F1)

Add a launch class to the manager API:

```rust
// crates/freshell-codex/src/launch_lifecycle.rs
#[derive(Clone, Copy, PartialEq)]
pub enum LaunchClass { Interactive, Restore }

pub async fn plan_create_with_retry(
    &self, input: &CodexLaunchPlanInput<'_>, attempts: u32, class: LaunchClass,
) -> Result<CodexTerminalLaunch, CodexLaunchError>
```

- `Restore`: acquire the semaphore with **no wall-clock death**. Wait is bounded structurally, not temporally: `queue_depth × per-plan-bound`, where the per-plan bound already exists (the planner's own attempt budget). Waiting is cancel-aware (select against the caller's `cancel_rx`, threaded down from `spawn_gated_restore_create` — disconnect/shutdown drains the queue, extending T11 semantics).
- `Interactive`: keep today's 30s fail-fast (a human is actively waiting; loud-at-30s for an interactive create is defensible, and the REST `/api/tabs` door — `crates/freshell-freshagent/src/terminal_tabs.rs` codex branch — is interactive by construction).
- Concurrency stays **2** (serialization is the point; each plan is seconds when healthy). Add a bounded plan-queue cap (default 64, matching the spawn gate; env `FRESHELL_CODEX_PLAN_QUEUE_CAP`) — overflow maps to `RATE_LIMITED` (client ladder absorbs), the true backpressure backstop.
- Emit queue-position/phase notifications via a progress callback (`P3`) on enqueue and on acquire.

Restore storms are **known-finite** work: N panes existed before the bounce, N restores arrive, the queue drains N. There is no unbounded-arrival regime that would justify timeout death; a genuinely wedged planner surfaces per-plan (its own attempt budget → T4/T6), not via queue starvation.

### P3 — Progress protocol + client placeholder (fixes F4, T5)

**New server→client frame** (additive; unknown types are ignored by the frozen client, so protocol-safe):

```
terminal.restoreProgress {
  requestId: string,          // the create's requestId — the terminal may not exist yet
  phase: 'queued' | 'planning' | 'spawning',
  queuePosition?: number,     // plan-queue position when phase='queued'
  at: string,
}
```

Why a new frame and not `terminal.meta.updated`: meta frames are keyed by a *registered terminal*; during queueing/planning no registry row exists. The natural key is the create `requestId`, which the client already correlates (dedupe ladder). Rejected alternative: overloading the auto-resume recovering frame — wrong lifecycle (that lane is keyed by a crashed terminal that *existed*).

**Terminal states of the sequence:** `terminal.created` (success — clears placeholder, exactly as today) or `error{code, class}` (only after §3's disposition allows it).

**Wire taxonomy fix (T1/T2/T4 vs T6 conflation):** add an optional discriminator to the create-error frame: `errorClass: 'contention' | 'provider' | 'artifact' | 'identity'`. Under the full design, `contention`-class errors are never *sent* for restore creates (absorbed by P1/P2); the field exists so the client can render any residual/interactive case as "still trying / retry" instead of a dead-pane card, and so tests can pin the mandate ("no frame with `errorClass:'contention'` during a storm").

**Client** (`src/store/terminalLifecycleSlice.ts`, `src/components/TerminalView.tsx`, `src/lib/pane-reconcile.ts`):
- New pane transient state `restorePending {phase, queuePosition}` driven by `terminal.restoreProgress` — mirror the existing `recordAutoResumeRecovering` pattern (`terminalLifecycleSlice.ts:60`).
- Placeholder render: "Resuming… (queued, position n)" / "Resuming… (starting codex)" — spinner, not banner.
- `[Restore failed]` banner / `restoreError` card **only** on a terminal error frame whose class is unanticipatable (or `errorClass` absent + retries exhausted). `buildRestoreError` classes (`durable_artifact_missing`, `missing_canonical_identity`, `provider_runtime_failed`, `dead_live_handle`) are already the right unanticipatable vocabulary — they stay.

### P4 — Retry with backoff: the auto-resume hub owns it (fixes F3)

**Single owner: extend the existing hub.** A separate restore-retry ledger would be a second writer over the same pane-lifecycle state — rejected on the single-writer discipline established by the identity work.

- Widen the hub channel from `CrashEvent` to:

```rust
pub enum ResumeEvent {
    Crash(CrashEvent),                              // today's lane, unchanged
    RestoreFailed {                                  // new: create failed pre-PTY
        create: Box<TerminalCreate>,                 // full payload — the hub can re-drive it
        create_request_id: String,
        error_class: RestoreErrorClass,              // from the taxonomy
        conn: ConnHandle,                            // sink + cancel_rx for re-drive & frames
    },
}
```

- Emission point: the failure arms of `spawn_gated_restore_create`/`handle_create` for restore-class creates, `error_class ∈ {contention, transient}` only (T6/T7/T8 go loud immediately — deterministic failures don't retry).
- Hub `decide()` gains a restore arm **reusing the existing discipline**: delays `[2s, 10s]` (`AUTO_RESUME_DEFAULT_DELAYS_MS`), history keyed by `create_request_id` (`ResumeHistory` is already keyed that way, `auto_resume.rs:89-97`), and — critically — the **same flap-breaker cycle window** (`:30-38`): restore-retries and crash-resumes share one bounded resurrection budget, so the combined loop can never be infinite-and-silent. Exhaustion → loud `restoreError` with the *original* error class + the existing settle frame, honoring bounded-and-loud.
- Re-drive path: after backoff, feed the stored `TerminalCreate` back through `spawn_gated_restore_create` (the hub's respawn seam already shares `plan_codex_managed_launch`, `terminal.rs:2011-2013`). Dedupe: mint a derived requestId suffix (the original was cleared via `clear_if_in_flight`, `create_gate.rs:84,105,167`) or reuse the original — decide at implementation; the dedupe map semantics at `create_dedupe.rs` support either.
- With P1+P2 absorbing contention, this lane handles only *residual transients* (T4). It is defense-in-depth, not the primary mechanism — which is why it is a later slice.

### Fairness & ordering (considered, resolved simply)

- **Per-mode fairness:** achieved structurally by P1 (permits only cover fast PTY spawns) — no weighted scheduler needed.
- **FIFO vs priority:** server stays FIFO. Visible/focused-tabs-first is legitimately a *client send-order* concern — the client already controls the order it issues restore-creates; if wanted, reorder there (zero server change). Rejected: server-side priority queue — adds a scheduler abstraction with no server-visible signal for "focused".

---

## 5. Protocol changes (complete list)

| Change | Direction | Compat |
|---|---|---|
| `terminal.restoreProgress {requestId, phase, queuePosition?, at}` | S→C, new | Additive; frozen clients ignore unknown types |
| `error` frame gains optional `errorClass` | S→C, field add | Additive/optional |
| No client→server changes | — | `terminal.autoResumeCancel` (`shared/ws-protocol.ts:360`) already covers user-cancel of the retry lane |

`terminal.meta.updated`, reconcile verdicts (`derive_verdicts`), and the auto-resume settle frames are **unchanged**.

---

## 6. Alternatives considered

1. **Env-knob band-aid** (`FRESHELL_SPAWN_GATE_TIMEOUT_MS=60000`, concurrency 6 — the pre-bounce checklist): treats symptoms; codex planning still pins permits, 30s plan death still fires at tab 3+, still no progress UX. Kept only as the operational escape hatch until Slice 1 lands.
2. **Raise plan concurrency (2→N):** trades queue death for memory/CPU stampede of N simultaneous sidecar spawns — the exact ~226s stacking D-C-REVISIT feared. Serialization + queue + progress is strictly better.
3. **Client-only retry** (extend the 2s ladder to `PTY_SPAWN_FAILED`): retries T6 (binary missing) forever or needs the taxonomy anyway; blind to queue state; frozen-client constraint makes iteration slow. Server owns truth; rejected as primary (the existing `RATE_LIMITED` ladder stays as-is).
4. **Separate restore-retry ledger:** second writer over pane lifecycle; violates single-writer; rejected (§P4).
5. **Timeout-with-longer-timeout** (30s→120s plan wait): any fixed wall-clock death loses to a large-enough storm; structural bound (queue-depth × per-plan budget) is the honest bound. Rejected.
6. **Overload `terminal.meta.updated` for progress:** no registry row exists yet; wrong key. Rejected (§P3).
7. **Server-side priority scheduling:** no signal for focus server-side; client send-order achieves it free. Rejected.

---

## 7. Staged implementation plan

Slices sized for the-usual (worktree, plan→implement→review per slice). **S1 is the pre-bounce minimal patch**; S2–S4 complete the mandate.

### Slice 1 — Absorb contention, server-only (pre-bounce; small, no protocol change)

*The user never sees T1/T2 die again; UX during the wait is today's pending state.*

- `crates/freshell-ws/src/terminal.rs`: extract `prepare_launch` (resume-session-id derivation + `plan_codex_managed_launch`) from `handle_create`; `handle_create` accepts `Option<PreparedLaunch>`.
- `crates/freshell-ws/src/create_gate.rs`: call `prepare_launch` before `spawn_gate.acquire`; discard prepared launch in all 4 early-exit arms; restore-class gate wait becomes cancel-aware-unbounded (drop the 10s death for this path only — interactive creates keep `spawn_timeout_ms`).
- `crates/freshell-codex/src/launch_lifecycle.rs`: `LaunchClass` param; restore class queues on the semaphore (cancel-aware) instead of the 30s timeout; plan-queue cap + `RATE_LIMITED` overflow mapping; update the D-C-REVISIT comment block (`:453-458`) to record the supersession.
- `crates/freshell-freshagent/src/terminal_tabs.rs`: pass `LaunchClass::Interactive` (behavior unchanged).
- Tests: unit (budget queue drains N>2 without error via `with_plan_budget` DI; prepared-launch discard on each early exit; gate wait cancels on disconnect); integration restore-storm (§8).

### Slice 2 — Progress protocol + client placeholder

- `crates/freshell-protocol/src/server_messages.rs` + `shared/ws-protocol.ts`: `terminal.restoreProgress`, `errorClass` field.
- Emission: plan-queue enqueue/acquire (P2 callback), gate enqueue, PTY-spawn start.
- Client: `terminalLifecycleSlice.ts` (`recordRestoreProgress`, cleared by `terminal.created`/error), `TerminalView.tsx` placeholder render, `pane-reconcile.ts` error-class gating of the `restoreError` card.

### Slice 3 — Hub-owned retry (defense-in-depth)

- `crates/freshell-ws/src/auto_resume.rs`: `ResumeEvent` enum, restore arm in `decide()` sharing delays + flap-breaker cycles; re-drive via `spawn_gated_restore_create`; loud settle on exhaustion carrying original class.
- Emission from the residual-transient failure arms only.

### Slice 4 — Records + hardening

- `DEVIATIONS.md`: close/annotate D-C-REVISIT (supersede fail-fast), record the A18 sharpening and the A14 evidence (§9).
- e2e: extend `codex_managed_launch_e2e.rs` with a storm phase (fake runtime); client tests for placeholder/banner gating.
- Optional: fold in the resume-button branch as the manual recovery affordance for the loud cases (§9.4).

---

## 8. Test strategy

**Unit (S1):**
- `with_plan_budget(factory, 2, wait)` DI: 8 concurrent restore-class plans, fake runtime with 200ms plans → all 8 succeed, zero `budget exhausted` errors, max concurrency observed = 2; interactive class still times out at `wait`.
- Prepared-launch discard: for each of the 4 early-exit arms, assert sidecar teardown observed (fake runtime records spawn/teardown pairs).
- Cancel-aware waits: fire `cancel_rx` while queued at (a) plan budget, (b) spawn gate → no PTY, no error frame, dedupe sentinel cleared (extends the existing `restore_create_cancelled` pins).

**Integration — the restore-storm test (the mandate's pin):**
- Harness: fake codex runtime (slow: 500ms/plan), spawn gate at defaults (4/64/10s for interactive; restore path unbounded), **8 codex + 4 shell restore-creates** issued in one burst on one connection.
- Assert: (1) **zero** `error` frames of any kind; (2) all 12 `terminal.created` arrive; (3) all 4 shell creates settle before the 4th codex create settles (fairness pin — proves planning is off-permit); (4) plan concurrency never exceeded 2; (5) disconnect mid-storm → remaining queue drains with no PTY spawns and no frames (T11).
- Negative pin: same storm with a fake runtime whose 3rd plan fails deterministically (ENOENT-class) → exactly one loud error frame, `errorClass:'provider'`, other 11 unaffected.

**S2 client tests:** progress frame → placeholder renders with queue position; `terminal.created` clears it; `errorClass:'contention'` never renders the `restoreError` card; unanticipatable class renders it with the existing copy.

**S3:** hub restore-arm decide() table tests (delays, shared cycle window with crash lane, exhaustion → settle with original class); e2e: transient plan failure ×1 then success → pane resumes with no user-visible error.

**e2e (S4):** `codex_managed_launch_e2e.rs` storm phase against the fake app-server; keep `#[ignore]`d real-codex variant for manual pre-release runs (real-codex `--remote … resume` remains CI-unpinned — unchanged risk, out of scope here).

---

## 9. Interactions & records

1. **D-GATE-SOFT:** this design is its generalization — the gate never kills a live pane; now contention never kills a restore. Cite it in the S1 commit.
2. **A14 / D-C-REVISIT** (`launch_lifecycle.rs:453`): the 2/30s fail-fast was explicitly revisit-when-evidence. The S5-flip bounce analysis **is** the evidence (tabs 3+ die at ≥5 codex tabs). S1 supersedes the fail-fast half (restore class) while keeping the half that mattered (concurrency bound 2). Record in DEVIATIONS.md.
3. **Spawn-gate D-C addendum:** permit-hold-from-spawn-to-settle is preserved exactly; only planning moves outside it. The da5d9b5c regression class (early release mid-create) cannot recur — the permit scope still brackets PTY spawn→settle, pinned by `permit_released_only_after_work_completes` (`create_gate.rs:230-249`).
4. **Resume-button branch** (`.worktrees/resume-button`, unmerged): complementary, not competing — it is the *manual* affordance for the loud (unanticipatable) residue; this design shrinks its scope to exactly that residue. Land it after S2 so its button appears only on genuine-failure cards.
5. **Auto-resume flap breaker:** shared cycle window across crash-resumes and restore-retries (P4) keeps the global resurrection budget single and bounded — no new breaker, no second counter.
6. **Frozen-client constraint:** S1 is invisible to the client (strictly fewer error frames). S2's frames are additive. No frozen-client behavior changes required.

## 10. Open questions (decide at implementation, none block S1)

1. Retry re-drive requestId: reuse original vs derived suffix (dedupe-map interaction) — S3.
2. Should interactive codex creates also queue-with-progress instead of 30s fail-fast? Defensible either way; deferred until a user report says otherwise (keeps S1 diff minimal).
3. `queuePosition` fidelity: exact position requires a counting queue around the semaphore; "queued" without a number is acceptable for S2 v1.
