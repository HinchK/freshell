# Wall Pins Closure Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close the three remaining `test.fail` pins in the restart contract wall (`test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`) so the wall finishes green with ZERO expected-fail pins, stably (3 consecutive full runs).

**Architecture:** Three product fixes to the restart-resilience machinery. Pin 1 (claude never-conversed → Respawn, not DeadSession) and Pin 3 (pending-marker read → loud `fresh_by_race` verdict + DOM-visible breadcrumb) both modify `derive_verdicts` in `crates/freshell-ws/src/reconcile.rs` — adjacent match arms, sequenced in that order. Pin 2 (claude identity durable BEFORE the PTY spawn makes it observable in argv, plus a wrong e2e probe selector) is a disjoint subsystem and lands last. All three pins were root-caused by a systematic-debugging investigation; each task re-verifies its load-bearing diagnostic claim before building on it.

**Tech Stack:** Rust (axum/tokio server in `crates/`), TypeScript/React client (`src/`), Playwright e2e (`test/e2e-browser/`), Vitest unit tests (`test/unit/`).

## Global Constraints

- **Worktree:** all work happens in `/home/dan/code/freshell/.worktrees/wall-pins-closure` on branch `fix/wall-pins-closure`, based on `origin/main` at `c1c67464` (already fetched and current — verify with `git log --oneline -1 origin/main` before Task 1; if origin/main moved, rebase first: `git fetch origin && git rebase origin/main`).
- **Ports:** NEVER use ports 3001 or 3002 (the user's LIVE server runs on 3002). The e2e harness picks kernel-ephemeral ports automatically (`findFreePort()` binds port 0) — never override with a fixed port, never set `PORT`.
- **NEVER restart the user's live server.** NEVER use broad kill patterns (`pkill`, `killall`, `kill` by name). Tests kill only PIDs they own.
- **Shared host:** no synthetic load, no parallel wall runs.
- **Node test coordinator gate:** before any `npm test`, run `npm run test:status`; if the gate is held, WAIT and retry (poll every 60s) — do not force. Full runs use: `FRESHELL_TEST_SUMMARY='wall pins closure' env -u FRESHELL_BIND_HOST npm test`.
- **TDD:** Red-Green-Refactor for every step. Frequent, focused, atomic commits.
- **Wall flip protocol** (spec header, `restore-contract-wall-rust.spec.ts:12-16`): Playwright turns an unexpected PASS of a `test.fail()` test into a hard failure — that is the signal to DELETE the `test.fail()` lines and let the assertion run green. Never widen a pin; never convert a pin to `test.fixme`. **If a pin cannot honestly flip, STOP and report the failing evidence — never re-pin.**
- **Contract:** the verdict `reason` field is a free-form `Option<String>` / `z.string().optional()` — NOT enum-pinned. Adding `"fresh_by_race"` requires zero schema regeneration, but the gates still verify: `npm run contract:generate` must produce no diff, `npm run test:port` green, `cargo test -p freshell-protocol --locked` green.
- **Docs:** README.md is the only end-user markdown doc; this plan (under `docs/plans/`) is a working/agent doc. Create no other markdown files.
- **PR policy: do NOT create a PR.** Push the branch (`git push -u origin fix/wall-pins-closure`) and stop. Landing happens outside this workflow.
- **Rust gates (every task that touches Rust):** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`.
- **E2e invocation:** `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium <spec> [-g "<title>"]` — `--project=rust-chromium` is mandatory (the wall is in `RUST_ONLY_SPECS`). The harness lazily builds `target/release/freshell-server`; pre-build with `cargo build --release -p freshell-server` to keep test timing honest.

## Scope note

The three pins are one deliverable — "the wall finishes green with zero pins" — with a load-bearing fix order (Pin 1 → Pin 3 share `derive_verdicts`; Pin 2 is disjoint). They ship as one plan on one branch; each task is independently red-green testable.

## Background: the three pins (current state, verified against `c1c67464`)

| Pin | Wall leg (title / `test.fail` line) | Root cause (verified by exploration) |
|---|---|---|
| 1 | `THE RULER: all pane types live, one SIGKILL, every §2 contract holds` (`:1459`, pin at `:1500-1503`) — red leg: the claude `--resume <preallocatedId>` argv poll at `:1752-1760` | `derive_verdicts` Absent arm (`reconcile.rs:316-360`) has an amplifier carve-out (`:327`) but none for claude. A claude pane created (id preallocated, ledger binding durable → `ever_observed` true via `ledger.ever_bound`) but never conversed with has no transcript file → `Absent` → `DeadSession{session_not_on_disk}` (`:349-353`). PR #565's locator fallback (`crates/freshell-server/src/existence.rs:156-170`) only rescues *exists-but-unparseable* files; a never-created file is genuinely `Absent`. |
| 3 | `SIGKILL-inside-locator-window: never silently fresh` (`:1933`, pin at `:1949-1952`) | Write side complete: `record_pending` at `terminal.rs:2449-2462` for `MARKER_MODES=["codex","opencode","amplifier"]` (`:105`), keyed by `terminal_id`, surviving SIGKILL (exit-hook delete at `:1338` doesn't run on SIGKILL). Read side MISSING: zero production readers of pending markers; the no-identity path emits `Fresh{no_recoverable_identity}` (`reconcile.rs:292-295`) and the client renders `"Started fresh (no_recoverable_identity)."` into the **xterm canvas** (`TerminalView.tsx:4326` via `writeLocalXtermNotice`) — invisible to the leg's DOM probe `getByText(/couldn't be resumed|could not be resumed|fresh session/i)`. **Correction to the task brief:** roadmap P1.10 (re-arm the opencode locator on restore-created panes) IS ALREADY LANDED — `maybe_arm` is called unconditionally at `terminal.rs:2319`, `OpencodeLocator::arm` gates only on missing identity, pinned by `#[tokio::test] restore_created_pane_without_identity_arms_and_resolves_into_the_ledger` (`crates/freshell-ws/src/opencode_association.rs:536`). Task 5 verifies this instead of rebuilding it. |
| 2 | `SIGKILL-within-5s-of-pane-creation: identity survives without client state` (`:1816`, pin at `:1825-1828`) | Boot-time recovery IS wired (candidate cause (a) is FALSE): `RecoveryOfferPanel` mounts unconditionally (`App.tsx:1926`), fetches `GET /api/recovery/inventory` on mount when `!hadPersistedLayoutAtBoot || pendingOffer` (`RecoveryOfferPanel.tsx:83`) — proven green by `recover-my-panes-rust.spec.ts` scenarios 1–3. Two real gaps: **Gap A (race, candidate cause (b))** — claude is excluded from `MARKER_MODES` and its binding row is written 7 `.await` points (~230 lines) AFTER the PTY spawn (`spawn .await :2211` vs `record_binding .await :2445`) while the fake CLI's argv line appears synchronously at spawn — the leg kills right after argv, potentially before durability. **Gap B (test)** — the leg's probe `getByText(/recover .*pane/i)` (`:1920`) can never match the panel's actual heading `Restore N panes from server memory?` (`RecoveryOfferPanel.tsx:217`); the stable handle is `data-testid="recovery-offer-panel"`. Task 6 instruments to confirm Gap A empirically, then fixes both. |

Full investigation reports (background only; the plan is self-contained): `/home/dan/code/freshell/.worktrees/.the-usual-logs/wall-pins-closure/reports/{pin1-claude-verdict,pin3-pending-markers,pin2-recovery-offer,wall-and-gates,snippets-for-plan}.md`.

---

### Task 1: Probe API split — `ever_observed_on_disk`

Pin 1 needs to distinguish two facts that today's `ever_observed` conflates: "the transcript was actually SEEN on disk" (in-process observed set, fed by index snapshots and the PR #565 locator fallback) vs "the identity was ever ledger-bound" (durable, survives restarts, but proves only that the id was minted — a never-conversed claude session is ledger-bound yet has never had a transcript). This task adds `ever_observed_on_disk` to the probe trait without changing any existing behavior.

**Files:**
- Modify: `crates/freshell-ws/src/existence.rs` (the `SessionExistenceProbe` trait — currently exactly two methods, `exists` and `ever_observed`, no defaults)
- Modify: `crates/freshell-server/src/existence.rs` (the `IndexExistenceProbe` impl at lines 110–189; tests in `mod tests` from line 191)
- Test: `crates/freshell-server/src/existence.rs` (`mod tests`)

**Interfaces:**
- Consumes: existing `SessionExistenceProbe` trait; `IndexExistenceProbe { observed: Mutex<HashSet<String>>, ledger: Option<Arc<PaneLedger>>, ... }`; `PaneLedger::ever_bound(&self, provider: &str, session_id: &str) -> bool`.
- Produces: `fn ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool` on the `SessionExistenceProbe` trait, with a default implementation delegating to `ever_observed` (so test fakes whose observed set already means "seen on disk" — like `FakeProbe` in `reconcile.rs` tests — need no override), and an override on `IndexExistenceProbe` that consults ONLY the in-process observed set (never the ledger). Task 2 consumes this.

- [ ] **Step 1: Write the failing test**

In `crates/freshell-server/src/existence.rs` `mod tests`, next to `ever_observed_survives_a_restart_via_the_ledger` (line ~376 — reuse its exact probe+ledger construction; it builds a probe with a ledger installed and a session that was bound but is not in any index snapshot):

```rust
    /// PIN 1 (claude never-conversed carve-out): "seen on disk" is a strictly
    /// stronger fact than "ever bound". A ledger binding proves the identity
    /// was minted at create — NOT that a transcript ever existed. The
    /// carve-out keys on disk observation, so ever_bound alone must not
    /// count.
    #[test]
    fn ever_observed_on_disk_excludes_ledger_only_bindings() {
        // Construct probe + ledger EXACTLY as
        // ever_observed_survives_a_restart_via_the_ledger does (same fixture
        // helpers, same bound-but-never-on-disk session id), then:
        // assert!(probe.ever_observed("claude", session_id));           // via ledger — unchanged
        // assert!(!probe.ever_observed_on_disk("claude", session_id));  // NEW: ledger does not count
    }
```

Copy the sibling test's body verbatim up to its assertion, then replace/extend the assertions as shown in the comments (the two `assert!` lines are the required assertions; the construction lines come from the sibling). Also add a second test asserting the positive path via the observed set:

```rust
    /// A genuine on-disk observation (index snapshot or locator-fallback hit)
    /// counts for BOTH ever_observed and ever_observed_on_disk.
    #[test]
    fn ever_observed_on_disk_true_after_disk_observation() {
        // Construct probe as zero_turn_claude_transcript_on_disk_is_present_not_absent
        // does (temp claude home + locator + warm index + zero-turn file), call
        // probe.exists("claude", session_id) once (fallback hit feeds the
        // observed set), then:
        // assert!(probe.ever_observed_on_disk("claude", session_id));
    }
```

(That sibling is `#[tokio::test]` at line ~296 — mirror its async-ness and cleanup.)

- [ ] **Step 2: Run tests to verify they fail to compile (RED)**

Run: `cd /home/dan/code/freshell/.worktrees/wall-pins-closure && cargo test -p freshell-server --lib existence`
Expected: compile error — `no method named ever_observed_on_disk`.

- [ ] **Step 3: Add the trait method with a default**

In `crates/freshell-ws/src/existence.rs`, inside `trait SessionExistenceProbe`, after `ever_observed`:

```rust
    /// "Seen on disk" strictly: true only if this process actually observed
    /// the session artifact on disk (index snapshots, or the claude
    /// locator-fallback hit). Unlike `ever_observed`, durable ledger bindings
    /// do NOT count — a binding proves the identity was minted, not that a
    /// transcript ever existed (PIN 1: the claude never-conversed carve-out
    /// keys on this distinction). Default: delegate to `ever_observed`, which
    /// is already disk-only for fakes without a ledger.
    fn ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool {
        self.ever_observed(provider, session_id)
    }
```

- [ ] **Step 4: Override on `IndexExistenceProbe`**

In `crates/freshell-server/src/existence.rs`, inside `impl SessionExistenceProbe for IndexExistenceProbe` (after the existing `ever_observed` at lines 176–188):

```rust
    fn ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool {
        self.observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
    }
```

- [ ] **Step 5: Run tests to verify they pass (GREEN)**

Run: `cargo test -p freshell-server --lib existence`
Expected: PASS, including all pre-existing existence tests (`ever_observed_survives_a_restart_via_the_ledger`, the four kata-09v1 fallback tests) — `ever_observed` itself is untouched.

- [ ] **Step 6: Rust gates**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: clean. (If `fmt` complains, run `cargo fmt --all` and re-check.)

- [ ] **Step 7: Environment sanity + commit**

Run: `[ -d node_modules ] || npm ci` (the later tasks need the JS toolchain; `ls node_modules/.bin/tsx` must resolve — if missing, `npm ci`).

```bash
git add crates/freshell-ws/src/existence.rs crates/freshell-server/src/existence.rs
git commit -m "feat(existence): split ever_observed_on_disk from ever_observed (disk-only, ledger excluded)"
```

---

### Task 2: Pin 1 — claude never-conversed carve-out in `derive_verdicts` + flip the ruler pin

**Files:**
- Modify: `crates/freshell-ws/src/reconcile.rs` (the `SessionExistence::Absent` arm, lines ~316–360; `mod tests` from line 375)
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts:1500-1503` (delete the ruler `test.fail`)
- Test: `crates/freshell-ws/src/reconcile.rs` `mod tests`

**Interfaces:**
- Consumes: `SessionExistenceProbe::ever_observed_on_disk(provider, session_id) -> bool` (Task 1); `ReconcileDeps.pane_ledger: &PaneLedger` with `ever_bound(&self, provider: &str, session_id: &str) -> bool`; existing helpers `base(pane, verdict)`, `corrected_flag(claim, resolved)`, `deps.registry.respawn_exhausted(&key)`.
- Produces: claude Absent-arm behavior — `Respawn` (carrying `session_ref`) for ledger-bound, never-disk-observed claude identities; unchanged `DeadSession{session_not_on_disk}` for disk-observed-then-deleted; unchanged everything else. The composed-ruler wall leg depends on this.

**Design decision (record in the code comment, verbatim rationale):** the carve-out mirrors the amplifier arm but is narrower — it requires (a) `sref.provider == "claude"`, (b) a durable ledger binding (`ever_bound`), and (c) the transcript never having been SEEN on disk (`!ever_observed_on_disk`). Condition (c) preserves the hazard guard within a boot (a deleted transcript that WAS observed stays an immediate `DeadSession{session_not_on_disk}` — existing test `row4_absent_but_ever_observed_yields_dead_session` keeps passing unchanged). Across a restart, a conversed-then-deleted transcript is indistinguishable from never-conversed by these signals; that case takes the same escape the amplifier arm already accepts — §7.5's `respawn_exhausted` convergence ends a respawn↔instant-exit loop in an actionable `DeadSession{respawn_exhausted}`, never thrash and never silent. Coherence with PR #565: the locator fallback fires only when a transcript FILE EXISTS (converting false-Absent to Present ⇒ Respawn); this arm fires only in the true-Absent branch (file never created). Zero overlap, two halves of one rule: "a claude identity the disk has no memory of is respawnable; one the disk remembers and lost is dead."

- [ ] **Step 1: Write the failing tests**

In `crates/freshell-ws/src/reconcile.rs` `mod tests`, after `amplifier_absent_even_observed_yields_respawn_not_dead_session` (~line 656). The fixture (`Fixture::new()` → `registry`/`identity`/`probe: FakeProbe`/`ledger: PaneLedger::new(Some(root))`), `pane(key)` (default mode `"claude"`), and `sref(provider, id)` builders already exist in this mod:

```rust
    /// PIN 1 red test: a claude pane whose session id was preallocated at
    /// create (ledger-bound, durable) but which NEVER conversed has no
    /// transcript file -> Absent. That is not a dead state: claude's
    /// --resume/--session-id recreates the file on first output (mirror of
    /// the amplifier arm). Kata 09v1's locator fallback covers
    /// exists-but-unparseable; this covers never-created.
    #[test]
    fn claude_never_conversed_yields_respawn_not_dead_session() {
        let f = Fixture::new();
        f.ledger
            .record_binding(&crate::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "s-never",
                terminal_id: "T-never",
                mode: "claude",
                cwd: None,
                create_request_id: Some("cr-never"),
                now_ms: 1_000,
            })
            .expect("record binding");
        let mut p = pane("cr-never");
        p.session_ref = Some(sref("claude", "s-never"));
        // Probe default: Absent, never observed on disk.
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref, Some(sref("claude", "s-never")));
    }

    /// PIN 1 hazard guard: a claude transcript that WAS seen on disk and is
    /// now gone is a real data-loss shape — stays loud dead_session even
    /// though the identity is ledger-bound (rows 4/4b unchanged).
    #[test]
    fn claude_deleted_after_conversation_stays_dead_session() {
        let f = Fixture::new();
        f.ledger
            .record_binding(&crate::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "s-gone2",
                terminal_id: "T-gone2",
                mode: "claude",
                cwd: None,
                create_request_id: Some("cr-gone2"),
                now_ms: 1_000,
            })
            .expect("record binding");
        f.probe.mark_observed("claude", "s-gone2");
        let mut p = pane("cr-gone2");
        p.session_ref = Some(sref("claude", "s-gone2"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("session_not_on_disk"));
    }
