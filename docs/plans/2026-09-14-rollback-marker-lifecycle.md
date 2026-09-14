# Rolled-Back Marker Restorability Lifecycle Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the agreed restorability-driven lifecycle for the fresh-agent "Rolled back" marker section (the rolled-back turns list at the bottom of fresh-agent pane transcripts). Today the section stays expanded forever once any turn has been rolled back. Change it so: (1) the expanded section with per-turn "Redo to here" affordances renders only for turns that are still restorable (current rollback chain, redo available); (2) turns that are not restorable — redo permanently destroyed by a new submission, markers frozen from prior rollback chains, or codex (undo-only) from the moment of its undo — render as a single quiet collapsed line "Rolled back (N) — kept in history" that the user can expand on demand; (3) the server stamps per-marker restorability onto the snapshot via an additive strict-contract key that older-server payloads tolerate (absent treated as not restorable); (4) the expanded header counts only restorable steps and the collapsed line counts only historical steps — the all-time union is never presented as live state; (5) presentation is a pure function of the snapshot: no timers, no per-client dismissal state, identical on refresh, remount, and other devices. The durable rollback record contents and the undo/redo wire semantics are unchanged; only the snapshot surface grows one additive key and the client presentation changes.

### Explicit constraints
- Execute via the-usual six-stage workflow.
- Work in a dedicated worktree under `.worktrees/` on branch `the-usual/rollback-marker-lifecycle` based on `origin/main`; never commit behavior changes to main; never push to origin/main; no PR without explicit user approval.
- Red-Green-Refactor TDD with unit and e2e coverage; affected e2e specs must actually pass on the configured cloud backend (never add specs to CLOUD_SKIP_SPECS; keep tests ≤120s wall).
- Frozen contract workflow for any change to the WS-frozen surface (wire changes): edit `shared/ws-protocol.ts`, run `npm run contract:generate`, update `crates/freshell-protocol` inventory arrays/counts, and commit regenerated `port/contract/*.json` in the same commit.
- Rust gates: `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; toolchain 1.96.0.
- A11y (CI-gated via `npm run lint`): every new interactive element is a semantic `<button>` with a discernible aria-label.
- Coordinated test gates: check `npm run test:status` before any broad run; wait on foreign holders; label broad runs with `FRESHELL_TEST_SUMMARY`.
- Never restart the live self-hosted server (port 3001) without the user's explicit "APPROVED".
- The legacy TypeScript server (`server/`) is not modified by this feature (rollback is Rust-server-only).
- Shared modules use NodeNext/ESM: relative imports under `shared/` keep `.js` extensions.

### Accepted tradeoffs and residuals
- Codex renders collapsed from birth: it is undo-only, so its markers are never restorable and only ever appear as the collapsed history line.
- Immediate post-undo feedback relies on the existing composer refill plus the "Undone — the removed prompt is back in the composer" notice, not on an expanded marker list.
- The collapsed line is non-dismissible; one quiet line is the minimal honest representation of permanently removed steps.
- The durable marker record ("persist marked in history") is unchanged; only its presentation changes.
- Existing tests/e2e expectations that assert expanded visibility in non-restorable states (notably codex cases) are updated to the collapsed presentation; the literal "Rolled back (N)" phrasing is kept in both states so text-based selectors keep matching where possible.

**Goal:** The fresh-agent "Rolled back" section shows restorable turns expanded with redo affordances and collapses every non-restorable turn behind a single quiet "Rolled back (N) — kept in history" disclosure line, all derived purely from a new server-stamped per-marker `restorable` snapshot flag.

**Architecture:** The Rust snapshot stamper `stamp_rollback_snapshot` (`crates/freshell-freshagent/src/rollback_record.rs`) grows a read-time per-turn `restorable` key — `can_redo_param && entry.epoch == record.current_epoch`, stamped on ALL roles beside the existing `rolledBack:true` injection — where `can_redo_param` is the provider-adjudicated argument (claude's tip recheck included). The shared zod turn schema in `shared/fresh-agent-contract.ts` declares the optional key (absent ⇒ older server ⇒ not restorable). The client transcript (`FreshAgentTranscript.tsx`) splits the bucket on the flag: restorable rows keep today's expanded section and redo buttons; everything else renders behind a collapsed disclosure line. The durable rollback record, the WS frames, and the undo/redo handlers are untouched.

**Tech Stack:** Rust workspace crate `freshell-freshagent` (serde_json snapshot stamping), shared zod REST contract (`shared/fresh-agent-contract.ts`), React 18 + TypeScript client (`FreshAgentTranscript.tsx`), Vitest unit suites, Playwright `rust-chromium` e2e (local + cloud).

## Global Constraints

- **Worktree/branch:** all work happens in `/home/dan/code/freshell/.worktrees/rollback-marker-lifecycle` on branch `the-usual/rollback-marker-lifecycle` (base `e46020b4d21d30ba54032c30b56111b8c93b7c76` = `origin/main`). Never commit to `main`; never push to `origin/main`; no PR without explicit user approval. Committer identity comes from the repo/global git config — never override it and never write `dan@danshapiro.com` into git config or commits.
- **Frozen-contract constraint compliance (evidence-cited):** the User Request's frozen-contract workflow governs changes that touch the WS-frozen surface. The fresh-agent snapshot schema lives in `shared/fresh-agent-contract.ts` (a REST payload, strict-parsed client-side at `src/lib/api.ts:487`), NOT in `shared/ws-protocol.ts`: the generator (`port/contract/generate-ws-contract.ts`) reads only `shared/ws-protocol.ts`, `FreshAgentTurnSchema`/`FreshAgentSnapshotSchema` are absent from the committed `port/contract` bundle, and the snapshot never rides a WS frame (`freshAgent.event.event` is opaque; the client fetches snapshots over REST). Precedent: commit `7b0c0ea9b` added the snapshot-level `redoableTurnIds` key with zero `port/contract/`, `crates/freshell-protocol`, or `ws-protocol.ts` changes. For THIS change, compliance is executed as follows: the workflow's verification leg runs in Task 1 Step 6 — `npm run contract:generate` is executed and `git status --porcelain port/contract/ crates/freshell-protocol/ shared/ws-protocol.ts` must come back EMPTY; the "commit regenerated `port/contract/*.json` in the same commit" clause is satisfied vacuously because regeneration produces no diff (there is nothing to commit). There is no `shared/ws-protocol.ts` edit for a REST-snapshot key — a gratuitous WS edit would be churn against the freeze tests, not compliance. A non-empty verification result means the frozen surface was touched by mistake — stop and fix before committing. The full checklist (ws-protocol.ts edit → contract:generate → `crates/freshell-protocol` inventory arrays/counts → commit regenerated artifacts) becomes mandatory only if a WS frame type changes, which this feature does not do.
- **Critical lockstep:** the Rust stamp and the `shared/fresh-agent-contract.ts` schema key MUST land in the same commit (Task 1) — the client strict-parses snapshots, so a server stamping an undeclared key would make every new-server snapshot fail client-side.
- **TDD:** Red-Green-Refactor per task. Never weaken, skip, or delete tests to make verification pass. The only justified Red exception in this plan is Task 3's e2e additions (coverage of behavior whose Red was proven at unit level in Task 2) — record it in the implementer report as the plan directs.
- **Rust gates:** `cargo fmt --all --check` (fix with `cargo fmt --all`); `cargo clippy --workspace --all-targets -- -D warnings`; toolchain 1.96.0.
- **ESM:** relative imports under `shared/` keep `.js` extensions.
- **A11y:** every new interactive element is a semantic `<button type="button">` with a discernible aria-label; `npm run lint` (eslint-plugin-jsx-a11y, CI-gated) must pass.
- **Test coordination (applies to every broad run this plan triggers):** check `npm run test:status` before any broad run; wait on a foreign holder rather than killing it; label every broad run with `FRESHELL_TEST_SUMMARY` (e.g. the end-of-execution gate in the Verification summary and Task 3 Step 7's cloud e2e run both carry `FRESHELL_TEST_SUMMARY='the-usual: rollback-marker-lifecycle <purpose>'`). Focused unit runs use the repo-owned passthrough: `npm run test:vitest -- run <paths>`.
- **Vitest passthrough rule (validated by executed reproduction):** the coordinator classifies forwarded paths by config ownership. Default-owned paths (`test/unit/client/**`, `test/unit/shared/**`, `test/unit/lib/**`) run under `config/vitest/vitest.config.ts`. Server-owned paths (`test/unit/server/**`, `test/server/**`) REQUIRE the explicit config with the subcommand AFTER it: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts run <paths>`. NEVER mix default-owned and server-owned paths in one invocation — a mixed set falls to the default config, which EXCLUDES `test/unit/server/**`: the server files silently do not run and the command still exits 0 (a false green). Never put a bare leading `run` before an explicit `--config` — the coordinator prepends its own `run` and the stray positional becomes a path filter matching every file with `run` in its path. Evidence: scripts/testing/coordinator-command-matrix.ts:546-557, config/vitest/vitest.config.ts:43, executed reproductions in the load-bearing finder report (§A1).
- **e2e:** `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` must stay out of `CLOUD_SKIP_SPECS`/`CLOUD_SKIP_TITLES`; every test ≤120s wall; runs require `--project=rust-chromium` (the match-all chromium project ignores RUST_ONLY_SPECS — a filtered-to-nothing run is not coverage). The e2e boots its own ephemeral servers; it never touches the live port-3001 server, which must never be restarted without the user's explicit "APPROVED".
- **`server/` (legacy TypeScript server) is untouched** by this feature.
- **docs/index.html needs no change:** the mock depicts no rolled-back section today (verified — zero matches for "rolled back" in the mock), and this is a presentation-lifecycle nuance, not a major feature.
- **No production-data or live-server interactions:** all verification runs against hermetic in-repo fakes on ephemeral ports.

Supporting exploration evidence (file:line citations for every claim above) lives in the run's reports:
`/home/dan/code/freshell/.worktrees/.the-usual-logs/rollback-marker-lifecycle/reports/plan-server-surface.md`, `plan-client-render.md`, `plan-e2e-coverage.md`, `plan-rust-epochs.md`. Implementers should consult them for surrounding context; the plan's own citations are authoritative for the task at hand.

---

### Task 1: Wire surface — server stamps per-marker `restorable`; the shared contract declares it

**Files:**
- Modify: `crates/freshell-freshagent/src/rollback_record.rs:537-572` (`stamp_rollback_snapshot` + its doc comment at ~518-536)
- Modify: `shared/fresh-agent-contract.ts:182-201` (`FreshAgentTurnSchema`, insert after the `rolledBack` key at line 200)
- Test: `crates/freshell-freshagent/src/rollback_record.rs` (stamper tests at ~1151, ~1189, ~1270; plus one NEW test)
- Test: `crates/freshell-freshagent/src/claude_snapshot.rs` (tests at ~2076, ~2118, ~2162, ~2206)
- Test: `crates/freshell-freshagent/src/lib.rs` (opencode snapshot tests at ~4081, ~4202, ~4248, ~4277, ~4299)
- Test: `crates/freshell-freshagent/src/codex.rs` (snapshot tests at ~17412, ~17483)
- Test: `crates/freshell-freshagent/src/snapshot.rs` (REST route test at ~643)
- Test: handler op-sequence tails — `crates/freshell-freshagent/src/opencode_ws.rs:11783`, `claude.rs:14736`, `codex.rs:12764`
- Test: `test/unit/shared/fresh-agent-contract.test.ts` (rollback-surface describe block ~115-179)

**Interfaces:**
- Consumes: `RollbackRecord.entries[*].epoch` vs `RollbackRecord.current_epoch` (rollback_record.rs:131-176), and the provider-adjudicated `can_redo` parameter already received by `stamp_rollback_snapshot` (claude's `claude_can_redo_now` tip recheck arrives through it — claude_snapshot.rs:1022-1033).
- Produces: per-turn `restorable: true|false` on every server-produced `rolledBackTurns` row (all roles): true/false from the record-based stamper, and explicit `false` on the record-less opencode fallback bucket rows (`lib.rs:1604-1609` — a new server speaks authoritatively; it never serves a maybe-restorable marker without adjudicating it). An ABSENT key remains exclusively the older-server tolerance (absent ⇒ not restorable). Later tasks consume `turn.restorable === true` client-side.

- [ ] **Step 1: Write the failing tests (Rust + TS)**

Rust — extend the stamper unit tests in `rollback_record.rs` (`mod tests`):

In `stamp_rollback_snapshot_stamps_markers_at_read_time_and_counts_user_steps` (~1270, record: one entry [u2,a2], `can_redo=true`): add assertions that BOTH bucket turns carry `restorable == json!(true)`, and — mirroring the existing read-time-stamp check at ~1294-1296 — that the STORED entry JSON still has NO `restorable` key after stamping (the flag is stamped at read time, never stored, exactly like `rolledBack`).

In `stamp_rollback_snapshot_lists_only_current_epoch_user_ids_as_redoable` (~1151, two-epoch record): add per-turn assertions — every epoch-0 bucket turn `restorable == json!(false)`, every current-epoch bucket turn `restorable == json!(true)`, on BOTH roles (user and assistant rows alike).

In `stamp_rollback_snapshot_redoable_ids_are_empty_when_redo_is_unavailable` (~1189, `can_redo=false`): add the assertion that every bucket turn carries `restorable == json!(false)`.

Add ONE new test in the same module:

```rust
#[test]
fn stamp_rollback_snapshot_stamps_restorable_on_all_roles_matching_the_redoable_rule() {
    // Two-epoch record: frozen entry [o1(role user), o2(role assistant)] at
    // epoch 0, current entry [u2(role user), a2(role assistant)] at epoch
    // current_epoch. can_redo = true.
    // Assert:
    //  - bucket rows: [o1, o2, u2, a2] with restorable [false, false, true, true]
    //    (ALL roles stamped, not just user rows)
    //  - the user-role rows with restorable:true are EXACTLY redoableTurnIds
    //    (invariant: user rows restorable <=> members of the redo gate set)
    //  - with can_redo = false over the same record, every restorable stamp
    //    flips to false and redoableTurnIds is empty.
    // Build the record with the same helpers the neighboring tests use
    // (RollbackRecord::empty(now_ms) — there is NO Default impl — then
    // begin_new_epoch/splice_undo_entry/push_entry per the patterns at
    // rollback_record.rs:1151-1183).
}
```

Rust — extend the per-provider snapshot tests (each already pins the exact `rollback` block JSON; grow them with per-turn `restorable` checks on the bucket — per-field assertions, `assert_eq!(turn["restorable"], json!(true/false))`):

- `claude_snapshot.rs` `claude_snapshot_surfaces_the_ledger_bucket_and_rechecks_the_original_tip` (~2076): u2/a2 `restorable == true`.
- `claude_snapshot.rs` `claude_snapshot_a_moved_original_tip_forces_can_redo_false` (~2118): u2/a2 `restorable == false` even though the STORED bit is true — this is the regression pin for the provider-adjudicated-param rule.
- `claude_snapshot.rs` `claude_snapshot_the_bucket_is_the_entries_union_across_epochs` (~2162): frozen o1/o2 `restorable == false`; current-epoch u2/a2 `restorable == true`.
- `claude_snapshot.rs` `claude_snapshot_destroyed_redo_keeps_the_marked_bucket` (~2206): `restorable == false`.
- `lib.rs` `opencode_snapshot_filters_turns_to_the_active_prefix_and_marks_the_tail` (~4081): the record-LESS fallback bucket turns carry `restorable == json!(false)` (the fallback path stamps an explicit false — an out-of-band revert is never restorable, and an absent key stays reserved for older-server payloads).
- `lib.rs` `opencode_snapshot_stamps_capabilities_and_the_ledger_marker_bucket` (~4202), `opencode_snapshot_undone_depth_counts_user_steps_not_entries` (~4248), `get_opencode_snapshot_surfaces_the_durable_rollback_record` (~4299): bucket turns `restorable == true`.
- `lib.rs` `opencode_snapshot_destroyed_redo_keeps_the_marked_bucket_alive` (~4277): `restorable == false` (the collapsed-history server truth).
- `codex.rs` `codex_snapshot_stamps_paginated_capabilities_the_marker_bucket_and_the_revision_floor` (~17412) and `get_snapshot_surfaces_the_durable_rollback_record_and_floors_the_revision` (~17483): bucket turns `restorable == false` (codex is undo-only — collapsed from birth).
- `snapshot.rs` `claude_locator_surfaces_the_durable_rollback_record` (~643): the REST-surfaced bucket turns `restorable == true`.

Rust — add snapshot reads inside the three real-handler op-sequence tests, each using the exact call shape proven by the tests that already live in that file (verified against the current source):

- `opencode_ws.rs` `handle_rollback_after_a_resend_starts_a_new_epoch_and_redo_still_works` (~11783): immediately after the second undo's existing record asserts (the test already loads `let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record")` and asserts bucket `[msg_u3,msg_a3,msg_u4,msg_a4]`, epochs `[0,1]`, `can_redo()` true — around ~11818-11840) and BEFORE the redo leg, mirror the neighboring `compact_retires_redo_...` test's direct call (~8599): `crate::build_opencode_snapshot_json("ses_real", &json!({ "id": "ses_real", "time": { "updated": 5 } }), &json!([]), Some(&record))` — the builder is crate-callable and the neighboring test in this very file asserts `snap["rollback"]` through it. Assert: the epoch-0 rows msg_u3/msg_a3 carry `restorable == json!(false)`; the epoch-1 rows msg_u4/msg_a4 carry `restorable == json!(true)`; `snap["rollback"]["redoableTurnIds"] == json!(["msg_u4"])`.
- `claude.rs` `handle_rollback_after_a_resend_re_roots_the_chain_and_redo_restores_the_new_epoch` (~14736): after the second undo's record asserts (entries union [u2,a2]+[uq,aq], epochs `[0,1]` — around ~14828-14884) and BEFORE the redo leg, call `crate::claude_snapshot::get_claude_snapshot(<session_type>, <thread_id>, Some(&record)).await` (`pub(crate) async fn`, claude_snapshot.rs:1117 — the test's staged `CLAUDE_CONFIG_DIR` transcripts make `locate_transcript` resolve) and assert: u2/a2 `restorable == false`; uq/aq `restorable == true`.
- `codex.rs` `handle_rollback_undo_send_undo_undo_freezes_epoch_zero_and_orders_the_new_epoch_ascending` (~12764): at the test's tail (after the existing entries asserts ~12853-12868), mirror the `codex_snapshot_stamps_paginated_capabilities_the_marker_bucket_and_the_revision_floor` test's DIRECT `build_codex_snapshot_json` call (~17412, same-file `mod tests` so the file-private builder is callable) with this test's loaded record, and assert: EVERY bucket turn `restorable == false` and `rollback.canRedo == false` (codex can never be restorable). Do NOT call `st.get_snapshot(...).await` inline in this test — it sends `thread/read` to the fake sidecar and awaits a response this single-task test cannot service (the neighboring snapshot test at ~17502-17520 spawns the call and services `peer` concurrently; this handler test has no background responder, so an inline await would hang the gate).

TS — in `test/unit/shared/fresh-agent-contract.test.ts`, in the `rollback surface (kata 1wxv)` describe block (~115-179), add alongside the existing `rolledBack` legs (~129-134; follow the block's inline-literal fixture style seen at 129-146):

```ts
  it('a bucket turn may carry restorable', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true, restorable: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.restorable).toBe(true)
  })
  it('restorable is optional on turns (older servers omit it)', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.restorable).toBeUndefined()
  })
  it('snapshot round-trips restorable-stamped rolledBackTurns', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [],
      rolledBackTurns: [{ id: 't2', turnId: 't2', summary: 'gone', items: [], rolledBack: true, restorable: true }],
      rollback: { canRedo: true, undoneDepth: 1, redoableTurnIds: ['t2'] },
      extensions: {},
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.rolledBackTurns?.[0]?.restorable).toBe(true)
  })
  it('a turn with an undeclared restorableTypo key rejects (turn stays strict)', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true, restorableTypo: true,
    }).success).toBe(false)
  })
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent stamp_rollback_snapshot`

Expected: FAIL — the new `restorable` assertions fail because `stamp_rollback_snapshot` does not stamp the key (assertions on `turn["restorable"]` mismatch a `Value::Null`/missing key), and the new all-roles test fails for the same reason.

Run: `cargo test -p freshell-freshagent -- claude_snapshot opencode_snapshot codex_snapshot claude_locator`

Expected: FAIL for the same missing-key reason in the extended provider tests. (Multiple positional filters after `--` are OR'd name filters — verified empirically on this host's toolchain 1.96.0 by the load-bearing finder with a scratch crate; see reports/load-bearing-finder.md §A2. A filter that matches nothing exits 0 with "0 tests", so a typo'd filter would surface HERE as an unexpected pass — treat any "0 tests" or unexpected-pass result at this step as a stop-and-fix condition, never as the intended Red.)

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL — `restorable: true` and `restorableTypo` reject against the strict turn schema (undeclared key), i.e. the schema change is missing.

- [ ] **Step 3: Add the minimal production implementation**

Rust — `crates/freshell-freshagent/src/rollback_record.rs`, in `stamp_rollback_snapshot` (~543-552), replace the bucket build:

```rust
    let bucket: Vec<Value> = record
        .entries
        .iter()
        .flat_map(|e| {
            // Per-marker restorability (rolled-back section lifecycle): a
            // marker is restorable iff redo is available (the provider-
            // adjudicated `can_redo` param — claude rechecks the chain tip
            // through it) AND its entry belongs to the CURRENT epoch (frozen
            // prior-epoch markers are never restorable). The exact per-turn
            // generalization of `redoable_turn_ids`, stamped on ALL roles.
            let restorable = can_redo && e.epoch == record.current_epoch;
            e.removed_turns.iter().map(move |t| (t, restorable))
        })
        .map(|(t, restorable)| {
            let mut t = t.clone();
            t["rolledBack"] = json!(true);
            t["restorable"] = json!(restorable);
            t
        })
        .collect();
```

Also extend the function's doc comment (~518-536) with one line noting the read-time `restorable` stamp beside the existing `rolledBack` bullet, and leave `redoable_turn_ids` (577-594) untouched (minimal diff; the user-row invariant holds by construction).

Rust — also stamp the record-less fallback bucket: in `crates/freshell-freshagent/src/lib.rs`, `build_opencode_snapshot_json`'s record-less fallback turn projection (the per-turn `rolledBack` stamp at ~1539, bucket insert at ~1604-1609), stamp `t["restorable"] = json!(false)` beside the existing `rolledBack` stamp. An out-of-band revert the ledger never observed can never be restorable, and the new server must not leave the key ambiguous — an absent key stays reserved exclusively for older-server payloads.

TS — `shared/fresh-agent-contract.ts`, in `FreshAgentTurnSchema` immediately after the `rolledBack` key (line 200):

```ts
  // Rolled-back section lifecycle: server-stamped per rolledBackTurns marker
  // row — true only while the step is still restorable (current rollback
  // chain, redo available); always false for out-of-band fallback markers.
  // Absent (an older-server payload) ⇒ not restorable ⇒ collapsed history
  // presentation. Never stamped on live turns[].
  restorable: z.boolean().optional(),
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent stamp_rollback_snapshot`

Expected: PASS

Run: `cargo test -p freshell-freshagent`

Expected: PASS (the full freshell-freshagent crate — this covers every extended provider/builder/handler test. WALL CAVEAT: this worktree has NO shared cargo target dir — the FIRST run pays a full cold workspace build; expect tens of minutes, not minutes, and treat a long silent build as normal, not a hang. Subsequent runs are warm.)

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No structural refactor is expected (one stamping site, one schema key). If the two test extensions revealed duplicated fixture-building, deduplicate within the touched test modules only. Keep `redoable_turn_ids` untouched.

- [ ] **Step 6: Run impacted-test verification + gates**

Impacted set: the whole `freshell-freshagent` crate (every snapshot builder consumer) plus the shared contract suite plus the client/server snapshot-contract unit tests that strict-parse builder output.

Run: `cargo test -p freshell-freshagent` (if not already green in Step 4)

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts run test/unit/server/rust-claude-snapshot-contract.test.ts test/unit/server/fresh-agent/opencode-normalize.test.ts`

Expected: PASS (the server-config workload — the `run` subcommand goes AFTER the explicit `--config`, which the coordinator forwards verbatim. NEVER merge default-owned and server-owned paths into one `test:vitest` invocation: the coordinator routes mixed sets to the default config, which EXCLUDES `test/unit/server/**` — the server files silently do not run and the command still exits 0, a false green. Also never write the server invocation with a leading bare `run` before the config — the coordinator prepends its own `run` and the stray positional becomes a path filter pulling in every file with `run` in its path. The golden-fixture byte-identity test is unaffected — the fixture carries no rollback keys.)

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`

Expected: PASS (fix with `cargo fmt --all` if the new code needs it)

Run: `npm run contract:generate && git status --porcelain port/contract/ crates/freshell-protocol/ shared/ws-protocol.ts`

Expected: contract regeneration produces NO diff and the porcelain output is EMPTY (the frozen WS surface is untouched — the Global Constraints explain why). A non-empty result is a stop-and-fix condition.

Run: `npm run typecheck:client`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/rollback_record.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/snapshot.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/claude.rs shared/fresh-agent-contract.ts test/unit/shared/fresh-agent-contract.test.ts
git commit -m "feat(fresh-agent): stamp per-marker restorable on the rollback snapshot bucket"
```

### Task 2: Client presentation lifecycle — restorable rows stay expanded, everything else collapses behind a disclosure line

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (props/state ~891-955; the rolled-back section render ~1153-1182)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:2945` (ONE line: pass `sessionId={snapshot?.sessionId}` to the transcript — the disclosure state is conversation-scoped; without it the toggle would leak across a same-pane conversation switch, since PaneContainer keys the view by paneId only and `startNewConversation` clears the snapshot without remounting)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (rolled-back describe block ~2596-2707)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (rollback dispatch describe ~7507-7546; plus one NEW codex test)
- No changes to `src/lib/fresh-agent-rollback.ts` (pinned copy stays verbatim).

**Interfaces:**
- Consumes: Task 1's per-turn `restorable?: boolean | undefined` on `FreshAgentTurn` (absent ⇒ historical); the pane's current session id (`FreshAgentView` already holds it on the snapshot — `snapshot?.sessionId`).
- Produces (pinned presentation contract consumed by Task 3's e2e):
  - Region: the existing `<section aria-label="Rolled back turns">` renders whenever the bucket is non-empty, in BOTH presentations.
  - Expanded group (restorable rows): header copy `Rolled back ({restorableUserSteps}) — gone from the conversation; redo to restore.`; row markup unchanged (`div.flex.items-start` class, "rolled back" badge, summary text); per-row redo button gate unchanged (`canRedo && onRedoToTurn && role === 'user' && redoableTurnIdSet?.has(...)`).
  - Historical group: a semantic `<button type="button">` disclosure line — visible text `Rolled back ({historicalUserSteps}) — kept in history`, `aria-expanded={historyExpanded}`, `aria-label="Toggle rolled-back history"`, `ChevronRight` rotating 90° when expanded (repo disclosure idiom, `FreshAgentItemCard.tsx:64-114`); expanded body reveals the historical rows with the same row markup and NO redo button. Default collapsed; NON-dismissible; conversation-scoped — the toggle state resets to collapsed whenever the pane's session id changes (a new conversation in the same pane, or a session restore, starts collapsed; within one conversation the user's expansion persists).
  - Counts are user-role step counts per group; the all-time union count is NEVER rendered.

- [ ] **Step 1: Write the failing tests**

Rework and extend `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (rolled-back describe ~2596-2707; the shared `markerTurns()` fixture at ~2599-2607 builds rows u2/a2/u3/a3 with `rolledBack: true` and NO `restorable`):

1. `renders nothing when rolledBackTurns is empty` (~2609): unchanged.
2. Rework `renders the marker rows with the USER-STEP count label` (~2621): stamp ALL four fixture rows `restorable: true`. Assert: region found; header text exactly `Rolled back (2) — gone from the conversation; redo to restore.`; all four row texts visible in the expanded list; NO `Toggle rolled-back history` button (no historical rows).
3. NEW `collapses non-restorable markers behind the history line with the historical step count`: fixture rows WITHOUT `restorable` (older-server shape). Assert: region found; the disclosure button (name `Toggle rolled-back history`) is visible with `aria-expanded: false` and text `Rolled back (2) — kept in history`; the four row texts are NOT visible; clicking the toggle sets `aria-expanded: true` and reveals the row texts; NO `Redo to here` buttons anywhere.
4. Rework `per-row Redo to here fires onRedoToTurn only on redoable user rows when canRedo` (~2635): stamp the fixture rows `restorable: true`, keep `canRedo` + `redoableTurnIds={['u2','u3']}`. The existing assertions survive verbatim (exactly 2 buttons; clicks fire `onRedoToTurn('u2'/'u3')`).
5. Rework `frozen prior-epoch markers ... expose NO Redo to here` (~2656): fixture = frozen u2/a2 (NO `restorable`) + current u3/a3 (`restorable: true`), `canRedo`, `redoableTurnIds={['u3']}`. Assert: expanded header text `Rolled back (1) — gone from the conversation; redo to restore.`; exactly 1 `Redo to here` button (on u3's row); the disclosure line text `Rolled back (1) — kept in history`; the frozen rows' texts are NOT visible until the toggle is clicked, then visible with NO redo buttons; the union count `Rolled back (2)` appears NOWHERE.
6. Rework `legacy harmlessness: an absent redoableTurnIds ... exposes NO per-marker redo` (~2679): fixture WITHOUT `restorable`, `canRedo`, no `redoableTurnIds`. Assert: the collapsed history line renders (older-server shape ⇒ all historical); zero `Redo to here` buttons; expand reveals the rows.
7. Rework `exposes no Redo to here affordance when canRedo is false` (~2693): fixture rows with `restorable: false` (the realistic server shape when redo is destroyed), `canRedo={false}`. Assert: collapsed history line; zero buttons; expand reveals rows.

Rework and extend `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

8. Rework `the view passes the snapshot redoableTurnIds through to the marker section (frozen markers hidden, current-epoch marker enabled)` (~7507-7529): in the `rollbackCapableSnapshot` fixture, stamp ONLY the current-epoch marker row (u9, `current marker`) `restorable: true`, leave the frozen u8/a8 rows unstamped. Replace the `screen.getByText('frozen marker')` visibility wait with a wait on `'current marker'` visible. Assert: exactly 1 `Redo to here` button in the row containing `'current marker'`; the disclosure line `Rolled back (1) — kept in history` is present; clicking it reveals `'frozen marker'` with no button.
9. Rework `legacy: a rollback block WITHOUT redoableTurnIds offers no per-marker redo` (~7531-7546): no `restorable` anywhere in the fixture. Re-target the `'rolled prompt'` wait: the collapsed history line renders; after expanding it, `'rolled prompt'` is visible; zero `Redo to here` buttons; region still present.
10. NEW `a freshcodex pane renders its markers collapsed from birth (undo-only provider)`: a codex snapshot with `capabilities: { undo: true, redo: false }`, `rollback: { canRedo: false, undoneDepth: 1 }`, and one marker row stamped `restorable: false` (the server's codex shape from Task 1). Assert: the collapsed history line renders with `Rolled back (1) — kept in history`; zero `Redo to here` buttons; expanding reveals the row. (Model the harness on the existing freshcodex view test at ~7779-7813.)
11. NEW `the disclosure toggle resets when the pane switches conversations (same component, new session)`: render the transcript with `sessionId='ses-a'` and historical markers; expand the disclosure (rows visible). Re-render with `sessionId='ses-b'` and different historical markers (same component instance — no unmount). Assert: the disclosure is collapsed again (`aria-expanded: false`, rows hidden); toggling works per conversation. This is the leak regression pin — PaneContainer keys the view by `paneId` only and `startNewConversation` swaps the snapshot without remounting the transcript.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: FAIL in the driving cases (2, 3, 5, 6, 7) — case 2 fails because its exact header-text assertion pins the NEW copy (`…; redo to restore.`) against today's `…; kept in history.` header (FreshAgentTranscript.tsx:1156); cases 3 and 5 find no `Toggle rolled-back history` button (and case 5 finds the frozen rows already visible); cases 6-7 find no collapsed line. Case 4 remains green pre-change BY DESIGN (it asserts only the two redo buttons and their clicks, which today's rendering already satisfies for restorable rows) — it is the restorable-side regression guard and must stay green through the change.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: FAIL — the reworked/re-targeted assertions fail for the same reason (e.g. the collapsed-line waits never resolve because current code renders rows expanded).

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

(a) Add the optional prop `sessionId?: string` to `FreshAgentTranscriptProps` (the conversation identity the disclosure state scopes to), and beside the existing local states (~946-949) add the conversation-scoped toggle:

```tsx
  // Rolled-back section lifecycle: historical (non-restorable) markers render
  // behind a quiet disclosure line. The toggle is ephemeral view state SCOPED
  // TO THE CONVERSATION — a different sessionId (a new conversation started
  // in the same pane, or a session restore) re-collapses it, so the
  // disclosure never leaks across conversations. Pure derivation, no effect,
  // no timer; placement itself is a pure function of the snapshot.
  const [historyToggle, setHistoryToggle] = useState<{ sessionId: string | null; expanded: boolean }>({ sessionId: null, expanded: false })
  const historyExpanded = historyToggle.sessionId === (sessionId ?? null) ? historyToggle.expanded : false
  const toggleHistory = () => setHistoryToggle({ sessionId: sessionId ?? null, expanded: !historyExpanded })
```

In `src/components/fresh-agent/FreshAgentView.tsx` (~2945), pass the conversation identity through — the ONE-LINE view change this task makes:

```tsx
              sessionId={snapshot?.sessionId}
```

(b) After the `redoableTurnIdSet` memo (~951-955) add the split and counts:

```tsx
  // Restorable markers (server-stamped flag) keep the expanded section with
  // redo affordances; everything else — redo destroyed by a submission, frozen
  // prior chains, codex from birth, older servers without the flag — renders
  // behind the collapsed history line. Counts are USER-role steps per group;
  // the all-time union is never presented as live state.
  const restorableMarkers = rolledBackTurns.filter((t) => t.restorable === true)
  const historicalMarkers = rolledBackTurns.filter((t) => t.restorable !== true)
  const restorableSteps = restorableMarkers.filter((t) => t.role === 'user').length
  const historicalSteps = historicalMarkers.filter((t) => t.role === 'user').length
```

(c) Replace the section render (~1153-1182) with the split presentation. Keep the section wrapper and row markup byte-compatible (the e2e locates rows via `div.flex.items-start`); share the row markup through a local render helper:

```tsx
        {rolledBackTurns.length > 0 ? (
          <section aria-label="Rolled back turns" className="mx-2 mt-2 rounded-md border border-dashed border-border/60 bg-muted/30 p-2 opacity-80">
            {restorableMarkers.length > 0 ? (
              <>
                <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                  Rolled back ({restorableSteps}) — gone from the conversation; redo to restore.
                </p>
                {restorableMarkers.map((turn, index) => renderMarkerRow(turn, index, true))}
              </>
            ) : null}
            {historicalMarkers.length > 0 ? (
              <div>
                <button
                  type="button"
                  onClick={() => toggleHistory()}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50"
                  aria-expanded={historyExpanded}
                  aria-label="Toggle rolled-back history"
                >
                  <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', historyExpanded && 'rotate-90')} aria-hidden="true" />
                  Rolled back ({historicalSteps}) — kept in history
                </button>
                {historyExpanded
                  ? historicalMarkers.map((turn, index) => renderMarkerRow(turn, index, false))
                  : null}
              </div>
            ) : null}
          </section>
        ) : null}
```

where `renderMarkerRow` is a local function inside the component (defined just before the return) reproducing today's row markup exactly — same `key={\`${getFreshAgentDisplayTurnKey(turn)}:${index}\`}`, same `div.flex.items-start.justify-between.gap-2...` class, same badge + `turn.summary || turnPlainText(turn)` text — with the redo button branch gated on the `restorable` argument in addition to the unchanged existing gate:

```tsx
  const renderMarkerRow = (turn: FreshAgentTurn, index: number, restorable: boolean) => (
    <div key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`} className="flex items-start justify-between gap-2 rounded px-1 py-1">
      <div className="min-w-0">
        <span className="mr-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">rolled back</span>
        <span className="text-sm text-muted-foreground">{turn.summary || turnPlainText(turn)}</span>
      </div>
      {restorable && canRedo && onRedoToTurn && turn.role === 'user' && redoableTurnIdSet?.has(turn.turnId ?? turn.id) ? (
        <button
          type="button"
          onClick={() => onRedoToTurn(turn.turnId ?? turn.id)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Redo to here"
          title={`Restore this turn and the rolled-back turns before it (“${turn.summary.slice(0, 60)}”)`}
        >
          <Redo2 className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )
```

(If `cn` is not already imported in this file, add it from `'@/lib/utils'` — check the existing imports first. `ChevronRight` is already imported.)

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The row markup is shared via `renderMarkerRow` (no duplication). Verify the comment block at the old header (r2/r3 counting note ~1157-1160) still tells the truth for the restorable-side count or move it next to the split consts; remove any comment that now misstates the rendering rule.

- [ ] **Step 6: Run impacted-test verification + gates**

Impacted set: every unit suite that renders `FreshAgentTranscript`/`FreshAgentView` with a rollback surface, the shared contract suite (unchanged expectations), plus typecheck and the a11y lint (the new disclosure button).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/shared/fresh-agent-contract.test.ts test/unit/client/lib/fresh-agent-rollback.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS

Run: `npm run typecheck:client && npm run lint`

Expected: PASS (the new `<button>` carries `aria-expanded` + `aria-label`; eslint-plugin-jsx-a11y stays green)

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(fresh-agent): collapse non-restorable rolled-back markers behind a history disclosure"
```

### Task 3: E2E lifecycle coverage — state flips, mixed epochs, codex-from-birth, reload convergence

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` (tests at ~604, ~698, ~786, ~988; plus ONE new test)

**Interfaces:**
- Consumes: Task 2's pinned presentation contract — region `Rolled back turns` always present when the bucket is non-empty; disclosure button name `Toggle rolled-back history`; expanded header `Rolled back (N) — gone from the conversation; redo to restore.`; collapsed line `Rolled back (N) — kept in history`; `Redo to here` buttons only on restorable user rows.
- Produces: e2e coverage proving the lifecycle across the real Rust server + hermetic fakes: the undo→send flip (all markers collapse), the mixed-epoch split, codex collapsed-from-birth, the expand interaction, and reload convergence in a non-restorable state.

**TDD note (justified Red exception):** this task adds coverage for behavior whose Red/Green was proven at unit level in Task 2; the new e2e assertions cannot run against the pre-change client without a separate build, and the existing spec passes vacuously after Task 2 (the multi-epoch frozen-row locator matches nothing once frozen rows move behind the disclosure — `toHaveCount(0)` passes empty). The task therefore fixes a vacuous assertion and adds new coverage; record this exception in the implementer report.

- [ ] **Step 1: Extend test 1 — the undo→send flip collapses the UI (opencode lane)**

In `opencode: /undo step refills composer, /redo restores, a new submission destroys redo...` (~604), after the existing post-send REST asserts (~690-691: `canRedo === false`, bucket non-empty), add UI assertions:

```ts
      // Lifecycle: the send destroyed redo — every marker is historical now, so
      // the UI must show the single collapsed history line (2 user steps:
      // 'prompt one' + 'prompt two') with no redo affordances; expanding
      // reveals the frozen rows.
      const historyToggle = page.getByRole('button', { name: 'Toggle rolled-back history' })
      await expect(historyToggle).toBeVisible({ timeout: 15_000 })
      await expect(historyToggle).toHaveText(/Rolled back \(2\) — kept in history/)
      await expect(page.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)
      await historyToggle.click()
      await expect(page.getByText('prompt one', { exact: true })).toBeVisible()
      await expect(page.getByText('prompt two', { exact: true })).toBeVisible()
```

(`prompt one`/`prompt two` are this test's fixture texts — REST-pinned as the bucket's user summaries by the poll at ~670-677; `{ exact: true }` avoids substring collisions with the fake's assistant-row texts.)

- [ ] **Step 2: Rework test 2's mixed-epoch tail — no more vacuous frozen-row assert**

In `opencode: multi-epoch markers — frozen prior-epoch rows lose "Redo to here" while the current epoch keeps it (delta-r1 F6)` (~698), replace the mixed-epoch UI leg (~741-746: the `frozenRow`/`currentRow` locators + counts — the `frozenRow` count-0 assert passes vacuously once frozen rows move behind the disclosure) with role/text-disambiguated assertions. Reuse the `section()` helper the test already defines at ~717; BOTH surfaces read `Rolled back (1)` in this state, so never use a bare `getByText(/Rolled back \(1\)/)` here:

```ts
      // UI (lifecycle): the expanded section renders ONLY the current
      // (restorable) epoch — header counts restorable steps; the frozen
      // epoch-0 step lives behind the collapsed history line counting
      // historical steps. Both surfaces read "Rolled back (1)" here —
      // assert by exact text / role, never a bare text match.
      await expect(section().getByText('Rolled back (1) — gone from the conversation; redo to restore.')).toBeVisible({ timeout: 15_000 })
      const historyToggle = section().getByRole('button', { name: 'Toggle rolled-back history' })
      await expect(historyToggle).toBeVisible()
      await expect(historyToggle).toHaveText(/Rolled back \(1\) — kept in history/)
      const currentRow = section().locator('div.flex.items-start', { has: page.getByText('prompt three edited', { exact: true }) })
      await expect(currentRow.getByRole('button', { name: 'Redo to here' })).toHaveCount(1, { timeout: 15_000 })
      // The frozen row is NOT rendered until the disclosure opens.
      await expect(page.getByText('prompt three', { exact: true })).toHaveCount(0)
      await historyToggle.click()
      const frozenRow = section().locator('div.flex.items-start', { has: page.getByText('prompt three', { exact: true }) })
      await expect(frozenRow).toBeVisible()
      await expect(frozenRow.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)
      // The restorable epoch keeps exactly its one affordance overall.
      await expect(section().getByRole('button', { name: 'Redo to here' })).toHaveCount(1)
```

(The earlier epoch-0 leg of this test at ~713-718 — single `/undo`, `Redo to here` count 1 — stays valid: that state is pure-restorable so the section renders expanded. The REST deep-equals at ~643, ~1021, ~1042 also stay valid because `restorable` rides the TURN rows, never the `rollback` block — keep it that way.)

- [ ] **Step 3: Extend test 4 — codex collapsed from birth**

In `codex: undo-to-here reverts in place; /redo is refused with the codex copy` (~786), after the `/redo` refusal asserts (~815-819 and the recorded-turns check ~837-848), add — note the undo-to-here on the FIRST user turn reverts BOTH codex turns (the empty-prefix revert is legal on codex; `userRows` went 2→0 at ~803), so the collapsed line counts 2 historical steps:

```ts
      // Codex is undo-only — its markers are never restorable, so the section
      // renders as the collapsed history line from the moment of the undo.
      const undoneSnap = await snap()
      const undoneUserSummaries = ((undoneSnap.rolledBackTurns ?? []) as any[])
        .filter((t) => t.role === 'user')
        .map((t) => t.summary)
      expect(undoneUserSummaries).toHaveLength(2) // both turns reverted (empty-prefix)
      const historyToggle = page.getByRole('button', { name: 'Toggle rolled-back history' })
      await expect(historyToggle).toBeVisible({ timeout: 15_000 })
      await expect(historyToggle).toHaveText(/Rolled back \(2\) — kept in history/)
      await expect(page.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)
      await historyToggle.click()
      for (const summary of undoneUserSummaries) {
        await expect(page.getByText(summary, { exact: true })).toBeVisible()
      }
```

(Reading the summaries from the REST snapshot and asserting the UI rows match keeps the test robust to however the codex builder summarizes turns; the count assertion pins the collapsed-line count semantics.)

- [ ] **Step 4: Add ONE new test — non-restorable reload convergence**

Add a sibling test inside the describe (~599), placed after the multi-client convergence test (~1048). It uses only helpers the spec already imports/defines (`bootOpencodeLane`, `sendOpencodeTurn`, `waitForRollbackCapability`, `typeSlash`, `sendComposerText`, `waitForPaneStatus`, `fetchSnapshot`, `userRows`, `TestHarness`):

```ts
  test('opencode: non-restorable convergence — after a send destroys redo, the collapsed history line survives reload identically (lifecycle)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt one', 1, lane.auditLogPath)
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt two', 2, lane.auditLogPath)
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)

      await waitForRollbackCapability(page)
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(1)
      // Restorable state: the expanded section renders with its redo affordance.
      await expect(page.getByText('Rolled back (1) — gone from the conversation; redo to restore.')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: 'Redo to here' })).toHaveCount(1)

      // The send destroys redo — the marker becomes historical and the UI
      // collapses to the single history line.
      await sendComposerText(page, 'prompt three')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await expect.poll(async () => (await snap())?.rollback?.canRedo, { timeout: 15_000 }).toBe(false)
      const historyToggle = page.getByRole('button', { name: 'Toggle rolled-back history' })
      await expect(historyToggle).toBeVisible({ timeout: 15_000 })
      await expect(historyToggle).toHaveText(/Rolled back \(1\) — kept in history/)
      await expect(page.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)

      // Reload: the collapsed state re-derives identically from the durable
      // snapshot — pure presentation, no per-client dismissal state.
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const reloadedToggle = page.getByRole('button', { name: 'Toggle rolled-back history' })
      await expect(reloadedToggle).toBeVisible({ timeout: 15_000 })
      await expect(reloadedToggle).toHaveText(/Rolled back \(1\) — kept in history/)
      await expect(reloadedToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)
      await reloadedToggle.click()
      await expect(page.getByText('prompt two', { exact: true })).toBeVisible()
      const afterReload = await snap()
      expect(afterReload.rollback?.canRedo).toBe(false)
      expect(((afterReload.rolledBackTurns ?? []) as any[]).filter((t) => t.role === 'user')).toHaveLength(1)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

(The load-bearing assertion is that the collapsed state after `page.reload()` is identical to before it — same toggle, same count, `aria-expanded` back to `false` — proving the presentation is snapshot-derived, not session-local.)

- [ ] **Step 5: Run the whole spec locally**

First build the fresh Rust binary and client for the e2e (the RustServer helper boots `target/release/freshell-server`; build explicitly so a stale binary can't silently test old server code):

Run: `cargo build --release -p freshell-server`

Expected: PASS (fresh build with Task 1's changes)

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts`

Expected: PASS — all 9 tests (8 existing + 1 new), each within its 120s override. (First run pays the global-setup dist build + a COLD cargo release build in this worktree — no shared target dir — so allow up to ~45 min total wall; a long silent cargo build is normal, not a hang. Later runs are warm.)

Run: `npm run test:e2e:a11y-gate`

Expected: this command is WARN-mode and always exits 0 — the check is the REPORT, not the exit status. Read the report and confirm the task's NEW assertions add no NEW violations (every new locator is role/aria-based or exact-text). PRE-EXISTING findings are NOT this change's to fix: this spec's two `css-class` findings (the `div.flex.items-start` row locators — deliberately retained for row-selector stability) and the tree's pre-existing baseline-drift violations predate this plan. Do NOT rewrite the pinned row locators and do NOT ratchet the selector baseline.

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts
git commit -m "test(e2e): cover the rolled-back marker restorability lifecycle across all state flips"
```

(The commit deliberately PRECEDES the cloud run: cloud images are commit-addressed, and a dirty tree forces the always-rebuild `-dirty` image path — faithful but ~13 minutes slower and the runner output would not show the committed HEAD.)

- [ ] **Step 7: Verify the spec on the configured cloud backend**

Check coordination first: `npm run test:status` — if a foreign holder is active, wait for it rather than killing it.

Run: `FRESHELL_TEST_SUMMARY='the-usual: rollback-marker-lifecycle cloud e2e verification' npm run test:e2e:cloud -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts`

Expected: PASS on the cloud backend, from the tree at Step 6's commit — the runner output must show the committed HEAD (a `-dirty` image tag means the tree was not committed; stop and fix that, not the tests). Confirm from the output that all 9 tests ran (a filtered-to-nothing run is not coverage) and the spec is NOT in CLOUD_SKIP_SPECS. If the cloud run finds a failure, fix it, commit the fix, and re-run from the committed tree.

---

## Verification summary (whole plan)

1. `cargo test -p freshell-freshagent` — green (Task 1).
2. `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/shared/fresh-agent-contract.test.ts` — green (Tasks 1-2).
3. `npm run typecheck:client && npm run lint` — green (Tasks 1-2).
4. `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings` — green (Rust changes land in Task 1; gate runs there and at the end-of-execution gate).
5. `npm run contract:generate` produces NO diff in `port/contract/`, `crates/freshell-protocol/`, `shared/ws-protocol.ts` (Task 1 — the frozen WS surface is untouched by design).
6. `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` — all 9 tests green (Task 3).
7. `npm run test:e2e:cloud -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` — green on the configured cloud backend (Task 3).
8. End-of-execution full-suite gate — green at final HEAD, run with the coordinated-test procedure: first `npm run test:status` (wait on any foreign holder rather than killing it), then `FRESHELL_TEST_SUMMARY='the-usual: rollback-marker-lifecycle end-of-execution full-suite gate' npm test`. Record the gate entry (time, HEAD, exact command, result) in the execution progress ledger.

## Out-of-scope (explicitly not built)

- No HistoryView integration for archived markers (the collapsed in-pane disclosure is the accepted v1 surface).
- No per-chain/epoch grouping inside the expanded history body (flat rows in conversation order).
- No `docker/cloud-run/test-durations.txt` recalibration (advisory shard-balance tuning; the spec already runs on cloud with the default estimate).
- No changes to `undoDepth`/`undoneDepth` semantics, the WS rollback frames, the durable `RollbackRecord`, the undo/redo handlers, `src/lib/fresh-agent-rollback.ts` pinned copy, `server/`, or `docs/index.html`.
