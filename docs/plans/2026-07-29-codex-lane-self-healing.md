# Codex Lane Self-Healing Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the codex rollout status lane self-healing so a single missed
inotify event can no longer silence `terminal.turn.complete` forever (kata
namg): honor notify's Rescan miss-recovery signal on BOTH watcher lanes, and
give the codex lane the busy-deadman ForceRead floor the amplifier lane
already has, bounding worst-case silent stall to `BUSY_DEADMAN_MS` (120 s).

**Architecture:** Two additive pieces mirroring existing amplifier patterns
in the same files. (1) A shared fs-event filter `fs_event_is_relevant` in
`crates/freshell-ws/src/activity.rs`, used by both the codex and amplifier
inotify closures, which additionally forwards Rescan-flagged events
(kernel `IN_Q_OVERFLOW` → `Event::new(EventKind::Other).set_flag(Flag::Rescan)`,
confirmed at notify-6.1.1 `src/inotify.rs:208-211`). (2) The codex tracker's
busy-deadman (`crates/freshell-activity/src/codex.rs:441-447`) changes from
"flip Busy→Unknown, stop" to the amplifier semantics "emit
`TrackerEffect::ForceRead`, STAY Busy, re-arm every window" (mirror of
`crates/freshell-activity/src/amplifier/tracker.rs:332-357`), and the hub's
`codex_frames`/`expire_due` learn to drain those force-reads through the
existing `drain_codex_lane` — exactly as `amplifier_frames`/`expire_due`
already do for the amplifier lane.

**Tech Stack:** Rust (tokio, notify 6.1.1, tracing), cargo test tiers
(tracker unit tests in `freshell-activity`, hub unit tests in
`freshell-ws/src/activity.rs` `mod tests`, integration tests in
`freshell-ws/tests/`), Playwright e2e (`rust-chromium` project), coordinated
vitest suite via `npm test`.

## Global Constraints

