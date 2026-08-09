# AUTO-01 — Make `ui.layout.sync` authoritative (implementation plan)

> **For df1 workers:** executed inline by `df1-auto-01-layout-sync-auth` per the
> orchestrator dispatch pipeline: plan → load-bearing audit → TDD → verify (focused
> green ×2) → review loop (fresh Task review subagent; ≤5 rounds). Evidence lands in
> `docs/plans/df1-evidence/AUTO-01.md`.

**Goal (checklist item, verbatim):** "Make `ui.layout.sync` authoritative. Replace the
OpenCode-only shadow layout with the real connected UI layout shared by browser, REST,
CLI, and MCP. Reverse mutations are owned by `AUTO-02` through `AUTO-11`."

**Acceptance (checklist Playwright validation, verbatim):** "Create, rename, reorder,
select, split, resize, and close content only through the visible UI, then fetch the
layout snapshot and assert exact tab IDs/order, pane tree/ratios, titles, content,
active tab, and active pane."

**df1 posture (dispatch):** Playwright DEFERRED per campaign policy — but author the
probe spec, register it in `MATRIX_SPECS`, and run it ONCE per relevant leg
(`legacy-chromium` parity control + `rust-chromium`) with per-leg outcome
classification in the evidence note. Proof of implementation = Rust unit/crate
integration tests + focused vitest where touched.

## Parity source (legacy Node, frozen `server/`)

- Ingest: `server/ws-handler.ts:2025-2039` — `case 'ui.layout.sync'` →
  `layoutStore.updateFromUi(m, ws.connectionId || 'unknown')` + per-connection
  `sidebarOpenSessionKeys` rebuild (see Residual risk R2).
- Store: `server/agent-api/layout-store.ts` (full read 2026-08-09):
  snapshot `{tabs, activeTabId, layouts, activePane, paneTitles, paneTitleSetByUser,
  timestamp?}` + `sourceConnectionId`; last-write-wins, whole-snapshot replace;
  `migrateLegacyFreshAgentNode` normalization on ingest; derived pane-title seeding
  (`derivePaneTitle` 93-159); `getNormalizedSnapshot(tabId?)` filter semantics
  (191-210); `listTabs` {id, title||id, activePaneId} (327-334); `listPanes(tabId?)`
  resolves `tabId || activeTabId || tabs[0].id`, leaves in tree order with
  `{id, index, kind, terminalId, title}` (341-355); `hasTab` id-OR-title (336-339);
  `getPaneSnapshot` (379-397); mutation ops used by existing routes: `createTab`/
  `splitPane`/`closePane`/`selectTab`/`selectPane`/`renameTab`/`renamePane`/`closeTab`/
  `swapPane`/`resizePane`/`attachPaneContent` (431-693). Quirk mirrored exactly:
  `closePane` on >2 panes REBUILDS the tree via `buildGridLayout` (geometry loss is
  legacy behavior, not a bug).
- Normalization: `shared/fresh-agent.ts:199-359` + `shared/session-contract.ts:69-97`
  (canonical claude id = 8-4-4-4-12 hex, version [1-5], variant [89ab], case-insens).
- Reads: `server/agent-api/router.ts:857-902` (`tabs/has`, `tabs/next|prev`,
  `GET /tabs` {tabs, activeTabId}, `GET /layout/snapshot`, `GET /panes`),
  fresh-agent/terminal create flows (546-600, 695-810) — `createTab(title)` bare,
  success → `attachPaneContent(fullPaneContent)`, rollback → `closeTab`.

## Current Rust state (base `origin/df1/integration` 3dbba43c2)

- `ui.layout.sync` parses into `ClientMessage::UiLayoutSync`
  (`crates/freshell-protocol/src/client_messages.rs:332-350`) and is DISCARDED in
  `freshell-ws` (`terminal.rs` catch-all `_ => true`; documented deferral at
  `pane_ops.rs:781-818` "Deferred pending ui.layout.sync ingestion (AUTO-01)").
- REST reads served from `FreshAgentState` shadow maps populated ONLY by REST
  mutation routes (`tabs`/`pane_tabs`/`terminal_panes`/`content_panes`):
  `layout_snapshot` (`pane_ops.rs:533+`) fabricates leaf nodes and an
  `{type:'unknown', paneIds}` marker for multi-pane tabs; `list_tabs`
  (`terminal_tabs.rs:2244`) reports `activeTabId: null`; `tabs_next/prev` 400-deferred
  (pane_ops.rs:483-513); `tabs_has` id-only (456-467); `list_panes`
  (`terminal_tabs.rs:2280`) lists ALL shadow panes with tab-title fallback.
- `freshell-ws` already depends on `freshell-freshagent`; `WsState.fresh_opencode`
  wraps the SAME `FreshAgentState` `main.rs:267-273` hands to the REST router —
  one shared instance, zero new crate edges.

