# CFG-01 — Make every `config.json` write lossless

**Item (verbatim):** *Make every `config.json` write lossless. Preserve `sessionOverrides`,
`terminalOverrides`, `projectColors`, `recentDirectories`, `completedMigrations`,
`legacyLocalSettingsSeed`, Codex secrets, and unknown future keys on every writer.*

**Playwright validation text (checklist, `PW-RUST`):** *Seed unique sentinels and parameterize
settings save, terminal rename/delete, session mutation, project color, recent-directory update,
provider migration, network change, title migration, and startup normalization. After each
isolated action/restart, deep-compare the file and allow only that writer's intended paths to
differ.*

**Reconciliation status (2026-07-18, row 9):** lossless writer (Batch A, `6e3af242`) + crate
tests + staging probe DONE; **missing: the `PW-RUST` seed-sentinels/deep-compare-per-writer
spec.** This item closes both that spec and the per-(writer × key) crate-test matrix cells that
no existing test names.

**Branch:** `df1/cfg-01-lossless-writes` (base `origin/df1/integration` @ `5521f3aba`).
**Posture:** deferred-with-probe (worker contract): correctness proven in crate tests; the PW
spec is named by the evidence thread, so it is authored + registered + probed once.
**Execution:** inline by the owning df1 worker (autonomous dispatch; no human checkpoint).
CFG-02 (write serialization queue) is explicitly NOT in flight and NOT this item; the
already-landed `ConfigLock` + dirty-key overlay are this item's foundation, not its deliverable.

## Parity source (frozen legacy `server/config-store.ts`)

- Every legacy save is `saveInternal({ ...existing, ...updates })`-shaped
  (`loadInternal` :344-362, `patchSettings` :442-456, `patchSessionOverride` :505-517,
  `patchTerminalOverride` :530-542, `setProjectColor` :549-562, `addRecentDirectory`
  :585-598): unknown **top-level** keys always copy forward; the writer's owned keys are
  overlaid; writes are tmp+rename atomic (:195, :424-433).
- Legacy's OWN load-normalization rebuilds `settings` (fixed-key `mergeServerSettings`,
  `shared/settings.ts:1261+`) and `serverSecrets` (codex-only) — i.e. unknown keys **inside
  `settings`** are dropped by BOTH servers (parity, out of scope), while Rust's `persist()`
  is strictly safer on sibling secrets (overlays onto the disk copy; legacy drops them on a
  normalization persist). Rust ⊇ legacy losslessness by design.

## Current state (verified by exhaustive grep + read, this worktree)

**Every** Rust `config.json` write funnels through `SettingsStore::persist()`
(`crates/freshell-server/src/settings_store.rs:481`): tmp+rename atomic, fresh disk read,
copy-forward of unmanaged top-level keys, adopt-from-disk + dirty-key overlay for
`sessionOverrides`/`terminalOverrides`/`projectColors`, wholesale `settings` overlay (typed
tree — parity per above), overlaying `serverSecrets`, ownership write/remove of
`legacyLocalSettingsSeed` (CFG-04), `recentDirectories` seed-if-absent, CFG-03 backup refresh.
Writers and their entry points:

| # | Writer (checklist name) | Rust entry point | persist via |
|---|---|---|---|
| 1 | settings save | `PATCH/PUT /api/settings` → `SettingsStore::patch` :373 | direct |
| 2 | terminal rename/delete | `PATCH/DELETE /api/terminals/:id` → `patch_terminal_override` :745 | direct |
| 3 | session mutation | `PATCH /api/sessions/:id` (+ terminal-rename cascade + close-delete) → `patch_session_override` :812 | direct |
| 4 | project color | `PUT /api/project-colors` → `set_project_color` :926 | direct |
| 5 | network change | `POST /api/network/configure[-firewall]`, `/disable-remote-access` → `settings.patch` | direct |
| 6 | provider migration + startup normalization | `SettingsStore::load` :302-316 (knownProviders seed/append, legacy-seed strip) | direct |
| 7 | recent-directory update | **not a Rust writer** (CFG-09 open: no MRU learning) — CFG-01 obligation is *preservation across every other writer*, which the copy-forward gives | — |
| 8 | title migration (`completedMigrations` writer; legacy `markMigrationCompleted` config-store.ts:567-576) | **not a Rust writer** (no caller in `server/` beyond the store itself; Rust has none) — preservation covered | — |