```

- [ ] **Step 2: Run to verify RED**

Run: `cargo test -p freshell-ws --lib reconcile`
Expected: `claude_never_conversed_yields_respawn_not_dead_session` FAILS (today it derives `DeadSession` — `ever_observed` answers true via `ledger.ever_bound`... note: with `FakeProbe` and a real fixture ledger, the DeadSession gate reads `deps.existence.ever_observed` which for `FakeProbe` is its observed set only, so the observed verdict may be `Fresh{identity_never_observed}` instead — either way it is NOT `Respawn`, which is the assertion). `claude_deleted_after_conversation_stays_dead_session` PASSES already (it pins the guard so the fix can't break it). All pre-existing tests PASS.

- [ ] **Step 3: Implement the carve-out**

In `crates/freshell-ws/src/reconcile.rs`, in the `SessionExistence::Absent` arm, immediately AFTER the amplifier carve-out block (which ends at line ~341 with `return ... Respawn`) and BEFORE the `ever_observed` dead-session gate (comment at ~:342):

```rust
            // Claude carve-out (never-conversed preallocation, PIN 1): claude
            // terminals get a server-preallocated --session-id at create and
            // the binding row is durable before the answer — but the
            // transcript file only appears on first output. Ledger-bound +
            // Absent + never SEEN on disk therefore means "created, never
            // conversed", not dead: claude's --resume/--session-id recreates
            // the file on first output. Kata 09v1's locator fallback
            // (freshell-server existence.rs) already converts
            // exists-but-unparseable into Present => Respawn; this arm covers
            // never-created — two halves of one rule, no overlap. A
            // transcript that WAS observed on disk and is now gone falls
            // through to the loud dead_session below (rows 4/4b hazard
            // guard). Cross-restart deleted-with-prior-conversation is
            // indistinguishable from never-conversed by these signals and
            // takes the same escape the amplifier arm accepts: §7.5's
            // respawn_exhausted convergence ends a respawn <-> instant-exit
            // loop in an actionable dead_session, never thrash.
            if sref.provider == "claude"
                && deps.pane_ledger.ever_bound(&sref.provider, &sref.session_id)
                && !deps
                    .existence
                    .ever_observed_on_disk(&sref.provider, &sref.session_id)
            {
                if deps.registry.respawn_exhausted(&key) {
                    return PaneVerdict {
                        session_ref: Some(sref),
                        reason: Some("respawn_exhausted".to_string()),
                        ..base(pane, ReconcileVerdict::DeadSession)
                    };
                }
                let corrected = corrected_flag(pane.session_ref.as_ref(), Some(&sref));
                return PaneVerdict {
                    session_ref: Some(sref),
                    corrected,
                    ..base(pane, ReconcileVerdict::Respawn)
                };
            }
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cargo test -p freshell-ws --lib reconcile && cargo test -p freshell-server --lib existence`
Expected: ALL PASS — the two new tests plus every pre-existing decision-table test (`row4_absent_but_ever_observed_yields_dead_session` still passes: it has no ledger binding AND marks disk observation; `row4b_never_observed_identity_yields_fresh_not_dead_session` still passes: no ledger binding → carve-out doesn't fire; `amplifier_absent_even_observed_yields_respawn_not_dead_session` untouched — its arm precedes ours; `respawn_exhausted_key_yields_dead_session_not_another_respawn` at `:816` untouched).

- [ ] **Step 5: Rust gates + commit the fix**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: clean / all pass.

```bash
git add crates/freshell-ws/src/reconcile.rs
git commit -m "fix(reconcile): claude never-conversed sessions respawn instead of dead_session (PIN 1)"
```

- [ ] **Step 6: Prove the ruler leg flips (RED signal = unexpected pass)**

Build and run the still-pinned ruler leg:

```bash
cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "THE RULER"
```

Expected: the run FAILS with Playwright's "passed unexpectedly" error for the `test.fail`-annotated ruler — that is the flip signal. (The ruler has `test.setTimeout(600_000)`; expect up to 10 minutes.)

**If instead the ruler still fails expectedly** (a leg OTHER than the claude `--resume` argv poll is red), do NOT delete the pin here — record the failing leg's error verbatim in the commit-message body of a `wip` note commit, continue to Task 3, and re-attempt this flip in Task 8 Step 2. If it still cannot flip there, HALT the workflow and report the evidence (never re-pin).

- [ ] **Step 7: Flip the pin**

In `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`, delete exactly the four lines at 1500–1503:

```typescript
    test.fail(
      e2eServerKind === 'rust',
      'P0.1: composed all-pane ruler; red until remaining P1.x land -- current observed red: the claude terminal §2.2 --resume argv leg under composition (the former P0.2 freshclaude identity gap closed in #562)',
    )
