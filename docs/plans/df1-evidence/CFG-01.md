# CFG-01 evidence — lossless `config.json` writes

**Item:** Make every `config.json` write lossless (preserve `sessionOverrides`,
`terminalOverrides`, `projectColors`, `recentDirectories`, `completedMigrations`,
`legacyLocalSettingsSeed`, Codex secrets, unknown future keys — on every writer).
**Branch:** `df1/cfg-01-lossless-writes` (base `origin/df1/integration` @ `5521f3aba`).
**Plan:** `docs/plans/df1/CFG-01.md` (writer inventory, gap matrix G1–G5, non-goals).

## State on base (verified, not assumed)

The lossless writer itself landed in Batch A (`6e3af242`, already an ancestor of
`origin/df1/integration`): `SettingsStore::persist()` reads the on-disk document and
overlays only owned keys, copy-forwarding everything else; Batch B added the
adopt-from-disk + dirty-key overlay for `sessionOverrides`/`terminalOverrides`/
`projectColors` and the advisory `ConfigLock`; CFG-03 added the atomic backup refresh;
CFG-04 added `legacyLocalSettingsSeed` ownership. **Every** production `config.json`
write funnels through `persist()` (exhaustive grep+read sweep: settings PATCH,
terminal override PATCH/DELETE, session override PATCH, project-color PUT, network
mutations via `settings.patch`, boot normalization persist; `instance_id.rs` and
`session_metadata.rs` write separate files; only test code writes `config.json`
directly). Legacy parity source read: `server/config-store.ts` `saveInternal` /
`{...existing, ...updates}` (:344-362 etc.). Legacy's OWN normalization rebuild drops
unknown keys *inside* `settings` and sibling secrets — Rust is a deliberate superset;
both divergences are documented in the plan as non-goals (frozen parity).

## What this item added

### Crate coverage (TDD regression-pinning — RED protocol below)

1. **G1 — shared sentinel breadth** (`settings_store.rs` `lossless_fixture_text()` +
   `assert_unmanaged_document_state_preserved()`): added `legacyLocalSettingsSeed`
   (CFG-04 ownable key, canonical order per `seeded_boot_is_byte_stable_on_second_boot`)
   and a **sibling** secret `serverSecrets.futureSiblingSecret`. One change strengthens
   all three existing writer legs (settings patch, terminal-override patch,
   session-override patch).
2. **G2 —** `project_color_write_preserves_unmanaged_top_level_document_state`: the
   project-color writer (`PUT /api/project-colors` → `set_project_color`) against the
   full sentinel fixture (the existing project-color family used reduced fixtures).
3. **G3 —** `boot_provider_seed_persist_preserves_unmanaged_top_level_document_state`
   and `boot_seed_strip_persist_preserves_unmanaged_top_level_document_state`: the two
   boot-time normalization persist triggers (`knownProviders` seed; stray-local-key
   strip) against the full sentinel fixture incl. pre-existing override/color entries.
4. **G4 —** `tests/net09_config_preservation.rs`: added the `legacyLocalSettingsSeed`
   sentinel to the spawned-real-binary network-writer byte-preservation + restart leg.

### PW-RUST spec (the reconciliation-named missing piece)

5. **G5 —** `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`, registered
   rust-only (`RUST_ONLY_SPECS` + rust-chromium `testMatch`; not `MATRIX_SPECS` —
   legacy cannot be a parity control for guarantees it never provided, see the spec's
   doc comment). Two tests:
   - *every REST writer preserves all sentinels; restart writes nothing* — fresh boot
     lands the first write; sentinel block injected (incl. sibling secret, keeping the
     server's own minted codex secret); **restart leg** asserts a fully-normalized
     config boots to a semantic no-op (zero diff paths); then six writer actions
     (settings save, terminal rename, terminal delete, session mutation, project
     color, network configure) each followed by a structural deep-compare of
     `config.json` allowing ONLY that writer's intended paths (diff paths are key
     arrays — session keys contain `:`, project paths contain `/`) plus per-key
     sentinel deep-equality; final cumulative diff ⊆ union of intended paths.
   - *boot writers preserve all sentinels* — `knownProviders` removed AND stray
     browser-local keys injected into `settings` (both boot triggers fire on one
     boot); diff ⊆ `{settings.codingCli.knownProviders, settings.theme,
     settings.uiScale, legacyLocalSettingsSeed}`; seed content asserted.
   - Provider discovery is pinned EMPTY (`FRESHELL_EXTENSIONS_DIR` + neutral cwd) so
     `knownProviders: []` boot behavior is deterministic.
   - Named writers that do not exist in Rust (recent-directory MRU — CFG-09 open;
     title migrations) are covered as preservation sentinels, documented in the spec.