## Design

One new module `crates/freshell-freshagent/src/layout_store.rs`: a Rust port of the
legacy `LayoutStore` — the SAME snapshot shape, normalization, title seeding, reads,
and the mutation ops the EXISTING Rust routes already need. Held as
`Arc<LayoutStore>` on `FreshAgentState` (constructed in `::new`, no other wiring).
`FreshOpencodeState` gains `pub fn fresh_agent(&self) -> &FreshAgentState`.

Write path: new WS arm in `handle_client_text` (`crates/freshell-ws/src/terminal.rs`):
`ClientMessage::UiLayoutSync(m)` → `update_from_ui(&m, &conn_id.to_string())`.
In-memory-only op (layout payloads are small; legacy does the same synchronously).
No server→client reply/broadcast on ingest (legacy replies nothing).

Read re-points (authoritative = the real connected UI layout):
- `GET /api/layout/snapshot` → store `get_normalized_snapshot(tabId)` (legacy-exact
  six keys always present + `timestamp` only when present; removes the fabricated
  `unknown` marker — real tree now).
- `GET /api/tabs` → store `list_tabs()` + real `activeTabId` (legacy-exact rows
  `{id, title(title||id fallback), activePaneId}`).
- `GET /api/panes` → store `list_panes(tabId)`: legacy tab resolution
  (`tabId || activeTabId || tabs[0]`), tree-order leaves, rows
  `{id, index, kind?, terminalId?, title?}` + additive `tabId` (pre-existing Rust
  field kept for the MCP bridge; recorded deviation).
- `GET /api/tabs/has` → `has_tab` id-OR-title (legacy-exact flip from id-only).

Write-through at EXISTING mutation routes (keeps REST-only flows coherent pre-sync;
mirrors legacy's route→store calls one-for-one; route semantics/rollback/broadcasts
UNCHANGED — AUTO-02..11 own those contracts):
- `lib.rs::create_tab` (fresh-agent): store `create_tab(title)` bare → success →
  `attach_pane_content(full fresh-agent paneContent)` (router.ts:546-585).
- `terminal_tabs` create (terminal/browser/editor): same two-step with the route's
  full paneContent (router.ts:738-798); `retire_restore_key_content` also removes the
  store tab row.
- `pane_ops::split_pane` → `store.split_pane(...)` + `attach_pane_content(new full
  content)`; the store mints the split node id (legacy nanoid equivalent: uuid).
- `close_pane`/`select_pane`/`select_tab`/`rename_tab`/`delete_tab` → store ops
  (`close_pane`'s sibling guard now comes from the real tree; REST close of a
  UI-created pane works — the point of the item). `swap_pane`/`navigate_pane` add
  `store.swap_pane`/`store.attach_pane_content` alongside the kept process maps.
- `rename_pane` (lib.rs PATCH): UNCHANGED (AUTO-06 owns its full parity incl.
  store mutation + broadcast); `resize_pane`/`tabs_next|prev`/`attach_pane`
  deferrals STAY (AUTO-03/06/07) — deferral texts updated to state the truth
  (store exists; route contract owned elsewhere) while keeping the substring
  "ui.layout.sync" pinned by tests.
- Dispatch routes (`send-keys`/`capture`/`wait-for`) KEEP shadow-map resolution
  untouched — re-pointing them at real UI panes is AUTO-09's stone.

Client/browser/Node trees: untouched (client already mirrors; Node `server/` frozen).

## Load-bearing ledger (audited 2026-08-09, all verdicts from direct evidence)

| # | Claim | Method | Verdict |
|---|-------|--------|---------|
| 1 | Real client `ui.layout.sync` frames parse into `ClientMessage::UiLayoutSync` (layouts opaque `Value`, titles `Value`, `activeTabId` double-option, ms `i64` timestamp) | inspect `client_messages.rs:332-350` + `roundtrip.rs:352-377` + `layoutMirrorMiddleware.ts:24-50` | VERIFIED |
| 2 | The frame is unconsumed today and NOT intercepted by `unhandled_fresh_agent_control_reply` (only approval/question/fork/compact) | inspect `terminal.rs:962,4411-4440` | VERIFIED |
| 3 | WS and REST share ONE `FreshAgentState` (`main.rs:267-273`; `WsState.fresh_opencode`) | inspect | VERIFIED |
| 4 | `FreshOpencodeState` lacks a `FreshAgentState` accessor; adding one is additive | inspect `opencode_ws.rs:207-234` | VERIFIED |
| 5 | The SPA never reads `GET /api/tabs|panes|layout/snapshot` (only CLI/MCP/tests) | grep `src/` (only PATCH panes + tabs-sync beacon) | VERIFIED |
| 6 | MCP row consumers tolerate changed/additive row fields | `freshell-tool.ts:143-144` (all optional) | VERIFIED |
| 7 | freshell-ws test harness returns `WsState` for direct store assertions | `tests/common/mod.rs:spawn_server_with_specs_and_state` | VERIFIED |
| 8 | Protocol is accept-and-strip (no `deny_unknown_fields`) | `common.rs:13`, `lib.rs:19` | VERIFIED |
| 9 | Legacy store semantics fully enumerated | read of `layout-store.ts`, `router.ts:503-810,855-902`, `shared/fresh-agent.ts` | VERIFIED |
| 10 | MATRIX registration = ONE additive regex line; pw via item lease | `playwright.config.ts` / df1 README | VERIFIED |