```

(Keep the explanatory comment above it only if it still reads true; otherwise trim it to a short note that the ruler is now a live assertion.)

- [ ] **Step 8: Run the flipped ruler leg green, twice**

Run (twice, sequentially):
`npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "THE RULER"`
Expected: PASS both times. (The third stability run happens with the full wall in Task 8.)

- [ ] **Step 9: Commit**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(wall): flip the composed-ruler pin — claude never-conversed leg now green (PIN 1)"
```

---

### Task 3: Pin 3 server — pending-marker read → `fresh_by_race`, one-shot consumption

**Files:**
- Modify: `crates/freshell-ws/src/reconcile.rs` (the no-identity Fresh path at lines ~286–296; new pub helper; `mod tests`)
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_pane_reconcile`, ~line 3282; verdicts computed at `:3330-3333`, response sent at `:3382-3388`)
- Test: `crates/freshell-ws/src/reconcile.rs` `mod tests`

**Interfaces:**
- Consumes: `PaneLedger::pending_for_terminal(&self, terminal_id: &str) -> Option<PendingMarker>` (reader-rule: `None` if a binding row covers the terminal — `pane_ledger.rs:787`); `PaneLedger::record_pending(&self, terminal_id: &str, mode: &str, cwd: Option<&str>, now_ms: i64) -> io::Result<()>`; `PaneLedger::delete_pending(&self, terminal_id: &str) -> io::Result<()>`; `ReconcilePane.terminal_id: Option<String>` (the client's stale pre-kill terminal id — the marker's key).
- Produces: new verdict reason string `"fresh_by_race"` on `Fresh` verdicts (free-form field — no contract regeneration); `pub fn fresh_by_race_marker_tids(panes: &[ReconcilePane], verdicts: &[PaneVerdict]) -> Vec<String>` in `reconcile.rs` (verdicts are 1:1 with request order — documented on `PaneVerdict.pane_key`); marker consumption in `handle_pane_reconcile`. Task 4's client breadcrumb keys on the literal reason string `fresh_by_race`.

**Load-bearing verification folded in (Step 1):** the design claims the client re-presents the dead epoch's `terminalId` on post-restart reconcile (that is the marker join key — markers are keyed by `terminal_id`, and `createRequestId` is not stored on markers). The pinned leg itself proves the client retains it (its settle-poll at `:1988-1995` waits for `content.terminalId` to CHANGE from the pre-kill value, so the pre-kill value was present). Confirm the reconcile REQUEST carries it: `grep -n "terminalId" src/lib/pane-reconcile.ts | head -30` — the request builder must include the pane's current `terminalId`. If (and only if) it demonstrably does not, STOP this task and report: the fallback design (extending `PendingMarker` with an optional `create_request_id` field and joining on that) is a schema change that needs plan-review, not an inline improvisation.

- [ ] **Step 1: Verify the join key** (command above; record the matching line in the commit body).

- [ ] **Step 2: Write the failing tests**

In `crates/freshell-ws/src/reconcile.rs` `mod tests`:

```rust
    /// PIN 3 red test (§4.2 pending-marker read): identity establishment was
    /// in flight when the server died (durable pending marker, keyed by the
    /// dead epoch's terminal id) -> the verdict is fresh, but LOUD:
    /// fresh_by_race, never a silent no_recoverable_identity.
    #[test]
    fn pending_marker_yields_fresh_by_race_not_silent_fresh() {
        let f = Fixture::new();
        f.ledger
            .record_pending("T-race", "opencode", None, 1_000)
            .expect("record pending");
        let mut p = pane("cr-race");
        p.mode = Some("opencode".to_string());
        p.terminal_id = Some("T-race".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("fresh_by_race"));
    }

    /// One-shot semantics (§6 decision 5): once the marker is consumed, a
    /// later reconcile derives the plain labeled fresh — the breadcrumb
    /// fires exactly once.
    #[test]
    fn consumed_marker_reverts_to_no_recoverable_identity() {
        let f = Fixture::new();
        f.ledger
            .record_pending("T-race2", "opencode", None, 1_000)
            .expect("record pending");
        let mut p = pane("cr-race2");
        p.mode = Some("opencode".to_string());
        p.terminal_id = Some("T-race2".to_string());
        let first = f.one(p.clone());
        assert_eq!(first.reason.as_deref(), Some("fresh_by_race"));
        // Consume, as handle_pane_reconcile does for fresh_by_race verdicts.
        let tids = fresh_by_race_marker_tids(&[p.clone()], &[first]);
        assert_eq!(tids, vec!["T-race2".to_string()]);
        for tid in &tids {
            f.ledger.delete_pending(tid).expect("delete pending");
        }
        let second = f.one(p);
        assert_eq!(second.verdict, ReconcileVerdict::Fresh);
        assert_eq!(second.reason.as_deref(), Some("no_recoverable_identity"));
    }

    /// Shell panes stay bare fresh even with a stray marker — the marker
    /// read sits behind the shell early-return.
    #[test]
    fn shell_pane_ignores_pending_markers() {
        let f = Fixture::new();
        f.ledger
            .record_pending("T-sh", "shell", None, 1_000)
            .expect("record pending");
        let mut p = pane("cr-sh");
        p.mode = Some("shell".to_string());
        p.terminal_id = Some("T-sh".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason, None);
    }
