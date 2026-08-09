# SESSION-16 — Tolerate malformed and partially written provider data

> **For agentic workers:** df1 swarm worker document. TDD red-green-refactor per task; commit at every task boundary. Playwright posture for this item is `deferred` (spec authored, then ONE probe run per relevant leg with per-leg outcome classification — never iterated to green).

## Goal

On the **Rust server** (parity target), malformed/partially-written provider data never compromises the session directory:

1. **Healthy sessions stay available** — a bad record is isolated per-record (file providers) or, for OpenCode's single sqlite db, its failure is recorded/visible while prior healthy data is preserved; sibling healthy records never disappear because a neighbor is corrupt.
2. **Bad records are quarantined** — empty / all-malformed / cwd-less (R10b) records are excluded from the index (cached as exclusions, never re-parsed while unchanged) and never leak into the sidebar or search.
3. **A record is indexed once it becomes valid** — a partially-written (e.g. truncated-mid-line, cwd-not-yet-present) record that is later completed is re-parsed (its exclusion is keyed on `(mtime, size)`, which changed) and appears live, without a restart.

**Parity source:** frozen legacy `server/` indexer behavior at the base SHA —
`server/coding-cli/session-indexer.ts` (`readLightweightMeta` per-file/per-line
`try/catch { continue }` tolerance, `if (!meta.cwd) continue` R10b gate, `scanFailures`
recorded per listing attempt — never a silent-healthy empty for a failed provider),
`server/coding-cli/providers/claude.ts` `parseSessionContent` (per-line `JSON.parse`
skip), `providers/codex.ts` (same + unknown-item-type tolerance, 42f24759),
`providers/opencode.ts` / `opencode-listing-query.ts` (`listSessionsDirect`
`read_error` re-throw → preserve-cached, row-level cwd skip), and
`providers/amplifier.ts` (`parseAmplifierMetadata` malformed → `{}` → cwd-less skip).
Read policy: Node `fs.readFile(f, 'utf8')` is lossy (U+FFFD) — invalid-UTF-8 records are
still indexed, NOT quarantined (regression bug #7, pinned by
`crates/freshell-server/src/session_directory.rs::invalid_utf8_transcript_is_indexed_lossily_like_node`).

**Acceptance evidence (definition of done for `deferred` posture):**

1. Behavior verified present on Rust (fixes if the audit finds a gap), keyed to the three clauses above.
2. Focused tests green ×2 (flaky-prone: any TTL/timing-sensitive index test):
   - new Rust characterization tests in `crates/freshell-sessions` (per-provider malformed matrix, exclusion caching, excluded→included transition, opencode corrupt-db failure semantics),
   - one legacy control vitest file pinning the frozen-parity reading of the same corpus,
   - `cargo fmt`/`clippy` clean on touched crates.
3. Playwright spec `test/e2e-browser/specs/session-malformed-data.spec.ts` authored per the matrix convention, registered in `MATRIX_SPECS`, probe-run ONCE per relevant leg (`legacy-chromium` = control, `rust-chromium` = target; amplifier assertions rust-only per the established KNOWN DIVERGENCE), per-leg outcomes classified `green` / `expected-gap-red` in the status note.
4. Review loop (≤5 fresh rounds) reports no serious findings.
5. Evidence file `docs/plans/df1-evidence/SESSION-16.md` written in checklist annotation style.

## Current-state findings (verified by reading code at the base SHA `3dbba43c2`)