CFG-03's `maybe_restore_config_from_backup` rewrites the primary **from the backup** (atomic);
`instance_id.rs` writes a separate `instance-id` file; `session_metadata.rs` persists a sidecar.
No other production `config.json` write exists (verified: only test code writes the file
directly).

### Existing coverage (all on base)

- Writer-leg lossless tests ×3 (settings patch / terminal-override / session-override) sharing
  `lossless_fixture_text()` + `assert_unmanaged_document_state_preserved()`
  (sentinels: `completedMigrations`, `recentDirectories`, `serverSecrets.codexDisplayIdSecret`,
  unknown `zzFutureKey`) — `settings_store.rs:3018-3206`.
- Batch-B side-by-side tests (external-writer survival, dirty-key-wins, tombstones,
  two-instance flock serialization) :3208+.
- CFG-03 restore preserving "every last good value" :3750+; GAP2 persist-failure :4073+.
- CFG-04 `seed_survives_unrelated_patch` (settings writer only).
- Project-color family :4130-4466 (round-trip + external-writer + dirty-key — but NOT the full
  sentinel fixture).
- `tests/net09_config_preservation.rs` — spawned real binary: network configure ×
  (sessionOverrides, terminalOverrides, serverSecrets+sibling, completedMigrations,
  recentDirectories, projectColors, unknown key) byte-preserved + restart leg. No
  `legacyLocalSettingsSeed` sentinel.

## Gaps this item closes

1. **G1 — sentinel breadth in the shared store fixture:** no test asserts
   `legacyLocalSettingsSeed` or a **sibling** (non-codex) secret survives the three store-level
   writer legs. Fix: extend `lossless_fixture_text()` + the assert helper (one change,
   three tests strengthened). The fixture's content-free `settings` shape stays as-is — the
   seed and secrets are top-level store write-throughs, not settings fields.
2. **G2 — project-color writer × full sentinel fixture** (acceptance names project color as a
   writer; existing tests use reduced fixtures).
3. **G3 — startup-normalization/provider-migration persist × full sentinel fixture** (the boot
   persist at `load()` :311 is an acceptance-named writer; no test proves sentinels survive it
   — both triggers: knownProviders seed/append AND legacy local-key strip).
4. **G4 — network writer leg missing `legacyLocalSettingsSeed`:** add the key to
   `net09_config_preservation.rs`'s seed + watched set (byte-preserved across configure +
   restart).
5. **G5 — the named `PW-RUST` spec:** author
   `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts` (spawn an owned rust binary against
   an isolated seeded home — cfg03 precedent bypassing the fixtures'
   `ensureSetupWizardBypassConfig` — drive writers 1-6 via authed REST, deep-compare the file
   after EACH action allowing only that writer's intended paths to differ, then a final
   restart/no-op-boot leg asserting zero unintended drift). Register rust-only: it rides
   Rust's deliberately-**stronger** guarantees (sibling secrets survive; legacy's
   normalization persist drops them), so legacy cannot be a parity control — same registration
   shape as `diag03` (added to `RUST_ONLY_SPECS` + `rust-chromium` `testMatch`).

### Explicit non-goals (owned by other items)

- CFG-02 write-serialization queue (not in flight; existing `ConfigLock` is Rust-vs-Rust
  advisory only — unchanged).
- CFG-03 backup/restore UX, CFG-11 crash-mid-write atomicity legs, CFG-09 MRU learning,
  CFG-06 live-read freshness, CFG-10 migration idempotence semantics.