```

(If `ReconcilePane` does not derive `Clone`, build `p` twice from the same literal instead of `p.clone()`.)

- [ ] **Step 3: Run to verify RED**

Run: `cargo test -p freshell-ws --lib reconcile`
Expected: `pending_marker_yields_fresh_by_race_not_silent_fresh` FAILS with reason `no_recoverable_identity`; `consumed_marker_reverts_...` fails to compile (`fresh_by_race_marker_tids` undefined); `shell_pane_ignores_pending_markers` PASSES (pins existing behavior).

- [ ] **Step 4: Implement the read + the helper**

In `crates/freshell-ws/src/reconcile.rs`, replace the no-identity else-branch (lines ~286–296) body:

```rust
    // No live terminal for this key — recover a retired identity if one exists.
    let Some(sref) = resolve_authoritative_ref(deps, pane, &key) else {
        // Row 8: shells are stateless by design; row 9: CLI with nothing to
        // resume becomes an explicit, labeled fresh — never a surprise.
        if pane.mode.as_deref() == Some("shell") {
            return base(pane, ReconcileVerdict::Fresh);
        }
        // §4.2 pending-marker read (PIN 3): a durable pending marker keyed by
        // the client's stale terminal id means identity establishment was in
        // flight when the server died — fresh by RACE, not by intent. The
        // reason is distinct and surfaced (client breadcrumb); the caller
        // consumes the marker so the breadcrumb fires exactly once
        // (§6 decision 5: markers are never promoted — resolution or
        // consumption deletes them).
        if let Some(tid) = pane.terminal_id.as_deref() {
            if deps.pane_ledger.pending_for_terminal(tid).is_some() {
                return PaneVerdict {
                    reason: Some("fresh_by_race".to_string()),
                    ..base(pane, ReconcileVerdict::Fresh)
                };
            }
        }
        return PaneVerdict {
            reason: Some("no_recoverable_identity".to_string()),
            ..base(pane, ReconcileVerdict::Fresh)
        };
    };
