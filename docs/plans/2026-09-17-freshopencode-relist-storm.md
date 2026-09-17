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

**Architecture:** Three changes, all inside `crates/freshell-sessions`. (1) `OpencodeProvider` (the parse layer) gains a row-stamped usage cache: the full listing still re-runs on every dirty-mark/WAL-move re-list (that trigger contract is pinned and untouched), but the per-session usage walk `last_step_finish_usage_for_session` executes only for rows whose raw `time_updated` stamp moved; a locator-style atomic counter (`usage_walk_count`, mirroring `OpencodeLocator::db_scan_count`) makes the walk observable so tests can prove unchanged rows skip it. (2) An index-level integration test pins the end-to-end statement through a real `SessionIndex` — a WAL move re-lists without re-walking; a row-stamp bump re-walks exactly that session — via a tiny read-only seam on `CountingWrapper` plus a delegating accessor on `OpencodeSource`. (3) The direct arm of `SessionIndex::refresh_snapshot` stops counting byte-identical re-lists as changes, mirroring the file-backed arm's `content_moved` rule, so a WAL move that changed no listed row no longer advances the change generation and no longer broadcasts `sessions.changed` to every client.

**Tech Stack:** Rust workspace (rusqlite read-only queries, std sync primitives — `Mutex`/`AtomicU64`, tokio async test harness), Cargo unit + integration tests. No client/TypeScript changes; no wire-schema changes.

## Global Constraints

