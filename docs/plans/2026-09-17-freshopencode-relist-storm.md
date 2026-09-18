# Freshopencode Re-list Storm Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- The Freshell Rust server returns to an idle steady state: eliminate the freshopencode session-indexer read amplification — the context-meter usage walks that re-run for every opencode session on every opencode.db WAL-write dirty-mark re-list — removing the observed ~400K-read-syscalls/sec core burn so client WS frames stop lagging and the host-stats FRESHELL tile stays green.

### Explicit constraints
- Fix direction (user-adopted): the session-row-stamped usage cache is the clean fix — do not re-run usage walks for sessions whose row (e.g. time_updated) has not changed; coarsening the opencode dirty-marking may complement it.
- Root cause (adopted diagnosis): commit 9b5a4458's freshopencode context meter added per-session usage walks to a listing path that re-lists the whole opencode provider on any opencode.db/-wal change (inotify + ~200ms debounce; ~15 active opencode agents on the machine keep the WAL moving; 16GB DB, thousands of sessions), pegging 1-2 tokio workers and delaying WS frames.
- Work in a .worktrees/<slug> worktree on a branch from origin/main; red/green/refactor TDD with unit + integration coverage.
- The user's opencode DB (~/.local/share/opencode/opencode.db) is read-only in every Freshell code path (SQLITE_OPEN_READ_ONLY); never restart the live shared opencode sidecar; never query the real DB — use fixtures only.
- Do not restart the production server (port 3001) as part of this run; deploying requires the user's explicit "APPROVED" (not requested). No PR creation without explicit user approval.

### Accepted tradeoffs and residuals
- The leftover sandbox server on port 3499 was already stopped (user-approved) before this run.
- Meter data for a session may be served from a row-change-stamped cache rather than re-walked on every re-list; staleness is bounded by the session row's change stamp.
- Deploying the built fix to the production server is a separate, user-approved step outside this run.

**Goal:** Under sustained opencode WAL activity (~15 agents writing continuously), the server's session-index refresh stops burning a core: per-re-list work scales with changed session rows instead of all listed sessions, the tokio runtime returns to idle (host-stats FRESHELL tile green, client WS frames timely), and no-op re-lists stop fanning spurious `sessions.changed` refetch storms to every client.

**Architecture:** Four changes, all inside `crates/freshell-sessions`. (1) `OpencodeProvider` (the parse layer) gains a row-stamped usage cache: the full listing still re-runs on every dirty-mark/WAL-move re-list (that trigger contract is pinned and untouched), but the per-session usage walk `last_step_finish_usage_for_session` executes only for rows whose raw `time_updated` stamp moved; a locator-style atomic counter (`usage_walk_count`, mirroring `OpencodeLocator::db_scan_count`) makes the walk observable so tests can prove unchanged rows skip it. (2) The same row-stamped regime covers the listing's 3-views marker `EXISTS` probes — measured at ~99.7% of the live full-listing cost (validated Stage 2: 1257 ms with marker arms, 4 ms without; ≈0.83 ms/session × 1505 listed rows): the listing SELECT drops the inline marker subqueries and fills each row's marker from a `(session_id, time_updated)`-stamped cache, probing only stamp-moved/new/NULL-stamp rows. (3) An index-level integration test pins the end-to-end statement through a real `SessionIndex` — a WAL move re-lists without re-walking; a row-stamp bump re-walks exactly that session — via a tiny read-only seam on `CountingWrapper` plus a delegating accessor on `OpencodeSource`. (4) The direct arm of `SessionIndex::refresh_snapshot` stops counting byte-identical re-lists as changes, mirroring the file-backed arm's `content_moved` rule, so a WAL move that changed no listed row no longer advances the change generation and no longer broadcasts `sessions.changed` to every client.

**Tech Stack:** Rust workspace (rusqlite read-only queries, std sync primitives — `Mutex`/`AtomicU64`, tokio async test harness), Cargo unit + integration tests. No client/TypeScript changes; no wire-schema changes.

## Global Constraints

