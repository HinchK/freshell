# CFG-04 — Restore automatic legacy browser-preference seeding (Rust parity)

**Item (verbatim):** *Restore automatic legacy browser-preference seeding. Return and consume `legacyLocalSettingsSeed` once for a fresh WebView/browser profile, including theme, browser-local sidebar presentation, scale, terminal font, and sound. Server-backed first-chat exclusions remain in `config.json` and are covered by `SESSION-13`.*

**Playwright validation text (checklist):** *Start with seeded legacy settings and empty browser storage, open Rust, assert every visible preference, reload twice, and verify the one-time migration marker prevents stale seed values from overwriting a later user change.*

## Parity source

**Frozen legacy `server/` on `origin/df1/integration`** (base `4c2297667`), specifically:

- `server/config-store.ts` `ConfigStore.loadInternal` (lines ~318-399): boot-time extraction
  `extractLegacyLocalSettingsSeed(rawSettings)`, merge `mergeLocalSettings(extracted, storedSeed)`
  (stored wins), strip of local keys from the live `settings` tree, and the
  `shouldPersistNormalizedConfig` boot re-persist (settings changed OR seed changed).
- `server/shell-bootstrap-router.ts`: bootstrap-only return — `...(legacyLocalSettingsSeed ? { legacyLocalSettingsSeed } : {})`, never in WS snapshots/broadcasts.
- `shared/settings.ts`: the extraction/normalization contract — `extractLegacyLocalSettingsSeed`,
  `normalizeExtractedLocalSeed`, `mergeLocalSettings`, the local key pick-lists
  (`TERMINAL_LOCAL_KEYS`, `PANES_LOCAL_KEYS`, `SIDEBAR_LOCAL_KEYS`, `FRESH_AGENT_LOCAL_KEYS`),
  enum value lists, clamp ranges, and the `ignoreCodexSubagentSessions`→`ignoreCodexSubagents`
  plus `agentChat`→`freshAgent` legacy aliases.

The **client side already exists and is untouched by this item** (proven by green unit tests):
`src/App.tsx` consumes `bootstrapData.legacyLocalSettingsSeed` once via
`seedBrowserPreferencesSettingsIfEmpty` / `patchBrowserPreferencesRecord({legacyLocalSettingsSeedApplied: true})`;
the one-time marker `legacyLocalSettingsSeedApplied` lives in the
`freshell.browser-preferences.v1` localStorage blob (`src/lib/browser-preferences.ts`).

## Gap (today, Rust)

`crates/freshell-server` has zero matches for the seed. Concretely:

1. `SettingsStore::load` (`crates/freshell-server/src/settings_store.rs`) never extracts the
   seed; a legacy mixed `config.json` boots with local keys silently dropped by typed
   `ServerSettings` deserialization and **no seed ever created**.
2. `persist()` rewrites `settings` from the typed tree (losslessly for top-level keys via
   copy-forward), so the next write permanently deletes the local fields **without seeding —
   the preference data is lost**; a pre-existing top-level seed survives only by accident of
   copy-forward, never normalized/merged.
3. `GET /api/bootstrap` (`crates/freshell-server/src/boot.rs`) never returns the seed, so the
   fresh-profile client has nothing to consume.

The rust leg of `test/e2e-browser/specs/settings-persistence-split.spec.ts` is a committed
`test.fail` pinning this exact gap.

## Architecture

1. **New crate module `crates/freshell-server/src/legacy_local_seed.rs`** — a faithful Rust port
   of `extractLegacyLocalSettingsSeed` + `normalizeExtractedLocalSeed` (pick lists, legacy
   aliases, enum validation, clamping) and the seed-merge half of `mergeLocalSettings`, plus a
   `js_number` helper so integral floats serialize like JS (`1`, not `1.0`) for byte-stable
   side-by-side operation with the legacy server.
2. **`SettingsStore` integration** — extract+merge at boot *after* the CFG-03 backup restore
   (so the restored document is what gets read), hold the seed in memory, accessor
   `legacy_local_settings_seed()`, a seed-scoped boot normalization persist (stripped local keys
   → disk, merged seed → disk), and `persist()` ownership of the top-level
   `legacyLocalSettingsSeed` key (write when `Some`, remove when `None` — mirroring
   `JSON.stringify` dropping an `undefined` key).