- TDD red/green/refactor for every change; never skip tests; keep the refactor step. Narrowed cargo selectors only (delegated, no coordinator gate mid-task); the run's final full-suite verification goes through the coordinated gate at the end, never raw mid-task.
- The real opencode DB (`~/.local/share/opencode/opencode.db`, multi-GB) is READ-ONLY in every production code path (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_READ_URI`); tests use writable fixture DBs in temp dirs, never the real DB. Stage-2 live validation queries (EXPLAIN/statistical) are read-only, with receipts recorded under the run's logs directory.
- The re-list TRIGGER contract is unchanged: `opencode_change_token_gating_unchanged_no_requery_wal_touch_requeries` (crates/freshell-sessions/src/directory_index.rs:4130-4167) must pass unmodified — this fix bounds the INSIDE of `direct_list`, not its frequency.
- Cache the RAW `OpencodeStepUsage` keyed by the row's raw `time_updated` stamp — never the resolved `TokenSummary`. The opencode_limits F2 nudge (`crates/freshell-server/src/opencode_limits.rs:202-211`) re-lists precisely to apply NEW model limits to UNCHANGED usage; `refresh_once_fills_the_snapshot_relists_and_lights_the_meter` (opencode_limits.rs:534) must stay green.
- The wire contract is untouched: `TokenSummary` emission semantics stay byte-identical (zod `.positive()` bounds, hard `.parse` at src/lib/api.ts:646/:681). A cached value must be exactly what a fresh walk would emit for the same row.
- The usage cache is in-memory only and lives for the provider's process lifetime (one instance inside `OpencodeSource`, held by the `SessionIndex`): `rust-session-cache.json` and `CACHE_SCHEMA_VERSION` are untouched — no persistence-format change.
- A NULL `time_updated` row is never cache-validated (always re-walked) — it cannot be stamp-checked, matching pre-cache behavior.
- Degrade discipline (the `FIRST_USER_MESSAGE_SQL` precedent, docs/plans/2026-09-14-freshopencode-context-meter.md Global Constraints line 36): any cache/lock/query error path degrades to re-walk or `None`, never breaks the listing. Lock poisoning recovers via `unwrap_or_else(|poisoned| poisoned.into_inner())`.
- Negative/observability rule (session_watcher_tests.rs:405-413): assert on counters (observable work), never only on `subscribe_changes()`.
- Rust style gates before push: `cargo fmt --all --check`; `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`.
- Library crates emit `tracing` only (warn! on degrade paths, debug! for chatty paths); no subscriber install in freshell-sessions.
- No PR creation without explicit user approval. No production-server (port 3001) restart; deploying is outside this run. Commits use the repo-configured identity (Dan Shapiro <3732858+danshapiro@users.noreply.github.com>) — never `dan@danshapiro.com` as author.
- No user-facing UI or behavior change: no README, docs/index.html, or client changes.

### Load-bearing assumptions (validated in Stage 2 before execution; receipts recorded in the run's logs directory)

1. **opencode maintains `session.time_updated` on message/part writes** — the cache's staleness bound. Validation: read-only statistical check on the live DB (sampled recent sessions satisfy `time_updated >= max(message.time_created)` of the session), plus opencode's session-row write path if the installed version's source is inspectable. If false, the plan needs a redesign (stamp-independent freshness belt).
2. **The 3-views marker `EXISTS` subqueries (parse/opencode.rs:547-563) do not degrade to a per-session `part`-table scan on the live DB.** Validation: read-only `EXPLAIN QUERY PLAN` of the listing SQL on the live DB. If they do degrade, this plan gains an amendment task (hoist marker detection to one scan per re-list) — a planning-level change executed through plan amendment, not silently.
3. `IndexedSession`/`TokenSummary` already support equality (the file-backed `content_moved` comparison at directory_index.rs:2123-2125 compares `entry.item != item`, so `PartialEq` exists) — Task 3's comparison needs no new derives.
4. `SessionIndex::snapshot()` awaits the refresh it triggers (the gating test's counter assertions at :4139-4164 depend on it), so Task 3's generation observations are synchronous; use the `wait_until` helper (:2521-2532) if a leg ever proves flaky rather than sleeping longer.

### Non-goals (recorded, not silent deferrals)

- Caching `first_user_message` lookups: already bounded to the unnamed-session subset ("listing cost scales with the small unnamed subset", parse/opencode.rs:738-742); not the amplification this run is chartered to fix. OPTIONAL improvement, not required.
- Coarsened/rate-limited opencode dirty-marking (the adopted direction's optional complement): rejected for this run — with the row-stamped cache, each re-list costs O(changed sessions), so coarsening would only buy wall-clock staleness on listed-row freshness. Revisit only if post-deploy observation shows residual listing cost starving the runtime.
- No changes to the watcher, debouncer, change-token logic, host-stats collection, or any client code.

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
    // on message writes — the fixture here deliberately does NOT).
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
        "a legitimate no-usage None (no step-finish / capped miss) is cached like any result"
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
/// that found no step-finish, or a bounded/capped miss — the stamp, not
/// the value, decides freshness (freshopencode re-list storm fix:
/// docs/plans/2026-09-17-freshopencode-relist-storm.md).
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

(5) Prune the cache to the listed id-set immediately before the successful return (:777) — build the id set first so the prune stays O(n), not O(n²):

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

### Task 2: Index-level proof — WAL moves re-list without re-walking unchanged sessions

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (`CountingWrapper` at :2631-2652, `OpencodeSource` at :698-725; tests in the same file's `mod tests`, modeled on :4130-4167)

**Interfaces:**
- Consumes: `OpencodeProvider::usage_walk_count()` (Task 1), existing `CountingWrapper` counters, existing fixture helpers `opencode_data_home_with_sessions` (:3887-3913), `set_opencode_session_model` (:4012-4019), `seed_opencode_step_finish` (:3998-4009, fixed ids `msg_usage`/`prt_usage` — one session per call), `ensure_opencode_message_tables`/`insert_opencode_message`/`insert_opencode_part` (:3921-3974), `OPENCODE_TEST_MODEL` (:4212-4213), `test_index_with_ttl` (:2560).
- Produces: `CountingWrapper::counting_inner(&self) -> &S` (pub(crate)); `OpencodeSource::usage_walk_count(&self) -> u64` (pub).

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

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 2);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);
        assert_eq!(source.counting_inner().usage_walk_count(), 2);

        // Touch ONLY the wal (the storm driver): the listing re-runs (the
        // pinned contract) but NO session row moved — no walk re-runs.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        let snap2 = index.snapshot().await;
        assert_eq!(snap2.len(), 2);
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
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        let snap3 = index.snapshot().await;
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

Expected: PASS — the walk behavior itself comes from Task 1's cache; this task proves it holds through the full `SessionIndex` sweep path and pins it against regressions at the level where the storm manifests.

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

### Task 3: Content-identical direct re-lists stop advancing the change generation

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (`refresh_snapshot` direct arm, :2028-2036)
- Test: same file, `mod tests`

**Interfaces:**
- Consumes: `DirectEntry { token, items }` (:1906-1913), the file-backed `content_moved` precedent (:2113-2137), `IndexedSession` equality (implied by the file-backed comparison at :2125).
- Produces: no new API — internal `changed` accounting change only.

- [ ] **Step 1: Write the failing behavioral test**

In `directory_index.rs` `mod tests`, next to the Task 2 test:

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

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);
        rx.borrow_and_update(); // mark the first publish as seen

        // WAL move with NO listed-row change: the re-list runs (pinned
        // contract) and publishes byte-identical items — the generation
        // must hold.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL
        let _ = index.snapshot().await;
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
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL
        let _ = index.snapshot().await;
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

Expected: FAIL — the first `assert!` fails: today's direct arm counts EVERY successful re-list as `changed` (directory_index.rs:2034), so the byte-identical WAL-move re-list advances the generation. This is the behavioral red (not a compile error).

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
                    Err(err) => { /* scan-failure recording, cache preserved — unchanged */ }
                }
                // Direct-listed sources never touch the per-file cache/discovery.
                continue;
            }
```

becomes:

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
                        // NEXT sweep treats the listing as unchanged.
                        let content_moved = direct_cache
                            .get(&idx)
                            .is_none_or(|entry| entry.items != items);
                        direct_cache.insert(idx, DirectEntry { token, items });
                        if content_moved {
                            changed += 1;
                        }
                    }
                    Err(err) => { /* scan-failure recording, cache preserved — unchanged */ }
                }
                // Direct-listed sources never touch the per-file cache/discovery.
                continue;
            }
