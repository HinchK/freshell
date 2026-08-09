# CFG-04 — Restore automatic legacy browser-preference seeding — df1 evidence

**Branch:** `df1/cfg-04-browser-seed` (base `origin/df1/integration` @ `4c2297667`) · **Date:** 2026-08-09 · **Playwright posture:** `deferred`

IMPLEMENTED (2026-08-09, df1 worker `df1-cfg-04-browser-seed`): the Rust server now extracts,
merges, persists, and bootstrap-returns `legacyLocalSettingsSeed` with byte-fidelity to the
frozen legacy server (`server/config-store.ts` + `server/shell-bootstrap-router.ts` +
`shared/settings.ts` as parity source). The client consumption + one-time marker already
existed and are unchanged (proven pre-existing by the repo's own unit suites, re-run green on
this branch).

- **Extraction/merge port** — `crates/freshell-server/src/legacy_local_seed.rs` (new).
  `extract_legacy_local_settings_seed` + `merge_legacy_seeds` port
  `extractLegacyLocalSettingsSeed`/`normalizeExtractedLocalSeed` and the seed half of
  `mergeLocalSettings`: all five item categories (theme, browser-local sidebar presentation,
  scale, terminal font, sound) plus panes/freshAgent/streamDeck for contract completeness;
  enum drops, numeric clamps-with-rounding exactly where the legacy clamps, default-fills
  (`sortMode`/`worktreeGrouping`, incl. `hybrid`→`activity` and null→default), the
  `ignoreCodexSubagentSessions`→`ignoreCodexSubagents` alias (canonical-present always wins,
  even when invalid), the `agentChat`→`freshAgent` per-key canonical-wins alias, and JS number
  serialization (integral floats persist as `1`, never `1.0`) for byte-stable side-by-side
  operation. 15 module tests byte-pinned against the REAL legacy functions executed via tsx
  on the frozen base (oracle battery), several asserting byte-equality with
  `JSON.stringify` output, not just value equality.
- **Boot wiring** — `crates/freshell-server/src/settings_store.rs`. `SettingsStore::load`
  extracts/merges the seed AFTER the CFG-03 backup restore (so the recovered document is what
  is read); the seed is held immutable for the process life (legacy cache parity), accessor
  `legacy_local_settings_seed()`. `persist()` owns the top-level key: written from memory when
  present, REMOVED when `None` (JS `JSON.stringify`-drops-`undefined` parity — never `null` on
  disk). The boot normalization persist fires on the seed-scoped half of
  `shouldPersistNormalizedConfig`: local keys found inside `settings` (stripped by the typed
  tree), or merged seed ≠ raw stored key (incl. garbage/un-normalizable seed removal). Server
  keys (`sidebar.excludeFirstChatSubstrings`/`excludeFirstChatMustStart`, the SESSION-13
  surface) remain in the typed tree and on disk — proven by test, untouched by design.
- **Bootstrap return** — `crates/freshell-server/src/boot.rs`. `GET /api/bootstrap` includes
  `legacyLocalSettingsSeed` when (and only when) a seed exists, in the original's payload key
  order (settings, seed, platform, shell, perf); absent, never `null`. Payload assembly
  extracted to the pure, unit-tested `bootstrap_payload`. The seed remains bootstrap-only:
  nothing added to `/api/settings`, WS snapshots, or `settings.updated` — the typed
  `ServerSettings` cannot carry it by construction.

**PROVEN (crate + unit level, all green twice where flaky-prone):**

- `cargo test -p freshell-server` (all targets): 592 passed / 0 failed, at final SHA, two runs.
  Includes 15 new `legacy_local_seed` fixture tests (byte-parity vs the Node oracle) and 7 new
  `settings_store` integration tests: mixed-legacy boot extracts+strips+seeds all five
  categories while `excludeFirstChat*` stay server-backed; boot persist writes the top-level
  seed and strips local keys from `settings`; **second boot is byte-stable** (the seed
  change-check converges — the one-time-marker server-side analog); stored-seed-wins merge
  precedence with extracted strays preserved; seed survives an unrelated PATCH
  (CFG-01-style losslessness for this writer); fresh installs never synthesize/write a seed;
  garbage stored seeds (`"nope"`, `{"theme":"neon"}`) are removed from disk at boot.
- Focused legacy/client regression suites green (no TS changes were needed):
  `config-store.test.ts` + `bootstrap-router.test.ts` (75/75, server config),
  `browser-preferences.test.ts` + `browserPreferencesPersistence.test.ts` (20/20),
  `App.test.tsx` + `terminal-font-settings.test.tsx` (36/36, incl. the four
  `legacyLocalSettingsSeed` bootstrap-consumption tests and the
  does-not-reapply-after-reset-to-default marker test).
- `cargo clippy -p freshell-server --all-targets -- -D warnings` clean; `cargo fmt --check` clean.

**Playwright (deferred — authored, intentionally unrun by the worker):**

- `test/e2e-browser/specs/cfg04-legacy-browser-seed.spec.ts` (new, matrix-registered in
  `MATRIX_SPECS`) mirrors the checklist validation text exactly: pre-split mixed legacy
  config + empty browser storage → open → every visible seeded preference asserted in resolved
  settings (theme/scale/font/sidebar presentation/sound + exclusion retention) → blob holds the
  seed with `legacyLocalSettingsSeedApplied: true` → reload ×2 still resolves → user change to
  `dark` → reload → stale server seed (`light`) NOT re-applied (the one-time marker clause) →
  disk assertions (seed top-level, local keys stripped, exclusions intact). One authoring-time
  review fix landed pre-registration: `collapsed` was removed from the fixture because a
  collapsed sidebar unmounts the sidebar Settings button the user-change step clicks
  (`App.tsx`'s `{!sidebarCollapsed && <Sidebar/>}`) — `collapsed` remains covered at crate
  level instead.
- `test/e2e-browser/specs/settings-persistence-split.spec.ts`: the rust-leg `test.fail`
  annotation ("CFG-04/SESSION-13: legacyLocalSettingsSeed not implemented in Rust") is REMOVED
  — the gap it pinned is what this item implemented; the spec comment now records the history.
  SESSION-13's own replication/apply scope is unchanged and unaffected (this spec never
  interacts with the exclusion knobs).
- Static parity check (no Playwright run allowed under `deferred`): own-file `tsc` strict
  one-shot error count equals the sibling `settings-persistence-split.spec.ts` baseline (5==5,
  identical classes — artifacts of running outside the repo tsconfigs, which intentionally
  exclude `test/`).

**MISSING (explicit, by campaign policy):** neither spec has been EXECUTED in this phase
(`spec-authored-unrun: test/e2e-browser/specs/cfg04-legacy-browser-seed.spec.ts`); the
close-out campaign's matrix pass is the executor, with the crate+legacy suite evidence above
as the interim proof. DIAG-07's bootstrap byte-budget remains unowned by this item (pre-existing
on Rust; unchanged).
