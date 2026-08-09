# SESSION-16 — Tolerate malformed and partially written provider data — df1 evidence

**Branch:** `df1/session-16-malformed-data` (base `origin/df1/integration` @ `3dbba43c2`) · **Date:** 2026-08-09 · **Playwright posture:** `deferred` (spec authored + registered in MATRIX_SPECS + ONE probe run per relevant leg; per-leg outcomes classified below — NOT iterated to green)

Class-P item (behavior largely present; evidence/paranoia missing). Load-bearing audit (`docs/plans/df1/SESSION-16.md`, ledger A1–A11) verified every acceptance mechanism present on the Rust server at the base SHA; the work is a proof-and-pin campaign at three depths plus the deferred matrix probe. **Zero production-code changes were needed.**

## Parity source (named)

Frozen legacy `server/` indexer behavior at the base SHA:
- `server/coding-cli/session-indexer.ts` — `readLightweightMeta` per-file `try/catch` degenerate-meta fallback and per-line `catch { continue }`, R10b discovery gate (`if (!meta.cwd) continue`, `:1295`), `scanFailures` recorded per listing attempt (`:1257-1262`) so a provider outage never reads as "healthy empty".
- `server/coding-cli/providers/claude.ts` `parseSessionContent` (per-line JSON.parse skip), `providers/codex.ts` (same + unknown-item-type tolerance), `providers/opencode.ts` (`listSessionsDirect` re-throws read errors → preserve cached sessions; row-mapping skips cwd-less rows), `providers/amplifier.ts` (`parseAmplifierMetadata` malformed → `{}` → cwd-less skip).
- Read policy: Node `fs.readFile(f, 'utf8')` is lossy (U+FFFD) — invalid-UTF-8 records are **indexed, not quarantined** (regression class "bug #7").

## Clause → evidence map

**"Keep healthy sessions available"**
- File providers (claude/codex/amplifier): per-record parse isolation — a bad sibling never affects a healthy one. Pins: `claude_healthy_session_survives_a_matrix_of_quarantined_siblings`, `codex_...`, `amplifier_...` (new, below) + re-sweep stability assertions.
- OpenCode (single sqlite db): corrupt db = provider-level outage handled as **preserve-cached + recorded failure**, never silent-healthy: `opencode_corrupt_db_at_cold_boot_records_a_scan_failure_not_a_healthy_empty`, `opencode_corrupt_replace_preserves_sessions_and_healthy_restore_recovers` (mtime-moved re-query leg; the unchanged-mtime health-check leg was already pinned in-crate by `opencode_db_unreadable_with_unchanged_mtime_records_a_scan_failure`). Row-level: `opencode_quarantined_rows_do_not_poison_healthy_rows_in_the_same_db` (NULL-directory row skipped, sibling in the same db listed, no failure recorded).
- Search side: quarantined records never carry `source_file` in the index (absent from the corpus), so file-tier search literally cannot touch them; healthy records stay searchable. Browser-level search usability asserted in the PW spec.

**"Quarantine bad records"**
- Empty / whitespace-only / all-lines-malformed / cwd-less-valid / truncated-without-complete-line: excluded, cached as exclusions (`FileEntry.item: None`), never re-parsed while `(mtime, size)` hold: `claude_exclusions_are_cached_and_never_reparsed_while_unchanged` (parse-call counting) + pre-existing in-crate `excluded_file_cached`, `persisted_cache_excluded_marker_survives_reload`.
- Explicitly NOT quarantined (legacy parity): truncated-with-valid-prefix (parseable prefix indexed) and invalid-UTF-8 (lossy U+FFFD). Both asserted as indexed: `claude_invalid_utf8_record_is_indexed_lossily_not_quarantined` (LIVE `ClaudeSource` path — previously only the oracle path `session_directory.rs::invalid_utf8_transcript_is_indexed_lossily_like_node` was pinned).

**"Index a record once it becomes valid"**
- Mechanism: exclusion cache keyed on `(mtime, size)`; the completing write moves the key → re-parse → include — no special-casing (the `unchanged` check is content-blind). Pins: `claude_partial_record_is_indexed_once_it_becomes_valid` (TWO shapes: append-completion of the truncated line; corrupt first line terminated + later complete record), `codex_partial_record_is_indexed_once_it_becomes_valid` (mid-write `session_meta` completion), `amplifier_healthy_..._and_partial_completes` (metadata.json full rewrite). Each asserts **exactly one** live addition and byte-identical healthy controls.
- Live delivery channel (sessions.changed without restart): `main.rs::sessions_sweep_signature`'s count component moves on any add regardless of the new item's timestamps (pre-existing pin `new_older_session_file_is_still_detected_as_a_change`); the PW probe's "one live addition" leg exercises it end-to-end.
- **Teeth:** mutation spot-check — gating the re-parse on `entry.item.is_some()` (exclusions can never re-validate) turns EXACTLY the three become-valid tests red (`amplifier_...`, `claude_partial_...`, `codex_partial_...`), 7 others green; reverted and re-verified green.

## What landed

