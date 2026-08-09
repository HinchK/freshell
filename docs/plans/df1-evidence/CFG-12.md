# CFG-12 — Preserve the browser-local/server-wide settings split — df1 evidence

**Branch:** `df1/cfg-12-settings-split` (base `origin/df1/integration` @ `3dbba43c2`) · **Date:** 2026-08-09 · **Item:** CFG-12 (checklist: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` — two isolated contexts: browser-local theme/sidebar prefs stay per-profile; server-shared `defaultCwd` replicates to every client and persists).

## Root cause

The rust port emitted a **boot-frozen** `Arc<ServerSettings>` (`WsState.settings`, snapshotted in
`crates/freshell-server/src/main.rs` at boot) as EVERY `/ws` connection's handshake
`settings.updated` frame (`build_handshake_with_capabilities`,
`crates/freshell-ws/src/lib.rs`). The field's own doc comment admitted the divergence: the
original recomputes settings per connection (`server/index.ts:415-427`
`handshakeSnapshotProvider` → `await configStore.getSettings()`; `server/ws-handler.ts:1815-1845`
`sendHandshakeSnapshot`). A `PATCH /api/settings { defaultCwd }` committed the live
`SettingsStore`, persisted `config.json`, and broadcast a live frame to CONNECTED clients — but a
client that (re)loaded afterwards received the boot snapshot in its handshake, and the client's
last-write-wins `setServerSettings(msg.settings)` (`src/App.tsx:1151-1152`) erased the correct
value `/api/bootstrap` (already live: `boot.rs:104` reads `store.get().await`) had delivered.

## Fix (commit `4a303bcfc`)

- `WsState` gains `handshake_settings: Arc<tokio::sync::RwLock<ServerSettings>>` — the LIVE tree,
  resolved per connection by the (now async) `build_handshake*` builders.
- `SettingsStore::shared_settings_lock()` vends the store's ONE inner lock (Arc identity: a PATCH
  commit is exactly the memory the next handshake reads; no copies, no caching layer); `main.rs`
  wires it into `WsState`.
- The frozen `settings` field REMAINS boot-scoped for `terminal.rs`'s create-time derivations —
  CFG-06's boundary ("every new operation resolves live"), pinned by an explicit assertion in the
  new unit test so the two fields cannot be silently merged without CFG-06's per-consumer proofs.
- Clean-boot wire bytes are unchanged (the lock is seeded from the same loaded tree); oracle
  byte-parity fixtures untouched and passing.

## RED proofs (pre-fix code)

1. **Unit compile-REDs:** `cargo test -p freshell-ws --lib handshake_settings_updated_reflects_live`
   → `E0609: no field handshake_settings` / `E0277: Vec<ServerMessage> is not a future`;
   `cargo test -p freshell-server settings_store::tests::patch_is_visible` →
   `E0599: no method shared_settings_lock`.
2. **Unit assertion-RED** (scaffolding landed, builder still frozen):
   `tests::handshake_settings_updated_reflects_live_writes_between_connections` FAILED —
   `left: Null, right: String("/tmp/shared-cwd")` ("a later connection's handshake must resolve the
   live tree, not the boot snapshot"); 430 other ws lib tests passed.
3. **E2E annotation-RED** (pre-fix binary `target/release/freshell-server` → copied to
   `/tmp/opencode/freshell-server-cfg12-prefix`, startup line `[commit
   3407b3d20212d0e6b1affb4c110584e1222767b1] [dirty false]` — docs-only commit over base
   `3dbba43c2`, i.e. pre-product-change):

   `FRESHELL_E2E_RUST_SERVER_BIN=/tmp/opencode/freshell-server-cfg12-prefix npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --reporter=json test/e2e-browser/specs/settings-persistence-split.spec.ts`

   → defaultCwd test: annotation
   `CFG-12: rust WS/bootstrap settings resolution drops a PATCHed server-shared defaultCwd (2026-08-09)`,
   `expectedStatus: "failed"`, actual `status: "failed"` at spec line 203:
   Expected `"/tmp/freshell-e2e-rust-xMNnLz/shared-default-cwd"`, Received `undefined`
   (10s `expect.poll` predicate timeout after `pageB.reload()`). Seed test passed as expected;
   suite stats `expected: 2, unexpected: 0`. `patchResponse.ok` passed beforehand — the PATCH was
   accepted; the red edge is strictly client-visible replication (matches JAN-87's triage).

## GREEN proofs

### Rust unit / integration (post-fix, cargo lease)

- `cargo test -p freshell-ws --lib` → **431 passed, 0 failed** (incl. new
  `handshake_settings_updated_reflects_live_writes_between_connections` + all 5 pre-existing
  handshake-shape tests re-`#[tokio::test]`-ed).
- `cargo test -p freshell-server settings_store::tests` → **57 passed, 0 failed** (incl. new
  `patch_is_visible_through_shared_settings_lock` (Arc identity) and
  `patched_default_cwd_survives_reload_from_disk` (restart half of the checklist text)).
- `cargo test -p freshell-ws --test handshake_live_settings` → **1 passed** (NEW: real `/ws`
  server, two connections, lock mutation between → 2nd handshake carries `defaultCwd`).
- `cargo test -p freshell-server --bin freshell-server` → **610 passed, 0 failed** (full bin suite).
- `cargo test -p freshell-ws --all-targets` → first full run: 1 failure in
  `codex_locator_activity::fresh_pane_locator_identity_reaches_activity_and_turn_complete`
  (turn-complete timing test, hit its window under swarm load, 35.4s; NOTHING settings-adjacent).
  Isolated rerun `cargo test -p freshell-ws --test codex_locator_activity` → **ok (5.4s)** —
  classified pre-existing load flake, not a regression from this diff. (Full-suite rerun result
  recorded below.)
- `cargo fmt --check` clean.

### Playwright (pw lease; spec un-pinned at the same commit)

Post-fix binary: `cargo build --release -p freshell-server` (fixture rebuilds in place).

(To be filled: rust ×2, legacy ×2 run results.)

## Commands (verbatim, at final SHA)

```
# unit + wire
cargo test -p freshell-ws --lib
cargo test -p freshell-server --bin freshell-server
cargo test -p freshell-ws --test handshake_live_settings
# e2e (pw lease)
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/settings-persistence-split.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium test/e2e-browser/specs/settings-persistence-split.spec.ts
```