1. **File-provider parse isolation (claude/codex/amplifier) — PRESENT.** `SessionSource::parse` returns `Option`; every parse fn is corruption-tolerant by construction: `directory_index.rs::parse_claude_file` / `parse_codex_file` read via `String::from_utf8_lossy`, parse via the 1:1 parser ports (per-line `serde_json::from_str` skip), then R10b (`meta.cwd.as_ref()?`). `amplifier.rs::parse_amplifier_file` same shape (`parse_amplifier_metadata` malformed → default → cwd `None` → excluded). Sweep runs in `spawn_blocking`; a hypothetical panic is contained by `perform_refresh`'s `JoinError` arm (preserves published snapshot).
2. **Quarantine = cached exclusion — PRESENT.** `FileEntry { mtime_ms, size, item: Option<IndexedSession> }`; `item: None` caches an exclusion. Existing tests: `excluded_file_cached`, `persisted_cache_excluded_marker_survives_reload`, oracle-path `invalid_utf8_transcript_is_indexed_lossily_like_node`, fixture-parity `malformed_skips_two_bad_lines_but_counts_all_six`, `corrupt_and_empty_codex_streams_never_panic`, `parse_amplifier_metadata_malformed_json_yields_default`.
3. **Index-once-valid mechanism — PRESENT but UNPINNED.** `refresh_snapshot` (directory_index.rs:1342-1357) re-parses any file whose `(mtime, size)` moved — a cached EXCLUSION is re-parsed identically to a cached inclusion (the `unchanged` check is content-blind). No test covers the excluded→included transition; closest are `changed_file_single_reparse` (included→included) and `new_file_added` (absent→included). **This is the item's clause 3 and the primary test gap.**
4. **Live-delivery of a completed record — PRESENT.** `main.rs::sessions_sweep_signature` = `(items.len(), max lastActivityAt, identity digest)`; an excluded→included transition moves `items.len()` even when the new item's timestamps are old (pinned by `new_older_session_file_is_still_detected_as_a_change`). 2s sweep broadcasts `sessions.changed`; client refetch path (`App.tsx` listener) is SESSION-09-proven by `session-directory-matrix.spec.ts` "a session written mid-test appears in the sidebar without a reload".
5. **OpenCode (single-db) failure semantics — PRESENT.** `OpencodeSource::direct_list` Err → preserve cached items + record scan failure (`a_failing_direct_list_records_a_scan_failure_and_recovery_clears_it`); `direct_health_check` runs EVERY sweep even on unchanged mtime (`opencode_db_unreadable_with_unchanged_mtime_records_a_scan_failure`); row-level: `to_opt_string`/`to_opt_i64` coerce unexpected sqlite types to `None` (never a row error), cwd-less rows skipped (`_ => continue` in `list_sessions`). Schema/tables discovered per query (`PRAGMA table_info`, `sqlite_master`).
6. **Search stays usable — PRESENT.** `search.rs::search_session_file` reads lossy + skips unparseable lines; `Err` only on real I/O failure → per-file `partialReason: 'io_error'` in `session_directory.rs::apply_file_search` (legacy `service.ts:208-217` parity). Quarantined records never reach search (no `source_file` in the index).
7. **Legacy malformed-corpus vitest:** none pins the full corpus matrix against the frozen `session-indexer.ts` (nearest: `skips sessions without cwd metadata`, large-file head/tail snippet tests). The PW legacy leg is the behavioral control; a small vitest control pins the reading without a browser.
8. **What "quarantine" is NOT (anti-scope):** no per-record quarantine LIST API exists in legacy or Rust (nothing to port); no `history.jsonl` repair (SESSION-21); no resume-path validation (TERM-06/TERM-23); no search snippet safety (SESSION-19). Crucially: truncated-with-valid-prefix and invalid-UTF-8 records are deliberately still indexed (partial data, U+FFFD) — "quarantine" applies to records with NO indexable identity (empty/all-malformed/cwd-less), matching legacy exactly.

## Design

This item is **class P (behavior present, evidence missing)**. The work is a proof-and-pin
campaign at three depths, plus the deferred-matrix spec. Behavior changes only if the
load-bearing audit falsifies a "PRESENT" claim (each task notes its fallback).

**Depth 1 — Rust characterization tests (`crates/freshell-sessions`):** one new integration
test file `crates/freshell-sessions/tests/malformed_data_quarantine.rs` driving REAL
`SessionIndex` sweeps over real on-disk corpora (temp dirs):

