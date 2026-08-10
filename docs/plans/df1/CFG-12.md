# CFG-12 — Preserve the browser-local/server-wide settings split (Rust WS handshake live settings)

**Item (verbatim):** *Preserve the browser-local/server-wide settings split. Browser appearance/sidebar preferences must remain per profile while server launch/file/network settings replicate to every client.*

**Playwright validation text (checklist):** *Use two isolated browser contexts, change theme/sidebar sort and default cwd in A, assert B keeps its local appearance but receives the cwd, then reload both and restart Rust to prove both persistence paths.*

**Campaign acceptance (gate B001, inherited):** `test/e2e-browser/specs/settings-persistence-split.spec.ts`'s defaultCwd test carries a committed `test.fail(e2eServerKind === 'rust', 'CFG-12: ...')` pin. Land the rust WS/bootstrap `defaultCwd` behavior so that leg passes, **remove the pin**, and prove the whole spec green on `--project=legacy-chromium` AND `--project=rust-chromium`, ≥2 consecutive runs each.

**Branch:** `df1/cfg-12-settings-split` (base `origin/df1/integration` @ `3dbba43c2`). **Execution:** inline by the owning df1 worker (autonomous dispatch; no human checkpoint).

## Parity source (frozen legacy `server/`)

- `server/index.ts:415-427` — `handshakeSnapshotProvider`: on EVERY `/ws` connection it calls
  `migrateSettingsSortMode(await configStore.getSettings())` — the **live** config store — and
  returns `{ settings, projects, perfLogging, configFallback }`.
- `server/ws-handler.ts:1815-1845` — `sendHandshakeSnapshot`: per connection, awaits the provider
  and sends `settings.updated` (current settings), `perf.logging`, optional `config.fallback`,
  then `terminal.inventory`.
- Client (`src/App.tsx:554-631,1151-1152`) — fetches `/api/bootstrap` (whose `settings` the rust
  server ALREADY serves live from `SettingsStore`, `crates/freshell-server/src/boot.rs:104`) AND
  applies every WS `settings.updated` via `setServerSettings`. The WS frame is the last write on a
  reload, so a stale handshake value **wins over** the correct bootstrap value.
- `shared/settings.ts:1406-1445` — `composeResolvedSettings` maps `defaultCwd: server.defaultCwd`
  straight into the resolved settings the e2e harness reads; `stripLocalSettings` never strips
  top-level `defaultCwd`. The browser-local half (theme/uiScale/local sidebar/terminal/panes keys)
  lives only in `localStorage` (`freshell.browser-preferences.v1`) and rides
  `legacyLocalSettingsSeed` (CFG-04, landed) — the split itself is client-side and already correct.

## Gap (today, Rust)

`crates/freshell-ws/src/lib.rs`:

- `WsState.settings: Arc<ServerSettings>` is a **boot-frozen** snapshot (`main.rs:204-205`
  `Arc::new(settings_store.get().await)` → `main.rs:795`).
- `build_handshake_with_capabilities` (lib.rs:440-501) emits that frozen tree as the per-connection
  `settings.updated` frame. A `PATCH /api/settings { defaultCwd }` mutates the live
  `SettingsStore`, persists to `config.json`, and broadcasts a live `settings.updated` — but any
  client that (re)connects afterwards gets the boot snapshot in its handshake, and the client's
  last-write-wins application erases the replicated value. E2E red observed exactly there:
  `getResolvedSettings(pageB)?.defaultCwd` → `undefined` after PATCH + `pageB.reload()`
  (evidence: `docs/plans/df1-evidence/JAN-87.md`).