```

Also grep every other use of `changed` inside `refresh_snapshot`/`perform_refresh_once` and confirm the only consumer is the publish decision at :1772-1774 (`if changed > 0 { change_tx ... }`) — record that check in the task result; any other consumer must be reconciled deliberately, not silently.

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

## Final verification (after Task 3, before the delta review)

1. Style gates: `cargo fmt --all --check` and `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` — both must pass (fix findings in place; these are the repo's pre-push gates).
2. Coordinated full suite at final HEAD through the shared coordinator gate (repo lane, e.g. `npm test` from the worktree — never a raw broad cargo run mid-task; the baseline at base_ref `a6c0848ef589061d633f1f1d4cf43756a01c9e11` was green, so any failure is attributable to this branch).
3. Affected e2e specs on the configured backend (`FRESHELL_E2E_BACKEND=cloud`): `npm run test:e2e -- test/e2e-browser/specs/session-directory-matrix.spec.ts test/e2e-browser/specs/sidebar-opencode-rail.spec.ts test/e2e-browser/specs/freshopencode-tui-parity.spec.ts test/e2e-browser/specs/freshopencode-model-picker.spec.ts` — the session-directory listing surfaces this change touches end-to-end. (Note: `freshopencode-db-history.spec.ts` is cloud-skipped (`CLOUD_SKIP_SPECS`) and is NOT cloud coverage; it runs locally only if the harness is being changed, which this plan does not do.)

## Coverage summary

- Unit/integration (Rust): 6 new parse-layer cache tests (tests/opencode_usage.rs), 2 new index-level tests (directory_index.rs mod tests) — walk-skip, exact-rewalk, documented staleness bound, NULL-stamp, None-caching, prune, WAL-move-relist-without-rewalk, generation suppression — plus the untouched pins: the change-token gating contract, the F2-nudge chain, the meter wire trio, by-id existence arms, and the auto-title ladder.
- E2E: no new spec — the client chain is untouched and provider-agnostic (the context-meter plan's own coverage rationale, docs/plans/2026-09-14-freshopencode-context-meter.md coverage summary); the affected existing specs run on the cloud lane per Final verification step 3.
- Production observability (post-deploy, outside this run): the server's own `usage_walk_count` is available for diagnostics; the host-stats FRESHELL tile (scheduler-drift p99 ≤ 50ms) is the success criterion the user watches.