- TDD red/green/refactor for every change; never skip tests; keep the refactor step. Narrowed cargo selectors only (delegated, no coordinator gate mid-task); the run's final full-suite verification goes through the coordinated gate at the end, never raw mid-task.
- The real opencode DB (`~/.local/share/opencode/opencode.db`, multi-GB) is READ-ONLY in every production code path (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_URI`); tests use writable fixture DBs in temp dirs, never the real DB. Stage-2 live validation queries were the recorded read-only exception, with receipts under the run's logs directory (validator reports A, A2, B).
- The re-list TRIGGER contract is unchanged: `opencode_change_token_gating_unchanged_no_requery_wal_touch_requeries` (crates/freshell-sessions/src/directory_index.rs:4130-4167) must pass unmodified — this fix bounds the INSIDE of `direct_list`, not its frequency.
- Cache the RAW `OpencodeStepUsage` and the RAW marker boolean keyed by the row's raw `time_updated` stamp — never the resolved `TokenSummary`. The opencode_limits F2 nudge (`crates/freshell-server/src/opencode_limits.rs:202-211`) re-lists precisely to apply NEW model limits to UNCHANGED usage; `refresh_once_fills_the_snapshot_relists_and_lights_the_meter` (opencode_limits.rs:534) must stay green.
- The wire contract is untouched: `TokenSummary` emission semantics stay byte-identical (zod `.positive()` bounds, hard `.parse` at src/lib/api.ts:646/:681). A cached value must be exactly what a fresh walk would emit for the same row.
- A NULL `time_updated` row is never cache-validated (always re-walked / re-probed) — it cannot be stamp-checked, matching pre-cache behavior. Validated Stage 2: the live DB has zero NULL-stamp listed rows (validator A), so this is a correctness guard, not a live-workload path.
- Degrade discipline (the `FIRST_USER_MESSAGE_SQL` precedent, docs/plans/2026-09-14-freshopencode-context-meter.md Global Constraints line 36): any cache/lock/query error path degrades to re-walk/re-probe or the old value, never breaks the listing. Lock poisoning recovers via `unwrap_or_else(|poisoned| poisoned.into_inner())`.
- Test-timing discipline (validated Stage 2, finder F-01): `SessionIndex::snapshot()` is stale-while-revalidate — a stale-but-present cache spawns a DETACHED refresh and returns immediately (directory_index.rs:1296-1362; only the truly cold first call awaits inline), and under `#[tokio::test]`'s current-thread runtime a spawned sweep only runs when the test task yields. Every index-level test settles on its observable counter via the crate's `wait_until` helper (:2521-2532) before asserting — never a bare sleep-and-assert — and guarantees TTL staleness with the 10 ms-TTL/30 ms-sleep idiom of the gating test (:4130-4167). The file-backed `content_identical` twin (:3009-3101) is the template.
- Negative/observability rule (session_watcher_tests.rs:405-413): assert on counters (observable work), never only on `subscribe_changes()`.
- Rust style gates before push: `cargo fmt --all --check`; `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`.
- Library crates emit `tracing` only (warn! on degrade paths, debug! for chatty paths); no subscriber install in freshell-sessions.
- No PR creation without explicit user approval. No production-server (port 3001) restart; deploying is outside this run. Commits use the repo-configured identity (Dan Shapiro <3732858+danshapiro@users.noreply.github.com>) — never `dan@danshapiro.com` as author.
- No user-facing UI or behavior change: no README, docs/index.html, or client changes.
- The caches are in-memory only and live for the provider's process lifetime (one instance inside `OpencodeSource`, held by the `SessionIndex`): `rust-session-cache.json` and `CACHE_SCHEMA_VERSION` are untouched — no persistence-format change.

### Stage-2 validated facts (decisions recorded; evidence in the validator reports, cited by path)

1. **`time_updated` bump semantics (LB-01, validator B; corroborated by validator A's live sampling):** opencode v1.18.31 (the installed version — verified) bumps `session.time_updated` on EVERY user prompt (`SessionPrompt.prompt` → `sessions.touch` → full-row projector write) and on EVERY step-finish (the processor writes the step-finish part, then forks `summarize`, whose first statement is an unconditional `setSummary` `Date.now()` bump; per-aggregate event-seq ordering lands the bump only after the part row commits). Message creates and part appends (including step-finish rows) NEVER bump directly. Consequence: row-stamp cache staleness is step-bounded during turns and turn-bounded at worst — the accepted residual is a bounded lag, not a freeze. Fixture corollary (N-02): fixture tests MUST move `time_updated` explicitly — a bare message/part insert does not reproduce a bump (the re-walk legs below already do this; the staleness-leg test documents the opposite deliberately).
2. **Marker `EXISTS` cost (LB-02, validators A + A2; fallback leg validator B):** on the live 17 GB DB the full production listing took 1257 ms real for 1505 listed rows; the identical SELECT minus the two marker `EXISTS` arms took 4 ms — the marker arms are ≈99.7% of the cost (≈0.83 ms/session). Both arms are index searches (`part_session_idx (session_id)` exists live and is declared at v1.18.31 — migration 20260127222353, never dropped; the repo's recorded inventory was incomplete). `session` has no `time_updated` index (scan+sort is the 4 ms working baseline). Consequence: the marker cache (Task 2) is REQUIRED — the usage cache alone leaves ~65-130% of a core burning at the 0.5-1 re-list/s cadence; with both row-stamped caches the measured residual is ≈4 ms listing + ≈45-90 ms unnamed-subset first-message lookups ≈ 51 ms/re-list (~2.5-5% of a core) — idle steady state by design, no cadence coarsening required.
3. **NULL stamps (LB-03, validator A):** zero NULL-`time_updated` listed rows live — Task 4's content-identical suppression is effective on production data.
4. **Unnamed subset (LB-04, validator A):** 225 strict (228 loose) of 1505 listed sessions still need naming, at a fresh-measured ≈0.2 ms/lookup (20 lookups, 4 ms total, all ≤1 ms) — the deliberately-uncached first-message lookups cost ≈45-90 ms/re-list, immaterial. First-message caching stays a non-goal.
5. **Detached refresh (finder F-01, coordinator spot-checked):** covered by the test-timing constraint above; Tasks 3 and 4's tests settle via `wait_until`.
6. **`changed` consumers (finder F-02, coordinator spot-checked):** `changed` feeds BOTH the change-generation publish decision (directory_index.rs:1772-1774) AND the persistent-parse-cache save gate `take_pending_save_from_parts` (:1779-1785). Task 4's suppression effect on the second consumer is benign-to-beneficial: `DirectEntry` is in-memory only, so today's WAL storm was accumulating phantom save pressure over an unchanged file-backed cache; post-fix saves are driven by real changes only. No contract is violated (save cadence is threshold/debounce-gated, :1813-1849); the reconciliation must be echoed in Task 4's task result.
7. **`IndexedSession` derives `PartialEq`** (directory_index.rs:60; the file-backed comparison at :2125 compiles today) and `is_none_or` is already used at base (:1670, :1842) — Task 4's comparison needs no new derives or MSRV action.

### Recorded accepted residuals (validated, not silently deferred)

- **Marker staleness (Task 2):** a marker part written without any subsequent session-row stamp bump is served stale until the session's next activity (its next prompt or step-finish — both bump). This affects only the listing's `is_subagent`/`is_non_interactive` decoration; the by-id classification paths (`session_is_subagent_by_id`, the locator candidate query) are unchanged and evaluate fresh. Bounded, self-healing, and consistent with the user-adopted row-stamp regime.
- **Error-None caching (Task 1):** the walk returns `None` both for a legitimate miss (no step-finish yet; the 64-probe cap) and for a transient error (prepare/query failure). Both are cached identically by design: the cap-None case MUST stay cached (a pathological 64-probe session is the storm's worst case), and an error-None leaves the meter dark for that (session, stamp) until the stamp moves — diagnosable via the existing `tracing::debug!` on every degrade path. Pre-cache behavior healed on the next re-list at the cost of the storm itself.
- **Boot cost (finder N-04):** a server restart clears both in-memory caches and pays one full cold walk+probe set (thousands of bounded walks/probes) at boot — identical to today's every-re-list cost, paid once. Deploy expectation only.
- **Mid-listing snapshot variance (finder N-03):** pre-existing (the listing statement and per-session probes run as separate autocommit snapshots on one connection); the caches do not worsen it; self-corrects on the next re-list.

### Non-goals (recorded, not silent deferrals)

- Caching `first_user_message` lookups: validated immaterial (≈45-90 ms/re-list at current scale, fact 4). OPTIONAL improvement, not required.
- Coarsened/rate-limited opencode dirty-marking (the adopted direction's optional complement): not needed for the goal — the measured post-fix residual (~51 ms/re-list) fits the idle budget at the debounce-floor cadence (fact 2). Revisit only if post-deploy observation shows otherwise.
- No changes to the watcher, debouncer, change-token logic, the locator candidate query (`run_opencode_candidate_query` keeps its inline markers — it is bounded by floor+LIMIT 200 and throttled to ≤1 read/terminal/60 s), host-stats collection, or any client code.

---

### Task 1: Row-stamped usage cache + walk counter in `OpencodeProvider`

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (struct at :638-647, listing loop at :757-761, return at :777)
- Test: `crates/freshell-sessions/tests/opencode_usage.rs` (extend the existing fixture suite)

**Interfaces:**
- Produces: `OpencodeProvider::usage_walk_count(&self) -> u64` (pub test/diagnostic accessor mirroring `OpencodeLocator::db_scan_count`, opencode_locator.rs:177/:227-229); internal cache fields (private) consulted by `list_sessions`.
- Consumes: existing `OpencodeSessionRow.last_activity_at: Option<i64>` (the raw row stamp, already SELECTed as `s.time_updated AS lastActivityAt` at parse/opencode.rs:592, mapped at :619), `OpencodeStepUsage` (PartialEq, at :155-163), `last_step_finish_usage_for_session` (:377-502, unchanged).

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-sessions/tests/opencode_usage.rs`: extend the existing `use` for `OpencodeSession` (the file currently has `use freshell_sessions::parse::OpencodeProvider;` per its helper conventions — change it to `use freshell_sessions::parse::{OpencodeProvider, OpencodeSession};`), then append after the last existing test (`legacy_schema_without_model_column_stays_listable`, ends ~:372):

```rust
// ── Row-stamped usage cache (freshopencode re-list storm fix) ──────────
//
// Production shape under test: every dirty-mark/WAL-move re-list re-runs
// the WHOLE listing (the pinned change-token contract), but the usage walk
// must only execute for rows whose time_updated moved. The provider's
// walk counter (mirroring OpencodeLocator::db_scan_count) is the
// observable-work seam: cache hits never increment it.
//
// Fixture note (Stage-2 validated fact 1): live opencode bumps
// session.time_updated on prompts and step-finishes, NOT on bare
// message/part inserts — so these fixtures move the stamp EXPLICITLY
// wherever a re-walk is expected (and the staleness-leg test deliberately
// does not, to pin the accepted bound).

fn list_sessions_from(provider: &OpencodeProvider, now_ms: i64) -> Vec<OpencodeSession> {
    provider.list_sessions(now_ms).expect("read ok").sessions
}

#[test]
fn usage_cache_unchanged_row_stamp_skips_the_walk() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
    drop(conn);
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = list_sessions_from(&provider, 42);
    assert_eq!(first.len(), 1);
    assert_eq!(provider.usage_walk_count(), 1);
    let second = list_sessions_from(&provider, 43);
    assert_eq!(
        provider.usage_walk_count(),
        1,
        "an unchanged session row (time_updated still 5000) must not re-run the usage walk"
    );
    assert_eq!(second[0].last_usage, first[0].last_usage);
}

#[test]
fn usage_cache_row_stamp_change_rewalks_exactly_that_session() {
    let dir = TmpDir::new();
    {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        create_schema(&conn);
        insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
        insert_session(&conn, "ses_2", "Named", Some(MODEL_JSON));
        insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
        insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
        insert_message(&conn, "msg_2", "ses_2", 100, "assistant");
        insert_part(&conn, "prt_2", "msg_2", "ses_2", STEP_FINISH_FULL);
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let _ = list_sessions_from(&provider, 42);
    assert_eq!(provider.usage_walk_count(), 2);

    // ses_1's row changes: a newer step-finish with different tokens + a stamp bump.
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    insert_message(&conn, "msg_3", "ses_1", 200, "assistant");
    insert_part(
        &conn,
        "prt_3",
        "msg_3",
        "ses_1",
        r#"{"reason":"stop","type":"step-finish","tokens":{"total":777777,"input":7,"output":7,"reasoning":1,"cache":{"write":0,"read":777763}},"cost":0}"#,
    );
    conn.execute(
        "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_1'",
        [],
    )
    .unwrap();
    drop(conn);

    let second = list_sessions_from(&provider, 43);
    assert_eq!(
        provider.usage_walk_count(),
        3,
        "only the session whose row stamp moved re-walks"
    );
    let ses1 = second.iter().find(|s| s.session_id == "ses_1").unwrap();
    assert_eq!(ses1.last_usage.as_ref().unwrap().total, Some(777_777));
    let ses2 = second.iter().find(|s| s.session_id == "ses_2").unwrap();
    assert_eq!(ses2.last_usage.as_ref().unwrap().total, Some(215_242));
}

#[test]
fn usage_cache_serves_cached_usage_until_the_row_stamp_moves() {
    // The accepted residual, pinned deliberately: a step-finish written
    // WITHOUT a session-row change serves the cached value; the staleness
    // bound is the session row's time_updated (live opencode bumps the row
    // on prompts and step-finishes — the fixture here deliberately does NOT).
    let dir = TmpDir::new();
    {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        create_schema(&conn);
        insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
        insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
        insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = list_sessions_from(&provider, 42);
    assert_eq!(first[0].last_usage.as_ref().unwrap().total, Some(215_242));

    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    insert_part(
        &conn,
        "prt_2",
        "msg_1",
        "ses_1",
        r#"{"reason":"stop","type":"step-finish","tokens":{"total":999999,"input":9,"output":9,"reasoning":1,"cache":{"write":0,"read":999981}},"cost":0}"#,
    );
    drop(conn);
    let stale = list_sessions_from(&provider, 43);
    assert_eq!(
        stale[0].last_usage.as_ref().unwrap().total,
        Some(215_242),
        "without a row-stamp move the cached value is served (the documented bound)"
    );

    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute(
        "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_1'",
        [],
    )
    .unwrap();
    drop(conn);
    let fresh = list_sessions_from(&provider, 44);
    assert_eq!(fresh[0].last_usage.as_ref().unwrap().total, Some(999_999));
}

#[test]
fn usage_cache_null_time_updated_row_is_never_cached() {
    let dir = TmpDir::new();
    {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        create_schema(&conn);
        conn.execute(
            "INSERT INTO session VALUES ('ses_1', '/repo/x', 'Named', 1000, NULL, NULL, NULL, NULL, ?1)",
            rusqlite::params![MODEL_JSON],
        )
        .unwrap();
        insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
        insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = list_sessions_from(&provider, 42);
    assert_eq!(first[0].last_usage.as_ref().unwrap().total, Some(215_242));
    assert_eq!(provider.usage_walk_count(), 1);
    let _ = list_sessions_from(&provider, 43);
    assert_eq!(
        provider.usage_walk_count(),
        2,
        "a NULL time_updated row cannot be stamp-validated and always re-walks"
    );
}

#[test]
fn usage_cache_caches_a_none_result_until_the_row_stamp_moves() {
    // None is cached like any result — BOTH the legitimate miss (no
    // step-finish yet) and the transient-error degrade return None
    // indistinguishably (recorded residual, Stage-2 validated facts §7):
    // the cap-None pathological session is exactly the storm's worst case
    // and must not re-walk per re-list.
    let dir = TmpDir::new();
    {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        create_schema(&conn);
        insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
        insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
        insert_part(&conn, "prt_1", "msg_1", "ses_1", r#"{"type":"text","text":"no finish yet"}"#);
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = list_sessions_from(&provider, 42);
    assert_eq!(first[0].last_usage, None);
    assert_eq!(provider.usage_walk_count(), 1);
    let second = list_sessions_from(&provider, 43);
    assert_eq!(second[0].last_usage, None);
    assert_eq!(
        provider.usage_walk_count(),
        1,
        "a None walk result (miss or degrade) is cached like any result"
    );

    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    insert_part(&conn, "prt_2", "msg_1", "ses_1", STEP_FINISH_FULL);
    conn.execute(
        "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_1'",
        [],
    )
    .unwrap();
    drop(conn);
    let third = list_sessions_from(&provider, 44);
    assert_eq!(third[0].last_usage.as_ref().unwrap().total, Some(215_242));
    assert_eq!(provider.usage_walk_count(), 2);
}

#[test]
fn usage_cache_prunes_sessions_that_left_the_listing() {
    let dir = TmpDir::new();
    {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        create_schema(&conn);
        insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
        insert_session(&conn, "ses_2", "Named", Some(MODEL_JSON));
        insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
        insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
        insert_message(&conn, "msg_2", "ses_2", 100, "assistant");
        insert_part(&conn, "prt_2", "msg_2", "ses_2", STEP_FINISH_FULL);
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let _ = list_sessions_from(&provider, 42);
    assert_eq!(provider.usage_walk_count(), 2);

    // ses_2 archives (leaves the listing)...
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute("UPDATE session SET time_archived = 6000 WHERE id = 'ses_2'", [])
        .unwrap();
    drop(conn);
    let _ = list_sessions_from(&provider, 43); // ses_2 gone; ses_1 cached
    assert_eq!(provider.usage_walk_count(), 2);

    // ...then returns with the SAME time_updated stamp but different part
    // data: the prune means it is not a cache hit — the re-list re-walks it.
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute("UPDATE session SET time_archived = NULL WHERE id = 'ses_2'", [])
        .unwrap();
    conn.execute("DELETE FROM part WHERE id = 'prt_2'", []).unwrap();
    insert_part(
        &conn,
        "prt_2",
        "msg_2",
        "ses_2",
        r#"{"reason":"stop","type":"step-finish","tokens":{"total":888888,"input":8,"output":8,"reasoning":1,"cache":{"write":0,"read":888872}},"cost":0}"#,
    );
    drop(conn);
    let third = list_sessions_from(&provider, 44);
    let ses2 = third.iter().find(|s| s.session_id == "ses_2").unwrap();
    assert_eq!(
        ses2.last_usage.as_ref().unwrap().total,
        Some(888_888),
        "a session re-entering the listing is re-walked even under an unchanged stamp"
    );
    assert_eq!(provider.usage_walk_count(), 3);
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --test opencode_usage`

Expected: FAIL — compile error, `no method named usage_walk_count found for struct OpencodeProvider` (the missing observation seam is the missing behavior; every new test exercises the cache contract it cannot observe yet).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/parse/opencode.rs`:

(1) Add the cache entry type near the `OpencodeProvider` struct (:638), and extend the struct + constructor (:638-647). All new std paths fully qualified — no new imports:

```rust
/// One cached usage-walk result, keyed by session id and validated by the
/// session row's `time_updated` stamp (the listing already SELECTs it as
/// `lastActivityAt`). `usage: None` is a legitimate cached value — a walk
/// that found no step-finish, a capped miss, or a transient-error degrade
/// — the stamp, not the value, decides freshness (freshopencode re-list
/// storm fix: docs/plans/2026-09-17-freshopencode-relist-storm.md).
#[derive(Debug, Clone)]
struct CachedUsage {
    stamp: i64,
    usage: Option<OpencodeStepUsage>,
}

/// The read-only opencode provider (path derivation + direct listing).
pub struct OpencodeProvider {
    home_dir: PathBuf,
    /// Row-stamped usage-walk cache: every dirty-mark/WAL-move re-list
    /// re-runs the whole listing (the pinned trigger contract), but the
    /// per-session usage walk only re-executes for rows whose
    /// `time_updated` moved. Pruned to the listed id-set at the end of
    /// each successful listing, so the map stays O(live sessions).
    usage_cache: std::sync::Mutex<std::collections::HashMap<String, CachedUsage>>,
    /// Counts actual usage-walk executions (cache misses) — test/diagnostic
    /// hook mirroring `OpencodeLocator::db_scan_count`
    /// (crates/freshell-sessions/src/opencode_locator.rs:172-177).
    usage_walks: std::sync::atomic::AtomicU64,
}
```

```rust
    pub fn new(home_dir: impl Into<PathBuf>) -> Self {
        Self {
            home_dir: home_dir.into(),
            usage_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            usage_walks: std::sync::atomic::AtomicU64::new(0),
        }
    }
```

(2) Add the pub accessor in the `impl OpencodeProvider` block (next to `database_path`, ~:650):

```rust
    /// How many usage walks have actually executed (cache misses) so far —
    /// test/diagnostic hook mirroring `OpencodeLocator::db_scan_count`:
    /// proves unchanged session rows skip the walk across re-lists.
    pub fn usage_walk_count(&self) -> u64 {
        self.usage_walks
            .load(std::sync::atomic::Ordering::SeqCst)
    }
```

(3) Add the cache-or-walk helper as a private free function next to `last_step_finish_usage_for_session` (after :502):

```rust
/// Cache-or-walk wrapper around [`last_step_finish_usage_for_session`]:
/// consults the row-stamped cache first; only a stamp change (or a NULL
/// stamp, which can never be validated) executes the walk. `None` results
/// are cached like any other — a walk that legitimately found nothing
/// should not re-run per re-list (the pathological 64-probe-cap session is
/// exactly the one this must not re-walk on every WAL move). A poisoned
/// lock recovers rather than breaking the listing (degrade discipline).
fn cached_or_walked_usage(
    cache: &std::sync::Mutex<std::collections::HashMap<String, CachedUsage>>,
    walk_count: &std::sync::atomic::AtomicU64,
    conn: &Connection,
    row: &OpencodeSessionRow,
) -> Option<OpencodeStepUsage> {
    let Some(stamp) = row.last_activity_at else {
        // NULL time_updated: never cacheable — no stamp to validate
        // against. Always walk, exactly as the pre-cache code did.
        walk_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return last_step_finish_usage_for_session(conn, &row.session_id);
    };
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(hit) = cache.get(&row.session_id) {
        if hit.stamp == stamp {
            return hit.usage.clone();
        }
    }
    walk_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let usage = last_step_finish_usage_for_session(conn, &row.session_id);
    cache.insert(
        row.session_id.clone(),
        CachedUsage {
            stamp,
            usage: usage.clone(),
        },
    );
    usage
}
```

(4) Replace the walk call site in `list_sessions`'s row loop (:757-761) — the model gate is unchanged:

```rust
            let model = row.model.as_deref().and_then(opencode_model_composite);
            // Bounded usage lookup, gated on a resolvable model: usage
            // without a model can never produce meter fields (limits are
            // resolved per model), so those sessions skip the query. The
            // row-stamped cache serves unchanged rows without re-walking.
            let last_usage = if model.is_some() {
                cached_or_walked_usage(&self.usage_cache, &self.usage_walks, &conn, &row)
            } else {
                None
            };
```

(5) Prune the cache to the listed id-set immediately before the successful return (:777) — build the id set first so the prune stays O(n), not O(n²). Task 2 will extend this same prune block to the marker cache:

```rust
        // Prune the usage cache to the listed id-set: sessions that left
        // the listing (archived, deleted) drop their cached walk so a
        // later re-entry re-walks even under an unchanged stamp.
        {
            let listed: std::collections::HashSet<&str> =
                sessions.iter().map(|s| s.session_id.as_str()).collect();
            self.usage_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retain(|id, _| listed.contains(id.as_str()));
        }

        Ok(OpencodeListing { sessions, degrade })
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions --locked --test opencode_usage`

Expected: PASS — all 16 tests (10 existing + 6 new).

- [ ] **Step 5: Refactor while green**

Fold the repeated `Connection::open(dir.join("opencode.db")).unwrap()` reopen in the new tests into a tiny local helper only if it reads better next to the file's existing per-test block style; no production-code refactor is expected beyond the helper placement chosen in Step 3.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every opencode integration target (all share the provider/fixture conventions), the parse-layer unit tests, the locator tests (they construct `OpencodeProvider::new`), and the index-level opencode tests (they construct `OpencodeSource` and consume listings):

```bash
cargo test -p freshell-sessions --locked --test opencode_usage --test opencode_first_message --test opencode_sqlite --test opencode_exists_by_id --test opencode_row_by_id --test opencode_subagent_by_id --test malformed_data_quarantine
cargo test -p freshell-sessions --locked --lib -- parse::opencode
cargo test -p freshell-sessions --locked --lib -- opencode_locator
cargo test -p freshell-sessions --locked --lib -- directory_index::tests::opencode
```

Expected: PASS everywhere.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/tests/opencode_usage.rs
git commit -m "feat(sessions): row-stamped usage cache bounds freshopencode re-list walk cost"
```

---

### Task 2: Row-stamped marker cache in `OpencodeProvider` (the 99.7% cost)

**Why (Stage-2 validated fact 2, validators A + A2):** the live full listing took 1257 ms for 1505 rows; the identical SELECT minus the two marker `EXISTS` arms took 4 ms. The usage cache alone leaves ~65-130% of a core burning at the re-list cadence; this task applies the same row-stamped regime to the marker probes, bringing the per-re-list listing cost to the measured 4 ms baseline.

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (`run_opencode_query_inner` at :504-635; `OpencodeProvider` struct/constructor from Task 1; `list_sessions` row loop at :737; `run_opencode_listing_query` / `run_opencode_candidate_query` call sites at :716-717 / :786-807)
- Test: `crates/freshell-sessions/tests/opencode_sqlite.rs` (extend the marker/listing fixture suite)

**Interfaces:**
- Produces: `OpencodeProvider::marker_probe_count(&self) -> u64`; internal `marker_cache` field; `OpencodeListingResult` gains the table census flags (`has_part_table: bool, has_message_table: bool`) so the per-session probe can assemble only the arms that exist.
- Consumes: Task 1's prune block and stamp discipline; the marker predicates at parse/opencode.rs:547-563 (lifted verbatim into a standalone probe); `THREE_VIEWS_MARKER_SQL_PATTERN` (:18).
- Unchanged by design: `run_opencode_candidate_query` (the locator path) keeps inline markers — it is bounded (floor + LIMIT 200) and throttled; `OpencodeSessionRow.has_three_views_marker` stays (the candidate path maps it); `list_sessions_since` never touches either cache.

- [ ] **Step 1: Write the failing behavioral tests**

In `tests/opencode_sqlite.rs`, append after the existing marker tests (the file's `TmpDir` guard and `Connection` conventions are identical to opencode_usage.rs):

```rust
// ── Row-stamped marker cache (freshopencode re-list storm fix) ─────────
//
// Stage-2 measured the marker EXISTS arms at ~99.7% of the live listing
// cost (1257 ms -> 4 ms without them), so the listing SELECT drops the
// inline subqueries and fills each row's marker from a
// (session_id, time_updated)-stamped cache — probing only stamp-moved,
// new, and NULL-stamp rows. The provider's probe counter is the
// observable-work seam; cache hits never increment it.

fn marker_list_sessions(
    provider: &OpencodeProvider,
    now_ms: i64,
) -> Vec<freshell_sessions::parse::OpencodeSession> {
    provider.list_sessions(now_ms).expect("read ok").sessions
}

fn marker_fixture_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT, model TEXT
         );
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
            time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT);",
    )
    .unwrap();
}

fn marker_insert_session(conn: &Connection, id: &str, updated: i64) {
    conn.execute(
        "INSERT INTO session VALUES (?1, '/repo/x', 'Named', 1000, ?2, NULL, NULL, NULL, NULL)",
        rusqlite::params![id, updated],
    )
    .unwrap();
}

/// The production marker pattern is `%<freshell-session-metadata
/// origin=3-views%` (THREE_VIEWS_MARKER_SQL_PATTERN, parse/opencode.rs:18)
/// — any data payload containing that substring marks the row.
fn marker_payload() -> String {
    r#"{"text":"<freshell-session-metadata origin=3-views marker"}"#.to_string()
}

#[test]
fn marker_cache_unchanged_row_stamp_skips_the_probe() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    marker_fixture_schema(&conn);
    marker_insert_session(&conn, "ses_1", 5000);
    // The marker lives in a message row (the message arm of the old EXISTS).
    conn.execute(
        "INSERT INTO message VALUES ('msg_1', 'ses_1', 100, ?1)",
        rusqlite::params![marker_payload()],
    )
    .unwrap();
    drop(conn);
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = marker_list_sessions(&provider, 42);
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].is_subagent,
        Some(true),
        "a session carrying the marker part is still classified (probe path)"
    );
    assert_eq!(provider.marker_probe_count(), 1);
    let second = marker_list_sessions(&provider, 43);
    assert_eq!(
        provider.marker_probe_count(),
        1,
        "an unchanged session row must not re-run the marker probe"
    );
    assert_eq!(second[0].is_subagent, Some(true));
}

#[test]
fn marker_cache_row_stamp_change_reprobes_exactly_that_session() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    marker_fixture_schema(&conn);
    marker_insert_session(&conn, "ses_1", 5000);
    marker_insert_session(&conn, "ses_2", 5000);
    drop(conn);
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = marker_list_sessions(&provider, 42);
    assert_eq!(first.len(), 2);
    assert!(first.iter().all(|s| s.is_subagent.is_none()));
    assert_eq!(provider.marker_probe_count(), 2);

    // ses_1 gains a marker part AND a stamp bump; ses_2's stamp is untouched.
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute(
        "INSERT INTO part VALUES ('prt_1', NULL, 'ses_1', 100, NULL, ?1)",
        rusqlite::params![marker_payload()],
    )
    .unwrap();
    conn.execute(
        "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_1'",
        [],
    )
    .unwrap();
    drop(conn);

    let second = marker_list_sessions(&provider, 43);
    assert_eq!(
        provider.marker_probe_count(),
        3,
        "only the session whose row stamp moved re-probes"
    );
    let ses1 = second.iter().find(|s| s.session_id == "ses_1").unwrap();
    assert_eq!(ses1.is_subagent, Some(true));
    let ses2 = second.iter().find(|s| s.session_id == "ses_2").unwrap();
    assert_eq!(ses2.is_subagent, None, "cached unmarked value is served");
}

#[test]
fn marker_cache_serves_stale_marker_until_the_row_stamp_moves() {
    // The accepted residual, pinned deliberately (Stage-2 validated facts,
    // marker-staleness row): a marker part written WITHOUT a session-row
    // change serves the cached (unmarked) value; live opencode bumps the
    // row on every prompt and step-finish, so the bound is the session's
    // next activity.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    marker_fixture_schema(&conn);
    marker_insert_session(&conn, "ses_1", 5000);
    drop(conn);
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let first = marker_list_sessions(&provider, 42);
    assert_eq!(first[0].is_subagent, None);
    assert_eq!(provider.marker_probe_count(), 1);

    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute(
        "INSERT INTO message VALUES ('msg_1', 'ses_1', 100, ?1)",
        rusqlite::params![marker_payload()],
    )
    .unwrap();
    drop(conn);
    let stale = marker_list_sessions(&provider, 43);
    assert_eq!(
        stale[0].is_subagent,
        None,
        "without a row-stamp move the cached marker is served (the documented bound)"
    );

    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute(
        "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_1'",
        [],
    )
    .unwrap();
    drop(conn);
    let fresh = marker_list_sessions(&provider, 44);
    assert_eq!(fresh[0].is_subagent, Some(true));
}

#[test]
fn marker_cache_degraded_schema_never_probes_and_never_caches() {
    // Neither marker table exists: the old inline marker_expr was the
    // literal 0 (unmarked for every row, zero marker SQL); the cache
    // preserves that — no probe, no probe-count movement across re-lists.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT, model TEXT
         );",
    )
    .unwrap();
    marker_insert_session(&conn, "ses_1", 5000);
    drop(conn);
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let _ = marker_list_sessions(&provider, 42);
    let _ = marker_list_sessions(&provider, 43);
    assert_eq!(
        provider.marker_probe_count(),
        0,
        "a schema without marker tables issues no probes and stays unmarked"
    );
}
```

Note on `is_subagent`: the listing maps `Some(true)` when the marker is 1 and `None` when it is 0 (`is_subagent: if is_three_views { Some(true) } else { None }`, parse/opencode.rs:769-770) — the tests above assert that mapping.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --test opencode_sqlite`

Expected: FAIL — compile error, `no method named marker_probe_count found for struct OpencodeProvider`.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/parse/opencode.rs`:

(1) `OpencodeProvider` gains the marker cache + probe counter (same shape as Task 1's fields; add to the struct, the constructor, and a `marker_probe_count()` accessor mirroring `usage_walk_count`):

```rust
    marker_cache: std::sync::Mutex<std::collections::HashMap<String, CachedMarker>>,
    marker_probes: std::sync::atomic::AtomicU64,
```

```rust
/// One cached 3-views marker result, keyed by session id and validated by
/// the session row's `time_updated` stamp — the same regime as the usage
/// cache. `marker` is the 0/1 the inline EXISTS arms would have produced;
/// a schema with no marker tables yields 0 with no probe (the old inline
/// literal-0 degrade, preserved).
#[derive(Debug, Clone)]
struct CachedMarker {
    stamp: i64,
    marker: i64,
}
```

(2) `run_opencode_query_inner` (:504-635) gains an `inline_marker: bool` parameter: when `false` (the listing path), `marker_expr` becomes the literal `"0"` (keeping the SELECT's positional layout and the row-mapping indices untouched) and `marker_params` stays empty; when `true` (the candidate path), the current construction is byte-identical. The result struct also carries the census out:

```rust
/// OpencodeListingResult gains the marker-table census so the listing can
/// assemble per-session probes with only the arms that exist.
pub struct OpencodeListingResult {
    pub rows: Vec<OpencodeSessionRow>,
    pub schema_missing_parent_id: bool,
    pub has_part_table: bool,
    pub has_message_table: bool,
}
```

`run_opencode_listing_query` passes `inline_marker: false`; `run_opencode_candidate_query` passes `true` (byte-identical behavior there).

(3) The per-session probe (a private free function, next to the cache helpers):

```rust
/// Standalone per-session 3-views marker probe — the SAME two EXISTS
/// predicates the inline marker_expr used (parse/opencode.rs:547-563),
/// with only the arms whose tables exist; zero arms return 0 without
/// querying (the old literal-0 degrade, preserved).
fn probe_session_marker(
    conn: &Connection,
    has_part_table: bool,
    has_message_table: bool,
    marker_pattern: &str,
    session_id: &str,
) -> i64 {
    let mut arms: Vec<&str> = Vec::new();
    if has_part_table {
        arms.push(
            "EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = ?1 AND pa.data LIKE ?2)",
        );
    }
    if has_message_table {
        arms.push(
            "EXISTS (SELECT 1 FROM message m WHERE m.session_id = ?1 AND m.data LIKE ?2)",
        );
    }
    if arms.is_empty() {
        return 0;
    }
    let sql = format!("SELECT {}", arms.join(" OR "));
    match conn.query_row(
        &sql,
        rusqlite::params![session_id, marker_pattern],
        |row| row.get::<_, i64>(0),
    ) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode marker probe failed; serving unmarked (degrade discipline)"
            );
            0
        }
    }
}
```

(4) The cache-or-probe wrapper mirrors `cached_or_walked_usage` (NULL stamp → probe without caching; stamp hit → cached value; else probe + store), incrementing `marker_probes` only when a probe actually executes.

(5) In `list_sessions`'s row loop, replace `let is_three_views = row.has_three_views_marker == Some(1);` (:737) — the row's placeholder value from the stripped SELECT is never consumed — with:

```rust
            let has_three_views_marker = cached_or_probed_marker(
                &self.marker_cache,
                &self.marker_probes,
                &conn,
                result.has_part_table,
                result.has_message_table,
                THREE_VIEWS_MARKER_SQL_PATTERN,
                &row,
            );
            let is_three_views = has_three_views_marker == 1;
