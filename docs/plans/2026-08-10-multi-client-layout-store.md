# Multi-Client Layout Store Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

> **EXECUTION STATUS: TASKS 1–3 COMPLETE; TASKS 4–5 PENDING.** This plan
> is a retrospective artifact: Tasks 1–3 already exist at commit c22e5e0a6
> on branch fix/multi-client-layout-store (fork point 669219563),
> reconstructed from the executed work so the workflow's validation and
> review stages can run against a committed plan. Stage-2 load-bearing
> validation verified the commit, signatures, and tests are real, but
> falsified several claims: clippy/fmt are NOT currently clean, one by-id
> read surface was missed (`GET /api/layout/snapshot?tabId=`), and a
> silently-reconnecting client loses id resolvability under hard
> evict-on-disconnect. Tasks 4–5 (unchecked) close those gaps; validation
> notes inline below correct the falsified claims.

**Goal:** Fix the cross-client "pane not found" bug by making the Rust server's `LayoutStore` keep one layout snapshot per connected WS client (most-recent-first), so by-id agent-API operations (rename, select, split, close, swap, and explicit-tab layout reads) resolve pane/tab ids from EVERY connected client instead of only the last writer. (Validation note: capture/send-keys/wait-for never resolve through the `LayoutStore` — they use server-global pane→session maps (`terminal_panes`/`panes`/`pane_tabs`) and were never last-writer-scoped. Their pre-existing limitation — client-UI-minted panes are not addressable via those maps in the Rust port — is orthogonal to multi-client and out of scope here.)

**Architecture:** The Rust server mirrors client layouts via WS `ui.layout.sync` frames into a shared `LayoutStore` consumed by the REST/MCP agent API. Previously the store held ONE snapshot, wholesale-replaced last-writer-wins — but pane/tab ids are minted per client (`nanoid()` in the browser) or minted server-side by the agent API and broadcast to every client via `ui.command{tab.create}`, so the same id appearing in multiple snapshots always denotes the same logical entity (validated — this is what makes multi-hit mutation sound, and in the broadcast case required), while any non-last-writer client's locally-minted ids were unresolvable. The fix replaces the single snapshot with a `Vec<ClientEntry>` keyed by WS connection id: default reads answer from the primary (index 0, last writer) only; by-id reads search all snapshots primary-first; id-targeted mutations land in every snapshot containing the id; disconnect evicts that connection's snapshot (Task 5 refines hard eviction into stale-retention, because the validated client behavior shows clients do NOT re-send `ui.layout.sync` on a silent reconnect).

**Tech Stack:** Rust (workspace crates `freshell-freshagent`, `freshell-ws`), axum (REST router), tokio + tokio-tungstenite (WS), serde_json, `std::sync::{Arc, Mutex}` store interior.

## Global Constraints