Residual risks (accepted + recorded, none blocking):
- R1 multi-client divergence: last-write-wins = legacy semantics; correct-window
  arbitration is AUTO-14's. (`source_connection_id` tracked now for it.)
- R2 `sidebarOpenSessionKeys` per-connection tracking not ported: legacy stores it
  but NO production code reads it (only `test/server/ws-*` tests). Deferred; named.
- R3 malformed sync payloads: legacy zod rejects the whole frame; Rust accept-and-strip
  stores with total normalization (junk passes through verbatim until the next good
  sync). Divergence bounded to pathological clients; documented.
- R4 pane dispatch for UI-created panes (send/capture/wait-for): still shadow-map
  resolved (AUTO-09). List/snapshot reads DO see those panes (this item).
- R5 no-client REST-only flows: write-through keeps the store coherent (legacy parity).

## Tasks (TDD, commit each)

1. **`layout_store.rs` core + test scaffold** — `LayoutStore { inner: Mutex<State> }`,
   `update_from_ui`, `get_normalized_snapshot`, never-fed empty shape (no `timestamp`
   key), tab-filter semantics. RED→GREEN on new unit tests in-module.
2. **Normalization port** (`migrate_node`/`migrate_content` on `serde_json::Value`,
   hand-rolled canonical-claude-id check — no new deps) with a table test porting
   `shared/fresh-agent.ts` cases incl. nested splits, invalid alias → restoreError,
   timeline/cli fallthrough, non-record passthrough, untouched `sessionId`.
3. **Title seeding + mutation ops** (`create_tab`, `split_pane`, `close_pane` incl.
   grid rebuild + last-pane guard, `select_*`, `rename_*` cascades, `close_tab`,
   `swap_pane`, `resize_pane`, `attach_pane_content`, `has_tab`, `list_tabs`,
   `list_panes`, `get_pane_snapshot`, `resolve_pane_to_terminal`,
   `find_pane_by_terminal_id`, `find_split_for_pane`, `get_split_sizes`) with legacy
   unit tests: `test/unit/server/agent-api/layout-store*.test.ts` behaviors ported.
4. **Wire-in**: `FreshAgentState.layout_store` + accessor; `FreshOpencodeState::
   fresh_agent()`; WS arm + ws integration test
   `crates/freshell-ws/tests/ui_layout_sync.rs` (spawn via `common/`, send frame,
   assert store snapshot + normalization + last-write-wins + source conn id).
5. **Read re-points** (`layout_snapshot`, `list_tabs`, `list_panes`, `tabs_has`) with
   updated + new route tests (sync-stuffed store served exactly; REST-only flows).
6. **Write-through at existing mutation routes** + coherence tests; deferral-text
   updates (keep "ui.layout.sync" pins true; unknown-marker test → real-tree asserts).
7. **fmt/clippy + focused suites ×2** (`cargo test -p freshell-freshagent`,
   `-p freshell-ws`, `-p freshell-protocol`; `npm run test:vitest -- run` on touched
   JS scope = none expected beyond spec authoring).
8. **Playwright probe** `test/e2e-browser/specs/layout-sync-authoritative.spec.ts`
   (UI-only gestures: create/rename/reorder/select/split/resize/close → exact
   snapshot asserts + legacy agent-chat normalization leg) + `MATRIX_SPECS` line +
   ONE probe run per leg (pw lease; rust leg needs cargo release build — cargo
   lease), per-leg classification.
9. **Evidence** `docs/plans/df1-evidence/AUTO-01.md` + final df1ctl update.

## Focused GREEN commands (verifier-facing)

- `cargo test -p freshell-freshagent layout_store` (store + migration + reads)
- `cargo test -p freshell-freshagent` (routes incl. re-pointed reads)
- `cargo test -p freshell-ws --test ui_layout_sync` (WS ingest integration)
- `cargo test -p freshell-protocol` (wire-shape guard)
- `npx playwright test --project=legacy-chromium --project=rust-chromium layout-sync-authoritative` (probe, one run/leg; via `test/e2e-browser` working dir + repo env per helpers)
- `cargo fmt --check` + `cargo clippy -p freshell-freshagent -p freshell-ws -- -D warnings` + `npm run typecheck` (spec file)