```

(6) Extend Task 1's prune block to retain the marker cache with the same listed-id set (one `retain` per map, one shared `HashSet`).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions --locked --test opencode_sqlite`

Expected: PASS — all existing listing/degrade tests plus the 4 new ones. In particular `full_schema_lists_root_sessions_with_marker_and_ordering` and `neither_part_nor_message_table_degrades_to_unmarked_no_crash` stay green (values are unchanged; only the work to obtain them is bounded).

- [ ] **Step 5: Refactor while green**

Fold any duplicated stamp/cache-hit logic between `cached_or_walked_usage` and `cached_or_probed_marker` ONLY if a shared generic helper reads strictly simpler than two parallel functions (keep both counters and both call sites explicit — merging the counters would blur the observable-work pins); state the chosen shape in the task result.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all opencode integration targets, the parse-layer unit tests (the inner query's signature changed), the locator tests (they consume `list_sessions_since` — unchanged, but the provider struct changed), and the index-level opencode tests:

```bash
cargo test -p freshell-sessions --locked --test opencode_usage --test opencode_sqlite --test opencode_first_message --test opencode_exists_by_id --test opencode_row_by_id --test opencode_subagent_by_id --test malformed_data_quarantine
cargo test -p freshell-sessions --locked --lib -- parse::opencode
cargo test -p freshell-sessions --locked --lib -- opencode_locator
cargo test -p freshell-sessions --locked --lib -- directory_index::tests::opencode
```

Expected: PASS everywhere.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/tests/opencode_sqlite.rs
git commit -m "feat(sessions): row-stamped marker cache drops the re-list listing to its 4ms baseline"
```

---

### Task 3: Index-level proof — WAL moves re-list without re-walking unchanged sessions

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (`CountingWrapper` at :2631-2652, `OpencodeSource` at :698-725; tests in the same file's `mod tests`, modeled on :4130-4167)

**Interfaces:**
- Consumes: `OpencodeProvider::usage_walk_count()` (Task 1), existing `CountingWrapper` counters, existing fixture helpers `opencode_data_home_with_sessions` (:3887-3913), `set_opencode_session_model` (:4012-4019), `seed_opencode_step_finish` (:3998-4009, fixed ids `msg_usage`/`prt_usage` — one session per call), `ensure_opencode_message_tables`/`insert_opencode_message`/`insert_opencode_part` (:3921-3974), `OPENCODE_TEST_MODEL` (:4212-4213), `test_index_with_ttl` (:2560), `wait_until` (:2521-2532).
- Produces: `CountingWrapper::counting_inner(&self) -> &S` (pub(crate)); `OpencodeSource::usage_walk_count(&self) -> u64` (pub).

**Timing discipline (Global Constraints, finder F-01):** the first (cold) snapshot runs inline; every later snapshot on a stale cache spawns a DETACHED sweep and returns stale immediately — so each later leg is `sleep(30ms)` (guarantee TTL staleness past the 10ms test TTL) → `snapshot()` → `wait_until(...)` on the counter → assert. Never bare-sleep-and-assert.

- [ ] **Step 1: Write the failing behavioral test**

In `directory_index.rs` `mod tests`, next to `opencode_change_token_gating_unchanged_no_requery_wal_touch_requeries` (:4130):

```rust
    /// The re-list storm bound, end-to-end at the index level: a WAL move
    /// still re-runs the WHOLE listing (the pinned change-token contract
    /// above), but the per-session usage walk only executes for rows whose
    /// `time_updated` moved — unchanged rows are served from the
    /// provider's row-stamped cache. Observable on BOTH counters, never on
    /// the change generation alone (the observable-work rule,
    /// session_watcher_tests.rs:405-413).
    #[tokio::test]
    async fn opencode_wal_move_relists_without_rewalking_unchanged_sessions() {
        let data_home = opencode_data_home_with_sessions(
            "opencode-usage-cache",
            &[
                ("ses_a", "/repo/a", "Session A", 1000, 5000),
                ("ses_b", "/repo/b", "Session B", 1000, 5000),
            ],
        );
        set_opencode_session_model(&data_home, "ses_a", OPENCODE_TEST_MODEL);
        set_opencode_session_model(&data_home, "ses_b", OPENCODE_TEST_MODEL);
        // seed_opencode_step_finish uses fixed msg/part ids, so only ses_a
        // can go through it; ses_b is seeded through the lower-level
        // helpers with distinct ids (same real-schema shape).
        seed_opencode_step_finish(
            &data_home,
            "ses_a",
            r#"{"total":111,"input":1,"output":1,"reasoning":0,"cache":{"write":0,"read":109}}"#,
        );
        {
            let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
            ensure_opencode_message_tables(&conn);
            insert_opencode_message(&conn, "msg_b", "ses_b", 200, "assistant");
            insert_opencode_part(
                &conn,
                "prt_b",
                "msg_b",
                "ses_b",
                r#"{"reason":"stop","type":"step-finish","tokens":{"total":222,"input":2,"output":2,"reasoning":0,"cache":{"write":0,"read":218}},"cost":0}"#,
            );
        }

        let source = std::sync::Arc::new(CountingWrapper::new(OpencodeSource::new(
            data_home.clone(),
        )));
        let direct_list_calls = Arc::clone(&source.direct_list_calls);
        let index = test_index_with_ttl(vec![source.clone()], Duration::from_millis(10));

        // Cold snapshot: runs inline (truly cold has nothing stale to serve).
        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 2);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);
        assert_eq!(source.counting_inner().usage_walk_count(), 2);

        // Touch ONLY the wal (the storm driver). snapshot() is
        // stale-while-revalidate: it spawns a DETACHED sweep and returns
        // the stale view — settle on the observable counter before
        // asserting (finder F-01; the file-backed twin's discipline).
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past the 10ms test TTL, deterministically stale
        let snap2 = index.snapshot().await;
        assert_eq!(snap2.len(), 2);
        wait_until(Duration::from_secs(5), || {
            direct_list_calls.load(Ordering::SeqCst) >= 2
        })
        .await;
        assert_eq!(
            direct_list_calls.load(Ordering::SeqCst),
            2,
            "the WAL-move re-list still fires"
        );
        assert_eq!(
            source.counting_inner().usage_walk_count(),
            2,
            "unchanged session rows must not re-run the usage walk"
        );

        // One session's row changes: exactly that session re-walks.
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute(
            "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_a'",
            [],
        )
        .unwrap();
        drop(conn);
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, deterministically stale
        let _ = index.snapshot().await;
        wait_until(Duration::from_secs(5), || {
            direct_list_calls.load(Ordering::SeqCst) >= 3
        })
        .await;
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 3);
        assert_eq!(
            source.counting_inner().usage_walk_count(),
            3,
            "exactly the session whose row stamp moved re-walks"
        );

        std::fs::remove_dir_all(&data_home).ok();
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --lib -- opencode_wal_move_relists_without_rewalking_unchanged_sessions`

Expected: FAIL — compile error, `no method named counting_inner` (and `usage_walk_count`) — the observation seams that make the index-level walk work observable do not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

In `directory_index.rs`:

(1) `CountingWrapper` — add next to `new` (:2643-2652):

```rust
        /// Read-only access to the wrapped source — lets index-level tests
        /// reach source-specific observation seams (e.g.
        /// `OpencodeSource::usage_walk_count`) while the wrapper's own
        /// counters keep proving the re-list side.
        pub(crate) fn counting_inner(&self) -> &S {
            &self.inner
        }