- `settings`-internal unknown-subkey preservation (dropped by BOTH servers — frozen-parity).
- Title-migration / recent-directory **writers** do not exist in Rust; only their keys'
  preservation is this item.

## Tasks (TDD; regression-pinning posture — see RED protocol)

The lossless writer landed in `6e3af242`; these tests pin it. RED protocol for each new/strengthened
test: (a) author, run GREEN against the real code; (b) **hand-splice** a regression into a scratch
checkout of `persist()` (rebuild-from-fixed-key-set, per `git show 6e3af242^`), re-run → must go RED;
(c) restore, re-run GREEN; record both in evidence. Never commit the spliced state.

### Task 1 — crate: shared sentinel fixture breadth (G1)
- Extend `lossless_fixture_text()`: add `legacyLocalSettingsSeed` (a valid seed object),
  a sibling secret `serverSecrets.futureSiblingSecret`.
- Extend `assert_unmanaged_document_state_preserved()` with both.
- Run the three existing writer tests (GREEN), splice-RED, restore.
- Command: `cargo test -p freshell-server --lib settings_store::` (focused filters per test).

### Task 2 — crate: project-color writer × full fixture (G2)
- New test `project_color_write_preserves_unmanaged_top_level_document_state` beside the three
  siblings, same fixture + helper, driving `set_project_color`.
- GREEN → splice-RED → restore.

### Task 3 — crate: boot normalization persist × full fixture (G3)
- Two tests beside the CFG-04 boot family:
  - `boot_persist_known_providers_seed_preserves_unmanaged_document_state` — fixture with
    `knownProviders` absent → `load()` seeds + persists; assert sentinels + seeded list.
  - `boot_persist_legacy_seed_strip_preserves_unmanaged_document_state` — fixture with stray
    browser-local keys inside `settings` → strip persist; assert sentinels + seed written.
- GREEN → splice-RED → restore.

### Task 4 — crate integration: net09 seed breadth (G4)
- Add `legacyLocalSettingsSeed` sentinel to `net09_config_preservation.rs` seed + watched set
  (byte-preservation across configure + restart). Run:
  `cargo test -p freshell-server --test net09_config_preservation`.

### Task 5 — PW-RUST spec (G5, deferred-with-probe)
- `cfg01-lossless-writes.spec.ts` per G5 above. Actions: PATCH settings; PATCH terminal rename
  + DELETE terminal delete (arbitrary ids — overrides are keyed maps, no live PTY needed);
  PATCH session override; PUT project-colors; POST network disable-remote-access (loopback
  rebind — safe on owned server); provider-migration boot leg (restart over a stale
  knownProviders home); startup-normalization leg (second isolated home with stray local keys).
  Deep-compare helper: parse before/after, compute the differing top-level paths, assert the
  diff set ⊆ writer's intended set (exact equality on every sentinel key).
- Register: `RUST_ONLY_SPECS` + rust-chromium `testMatch` (with comment).
- Probe once: `npx playwright test --project=rust-chromium cfg01-lossless-writes` against a
  built binary (build via cargo, sandbox NOT required — non-destructive spec).

### Task 6 — evidence + checklist hygiene
- `docs/plans/df1-evidence/CFG-01.md`: red/green proofs, splice evidence, probe output, final
  SHA, residual gaps (none expected beyond the documented non-goal divergences).
- df1ctl heartbeat ≥15min; final state review/COMPLETED.

## Verification (final, at HEAD)

- `cargo fmt --check` + `cargo clippy -p freshell-server --all-targets -- -D warnings`
- `cargo test -p freshell-server --lib settings_store` (+ `--test net09_config_preservation`)
- `npm run test:vitest -- run <touched vitest files none expected>` — n/a unless helpers touched
- PW probe: `npx playwright test --config test/e2e-browser/playwright.config.ts
  --project=rust-chromium cfg01-lossless-writes` (once; twice if flaky)
- No host-destructive legs in this item (crash-mid-write is CFG-11's; nothing here needs the
  sandbox lease).
