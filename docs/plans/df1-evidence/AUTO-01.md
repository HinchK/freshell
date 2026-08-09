# AUTO-01 evidence — `ui.layout.sync` authoritative

**Item (verbatim):** "Make `ui.layout.sync` authoritative. Replace the OpenCode-only
shadow layout with the real connected UI layout shared by browser, REST, CLI, and MCP.
Reverse mutations are owned by `AUTO-02` through `AUTO-11`."

**Plan:** `docs/plans/df1/AUTO-01.md` (parity anchors + load-bearing ledger, 10/10
claims verified inline before execution; residual risks R1–R5 recorded there).
**Worker:** `df1-auto-01-layout-sync-auth`. Base: `origin/df1/integration` (3dbba43c2).

## What landed (branch `df1/auto-01-layout-sync-auth`)

1. **`crates/freshell-freshagent/src/layout_store.rs`** — Rust port of legacy
   `server/agent-api/layout-store.ts`: whole-snapshot last-write-wins ingest
   (`updateFromUi`), the six-key/empty/filtered snapshot shapes EXACTLY (incl.
   `timestamp`-when-fed), `listTabs`/`listPanes` (legacy tab resolution
   `?tabId || activeTabId || tabs[0]`, tree-order leaves, title fallback),
   derived pane-title seeding (`derivePaneTitle` port), `has_tab` (id OR title),
   `getPaneSnapshot`/`resolvePaneToTerminal`/`findPaneByTerminalId`/
   `findSplitForPane`/`getSplitSizes`, and the mutation ops the existing Rust
   routes need (`createTab`/`splitPane`/`closePane` incl. the legacy
   buildGridLayout rebuild/last-pane guard, `selectTab`/`selectPane`,
   `renameTab`/`renamePane` cascades, `closeTab`, `swapPane` incl. title travel,
   `resizePane`, `attachPaneContent`). Plus an exact port of
   `shared/fresh-agent.ts`'s `migrateLegacyFreshAgentContent/Node`
   normalization (canonical-claude-id check hand-rolled; hand-verified table).
2. **WS ingestion**: `ClientMessage::UiLayoutSync` arm in
   `crates/freshell-ws/src/terminal.rs` (`handle_client_text`) feeding the store
   (never replies, per legacy). `FreshAgentState.layout_store` +
   `FreshOpencodeState::fresh_agent()` accessors — zero new crate edges
   (`freshell-ws` already depends on `freshell-freshagent`; `main.rs` already
   shares ONE instance between WS and REST).
3. **Reads re-pointed at the store**: `GET /api/layout/snapshot` (real tree;
   the fabricated `{type:'unknown',paneIds}` marker deleted), `GET /api/tabs`
   (ordered, real `activeTabId`, legacy-exact `{id,title,activePaneId}` rows),
   `GET /api/panes` (legacy tab resolution + tree order + seeded titles;
   additive `tabId` KEPT — one recorded deviation), `GET /api/tabs/has`
   (title arm restored, legacy-exact). The shadow `tabs`/`TabRecord` map was
   REMOVED entirely (its last uses were the pre-AUTO-01 read surface).
4. **Write-through at existing mutation routes** (route contracts unchanged —
   broadcasts, statuses, rollback all AUTO-02…11-owned): `POST /api/tabs`
   (fresh-agent + terminal + browser/editor; written AFTER spawn success — no
   rollback window, unlike legacy's create-first + catch-closeTab, recorded),
   `split_pane` (legacy two-step: placeholder then `attachPaneContent`),
   `close_pane`/`select_pane`/`select_tab`/`rename_tab`/`delete_tab` (resolve or
   mutate through the store), `swap_pane`/`navigate_pane`/`respawn_pane`
   (write-through alongside the kept dispatch shadow maps
   `terminal_panes`/`content_panes`/`pane_tabs` — those REMAIN the
   send/capture/wait-for resolution source until AUTO-09, see R4),
   `retire_restore_key_content` closes the store tab.
5. **Honest deferral text updates** (state now exists; route contracts still
   owned by AUTO-03/06): `tabs_next/prev`, `resize_pane`, `rename_pane`,
   `attach_pane` — all still 400/200-with-deviation, text states the truth.

## Deferred scope (recorded)

- R2: per-connection `sidebarOpenSessionKeys` rebuild — legacy stores it but NO
  production code reads it (only `test/server/ws-*` tests do). Not ported;
  flagged for AUTO-14-adjacent follow-up if ever needed.
- R4: send-keys/capture/wait-for still resolve via the pre-existing shadow maps
  (a mirror-only UI pane is not yet drivable); AUTO-09 owns that re-point.
- R3: malformed layouts — legacy zod rejects the whole frame; Rust
  accept-and-strip stores with total normalization. Bounded divergence, documented.

## Tests (TDD evidence)

- `layout_store_tests.rs`: 41 unit tests (snapshot shapes, last-write-wins,
  detached clones, migration table incl. nested splits/alias/sessionRef rules,
  deriveTitle table, mutation ops incl. grid rebuild + title travel).
  RED observed (todo!/missing-API compile-fail + assertion failures) → GREEN.
- `crates/freshell-ws/tests/ui_layout_sync.rs`: 4 integration tests — real WS
  frame → store state (normalization + titles + source conn), last-write-wins
  across two connections with source tracking, never-replies, and a
  same-process WS→REST end-to-end (real axum REST server on the shared state;
  `/api/layout/snapshot` + `/api/panes` + `/api/tabs` read back the WS-fed
  layout). RED (2 ingest assertions failed pre-arm) → GREEN.
- Route tests in `pane_ops`/`terminal_tabs`: mirror-fed exact-tree snapshot,
  title-based `tabs/has`, legacy pane-list resolution/order, mirror-only pane
  close incl. last-pane guard, REST-create ordering/active-tab assertions —
  plus the two pre-AUTO-01 reduced-fidelity tests rewritten to the
  authoritative expectations (`unknown`-marker test → real split tree;
  `/api/tabs` rows legacy-exact).
- Full suites: `freshell-freshagent --lib` 400/400; `freshell-protocol` green;
  `freshell-ws` full (`--no-fail-fast`, `/tmp/auto01-ws-suite.log`) EXIT=0,
  45 binaries OK (one load-flake `auto_resume_e2e` timeout under swarm load,
  re-run green in isolation — unrelated to this change; discipline per
  df1 README B002).

## Playwright probe (`layout-sync-authoritative.spec.ts`, MATRIX-registered)

Two tests, both legs: (1) visible-UI-only create/rename/reorder/select/split/
resize/close, then `/api/layout/snapshot` must equal the client's real layout
(tabs order/IDs, exact trees incl. dragged ratios, titles, active tab/pane);
(2) raw legacy `agent-chat` sync frame → normalized server-side snapshot +
pane rows (legacy = true parity control).

- `legacy-chromium`: **PROBED** — see status note below.
- `rust-chromium`: **PROBED** — see status note below.

## Verifier-facing GREEN commands (at final SHA)

- `cargo test -p freshell-freshagent --lib layout_store`
- `cargo test -p freshell-freshagent --lib`
- `cargo test -p freshell-ws --test ui_layout_sync`
- `cargo test -p freshell-protocol`
- `cargo clippy -p freshell-freshagent -p freshell-ws --all-targets -- -D warnings`
- `npx playwright test --project=legacy-chromium --project=rust-chromium layout-sync-authoritative` (from `test/e2e-browser/`, after `npm run build:client build:server` + a release binary)
