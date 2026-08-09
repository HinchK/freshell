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

### Playwright (pw lease; spec un-pinned)

Post-fix binary: `cargo build --release -p freshell-server` in-worktree (the rust-chromium
fixture's `ensureRustServerBuilt` no-op rebuild check then runs against a warm target dir).

At the fix commit with the spec un-pinned in-tree (pre-commit worktree state of `cf3764707`):

- `--project=rust-chromium` run 1: **2 passed** (19.3s) — defaultCwd test now passes
  un-annotated (its Playwright annotation list is EMPTY; the deleted pin would have hard-failed
  an unexpected pass, so green here is direct proof the pin was correctly removed).
- `--project=rust-chromium` run 2: **2 passed** (21.1s).
- `--project=legacy-chromium` run 1: **2 passed** (20.5s).
- `--project=legacy-chromium` run 2: **2 passed** (43.4s).

At the code-final SHA `cf3764707` (after the comment-only clippy fix; binary rebuilt, 45.2s —
HEAD at report time is `91beabfeb`, a docs-only evidence commit on top of `cf3764707`):

- `--project=rust-chromium` run 1: **2 passed** (16.7s).
- `--project=rust-chromium` run 2: **2 passed** (17.9s).
- `--project=legacy-chromium` run 1: **2 passed** (19.3s).
- `--project=legacy-chromium` run 2: **2 passed** (26.3s).

Focused cargo rerun at final SHA (same PTY chain as the build): ws lib **431/431**,
`--test handshake_live_settings` **1/1**, server bin **610/610**. `cargo fmt --check` clean;
`cargo clippy -p freshell-ws -p freshell-server --all-targets -- -D warnings` clean (round 2,
after rewording one doc-comment line that tripped `doc_lazy_continuation`); `npm run typecheck`
clean.

## Review record

Structured fresh-eyes self-review per the review-agent protocol (no `Task` tool in this
environment → the orchestrator's sanctioned fallback), over `git diff 3dbba43c2..cf3764707`
(the full change, incl. all 37 files):

- Verified no missed `WsState` construction sites: compiler-checked (`cargo check --all-targets`)
  + full green suites; 5 src + 8 common/mod.rs + 26 per-file integration literals all carry the
  new field.
- Verified no torn/interleaved read is possible through the handshake lock: `SettingsStore::patch`
  holds the write guard only for in-memory merge, drops it BEFORE disk `persist()`, commits the
  fully-merged tree with a second short write (`settings_store.rs:377-416`), so a handshake read
  sees a complete old-or-new tree and never waits on disk IO.
- Verified clean-boot byte parity claim by test, not inspection alone: all 5 pre-existing
  handshake-shape/transcript tests re-run green under the async builder; oracle fixture test
  (`default_plus_network_overlay_matches_captured_fixture`) green (610-pass bin suite).
- Verified the CFG-06 boundary is pinned behaviorally (frozen view must NOT follow the live lock —
  explicit assertion inside the new ws lib test).
- Spec edit: `e2eServerKind` removed from the second test's destructure (no remaining use);
  typecheck clean; both pw legs green ×2 after the edit.

**Findings: none.** Residual risks (accepted, owned elsewhere): create-time consumers still read
the boot-frozen view — deliberately deferred to CFG-06 (its PW validation asserts exactly that);
the checklist sentence's rust-restart leg is proven at store level
(`patched_default_cwd_survives_reload_from_disk`) plus the spec's on-disk `config.settings
.defaultCwd` assertion, matching the campaign acceptance, which names the exact split-spec legs.

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