```

And add the pub helper (near `derive_verdicts`, outside `mod tests`):

```rust
/// PIN 3 / §6 decision 5 one-shot: the terminal ids whose verdicts were
/// labeled fresh_by_race — the caller deletes their pending markers so the
/// breadcrumb fires exactly once. Verdicts are 1:1 with request order
/// (see `PaneVerdict::pane_key`).
pub fn fresh_by_race_marker_tids(panes: &[ReconcilePane], verdicts: &[PaneVerdict]) -> Vec<String> {
    panes
        .iter()
        .zip(verdicts)
        .filter(|(_, v)| v.reason.as_deref() == Some("fresh_by_race"))
        .filter_map(|(p, _)| p.terminal_id.clone())
        .collect()
}
```

- [ ] **Step 5: Wire consumption into `handle_pane_reconcile`**

In `crates/freshell-ws/src/terminal.rs`, inside `async fn handle_pane_reconcile` (~:3282), after `let mut verdicts` is fully computed (`:3333`, after the `catch_unwind` derive closure resolves) and BEFORE the `PaneReconcileResult` send (`:3382`):

```rust
    // PIN 3 one-shot: fresh_by_race verdicts consume their pending markers —
    // the next reconcile for the same dead terminal derives a plain
    // no_recoverable_identity. Blocking-pool, same budget reasoning as every
    // other ledger write site (V1.md).
    let race_tids = crate::reconcile::fresh_by_race_marker_tids(&request.panes, &verdicts);
    if !race_tids.is_empty() {
        let ledger = std::sync::Arc::clone(&state.pane_ledger);
        tokio::task::spawn_blocking(move || {
            for tid in race_tids {
                if let Err(err) = ledger.delete_pending(&tid) {
                    tracing::warn!(terminal_id = %tid, error = %err, "pane_ledger_marker_delete_failed_on_fresh_by_race");
                }
            }
        })
        .await
        .ok();
    }
```

(Match the module-path style already used at `:3330` for `derive_verdicts` — if it's imported unqualified, call `fresh_by_race_marker_tids` unqualified too. If `verdicts` at that point is inside a different scope/shape than a plain `Vec<PaneVerdict>`, place this block wherever both `request.panes` and the final verdicts vec are in scope, still before the send.)

- [ ] **Step 6: Run to verify GREEN**

Run: `cargo test -p freshell-ws --lib reconcile && cargo test -p freshell-ws`
Expected: all three new tests PASS; every pre-existing test PASSES (the new arm only fires when a marker exists for the presented terminal id, and fixture ledgers start empty).

- [ ] **Step 7: Contract sanity (reason is not pinned)**

Run: `npm run contract:generate && git diff --exit-code -- port/contract && npm run test:port && cargo test -p freshell-protocol --locked`
Expected: no diff, all green.

- [ ] **Step 8: Rust gates + commit**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`

```bash
git add crates/freshell-ws/src/reconcile.rs crates/freshell-ws/src/terminal.rs
git commit -m "feat(reconcile): pending-marker read derives loud fresh_by_race with one-shot consumption (PIN 3 server)"
```

---

### Task 4: Pin 3 client — `fresh_by_race` breadcrumb, DOM-visible

**Files:**
- Modify: `src/store/panesSlice.ts` (notice constants/function at lines ~601–605)
- Modify: `src/components/TerminalView.tsx` (notice write site `:4326` inside the effect at `:2991`; root JSX `:5228`)
- Create: `test/unit/client/store/panesSlice.fresh-by-race.test.ts`

**Interfaces:**
- Consumes: server reason string `"fresh_by_race"` (Task 3), delivered unchanged through the existing fold (`pane-reconcile.ts:451-460` forwards `verdict.reason` → reducer → `reconcileFreshNotice(reason)` — no fold change needed; this satisfies the brief's "extend the client fold" intent at the layer where text is produced).
- Produces: `export const RECONCILE_NOTICE_FRESH_BY_RACE` (exact text below — it must match the wall leg's regex `/couldn't be resumed|could not be resumed|fresh session/i`); a DOM element `data-testid="fresh-by-race-notice"` with `role="status"` rendered by `TerminalView` for ~10s when the notice is the fresh-by-race one. Task 5's e2e breadcrumb assertion depends on both.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/client/store/panesSlice.fresh-by-race.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { reconcileFreshNotice, RECONCILE_NOTICE_FRESH_BY_RACE } from '@/store/panesSlice'

describe('reconcileFreshNotice', () => {
  it('fresh_by_race renders the loud resumable-loss breadcrumb', () => {
    expect(reconcileFreshNotice('fresh_by_race')).toBe(RECONCILE_NOTICE_FRESH_BY_RACE)
    // The restart-contract-wall probes /couldn't be resumed|could not be
    // resumed|fresh session/i — the breadcrumb must match it.
    expect(RECONCILE_NOTICE_FRESH_BY_RACE).toMatch(/couldn't be resumed/i)
    expect(RECONCILE_NOTICE_FRESH_BY_RACE).toMatch(/fresh session/i)
  })
  it('other reasons keep the generic machine-coded notice', () => {
    expect(reconcileFreshNotice('no_recoverable_identity')).toBe(
      'Started fresh (no_recoverable_identity).',
    )
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-by-race.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `RECONCILE_NOTICE_FRESH_BY_RACE` is not exported.

- [ ] **Step 3: Implement the notice text**

In `src/store/panesSlice.ts`, extend the block at lines ~601–605:

```typescript
export const RECONCILE_NOTICE_CORRECTED = 'Session identity corrected by server — this pane now points at its live session.'
export const RECONCILE_NOTICE_DUPLICATE = 'A duplicate terminal for this session was detected and ignored.'
// PIN 3 (§4.2 "fresh by race, not by intent"): the server restarted while
// this pane's session identity was still being established — loud, distinct,
// and phrased to match the restart-contract wall's breadcrumb probe.
export const RECONCILE_NOTICE_FRESH_BY_RACE =
  "This pane couldn't be resumed — the server restarted before its session identity was captured. Started a fresh session."
export function reconcileFreshNotice(reason: string): string {
  if (reason === 'fresh_by_race') return RECONCILE_NOTICE_FRESH_BY_RACE
  return `Started fresh (${reason}).`
}
```

- [ ] **Step 4: Run to verify GREEN**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: DOM-visible strip in TerminalView**

Today the notice is written into the xterm canvas (`writeLocalXtermNotice`) which Playwright's `getByText` cannot read. Add a DOM overlay for the fresh-by-race notice only (minimal blast radius — other notices keep their current xterm-only rendering).

In `src/components/TerminalView.tsx`:

(a) Add to the existing `@/store/panesSlice` import: `RECONCILE_NOTICE_FRESH_BY_RACE`.

(b) At the component's top level, near the other `useState` hooks:

```typescript
  // PIN 3: the fresh-by-race breadcrumb must be readable by the DOM text
  // layer (assistive tech + the restart-contract wall's getByText probe) —
  // the xterm canvas write below is invisible to both.
  const [freshByRaceNotice, setFreshByRaceNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!freshByRaceNotice) return
    const t = setTimeout(() => setFreshByRaceNotice(null), 10_000)
    return () => clearTimeout(t)
  }, [freshByRaceNotice])
```

(c) At the `terminal.created` notice site (~line 4326, inside the effect at `:2991`), extend the existing block:

```typescript
          const createdReconcileNotice = contentRef.current?.reconcileNotice
          if (createdReconcileNotice) {
            writeLocalXtermNotice(term, `\r\n${createdReconcileNotice}\r\n`)
            if (createdReconcileNotice === RECONCILE_NOTICE_FRESH_BY_RACE) {
              setFreshByRaceNotice(createdReconcileNotice)
            }
            dispatch(clearPaneReconcileNotice({ tabId, paneId: paneIdRef.current }))
          }