- claude/codex matrix: healthy sibling stays indexed alongside (a) 0-byte file, (b)
  whitespace-only, (c) all-lines-malformed, (d) valid-JSON-but-cwd-less, (e)
  truncated-mid-line (no complete line → excluded), (f) invalid-UTF-8 payload wrapping a
  valid cwd record (indexed lossily — title carries U+FFFD, NOT quarantined).
- amplifier matrix: healthy sibling stays indexed alongside malformed / empty /
  missing-`working_dir` `metadata.json` (all excluded).
- **Clause 3 (both claude & codex & amplifier):** seed a partially-written record
  (truncated-mid-line, no complete cwd line) → sweep → excluded; append the completion →
  sweep past TTL → indexed, healthy sibling untouched, exclusion → inclusion transition.
- opencode: healthy db listed; db REPLACED by garbage bytes at unchanged→changed mtime →
  scan failure recorded + prior sessions preserved (never a silent healthy-empty); restore
  healthy db → failure clears + sessions return. Plus a **cold-boot corrupt-db** leg:
  garbage db with empty cache → empty snapshot + failure recorded (parity: legacy logs +
  surfaces unsearchable, never serves "healthy empty").

**Depth 2 — legacy control vitest** `test/unit/server/coding-cli/session-indexer-malformed-corpus.test.ts`:
the SAME corpus against frozen `session-indexer.ts` (control proving the Rust expected
values are the legacy ones): healthy claude record indexed; empty/malformed/cwd-less
siblings skipped; a cwd-less-then-completed record becomes indexed on refresh (legacy:
watcher/`refresh()` re-reads per changed `(mtime, size)`).

