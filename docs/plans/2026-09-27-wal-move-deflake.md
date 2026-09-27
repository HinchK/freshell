# Sessions WAL-Move CI De-Flake Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
The two freshell-sessions directory_index WAL-move tests landed by PR #819 (opencode_wal_move_relists_without_rewalking_unchanged_sessions and opencode_content_identical_relist_does_not_bump_generation) must stop failing intermittently on the GitHub-runner Rust lane: fix the root cause so the pinned contracts hold deterministically on every supported machine (the Rust PR required-check lane stops coin-flipping red).

### Explicit constraints
- Fix the root cause honestly; never weaken, skip, or loosen the pinned contract assertions (WAL-only move re-lists; unchanged rows don't re-walk; generation holds on byte-identical republish).
- Red-green-refactor: the failure mechanism must be reproduced deterministically locally first (it is currently CI-only: green 3/3 on 96 cores, 10/10 pinned to 2 cores, 1 green + 2 red on GitHub runners).
- Scope is the sessions WAL-move flake. The freshagent handoff test's one-off local flake and the arm E stuck-card cloud flake are separate findings, not in this run's scope (arm E is ledger-recorded as this run's baseline exclusion).
- the-usual workflow: worktree branch the-usual/wal-move-deflake from base d6643304361f5ac4dea2310f2579eb1bc9f485f3; PR only after explicit user approval.

### Accepted tradeoffs and residuals
- Token dimensions beyond nanosecond mtime + size stay out of scope: these two cover the observed failure bands (millisecond truncation and coarse kernel clock assignment — size is assignment-clock-immune, and any real WAL append or creation changes a size). Finer content hashing is unnecessary machinery for this defect class.
- CI-level final proof (green rust-gate on the PR) happens at landing time; the run's local certification substitutes repeated runs including a 2-core-pinned stress.
- The main checkout's local-environment noise (arm E red there, green in clean worktrees) is out of scope; flagged to the user separately.

**Goal:** The two WAL-move tests pass deterministically everywhere because the production change token actually sees same-millisecond and same-tick WAL writes — through nanosecond mtime AND size dimensions — with deterministic regression tests proving both forever.

**Architecture:** The root cause is in production code, not the tests: `OpencodeSource::direct_change_token` (crates/freshell-sessions/src/directory_index.rs:775-785) is `max(db_mtime, wal_mtime)` where both mtimes are **millisecond-truncated** (`file_mtime_ms`, directory_index.rs:917). A WAL append that lands in the same wall-clock millisecond as the cached token makes the token compare equal, so `refresh_snapshot`'s unchanged gate (directory_index.rs:2044-2050) skips the re-list forever — exactly the CI failure ("the WAL-move re-list must fire and settle" with the counter stuck at 1; not starvation: no amount of waiting helps). The collision (vs. budget starvation) is confirmed by the failing CI runs' own logs — each failed ONLY the two wal tests while every 2s-budget settle sibling passed (receipts: reports/load-bearing-finder.md, F-01). A second, deeper granularity defect compounds it (plan-review round 2, F-05): Linux assigns inode mtimes from a coarse clock refreshed once per scheduling tick, and multigrain timestamps only promote a previously-queried inode — a freshly created WAL is never promoted — so a same-tick WAL creation can carry an IDENTICAL nanosecond mtime to the db's cached token. Merely widening the token to nanoseconds therefore leaves the real-world hazard open. The fix is a **two-dimensional token**, `DirectToken { mtime_ns: i64, size: u64 }`: nanosecond mtime (closes the ms-truncation band) plus the sum of both files' sizes (clock-immune: any real WAL append or creation changes a size). Two deterministic regression tests pin both dimensions — a sub-millisecond mtime move (pinned to known offsets inside one ms window) and a same-mtime WAL growth (only the size dimension can see it). The amplifier's ms helper is display parity and stays; the #819 tests need NO edits at all. One task delivers the deterministic RED reproduction plus the GREEN production fix plus certification.

**Tech Stack:** Rust (edition 2021, MSRV 1.96 — `std::fs::FileTimes`/`File::set_times` stable since 1.75), tokio (`#[tokio::test]` current-thread runtimes), rusqlite fixtures, pnpm-era repo test lanes.

## Global Constraints

- pnpm 10.34.5 exactly; frozen installs only; never `npm ci`/`npm install` in this tree. Focused vitest via `pnpm run test:vitest run <path> --config <config>`; cargo takes ONE positional test filter per invocation.
- Broad coordinated gates behind the shared coordinator (`pnpm run test:status` to inspect; queue behind foreign holders; never kill them); broad runs set `FRESHELL_TEST_SUMMARY`; cloud vitest via `FRESHELL_VITEST_BACKEND=cloud`; agent-launched broad gates export `GCLOUD_ROBOT_REQUIRE=1` and `GCLOUD_ROBOT_HOME=/home/dan/code/skill-gcloud-robot/gcloud-robot`.
- TDD red/green/refactor; never weaken, skip, or loosen the pinned assertions in the two #819 tests — this plan does not edit them at all.
- This run's gate treats exactly one failure as the ledger-recorded pre-existing exclusion: `TerminalView.stuckCard.test.tsx > restart (arm E)` in the cloud lane (receipts in run-state.md's baseline ledger). Any other failure in this run's gates is attributable to this run and must be fixed.
- All work on branch `the-usual/wal-move-deflake` in `/home/dan/code/freshell/.worktrees/wal-move-deflake`; base_ref `d6643304361f5ac4dea2310f2579eb1bc9f485f3`; never touch the production server on port 3001; no PR creation without explicit user approval.
- Commits use the repo's configured git identity (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`); conventional commit messages.
- No docs changes: the fix is internal precision, no user-facing behavior; README and docs/index.html untouched.
- Evidence inputs: `reports/plan-flake-mechanism.md` (root cause, exclusions with line evidence), `reports/plan-determinism-patterns.md` (settle idioms, blast radius), and `reports/load-bearing-finder.md` (F-01..F-05) under the run's logs_dir.

---

### Task 1: Two-dimensional opencode change token (mtime_ns + size) + deterministic regression pins

**Files:**
- Create: nothing
- Modify: `crates/freshell-sessions/src/directory_index.rs` (pub `DirectToken` struct declared near the `SessionSource` trait ~:150; trait method signature at :195; new `stat_token_parts` helper next to `file_mtime_ms` at :917; `OpencodeSource::direct_change_token` at :775-785; `DirectEntry.token` type at :1958-1961; test fake's constant token at :5531; tests module: two new regression tests inserted between `opencode_wal_move_relists_without_rewalking_unchanged_sessions` and `opencode_content_identical_relist_does_not_bump_generation`)
- Modify: `crates/freshell-server/src/resolve.rs:961` and `:1014` (BOTH test fakes' constant/changing tokens adapt to the new type — compile-only)

**Interfaces:**
- Consumes: `SessionSource` trait (:150-215); `CountingWrapper` test fixture (:2694-2760, `direct_list_calls: Arc<AtomicUsize>` — delegates the token, signature-only impact); `test_index_with_ttl(Vec<Arc<dyn SessionSource>>, Duration)` (:2628); `opencode_data_home_with_sessions`, `set_opencode_session_model`, `OPENCODE_TEST_MODEL` (existing test helpers); `wait_until(Duration, impl FnMut() -> bool) -> bool` (:2589).
- Produces: `pub struct DirectToken { pub mtime_ns: i64, pub size: u64 }` (`#[derive(Clone, Copy, PartialEq, Eq, Debug)]`, exported via the public `directory_index` module — freshell-server's test fake constructs it); `fn stat_token_parts(path: &Path) -> Option<(i64, u64)>` (private helper: ns mtime + size in one stat); the trait signature becomes `fn direct_change_token(&self) -> Option<DirectToken>`; `DirectEntry.token` becomes `DirectToken` (in-memory only; `PersistState` :1080 persists no tokens, so no migration concern).

- [ ] **Step 1: Write the failing behavioral tests**

Add BOTH tests to the tests module in `crates/freshell-sessions/src/directory_index.rs`, inserted together between `opencode_wal_move_relists_without_rewalking_unchanged_sessions` and `opencode_content_identical_relist_does_not_bump_generation`:

**Test 1 — the sub-millisecond mtime dimension (the 2026-09-27 CI flake):**

```rust
    /// The same-millisecond regression pin (the 2026-09-27 CI flake): a WAL
    /// append that lands inside the SAME wall-clock millisecond as the
    /// cached change token is a real write (fast sqlite commits do this on
    /// fast hardware — the GitHub-runner reds), and the re-list must still
    /// fire. Reproduced deterministically by pinning both files' mtimes to
    /// KNOWN offsets inside one ms window, so no ms boundary can intervene:
    /// db at +100µs, wal (written after the cold sweep) at +600µs. A
    /// millisecond-truncated token floors both to the same ms and misses
    /// the move; the nanosecond mtime dimension sees the +500µs.
    #[tokio::test]
    async fn opencode_wal_move_within_the_same_millisecond_still_relists() {
        let data_home = opencode_data_home_with_sessions(
            "opencode-same-ms-wal",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        set_opencode_session_model(&data_home, "ses_a", OPENCODE_TEST_MODEL);
        // A seed-time WAL (if the fixture ever leaves one) must not own the
        // cached token — remove it so the cold sweep caches the DB's stat.
        let _ = std::fs::remove_file(data_home.join("opencode.db-wal"));

        // Pin the db's mtime to a KNOWN offset inside its ms window.
        let db = data_home.join("opencode.db");
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as i64;
        let window_base_ns = (now_ns / 1_000_000) * 1_000_000;
        let db_t = std::time::UNIX_EPOCH + Duration::from_nanos((window_base_ns + 100_000) as u64);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&db)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(db_t))
            .unwrap();
        // Readback canary: a filesystem that cannot hold the pinned
        // precision self-identifies HERE with a clear message, instead of
        // producing a misleading token failure later.
        assert_eq!(
            std::fs::metadata(&db).unwrap().modified().unwrap(),
            db_t,
            "the filesystem must hold sub-millisecond mtime precision for this pin"
        );

        let source =
            std::sync::Arc::new(CountingWrapper::new(OpencodeSource::new(data_home.clone())));
        let direct_list_calls = Arc::clone(&source.direct_list_calls);
        let index = test_index_with_ttl(vec![source.clone()], Duration::from_millis(10));

        // Cold snapshot: inline sweep caches the token from the db's pinned stat.
        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);

        // The WAL move: a real write, whose mtime lands +500µs after the
        // db's — inside the same millisecond window.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        let wal_t = std::time::UNIX_EPOCH + Duration::from_nanos((window_base_ns + 600_000) as u64);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&wal)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(wal_t))
            .unwrap();
        assert_eq!(
            std::fs::metadata(&wal).unwrap().modified().unwrap(),
            wal_t,
            "the filesystem must hold sub-millisecond mtime precision for this pin"
        );

        tokio::time::sleep(Duration::from_millis(30)).await; // past the 10ms test TTL, deterministically stale
        let _ = index.snapshot().await; // stale-while-revalidate detaches the re-list
        assert!(
            wait_until(Duration::from_secs(5), || {
                direct_list_calls.load(Ordering::SeqCst) >= 2
            })
            .await,
            "a sub-millisecond WAL move must still trigger the re-list"
        );

        std::fs::remove_dir_all(&data_home).ok();
    }
```

**Test 2 — the size dimension (plan-review round 2, F-05): a WAL growth whose mtime is EXACTLY the cached max — only the size dimension can see it:**

```rust
    /// The coarse-clock regression pin (plan-review round 2): the kernel
    /// assigns inode mtimes from a clock refreshed once per scheduling
    /// tick, and multigrain promotion only applies to a previously-queried
    /// inode — a freshly created WAL is never promoted — so a same-tick
    /// WAL creation can carry an IDENTICAL nanosecond mtime to the db's
    /// cached token. A mtime-only token (ms OR ns) then reports the source
    /// unchanged forever. Pin that world deterministically: the wal's
    /// mtime is set EXACTLY equal to the db's (the cached max), and only
    /// its SIZE differs — the re-list must still fire.
    #[tokio::test]
    async fn opencode_wal_growth_with_an_unchanged_max_mtime_still_relists() {
        let data_home = opencode_data_home_with_sessions(
            "opencode-same-ns-wal",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        set_opencode_session_model(&data_home, "ses_a", OPENCODE_TEST_MODEL);
        let _ = std::fs::remove_file(data_home.join("opencode.db-wal"));

        let db = data_home.join("opencode.db");
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as i64;
        let window_base_ns = (now_ns / 1_000_000) * 1_000_000;
        let db_t = std::time::UNIX_EPOCH + Duration::from_nanos((window_base_ns + 100_000) as u64);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&db)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(db_t))
            .unwrap();
        assert_eq!(
            std::fs::metadata(&db).unwrap().modified().unwrap(),
            db_t,
            "the filesystem must hold sub-millisecond mtime precision for this pin"
        );

        let source =
            std::sync::Arc::new(CountingWrapper::new(OpencodeSource::new(data_home.clone())));
        let direct_list_calls = Arc::clone(&source.direct_list_calls);
        let index = test_index_with_ttl(vec![source.clone()], Duration::from_millis(10));

        let snap = index.snapshot().await; // cold: token = (db_t ns, db size)
        assert_eq!(snap.len(), 1);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);

        // The same-tick WAL creation: mtime pinned EXACTLY equal to the
        // cached max; the size dimension is the only witness.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&wal)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(db_t))
            .unwrap();
        assert_eq!(
            std::fs::metadata(&wal).unwrap().modified().unwrap(),
            db_t,
            "the filesystem must hold the pinned mtime exactly for this pin"
        );

        tokio::time::sleep(Duration::from_millis(30)).await; // past the 10ms test TTL, deterministically stale
        let _ = index.snapshot().await; // stale-while-revalidate detaches the re-list
        assert!(
            wait_until(Duration::from_secs(5), || {
                direct_list_calls.load(Ordering::SeqCst) >= 2
            })
            .await,
            "a WAL growth with an unchanged max mtime must still trigger the re-list"
        );

        std::fs::remove_dir_all(&data_home).ok();
    }
```

- [ ] **Step 2: Run the tests and verify the intended failures (witness the mechanism)**

Order of operations for a faithful red: implement Step 3's TYPE change first but keep the token's mtime dimension at the CURRENT ms-truncated behavior (compute `mtime_ns` as `file_mtime_ms(path).unwrap_or(0) * 1_000_000` and `size` as a hard-coded `0`) — the status-quo detection dressed in the new type — so the tree compiles and BOTH tests run against exactly today's production behavior:

1. `cargo test -p freshell-sessions --lib opencode_wal_move_within_the_same_millisecond_still_relists` — Expected: FAIL after ~5s with `a sub-millisecond WAL move must still trigger the re-list`.
2. `cargo test -p freshell-sessions --lib opencode_wal_growth_with_an_unchanged_max_mtime_still_relists` — Expected: FAIL after ~5s with `a WAL growth with an unchanged max mtime must still trigger the re-list`.

Both reds are the intended missing behavior, not setup accidents: the unchanged gate compares the cached and fresh tokens equal (test 1: mtime-only floors/pins inside one ms window; test 2: mtimes pinned EXACTLY equal), `direct_list` never runs, and the counter stays 1 for the full 5s settle budget — the exact CI signature. If a test instead fails fast with a stat/set_times error or a `snap.len()`/readback assertion, STOP: that is a fixture/OS accident, not the intended red.

Witness both reds before proceeding (the reds alone cannot distinguish unchanged-gate suppression from a detached sweep that never ran — F-04): temporarily add `eprintln!("witness db_ms={:?} wal_ms={:?} db_ns={:?} wal_ns={:?}", file_mtime_ms(&db), file_mtime_ms(&wal), std::fs::metadata(&db).unwrap().modified(), std::fs::metadata(&wal).unwrap().modified());` as the first line inside the `wait_until` closure of each test, rerun, and confirm: test 1's two ms values are EQUAL while the ns values differ by exactly 500_000 — the collision, witnessed; test 2's mtimes are equal at FULL nanosecond precision — the coarse-clock world, witnessed. Remove both `eprintln!` lines before continuing (they must not be committed).

- [ ] **Step 3: Add the full production implementation**

3a. In `crates/freshell-sessions/src/directory_index.rs`, immediately before the `SessionSource` trait definition (~:150), add:

```rust
/// The change token a direct-listed source's cheap per-sweep check yields:
/// nanosecond mtime plus size. BOTH dimensions are load-bearing —
///
/// * `mtime_ns`: a millisecond-truncated mtime could not see a WAL append
///   that landed in the same wall-clock millisecond as the cached token
///   (the 2026-09-27 CI flake), deferring the re-list a full TTL window.
///   `i64` ns-since-epoch holds until year 2262.
/// * `size`: the kernel assigns inode mtimes from a coarse clock
///   refreshed once per scheduling tick, and multigrain promotion only
///   applies to a previously-queried inode — a freshly created WAL is
///   never promoted — so a same-tick WAL creation can carry an IDENTICAL
///   nanosecond mtime to the db's cached token. Size is assignment-clock
///   immune: any real WAL append or creation changes a size.
///
/// Pinned by the two same-tick regression tests
/// (`opencode_wal_move_within_the_same_millisecond_still_relists`,
/// `opencode_wal_growth_with_an_unchanged_max_mtime_still_relists`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DirectToken {
    pub mtime_ns: i64,
    pub size: u64,
}
```

3b. Change the trait method (at :195) to return the new type and update its doc:

```rust
    fn direct_change_token(&self) -> Option<DirectToken> {
        None
    }
```

3c. Next to `file_mtime_ms` (:917), add the token's stat helper:

```rust
/// `fs::metadata(path)` into the two change-token dimensions — nanosecond
/// mtime and size — in ONE stat call, `None` on any stat failure
/// (including "doesn't exist"). Used by [`OpencodeSource`]'s change
/// token, which treats a missing file as (mtime 0, size 0).
fn stat_token_parts(path: &Path) -> Option<(i64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    Some((mtime_ns, meta.len()))
}
```

3d. Replace the body of `OpencodeSource::direct_change_token` (:775-785):

```rust
    fn direct_change_token(&self) -> Option<DirectToken> {
        // The WAL wrinkle is load-bearing: sqlite in WAL mode (opencode's
        // default) can satisfy a write by appending to `opencode.db-wal`
        // ALONE, leaving `opencode.db`'s own mtime unchanged until the
        // next checkpoint. Watching BOTH files — max of the mtimes, sum of
        // the sizes, missing file as (0, 0) — means a WAL-only write still
        // changes the token. Both TOKEN dimensions are load-bearing too:
        // see [`DirectToken`] (ms truncation + coarse clock assignment).
        let [db, wal] = self.provider.watched_database_paths();
        let (db_mtime, db_size) = stat_token_parts(&db).unwrap_or((0, 0));
        let (wal_mtime, wal_size) = stat_token_parts(&wal).unwrap_or((0, 0));
        Some(DirectToken {
            mtime_ns: db_mtime.max(wal_mtime),
            size: db_size + wal_size,
        })
    }
```

3e. Change `DirectEntry`'s field type (:1958-1961) to `token: DirectToken` and adapt its doc comment's "keyed by change-token" prose (no semantic change). The unchanged gate at :2049 (`e.token == token`) is unchanged.

3f. Adapt the constant/changing-token test fakes to the new type (compile-only):
- `crates/freshell-sessions/src/directory_index.rs:5531`: `fn direct_change_token(&self) -> Option<DirectToken> { Some(DirectToken { mtime_ns: 42, size: 0 }) }` (keep its "CONSTANT token" comment).
- `crates/freshell-server/src/resolve.rs:961` (the `FixtureSource` inside the `tests` module): `fn direct_change_token(&self) -> Option<DirectToken> { Some(DirectToken { mtime_ns: 1, size: 0 }) }`.
- `crates/freshell-server/src/resolve.rs:1014` (the `FailingDirectSource` inside the same `tests` module — its token CHANGES every call by design; preserve that: `Some(DirectToken { mtime_ns: self.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst), size: 0 })`).
- In `crates/freshell-server/src/resolve.rs`, extend the `tests` module's existing import (at :944-946, `use freshell_sessions::directory_index::{FileStat, IndexedSession, SessionIndex, SessionSource};`) with `DirectToken`. The unqualified uses live inside this `tests` module — do NOT add the import to the parent module's :134 import list.

Nothing else changes: the trait's other implementors are the `CountingWrapper` (delegates — signature-only) and these fakes; `PersistState` persists no tokens (in-memory only, no ms/ns mixing concern); the amplifier's `file_mtime_ms` (amplifier.rs:241) is display parity (`getActivityMtimeMs`, ms by contract) and is NOT touched; the `file_mtime_ms` helper itself stays (the file-based stat cache and the wal tests' witness step still use it).

- [ ] **Step 4: Run the focused tests**

Run (two invocations — cargo takes ONE positional filter each):

1. `cargo test -p freshell-sessions --lib opencode_wal_move_within_the_same_millisecond_still_relists` — Expected: PASS (fast, well under 5s).
2. `cargo test -p freshell-sessions --lib opencode_wal_growth_with_an_unchanged_max_mtime_still_relists` — Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor needed: `DirectToken` is a minimal two-field value type, the helper mirrors `stat_file`'s established shape, and both regression tests reuse the module's existing fixture and settle idiom. State this explicitly in the task report.

- [ ] **Step 6: Run impacted-test verification**

The token type change affects every consumer of the change token: all directory_index opencode tests (the unchanged-gate tests at :4206 and :2991-3162 keep their semantics — tokens only ever compare for equality within one process lifetime), the two previously-flaky pinned tests, and the dependents that implement or consume `SessionSource` (freshell-server's resolve route and its test fake; freshell-ws and freshell-freshagent depend on freshell-sessions and must keep compiling).

Run (four invocations — cargo takes ONE positional filter each):

1. `cargo test -p freshell-sessions --lib opencode_wal_move_relists_without_rewalking_unchanged_sessions` — Expected: PASS
2. `cargo test -p freshell-sessions --lib opencode_content_identical_relist_does_not_bump_generation` — Expected: PASS
3. `cargo test -p freshell-sessions` (full crate — 320 tests including the two new ones) — Expected: PASS
4. `cargo test -p freshell-server -p freshell-ws -p freshell-freshagent` (sessions' dependents' lanes) — Expected: PASS

Then the flake certification (house idiom: repeated runs, CI-like 2-core pin; the pre-fix evidence was 10/10 green locally so the certification must be strictly stronger than a single pass), failing closed on any failure (the certification substitutes for pre-PR CI proof, so its command status must be authoritative):

```bash
set -o pipefail; ok=1
for t in opencode_wal_move_within_the_same_millisecond_still_relists opencode_wal_growth_with_an_unchanged_max_mtime_still_relists opencode_wal_move_relists_without_rewalking_unchanged_sessions opencode_content_identical_relist_does_not_bump_generation; do
  for i in $(seq 1 10); do
    taskset -c 0,1 cargo test -p freshell-sessions --lib "$t" > /tmp/wal-deflake-cert-$t-$i.log 2>&1 || { echo "FAIL $t run $i"; ok=0; break 2; }
  done
  echo "10/10 $t"
done
[ "$ok" = 1 ]
```

Expected: `10/10` for each of the four tests, zero failures, and the command exits 0; any test failure prints its line and the command exits 1. Then one full 2-core-pinned crate pass: `taskset -c 0,1 cargo test -p freshell-sessions --lib` — Expected: PASS.

- [ ] **Step 7: Run the broad gate**

Run (coordinated, cloud vitest): `FRESHELL_TEST_SUMMARY='the-usual wal-move-deflake task-1 gate' FRESHELL_VITEST_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 GCLOUD_ROBOT_HOME=/home/dan/code/skill-gcloud-robot/gcloud-robot pnpm run check`

Expected: PASS — green excluding only the ledger-recorded arm E cloud flake (any OTHER failure is attributable to this run and must be fixed before proceeding).

- [ ] **Step 8: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs crates/freshell-server/src/resolve.rs
git commit -m "fix(sessions): two-dimensional opencode change token so same-tick WAL writes re-list deterministically"
```

The commit contains exactly two files: the `DirectToken` type, the `stat_token_parts` helper, the token computation, the `DirectEntry`/fake type adaptations, and the two regression tests in directory_index.rs; the compile-only fake adaptation in resolve.rs. The two #819 tests are untouched. The witness `eprintln!` lines from Step 2 must NOT be in the commit.
