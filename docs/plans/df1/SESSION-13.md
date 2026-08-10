# SESSION-13 — Restore the two server-wide first-chat exclusion controls — implementation plan

> **For agentic workers:** TDD per repo AGENTS.md; Red-Green-Refactor; commit at each task boundary.

**Item (verbatim):** *Restore the two server-wide first-chat exclusion controls. Preserve `excludeFirstChatSubstrings` and `excludeFirstChatMustStart` in `config.json`, replicate them to every client, and apply them to complete multi-provider data.*

**PW validation (verbatim):** *Seed start/middle/no-match sessions across providers, edit both controls in A, assert exact membership in A and B, reload/restart, and verify the shared values and results persist.*

**Branch:** `df1/session-13-first-chat-exclusions` (base `origin/df1/integration` @ `5521f3aba7`)
**Playwright posture:** `deferred-with-probe` — author + register in `MATRIX_SPECS` + probe once per leg (pw lease); classify per-leg in the evidence note.

## Goal

Close the remaining legacy-parity gaps of the server-wide first-chat exclusion controls on the Rust server's **PATCH write path**, and pin the whole control loop (persist → replicate → apply) with tests plus one matrix Playwright spec.

## Architecture / already-in-place inventory (validated by direct code reading)

The receive/retain/replicate/apply chain around these two keys is mostly landed already:

- **Boot retention (CFG-04, landed):** `SettingsSidebar.exclude_first_chat_substrings` / `exclude_first_chat_must_start` are typed fields (`crates/freshell-protocol/src/settings.rs:60-65`); boot normalization keeps them inside `settings` on disk while stripping browser-local sibling keys (proven by `legacy_mixed_config_seeds_and_strips_at_boot` etc. in `crates/freshell-server/src/settings_store.rs`).
- **Live replication (CFG-12, landed):** `PATCH /api/settings` commits the one `SettingsStore` and broadcasts `settings.updated` (`crates/freshell-server/src/settings_store.rs:1857`); a fresh `/ws` handshake resolves the LIVE tree (`WsState::handshake_settings`, `SettingsStore::shared_settings_lock()`); `/api/bootstrap` returns the live tree (`boot.rs:104`).
- **Application (client, pre-existing):** `src/store/selectors/sidebarSelectors.ts:634-646,653+666` — `isExcludedByFirstUserMessage` (case-sensitive `includes`, or `startsWith` when `mustStart`) inside `filterSessionItemsByVisibility`, fed by `selectExcludeFirstChatSubstrings`/`selectExcludeFirstChatMustStart` reading `state.settings.settings.sidebar.*` (i.e. the server tree). Unit-covered by `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`.
- **Complete multi-provider data (Rust directory, pre-existing):** `IndexedSession.first_user_message` populated for claude (`parse/claude.rs`), codex (`parse/codex.rs`), amplifier (`amplifier.rs` `read_first_user_message_from_transcript`); opencode intentionally `None` (faithful — legacy `listSessionsDirect` never populates it either; verified in `server/coding-cli/providers/opencode*` zero hits). Projection to the wire as camelCase `firstUserMessage` only when present (`crates/freshell-server/src/session_directory.rs:159`), matching legacy `session-indexer.ts:1032`. Legacy registers the same four providers on this branch (`server/index.ts:240`).
- **The two settings-UI controls (client, pre-existing):** `src/components/settings/WorkspaceSettings.tsx` — textarea (aria-label "Sidebar first chat exclusion substrings", debounced 500ms `SERVER_TEXT_SETTINGS_DEBOUNCE_MS` via `scheduleServerTextSettingSave`) and Toggle (aria-label "Require first chat exclusion substring at start", immediate `applyServerSetting`), both PATCHing via `saveServerSettingsPatch`.

## Root cause of the remaining gap

The Rust `SettingsStore::patch` does a raw `deep_merge` + typed serde deserialize with a `validate_patch` that has **no sidebar handling at all** (`crates/freshell-server/src/settings_store.rs:1577-1640`). The legacy write path (`server/settings-router.ts:127-147` → `shared/settings.ts` `buildServerSettingsPatchSchema` + `mergeServerSettings`) does, for the `sidebar` patch object:

1. `stripDeprecatedSettingsPatchAliases` removes `sidebar.ignoreCodexSubagentSessions` BEFORE validation (`server/settings-router.ts:23-36`).
2. Zod4 strict sidebar object `{excludeFirstChatSubstrings?: string[], excludeFirstChatMustStart?: z.coerce.boolean(), autoGenerateTitles?: z.coerce.boolean()}.strict().optional()` (`shared/settings.ts:796-800`) — unknown sidebar keys or wrong substring element types are 400s with byte-pinned issue shapes; boolean keys accept ANY JSON value via `Boolean()` truthiness coercion.
3. `mergeServerSettings` → `sanitizeServerSettingsPatch` + `normalizeTrimmedStringList` (`shared/string-list.ts`) — substrings stored trim/deduped/empty-dropped, first occurrence wins; presence-replaces (incl. `[]` clearing).

