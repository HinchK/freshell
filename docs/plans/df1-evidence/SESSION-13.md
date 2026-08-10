# SESSION-13 — Restore the two server-wide first-chat exclusion controls — df1 evidence

**Branch:** `df1/session-13-first-chat-exclusions` (base `origin/df1/integration` @ `5521f3aba`) · **Date:** 2026-08-10 · **Playwright posture:** `deferred-with-probe` (spec authored, registered in `MATRIX_SPECS`, and PROBED once per leg by this worker — green 2× consecutive on both legs at final text)

**Item:** restore `sidebar.excludeFirstChatSubstrings` (string list, normalize-trimmed) and `sidebar.excludeFirstChatMustStart` (boolean) as server-wide `config.json` settings that (a) preserve, (b) replicate to every client, (c) apply to complete multi-provider session data.

## Root cause

The **read/retain/replicate/apply chain was already landed** (CFG-04 boot retention of the typed `SettingsSidebar` fields; CFG-12 live handshakes + `settings.updated` broadcast; client-side `isExcludedByFirstUserMessage` filter in `sidebarSelectors.ts`; rust directory projection of `firstUserMessage` for claude/codex/amplifier with opencode legitimately bare, matching legacy). The **genuine residual gap was the PATCH write path** of the two controls: `SettingsStore::patch` did a raw `deep_merge` + typed serde deserialize, and `validate_patch` had **no sidebar handling at all**:

| Legacy behavior (`settings-router.ts:127-147` → zod strict schema + `mergeServerSettings`) | Rust before this item |
|---|---|
| `sidebar.{unknown}` → 400 `unrecognized_keys` | accepted, silently dropped by serde |
| `sidebar: "nope"` → 400 `invalid_type(object)` | 400 but via serde failure (shape drift) |
| `excludeFirstChatSubstrings: "nope"`, element `[1,"a"]` → 400 with element-path issue | 400 via serde (shape drift) / no validation |
| `excludeFirstChatMustStart: "yes"/null/0/{}` → 200, coerced by `z.coerce.boolean()` | **400** (serde bool rejects) — API-incompatible |
| substrings `[" a ","a",""," b ","b"]` → stored `["a","b"]` (trim/dedupe/drop-empty) | stored **verbatim** |
| `sidebar:{ignoreCodexSubagentSessions:...}` alias stripped pre-validation → 200 no-op | accidentally-200 only because there was no strictness |

20… wait — the table above is the contract; the 19-case battery was produced by executing the REAL legacy `buildServerSettingsPatchSchema` + `mergeServerSettings` under `npx tsx` against this checkout (CFG-04 oracle pattern): expected accept/reject + merged-sidebar JSON bytes pasted into `sidebar_patch_oracle_byte_parity_battery`.

## Fix (`c20c842c4`)

`crates/freshell-server/src/settings_store.rs`:

1. `strip_deprecated_settings_patch_aliases(&mut patch)` at `patch()` entry — mirrors `stripDeprecatedSettingsPatchAliases` ordering (before validation), so the browser-local alias key remains an accepted no-op and never trips strictness.
2. `validate_sidebar_patch` in `validate_patch` (positioned between `panes` and `codingCli`, matching legacy zod field order for multi-issue patches): non-object → `invalid_type(object)`; substrings non-array → `invalid_type(array)`; non-string element → `invalid_type(string)` with element-index path; unknown subkeys → one `unrecognized_keys` issue — all via the existing live-pinned helpers (`invalid_type_issue`, `unrecognized_keys_issue`). The boolean knobs are deliberately NOT type-checked (`z.coerce.boolean()` accepts any value).
3. `normalize_sidebar_patch` pre-merge: JS `Boolean()` truthiness for `excludeFirstChatMustStart`/`autoGenerateTitles` (`""/0/null`→false; non-empty string incl. `"false"`/non-zero number/array/object → true), and the existing module-local `normalize_trimmed_string_list` for the substrings. Observationally identical to legacy's validate-then-merge order because a PRESENT sidebar key always REPLACES the base (`hasOwn` semantics in `mergeServerSettings`), verified row-for-row by the oracle battery.