3. **`GET /api/bootstrap`** — include `legacyLocalSettingsSeed` when present, placed after
   `settings` (Node payload order). Payload assembly extracted into a pure, unit-testable
   function.
4. **Playwright (authored, unrun — `deferred` posture)** — new matrix spec
   `cfg04-legacy-browser-seed.spec.ts` mirroring the checklist validation text + registration in
   `MATRIX_SPECS`; remove the now-implemented `test.fail` rust annotation from
   `settings-persistence-split.spec.ts`.

### Non-goals (explicitly out of this item)

- SESSION-13 (first-chat exclusion replication/application) — the exclusions only need to
  *remain* server-backed on disk here (`SettingsSidebar` typed fields; untouched).
- DIAG-07 (bootstrap budget/truthfulness beyond the seed field).
- CFG-12 (two-context per-profile split) beyond what the flipped spec already proves.
- Any change to `GET /api/settings`, WS snapshots, or `settings.updated` (seed stays
  bootstrap-only) or to the already-correct client.

## Acceptance evidence (definition of done for `deferred` posture)

- New Rust crate tests green: extractor fidelity vs a Node-oracle battery (all five item
  categories: theme, sidebar presentation, scale, terminal font, sound — plus panes/freshAgent/
  streamDeck for contract completeness), stored-wins merge precedence, boot normalization
  persist (mixed legacy config → seed on disk + local keys stripped from `settings`), second-boot
  byte-stability, seed survives an unrelated PATCH, absent-seed fresh install unchanged.
- Focused existing TS suites green (client consumption + legacy server contract regression):
  `test/unit/server/config-store.test.ts`, `test/unit/client/lib/browser-preferences.test.ts`,
  `test/unit/client/store/browserPreferencesPersistence.test.ts`,
  `test/unit/client/components/App.test.tsx`, `test/e2e/terminal-font-settings.test.tsx`,
  `test/integration/server/bootstrap-router.test.ts`.
- `settings-persistence-split.spec.ts` rust `test.fail` removed (implementation landed);
  `cfg04-legacy-browser-seed.spec.ts` authored + registered in `MATRIX_SPECS`
  (`spec-authored-unrun` in df1 status).
- `cargo fmt --check` + `cargo clippy -p freshell-server` clean; typecheck clean where scoped.
- Evidence file `docs/plans/df1-evidence/CFG-04.md` in checklist annotation style.

## Global constraints

- Work only in this worktree; commit at every phase boundary; never push/PR.
- Focused tests only: `cargo test -p freshell-server …`, `npm run test:vitest -- run <files>`.
  No broad suite without the gate lease. No Playwright run (posture: `deferred`).
- nice/ionice for all builds/tests.
- NodeNext/ESM for TS; relative imports keep `.js` extensions.
- The seed must remain **bootstrap-only** server-side: never in `/api/settings`, never in any WS
  message (`test/server/ws-handshake-snapshot.test.ts` pins this for legacy; Rust's typed
  `ServerSettings` cannot carry it by construction — keep it that way).

---

## Task 1: `legacy_local_seed.rs` — extractor + merge port

**Files:**
- Create: `crates/freshell-server/src/legacy_local_seed.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod legacy_local_seed;`)
- Test: in-module `#[cfg(test)]` tests (crate convention)

**Interfaces (produced):**
- `pub fn extract_legacy_local_settings_seed(raw: &Value) -> Option<Value>`
  — port of `extractLegacyLocalSettingsSeed` + `normalizeExtractedLocalSeed`. Input: the raw
  `settings` object (or, reused, the raw stored seed object). Output: normalized
  `LocalSettingsPatch` JSON, `None` when nothing valid survives.
- `pub fn merge_legacy_seeds(extracted: Option<&Value>, stored: Option<&Value>) -> Option<Value>`
  — `mergeLocalSettings(extracted, stored)` restricted to already-normalized patches: per-key
  `mergeDefined` per section, stored (patch) wins.