- `crates/freshell-sessions/tests/malformed_data_quarantine.rs` (NEW, 878 lines post-fmt) — 10 integration tests over REAL `SessionIndex` sweeps with real on-disk corpora (all four providers). Green ×2 runs; `cargo fmt`/`clippy --all-targets -D warnings` clean.
- `test/unit/server/coding-cli/session-indexer-malformed-corpus.test.ts` (NEW) — frozen-behavior CONTROL: real `claude`/`codex`/`amplifier` provider modules (homeDir-repointed only) against the same corpus; healthy-beside-quarantine membership, lossy-UTF-8 indexing, and the become-valid transition driven through the REAL chokidar 'change' → dirty-file → incremental-refresh channel (not a forced rescan). Green ×2. Cites (doesn't duplicate) `session-indexer-provider-refresh.test.ts`'s direct-provider-throw preservation pin for the opencode db-level seam.
- `test/e2e-browser/specs/session-malformed-data.spec.ts` (NEW) + one `MATRIX_SPECS` line — deferred-matrix acceptance spec; see probe classification below.
- No production changes; no changes to `port/oracle`, `src/`, or shared schemas.

## Deliberate scoping / non-claims

- "Quarantine" is per-record exclusion from the index (legacy semantics) — legacy has no quarantine LIST surface, so none was ported or invented. Corrupt provider data is observable via `scanFailures` → resolve-route `providerErrors`/`degraded` (pre-existing parity, `resolve.rs`), not via the directory endpoint (legacy shape).
- OpenCode db-level corruption legs live in crate tests only: one home has exactly one `opencode.db`, so a corrupt db and a healthy db cannot coexist in one e2e home. The PW spec carries the ROW-level opencode quarantine leg (NULL `directory`).
- Truncated-with-valid-prefix + invalid-UTF-8 records being VISIBLE in the sidebar is intentional legacy parity (they're "tolerated", not "quarantined") — the PW spec asserts their presence, not absence.
- `history.jsonl` repair (SESSION-21), resume-path validation (TERM-06/23), search snippet safety (SESSION-19), timestamp flooring (SESSION-14), and live-watch coalescence (SESSION-09) are explicitly out of scope.

## Playwright probe classification (deferred policy: ONE run per leg)

- `legacy-chromium` (control): **green 2/2, 25.5s** (final run on the corrected seed; an earlier run on the defective seed also passed, 44.8s — legacy's watcher makes the live leg insensitive to the seed defect).
- `rust-chromium` (target): **green 2/2, 43.0s** (final run on the corrected seed). Two prior runs against the defective seed failed the live-addition leg at the 15s UI timeout; root-cause trail below.

### The seed defect and the root-cause trail (fully mechanized, instrumented)

Run 1/2 on `rust-chromium` failed only the live-addition leg with `element(s) not found` at the 15s UI timeout — yet the failure-time page snapshot SHOWED the completed record in the sidebar (it arrived just past the timeout). Instrumentation journey (release binary + isolated home + raw WS/HTTP clients):

1. Direct API probe (no browser): completed record became API-visible **1574ms** after the completing append; `sessions.changed` at **+2426ms**. Server-side delivery healthy.
2. Corpus bisect + per-tick sweep-signature dump (temporary `eprintln!` in `spawn_sessions_sweep`, reverted after): every tick reported `len=3` **from the first tick** — the "partial" seed was in the index from boot.
3. Why both could be true: the 2/3-of-bytes cut left the init + first-turn lines COMPLETE (cwd present → indexed) but with ONE user message → `is_non_interactive` → HIDDEN by the default browse projection (`priority=visible`). So the record was indexed-but-invisible: API browse (test 1's negative assertion) correctly excluded it, while the index included it. The completion then changed NEITHER the index count NOR (with a newer codex seed above it) the corpus max-`lastActivityAt`: the sweep signature `(len, maxTs, identityDigest)` never moved → **no `sessions.changed` broadcast** → the broadcast-driven browser never refetched within 15s. Legacy passed the identical spec because its watcher/sync broadcasts on content diffs regardless of projection-visibility classes.
4. Fix: the seed's cut now lands WITHIN LINE 1 (zero complete lines) — a genuine never-indexed partial; the completing append is a true count+1 index addition → sweep broadcasts → both legs should render live.

**Control for environment attribution (df1 README B002 discipline):** on the same box/branch/load, the July-proven rust live-create test (`session-directory-matrix.spec.ts` "a session written mid-test appears in the sidebar without a reload") was rerun: **green (32.1s)** — the environment is not the differentiator; the seed was.

### Adjacent discovery (documented, out of scope here — belongs to SESSION-09's differ semantics)

The Rust sweep signature `(len, max lastActivityAt, identity digest)` is structurally blind to changes that alter FILTER VISIBILITY without altering the index summary: e.g. a hidden non-interactive session gaining its second user message (becoming visible) with stale timestamps moves neither `len` nor max-`lastActivityAt`, so no broadcast — the browser only converges at the next unrelated broadcast. Legacy's `hasSessionDirectorySnapshotChange` (content/mtime or full comparable diff) broadcasts there. Not hit by the corrected spec (its completion is a true count+1 addition); recorded as campaign-discovered context for SESSION-09's "modified" leg.

## Green commands (re-runnable at final SHA)

```
cargo test -p freshell-sessions --test malformed_data_quarantine
cargo clippy -p freshell-sessions --all-targets -- -D warnings
npm run test:vitest -- run test/unit/server/coding-cli/session-indexer-malformed-corpus.test.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium test/e2e-browser/specs/session-malformed-data.spec.ts   # probe leg 1
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/session-malformed-data.spec.ts     # probe leg 2
```