### Typecheck gate

`test/e2e-browser/tsconfig.cfg01-check.json` (house per-item convention, mirrors
TERM-04/HARNESS-05): `npx tsc -p test/e2e-browser/tsconfig.cfg01-check.json` →
**zero errors attributed to the spec** (13 output lines, all the pre-existing
`helpers/fixtures.ts` worker-scope tuple error that reproduces identically on base).

## RED/GREEN proofs

### Crate

- **GREEN (real code):** `cargo test -p freshell-server --bin freshell-server
  settings_store::` → 60 passed, 0 failed (includes the 3 extended + 3 new lossless
  tests). `cargo test -p freshell-server --test net09_config_preservation` → 1 passed.
- **RED (hand-spliced regression, never committed):** `persist()` body replaced with
  the pre-`6e3af242` fixed-key-set rebuild (`git show 6e3af242^:...`; drops
  `completedMigrations`/`legacyLocalSettingsSeed`/sibling secret/`zzFutureKey`,
  empties `recentDirectories`). Result: ALL SIX lossless tests FAILED
  (`settings_patch_…`, `terminal_override_patch_…`, `session_override_patch_…`,
  `project_color_write_…`, `boot_provider_seed_persist_…`,
  `boot_seed_strip_persist_…`); control `agent_chat_key_rejected` still passed
  (splice is surgical). Restored via `git reset --hard HEAD` (green checkpoint
  commit) → 60/60 GREEN again.
- **net09 rationale:** the seed key is written from memory by `persist()`; the
  restart leg proves a stored canonical seed needs no normalization write (else the
  byte-hash compare would catch it).

### PW probe (deferred-with-probe posture: authored on the item branch, probed here)

`npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium cfg01-lossless-writes` (each run rebuilds client+server via global setup; the spec itself builds/uses `target/release/freshell-server` at the branch HEAD):

- Run 1 (authored spec): **1 failed / 1 not-run** — deterministic SPEC-logic bug, found by the
  probe exactly as intended: the per-action sentinel check ran bit-for-bit on the
  writer-under-test's own managed key (`terminalOverrides` during the rename leg).
- Run 2 (containment semantics added): **1 failed / 1 not-run** — second deterministic
  spec-logic bug of the same class, one leg later: the delete leg legitimately mutates the
  rename leg's entry (`+deleted:true`); containment needed a mutation-target exception with
  field-level survival.
- Run 3: **2 passed (22.5s)** — all legs green: restart zero-diff, settings save, terminal
  rename, terminal delete, session mutation, project color, network configure, cumulative
  deep-compare, both boot-writer triggers.
- Run 4 (confirmation, final spec SHA `1ce0e7528`): **2 passed (47.7s)** — two consecutive
  greens; earlier failures were deterministic assertion-semantics fixes, not flakes.

No product bug found by the probe (the writer was already lossless on base); the probe's
value-add was hardening the spec's own assertion semantics into non-vacuous form
(writer-targeted keys use allowed-path diff restriction + entry containment, everything else
bit-for-bit).

### Review loop

No `Task` tool exists in this harness; the freshell-pane agent attempt (`new-tab
agent=opencode`) timed out server-side with no tab created. **Fallback used:** fresh review
subagent via `opencode run` CLI (read-only review-agent rules), cwd = the worktree. Findings
recorded below after it returns.

## Residual gaps / honest limits

- `settings`-internal unknown subkeys: dropped by BOTH servers (typed/`mergeServerSettings`
  fixed-key normalization) — frozen parity, not a CFG-01 loss mode.
- Settings cross-PROCESS conflict (legacy edits `settings.defaultCwd` while Rust runs;
  Rust's next patch overlays `settings` wholesale): the documented, accepted Batch-B
  residual; CFG-02's serialization queue (not in flight) is the follow-up surface.
- Crash-MID-WRITE atomicity (torn tmp/rename legs) is CFG-11's acceptance, not this
  item's; the destructive sandbox legs belong to that item.
- The PW spec runs the writer legs against REST endpoints with no live PTYs; terminal
  rename's session-cascade and session rename's terminal-cascade are no-ops for unknown
  IDs (by design of the store keys) — cascade parity itself is owned by SESSION-03/TERM-*.