Live-pinned oracle table (executed against the REAL legacy schema+merge via tsx on this worktree's checkout, `npx tsx` battery, 19 cases):

| Patch body | Legacy result |
|---|---|
| `mustStart`: `"yes"` / `"false"` / `1` / `{}` / `[]` | 200 → `true` |
| `mustStart`: `""` / `0` / `null` | 200 → `false` |
| `substrings: [" a ","a",""," b ","b"]` | 200 → `["a","b"]` |
| `substrings: []` (key present) | 200 → **replaces/clears** to `[]` |
| `substrings: "nope"` | 400 `invalid_type` expected `array`, path `["sidebar","excludeFirstChatSubstrings"]` |
| `substrings: [1,"a"]` | 400 `invalid_type` expected `string` at path `["sidebar","excludeFirstChatSubstrings",0]` |
| `sidebar: {bogus:1}` | 400 `unrecognized_keys` keys `["bogus"]` path `["sidebar"]`, msg `Unrecognized key: "bogus"` |
| `sidebar: "nope"` | 400 `invalid_type` expected `object`, path `["sidebar"]` |
| `sidebar: {ignoreCodexSubagentSessions:true}` | 200 no-op (alias stripped pre-validation) |
| `sidebar: {}` / `autoGenerateTitles: "yes"`/`0` | 200; autoGenerateTitles `true`/`false` |

Current Rust behavior on the same inputs: `mustStart:"yes"` → 400 (serde bool fails, details `[]`); `substrings:[" a ","a",...]` → 200 stored **verbatim**; `sidebar:{bogus:1}` → 200 (serde silently drops); alias-only patch → 200 only by accident (no validation to reject it). All divergent.

## Global constraints

- Rust edition 2024 workspace; `cargo fmt --check` + `cargo clippy -p freshell-server --all-targets -- -D warnings` clean at every commit.
- Legacy `server/`, `shared/`, `src/` trees are FROZEN for this item — parity is proven by executing the legacy functions read-only via `npx tsx` (the CFG-04 oracle-battery pattern); NO source edits.
- No scoped‑test command outside: `cargo test -p freshell-server`, `npm run test:vitest -- run <focused client/server files>`, own PW spec via the pw lease.
- Zod issue shapes byte-pinned via the EXISTING helpers in `settings_store.rs` (`invalid_type_issue`, `unrecognized_keys_issue` — both already live-matched for top-level/`codingCli`).

## Task plan

### Task 1: RED — sidebar PATCH validation + normalization failing tests (Rust)

**Files:**
- Test: `crates/freshell-server/src/settings_store.rs` (`mod tests` — validate_patch unit tests + `store.patch`/`router_state_at` integration tests)

**Test list (all written first, all failing for the right reason):**

1. `validate_patch_sidebar_unknown_key_rejected` — `{sidebar:{bogus:1}}` → one `unrecognized_keys` issue, keys `["bogus"]`, path `["sidebar"]`. **RED:** currently `None` (accepted).
2. `validate_patch_sidebar_not_an_object_rejected` — `{sidebar:"nope"}` → `invalid_type` expected `object`, path `["sidebar"]`. **RED:** currently `None`.
3. `validate_patch_sidebar_substrings_wrong_type_rejected` — `{sidebar:{excludeFirstChatSubstrings:"nope"}}` → `invalid_type` expected `array` at full path. **RED:** currently `None`.
4. `validate_patch_sidebar_substring_element_type_rejected` — `[1,"a"]` → `invalid_type` expected `string` at `[...,0]`. **RED:** currently `None`.
5. `validate_patch_sidebar_deprecated_alias_stripped` — `{sidebar:{ignoreCodexSubagentSessions:true}}` → `None` (accepted, no-op). **RED-green baseline:** accidentally passes today, pins the ordering (strip BEFORE strict check) so the new strict validator can't regress it.
6. `patch_coerces_exclude_first_chat_must_start_truthiness` — store.patch with `"yes"`/`"false"`/`1`/`{}`/`[]`/`0`/`""`/`null` per the oracle table; assert merged bool. **RED:** currently 400.
7. `patch_normalizes_exclude_first_chat_substrings` — `[" a ","a",""," b ","b"]` → merged `["a","b"]`; `[]` clears; key absent keeps base. **RED:** verbatim today.
8. `patch_sidebar_write_through_persists_normalized_disk_and_restart` — PATCH via the REAL `patch_settings` route handler (`router_state_at`): response JSON `sidebar` normalized; `.freshell/config.json` on disk normalized; fresh `SettingsStore::load` (restart) sees them; captured `broadcast_tx` receiver frame parses as `settings.updated` with the normalized values. **RED** on normalization.
9. `sidebar_patch_oracle_byte_parity_battery` — the 19-case oracle table above replayed through a tiny Node/tsx helper (spawn `npx tsx` against a checked-in-per-test inline script mirroring the probe used in planning) producing expected `(status, sidebar)` pairs; run each through `store.patch` on a base fixture with `substrings ["keep"]`; assert identical accept/reject and identical merged sidebar JSON. **RED** on the divergent rows.

### Task 2: GREEN — implement sidebar patch parity in `settings_store.rs`

**Files:**
- Modify: `crates/freshell-server/src/settings_store.rs` — `patch()` pipeline + `validate_patch()` + two new private helpers.

**Implementation (exact behavior, mirroring legacy stage-for-stage):**

- In `patch()`, BEFORE `validate_patch` (mirroring `settings-router.ts:132` strip-then-validate order): `strip_deprecated_settings_patch_aliases(&mut patch_body)` — when `patch.sidebar` is an object, remove `ignoreCodexSubagentSessions`.
- In `validate_patch`, new `sidebar` branch (ordering identical to legacy zod issue ordering: per-field type issues first, one strict unknown-keys issue last):
  - non-object → `invalid_type_issue("object", json!(["sidebar"]), v)`.
  - `excludeFirstChatSubstrings` present: non-array → `invalid_type_issue("array", ...)`; each non-string element → `invalid_type_issue("string", json!(["sidebar","excludeFirstChatSubstrings",i]), item)`.
  - `excludeFirstChatMustStart` / `autoGenerateTitles`: NO type check (legacy `z.coerce.boolean` accepts anything).
  - unknown subkeys (after alias strip) → `unrecognized_keys_issue(&unknown, &json!(["sidebar"]))`, known set `["excludeFirstChatSubstrings","excludeFirstChatMustStart","autoGenerateTitles"]`.
- In `patch()` between validation and `deep_merge`: `normalize_sidebar_patch(&mut patch_body)` —
  - `excludeFirstChatMustStart`/`autoGenerateTitles` when present → `json!(js_truthiness(v))` where truthiness is: `Null→false`, `Bool(b)→b`, `Number→as_f64()!=0.0` (JSON has no NaN), `String→!s.is_empty()`, `Array|Object→true`.
  - `excludeFirstChatSubstrings` when present (post-validation: guaranteed `Vec<String>`) → reuse the existing `normalize_trimmed_string_list` (`settings_store.rs:1781`).
- `deep_merge` + `serde_json::from_value` + persist then commit unchanged.

### Task 3: replication proof tests (Rust)

**Files:**
- Test: `crates/freshell-server/src/settings_store.rs`

- `patched_exclusions_visible_through_shared_settings_lock` — after a sidebar PATCH, `store.shared_settings_lock()` read guard shows the new values (CFG-12 handshake source; mirrors `patch_is_visible_through_shared_settings_lock`).
- (covered by Task 1 #8: broadcast frame + restart persistence.)

Optional-if-cheap ws-leg (only if the existing `freshell-ws` handshake test file makes it a one-liner; otherwise the lock test + CFG-12's `handshake_live_settings` integration test suffice): add sidebar keys to the existing live-handshake fixture pattern.

### Task 4: multi-provider projection proof (client selector + Rust projection)

**Files:**
- Test: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts` — extend the `first chat substring filtering` describe with provider-diverse items (providers `claude`, `codex`, `amplifier`, `opencode`; opencode item with `firstUserMessage: undefined` stays visible regardless — the "complete multi-provider data" clause: exclusion only filters where data exists, never crashes/absconds on absent data).
- Test: `crates/freshell-server/src/session_directory.rs` (module tests) — one `dir_item_json_projects_first_user_message_camel_case_when_present` asserting the wire projection carries `firstUserMessage` for claude/codex/amplifier-shaped items and OMITS the key (not null) when `None` (legacy `session-indexer.ts:1032` parity).

Both are expected to pass on first run (pre-existing behavior) — they pin the apply/data clauses of the item and guard regressions. (Written as tests-first anyway; if any turns RED unexpectedly, that IS a newly-found gap to fix.)

### Task 5: Playwright matrix spec (author + register + probe once)

**Files:**
- Create: `test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (`MATRIX_SPECS` append + comment)

**Spec content (mirrors the checklist validation text, both matrix kinds):**
- `testServer` worker fixture `setupHome` seeds, per provider claude + codex + amplifier (fixture shapes copied from `session-directory-matrix.spec.ts`):
  - one session whose first user message STARTS with the marker (`"__S13AUTO__ start-*"` per provider),
  - one with the marker only in the MIDDLE (`"please run __S13AUTO__ helper"`),
  - one NO-match control session;
  - plus default `network`/`codingCli.providers.claude.cwd` boilerplate from `settings-persistence-split.spec.ts`.
- Context A: open, wait ready; assert all three-per-provider visible in the sidebar.
- Edit controls in A via the REAL UI: Settings → Workspace tab → textarea (aria-label `Sidebar first chat exclusion substrings`) filled with `__S13AUTO__`; wait ≥ 500ms debounce + poll the test harness state until `settings.sidebar.excludeFirstChatSubstrings` is `["__S13AUTO__"]` (contains-mode) → assert start+middle hidden, no-match visible, for every provider (exact membership).
- Toggle the mustStart switch (aria-label `Require first chat exclusion substring at start`) → poll merged server settings → assert middle reappears, start stays hidden (prefix mode).
- Context B (same server, isolated profile): no reload needed for its first load — assert B's resolved settings carry both values and B's sidebar membership matches A exactly (replication-to-every-client clause).
- A reload: values + filtering persist.
- Server `handle.restart()` (the `E2eServerHandle` seam supports restart, cf. `server-restart-recovery.spec.ts`): after restart + reconnect, assert resolved values + exact membership again (config.json persistence clause), and read `.freshell/config.json` directly asserting `settings.sidebar.excludeFirstChat*` bytes (`["__S13AUTO__"]`, `true`).
- No `test.fail`/`fixme` annotations: the CFG-04/CFG-12 prerequisites are landed; no current annotated-red leg names SESSION-13 anywhere (verified 2026-08-09: only history comments at `settings-persistence-split.spec.ts:82,94` remain — nothing pinned to un-pin).

**Probe (pw lease):** run once per project: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts` and `--project=legacy-chromium` (rust leg needs a warm release build first: `cargo build --release -p freshell-server` under the cargo lease, per CFG-12's procedure). Re-run any flaky leg (×2-if-flaky). Classify each leg in the evidence note.

### Task 6: verification sweep + evidence

- `cargo fmt --check`; `cargo clippy -p freshell-server --all-targets -- -D warnings`; `npm run typecheck`.
- Focused reruns ×2 where touched/flaky: `cargo test -p freshell-server settings_store` (and the full `--bin freshell-server` once at final SHA), focused vitest files, both PW legs.
- Legacy regression sweep (read-only suites, no legacy source touched): `npm run test:vitest -- run test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/shared/settings.test.ts`.
- Evidence at `docs/plans/df1-evidence/SESSION-13.md`; `df1ctl.py update SESSION-13` heartbeats ≥ every 15 min during work; terminal `COMPLETED` + end state `review`.

## Load-bearing assumptions (validated pre-plan)

| # | Assumption | Method | Result |
|---|---|---|---|
| L1 | Legacy normalizes/coerces per the 19-row oracle table | ran the REAL `buildServerSettingsPatchSchema`+`mergeServerSettings` via `npx tsx` against this checkout | VALIDATED (table above, byte-exact incl. zod4 messages) |
| L2 | Rust `validate_patch`/`patch` have zero sidebar handling today | read `settings_store.rs:1577-1640,373-429` | VALIDATED |
| L3 | CFG-12's handshake/live-lock machinery covers sidebar keys (whole-tree) | read `network.rs:218`, `settings_store.rs:1857`, CFG-12 evidence | VALIDATED |
| L4 | Client applies exclusions provider-agnostically on `firstUserMessage` | read `sidebarSelectors.ts:69-70,634-666` + existing visibility tests | VALIDATED |
| L5 | Rust directory projects `firstUserMessage` for claude/codex/amplifier, omits (not nulls) when absent | read `directory_index.rs:73,405`, `amplifier.rs:380-407`, `session_directory.rs:159`; legacy `session-indexer.ts:1032` | VALIDATED (opencode `None` = faithful on BOTH) |
| L6 | Legacy registers the amplifier provider on THIS branch (matrix spec's stale `rust`-only guard notwithstanding) | `server/index.ts:240` + `git log` on `providers/amplifier.ts` | VALIDATED |
| L7 | No current annotated-red PW leg names SESSION-13 (checklist line 34's `test.fail` mention is historical) | grep `test.fail\|SESSION-13` in specs; CFG-04 evidence §Playwright | VALIDATED — nothing to un-pin |
| L8 | WorkspaceSettings textarea/toggle aria-labels + 500ms debounce drivable from PW | read `WorkspaceSettings.tsx:121-150`, `SettingsView.tsx:30,79-92` | VALIDATED |