```

(2) `OpencodeSource` — add next to `with_model_limit_resolver` (:713-716):

```rust
    /// Usage walks actually executed by the wrapped provider so far (cache
    /// misses) — the index-level observable-work pin for the row-stamped
    /// usage cache: a re-list that changed no session row must not move
    /// it (delegates to `OpencodeProvider::usage_walk_count`).
    pub fn usage_walk_count(&self) -> u64 {
        self.provider.usage_walk_count()
    }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions --locked --lib -- opencode_wal_move_relists_without_rewalking_unchanged_sessions`

Expected: PASS — the walk behavior comes from Task 1's cache; this task proves it holds through the full `SessionIndex` sweep path (detached sweeps and all) and pins it against regressions at the level where the storm manifests.

- [ ] **Step 5: Refactor while green**

No refactor expected — two accessors, each two lines, placed next to their siblings.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole directory-index module (the wrapper and source changed) and the watcher tests (they consume `wrapper_counters`):

```bash
cargo test -p freshell-sessions --locked --lib -- directory_index
cargo test -p freshell-sessions --locked --lib -- session_watcher_tests
```

Expected: PASS everywhere.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "test(sessions): pin WAL-move re-lists without usage re-walks at the index level"
```

---

### Task 4: Content-identical direct re-lists stop advancing the change generation

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (`refresh_snapshot` direct arm, :2028-2036)
- Test: same file, `mod tests`