- The `WsState.settings` field has a deliberate doc comment admitting the divergence
  ("the original recomputes ... fresh on every connection, `server/index.ts:369-381`; this crate
  already snapshots `settings` once at boot").

Already-correct surfaces (no change): PATCH/GET `/api/settings` (`settings_store.rs:1825-1864`,
live store + persist + broadcast), `/api/bootstrap` (live `state.settings.get()`),
`load_full_settings` disk round-trip (deep-merge incl. `defaultCwd`).

### Ownership boundary (explicit non-goals)

- `terminal.rs`'s create-time reads of the same frozen `WsState.settings`
  (`cli_provider_settings` :1113, codex plan :1170, `resolve_create_cwd(... state.settings
  .default_cwd ...)` :2041/:3168) are NEW-OPERATION freshness — owned by **CFG-06** ("every new
  operation ... must resolve current values from the live store; dedicated TERM-* tests prove each
  consumer"). This item leaves them untouched and leaves the frozen field in place for them.
- `config_fallback` stays boot-frozen (it is a boot-time event by design, GAP1/CFG-03 semantics).
- No client or `shared/settings.ts` changes — the split logic is already correct and shared by
  both server kinds (legacy leg is green).

## Architecture

Add ONE live source to `WsState`, consumed ONLY by the handshake builder:

```rust
/// CFG-12: the LIVE server-settings tree, resolved per `/ws` connection ...
pub handshake_settings: Arc<tokio::sync::RwLock<ServerSettings>>,
```

- `SettingsStore` vends its inner lock: `pub fn shared_settings_lock(&self) -> Arc<RwLock<ServerSettings>>`
  — so a `PATCH`'s committed write (`settings_store.rs:416`) is the SAME memory the next handshake
  reads. No copy, no sync loop, no broadcast-into-snapshot caching.
- `build_handshake` / `build_handshake_with_capabilities` become `async` and read
  `state.handshake_settings.read().await.clone()` for the `settings.updated` frame; `handle_socket`
  awaits the builder. Only caller outside tests is `handle_socket`.
- On a **clean boot** the lock contents equal the old snapshot, so the wire bytes are unchanged —
  the oracle byte-parity fixtures and the existing handshake-shape tests keep passing untouched.
- The frozen `settings` field stays for the create-time consumers (CFG-06's future target), with
  doc comments on both fields pinning the boundary so a future reader can't conflate them.

### Test construction sites updated (mechanical; `handshake_settings` seeded from each site's
existing fixture value)

- `crates/freshell-server/src/main.rs:777` (prod: `settings_store.shared_settings_lock()`)
- `crates/freshell-ws/src/lib.rs:797` (`state()`)
- `crates/freshell-ws/src/terminal.rs:5457,5692`
- `crates/freshell-ws/src/opencode_association.rs:394`, `codex_association.rs:284`,
  `codex_proxy_route.rs:227`
- `crates/freshell-ws/tests/common/mod.rs` (9 `WsState` literals; seed from
  `test_settings_value()`)

## Tasks

### Task 1 — ws crate: live handshake settings (RED→GREEN)

**Files:** `crates/freshell-ws/src/lib.rs` (+ the six src-side construction sites above).

1. RED: new unit test in `lib.rs::tests` — build `state()`, mutate
   `state.handshake_settings.write().await.default_cwd = Some("/tmp/shared-cwd".into())`, rebuild
   the handshake, assert frame 2's `settings.updated.settings.defaultCwd == "/tmp/shared-cwd"`
   (and that the pre-mutation handshake lacked it). Compile error red first (field doesn't exist).
2. Add `handshake_settings` to `WsState` (doc-commented, boundary vs `settings` spelled out).
3. Make `build_handshake*` async; emit `state.handshake_settings.read().await.clone()`; await in
   `handle_socket`; update the 6 src test sites; convert the sync handshake tests to
   `#[tokio::test]` + `.await` (purely mechanical).
4. GREEN: `cargo test -p freshell-ws --lib` (scoped, cargo lease).
5. Commit.

### Task 2 — server crate: vend the live lock + wire it (RED→GREEN)

**Files:** `crates/freshell-server/src/settings_store.rs`, `crates/freshell-server/src/main.rs`.

1. RED: new `settings_store` tests:
   - `patch_is_visible_through_shared_settings_lock` — `store.patch({"defaultCwd": "..."})`;
     `store.shared_settings_lock().read().await.default_cwd` is the patched value (proves Arc
     identity: the handshake will see exactly what PATCH committed).
   - `patched_default_cwd_survives_reload_from_disk` — patch, drop, `SettingsStore::load` the same
     home; `get().await.default_cwd` persists (locks the restart half of the checklist text).
2. Implement `shared_settings_lock()`; wire `handshake_settings: settings_store.shared_settings_lock()`
   at `main.rs:777`.
3. GREEN: `cargo test -p freshell-server settings_store` (scoped, cargo lease).
4. Commit.

### Task 3 — ws integration: two real `/ws` connections see pre/post-patch settings

**Files:** Create `crates/freshell-ws/tests/handshake_live_settings.rs`; extend
`crates/freshell-ws/tests/common/mod.rs` with `spawn_server_with_shared_settings()` returning
`(url, registry, Arc<RwLock<ServerSettings>>)` (same shape as the existing spawn helpers; the lock
seeds BOTH `handshake_settings` and the frozen `settings` fixture value).

1. Connect #1 → handshake `settings.updated` has NO `defaultCwd`.
2. Write `default_cwd` into the returned lock (a PATCH's committed-write analog).
3. Connect #2 → handshake `settings.updated.settings.defaultCwd` IS present; connection #1's
   already-sent bytes were not retroactively changed (implicit: #1 assertion ran before mutation).
4. GREEN: `cargo test -p freshell-ws --test handshake_live_settings` (scoped).
5. Commit.

### Task 4 — Playwright: un-pin the defaultCwd leg, prove both projects ×2

**Files:** `test/e2e-browser/specs/settings-persistence-split.spec.ts`
(delete the `test.fail(e2eServerKind === 'rust', ...)` + its owner comment; rewrite the
describe-block history note to record CFG-12 as landed).

1. RED-FIRST (pre-change code): run the rust leg at the BASE state with `--reporter=json`,
   capture the annotated failure (`status: "failed"` at the `getResolvedSettings(pageB)?.defaultCwd`
   poll) into the evidence file. [Recorded before Tasks 1-3 land; binary is the pre-fix build.]
2. Pre-build: `cargo build --release -p freshell-server` (cargo lease) so the fixture's cold-build
   can't blow its 60 s timeout.
3. Runs (pw lease, released after each): `--project=rust-chromium` ×2 consecutive green, then
   `--project=legacy-chromium` ×2 consecutive green, spec-scoped:
   `npx playwright test --config test/e2e-browser/playwright.config.ts --project=<p> test/e2e-browser/specs/settings-persistence-split.spec.ts`
4. Commit.

### Task 5 — hygiene + evidence + review

- `cargo fmt --check` (workspace), `cargo clippy -p freshell-ws -p freshell-server --all-targets`
  clean at the touched crates.
- Evidence: `docs/plans/df1-evidence/CFG-12.md` (red proof, green commands + outcomes, run ids).
- Fresh review subagent (review-agent skill) over the diff; fix serious findings; ≤5 loops.
- `df1ctl update CFG-12` heartbeats ≥15 min cadence throughout; terminal state `review` /
  `COMPLETED`.

## Load-bearing assumptions (validated in `load-bearing` audit below)

| # | Assumption | Validation | Result |
|---|-----------|------------|--------|
| A1 | Legacy recomputes handshake settings per connection (not boot-frozen) | read `server/index.ts:415-427` + `ws-handler.ts:1815-1845` | ✔ per-connection `configStore.getSettings()` await |
| A2 | Rust PATCH commits the live store and persists `defaultCwd` before the e2e poll | read `settings_store.rs:359-418,467-507` | ✔ persist-then-commit; `defaultCwd` allowlisted :1606 |
| A3 | `/api/bootstrap` + `GET /api/settings` already serve the live tree | read `boot.rs:100-116`, `settings_store.rs:1836-1841` | ✔ both `store.get().await` |
| A4 | Client's last write wins: WS handshake `settings.updated` can clobber bootstrap settings | read `src/App.tsx:594,1151-1152` | ✔ same reducer; whichever lands last holds |
| A5 | Clean-boot wire bytes unchanged after the fix | `default_plus_network_overlay_matches_captured_fixture` + handshake-shape tests | ✔ lock seeded from same loaded tree; run green in Task 1/4 |
| A6 | Client composes `defaultCwd` server→resolved unfiltered | `shared/settings.ts:1406-1445,1497-1536` | ✔ direct map; not a local key |
| A7 | No other consumer of handshake `settings.updated` breaks if content becomes live | grep all `SettingsUpdated`/handshake consumers | ✔ only build site emits; frame TYPE/shape unchanged |