```

(Only the `if (createdReconcileNotice === ...)` lines are new; keep the rest byte-identical. The attach-path site at ~`:5040` is left unchanged — a fresh verdict always arrives via `terminal.created`.)

(d) In the root JSX at ~line 5228, inside the `wrapperRef` div (which has `relative` when visible), as a sibling of the `containerRef` xterm div:

```tsx
      {freshByRaceNotice ? (
        <div
          role="status"
          data-testid="fresh-by-race-notice"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-amber-100/90 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900/80 dark:text-amber-100"
        >
          {freshByRaceNotice}
        </div>
      ) : null}
```

- [ ] **Step 6: Lint + typecheck gates**

Run: `npm run lint && npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-by-race.test.ts --config config/vitest/vitest.config.ts`
Expected: clean, PASS. (Full `npm test` runs in Task 8.)

- [ ] **Step 7: Commit**

```bash
git add src/store/panesSlice.ts src/components/TerminalView.tsx test/unit/client/store/panesSlice.fresh-by-race.test.ts
git commit -m "feat(client): DOM-visible fresh_by_race breadcrumb for race-lost pane identity (PIN 3 client)"
```

---

### Task 5: Pin 3 e2e — verify P1.10 is landed, flip the pin, prove re-capture

**Files:**
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (`SIGKILL-inside-locator-window` test at `:1933`; pin at `:1949-1952`)

**Interfaces:**
- Consumes: `data-testid="fresh-by-race-notice"` / breadcrumb text (Task 4); `fresh_by_race` verdict (Task 3); the leg's existing locals `sharedRoot`, `argLogPath`, `rowGatePath` (the `FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH` value, deliberately never created pre-kill), `{ server, harness }`, `tabId`, `leaf`, helpers `readArgvLog`, `findLeafById`.
- Produces: an unpinned, strengthened wall leg — breadcrumb visible AND post-restart identity re-capture via the (already-landed) re-armed locator.

- [ ] **Step 1: Verify P1.10 is genuinely landed (load-bearing check on the brief's claim)**

The task brief said "verify it's genuinely un-landed, then build" — exploration found it IS landed: `maybe_arm` is called unconditionally at `terminal.rs:2319` (restore creates route through the same `handle_create`), and `OpencodeLocator::arm` gates only on missing identity (`opencode_locator.rs:194-196`). Confirm the pinning test passes:

Run: `cargo test -p freshell-ws restore_created_pane_without_identity_arms_and_resolves_into_the_ledger`
Expected: PASS (1 test). Do NOT rebuild the re-arm; the e2e assertion added in Step 4 proves it end-to-end. Record this command+result in the commit body.

- [ ] **Step 2: Prove the leg flips (unexpected pass)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "SIGKILL-inside-locator-window"
```

Expected: FAILS with "passed unexpectedly" — the breadcrumb now matches `/couldn't be resumed|could not be resumed|fresh session/i` in the DOM. If it still fails expectedly, debug the breadcrumb chain (server verdict → reducer notice → DOM strip) before touching the pin; do not proceed on red.

- [ ] **Step 3: Flip the pin**

Delete exactly the four lines at 1949–1952:

```typescript
    test.fail(
      e2eServerKind === 'rust',
      'P1.8 (§2.4): SIGKILL inside locator window yields silent fresh, no breadcrumb',
    )
```

Update the leading `EXPECTED-FAIL WALL PIN` comment block (`:1938-1948`) to describe the now-live contract (keep the DETERMINISM note about the row gate — it still holds for the pre-kill phase).

- [ ] **Step 4: Add the re-capture assertion (re-armed locator, end to end)**

Immediately after the existing `expect(resumed || breadcrumbVisible).toBe(true)` (`:2007`), inside the same `try` block:

```typescript
      // P1.10 end-to-end (landed; pinned unit-side by opencode_association.rs
      // restore_created_pane_without_identity_arms_and_resolves_into_the_
      // ledger): the restore-created pane lacks identity, so the locator
      // re-armed at restore-create. Open the fake's row gate NOW and submit —
      // the re-armed locator must capture a ses_ identity post-restart.
      await fs.writeFile(rowGatePath, '')
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello again after restart')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, leaf.id)
          return l?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 })
        .toMatch(/^ses_/)
```