- Rust server only — the Node server intentionally retains single-snapshot behavior; every touched Node-parity doc comment marks the intentional divergence.
- No changes to the TypeScript client, Node server, or shared protocol schemas.
- Single-client behavior must remain behaviorally identical to the existing Node-parity semantics (`server/agent-api/layout-store.ts` ports, per the repo's Node-parity equivalence standard), including the `"no layout snapshot"` / `"pane not found"` / `"tab not found"` messages. Known accepted edges: on a virgin (zero-client) store, `select_tab`/`split_pane` no longer materialize an empty snapshot, so a following by-id miss reports `"no layout snapshot"` where the old port said `"pane not found"`; JS numeric-grammar corners in index targets (e.g. `Number("0x2")`) are excepted, consistent with the repo's equivalence reports.
- Never touch the live self-hosted server on port 3001; no deploy/restart from this workflow.
- No push and no PR from this workflow — local commits only, on the worktree branch.
- Red-Green-Refactor TDD: every new test is watched RED against the old single-snapshot store before implementation.
- `cargo test --workspace`, `cargo clippy`, and `cargo fmt --check` must be green at completion. (Known environment flake, branch-orthogonal — validated: two pre-existing `freshell-server` bin tests, `net_bind::…inflight_connection_survives_rebind…` and `network::…concurrent_configure_and_disable…`, race under parallel execution on WSL2 (in-source note at `crates/freshell-server/src/network.rs:2405-2411`); they pass isolated / with `--test-threads=1` / on rerun. Do not chase them; verify workspace green modulo that pair.)

---

## Task 1: Layout store core — per-client snapshots

**Files:**
- Modify: `crates/freshell-freshagent/src/layout_store.rs`
- Test: `crates/freshell-freshagent/src/layout_store_tests.rs` (included via `#[path = "layout_store_tests.rs"] mod tests;` at `layout_store.rs:1181`)

**Interfaces:**
- Consumes: `freshell_protocol::UiLayoutSync` (WS layout frame), existing `UiSnapshot` / `TabRow` / `PaneNode` internals, existing helpers `find_pane_tab`, `single_pane_id`, `set_sticky_title`, `leaves_of`.
- Produces (exact signatures from the committed code):
  - `struct ClientEntry { key: String, snapshot: UiSnapshot }` — one connected client's mirrored snapshot.
  - `struct LayoutInner { clients: Vec<ClientEntry> }` — most-recent-first; index 0 is the PRIMARY (last writer). Replaces the old single-snapshot inner.
  - `const SERVER_CLIENT_KEY: &str = "__server__";` — bootstrap entry for server-side `create_tab` on an empty store; superseded (evicted) by the first real client sync.
  - `pub fn update_from_ui(&self, sync: &freshell_protocol::UiLayoutSync, source_connection_id: &str)` — REPLACES this client's snapshot and makes it the primary.
  - `pub fn remove_client(&self, client_key: &str)` — drops that client's snapshot; primary falls back to the most recently synced remaining client.
  - `pub fn pane_is_sole_in_tab(&self, pane_id: &str) -> bool` — the `tabRenamed` check, answered from the snapshot where the pane actually resolves.
  - `pub(crate) fn snapshots_clone(&self) -> Vec<UiSnapshot>` — clones of every snapshot, primary first, for read-only walkers (target resolver).
  - Reworked reads: `pub fn list_tabs(&self) -> (Vec<Value>, Option<String>)` (primary-only), `pub fn list_panes(&self, tab_id: Option<&str>) -> Result<Vec<PaneRow>, &'static str>` (default tab primary-only; explicit tab id searches all snapshots), `pub fn get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot>`, `pub fn has_tab(&self, target: &str) -> bool`, `pub fn get_single_pane_id(&self, tab_id: &str) -> Option<String>` (all-snapshot, primary-first).
  - Reworked mutations (`rename_pane`, `rename_tab`, `close_tab`, `select_tab`, `select_pane`, `swap_pane`, `split_pane`, `attach_pane_content`, `close_pane`, `resize_split`): apply to EVERY snapshot containing the id; outcome reports the first (most-recent) match. E.g. `pub fn rename_pane(&self, pane_id: &str, title: &str) -> RenameOutcome`.
  - `"no layout snapshot"` is returned only when `clients` is empty (Node parity).

**Steps:**

- [x] Write failing store-level tests in `layout_store_tests.rs` (multi-client section, with a `client_sync(tab_id, tab_title, pane_id, ts)` helper building one-tab/one-pane syncs per simulated client):
  - `rename_pane_resolves_ids_from_any_client_snapshot` — THE reported bug. Key assertion:
    ```rust
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b"); // last writer
    let out = store.rename_pane("pA", "Renamed A");
    assert_eq!(out.message, None, "pane from a non-primary client snapshot must resolve");
    ```
    plus `list_tabs()` stays primary-only (`rows[0]["id"] == json!("tB")`).
  - `by_id_reads_and_mutations_resolve_across_clients` — `get_pane_snapshot("pA")`, `list_panes(Some("tA"))`, `has_tab("tA")`/`has_tab("Desktop")`, `resolve_target(&store, "pA")`, then `split_pane`/`close_pane`/`select_pane`/`rename_tab` all resolve conn-a ids while conn-b is primary.
  - `rename_pane_updates_every_client_snapshot_containing_the_id` — two same-origin windows sync the same ids; after `rename_pane("p1", "Both")` and `remove_client("conn-b")` (the primary), `get_normalized_snapshot(None)["paneTitles"]["t1"]["p1"] == json!("Both")` — multi-hit mutation survives primary eviction.
  - `remove_client_evicts_and_primary_falls_back_to_most_recent_remaining` — after `remove_client("conn-b")`, `list_tabs()` answers from conn-a; `rename_pane("pB", "X").message == Some("pane not found")`; evicting the last client yields `Some("no layout snapshot")`.
  - `sole_pane_check_uses_the_snapshot_where_the_pane_resolves` — same tab id `T` is a two-pane split in conn-a but single-pane in conn-b (primary); `pane_is_sole_in_tab("pB")` is true, `pane_is_sole_in_tab("p1")` is false.
  - `update_from_ui_still_replaces_the_same_clients_snapshot` — single-client parity guard: a re-sync from the same `conn-a` replaces its own snapshot (`rename_pane("p1", "X").message == Some("pane not found")` for the superseded ids).
- [x] Run to verify RED against the old single-snapshot store: `cargo test -p freshell-freshagent --lib layout_store::tests::rename_pane_resolves_ids_from_any_client_snapshot` — observed failure: `out.message` was `Some("pane not found")` (conn-b's sync had wholesale-replaced the store). Validation note (Stage 2, corrected): of the other five, the tests exercising `remove_client`/`pane_is_sole_in_tab` discriminate via COMPILE failure against the fork-point store (those APIs did not exist yet), `update_from_ui_still_replaces_the_same_clients_snapshot` is a single-client parity guard rather than a behavioral RED, and the rest failed behaviorally (pA unresolvable via conn-a; title lost after primary eviction; sole-pane answered from the wrong snapshot).
- [x] Implement: replace the single-snapshot `LayoutInner` with `clients: Vec<ClientEntry>` plus accessors `primary()`, `primary_mut()`, `snapshots()`, `snapshots_mut()`, and `ensure_primary()` (server bootstrap via `SERVER_CLIENT_KEY`). Rework `update_from_ui` to replace only `source_connection_id`'s entry and move it to index 0 (evicting the `__server__` bootstrap entry on the first real sync). Convert by-id reads to primary-first all-snapshot search and mutations to multi-hit application, e.g. `rename_pane`:
    ```rust
    let mut first: Option<String> = None;
    for snapshot in inner.snapshots_mut() {
        let Some(tab_id) = find_pane_tab(snapshot, pane_id) else { continue };
        set_sticky_title(snapshot, &tab_id, pane_id, title);
        ...
        first.get_or_insert(tab_id);
    }
    ```
    Add `remove_client` (`clients.retain(|entry| entry.key != client_key)`), `pane_is_sole_in_tab` (`leaves_of(snapshot, &tab_id).len() == 1` in the resolving snapshot), and `snapshots_clone`. Update the `LayoutInner` doc comment to document the intentional divergence from Node's single-snapshot store (`server/agent-api/layout-store.ts` — single-snapshot field at `:49`, wholesale-replace `updateFromUi` at `:169-181`; the committed comment's `layout-store.ts:44-46` anchor mis-points at `emptySnapshot()` — Task 4 corrects it).
- [x] Run to verify GREEN: `cargo test -p freshell-freshagent --lib layout_store` — all `layout_store::tests` pass (`test result: ok`), including the pre-existing single-client suite unchanged.
- [x] Commit — landed as part of the single atomic commit `c22e5e0a6` ("fix(rust-server): multi-client layout store resolves pane ids from every client"). All three tasks were implemented and committed together, not as separate commits; this step records that honestly rather than inventing per-task SHAs.

---

## Task 2: WS ingestion keyed by connection id + disconnect eviction

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (sync ingestion + disconnect teardown)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState.layout` doc comment — intentional-divergence note)
- Test: `crates/freshell-ws/tests/ui_layout_sync.rs`

**Interfaces:**
- Consumes: `freshell_freshagent::layout_store::LayoutStore` (Task 1's `update_from_ui` / `remove_client` / read surface), the WS serve loop's per-connection `conn_id`, `ClientMessage::UiLayoutSync(sync)`.
- Produces: connection-keyed ingestion and eviction inside the existing socket lifecycle:
  - `handle_client_text`'s `ClientMessage::UiLayoutSync` arm: `state.layout.update_from_ui(&sync, &conn_id.to_string());` (no reply frame — Node sends none).
  - `run()`'s disconnect teardown: `state.layout.remove_client(&conn_id.to_string());` alongside the existing `registry.remove_connection(conn_id)`.
  - Known accepted limitation: teardown runs on every non-panic termination path (all `select!` arms exit via `break` to it); a panic inside the WS task skips teardown entirely — a pre-existing pattern that equally skips `registry.remove_connection` and session-lease release. Accepted for this change; recommended follow-up (out of scope): one RAII drop guard covering all teardown steps.

**Steps:**

- [x] Write the failing integration test `two_client_syncs_coexist_rest_resolves_non_primary_ids_and_disconnect_evicts` in `crates/freshell-ws/tests/ui_layout_sync.rs`: two REAL `/ws` connections (harness convention from `session_identity_frames.rs`; `ping`/`pong` on the same connection as the ordering barrier) sync different layouts (conn-1: tab `t1`/pane `p1`; conn-2, last writer: tab `t2`/pane `p2`); a real REST `PATCH /api/panes/p1` against a router sharing the SAME `LayoutStore` must succeed. Key assertions:
    ```rust
    assert_eq!(resp.status(), 200);
    assert_eq!(body["data"]["paneId"], serde_json::json!("p1"));
    ...
    assert_eq!(tabs.len(), 1, "list_tabs reads the primary snapshot only");
    assert_eq!(tabs[0]["id"], serde_json::json!("t2"));
    ...
    assert!(evicted, "disconnect must evict the closed client's snapshot");
    ```
    After conn-1 closes, `p1` no longer resolves while `layout.get_pane_snapshot("p2").is_some()` still holds.
- [x] Run to verify RED: `cargo test -p freshell-ws --test ui_layout_sync two_client_syncs_coexist_rest_resolves_non_primary_ids_and_disconnect_evicts` — observed failure: REST returned 200 with body `{"message":"pane not found"}` (conn-2's sync had replaced the shared snapshot, so `p1` was unresolvable).
- [x] Implement: pass `&conn_id.to_string()` as `update_from_ui`'s `source_connection_id` in the `UiLayoutSync` arm (the port of Node's `this.layoutStore.updateFromUi(m, ws.connectionId || 'unknown')` — validated at `server/ws-handler.ts:2026`, arm `:2024-2039`, no reply frame confirmed; the previously cited `:1966-1969` is the `hello` arm); add `state.layout.remove_client(&conn_id.to_string())` to `run()`'s disconnect teardown; update the `ui.layout.sync` arm comment, the disconnect comment, and `WsState.layout`'s doc in `lib.rs` to state the intentional multi-client divergence from Node's single last-writer-wins snapshot. Update the pre-existing `ui_layout_sync_frame_populates_the_shared_layout_store` test's doc to the per-connection wording.
- [x] Run to verify GREEN: `cargo test -p freshell-ws --test ui_layout_sync` — both tests pass (`test result: ok`).
- [x] Commit — landed in the same atomic commit `c22e5e0a6` (see Task 1's commit step; the three tasks shipped as one commit).

---

## Task 3: REST handler integration — tabRenamed, rename cascade, target resolver

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (the `rename_pane` REST handler for `PATCH /api/panes/:id`)
- Modify: `crates/freshell-freshagent/src/target_resolver.rs`
- Test: `crates/freshell-freshagent/src/rename_cascade_tests.rs` (included via `#[path = "rename_cascade_tests.rs"] mod rename_cascade_tests;` at `lib.rs:3254`)

**Interfaces:**
- Consumes: Task 1's `LayoutStore::{rename_pane, pane_is_sole_in_tab, get_pane_snapshot, snapshots_clone}`.
- Produces (exact signatures from the committed code):
  - `pub fn resolve_target(store: &LayoutStore, raw: &str) -> ResolvedTarget` — now iterates `store.snapshots_clone()`; empty store short-circuits to `ResolvedTarget::NotFound("no layout snapshot")`; a primary miss's message is preserved via `miss.get_or_insert(...)`.
  - `fn resolve_in_snapshot(snapshot: &UiSnapshot, raw: &str) -> ResolvedTarget` — the full Node resolution ladder (pane id → tab by id OR title in one combined pass over tabs in order, duplicate titles first-wins → `tab.pane` index form → bare index → pane title, 2+ matches → Ambiguous) extracted to run against ONE client snapshot; the ladder runs per snapshot, primary first, behaviorally identical to Node with one client connected (per the repo's equivalence standard; JS numeric-grammar corners like `Number("0x2")` excepted).
  - REST `rename_pane` handler: `tabRenamed` computed as `let tab_renamed = state.layout.pane_is_sole_in_tab(&pane_id);` (replacing the old `list_panes(Some(&tab_id)).map(|rows| rows.len() == 1)` read, which would answer from the wrong snapshot when another client has a same-id tab of different shape); the rename cascade (`rename_persistence::persist_syncable_terminal_rename`) receives the pane snapshot from `get_pane_snapshot`, which uses the same primary-first search as the rename. Validation note: the handler takes three separate store locks (with an await between), so a concurrently interleaved `ui.layout.sync` can reorder the store between calls — verified benign (worst case: a mislabeled `tabRenamed` flag in one response; no in-repo consumer reads it).

**Steps:**

- [x] Write the failing handler test `rename_from_non_primary_client_succeeds_and_tab_renamed_uses_that_snapshot` in `rename_cascade_tests.rs` (adding a `seed_layout_as(state, payload, conn_id)` variant of the existing `seed_layout` helper): conn-a syncs tab `t1` as a SINGLE-pane tab holding `p1`; conn-b (primary) syncs the SAME tab id `t1` with TWO panes `b1`/`b2`. Key assertions:
    ```rust
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Cross Client").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabRenamed"], json!(true),
        "tabRenamed must come from conn-a's snapshot (single-pane t1), not \
         the primary's two-pane t1: {body}");
    ```
    plus the primary's `b1` rename returns `tabRenamed == json!(false)`, and both renames broadcast `ui.command{pane.rename}`.
- [x] Run to verify RED: `cargo test -p freshell-freshagent --lib rename_cascade_tests::rename_from_non_primary_client_succeeds_and_tab_renamed_uses_that_snapshot` — observed failure: 200 with the Node-parity miss body `{"status":"ok","data":{"message":"pane not found"},"message":"pane not found"}` (no `tabId`/`paneId`/`tabRenamed` fields), because `p1` existed only in the non-last-writer's snapshot.
- [x] Implement: in `lib.rs`'s `rename_pane` handler, replace the `list_panes`-based `tabRenamed` computation with `state.layout.pane_is_sole_in_tab(&pane_id)` and update the handler's step-5 doc comment (multi-client note). In `target_resolver.rs`, split the ladder into `resolve_in_snapshot` and make `resolve_target` iterate `store.snapshots_clone()` primary-first, preserving the primary's miss message (`miss.expect("at least one snapshot was checked")` when nothing resolves). `by_id_reads_and_mutations_resolve_across_clients` (Task 1) covers the resolver's cross-client behavior via `resolve_target(&store, "pA")`.
- [x] Run to verify GREEN: `cargo test -p freshell-freshagent --lib` — full crate lib suite passes, 420/420 (`test result: ok. 420 passed; 0 failed`).
- [x] Final verification as originally run: `cargo test --workspace` green (including `freshell-ws` integration tests 2/2). **Stage-2 validation correction (claim falsified at HEAD):** `cargo clippy` shows 2 warnings (`layout_store.rs:414` doc-lazy-continuation — the same lint class main fixed in e6e958406; `target_resolver.rs:159` needless borrow) and `cargo fmt --check` shows 3 diffs (`layout_store_tests.rs:699/:765`, `ui_layout_sync.rs:319`). Re-verified green: lib suite 420/420, ui_layout_sync 2/2, workspace green modulo the two known-flaky pre-existing `freshell-server` bin tests (see Global Constraints). The clippy/fmt gates are closed by Task 4.
- [x] Commit — landed in the same atomic commit `c22e5e0a6` on `fix/multi-client-layout-store` (8 files, +906/−269). No push, no PR (per repo rules and Global Constraints).

---

## Task 4: Restore the quality gate (clippy + fmt) — REMAINING

**Files:**
- Modify: `crates/freshell-freshagent/src/layout_store.rs` (doc-comment lint + stale Node line refs)
- Modify: `crates/freshell-freshagent/src/target_resolver.rs` (needless borrow)
- Modify: `crates/freshell-freshagent/src/layout_store_tests.rs`, `crates/freshell-ws/tests/ui_layout_sync.rs` (rustfmt rewraps)

**Context:** Load-bearing validation re-ran the gates at HEAD: the behavioral suite is fully green (`freshell-freshagent --lib` 420/420; `ui_layout_sync` 2/2; `cargo test --workspace` 3006 passed / 0 failed), but the repo-standard quality gate is RED — `cargo clippy --workspace --all-targets -- -D warnings` exits 101 (`clippy::doc_lazy_continuation` at `layout_store.rs:414`; `clippy::needless_borrow` at `target_resolver.rs:159`) and `cargo fmt --all --check` exits 1 (3 rewraps: `layout_store_tests.rs:699`, `:765`; `ui_layout_sync.rs:319`). All findings are in files added/touched by this branch. Evidence: `.the-usual-logs/multi-client-layout-store/reports/V3.md` (+ logs).

**Steps:**

- [ ] Fix `clippy::doc_lazy_continuation` at `crates/freshell-freshagent/src/layout_store.rs:414` (indent the doc-comment list continuation).
- [ ] Fix `clippy::needless_borrow` at `crates/freshell-freshagent/src/target_resolver.rs:159` (`&snapshot` → `snapshot`).
- [ ] While in `layout_store.rs`, correct the stale Node-parity citation in the `LayoutInner` divergence doc comment: `layout-store.ts:44-46` → `server/agent-api/layout-store.ts:48-50` (`updateFromUi` at `:169-181`); likewise correct any `ws-handler.ts:1966-1969` doc references in `crates/freshell-ws` (if present) to `server/ws-handler.ts:2024-2027`.
- [ ] Run `cargo fmt --all` (expected effect: the 3 rewraps above plus any fallout from the edits; no semantic changes).
- [ ] Run to verify GREEN: `cargo clippy --workspace --all-targets -- -D warnings` (exit 0), `cargo fmt --all --check` (exit 0), `cargo test -p freshell-freshagent --lib` (420 passed), `cargo test -p freshell-ws --test ui_layout_sync` (2 passed).
- [ ] Commit (focused, atomic, e.g. `fix(rust-server): restore clippy/fmt gate for multi-client layout store`). No push, no PR (per repo rules and Global Constraints).

---

## Task 4: Close the remaining by-id read gap + gate hygiene (added by Stage-2 load-bearing validation)

**Files:**
- Modify: `crates/freshell-freshagent/src/layout_store.rs` (`get_normalized_snapshot` at `:279`, divergence doc-comment anchor at `:70`, clippy doc-lazy-continuation at `:414`)
- Modify: `crates/freshell-freshagent/src/target_resolver.rs` (clippy needless borrow at `:159`)
- Format only: `crates/freshell-freshagent/src/layout_store_tests.rs`, `crates/freshell-ws/tests/ui_layout_sync.rs` (`cargo fmt`)
- Test: `crates/freshell-freshagent/src/layout_store_tests.rs`

**Why:** Validation falsified the completeness claim narrowly: `GET /api/layout/snapshot?tabId=` (`get_normalized_snapshot(Some(tab_id))`) still answers from the PRIMARY snapshot only — the one remaining by-id agent-API read where a non-last-writer client's tab id is unresolvable. Also: the clippy/fmt gates are currently red, and the committed divergence comment cites the wrong Node anchor.

**Steps:**

- [ ] Write the failing test `normalized_snapshot_with_explicit_tab_id_resolves_from_any_client_snapshot` in `layout_store_tests.rs` (reuse the `client_sync` helper): conn-a syncs tab `tA`/pane `pA`; conn-b (primary, last writer) syncs `tB`/`pB`. Assert `get_normalized_snapshot(Some("tA"))` returns conn-a's tab content, and `get_normalized_snapshot(None)` stays primary-only (answers from `tB`).
- [ ] Run to verify RED: `cargo test -p freshell-freshagent --lib layout_store` — the explicit-tab assertion fails against the primary-only read.
- [ ] Implement: make `get_normalized_snapshot(Some(tab_id))` search all snapshots primary-first (same pattern as explicit-tab `list_panes`); the default `None` path stays primary-only. Update the method's doc comment with the multi-client note.
- [ ] Fix the divergence doc-comment anchor at `layout_store.rs:70`: cite `server/agent-api/layout-store.ts` (single-snapshot field `:49`, wholesale-replace `updateFromUi` `:169-181`) instead of `layout-store.ts:44-46`.
- [ ] Fix clippy: doc-lazy-continuation at `layout_store.rs:414`; needless borrow at `target_resolver.rs:159`. Run `cargo fmt` (3 known diffs in the two test files above).
- [ ] Run to verify GREEN: `cargo test -p freshell-freshagent --lib` all pass; `cargo clippy` clean; `cargo fmt --check` clean.
- [ ] Commit (focused, atomic; no push, no PR).

---

## Task 5: Reconnect-window resilience — stale-snapshot retention (added by Stage-2 load-bearing validation)

**Files:**
- Modify: `crates/freshell-freshagent/src/layout_store.rs` (`ClientEntry` staleness, `remove_client`, `update_from_ui`, primary selection)
- Test: `crates/freshell-freshagent/src/layout_store_tests.rs` (new tests + assertion updates to the Task 1 eviction tests)
- Modify (assertion update only): `crates/freshell-ws/tests/ui_layout_sync.rs` (disconnect expectations)

**Why (validated, falsified assumption):** The unmodified TS client's ONLY `ui.layout.sync` sender is `layoutMirrorMiddleware.ts` — change-gated (`if (serialized === lastPayload) return`) and debounced, with `lastPayload` never reset on reconnect; neither server requests a sync on hello. So after a silent WS reconnect (new conn-id, unchanged layout), hard evict-on-disconnect leaves that client's ids unresolvable for an UNBOUNDED window (until the next layout change or a page reload) — transiently re-opening the reported bug for exactly the multi-device users it targets (mobile background/sleep, keepalive drops). Client/protocol changes are out of bounds (Global Constraints), so the mitigation is server-side retention. Retention also restores Node's post-disconnect utility (Node retains its snapshot forever; validation flagged hard-evict as a regression for agent workflows that run after the last UI client closes).

**Design (server-only):**
- `ClientEntry` gains `stale: bool` (false on every live sync).
- `remove_client(key)` marks the entry stale instead of dropping it.
- A stale entry is never primary while any live entry exists; if ONLY stale entries remain, the most recent one still answers default reads (Node-parity post-disconnect behavior). `"no layout snapshot"` only when the store is truly empty.
- Supersede-eviction: when `update_from_ui` applies a live sync, drop any STALE entry whose snapshot shares at least one pane id with the incoming sync (the validated same-id-same-entity invariant makes overlap ⇒ same client/layout sound — this is how a reconnected client's old entry is replaced by its new conn-id entry).
- Cap stale entries at 4 (drop oldest beyond the cap) as a growth safety valve.
- By-id reads and mutations treat stale entries exactly like live ones (that is the point).

**Steps:**

- [ ] Write failing tests in `layout_store_tests.rs`:
  - `disconnected_clients_ids_stay_resolvable_until_superseded` — conn-a syncs `tA`/`pA`; `remove_client("conn-a")`; `rename_pane("pA", "X").message == None` (still resolves); then a live sync containing `pA` under a NEW conn id evicts the stale entry (exactly one entry containing `pA` remains).
  - `stale_entry_never_primary_while_live_clients_exist` — a live client wins `list_tabs()` even if the stale entry synced later; with only stale entries left, the most recent stale answers default reads.
  - `stale_cap_bounds_growth` — 5 disconnected distinct clients → oldest dropped, 4 retained.
- [ ] Run to verify RED against the current hard-evict store.
- [ ] Implement per the design. Update existing end-state assertions to retention semantics: `remove_client_evicts_and_primary_falls_back_to_most_recent_remaining` (primary falls back to the most recent LIVE entry; a fully-stale store still answers; `"no layout snapshot"` only for a truly empty store) and the `ui_layout_sync.rs` disconnect assertions (`p1` remains resolvable after conn-1 closes, until superseded).
- [ ] Run to verify GREEN: `cargo test -p freshell-freshagent --lib`, `cargo test -p freshell-ws --test ui_layout_sync`, `cargo clippy`, `cargo fmt --check`.
- [ ] Commit (focused, atomic; no push, no PR).

---

## Validated residual caveats (documented and accepted by Stage-2 load-bearing validation)

- **Resolver precedence shadowing (accepted):** the full resolution ladder runs per snapshot primary-first, so a fuzzy match in the primary (an exact tab-title match, or an all-digit bare index) wins before a secondary snapshot's exact pane/tab id is consulted, and cross-snapshot title collisions never yield `Ambiguous`. Accepted because a collision requires a human-facing title or digit string to exactly equal another client's nanoid-format id — improbable — and reordering the tested resolver (cross-snapshot exact-id pass first) was judged not worth the churn. Deliberate; documented here.
- **Primary-only listings vs by-id resolution asymmetry (deliberate):** `list_tabs`/default `list_panes` show only the last writer's layout while by-id ops resolve across all clients; MCP tool descriptions promise "list all tabs", so an agent may successfully act by id on a pane that listings don't show. Matches Node default-read semantics; kept.
- **`resize_split` writes primary-derived sizes onto every snapshot containing the id** — mirror-only divergence that self-heals at each client's next sync. (The store is validated non-authoritative: nothing persists it or restores clients from it; the only store-driven disk write is the best-effort title override in the rename cascade.)
- **`tabRenamed` has no in-repo consumer** (`PaneContainer.tsx:312-321` ignores it); its cross-client "resolving snapshot wins" semantics are pinned by test and benign.
- **Deployment-path flag:** the repo's documented default server is still Node (`npm run serve`, `bin: freshell`, Electron bundle); the Rust server is opt-in (`run-rust-server.sh`), with direction toward Rust (rust-port-mainline #633). This fix helps Rust-server deployments; the Node store intentionally stays single-snapshot per Global Constraints.
- **Exotic parity drift (noted, not gating):** Rust `js_number` ≠ JS `Number()` for `0x/0o/0b` strings in the bare-index rung; Node `selectTab` materializes an empty snapshot where Rust doesn't. Single-client parity for error strings, ladder rung order, and miss-message precedence is otherwise verified line-by-line.