- Work in the existing worktree `/home/dan/code/freshell/.worktrees/codex-lane-self-healing`, branch `fix/codex-lane-self-healing`, based on `origin/main` (`e1f4d4c5` or newer — `git fetch origin` first and verify).
- Red-Green-Refactor: every behavior change lands with a test that was red first.
- Quality gates (all must pass before push): `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, coordinated `env -u FRESHELL_BIND_HOST npm test` (set `FRESHELL_TEST_SUMMARY`; WAIT if the coordinator gate is held by another agent — never kill a foreign holder), `npm run test:port`, release build + relevant e2e specs (`terminal-activity-rust`, `idle-gate-semantics-rust`, `codex-status-completeness-rust`, `amplifier-lane-resilience-rust`) on ephemeral ports.
- NEVER touch ports 3001/3002 (the user's LIVE server runs on 3002). NEVER restart the user's server. NEVER use broad kill patterns (`pkill -f ...`, `pkill node`).
- This is a SHARED host: do NOT generate synthetic load to chase reproduction. The deterministic watch-drop simulation in Task 4 is the repro.
- Do NOT widen the 30 s budget of `fresh_pane_locator_identity_reaches_activity_and_turn_complete` (`crates/freshell-ws/tests/codex_locator_activity.rs:100`). Attribution (verified against the record — `git show f2c505e9` and `docs/plans/2026-07-27-deflake-load-flakes.md`): the 10s→30s widening absorbed the DELAYED-under-load frame class (a late frame at 15.43 s); the LOST-frame class this plan fixes blew even the 30 s budget (35.42 s, "plausibly never arrived") and was filed as kata namg. The budget stays as-is: 30 s absorbs delayed delivery; this fix bounds the lost-event class via the Rescan forward + deadman force-read.
- PR POLICY: do NOT create a PR. Push the branch and stop; landing happens outside with the final review verdict.
- Commits: focused and atomic, conventional style, referencing `kata namg`.
- Git identity: commits must use the repo-configured `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`; never write `dan@danshapiro.com` into git config.
- Server code uses NodeNext/ESM (not touched here); all changes are Rust-side.
- `docs/plans/*.md` are working/agent docs (allowed); do not add other end-user markdown docs.

## Audit Verification (load-bearing: claims checked against source)

The systematic-debugging audit was verified against the worktree source at
`e1f4d4c5` before this plan was written. All load-bearing claims CONFIRMED:

- Codex watcher filter at `crates/freshell-ws/src/activity.rs:334-342` and amplifier filter at `:748-756` are the identical `matches!` over `Modify(Data|Any|Name)/Create/Remove/Any` — neither includes `EventKind::Other`, and both closures receive `Ok` events (codex: `let Ok(event) = res else { return }` at `:333`), so a Q_OVERFLOW/Rescan event is received and silently dropped on both lanes.
- notify 6.1.1 (crates.io registry, NOT vendored; no `[patch]`) emits `Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan))` on `EventMask::Q_OVERFLOW` — `notify-6.1.1/src/inotify.rs:208-211`. The event carries no paths and arrives as `Ok`, not `Err`.
- `drain_codex_lane` (`activity.rs:386-407`) has exactly two callers: initial attach (`:383`) and the `CodexFsChange` arm of `handle_event` (`:501-503`). `expire_due` never calls it. No periodic/deadman/reattach re-read exists for codex.
- `codex_frames` (`activity.rs:1107-1153`) has the dead no-op arm `TrackerEffect::ForceRead { .. } => {}` at `:1149`; `amplifier_frames` (`:1155-1203`) collects ForceReads into a `Vec<String>` that ONLY `expire_due` (`:989`, drained at `:1014-1016` via `drain_lane`) consumes.
- Codex tracker: `BUSY_DEADMAN_MS = 120_000` (`codex.rs:51`); `expire()` (`codex.rs:420-453`) flips Busy→Unknown at `:441-447`, resets `last_observed_at` (one-shot, no re-arm), emits only `Changed`, never `ForceRead`. Amplifier's `expire()` deadman (`amplifier/tracker.rs:332-357`) pushes `ForceRead`, touches ONLY `force_read_logged`/`next_force_read_at`, stays Busy, re-arms at `at + DEADMAN`.
- `RolloutTailer::read_new_lines` (`codex_reconcile.rs:62-103`) is offset-based and catches up fully whenever invoked; all four IO failure sites (`:63-65, :66-68, :78-80, :82-84`) return an empty batch indistinguishable from "no new lines". Its doc comment (`:60-61`) claims "the deadman covers a wedged lane" — that deadman does not exist today.
- The codex module doc deviation list (`codex.rs:19-36`) does NOT list the missing self-healing floor — oversight vs. amplifier G4 hardening, not an adjudicated trade-off. Confirmed.

Corrections to the audit's naming (function behavior unchanged): the
amplifier drain is `drain_lane` (`:819`), not `drain_amplifier_lane`;
amplifier's `force_reads` is a tuple return threaded out of the lock, not a
struct field; `TrackerEffect` is a single shared generic enum
(`freshell-activity/src/lib.rs:39-52`) so `ForceRead { terminal_id, at }`
already exists on the codex effect type — no enum change needed.

One additional platform fact that shapes Piece 1: notify's **kqueue** backend
(`kqueue.rs:271`) emits `EventKind::Other` with NO flag as a `_ =>` catch-all.
Matching on `EventKind::Other` would therefore cause spurious reads on
BSD/macOS. The fix gates on `event.need_rescan()` (`event.rs:502-504`, the
crate's own predicate: `matches!(self.flag(), Some(Flag::Rescan))`) instead —
this is the "or gate on `event.flag()==Some(Flag::Rescan)`" option the spec
explicitly allows, and it also catches FSEvents' MustScanSubDirs rescans.

Load-bearing validation addendum (assumption ledger in
`.worktrees/.the-usual-logs/codex-lane-self-healing/load-bearing-ledger.md`):

- Incident attribution: the recorded kata-namg incident's `task_complete`
  WAS durably present at the watched path (kata body: the append was
  expect-guarded; the failure was the never-delivered frame), so the
  deadman force-read (Piece 2) is the incident's actual remedy. A kernel
  Q_OVERFLOW is implausible for that specific incident (each lane owns a
  dedicated inotify instance, `activity.rs:165-169`; default queue depth
  16384 vs. 2-3 events in the test) — Piece 1 is production-plausibility
  hardening mandated by the spec, not the incident fix.
- Codex rollout files are effectively append-only mid-turn (resume opens
  append-mode; forks create NEW files handled by adoption-layer lane
  replacement at `activity.rs:368-378`; rollback is an appended marker), so
  the same-path offset tail-read behind `drain_codex_lane` is sufficient
  recovery for every realistically swallowable event kind.
- The flake history of `codex_locator_activity.rs` distinguishes two
  classes (see Global Constraints): DELAYED-under-load (absorbed by the
  existing 30 s budget, commit `f2c505e9`) vs. LOST (this fix; blew even
  30 s). Task 5 Step 2's gate runs unloaded and passes on baseline — Task
  4's deterministic test, not that gate, is what proves the fix.

## Adjudicated Design Decisions

**D1 — Deadman semantics: STAY Busy (mirror amplifier) + a submit-time
staleness escape for the demotion's one behavioral consumer.** The spec asks
this to be evaluated and documented. Decision: match amplifier on the timer
path, and preserve the retired demotion's submit semantics directly at the
submit site. Rationale: (a) "never fabricate a completion, never demote on a
timer" is the amplifier lane's adjudicated stance
(`amplifier/tracker.rs:13-15`) and the force-read now provides the honest
answer — if the rollout holds the missed `task_complete`, the drain delivers
it within one window; if the turn is genuinely still running, Busy is the
truthful phase; (b) staying Busy keeps `next_deadline()` armed, so the
force-read REPEATS every window — which also retries the tailer's fail-quiet
IO errors (part of Piece 3's failure class) for free; the old Unknown flip
disarmed the timer permanently; (c) VALIDATED CORRECTION (load-bearing
check, ledger A2 — the original claim here was falsified by a full
state-machine trace): with the demotion simply removed, the demotion's one
behavioral consumer — a user submit on a wedged (phantom-Busy) terminal —
takes the queued-submit branch, and the user's real turn's single BEL is
spent clearing the phantom (`transition_after_turn_clear` re-arms Pending;
`record_completion_if_idle` refuses non-Idle at `codex.rs:606-608`): ZERO
completions, no chime, ~2 min of lying blue, strictly worse than the old
demotion's rescue (submit ≥120 s after silence → fresh pending → exactly one
completion, pinned by `dup_bel_chunk_after_stale_accepted_completes_exactly_once`).
Therefore `note_input`'s Busy branch gains a staleness escape: a submit into
a Busy terminal whose silence exceeds `busy_deadman_ms` (measured BEFORE the
submit refreshes `last_observed_at`) takes the fresh-pending path — the old
demotion's exact submit semantics at the same threshold, event-driven
instead of timer-driven, so untouched panes still never demote. Alternatives
considered and rejected: keep-plan-as-is (accepts a strictly-worse dominant
sub-case), demote-after-N-fruitless-force-reads (widens the zero-chime
exposure window to N×120 s and re-introduces timer demotion).
`CodexPhase::Unknown` remains a valid enum variant (protocol unchanged; the
turn-clear guard at `codex.rs:294` keeps accepting it). Consequences handled
in Task 3: the two tracker tests that pin/depend on the demotion
(`busy_deadman_demotes_to_unknown_and_reconcile_repromotes`, `codex.rs:937-953`,
and `dup_bel_chunk_after_stale_accepted_completes_exactly_once`,
`codex.rs:1003-1022`) are re-derived, not deleted, and the escape gets its
own red-first pin. Known residual (pre-existing in BOTH regimes, not a
regression): a submit into a phantom-Busy pane while it is still FRESH
(silence < window) queues and loses the chime — the old demotion never
protected that sub-case either; out of scope here.

**D2 — Optional third piece (tailer degrade signal / codex LaneRetry
parity): DEFERRED, loudly.** The spec permits deferral if noted in the plan
and in the kata comment. Adjudication: (a) the observed failure class — a
missed fs event — is fully covered by Pieces 1+2, and the repeating deadman
force-read additionally converts fail-quiet tailer IO errors from
"silent forever" into "retried every 120 s while busy"; (b) full parity
(`TailerReadOutcome`-style degrade + `LaneRetry` bounded re-attach + loud
give-up) requires retaining `session_id`/`rollout_path` on `CodexLane`, a
`codex_lane_retries` map, `hub_next_deadline` and Exit-teardown wiring, and
give-up UX — a change the size of this entire fix, deserving its own
red-first kata; (c) the deferral is recorded in code (the truthful doc
comments written in Task 4 at `codex_reconcile.rs:58-61` and the module-doc
deviation entry in Task 3 both name it) so it cannot be silently lost.
This is NOT an unresolved coverage gap: the spec explicitly authorizes this
deferral path with these exact conditions, and both conditions are met by
concrete steps below (Task 3 Step 3 (3i), Task 4 Step 3d).

Named residual risks recorded with this deferral (load-bearing validation,
ledger A1/A6 — these fall in the deferred piece-3/attach-retry territory and
are listed so the deferral cannot silently hide them; recommend filing a
follow-up kata for the first two at landing):

- **Silent attach failure:** `attach_codex_rollout`'s three warn-and-return
  exits (`activity.rs:311-319`, `:350-353`, `:355-362`) have no retry and no
  test-visible signal; a passing bind assertion does not prove attach
  succeeded (bind and attach are separate channel events). If the lane never
  attaches, neither piece 1 nor piece 2 helps (no watcher, no Busy seed).
- **Busy-edge loss:** the deadman arms only while the tracker is Busy; if
  the busy edge itself was never observed, no force-read floor exists.
- **Rollout semantics pinned at codex 0.145.0:** append-only-mid-turn was
  verified at that version; `.zst` archival timing unverified.

One further named residual, found by independent (fresh-eyes) review of this
plan and NOT piece-3 territory: **amplifier deadman anchor-pinning
(hot-loop; latent in the amplifier lane, fixed in the codex port).**
`amplifier/tracker.rs::note_output` (`:266-275`) resets only
`force_read_logged` on Busy liveness; a FIRED `next_force_read_at` stays
armed, so output resuming after a deadman fire pins that lane's
`next_deadline()` at a past instant while the fire guard
(`idle_age > window`) is false — the hub loop computes `wait = 0` and spins
`expire_due` until the turn ends. The codex port disarms the anchor on
liveness (Task 3 Step 3g, red-first pinned by
`resumed_output_disarms_the_fired_deadman_anchor`); the matching one-line
amplifier fix is OUT OF SCOPE for this kata (budget freeze; amplifier
tracker changes were never in the spec) — include it in the follow-up kata
recommended above.

Additionally, to close the strict reading of the spec's "note it in the
kata comment" condition: at landing time, post a one-line deferral comment
ON kata namg itself (the code comments citing kata namg satisfy the loose
reading; the kata currently has zero comments). Attach or reference the
spec text there too — its grants currently live only in session
transcripts.

**D3 — Testing the Rescan path without synthetic load.** Kernel Q_OVERFLOW
cannot be produced deterministically without flooding inotify (forbidden:
shared host, no synthetic load). The evidence chain instead is: (i) the
filter decision is extracted into `fs_event_is_relevant` and unit-tested
red-first against a constructed `Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan))`
(exactly the value notify emits, verified at source); (ii) both closures are
reduced to a single call of that function (verified by grep in Task 2 Step 6
— no residual inline `matches!` in either closure); (iii) the end-to-end
"missed event → self-heal" outcome is proven by the deterministic watch-drop
hub test in Task 4, which exercises the same recovery machinery (force-read →
`drain_codex_lane`) that a real Rescan triggers via `CodexFsChange`.

**D4 — Test-scale deadman.** There is no clock abstraction anywhere in these
crates (every tracker method takes explicit `at: i64` epoch-ms; the hub uses
wall-clock `now_ms()`), and the hub-level test cannot wait 120 s. The tracker
gains a `busy_deadman_ms` field (production default `BUSY_DEADMAN_MS`) with a
public setter, which the in-crate hub test shrinks to 500 ms. The override
drives ONLY the busy-deadman arm and `next_deadline()`'s Busy arm; the
pending-liveness window (`has_pending_output_liveness`, `codex.rs:496-504`)
stays on the `BUSY_DEADMAN_MS` constant — shrinking it too would perturb
unrelated pending-decay timing.

## File Structure

No new files. All changes are additive edits to three existing files:

- **Modify:** `crates/freshell-ws/src/activity.rs` — new private free fn `fs_event_is_relevant` (near the other free fns, e.g. above `hub_next_deadline` at `:1042`); both watcher closures (`:332-348` codex, `:738-762` amplifier) call it; `codex_frames` (`:1107-1153`) returns `(Vec<ServerMessage>, Vec<String>)`; its 8 call sites (`:367, :404, :490, :535, :626, :655, :683, :987`) updated; `expire_due` (`:977-1039`) drains codex force-reads via `drain_codex_lane`; new tests in `mod tests`.
- **Modify:** `crates/freshell-activity/src/codex.rs` — `TerminalActivity` gains `force_read_logged`/`next_force_read_at`; `CodexActivityTracker` gains `busy_deadman_ms` (+ manual `Default`, + `set_busy_deadman_ms`); `expire()` deadman arm rewritten; `next_deadline()` Busy arm consults `next_force_read_at`; `note_output`'s Busy/Pending liveness branches disarm a fired deadman anchor; module doc deviation entry added; tests rewritten/added.
- **Modify:** `crates/freshell-ws/src/codex_reconcile.rs` — doc-comment truth-up only (`:58-61`), naming the now-real deadman and the deferred degrade-signal piece.

This is one subsystem (the codex/amplifier activity status lanes) — a single
plan is appropriate; no scope split needed.

---

### Task 1: Baseline — worktree freshness, deps, green base suite

**Files:**
- No source changes. Verification only, inside `/home/dan/code/freshell/.worktrees/codex-lane-self-healing`.

**Interfaces:**
- Consumes: nothing.
- Produces: a verified-green base every later task's red/green signal is meaningful against.

- [ ] **Step 1: Verify base freshness**

```bash
cd /home/dan/code/freshell/.worktrees/codex-lane-self-healing
git fetch origin
git log --oneline -1 origin/main
git merge-base --is-ancestor origin/main HEAD && echo "BASE OK" || echo "BASE STALE - rebase onto origin/main first"
git status --short
# Line-anchor drift guard (ledger A3): the plan's edit targets are
# line-anchored against e1f4d4c5. Any upstream change to the touched files
# invalidates them.
git log --oneline e1f4d4c5..origin/main -- \
  crates/freshell-ws/src/activity.rs \
  crates/freshell-activity/src/codex.rs \
  crates/freshell-ws/src/codex_reconcile.rs \
  crates/freshell-ws/tests/codex_locator_activity.rs
```

Expected: `BASE OK` (branch `fix/codex-lane-self-healing` at `e1f4d4c5` or
newer), status clean apart from committed plan docs. If `BASE STALE`, run
`git rebase origin/main` (the branch carries only the plan-docs commit, so
this is near-trivial) and re-verify. The drift-guard `git log` must print
NOTHING: if any commit touches those four files, do not follow the plan's
line numbers blindly — re-locate every cited anchor by grep (the plan
already names the symbols) before Task 2, and if the drift is semantic
(the audited functions changed behavior), STOP and report instead of
proceeding.

- [ ] **Step 2: Node deps**

```bash
node -e "require.resolve('tsx')" 2>/dev/null || npm ci
[ -e node_modules/tsx ] || ln -s ../node_modules/tsx node_modules/tsx
```

Expected: exits 0. (The symlink line is the repo's documented workaround; the
`[ -e ... ]` guard makes it a no-op when unnecessary.)

- [ ] **Step 3: Rust baseline for the two touched crates**

```bash
cargo test -p freshell-activity -p freshell-ws
```

Expected: all tests PASS. (~2–5 min. `cargo test --workspace` runs later as a
gate; this narrower run keeps the baseline cheap.)

- [ ] **Step 4: Coordinated base suite green**

```bash
FRESHELL_TEST_SUMMARY="codex-lane-self-healing: baseline green check" \
  env -u FRESHELL_BIND_HOST npm test
```

Expected: PASS. If the coordinator gate is held by another agent
(`npm run test:status` shows a holder), WAIT for it — do not kill or bypass.
If the base suite is NOT green, STOP and report the failing command + summary
instead of proceeding (repo rule).

- [ ] **Step 5: No commit** — nothing changed.

---

### Task 2: Forward notify's Rescan signal on both watcher lanes

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs:332-348` (codex closure), `:738-762` (amplifier closure), plus one new private free fn placed with the other module-level free fns (immediately above `fn hub_next_deadline` at `:1042` is a good spot)
- Test: `crates/freshell-ws/src/activity.rs` `mod tests` (starts `:1237`)

**Interfaces:**
- Consumes: `notify::Event` / `notify::EventKind` / `notify::event::ModifyKind` / `notify::event::Flag` (notify is referenced fully-qualified in this file; there are no top-level `use notify::` statements — keep it that way, except inside the new test where local `use` is fine); `Event::need_rescan(&self) -> bool` (notify-6.1.1 `event.rs:502-504`).
- Produces: `fn fs_event_is_relevant(event: &notify::Event) -> bool` (private to `activity.rs`), called by BOTH watcher closures. Task 4's hub test does not use it directly, but the closures' behavior contract ("Rescan forwards as CodexFsChange/AmplifierFsChange") is what makes a real Q_OVERFLOW trigger `drain_codex_lane`/`drain_lane`.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `crates/freshell-ws/src/activity.rs` (anywhere among
the plain `#[test]` fns is fine; near the top of the module keeps it
discoverable):

```rust
    /// KATA namg: notify's inotify backend reports kernel IN_Q_OVERFLOW as
    /// Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)) -- "events
    /// were dropped, re-check the file" (notify-6.1.1 inotify.rs:208-211).
    /// Both lane watchers must forward it as an fs-change so a real overflow
    /// triggers an immediate catch-up read. Gate on the Rescan FLAG, not on
    /// EventKind::Other: the kqueue backend emits flagless Other as a
    /// catch-all (kqueue.rs:271), which must NOT trigger reads, and our own
    /// tail reads produce Access events which must never self-trigger
    /// (zero-polling invariant).
    #[test]
    fn rescan_overflow_is_relevant_but_flagless_other_and_access_are_not() {
        use notify::event::{AccessKind, Flag};
        use notify::{Event, EventKind};

        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(
            fs_event_is_relevant(&overflow),
            "IN_Q_OVERFLOW rescan must trigger a catch-up read"
        );

        let flagless_other = Event::new(EventKind::Other);
        assert!(
            !fs_event_is_relevant(&flagless_other),
            "kqueue catch-all Other (no Rescan flag) must not trigger reads"
        );

        let access = Event::new(EventKind::Access(AccessKind::Any));
        assert!(
            !fs_event_is_relevant(&access),
            "our own tail reads (Access) must never self-trigger"
        );

        let append = Event::new(EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        )));
        assert!(fs_event_is_relevant(&append), "real appends still read");
    }
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cargo test -p freshell-ws --lib activity::tests::rescan_overflow_is_relevant_but_flagless_other_and_access_are_not
```

Expected: FAIL to compile with `cannot find function fs_event_is_relevant`
(compile-fail is the red here — the seam does not exist yet).

- [ ] **Step 3: Implement the shared filter and wire BOTH closures**

Add the free function (place it immediately above `fn hub_next_deadline`):

```rust
/// Shared fs-event filter for the codex and amplifier tail watchers.
///
/// Kind filter: only DATA-mutation events drive a tail read. This is the
/// zero-polling guarantee: our OWN read opens the file, which inotify
/// reports as `Access(..)` (IN_OPEN/IN_CLOSE_NOWRITE) and -- via the atime
/// update -- `Modify(Metadata(..))` (IN_ATTRIB); forwarding either would
/// self-trigger one extra read per real read. Appends arrive as
/// `Modify(Data(..))` (IN_MODIFY); `Create`/`Remove`/`Modify(Name)` cover
/// rotation edge cases.
///
/// Rescan override (kata namg): notify's inotify backend reports kernel
/// IN_Q_OVERFLOW as `Event::new(EventKind::Other).set_flag(Flag::Rescan)`
/// (notify-6.1.1 inotify.rs:208-211) -- "you may have missed events,
/// re-check". It is the library's ONE miss-recovery signal; dropping it
/// leaves a lane silently wedged until an unrelated future write. Gate on
/// `need_rescan()` rather than `EventKind::Other`: the kqueue backend emits
/// flagless `Other` as a `_ =>` catch-all (kqueue.rs:271), which must NOT
/// trigger reads.
fn fs_event_is_relevant(event: &notify::Event) -> bool {
    event.need_rescan()
        || matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                | notify::EventKind::Modify(notify::event::ModifyKind::Any)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                | notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Any
        )
}
```

Rewrite the CODEX closure body (`:332-348`) to use it — replace the
`let relevant = matches!(...); if relevant { ... }` block with:

```rust
            match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                let Ok(event) = res else { return };
                if fs_event_is_relevant(&event) {
                    let _ = tx.send(HubEvent::CodexFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            }) {
```

Rewrite the AMPLIFIER closure body (`:738-762`) the same way — replace the
inline `if matches!(...)` with:

```rust
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res {
                if fs_event_is_relevant(&event) {
                    let _ = tx.send(HubEvent::AmplifierFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            }
        });
```

Update the two now-partially-stale comments so they stay truthful (the
detailed kind/Rescan rationale now lives on `fs_event_is_relevant`):

- Codex side, replace the comment block at `:320-328` ("The event-kind
  filter is the amplifier one VERBATIM (copy the matches! expression from
  activity.rs:422-430)...") with:

```rust
        // Watcher: mirror the amplifier watcher EXACTLY. The closure
        // captures only the hub-event sender + terminal id (never a hub
        // clone: that would put an Arc cycle inside HubInner and let the
        // notify thread emit frames out of order with the hub task). The
        // event filter is the SHARED `fs_event_is_relevant` (same fn as the
        // amplifier lane): data-mutation kinds only, plus the Rescan
        // miss-recovery override -- see its doc comment (kata namg).
```

- Amplifier side, replace the comment block at `:739-746` ("Only
  DATA-mutation events drive a tail read...") with:

```rust
            // Event filter: the SHARED `fs_event_is_relevant` (same fn as
            // the codex lane) -- data-mutation kinds only (zero-polling:
            // our own reads must not self-trigger), plus the Rescan
            // miss-recovery override. See its doc comment (kata namg).
```

- [ ] **Step 4: Run the new test to verify it passes**

```bash
cargo test -p freshell-ws --lib activity::tests::rescan_overflow_is_relevant_but_flagless_other_and_access_are_not
```

Expected: PASS.

- [ ] **Step 5: Run the neighboring lane tests (no regression in real-append paths)**

```bash
cargo test -p freshell-ws --lib activity::
```

Expected: all PASS — in particular
`codex_rollout_lane_seeds_busy_then_clears_via_inotify`,
`amplifier_events_lane_drives_busy_complete_and_idle_via_inotify`, and
`idle_terminals_arm_no_timers_and_read_no_files` (zero-polling stats — the
Access/atime exclusion still holds because the kind list is unchanged).

- [ ] **Step 6: Verify no residual inline filter (both closures use the shared fn)**

```bash
grep -n "ModifyKind::Data" crates/freshell-ws/src/activity.rs
```

Expected: exactly TWO matches — one inside `fs_event_is_relevant`, one
inside the new unit test from Step 1 (its `append` case constructs a
`Modify(Data(..))` event). NEITHER may be inside the codex or amplifier
watcher closure; if a closure still contains its own `matches!` kind list,
the refactor is incomplete; fix before committing.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "fix(ws): forward notify Rescan (IN_Q_OVERFLOW) on codex and amplifier watch lanes (kata namg)"
```

---

### Task 3: Codex busy-deadman emits ForceRead and stays Busy (tracker)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` — module doc (`:19-36`), `TerminalActivity` struct (`:82-108`), `track_terminal` init (`:177-194`), `CodexActivityTracker` struct + `Default` (`:139-143`), `note_input` (`:332-367`, the D1 staleness escape), `expire()` (`:420-453`), `next_deadline()` (`:455-486`), `note_output` liveness branches (`:371-418`)
- Test: `crates/freshell-activity/src/codex.rs` `mod tests` (`:617` onward)

**Interfaces:**
- Consumes: `TrackerEffect::ForceRead { terminal_id: String, at: i64 }` — already exists on `CodexEffect = TrackerEffect<CodexActivityRecord>` (`freshell-activity/src/lib.rs:39-52`, `codex.rs:53`); no enum change. Amplifier template: `amplifier/tracker.rs:332-357` (expire) and `:362-388` (next_deadline).
- Produces (Task 4 relies on these exact signatures):
  - `CodexActivityTracker::expire(&mut self, at: i64) -> Vec<CodexEffect>` now MAY contain `TrackerEffect::ForceRead` entries (busy terminal silent past the window; repeats every window; phase stays `CodexPhase::Busy`).
  - `pub fn set_busy_deadman_ms(&mut self, ms: i64)` on `CodexActivityTracker`.
  - `next_deadline()` keeps returning `Some(..)` while a terminal is Busy (re-armed by each fire), so the hub timer keeps waking.
  - `note_input` D1 staleness escape (tracker-internal behavior, no signature change): a submit into a Busy terminal silent past `busy_deadman_ms` takes the fresh-pending path instead of queueing (the retired demotion's submit semantics, same threshold).

- [ ] **Step 1: Write the failing tests**

Add a `force_reads` counting helper to the codex test module (copy of
`amplifier/tracker.rs:477-482`), next to the existing `phases`/`completions`
helpers (`codex.rs:621-642`):

```rust
    fn force_reads(effects: &[CodexEffect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, TrackerEffect::ForceRead { .. }))
            .count()
    }
```

Add the new deadman pin (mirror of amplifier's
`deadman_force_reads_but_stays_busy`, `amplifier/tracker.rs:564-578`,
extended with the repeat assertion). It uses the existing `started()` helper
(`codex.rs:835-840`):

```rust
    #[test]
    fn deadman_force_reads_and_stays_busy_then_repeats() {
        // KATA namg: the codex busy-deadman self-heals instead of demoting.
        // A busy terminal silent past the window requests a rollout
        // force-read and STAYS busy -- never fabricate a completion, never
        // demote on a timer -- and repeats every window while the silence
        // persists (each repeat also retries a fail-quiet tailer read).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy

        let effects = tracker.expire(200 + BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1, "silent busy requests a force-read");
        assert_eq!(
            tracker.list()[0].phase,
            CodexPhase::Busy,
            "the deadman never demotes on a timer"
        );
        assert!(
            phases(&effects).is_empty(),
            "staying busy is not a public change -- no Changed frame"
        );

        // Not due again until the repeat interval.
        assert!(tracker.expire(200 + BUSY_DEADMAN_MS + 2).is_empty());

        // Still silent a full window later: fires again.
        let again = tracker.expire(200 + 2 * BUSY_DEADMAN_MS + 2);
        assert_eq!(force_reads(&again), 1);
    }
```

Add the deadline pin (the hub timer must stay armed while busy — the repeat
depends on it):

```rust
    #[test]
    fn busy_deadline_follows_the_force_read_rearm() {
        // Pin RELATIVE to next_deadline() rather than assuming which
        // observation timestamp seeded last_observed_at.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let d0 = tracker.next_deadline().expect("busy arms the deadman timer");
        let fired = tracker.expire(d0);
        assert_eq!(force_reads(&fired), 1, "expiring at the armed deadline fires");
        assert_eq!(
            tracker.next_deadline(),
            Some(d0 + BUSY_DEADMAN_MS),
            "after the fire the deadline follows the re-arm anchor"
        );
    }
```

Add the fire-then-resume hot-loop guard pin (fresh-eyes review, iteration 1:
the amplifier idiom copied as-is never clears a fired anchor when Busy-phase
output resumes, so `next_deadline()` returns a constant PAST instant while
the fire guard `idle_age > window` is false — the hub loop computes
`wait = 0` and spins `expire_due` until the turn ends):

```rust
    #[test]
    fn resumed_output_disarms_the_fired_deadman_anchor() {
        // KATA namg: a deadman fire arms next_force_read_at; if output then
        // resumes mid-turn, the liveness refresh must DISARM the anchor.
        // Otherwise next_deadline()'s Busy arm returns the stale (past)
        // anchor while expire()'s fire guard stays false -- nothing ever
        // fires or re-arms, and the hub loop spins at wait = 0 until the
        // turn ends. (Latent in the amplifier template, which resets only
        // the warn latch on liveness; fixed in this port -- see D2.)
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy
        let d0 = tracker.next_deadline().expect("busy arms the deadman");
        assert_eq!(force_reads(&tracker.expire(d0)), 1, "silent busy fires");

        // Output resumes mid-turn: the refresh must re-base the deadline
        // in the FUTURE relative to the new observation.
        let resume_at = d0 + 50;
        tracker.note_output("t1", "still streaming", resume_at);
        assert_eq!(
            tracker.next_deadline(),
            Some(resume_at + BUSY_DEADMAN_MS + 1),
            "resumed liveness disarms the fired anchor (no wait=0 hot-loop)"
        );
        assert!(
            tracker.expire(resume_at + 1).is_empty(),
            "a live turn never fires the deadman"
        );

        // A fresh full window of silence after the resume fires again.
        let again = tracker.expire(resume_at + BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&again), 1);
    }
```

Add the test-scale override pin (Task 4's hub test depends on this):

```rust
    #[test]
    fn deadman_window_is_overridable_for_test_scale() {
        let mut tracker = CodexActivityTracker::new();
        tracker.set_busy_deadman_ms(500);
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let d0 = tracker
            .next_deadline()
            .expect("busy arms the (shrunk) deadman timer");
        assert!(d0 <= 200 + 501, "the shrunk window drives the deadline");
        let effects = tracker.expire(d0);
        assert_eq!(force_reads(&effects), 1);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }
```

Add the D1 submit-time staleness escape pin (validated correction, ledger
A2: without this, removing the demotion makes a submit into a wedged pane
lose its chime entirely — the single real BEL gets spent clearing the
phantom turn):

```rust
    #[test]
    fn submit_into_stale_busy_starts_fresh_pending_and_completes_once() {
        // KATA namg (D1): the retired Busy->Unknown demotion had exactly ONE
        // behavioral consumer -- a user submit into a wedged (phantom-Busy)
        // terminal took the fresh-pending branch, and the next BEL completed
        // exactly once. Preserve that consumer directly at the submit site:
        // a submit into a Busy terminal SILENT past the deadman window
        // starts a FRESH pending turn (same threshold as the old demotion)
        // instead of queueing behind a turn end that will never come --
        // queueing would spend the real turn's single BEL on the phantom
        // and never chime.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // phantom busy
        let submit_at = 200 + 2 * BUSY_DEADMAN_MS; // still silent: stale
        tracker.note_input("t1", "\r", submit_at);
        assert_eq!(
            tracker.list()[0].phase,
            CodexPhase::Pending,
            "a stale-busy submit rescues a fresh pending turn (not a queue)"
        );
        let bel = tracker.note_output("t1", "\u{07}", submit_at + 500);
        assert_eq!(
            completions(&bel).len(),
            1,
            "the real turn's single BEL completes exactly once"
        );
    }
```

(A submit into a FRESH busy terminal — silence within the window — must
still queue; that behavior is already pinned by the existing
`queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`
(`codex.rs:691-709`), which stays untouched and must stay green.)

- [ ] **Step 2: Run them to make sure they fail**

```bash
cargo test -p freshell-activity -- \
  codex::tests::deadman_force_reads_and_stays_busy_then_repeats \
  codex::tests::busy_deadline_follows_the_force_read_rearm \
  codex::tests::resumed_output_disarms_the_fired_deadman_anchor \
  codex::tests::deadman_window_is_overridable_for_test_scale \
  codex::tests::submit_into_stale_busy_starts_fresh_pending_and_completes_once
```

(Multiple test filters must go after `--`; cargo itself accepts only one
positional filter.)

Expected: FAIL to compile (`set_busy_deadman_ms` not found). That is the red.
(If you comment out the override test to check the others: red with
`force_reads == 0` and `phase == Unknown` — today's demotion — the resume
test red at its first assert for the same reason, and the
staleness-escape test red with phase `Busy` and zero completions — today's
queued branch.)

- [ ] **Step 3: Implement the tracker changes**

3a. `TerminalActivity` (`codex.rs:82-108`) — add two fields at the end of the
struct (after `parser_state`):

```rust
    /// Deadman self-heal (kata namg; mirror of amplifier/tracker.rs:51-52):
    /// warn-once latch for the stuck-busy force-read log line.
    force_read_logged: bool,
    /// Deadman re-arm anchor: the busy force-read repeats every
    /// `busy_deadman_ms` while the silence persists.
    next_force_read_at: Option<i64>,
```

3b. `track_terminal`'s literal (`codex.rs:177-194`) — initialize both:

```rust
            force_read_logged: false,
            next_force_read_at: None,
```

3c. Re-arm freshness: a NEW turn must arm a fresh deadman + fresh warn
latch. Find every promotion-to-Busy assignment:

```bash
grep -n "phase = CodexPhase::Busy" crates/freshell-activity/src/codex.rs
```

and immediately after each such assignment add:

```rust
                state.force_read_logged = false;
                state.next_force_read_at = None;
```

(Expected sites: the `reconcile_rollout` promotion path and — if present —
the queued-submit re-promotion path. The `due` predicate below is a
conjunction with `idle_age_ms > window`, so a stale anchor cannot fire early;
this reset exists so the warn latch and anchor start fresh per turn. Do NOT
add resets to non-Busy assignments.)

3d. `CodexActivityTracker` (`codex.rs:139-143`) — add the window field and a
manual `Default` (the derive would default `busy_deadman_ms` to 0):

```rust
#[derive(Debug)]
pub struct CodexActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
    /// Busy-deadman window; [`BUSY_DEADMAN_MS`] in production. Overridable
    /// (test-scale hook) because there is no clock abstraction -- `expire`
    /// takes wall-clock ms and the hub uses `now_ms()`. Drives ONLY the
    /// busy-deadman + its `next_deadline` arm; the pending-liveness window
    /// stays on the constant.
    busy_deadman_ms: i64,
}

impl Default for CodexActivityTracker {
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            ledger: TurnCompletionLedger::default(),
            busy_deadman_ms: BUSY_DEADMAN_MS,
        }
    }
}
```

(Remove `Default` from the existing `#[derive(Debug, Default)]`; keep the
existing `new()` — it delegates to `Default` and keeps working. `HubInner`'s
`#[derive(Default)]` also keeps working through this impl.)

Add the setter next to the other `pub fn`s (e.g. right after `new()`):

```rust
    /// Test-scale hook: override the busy-deadman window (production
    /// default [`BUSY_DEADMAN_MS`]). Hub-level tests shrink it so the
    /// missed-event self-heal (kata namg) runs in test time.
    pub fn set_busy_deadman_ms(&mut self, ms: i64) {
        self.busy_deadman_ms = ms;
    }
```

3e. `expire()` (`codex.rs:420-453`) — hoist the window before the loop and
replace the demotion arm (`:441-447`) with the amplifier-mirror force-read.
The full method becomes:

```rust
    /// `expire` / `expireState` (`codex-activity-tracker.ts:350-573`), the
    /// pending-decay + busy-deadman transitions, deadline-driven.
    pub fn expire(&mut self, at: i64) -> Vec<CodexEffect> {
        let mut effects = Vec::new();
        let busy_deadman_ms = self.busy_deadman_ms;
        for state in self.states.values_mut() {
            let previous = state.to_record();

            if let Some(pending_until) = state.pending_until {
                if at > pending_until {
                    state.pending_until = None;
                }
            }

            if state.phase == CodexPhase::Pending && state.pending_until.is_none() {
                if !awaiting_fresh_snapshot(state, at) && !has_pending_output_liveness(state, at) {
                    state.phase = CodexPhase::Idle;
                    state.updated_at = at;
                    state.last_observed_at = at;
                    state.pending_submit_at = None;
                    state.pending_freshness_at = None;
                }
            } else if state.phase == CodexPhase::Busy {
                // Deadman (kata namg; mirror of amplifier/tracker.rs:332-357):
                // a busy terminal silent past the window requests a rollout
                // force-read and STAYS busy -- never fabricate a completion,
                // never demote on a timer. The hub drains the force-read via
                // drain_codex_lane; the offset-based tailer catches up fully,
                // so a missed inotify event costs at most one window instead
                // of a silent-forever stall. Repeats every window while the
                // silence persists (each repeat also retries a fail-quiet
                // tailer read).
                let idle_age_ms = at - state.last_observed_at;
                let due = state
                    .next_force_read_at
                    .map(|next| at >= next)
                    .unwrap_or(idle_age_ms > busy_deadman_ms);
                if idle_age_ms > busy_deadman_ms && due {
                    if !state.force_read_logged {
                        state.force_read_logged = true;
                        tracing::warn!(
                            component = "codex-activity-tracker",
                            event = "codex_activity_deadman_force_read",
                            terminal_id = %state.terminal_id,
                            age_ms = idle_age_ms,
                            "Codex terminal silent past deadman; requesting rollout force-read (staying busy)."
                        );
                    }
                    state.next_force_read_at = Some(at + busy_deadman_ms);
                    effects.push(TrackerEffect::ForceRead {
                        terminal_id: state.terminal_id.clone(),
                        at,
                    });
                }
            }

            let next = state.to_record();
            effects.extend(changed(Some(&previous), next));
        }
        effects
    }
```

(Note: unlike the old arm, `updated_at`/`last_observed_at` are NOT touched on
fire — that is exactly what makes the repeat interval work, same as
amplifier. Staying Busy produces no `Changed` effect via `changed()`.)

3f. `next_deadline()` Busy arm (`codex.rs:482`) — replace

```rust
                CodexPhase::Busy => Some(state.last_observed_at + BUSY_DEADMAN_MS + 1),
```

with the amplifier idiom (`amplifier/tracker.rs:373-375`):

```rust
                CodexPhase::Busy => Some(
                    state
                        .next_force_read_at
                        .unwrap_or(state.last_observed_at + self.busy_deadman_ms + 1),
                ),
```

Also change the Pending arm's liveness term (`codex.rs:476`) — leave it on
`BUSY_DEADMAN_MS` (the constant): pending-liveness is deliberately NOT
covered by the override (see the field doc). No edit needed there; just do
not "helpfully" convert it.

3g. `note_output` liveness branches (`codex.rs:371-418`) — disarm the
deadman on resumed output (the fire-then-resume hot-loop guard; a deliberate
DIVERGENCE from the amplifier template, which resets only the warn latch —
see the named residual in D2). Both non-clearing liveness branches (the
`count == 0` ordinary-output branch at `:378-383` and the `clear_count == 0`
non-clearing-signal branch at `:386-391`) currently read identically:

```rust
        if state.phase == CodexPhase::Busy || state.phase == CodexPhase::Pending {
            state.last_observed_at = at;
        }
```

Extend BOTH to:

```rust
        if state.phase == CodexPhase::Busy || state.phase == CodexPhase::Pending {
            state.last_observed_at = at;
            // Deadman disarm (kata namg): observed output IS liveness --
            // clear a fired anchor + warn latch so next_deadline()'s Busy
            // arm re-bases on the refreshed last_observed_at. An armed
            // stale anchor would pin the deadline at a PAST instant while
            // the fire guard (idle_age > window) is false: expire() never
            // fires/re-arms and the hub loop spins at wait = 0 until the
            // turn ends. (Latent in amplifier/tracker.rs:266-275, which
            // resets only force_read_logged; divergence recorded in the
            // module doc and plan D2.)
            state.force_read_logged = false;
            state.next_force_read_at = None;
        }
```

(The BEL-consuming path (`clear_count > 0`, `:393-417`) needs no edit: every
path that keeps or returns a terminal to Busy runs through a
`phase = CodexPhase::Busy` assignment, which 3c already resets, and
completion paths leave Busy. For Pending the two fields are dormant — the
deadman reads them only while Busy — so the unconditional reset inside the
shared Busy/Pending branch is safe.)

3h. `note_input` staleness escape (D1; `codex.rs:332-367`) — the retired
demotion's one behavioral consumer, preserved at the submit site. Two edits
inside the existing function; everything else stays byte-for-byte:

First, compute staleness BEFORE the observation timestamps are refreshed
(insert after `let previous = state.to_record();` at `:339`):

```rust
        // KATA namg (D1): submit-time staleness escape -- the one
        // behavioral consumer of the retired Busy->Unknown demotion. A
        // submit into a Busy terminal SILENT past the deadman window is a
        // user acting on a wedged/phantom turn (the deadman force-reads
        // could not heal it): treat it as a FRESH pending turn -- the old
        // demotion's submit semantics at the same threshold -- instead of
        // queueing behind a turn end that will never come (queueing would
        // spend the real turn's single BEL clearing the phantom: zero
        // completions, no chime). Measured BEFORE last_observed_at is
        // refreshed by this very submit.
        let stale_busy = state.phase == CodexPhase::Busy
            && at - state.last_observed_at > self.busy_deadman_ms;
```

Second, route a stale-busy submit past the queued branch and through the
same stale-state hygiene the Unknown branch already has — change the two
conditions (`:344` and `:353`):

```rust
        if state.phase == CodexPhase::Busy && !stale_busy {
```

```rust
        if state.phase == CodexPhase::Idle || state.phase == CodexPhase::Unknown || stale_busy {
```

(Do NOT clear `accepted_start_at` here — the old post-demotion path left it
stale too, and the pending-clear path nulls it on the next BEL (CE2, the
`transition_pending_after_turn_clear` anchor-null); clearing it here would
diverge from the pinned old behavior. Note the field-borrow shape:
`self.busy_deadman_ms` is a disjoint field read while `state` borrows
`self.states` — this compiles as-is.)

3i. Module doc — append a third entry to the deviation list
(`codex.rs:19-36`, after deviation 2):

```rust
//! 3. **The busy-deadman self-heals instead of demoting** (kata namg): a
//!    busy terminal silent past [`BUSY_DEADMAN_MS`] emits
//!    `TrackerEffect::ForceRead` (the hub drains it via `drain_codex_lane`)
//!    and STAYS busy, repeating every window -- it no longer flips
//!    Busy->Unknown on a timer. This is the amplifier lane's G4
//!    missed-signal floor (see `amplifier/tracker.rs`) -- with one
//!    divergence: resumed output DISARMS a fired force-read anchor (the
//!    `note_output` liveness reset), because an armed stale anchor pins
//!    `next_deadline()` at a past instant and hot-loops the hub (latent in
//!    the template; see the plan's D2 residual note). Ported because the
//!    rollout lane is a single unbroken inotify->mpsc->drain chain with zero
//!    redundant delivery: one missed fs event used to silence
//!    terminal.turn.complete forever. The retired demotion's ONE behavioral
//!    consumer -- a user submit into a wedged pane -- is preserved by the
//!    submit-time staleness escape in `note_input` (silence past the window
//!    at submit time takes the fresh-pending path, same threshold as the
//!    old demotion). The tailer's fail-quiet IO errors are
//!    retried on the same cadence; a LaneRetry-equivalent loud-degrade path
//!    (TailerReadOutcome parity) is deliberately DEFERRED -- see
//!    docs/plans/2026-07-29-codex-lane-self-healing.md (D2).
```

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
cargo test -p freshell-activity -- \
  codex::tests::deadman_force_reads_and_stays_busy_then_repeats \
  codex::tests::busy_deadline_follows_the_force_read_rearm \
  codex::tests::resumed_output_disarms_the_fired_deadman_anchor \
  codex::tests::deadman_window_is_overridable_for_test_scale \
  codex::tests::submit_into_stale_busy_starts_fresh_pending_and_completes_once
```

Expected: PASS (5 tests).

- [ ] **Step 5: Re-derive the two demotion-dependent tests**

Run the crate suite first to see exactly what broke:

```bash
cargo test -p freshell-activity
```

Expected failures: `busy_deadman_demotes_to_unknown_and_reconcile_repromotes`
(`codex.rs:937-953` — pins the removed demotion; any phase assertion on
`Unknown` now sees `Busy`) and possibly
`dup_bel_chunk_after_stale_accepted_completes_exactly_once`
(`codex.rs:1003-1022` — its setup comment says "demote to Unknown"; the
demotion no longer happens, but its stale-silence `note_input` now takes the
D1 staleness escape (3h) into the same fresh-pending path, so its
completion assertions may even stay green — replace it regardless, because
its name and setup comments now lie about the mechanism). Everything else
must still pass — in particular
`queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`
(`codex.rs:691-709`, the FRESH-busy queued branch, untouched by the
staleness escape) and `deadline_driven_expiry_converges_for_a_quiet_submit`
(`codex.rs:748-762`), which starts from Pending, reaches Idle, and converges;
if it hangs, the Pending arm was wrongly converted in 3f.

REPLACE `busy_deadman_demotes_to_unknown_and_reconcile_repromotes` with a
liveness-reset pin (the demotion pin's job — "don't lie blue forever" — is
now done by `deadman_force_reads_and_stays_busy_then_repeats`; this
replacement pins that observed liveness defers the deadman, mirror of
amplifier's `output_feeds_the_deadman_only`):

```rust
    #[test]
    fn busy_deadman_defers_while_output_liveness_continues() {
        // KATA namg replacement for the retired Busy->Unknown demotion pin:
        // the deadman fires on SILENCE, so rollout/PTY observations that
        // refresh last_observed_at keep deferring it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy
        tracker.note_output("t1", "streaming...", 100_000); // liveness
        assert!(
            tracker.expire(200 + BUSY_DEADMAN_MS + 1).is_empty(),
            "observed at 100_000: not yet silent past the window"
        );
        let effects = tracker.expire(100_000 + BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1, "silence measured from the last observation");
    }
```

(If `note_output` on a Busy codex terminal does not refresh
`last_observed_at` — verify by reading `note_output` in `codex.rs` — use a
second `reconcile_rollout("t1", &started(...), 100_000)` observation instead
of `note_output` and keep the same two assertions. The pinned invariant is
"silence is measured from the last observation", not the specific input
channel.)

REPLACE `dup_bel_chunk_after_stale_accepted_completes_exactly_once` with the
re-derived CE2 pin (same load-bearing invariant; the rescue mechanism is now
the D1 submit-time staleness escape instead of the timer demotion):

```rust
    #[test]
    fn dup_bel_chunk_after_stale_busy_submit_completes_exactly_once() {
        // CE2 re-derived for the self-healing deadman (kata namg): the
        // deadman no longer demotes to Unknown; instead, a submit into the
        // stale-silent Busy terminal takes the D1 staleness escape into a
        // FRESH pending turn (note_input, same threshold as the retired
        // demotion). A dup-BEL chunk (real PTY behavior, see the existing
        // dup-BEL test) must still stamp exactly ONE completion for the one
        // physical turn end -- the pending-clear path nulls the phantom's
        // stale accepted anchor, so the second BEL of the chunk finds no
        // turn to complete. The load-bearing invariant is one completion
        // per physical turn end, regardless of which branch armed it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy, accepted=100
        tracker.expire(200 + BUSY_DEADMAN_MS + 1); // deadman fires; stays busy
        let submit_at = 200 + BUSY_DEADMAN_MS + 1_000; // silence > window: stale
        tracker.note_input("t1", "\r", submit_at); // staleness escape: fresh pending
        let bel = tracker.note_output("t1", "\u{07}\u{07}", submit_at + 500);
        assert_eq!(
            completions(&bel).len(),
            1,
            "one turn end -> exactly one completion, even for a dup-BEL chunk"
        );
    }
```

If this assertion fails because the pending-clear semantics legitimately
differ (e.g. the dup BEL re-arms rather than emitting), do NOT force it
green by weakening to `<= 1`: read the surrounding queued-submit tests
(`stacked submits` family) and the old test's CE2 comments to derive the
correct expected frame sequence, pin THAT, and keep the "exactly one
completion per physical turn end" invariant as the assertion message.
Document the derivation in the test comment.

- [ ] **Step 6: Full crate green**

```bash
cargo test -p freshell-activity
```

Expected: PASS (all tests, including the amplifier tracker suite untouched).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-activity/src/codex.rs
git commit -m "fix(activity): codex busy-deadman force-reads and stays busy instead of demoting (kata namg)"
```

---

### Task 4: Hub drains codex force-reads; deterministic missed-event self-heal test

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` — `codex_frames` (`:1107-1153`), its 8 call sites (`:367, :404, :490, :535, :626, :655, :683, :987` — line numbers pre-Task-2; re-locate with `grep -n "codex_frames(" crates/freshell-ws/src/activity.rs`), `expire_due` (`:977-1039`)
- Modify: `crates/freshell-ws/src/codex_reconcile.rs:58-61` (doc truth-up)
- Test: `crates/freshell-ws/src/activity.rs` `mod tests`

**Interfaces:**
- Consumes: `CodexActivityTracker::expire` emitting `TrackerEffect::ForceRead { terminal_id, at }` and `set_busy_deadman_ms(&mut self, ms: i64)` (Task 3); `fn drain_codex_lane(&self, terminal_id: &str)` (existing, `activity.rs:387`); `notify::Watcher::unwatch` (test only); test fixtures `hub()`, `observer_send`, `next_frame_matching`, `next_frame_of_type`, `codex_rollout_fixture`, `codex_event_line` (all existing in `mod tests`).
- Produces: `fn codex_frames(idle: &mut IdleGate, effects: Vec<TrackerEffect<CodexActivityRecord>>) -> (Vec<ServerMessage>, Vec<String>)` — second element is force-read terminal ids, consumed ONLY by `expire_due` (identical contract to `amplifier_frames`, `:1155-1203`).

- [ ] **Step 1: Write the failing hub test**

Add to `mod tests` in `activity.rs`, next to the other codex lane tests
(after `codex_rollout_lane_seeds_busy_then_clears_via_inotify`):

```rust
    /// KATA namg: a missed inotify event must not silence
    /// terminal.turn.complete forever. Deterministic simulation of the miss:
    /// unwatch the lane's inotify watch BEFORE the task_complete append (the
    /// append then emits no fs event -- exactly the shape of a kernel queue
    /// overflow dropping the last append of a turn), and assert the
    /// busy-deadman force-read (shrunk to test scale) still delivers the
    /// completion -- exactly once, with exactly one idle chime after it
    /// (idle-gate interaction pin: a ForceRead-triggered late completion
    /// must not double-chime and must carry the correct idle reason).
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_missed_fs_event_self_heals_via_deadman_force_read() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout shows an unresolved turn: the lane seeds busy on attach.
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("seeded busy upsert");

        // Simulate the missed event + shrink the deadman to test scale.
        {
            use notify::Watcher;
            let mut inner = hub.inner.lock().unwrap();
            inner.codex.set_busy_deadman_ms(500);
            let lane = inner.codex_lanes.get_mut("t1").expect("lane installed");
            lane._watcher.unwatch(&rollout).expect("unwatch");
        }

        // The turn completes on disk -- but with the watch dropped, NO
        // CodexFsChange will ever arrive for this append.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_complete", now + 1_000)).expect("write");
        }

        // Barrier: the hub loop recomputes its one-shot deadline only when
        // it processes an event, and it is currently parked on the deadline
        // computed BEFORE the shrink. Any event re-arms it.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t2".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: crate::terminal::now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t2"
        })
        .await
        .expect("barrier upsert for t2");

        // RED today: without the expire_due force-read drain this NEVER
        // arrives (the missed append is re-read by nothing).
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 10_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete delivered by the deadman force-read");
        assert_eq!(complete["provider"], "codex");
        assert_eq!(complete["sessionId"], "sess-1");

        // Exactly one chime.
        assert!(
            next_frame_matching(&mut rx, "terminal.turn.complete", 1_000, |v| {
                v["terminalId"] == "t1"
            })
            .await
            .is_none(),
            "the self-healed completion must not double-chime"
        );

        // Idle-gate interaction: one idle, correct reason (no queued
        // submits in this flow -> grace).
        let idle = next_frame_matching(&mut rx, "terminal.idle", 5_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("terminal.idle after the self-healed completion");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_matching(&mut rx, "terminal.idle", 1_000, |v| {
                v["terminalId"] == "t1"
            })
            .await
            .is_none(),
            "exactly one idle emission"
        );
    }
```

(Frame-shape note: `terminal_id`/`session_id` serialize as
`terminalId`/`sessionId` — match the existing tests in this module, e.g.
`:2466-2472`. If `next_frame_matching` in this module returns
`Option<serde_json::Value>` via `.await` — check its signature next to
`next_frame_of_type` — the `.is_none()` uses above are correct; if it
panics on timeout instead, use `next_frame_of_type(&mut rx, ..., 1_000)`
with a filter loop the way `draining_stacked_submits_emits_one_queue_empty_idle`
(`:2140-2145`) asserts absence, keeping the same assertions.)

- [ ] **Step 2: Run it to make sure it fails**

```bash
cargo test -p freshell-ws --lib activity::tests::codex_missed_fs_event_self_heals_via_deadman_force_read
```

Expected: FAIL at `expect("turn complete delivered by the deadman
force-read")` after the 10 s wait — the tracker (Task 3) emits `ForceRead`,
but `codex_frames` still discards it (`TrackerEffect::ForceRead { .. } => {}`)
and `expire_due` never calls `drain_codex_lane`. This is the never-delivered
frame from the audit, reproduced deterministically.

- [ ] **Step 3: Wire the hub**

3a. `codex_frames` (`:1107-1153`) — change the signature and the ForceRead
arm to mirror `amplifier_frames` exactly:

```rust
/// Codex effects additionally surface force-read requests (the lane drains
/// them after the lock is released -- expire_due only; kata namg).
fn codex_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<CodexActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                // ... UNCHANGED body of the existing Changed arm ...
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                // ... UNCHANGED body of the existing TurnComplete arm ...
            }
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
        }
    }
    (frames, force_reads)
}
```

(Keep the two existing arm bodies byte-for-byte; only the signature, the two
`let mut` bindings, the ForceRead arm, and the return value change.
`claude_frames`' no-op ForceRead arm at `:1101` stays as-is — the claude
tracker never emits ForceRead.)

3b. Update the 8 call sites. Only `expire()` produces `ForceRead`, so every
site EXCEPT `expire_due` discards the second element — same convention as
`amplifier_frames`' non-expire callers. Locate them:

```bash
grep -n "codex_frames(" crates/freshell-ws/src/activity.rs
```

For sites shaped `let frames = codex_frames(&mut inner.idle, effects);` or a
block-tail `codex_frames(&mut inner.idle, effects)`:

```rust
                    let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                    frames
```

For sites shaped `frames.extend(codex_frames(&mut inner.idle, ...));` (the
`expire_due` site at `:987`) — see 3c. For any site shaped
`let frames = { ... codex_frames(...) };` adapt with the same
tuple-destructure-and-discard. Do not drain force-reads anywhere except
`expire_due` (single-drain invariant, mirrors amplifier).

3c. `expire_due` (`:977-1039`) — collect and drain the codex force-reads.
Change the block binding and the codex line:

```rust
        let (frames, codex_force_reads, force_reads, reattaches) = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let mut frames = Vec::new();
            let claude = inner.claude.expire(now);
            frames.extend(claude_frames(&mut inner.idle, claude));
            let codex = inner.codex.expire(now);
            let (mut f, codex_force_reads) = codex_frames(&mut inner.idle, codex);
            frames.append(&mut f);
            let amplifier = inner.amplifier.expire(now);
            let (mut f, force_reads) = amplifier_frames(&mut inner.idle, amplifier);
            frames.append(&mut f);
            // ... UNCHANGED: idle.expire loop, lane_retries scan ...
            (frames, codex_force_reads, force_reads, reattaches)
        };
        self.emit(frames);
        // KATA namg: service codex deadman force-reads -- the self-healing
        // floor for a missed rollout fs event. drain_codex_lane no-ops when
        // the lane is gone (get_mut miss), which is correct: exit tears the
        // tracker down with the lane, and a re-attach replaces both.
        for terminal_id in codex_force_reads {
            self.drain_codex_lane(&terminal_id);
        }
        for terminal_id in force_reads {
            self.drain_lane(&terminal_id);
        }
        // ... UNCHANGED: reattaches loop ...
```

Also update the `expire_due` doc comment (`:977-978`) from "then service any
amplifier force-read requests" to "then service any codex + amplifier
force-read requests".

3d. Truth-up the tailer doc comment,
`crates/freshell-ws/src/codex_reconcile.rs:58-61` — replace:

```rust
    /// Read bytes appended since the last read and return the COMPLETE lines
    /// among them; an unterminated trailing fragment is buffered for the next
    /// read. IO errors and a shrunk file yield an empty batch (fail quiet;
    /// the deadman covers a wedged lane).
```

with:

```rust
    /// Read bytes appended since the last read and return the COMPLETE lines
    /// among them; an unterminated trailing fragment is buffered for the next
    /// read. IO errors and a shrunk file yield an empty batch -- fail quiet;
    /// the codex busy-deadman (kata namg) retries the read every
    /// BUSY_DEADMAN_MS while the terminal stays busy, so a transient IO
    /// error costs at most one window. DEFERRED (adjudicated, kata namg /
    /// docs/plans/2026-07-29-codex-lane-self-healing.md D2): a
    /// TailerReadOutcome-style loud degrade signal + LaneRetry-equivalent
    /// bounded re-attach (amplifier parity) -- a permanently unreadable
    /// rollout currently retries quietly on the deadman cadence instead of
    /// degrading loudly.
```

- [ ] **Step 4: Run the new test to verify it passes**

```bash
cargo test -p freshell-ws --lib activity::tests::codex_missed_fs_event_self_heals_via_deadman_force_read
```

Expected: PASS. (Mechanism: the barrier event makes the hub loop recompute
`hub_next_deadline`; `inner.codex.next_deadline()` now returns
`last_observed + 501` which is already past, the one-shot timer fires,
`expire_due` collects the `ForceRead`, `drain_codex_lane` reads the appended
`task_complete`, and the completion + single grace idle flow out. If the
force-read fires before the append lands, the re-arm repeats 500 ms later
and converges — the repeat semantics from Task 3 make this race-free.)

- [ ] **Step 5: Full hub module green**

```bash
cargo test -p freshell-ws --lib activity::
```

Expected: all PASS — including the idle-gate hub pins
(`draining_stacked_submits_emits_one_queue_empty_idle`,
`codex_queued_rearm_drains_to_a_single_grace_idle`,
`codex_rollout_busy_rearm_drains_to_a_single_queue_empty_idle`), the
amplifier LaneRetry suite (`degraded_lane_reattaches_and_recovers`,
`exhausted_lane_retries_give_up_loudly`, `exit_clears_pending_lane_retry`),
and the zero-polling stats test `idle_terminals_arm_no_timers_and_read_no_files`
(idle terminals arm nothing; the new deadline only exists while Busy — same
as before the change).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_reconcile.rs
git commit -m "fix(ws): drain codex deadman force-reads in expire_due; missed inotify events self-heal (kata namg)"
```

---

### Task 5: Full gates, e2e on ephemeral ports, push (no PR)

**Files:**
- No planned source changes; only fixups the gates demand (commit each fixup atomically with a message explaining which gate required it).

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `fix/codex-lane-self-healing` branch with all gates green. NO PR.

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all clean/PASS. If `cargo fmt` complains, run `cargo fmt --all`,
re-run the check, and fold the formatting into a
`style: cargo fmt` commit (or amend the touching commit if it is the only
delta and not yet pushed).

- [ ] **Step 2: The load-flake test keeps its 30 s budget (spec test 4)**

```bash
grep -n "Duration::from_secs(30)" crates/freshell-ws/tests/codex_locator_activity.rs
cargo test -p freshell-ws --test codex_locator_activity
```

Expected: the grep finds the existing budget at `:100` UNCHANGED by this
branch (verify with `git diff origin/main -- crates/freshell-ws/tests/` →
empty), and the test PASSES. Do not widen the budget for any reason.

Honest scope note (ledger A4): this gate runs unloaded and passed 10/10 on
the pre-fix baseline, so a green run here does NOT by itself prove the fix
— Task 4's deterministic watch-drop test is the discriminator. Both
historical failures of this test were load-only. Contingency if it fails
here: rerun ONCE solo; a pass on the solo rerun under an otherwise loaded
host is the DELAYED-under-load class (out of this plan's scope — record it,
do not widen, do not chase reproduction on the shared host); a reproducible
solo failure is new and blocks the push — report it.

- [ ] **Step 3: Coordinated JS suites**

```bash
FRESHELL_TEST_SUMMARY="codex-lane-self-healing: post-fix full suite" \
  env -u FRESHELL_BIND_HOST npm test
npm run test:port
```

Expected: PASS. WAIT for the coordinator gate if held.

- [ ] **Step 4: Release build + relevant e2e (ephemeral ports)**

```bash
cargo build --release
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  terminal-activity-rust idle-gate-semantics-rust codex-status-completeness-rust amplifier-lane-resilience-rust
```

Expected: PASS. These specs each boot their OWN `RustServer` on an ephemeral
port (`findFreePort()` inside `RustServer.start()`) — they never touch
3001/3002. `amplifier-lane-resilience-rust` is included because Task 2
touched the amplifier watcher closure. Total runtime is minutes-scale; use a
generous command timeout and do not run other broad suites concurrently.

- [ ] **Step 5: Push the branch and STOP**

```bash
git log --oneline origin/main..HEAD
git push -u origin fix/codex-lane-self-healing
```

Expected: the plan commit plus 3–4 focused code commits. Do NOT run
`gh pr create` or any PR-creation equivalent — landing happens outside this
workflow with the final review verdict.

---

## Self-Review (performed while writing this plan)

**1. Spec coverage.**
- Fix piece 1 (Rescan on BOTH lanes, forwarded as the existing FsChange messages) → Task 2. The spec's "add EventKind::Other (or gate on flag()==Some(Flag::Rescan))" — the flag-gate option is taken, with a source-verified reason (kqueue flagless `Other`), documented in D3 and the code comment.
- Fix piece 2 (codex self-healing floor mirroring amplifier: `expire()` emits ForceRead on the busy-deadman path; `codex_frames`' dead arm forwards into a force-reads list; `expire_due` drains via `drain_codex_lane`) → Tasks 3 + 4. The requested stay-Busy-vs-Unknown evaluation → D1 (stay Busy on the timer path, amplifier mirror, PLUS the submit-time staleness escape after the original clause (c) was falsified by a full state-machine trace — ledger A2; the escape preserves the retired demotion's one behavioral consumer at the same threshold, red-first pinned in Task 3 Step 1). Bounded worst case ≤ `BUSY_DEADMAN_MS` → pinned by the Task 4 hub test (scaled window) and the Task 3 repeat pin. Fresh-eyes review (iteration 1) found the amplifier idiom alone leaves a FIRED anchor pinned in the past when Busy output resumes (hub `wait = 0` hot-loop) → Task 3 Step 3g disarms the anchor on `note_output` liveness, red-first pinned by `resumed_output_disarms_the_fired_deadman_anchor`; the template's own latent copy is a named residual in D2.
- Optional piece 3 → D2: deferred with the spec's two required notes (plan D2 here; kata comment in code at Task 4 Step 3d and the module-doc deviation at Task 3 Step 3i) — the deferral text was verified against the recovered spec verbatim (ledger A7), and D2 now also NAMES the uncovered residual risks (silent attach failure, busy-edge loss) plus the landing-time kata comment. Not silently skipped.
- Test (1) synthetic Rescan, both lanes, red today → Task 2 Steps 1–3 + the both-closures grep check (Step 6); fidelity argument in D3.
- Test (2) tracker deadman ForceRead mirroring amplifier's test, red today → Task 3 Steps 1–2.
- Test (3) hub-level watch-dropped-before-task_complete, deterministic, red today → Task 4 Steps 1–2 (unwatch seam is in-crate module privacy, the only seam that exists — verified; no synthetic load).
- Test (4) 30 s budget untouched → Global Constraints + Task 5 Step 2.
- Test (5) amplifier + idle-gate regression + the deadman×idle-gate interaction pin ("exactly one chime with correct reason") → Task 4 Step 1 (the interaction assertions are IN the new hub test — no artifact named "wave-2 idle-gate pins" exists in the repo (verified by search); the real pins are the idle.rs/activity.rs/e2e suites, all run in Tasks 4–5) + Task 4 Step 5 + Task 5 Step 4.
- Repo rules (worktree, base-green-first, npm ci/tsx, gates, ports, no-PR, no server restarts, no broad kills, shared host) → Global Constraints + Task 1 + Task 5.

**1b. No silent deferrals of required behavior.** The user-facing outcome —
"a codex done chime that never fires" becomes "fires within the deadman
window even when the fs event was missed" — is proven by a real-hub,
real-filesystem, real-watcher test (Task 4) with no mocks or fake providers;
the only test double is the deterministic `unwatch` that SIMULATES the
kernel-level event loss itself (which cannot be produced on demand without
forbidden synthetic load — adjudicated in D3, with the Rescan filter
unit-tested against the exact value notify emits, source-verified). The
optional piece 3 deferral is spec-authorized with its two conditions met
(D2). No other requirement is deferred; there are no unresolved coverage
gaps.

**2. Placeholder scan.** Every code step carries the actual code. Two spots
intentionally instruct verification-then-adapt rather than asserting unseen
internals, each bounded with the exact fallback and the invariant to pin:
Task 3 Step 5 (`note_output` liveness fallback) and Task 4 Step 1's
frame-helper signature note. Both name the concrete alternative — no "handle
appropriately", no TBDs. Task 3 Step 3c uses a grep to enumerate
promotion-to-Busy sites because the reset must land on every such site,
present and future-refactored; the exact two-line reset code is given.

**3. Type consistency.** `set_busy_deadman_ms(&mut self, ms: i64)` defined
in Task 3, consumed with the same name/signature in Task 4's test.
`codex_frames(...) -> (Vec<ServerMessage>, Vec<String>)` defined in Task 4
Step 3a, matching `amplifier_frames`' existing shape and consumed in Step 3c
as `let (mut f, codex_force_reads)`. `TrackerEffect::ForceRead { terminal_id:
String, at: i64 }` used with those exact fields in both tasks (matches
`lib.rs:51`). `fs_event_is_relevant(&notify::Event) -> bool` defined and
tested in Task 2 only. `force_reads(effects: &[CodexEffect]) -> usize`
helper matches its amplifier twin. Fixture names (`hub()`, `observer_send`,
`codex_rollout_fixture`, `codex_event_line`, `next_frame_matching`,
`next_frame_of_type`) match the existing `mod tests` verbatim.