Plus pinning in neighboring layers: `crates/freshell-server/src/session_directory.rs` — `to_value_projects_first_user_message_camel_case_present_vs_omitted` (the client's filter reads the camelCase key; providers with no first-chat data must OMIT the key, never serialize null — legacy `session-indexer.ts:1032` conditional-spread parity). `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts` — provider-diverse application leg (claude/codex/amplifier all filtered by the same knobs; a firstUserMessage-less opencode item is never hidden by these controls).

## RED proofs (pre-fix code)

`cargo test -p freshell-server --bin freshell-server settings_store::tests` — exactly the 9 new tests failed, each for the intended reason (58 pre-existing passed, zero collateral):

- 4× `validate_patch_sidebar_*` — `Option::unwrap()` on `None` (no sidebar validation existed).
- `patch_coerces_exclude_first_chat_must_start_truthiness` — 400 where legacy accepts.
- `patch_normalizes_exclude_first_chat_substrings` — verbatim `[" a ","a",""," b ","b"]` instead of `["a","b"]`.
- `patch_sidebar_deprecated_alias_stripped_before_validation` — unknown `bogus` key accepted.
- `sidebar_patch_write_through_persists_normalized_disk_broadcast_and_restart` — response verbatim, un-normalized.
- `sidebar_patch_oracle_byte_parity_battery` — row 0: 400 where legacy ACCEPTS.

## GREEN proofs (final SHA)

- `cargo test -p freshell-server --bin freshell-server settings_store::tests` → **67 passed / 0 failed** (run twice; also inside the full-suite runs below).
- `cargo test -p freshell-server --bin freshell-server session_directory` → **60 passed / 0 failed**.
- `cargo test -p freshell-server --bin freshell-server` (FULL bin suite) → **649 passed / 0 failed / 1 ignored**, under a clean `TMPDIR`. ⚠️ Default-TMPDIR runs on this host deterministically fail `repo_icon_git::tests::no_git_falls_back_to_start` — **host contamination, not this branch**: an EMPTY `/tmp/.git` directory exists on this machine (mtime 2026-08-10 00:55, empty — `git rev-parse` itself rejects it), and `resolve_repo`'s upward walk treats any `.git` dir as a repo root, so any tempfile under `/tmp` resolves `repo_root=/tmp`. Proven non-branch-caused by the TMPDIR-isolated reruns (fails under `/tmp`, passes elsewhere, on code my diff never touches). Unfiltered failing output: `assertion left==right failed — left: "/tmp", right: "/tmp/.tmpXXXX/plain"` at `crates/freshell-server/src/repo_icon_git.rs:110`.
- `cargo test -p freshell-server --all-targets` → full log `s13-alltargets2.log`; final run all-ok (counts below separately confirmed). NOTE: on the first all-targets run, ONE pre-existing timing flake surfaced: `network::tests::concurrent_configure_and_disable_serialize_to_a_consistent_end_state` — `left: 500, right: 200` at `network.rs:2917`, a concurrency test whose failure mode is the A-08 mutation-lock race window, in code paths this diff does NOT touch (my diff adds a sidebar branch to `validate_patch` + `patch()`; configure/disable flow through `network.rs`'s own handlers). It passed in BOTH bin-only suite runs (648/649 then 649/649), failed once in the parallel all-targets run, then passed 1× with nocapture and 5×5 isolated under TMPDIR — pre-existing load flake, same classification as CFG-12's `codex_locator_activity` (identical one-off-under-load pattern).
- `cargo fmt --check` clean · `cargo clippy -p freshell-server --all-targets -- -D warnings` clean.
- `npm run typecheck` clean.
- Legacy/client regression (no legacy source was touched):
  - `npm run test:vitest -- run test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts --config config/vitest/vitest.server.config.ts` → **86 passed**.
  - `npm run test:vitest -- run .../sidebarSelectors.visibility.test.ts test/unit/shared/settings.test.ts` → **72 passed** (22 in the visibility file — incl. the new provider-diverse test, first-run green).

## Playwright (probed — both legs)

`test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts` mirrors the checklist text literally: seeds start/middle/no-match sessions across claude/codex/amplifier plus a firstUserMessage-less opencode control; edits BOTH controls through the real Settings→Workspace UI in profile A (textarea + toggle, incl. the 500ms text-debounce); asserts exact sidebar membership in A and in a fresh isolated profile B; reloads A; RESTARTS the server via `testServer.restart()`; re-asserts values+membership; reads `.freshell/config.json` bytes for the two keys. Registered in `MATRIX_SPECS` with a comment.

Timings (final spec text):
- `--project=legacy-chromium`: **passed 25.8s**, then **passed 31.0s** at final SHA.
- `--project=rust-chromium`: **passed 36.7s**, then **passed 27.3s** at final SHA.

Per-leg classification: both legs pass un-annotated, 2× consecutive. No `test.fail`/`test.fixme` introduced; no pre-existing red leg named SESSION-13 (verified: `settings-persistence-split.spec.ts:82,94` mentions SESSION-13 only in history comments; CFG-04 already removed the committed pin).

**Probe findings fixed during authoring (spec-side only, no product change needed):**

1. Single-turn claude fixtures classified `isNonInteractive` (legacy `claude.ts:478` hides ≤1-user-message sessions from the default sidebar) — widened fixtures to two turns, same as `session-directory-matrix.spec.ts`.
2. **Harness asymmetry (flagged for HARNESS-02 follow-up, not fixed here):** `RustServer.restart()` re-invokes `boot()` which RE-RUNS `setupHome` (`test/e2e-browser/helpers/rust-server.ts:466`), while its own doc says "the isolated HOME is never touched" and `TestServer.restart()` (legacy) skips setupHome entirely. A setupHome that rewrites `.freshell/config.json` clobbers PATCHed state exactly on the leg that must verify persistence. This spec's setupHome now guards the config write on absence (transcript seeds are byte-identical rewrites, safe to repeat). Next matrix spec that writes config and restarts on rust hits this without the guard.

## Review record

Structured fresh-eyes self-review per the review-agent protocol (no `Task` tool in this environment → the orchestrator's sanctioned fallback, same as CFG-12), over `git diff 5521f3aba..HEAD`:

- Verified alias-strip ordering against `server/settings-router.ts:23-36` (before agentChat? No — agentChat check stays FIRST, matching legacy lines 127-136; strip precedes zod only; sequence: agentChat-reject → clone → strip → validate → normalize → merge).
- Verified clone-then-normalize is observationally identical to legacy validate-then-normalize-in-merge: sidebar keys are presence-replace in both systems; no patch can read the base mid-normalization.
- Verified unknown-key byte shape (`Unrecognized key: "bogus"` singular / plural join) via the pre-existing live-pinned `unrecognized_keys_issue`.
- Verified `z.coerce.boolean()` semantics against the real zod4 schema executed under tsx (the 19-row battery), incl. `null`→false and `"false"`→true.
- Verified the spec asserts disk bytes AND post-restart state (a poll that only checked in-memory state could not prove config.json persistence — the restart leg plus disk read together close that).
- Verified no foreign files touched: diff surface is `settings_store.rs`, `session_directory.rs`, one client selector test file, the new spec, `playwright.config.ts`, and this plan/evidence pair.

**Findings: none** in the diff surface. Residual environment risk owned elsewhere: the `/tmp/.git` host contamination (above) will fail any default-TMPDIR full-bin run for OTHER workers on this machine until the empty dir is removed — noted here because `repo_icon_git` failure attribution is otherwise confusing.

## Commands (verbatim, at final SHA)

```
# crate tests (green under clean TMPDIR; default /tmp poisoned by stray empty /tmp/.git)
cargo test -p freshell-server --bin freshell-server
cargo test -p freshell-server --all-targets
# legacy+client regression
npm run test:vitest -- run test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/shared/settings.test.ts
# e2e both legs
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts
```