**Semantics pinned exactly** (each has a test):

- Top-level: `theme` (enum `system|light|dark`, invalid dropped), `uiScale` (finite number,
  clamped to `[0.75, 4]`, not rounded).
- `terminal`: `fontSize` (round+clamp `[12,64]`), `fontFamily` (any string, incl. empty),
  `lineHeight` (clamp `[1,1.8]`, not rounded), `cursorBlink` (bool), `theme` (enum of 8 terminal
  themes), `warnExternalLinks` (bool), `osc52Clipboard` (`ask|always|never`), `renderer`
  (`auto|webgl|canvas`).
- `panes`: `snapThreshold` (round+clamp `[0,8]`), `iconsOnTabs`/`multirowTabs`/`repoIconsOnTabs`
  (bool), `tabAttentionStyle` (`highlight|pulse|darken|none`), `attentionDismiss` (`click|type`),
  `sessionOpenMode` (`tab|split`), `tabBarRows` (round+clamp `[1,10]`).
- `sidebar`: `sortMode` (**hybrid→`activity`, other invalid→`activity`, not dropped**),
  `worktreeGrouping` (invalid→`repo`, not dropped), `showProjectBadges`/`showSubagents`/
  `ignoreCodexSubagents`/`showNoninteractiveSessions`/`hideEmptySessions`/`collapsed` (bool),
  `width` (round+clamp `[200,500]`). Alias: `ignoreCodexSubagentSessions` (bool) maps to
  `ignoreCodexSubagents` when the canonical key is absent.
- `freshAgent`: read from shallow alias-merge `{...agentChat, ...freshAgent}` (canonical wins);
  `showThinking`/`showTools`/`showTimecodes` (bool).
- `notifications`: `soundEnabled` (bool).
- `streamDeck`: `enabled` (bool), `brightness`/`idleBrightness`/`idleTimeoutSeconds` (any
  finite number — **no clamp**, typeof-check only), `tileStyle`
  (`status-icons|terminal-previews`), `keyLayout` (`auto|newest-first|status-sorted`).
- Numbers serialize JS-style: integral floats → integer JSON (`js_number`).
- `None` (not `Some({})`) when the normalized patch is empty; non-object input → `None`.

**Steps (strict TDD):**

- [ ] Step 1: Generate the Node-oracle battery. Throwaway script
  `/tmp/opencode/cfg04-oracle.ts` run with the repo's `tsx`: feeds ~14 fixtures through the REAL
  `extractLegacyLocalSettingsSeed`/`mergeLocalSettings` from `shared/settings.ts` and prints
  `JSON.stringify` of results. Fixtures: (a) full mixed legacy settings (all five item
  categories), (b) out-of-range uiScale/fontSize/width/snapThreshold/tabBarRows (clamp+round
  proof), (c) invalid theme/terminal.theme/renderer/osc52/tileStyle/keyLayout (drop proof),
  (d) hybrid sortMode + invalid worktreeGrouping (default-fill proof), (e)
  `ignoreCodexSubagentSessions` alias + canonical-key-beats-alias case, (f) `agentChat` alias
  vs canonical `freshAgent` precedence on `showThinking`, (g) empty object → undefined,
  (h) non-object input → undefined, (i) merge: stored theme beats extracted theme,
  (j) merge: extracted-only section (terminal) survives beside stored-only section
  (notifications), (k) boolean-invalid members dropped, (l) uiScale integral `1` → `1`
  serialization, (m) streamDeck floats unclamped, (n) null members dropped. Paste printed
  outputs verbatim into the Rust tests as `json!({...})` expectations.
