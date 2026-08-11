# Multi-Client Layout Store Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

> **EXECUTION STATUS: COMPLETE.** This plan is a retrospective artifact:
> the implementation already exists at commit c22e5e0a6 on branch
> fix/multi-client-layout-store (fork point 669219563). It was
> reconstructed from the executed work so the workflow's validation and
> review stages can run against a committed plan. All checkboxes are
> marked complete; commit references and test evidence are real.

**Goal:** Fix the cross-client "pane not found" bug by making the Rust server's `LayoutStore` keep one layout snapshot per connected WS client (most-recent-first), so by-id agent-API operations (rename, select, split, close, swap, capture/send-keys targeting) resolve pane/tab ids from EVERY connected client instead of only the last writer.

**Architecture:** The Rust server mirrors client layouts via WS `ui.layout.sync` frames into a shared `LayoutStore` consumed by the REST/MCP agent API. Previously the store held ONE snapshot, wholesale-replaced last-writer-wins — but pane/tab ids are client-local (`nanoid()` per browser/device), so any non-last-writer client's ids were unresolvable. The fix replaces the single snapshot with a `Vec<ClientEntry>` keyed by WS connection id: default reads answer from the primary (index 0, last writer) only; by-id reads search all snapshots primary-first; id-targeted mutations land in every snapshot containing the id; disconnect evicts that connection's snapshot.

**Tech Stack:** Rust (workspace crates `freshell-freshagent`, `freshell-ws`), axum (REST router), tokio + tokio-tungstenite (WS), serde_json, `std::sync::{Arc, Mutex}` store interior.

## Global Constraints

- Rust server only — the Node server intentionally retains single-snapshot behavior; every touched Node-parity doc comment marks the intentional divergence.
- No changes to the TypeScript client, Node server, or shared protocol schemas.
- Single-client behavior must remain byte-identical to the existing Node-parity semantics (`layout-store.ts` ports), including the `"no layout snapshot"` / `"pane not found"` / `"tab not found"` messages.
- Never touch the live self-hosted server on port 3001; no deploy/restart from this workflow.
- No push and no PR from this workflow — local commits only, on the worktree branch.
- Red-Green-Refactor TDD: every new test is watched RED against the old single-snapshot store before implementation.
- `cargo test --workspace`, `cargo clippy`, and `cargo fmt --check` must be green at completion.

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
- [x] Run to verify RED against the old single-snapshot store: `cargo test -p freshell-freshagent --lib layout_store::tests::rename_pane_resolves_ids_from_any_client_snapshot` — observed failure: `out.message` was `Some("pane not found")` (conn-b's sync had wholesale-replaced the store). The other five failed correspondingly (pA unresolvable via conn-a; title lost after primary eviction; no primary fallback; sole-pane answered from the wrong snapshot).
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
    Add `remove_client` (`clients.retain(|entry| entry.key != client_key)`), `pane_is_sole_in_tab` (`leaves_of(snapshot, &tab_id).len() == 1` in the resolving snapshot), and `snapshots_clone`. Update the `LayoutInner` doc comment to document the intentional divergence from Node's `layout-store.ts:44-46`.
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
- [x] Implement: pass `&conn_id.to_string()` as `update_from_ui`'s `source_connection_id` in the `UiLayoutSync` arm (the port of Node's `this.layoutStore.updateFromUi(m, ws.connectionId || 'unknown')`, `server/ws-handler.ts:1966-1969`); add `state.layout.remove_client(&conn_id.to_string())` to `run()`'s disconnect teardown; update the `ui.layout.sync` arm comment, the disconnect comment, and `WsState.layout`'s doc in `lib.rs` to state the intentional multi-client divergence from Node's single last-writer-wins snapshot. Update the pre-existing `ui_layout_sync_frame_populates_the_shared_layout_store` test's doc to the per-connection wording.
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
  - `fn resolve_in_snapshot(snapshot: &UiSnapshot, raw: &str) -> ResolvedTarget` — the full Node resolution ladder (pane id → tab id → tab title → `tab.pane` index form → bare index → pane title, 2+ title matches → Ambiguous) extracted to run against ONE client snapshot; the ladder runs per snapshot, primary first, byte-identical to Node with one client connected.
  - REST `rename_pane` handler: `tabRenamed` computed as `let tab_renamed = state.layout.pane_is_sole_in_tab(&pane_id);` (replacing the old `list_panes(Some(&tab_id)).map(|rows| rows.len() == 1)` read, which would answer from the wrong snapshot when another client has a same-id tab of different shape); the rename cascade (`rename_persistence::persist_syncable_terminal_rename`) receives the pane snapshot from `get_pane_snapshot`, which resolves in the same snapshot as the rename.

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
- [x] Final verification across the whole change: `cargo test --workspace` green (including `freshell-ws` integration tests 2/2), `cargo clippy` clean, `cargo fmt --check` clean.
- [x] Commit — landed in the same atomic commit `c22e5e0a6` on `fix/multi-client-layout-store` (8 files, +906/−269). No push, no PR (per repo rules and Global Constraints).