**Interfaces:**
- Consumes: `DirectEntry { token, items }` (:1906-1913), the file-backed `content_moved` precedent (:2113-2137), `IndexedSession` equality (directory_index.rs:60 derive + :2125 precedent).
- Produces: no new API — internal `changed` accounting change only.

**Known second consumer (finder F-02, recorded):** `changed` feeds BOTH the publish decision (:1772-1774) AND `take_pending_save_from_parts` (:1779-1785, the persistent-parse-cache save gate). Suppressing byte-identical re-lists also stops them from accumulating save pressure — benign-to-beneficial (`DirectEntry` is in-memory only; today's WAL storm accumulated phantom saves of an unchanged file-backed cache). Echo this reconciliation in the task result.

- [ ] **Step 1: Write the failing behavioral test**

In `directory_index.rs` `mod tests`, next to the Task 3 test:

```rust
    /// Direct-arm twin of the file-backed content-identical rule
    /// (`content_identical_rewrite_reparses_without_bumping_generation`):
    /// a WAL-move re-list whose items are byte-identical to the cached
    /// listing (a WAL append that changed no listed row — a child-session
    /// write invisible to the root listing, a checkpoint, a vacuum) must
    /// NOT advance the change generation, because a phantom generation
    /// advance fans a spurious `sessions.changed` refetch to every client
    /// (the same rationale as the file-backed `content_moved` comment). A
    /// real row change still advances it.
    #[tokio::test]
    async fn opencode_content_identical_relist_does_not_bump_generation() {
        let data_home = opencode_data_home_with_sessions(
            "opencode-content-identical",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        let source = CountingWrapper::new(OpencodeSource::new(data_home.clone()));
        let direct_list_calls = Arc::clone(&source.direct_list_calls);
        let index = test_index_with_ttl(vec![Arc::new(source)], Duration::from_millis(10));
        let mut rx = index.subscribe_changes();

        // Cold snapshot: inline sweep, publishes the first generation.
        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);
        rx.borrow_and_update(); // mark the first publish as seen

        // WAL move with NO listed-row change: the re-list runs (pinned
        // contract, observed via the counter after settling) and
        // publishes byte-identical items — the generation must hold.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, deterministically stale
        let _ = index.snapshot().await; // stale-while-revalidate: detaches the sweep
        wait_until(Duration::from_secs(5), || {
            direct_list_calls.load(Ordering::SeqCst) >= 2
        })
        .await;
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 2);
        assert!(
            !rx.has_changed().unwrap(),
            "a byte-identical direct re-list must not advance the change generation"
        );

        // A real row change still advances the generation.
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute(
            "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_a'",
            [],
        )
        .unwrap();
        drop(conn);
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, deterministically stale
        let _ = index.snapshot().await; // detaches the sweep again
        wait_until(Duration::from_secs(5), || {
            direct_list_calls.load(Ordering::SeqCst) >= 3
        })
        .await;
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 3);
        assert!(
            rx.has_changed().unwrap(),
            "a content-moving re-list must advance the change generation"
        );

        std::fs::remove_dir_all(&data_home).ok();
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --lib -- opencode_content_identical_relist_does_not_bump_generation`

Expected: FAIL at the first `assert!` — the settled byte-identical WAL-move re-list DOES advance the generation today (the direct arm counts every successful re-list as `changed`, :2034), so `!rx.has_changed()` fails. This is the behavioral red, observable only after the counter settles (finder F-01) — a bare snapshot-and-assert would be vacuously green here.

- [ ] **Step 3: Add the minimal production implementation**

In `refresh_snapshot`'s direct arm, replace the `Ok(items)` branch (:2028-2036). Current code:

```rust
            } else {
                match source.direct_list() {
                    Ok(items) => {
                        if let Some(name) = source.provider_name() {
                            scan_failures.remove(name);
                        }
                        direct_cache.insert(idx, DirectEntry { token, items });
                        changed += 1;
                    }
                    Err(err) => { /* existing scan-failure recording body, unchanged */ }
                }
                // Direct-listed sources never touch the per-file cache/discovery.
                continue;
            }
```

becomes (only the `Ok(items)` arm changes; keep the existing `Err` body verbatim):

```rust
            } else {
                match source.direct_list() {
                    Ok(items) => {
                        if let Some(name) = source.provider_name() {
                            scan_failures.remove(name);
                        }
                        // Direct-arm twin of the file-backed content-identical
                        // rule (the parse loop's `content_moved` below): a
                        // re-list whose items are byte-identical to the cached
                        // listing (a WAL append that changed no listed row)
                        // publishes exactly the cached view — count ONLY a
                        // re-list whose published view actually differs as a
                        // change, so a phantom generation advance cannot fan a
                        // spurious `sessions.changed` refetch to every client.
                        // The token bookkeeping is refreshed either way so the
                        // NEXT sweep treats the listing as unchanged. Second
                        // consumer recorded (finder F-02):
                        // take_pending_save_from_parts also stops receiving
                        // phantom save pressure — benign (DirectEntry is
                        // in-memory only; saves stay driven by real changes).
                        let content_moved = direct_cache
                            .get(&idx)
                            .is_none_or(|entry| entry.items != items);
                        direct_cache.insert(idx, DirectEntry { token, items });
                        if content_moved {
                            changed += 1;
                        }
                    }
                    Err(err) => { /* existing scan-failure recording body, unchanged */ }
                }
                // Direct-listed sources never touch the per-file cache/discovery.
                continue;
            }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions --locked --lib -- opencode_content_identical_relist_does_not_bump_generation`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor expected — the change mirrors the file-backed rule verbatim.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole directory-index module (generation semantics), the watcher tests, and every server consumer of re-list publishes — the F2-nudge chain (its re-list applies NEW limits to unchanged usage, so its items DIFFER and the generation still advances), the session-directory wire tests, the auto-title sweep, the existence probes, and the sessions-sweep signature tests:

```bash
cargo test -p freshell-sessions --locked --lib -- directory_index
cargo test -p freshell-sessions --locked --lib -- session_watcher_tests
cargo test -p freshell-server --locked -- opencode_limits session_directory:: existence auto_title_sweep sessions_sweep
```

Expected: PASS everywhere. If any health-channel test (e.g. `a_failing_direct_list_records_a_scan_failure_and_recovery_clears_it`) pins a generation bump for a content-identical recovery, reconcile it deliberately per the file-backed precedent (`content_identical_rewrite_reparses_without_bumping_generation` is the crate's own statement of the rule) — record the reconciliation in the task result; never weaken the new content-identical contract to make an old assertion pass without that recorded reasoning.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "feat(sessions): direct-arm content-identical re-lists no longer bump the change generation"
```

---

## Final verification (after Task 4, before the delta review)

1. Style gates: `cargo fmt --all --check` and `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` — both must pass (fix findings in place; these are the repo's pre-push gates).
2. Coordinated full suite at final HEAD through the shared coordinator gate (repo lane, e.g. `npm test` from the worktree — never a raw broad cargo run mid-task; the baseline at base_ref `a6c0848ef589061d633f1f1d4cf43756a01c9e11` was green, so any failure is attributable to this branch).
3. Affected e2e specs on the configured backend (`FRESHELL_E2E_BACKEND=cloud`): `npm run test:e2e -- test/e2e-browser/specs/session-directory-matrix.spec.ts test/e2e-browser/specs/sidebar-opencode-rail.spec.ts test/e2e-browser/specs/freshopencode-tui-parity.spec.ts test/e2e-browser/specs/freshopencode-model-picker.spec.ts` — the session-directory listing surfaces this change touches end-to-end. (Note: `freshopencode-db-history.spec.ts` is cloud-skipped (`CLOUD_SKIP_SPECS`) and is NOT cloud coverage; it runs locally only if the harness is being changed, which this plan does not do.)
4. Design-budget note for the record: the measured post-fix per-re-list residual is ≈4 ms listing (validator A2) + ≈45-90 ms unnamed-subset first-message lookups (validator A) + per-changed-session walks/probes — ≈2.5-5% of a core at the 0.5-1 re-list/s debounce cadence, which meets the idle steady-state budget without cadence coarsening. The production observable remains the host-stats FRESHELL tile (scheduler-drift p99 ≤ 50 ms) post-deploy — a separate, user-approved step outside this run.

## Coverage summary

- Unit/integration (Rust): 6 new parse-layer usage-cache tests (tests/opencode_usage.rs), 4 new parse-layer marker-cache tests (tests/opencode_sqlite.rs), 2 new index-level tests (directory_index.rs mod tests) — walk-skip, exact-rewalk, documented staleness bounds, NULL-stamp, None-caching, degraded-schema marker behavior, prune, WAL-move-relist-without-rewalk, generation suppression — plus the untouched pins: the change-token gating contract, the F2-nudge chain, the meter wire trio, by-id existence arms, and the auto-title ladder.
- E2E: no new spec — the client chain is untouched and provider-agnostic (the context-meter plan's own coverage rationale, docs/plans/2026-09-14-freshopencode-context-meter.md coverage summary); the affected existing specs run on the cloud lane per Final verification step 3.
- Production observability (post-deploy, outside this run): the server's own `usage_walk_count`/`marker_probe_count` are diagnostic hooks; the host-stats FRESHELL tile (scheduler-drift p99 ≤ 50ms) is the success criterion the user watches.