- [ ] Step 2: Write the Rust test module (red — module doesn't exist yet).
- [ ] Step 3: Run `nice -n 19 cargo test -p freshell-server legacy_local_seed` → compile error
  (red confirmed).
- [ ] Step 4: Implement `legacy_local_seed.rs` (port the two functions + `js_number` +
  key/enum/clamp tables).
- [ ] Step 5: Re-run focused tests → green. `nice -n 19 cargo clippy -p freshell-server` and
  `cargo fmt` clean.
- [ ] Step 6: Commit `feat(df1 CFG-04): port legacyLocalSettingsSeed extraction+merge to Rust`.

## Task 2: `SettingsStore` boot integration + persist ownership

**Files:**
- Modify: `crates/freshell-server/src/settings_store.rs`
  (`SettingsStore` field, `load`, accessor, `persist`, `load_legacy_local_settings_seed` helper)

**Interfaces:**
- Consumes: `crate::legacy_local_seed::{extract_legacy_local_settings_seed, merge_legacy_seeds}`.
- Produces: `pub fn legacy_local_settings_seed(&self) -> Option<Value>` (clone out; the field is
  immutable after construction — plain `Option<Value>`, no lock, matching `config_fallback`).

**Semantics:**
- In `load`, AFTER `maybe_restore_config_from_backup(home)` (CFG-03 restore must win the file
  first) and alongside `load_full_settings`: tolerant re-read of `config.json`; extract raw
  `settings`, extract raw stored seed (only if object), merged = `merge_legacy_seeds(extracted,
  stored)`.
- Boot normalization persist trigger (scoped to the seed machinery): persist when
  `extracted.is_some()` (local keys were inside `settings` and were stripped from the typed
  tree) OR `merged.as_ref() != stored_raw.or(None-if-non-object)` — i.e. the merged seed differs
  from the raw stored key, including `Some`↔`None` transitions. Combined with the existing
  `needs_persist`. Persist failures keep the boot alive with in-memory values (existing
  `eprintln!` convention, mirroring legacy's warn-and-continue).
- `persist()`: `map.insert("legacyLocalSettingsSeed", seed)` when `Some`, else
  `map.remove("legacyLocalSettingsSeed")` (owned key; JS `undefined`⇔absent parity).
- Fresh install (no config): seed `None`; first persist (knownProviders seeding) writes no seed
  key.

**Steps:**

- [ ] Step 1: Write failing store tests (temp-home convention
  `std::env::temp_dir().join(format!("frs-cfg04-{}", uuid_like()))`, `store_at(dir)` helper):
  1. legacy mixed config → `legacy_local_settings_seed()` == full expected seed; live
     `get().await` has no local fields; `excludeFirstChatSubstrings` intact;
  2. same config → after boot, disk `config.json` has top-level seed (normalized) and
     `settings` stripped of `theme`/`uiScale`/local sidebar/terminal/notifications keys, with
     `sidebar.excludeFirstChatSubstrings` preserved;
  3. second boot of the normalized file → config bytes identical (byte-stability);
  4. stored seed + stray local key in settings → stored wins on conflict, extracted-only section
     kept;
  5. fresh empty home → `legacy_local_settings_seed()` is `None`, and after an unrelated PATCH
     the disk config still has NO seed key;
  6. unrelated PATCH after a seeded boot leaves the disk seed equal (`PATCH losslessness`);
  7. invalid stored seed shape (`"legacyLocalSettingsSeed": "nope"` / `{theme: "neon"}`) →
     seed `None`, disk key dropped after boot.
- [ ] Step 2: `nice -n 19 cargo test -p freshell-server settings_store` → red on new tests.
- [ ] Step 3: Implement store changes.
- [ ] Step 4: Green; run the FULL `settings_store` module tests + `legacy_local_seed` (no
  regressions); clippy/fmt.
- [ ] Step 5: Commit `feat(df1 CFG-04): extract/merge/persist legacyLocalSettingsSeed in SettingsStore`.

## Task 3: `GET /api/bootstrap` returns the seed

**Files:**
- Modify: `crates/freshell-server/src/boot.rs`
- Test: `crates/freshell-server/src/boot.rs` `#[cfg(test)]` (pure payload builder)

**Interfaces:**
- Produces: `pub(crate) fn bootstrap_payload(settings: &ServerSettings, legacy_local_settings_seed: Option<Value>, platform: &Value) -> Value`
  — pure builder emitting `{ settings, [legacyLocalSettingsSeed], platform, shell, perf }` in
  Node's key order; the `bootstrap` handler becomes auth-gate + one call.
- Consumes: `SettingsStore::legacy_local_settings_seed()` (Task 2), existing `state.settings.get().await`.

**Steps:**

- [ ] Step 1: Write failing tests: seed present → field appears after `settings` with exact
  content; seed `None` → field absent; existing `shell`/`perf` shape unchanged.
- [ ] Step 2: `nice -n 19 cargo test -p freshell-server boot::` → red.
- [ ] Step 3: Implement builder + handler wiring.
- [ ] Step 4: Green; full `boot` module tests green; clippy/fmt.
- [ ] Step 5: Commit `feat(df1 CFG-04): return legacyLocalSettingsSeed from /api/bootstrap`.

## Task 4: Playwright spec authoring (deferred — unrun) + annotation flip

**Files:**
- Create: `test/e2e-browser/specs/cfg04-legacy-browser-seed.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (one additive `MATRIX_SPECS` regex line)
- Modify: `test/e2e-browser/specs/settings-persistence-split.spec.ts` (remove the rust
  `test.fail` + its stale "not implemented" comment)

**Spec content (mirrors the checklist validation text, both matrix kinds):**
- `testServer` worker fixture seeds a LEGACY MIXED `config.json` via `setupHome` (pre-split
  shape: `theme:'light'`, `uiScale:1.25`, `terminal:{scrollback:4000,fontSize:18,fontFamily:'Fira Code'}`,
  `sidebar:{excludeFirstChatSubstrings:['welcome'],excludeFirstChatMustStart:false,sortMode:'project',width:280,collapsed:true}`,
  `notifications:{soundEnabled:false}`, plus the standard network/claude-cwd boilerplate copied
  from `settings-persistence-split.spec.ts`). No top-level seed.
- Fresh context A, `?e2e=1`, `waitForReady` (helpers copied from the sibling spec): assert
  resolved settings — theme `light`, `uiScale` 1.25, `terminal.fontSize` 18,
  `terminal.fontFamily` 'Fira Code', `sidebar.sortMode` 'project', `sidebar.width` 280,
  `sidebar.collapsed` true, `notifications.soundEnabled` false — and
  `sidebar.excludeFirstChatSubstrings` still `['welcome']` (server-backed retention, SESSION-13
  boundary).
- Assert the browser blob: `settings.theme === 'light'` and
  `legacyLocalSettingsSeedApplied === true`.
- Reload #1: seeded values still resolved; reload #2: ditto (blob-backed now).
- User change: open Settings → Appearance, click `dark`; wait for blob theme `dark`; reload;
  assert `dark` still resolved (stale server seed saying `light` must NOT be re-applied — the
  marker clause).
- Disk assertions: `config.json` top-level `legacyLocalSettingsSeed` matchObject the five item
  categories; `settings.theme`/`settings.uiScale`/`settings.notifications` absent;
  `settings.sidebar.excludeFirstChatSubstrings` still `['welcome']`.
- File doc-comment records: matrix wiring, CFG-04 ownership, `spec-authored-unrun` per the df1
  deferred-Playwright policy (close-out campaign executes it).

**Steps:**

- [ ] Step 1: Write the spec (copies the proven scaffolding of `settings-persistence-split.spec.ts`).
- [ ] Step 2: Register ` /cfg04-legacy-browser-seed\.spec\.ts$/ ` in `MATRIX_SPECS` (one line).
- [ ] Step 3: Remove the rust `test.fail` annotation (+ rewrite the stale comment) in
  `settings-persistence-split.spec.ts` — its seed assertions now pass on Rust by construction
  (crate-level proven); document the unrun flip in the evidence file.
- [ ] Step 4: Static checks only (no run): the repo's typecheck over the e2e tsconfig, and
  lint of the touched files if scoped lint is supported.
- [ ] Step 5: Commit `test(df1 CFG-04): author cfg04-legacy-browser-seed spec; flip settings-persistence-split rust leg`.

## Task 5: Verification battery + evidence file

- [ ] Step 1: Focused greens, at final SHA:
  - `nice -n 19 cargo test -p freshell-server legacy_local_seed`
  - `nice -n 19 cargo test -p freshell-server settings_store`
  - `nice -n 19 cargo test -p freshell-server boot`
  - `nice -n 19 npm run test:vitest -- run test/unit/server/config-store.test.ts test/unit/client/lib/browser-preferences.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx test/integration/server/bootstrap-router.test.ts`
  - `nice -n 19 cargo clippy -p freshell-server --all-targets -- -D warnings` and `cargo fmt --check`
- [ ] Step 2: Write `docs/plans/df1-evidence/CFG-04.md` (checklist annotation style: what
  landed, what's proven where, the unrun-spec note, links to spec paths).
- [ ] Step 3: Commit; update df1 status (`state: review`, `terminal: COMPLETED`) after the
  review loop is clean.

---

## Load-bearing audit ledger

*(Filled in during the load-bearing pass. Method legend: run code > inspect code > docs.)*

| # | Assumption (falsifiable) | Method | Result |
|---|---|---|---|
| A1 | Client consumes the seed once behind `legacyLocalSettingsSeedApplied` and is already correct/tested — item needs NO client change | run code (existing focused vitest) | PENDING |
| A2 | Frozen `server/` + `shared/settings.ts` on this base implement the full seed contract (parity source exists as read) | inspect code | VALIDATED (config-store.ts:333-339, 459-462; shell-bootstrap-router.ts:34-36,75; settings.ts:1449-1524) |
| A3 | `/api/bootstrap` is the SPA's only boot fetch for the seed; Rust `boot.rs` route is live; `BootState.settings` is the single SettingsStore loaded once in main.rs | inspect code | VALIDATED (App.tsx:550; boot.rs:84; main.rs:199,914) |
| A4 | Rust `ServerSettings` has no local fields, so typed round-trip strips them implicitly; `excludeFirstChat*` are typed `SettingsSidebar` fields (server-backed retention) | inspect code | VALIDATED (freshell-protocol/src/settings.rs:60-65,118-136) |
| A5 | Node clamps (never drops) out-of-range numeric seed members (`uiScale:-5→0.75`, `fontSize:1_000_000→64`) and emits integral floats as ints (`1`, not `1.0`) | run code (oracle battery, Task 1 Step 1) + existing pinned test | PARTIALLY VALIDATED (test/unit/server/config-store.test.ts:342-377 pins clamps); number-serialization to be oracle-verified |
| A6 | serde_json `Value`/`Map` equality for the changed-check is content-based (order-insensitive) with `preserve_order` enabled; integer-vs-float `Number` equality is representation-sensitive (requires `js_number`) | workspace Cargo.toml inspect + store test #3 (byte-stability double-boot) | PENDING |
| A7 | e2e harness: `createE2eServerHandle` + `setupHome` writes a pre-split config before BOTH server kinds start; `?e2e=1` exposes `__FRESHELL_TEST_HARNESS__` with `getState().settings.settings` resolved settings | inspect code | VALIDATED (rust-server.ts:260,461-467; test-server.ts:31,343; sibling spec green on legacy) |
| A8 | removing the `test.fail` on `settings-persistence-split.spec.ts`'s rust leg leaves that spec otherwise satisfied by CFG-04 alone (its steps never act on SESSION-13's exclusions; it only asserts seed round-trip + per-context locality + cwd replication) | inspect code | VALIDATED (spec lines 95-175: no excludeFirstChat* interaction; post-impl disk assertions hold because boot normalization strips/persists) |
| A9 | Seed must not appear outside bootstrap: legacy keeps it out of WS/`settings.updated`; Rust typed tree cannot carry it; no other Rust consumer needed | inspect code + grep | VALIDATED (zero crate matches pre-change; ws-handshake-snapshot.test.ts:249-250 pins legacy) |
| A10 | Boot normalization persist failure must not crash the boot (legacy warns + continues) | inspect code | VALIDATED (config-store.ts:368-377; settings_store.rs needs_persist arm already follows this) |