**Depth 3 — deferred Playwright spec** `test/e2e-browser/specs/session-malformed-data.spec.ts`
(+ one `MATRIX_SPECS` regex line): seeds per-provider healthy + quarantine-class siblings
pre-boot; asserts healthy records render in the sidebar (both legs), quarantined ones never
render; sidebar search box still filters (usable over a corpus containing bad records);
then completes a partial claude record mid-test and asserts exactly one live addition
without reload (the `toBeVisible` poll over ≤2 sweep ticks). OpenCode malformed shape =
rows quarantined by the row-level rules (NULL/empty `directory`) inside a healthy db (one
db per home — cannot mix corrupt-db + healthy-db in one home; the corrupt-db legs live in
the crate tests). Amplifier seeds/assertions are `e2eServerKind === 'rust'`-gated (KNOWN
DIVERGENCE: no legacy amplifier provider at this base — mirrors
`session-directory-matrix.spec.ts`'s established note).

**Ordering with other items:** SESSION-14 (timestamp flooring) and SESSION-07 (search
tiers) own their own semantics; this item asserts only "search remains usable" (title-tier
filter + no error state), never snippet contents.

## Global constraints

- Work only in `.worktrees/df1-session-16-malformed-data`; commit locally with explicit pathspecs; no pushes/PRs/checklist edits.
- `nice -n 19` (+ `ionice -c3` where available) on every build/test; cargo lane lease for cargo builds/tests; pw lease for the one probe run per leg; NO broad `npm test`/`npm run check`/`npm run verify`/unscoped vitest.
- Server route/server-side Node conventions (NodeNext/ESM `.js` import extensions) for the legacy control test; `server/` behavior itself is FROZEN (control test reads, never patches).
- No new dependencies; tests reuse existing helpers (`unique_temp_dir` style, `write_session_file` patterns from `directory_index.rs` tests adapted to the external-tests layout).
- All temp dirs under `std::env::temp_dir()` with pid/counter disambiguation, cleaned up at test end (existing convention).

## Load-bearing audit ledger

| # | Assumption (falsifiable) | Method | Result |
|---|---|---|---|
| A1 | A cached EXCLUSION is re-parsed when the file's `(mtime,size)` changes (mechanism for clause 3) | run code: RED-first crate test `excluded_record_becomes_valid...` — must pass against unmodified source | PENDING |
| A2 | `from_utf8_lossy` on the LIVE `ClaudeSource` path indexes invalid-UTF-8 records lossily (only the oracle path `list_claude_sessions` is pinned today) | grep + crate test (live source, invalid-UTF-8 fixture) | PENDING |
| A3 | Garbage-bytes opencode.db at cold boot → `direct_list` Err → empty snapshot + "opencode" recorded in `scan_failures` (no panic, no silent-healthy) | run code: crate test with garbage file | PENDING |
| A4 | Warm corrupt-replace → prior sessions preserved + failure recorded; restore → clears (mtime-moved leg; existing tests cover the unchanged-mtime health-check leg) | run code: crate test | PENDING |
| A5 | Amplifier malformed/empty/`working_dir`-less metadata.json → excluded (R10b), healthy sibling intact | crate test via `AmplifierSource` + `SessionIndex` | PENDING |
| A6 | Legacy control: frozen indexer skips empty/malformed/cwd-less and indexes the completed-once-partial record on refresh | run vitest control file against `session-indexer.ts` | PENDING |
| A7 | E2e seam: `setupHome` + `helpers/fixtures.ts` matrix routing supports per-provider seeds and mid-test writes (spec feasibility without new helpers) | inspect `session-directory-matrix.spec.ts` + `helpers/external-target.js` | VERIFIED (read; `setupHome`/`serverInfo.homeDir` give exactly this) |
| A8 | MATRIX_SPECS registration is one additive regex line, `...\.spec\.ts$` shape | inspect `test/e2e-browser/playwright.config.ts:13-43` | VERIFIED |
| A9 | `sessions_sweep_signature` moves on excluded→included even with old timestamps (count component) — so the PW live-addition leg has a delivery channel | read `main.rs:2154-2174` + existing `new_older_session_file_is_still_detected_as_a_change` | VERIFIED |
| A10 | `parse_amplifier_file` requires metadata.json `working_dir` (transcript lines never supply cwd) — the malformed-metadata amplifier record is genuinely unindexable | read `amplifier.rs:400-424` | VERIFIED |

## Tasks (each red → green → commit)

### Task 0: audit probes (validates A1–A6 before any prod change)
- Land the new crate test file + legacy control test in one RED framing commit: if every
  audit test passes unmodified, they are committed as characterization pins (honest note:
  proven-present, not proven-fixed). If any fails, the fix tasks below start genuinely RED.
- Mutation spot-check on A1 (temporarily gate the re-parse on `item.is_some()`, watch the
  excluded→included test go red, revert) — one cheap proof the pin has teeth.

### Task 1: Rust malformed-matrix + quarantine pins (freshell-sessions)
- `malformed_data_quarantine.rs`: claude/codex/amplifier matrices (healthy sibling stable; quarantine classes excluded; invalid-UTF-8 indexed lossily via the LIVE source; excluded→included transition per provider; exclusion not re-parsed while unchanged).

### Task 2: Rust opencode corrupt-db semantics
- Tests: cold-boot garbage db → empty + scan failure; warm preserve-on-corrupt-replace; restore-recovery. Extend existing `a_failing_direct_list...` file only if shapes don't already cover; new file otherwise (decision recorded).

### Task 3: legacy control vitest
- `test/unit/server/coding-cli/session-indexer-malformed-corpus.test.ts`.

### Task 4: deferred Playwright spec + MATRIX_SPECS registration (authored; probe-run ONCE per leg)
- `session-malformed-data.spec.ts` per Depth 3 above. Run once on `legacy-chromium` and once on `rust-chromium` with the pw lease; classify per-leg outcomes; do NOT iterate.

### Task 5: evidence + close-out
- `docs/plans/df1-evidence/SESSION-16.md` (annotation style: clauses → evidence map, per-leg PW classification, deliberate-notes). Final df1ctl update with green commands at final SHA.