(Use the leg's actual local names — verify with a read of `:1953-2010` that they are `rowGatePath`, `harness`, `tabId`, `leaf`; `fs` is the spec's existing `node:fs/promises` import. If the leaf lookup shape differs, mirror the leg's own settle-poll at `:1989-1995`, which reads `l?.content?.terminalId` the same way.)

- [ ] **Step 5: Run the flipped leg green, twice**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "SIGKILL-inside-locator-window"
```

Expected: PASS, twice sequentially. If the re-capture poll is the flaky part (locator window mechanics), investigate against the green `freshopencode` leg (`:1051`) which exercises the same fake row-gate machinery — do not delete the assertion to get green.

- [ ] **Step 6: Commit**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(wall): flip SIGKILL-inside-locator-window pin — fresh_by_race breadcrumb + re-armed locator re-capture (PIN 3)"
```

---

### Task 6: Pin 2 server — instrument, then make claude identity durable BEFORE spawn

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_create` at `:1408`; insert pre-spawn write immediately before the PTY `spawn_blocking` at ~`:2195`; spawn-anchor comment)
- Create: `crates/freshell-ws/src/terminal_create_ordering_tests.rs`
- Test: the new ordering test + the wall leg (Task 7)

**Interfaces:**
- Consumes: in-scope locals of `handle_create` immediately before the spawn: `terminal_id: String` (minted once at `:1572`), `mode: String` (`:1578`), `resume_session_id: Option<String>` (`:1618`; claude preallocation assigns `Some(Uuid::new_v4().to_string())` at `:1649`), `spec` (with `spec.cwd: Option<String>`, `:2109-2141`), `create.request_id`, `state: &WsState` (with `state.pane_ledger: Arc<PaneLedger>`); `PaneLedger::record_binding(&BindingWrite) -> io::Result<()>` (atomic write+fsync+rename+fsync-parent, keyed `(provider, session_id)` — a later re-write of the same key is benign); `surface_write_failure(state, terminal_id, result)`.
- Produces: durable claude binding row BEFORE the spawn that makes the id observable in argv; source-order regression pin `claude_binding_write_precedes_pty_spawn_in_handle_create`.

- [ ] **Step 1: Instrument — confirm the leg's red cause empirically (load-bearing stage)**

First confirm the pin is still red as claimed:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "SIGKILL-within-5s"
```

Expected: green suite result with the leg reported as "expected failure".

Then a single instrumented run to disambiguate the race (TEMPORARY, uncommitted): in the `SIGKILL-within-5s-of-pane-creation` test, immediately after `await server.restartAbrupt()` (`:1893`), insert:

```typescript
      // TEMP INSTRUMENTATION (do not commit): was the binding durable at kill?
      console.log('LEDGER BINDINGS AT KILL:',
        await fs.readdir(path.join(info.homeDir, '.freshell/pane-ledger/bindings')).catch(() => 'MISSING'))
```

(`info` is in scope in this leg; the Rust server's HOME is the fixture's isolated home dir — `applyIsolatedHomeEnvironment`, `test-server.ts:76-77` — exposed as `info.homeDir`; if the property name differs, read `test/e2e-browser/fixtures/rust-server.ts:295-310` for the accessor. `path` is already imported in the spec.)

Re-run the leg once and record the output verbatim in this task's final commit body:
- `MISSING` or `[]` → **Gap A confirmed empirically**: the SIGKILL beat the post-spawn binding write.
- a binding file present → the race did not materialize on this run; Gap B (Task 7) was the observed blocker. The pre-spawn write below still lands: the window is real at the code level (argv observable at `:2211`, durability only at `:2445`), and the leg's contract is "kill immediately after argv" — without tightening, green would be timing-luck.

Revert the instrumentation: `git checkout -- test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`.

- [ ] **Step 2: Write the failing ordering test**

Create `crates/freshell-ws/src/terminal_create_ordering_tests.rs`:

```rust
//! P1.9 (D3) source-order pin: claude's preallocated identity becomes
//! OBSERVABLE at PTY spawn (`--session-id` in argv, logged synchronously by
//! the e2e fakes), so its durable ledger write must PRECEDE the spawn.
//! Reordering these reopens the SIGKILL-within-5s recovery hole
//! (restore-contract-wall `SIGKILL-within-5s-of-pane-creation`).

#[test]
fn claude_binding_write_precedes_pty_spawn_in_handle_create() {
    let src = include_str!("terminal.rs");
    let write = src
        .find("PIN2_CLAUDE_PRE_SPAWN_BINDING")
        .expect("pre-spawn claude binding block (PIN2_CLAUDE_PRE_SPAWN_BINDING) missing from terminal.rs");
    let spawn = src
        .find("PIN2_PTY_SPAWN_ANCHOR")
        .expect("PTY spawn anchor (PIN2_PTY_SPAWN_ANCHOR) missing from terminal.rs");
    assert!(
        write < spawn,
        "claude durable binding write must stay BEFORE the PTY spawn: durability precedes observability"
    );
}
```

Wire it in `crates/freshell-ws/src/terminal.rs` (top of file, next to any existing `#[cfg(test)]` mod wiring; same pattern as `recovery_inventory.rs`'s `#[path]` test module):

```rust
#[cfg(test)]
#[path = "terminal_create_ordering_tests.rs"]
mod terminal_create_ordering_tests;
```

- [ ] **Step 3: Run to verify RED**

Run: `cargo test -p freshell-ws claude_binding_write_precedes_pty_spawn`
Expected: FAIL — `PIN2_CLAUDE_PRE_SPAWN_BINDING missing`.

- [ ] **Step 4: Implement the pre-spawn durable write**

In `crates/freshell-ws/src/terminal.rs`, immediately BEFORE the PTY `spawn_blocking` whose `.await` is at ~`:2211` (i.e. just above the `let spawn_...` clones at ~`:2190-2195`), insert:

```rust
    // PIN2_CLAUDE_PRE_SPAWN_BINDING — P1.9 (D3) durability-before-
    // observability: a fresh claude create preallocates its --session-id
    // (:1649) and the spawn below makes that id OBSERVABLE (argv, logged
    // synchronously by the e2e fakes). A SIGKILL landing right after spawn
    // must still find a durable ledger row, or the recovery inventory has
    // nothing to offer after browser loss. The post-spawn binding write
    // (:2420 arm) re-records the same (provider, session_id) key with the
    // resolved cwd — a benign re-write. Failure policy identical to that
    // arm: never blocks the create, surfaced LIVE.
    if mode == "claude" {
        if let Some(session_id) = resume_session_id.as_deref() {
            let ledger = std::sync::Arc::clone(&state.pane_ledger);
            let write_session_id = session_id.to_string();
            let write_terminal_id = terminal_id.clone();
            let write_mode = mode.clone();
            let write_cwd = spec.cwd.clone();
            let write_request_id = create.request_id.clone();
            let now = now_ms();
            let result = tokio::task::spawn_blocking(move || {
                ledger.record_binding(&crate::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: &write_session_id,
                    terminal_id: &write_terminal_id,
                    mode: &write_mode,
                    cwd: write_cwd.as_deref(),
                    create_request_id: Some(&write_request_id),
                    now_ms: now,
                })
            })
            .await
            .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
            crate::pane_ledger::surface_write_failure(state, &terminal_id, result);
        }
    }
```

And add the anchor comment on the line directly above the PTY `spawn_blocking` call (~`:2195`):

```rust
    // PIN2_PTY_SPAWN_ANCHOR: the spawn makes preallocated identity observable.
```

Notes for the implementer: (1) this fires for claude resume-creates too — their binding row already exists from a prior epoch, so the re-write is a no-op refresh; (2) `MARKER_MODES` correctly still excludes claude (claude has create-time identity and no post-spawn resolver — this write IS its durability story; record this answer to the brief's "should claude also get a marker?" question in the commit body: no — a binding row before spawn is strictly stronger than a marker); (3) the pre-spawn window for `MARKER_MODES` providers (their marker is also written post-spawn) is a known residual NOT exercised by any wall leg — do not fix it here (YAGNI; noted for a follow-up if a leg ever pins it).

- [ ] **Step 5: Run to verify GREEN**

Run: `cargo test -p freshell-ws claude_binding_write_precedes_pty_spawn && cargo test -p freshell-ws && cargo test --workspace`
Expected: ordering test PASSES; full workspace green.

- [ ] **Step 6: Rust gates + commit**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/terminal_create_ordering_tests.rs
git commit -m "fix(ws): claude binding row durable BEFORE PTY spawn — durability precedes argv observability (PIN 2 server)"
```

(Include the Step 1 instrumentation output verbatim in the commit body.)

---

### Task 7: Pin 2 e2e — fix the offer probe, flip the pin

**Files:**
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (`SIGKILL-within-5s-of-pane-creation` test at `:1816`; pin at `:1825-1828`; probe at `:1919-1924`)

**Interfaces:**
- Consumes: durable-before-spawn claude binding (Task 6); the shipped recovery offer UI — `data-testid="recovery-offer-panel"` (`RecoveryOfferPanel.tsx:190`), heading `Restore N panes from server memory?` (`:217`); the leg's locals `{ server, harness, info }`, `preallocatedId`.
- Produces: an unpinned, honestly-passing wall leg.

- [ ] **Step 1: Fix the probe (Gap B)**

The current probe can never match the shipped UI — `getByText(/recover .*pane/i)` vs the actual heading `Restore N panes from server memory?`. This is a broken test selector written before the panel existed (the green `recover-my-panes-rust.spec.ts` uses the testid). Replace the offer arm inside the poll at `:1919-1924`:

```typescript
          const recoverOffer = await page
            .getByTestId('recovery-offer-panel')
            .isVisible()
            .catch(() => false)
          return recoverOffer
```

(The poll's other arm — a pane whose `sessionRef.sessionId === preallocatedId` — stays byte-identical; the contract is unchanged: auto-restored OR visibly offered.)

- [ ] **Step 2: Prove the leg flips (unexpected pass)**

```bash
cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts -g "SIGKILL-within-5s"
```

Expected: FAILS with "passed unexpectedly" — the ledger row now survives the kill (Task 6), the recovery inventory's `ledgerOnly` arm reports it, `recoverable: true`, the panel opens, the testid probe sees it. If it still fails expectedly, debug the chain in order: binding file present in `<homeDir>/.freshell/pane-ledger/bindings/` after kill → `GET /api/recovery/inventory` returns `recoverable: true` with a `ledgerOnly` entry → panel mounts. Do not proceed on red.

- [ ] **Step 3: Flip the pin**

Delete exactly the four lines at 1825–1828:

```typescript
    test.fail(
      e2eServerKind === 'rust',
      'P1.8+P1.9 (D3): pane created <5s before SIGKILL is unrecoverable after browser loss',
    )
```

Update the leading `EXPECTED-FAIL WALL PIN` comment (`:1821-1824`) to describe the now-live contract.

- [ ] **Step 4: Run the flipped leg green, twice**

Same command as Step 2, twice sequentially. Expected: PASS both times.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(wall): flip SIGKILL-within-5s pin — durable pre-spawn binding + correct recovery-offer probe (PIN 2)"
```

---

### Task 8: Full gates, wall stability ×3, push

**Files:**
- No new source changes expected (fix-forward only if a gate fails; each fix gets its own focused commit).

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed branch `fix/wall-pins-closure` with the wall green, zero pins, three consecutive full runs.

- [ ] **Step 1: Zero-pin audit**

Run: `grep -n "test\.fail(" test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`
Expected: NO matches in code (prose mentions in comments are fine — verify each hit is inside a comment). Also `grep -rn "test\.fixme" test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` → no matches.

- [ ] **Step 2: (Only if deferred from Task 2 Step 6) flip the ruler pin now**

If the ruler pin was left in place, re-run the ruler leg; on "passed unexpectedly", delete `:1500-1503` and commit as Task 2 Step 9 describes. If it STILL fails expectedly, HALT: report the failing leg's error verbatim — the wall cannot honestly reach zero pins and the workflow must surface that rather than re-pin.

- [ ] **Step 3: Rust gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all clean/green.

- [ ] **Step 4: Node gates (coordinator-aware)**

```bash
npm run test:status   # if held: wait 60s and re-check until free
FRESHELL_TEST_SUMMARY='wall pins closure' env -u FRESHELL_BIND_HOST npm test
npm run test:port
npm run lint
npm run contract:generate && git diff --exit-code -- port/contract
cargo test -p freshell-protocol --locked
```

Expected: all green; no contract diff.

- [ ] **Step 5: Release build + THE FULL WALL ×3**

```bash
cargo build --release -p freshell-server
for i in 1 2 3; do
  npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust.spec.ts || { echo "WALL RUN $i FAILED"; break; }
done
```

Expected: three consecutive fully-green runs, zero pins, zero unexpected passes. Runs are sequential (shared host — never parallel). If any run fails: diagnose and fix forward (focused commit), then restart the 3× count from run 1. If a formerly-pinned leg cannot honestly stay green, HALT and report — never re-pin.

- [ ] **Step 6: Sibling e2e suites**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium hidden-pane-rebind-rust.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium reconcile-client-adoption-rust.spec.ts reconcile-completion-rust.spec.ts reconcile-handshake-rust.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium recover-my-panes-rust.spec.ts
```

Expected: all green (`recover-my-panes` guards Task 6/7 against regressions in the offer flow; the reconcile suites guard Tasks 2–4).

- [ ] **Step 7: Push the branch — NO PR**

```bash
git log --oneline origin/main..HEAD   # review: focused, atomic commits only
git push -u origin fix/wall-pins-closure
```

Do NOT open a pull request. Landing happens outside this workflow with the final review verdict.

---

## Self-Review (performed against the task spec)

**1. Spec coverage:**
- Pin 1 claude carve-out mirroring amplifier → Task 2. PR #565 coherence (two halves, no overlap) → Task 2 design decision + comment. Named red test `claude_never_conversed_yields_respawn_not_dead_session` → Task 2 Step 1. Composed ruler leg → Task 2 Steps 6–8. True-positive hazard guard → Task 2 `claude_deleted_after_conversation_stays_dead_session` (in-boot, direct) + `respawn_exhausted` convergence for the cross-restart shape (explicit design decision, mirrored from the amplifier arm's accepted tradeoff).
- Pin 3 read side before generic Fresh, marker lookup by terminalId lineage, distinct surfaced `fresh_by_race` → Task 3. Client fold breadcrumb visible → Task 4 (reason already flows through the fold; text + DOM visibility are where the change bites — noted explicitly). Contract-pinned check → verified NOT pinned; gates still run generate/test:port/protocol (Tasks 3, 8). P1.10 "verify then build" → verified LANDED (Task 5 Step 1 evidence) + end-to-end re-capture assertion added to the leg (Task 5 Step 4). Red tests: unit marker→fresh_by_race (Task 3), e2e breadcrumb + re-capture + pin flip (Task 5).
- Pin 2 instrument FIRST → Task 6 Step 1 (empirical bindings-at-kill disambiguation, recorded). Candidate (a) boot-state unwired → disproven with evidence (wired via App.tsx:1926; green recover-my-panes e2e). Candidate (b) race → real code-level window; fixed by durability-before-spawn (Task 6). Claude marker question → answered explicitly (binding-before-spawn is strictly stronger; recorded in commit body). Red tests: wall leg (Task 7) + ordering pin `claude_binding_write_precedes_pty_spawn_in_handle_create` (Task 6, the unit-level pin on the broken link).
- Gates: fmt/clippy/cargo test, npm test with summary + coordinator wait, test:port, lint, release build, full wall ×3 with zero pins, hidden-pane-rebind + reconcile (+ recover-my-panes) suites, ephemeral ports, no-PR push → Task 8 + Global Constraints. Fix order Pin 1 → Pin 3 → Pin 2 → task order 1–7.

**1b. No silent deferrals:** every requirement lands as production behavior proven by an unpinned wall leg (no stubs/mocks/fakes standing in — the fake CLIs are the wall's own pre-existing harness, not new test doubles). One explicitly-scoped non-goal: the pre-spawn durability window for `MARKER_MODES` providers (markers also written post-spawn) — NOT part of any spec'd pin, not exercised by any wall leg, documented in Task 6 Step 4 note (3). This is a scope observation from investigation, not a spec requirement being deferred; no UNRESOLVED COVERAGE GAP exists against the spec.

**2. Placeholder scan:** two steps intentionally reference sibling-test fixtures by exact name instead of inlining unknown fixture internals (Task 1 Step 1 construction lines; Task 5 Step 4 leaf-lookup fallback note) — in both, the assertions and target behavior are fully specified and the referenced fixture is named with file+line. No TBDs, no "handle edge cases", no test-less "write tests" steps.

**3. Type consistency:** `ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool` used identically in Tasks 1 and 2; `fresh_by_race_marker_tids(panes: &[ReconcilePane], verdicts: &[PaneVerdict]) -> Vec<String>` defined (Task 3 Step 4) matches both call sites (Task 3 Steps 2 and 5); `RECONCILE_NOTICE_FRESH_BY_RACE` defined (Task 4 Step 3) matches the import (Task 4 Step 5) and the e2e regex (verified by the Task 4 unit test); `BindingWrite` field set (`provider, session_id, terminal_id, mode, cwd, create_request_id, now_ms`) is identical across Task 2, Task 3 (none), and Task 6, matching the existing write block at `terminal.rs:2434-2443`; the reason strings `fresh_by_race` / `no_recoverable_identity` / `session_not_on_disk` are used byte-identically across server, tests, and client.
