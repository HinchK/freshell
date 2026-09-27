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
- Token size-awareness stays out of scope (no supported filesystem in the matrix is coarser than 100ns; the deterministic regression test pins the sub-ms visibility contract regardless).
- CI-level final proof (green rust-gate on the PR) happens at landing time; the run's local certification substitutes repeated runs including a 2-core-pinned stress.
- The main checkout's local-environment noise (arm E red there, green in clean worktrees) is out of scope; flagged to the user separately.

**Goal:** The two WAL-move tests pass deterministically everywhere because the production change token actually sees sub-millisecond WAL appends, with a deterministic regression test proving it forever.

**Architecture:** The root cause is in production code, not the tests: `OpencodeSource::direct_change_token` (crates/freshell-sessions/src/directory_index.rs:775-785) is `max(db_mtime, wal_mtime)` where both mtimes are **millisecond-truncated** (`file_mtime_ms`, directory_index.rs:917). A WAL append that lands in the same wall-clock millisecond as the cached token makes the token compare equal, so `refresh_snapshot`'s unchanged gate (directory_index.rs:2044-2050) skips the re-list forever — exactly the CI failure ("the WAL-move re-list must fire and settle" with the counter stuck at 1; not starvation: no amount of waiting helps). The collision (vs. budget starvation) is confirmed by the failing CI runs' own logs — each failed ONLY the two wal tests while every 2s-budget settle sibling passed (receipts: reports/load-bearing-finder.md, F-01). The fix switches the token to nanosecond mtimes (a new `file_mtime_ns` helper used only by the token; the amplifier's ms helper is display parity and stays), adds a belt settle-sleep to each test's first wal-write leg (house style at :4219; no assertion changes), and pins the sub-ms visibility contract with a deterministic regression test whose mtime pins carry a readback canary (a coarse filesystem self-identifies loudly instead of producing a misleading red). One task delivers the deterministic RED reproduction plus the GREEN production fix plus certification.

**Tech Stack:** Rust (edition 2021, MSRV 1.96 — `std::fs::FileTimes`/`File::set_times` stable since 1.75), tokio (`#[tokio::test]` current-thread runtimes), rusqlite fixtures, pnpm-era repo test lanes.

## Global Constraints

- pnpm 10.34.5 exactly; frozen installs only; never `npm ci`/`npm install` in this tree. Focused vitest via `pnpm run test:vitest run <path> --config <config>`; cargo takes ONE positional test filter per invocation.
- Broad coordinated gates behind the shared coordinator (`pnpm run test:status` to inspect; queue behind foreign holders; never kill them); broad runs set `FRESHELL_TEST_SUMMARY`; cloud vitest via `FRESHELL_VITEST_BACKEND=cloud`; agent-launched broad gates export `GCLOUD_ROBOT_REQUIRE=1` and `GCLOUD_ROBOT_HOME=/home/dan/code/skill-gcloud-robot/gcloud-robot`.
- TDD red/green/refactor; never weaken, skip, or loosen the pinned assertions in the two #819 tests — this plan adds only a one-line pre-write settle sleep to each (timing robustness, house style at directory_index.rs:4219); no assertion or expected value changes.
- This run's gate treats exactly one failure as the ledger-recorded pre-existing exclusion: `TerminalView.stuckCard.test.tsx > restart (arm E)` in the cloud lane (receipts in run-state.md's baseline ledger). Any other failure in this run's gates is attributable to this run and must be fixed.
- All work on branch `the-usual/wal-move-deflake` in `/home/dan/code/freshell/.worktrees/wal-move-deflake`; base_ref `d6643304361f5ac4dea2310f2579eb1bc9f485f3`; never touch the production server on port 3001; no PR creation without explicit user approval.
- Commits use the repo's configured git identity (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`); conventional commit messages.
- No docs changes: the fix is internal precision, no user-facing behavior; README and docs/index.html untouched.
- Evidence inputs: `reports/plan-flake-mechanism.md` (root cause, exclusions with line evidence) and `reports/plan-determinism-patterns.md` (settle idioms, blast radius) under the run's logs_dir.

---

### Task 1: Nanosecond opencode change token + deterministic same-ms regression pin

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (tests module: new test inserted between `opencode_wal_move_relists_without_rewalking_unchanged_sessions` and `opencode_content_identical_relist_does_not_bump_generation`; production: `direct_change_token` at :775-785; new helper next to `file_mtime_ms` at :917; the two #819 tests at :4253+ and :4409+ — one pre-write settle sleep line each, no assertion changes)

**Interfaces:**
- Consumes: `SessionSource::direct_change_token(&self) -> Option<i64>` (trait, :195 — signature UNCHANGED; the unit of the opencode token changes from ms to ns); `CountingWrapper` test fixture (:2694-2760, `direct_list_calls: Arc<AtomicUsize>`); `test_index_with_ttl(Vec<Arc<dyn SessionSource>>, Duration)` (:2628); `opencode_data_home_with_sessions`, `set_opencode_session_model`, `OPENCODE_TEST_MODEL` (existing test helpers); `wait_until(Duration, impl FnMut() -> bool) -> bool` (:2589).
- Produces: `fn file_mtime_ns(path: &Path) -> Option<i64>` (private helper, directory_index.rs) — the token's stat helper; the token value semantics for `DirectEntry.token` (:1958) become ns-since-epoch for the opencode source (in-memory only; `PersistState` :1080 persists no tokens, so no migration concern).

- [ ] **Step 1: Write the failing behavioral test**

Add to the tests module in `crates/freshell-sessions/src/directory_index.rs`, immediately after the closing brace of `opencode_wal_move_relists_without_rewalking_unchanged_sessions` (its `std::fs::remove_dir_all` cleanup ends around line 4398-4424, before `opencode_content_identical_relist_does_not_bump_generation` at :4409 — insert between them):

```rust
    /// The same-millisecond regression pin (the 2026-09-27 CI flake): a WAL
    /// append that lands inside the SAME wall-clock millisecond as the
    /// cached change token is a real write (fast sqlite commits do this on
    /// fast hardware — the GitHub-runner reds), and the re-list must still
    /// fire. Reproduced deterministically by pinning both files' mtimes to
    /// KNOWN offsets inside one ms window, so no ms boundary can intervene:
    /// db at +100µs, wal (written after the cold sweep) at +600µs. A
    /// millisecond-truncated token floors both to the same ms and misses
    /// the move; the nanosecond token sees the +500µs.
    #[tokio::test]
    async fn opencode_wal_move_within_the_same_millisecond_still_relists() {
        let data_home = opencode_data_home_with_sessions(
            "opencode-same-ms-wal",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        set_opencode_session_model(&data_home, "ses_a", OPENCODE_TEST_MODEL);
        // A seed-time WAL (if the fixture ever leaves one) must not own the
        // cached token — remove it so the cold sweep caches the DB's mtime.
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
        // Readback canary (F-02): a filesystem that cannot hold the pinned
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

        // Cold snapshot: inline sweep caches the token = the db's pinned ns.
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

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-sessions --lib opencode_wal_move_within_the_same_millisecond_still_relists`

Expected: FAIL after ~5s with `a sub-millisecond WAL move must still trigger the re-list` — the intended missing behavior, not a setup accident: the ms-truncated token (`file_mtime_ms`) floors both the cached db mtime (+100µs offset) and the wal mtime (+600µs offset) to the same millisecond, `refresh_snapshot`'s unchanged gate compares the tokens equal, and `direct_list` never runs (the counter stays 1 for the full 5s settle budget — the exact CI signature). If the test instead fails fast with a stat/set_times error or a `snap.len()`/readback assertion, STOP: that is a fixture/OS accident, not the intended red.

Witness the intended failure before proceeding (the red alone cannot distinguish unchanged-gate suppression from a detached sweep that never ran — F-04): temporarily add `eprintln!("witness db_ms={} wal_ms={} db_ns={:?} wal_ns={:?}", file_mtime_ms(&db), file_mtime_ms(&wal), std::fs::metadata(&db).unwrap().modified(), std::fs::metadata(&wal).unwrap().modified());` as the first line inside the `wait_until` closure (or run once before it), rerun, and confirm the two ms values are EQUAL while the ns values differ by exactly 500_000 — the collision, witnessed. Remove the `eprintln!` before continuing (it must not be committed).

- [ ] **Step 3: Add the minimal production implementation**

3a. In `crates/freshell-sessions/src/directory_index.rs`, next to `file_mtime_ms` (:917), add:

```rust
/// `fs::metadata(path).modified()` in nanoseconds, `None` on any stat
/// failure (including "doesn't exist"). The change-token granularity: a
/// millisecond-truncated token could not see a WAL append that landed in
/// the same wall-clock millisecond as the cached token, so the unchanged
/// gate deferred the re-list a full TTL window (pinned by the
/// same-millisecond regression test). `i64` ns-since-epoch holds until
/// year 2262.
fn file_mtime_ns(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_nanos() as i64)
}
```

3b. Replace the body of `OpencodeSource::direct_change_token` (:775-785):

```rust
    fn direct_change_token(&self) -> Option<i64> {
        // The WAL wrinkle is load-bearing: sqlite in WAL mode (opencode's
        // default) can satisfy a write by appending to `opencode.db-wal`
        // ALONE, leaving `opencode.db`'s own mtime unchanged until the
        // next checkpoint. Taking the max of both files' mtimes (0 for
        // whichever doesn't exist) means a WAL-only write still changes
        // the token.
        //
        // Nanosecond precision is equally load-bearing: the token gates
        // re-lists, and a fast writer CAN append to the WAL in the same
        // wall-clock millisecond as the previous sweep's cached token — a
        // ms-truncated token then reported the source unchanged and
        // deferred the re-list a full TTL window (the same-ms regression
        // test pins this). The unit here is ns, not file_mtime_ms's ms.
        let [db, wal] = self.provider.watched_database_paths();
        let db_mtime = file_mtime_ns(&db).unwrap_or(0);
        let wal_mtime = file_mtime_ns(&wal).unwrap_or(0);
        Some(db_mtime.max(wal_mtime))
    }
```

Nothing else changes: the trait signature stays `Option<i64>`; `DirectEntry.token` stays `i64` (in-memory only — `PersistState` persists no tokens, so old-process ms tokens never mix with new ns tokens); the amplifier's `file_mtime_ms` (amplifier.rs:241) is display-parity (`getActivityMtimeMs`, ms by contract) and is NOT touched.

3c. Belt (F-03, house style at directory_index.rs:4219): in EACH of the two #819 tests, insert one settle sleep immediately before its FIRST `std::fs::write(&wal, b"wal-bytes-changed")` line (in `opencode_wal_move_relists_without_rewalking_unchanged_sessions` at ~:4300 and in `opencode_content_identical_relist_does_not_bump_generation` at ~:4429 — the exact legs the CI reds panicked on at :4304/:4433):

```rust
        // Belt (house style, cf. the pre-write sleep at :4219): settle 30ms
        // before the wal write so the move lands in a later millisecond
        // window even on a hypothetical coarse-mtime filesystem. The ns
        // token makes this redundant on every supported FS (≥100ns
        // granularity); it keeps the test deterministic regardless of any
        // future token-precision regression.
        tokio::time::sleep(Duration::from_millis(30)).await;
```

No assertion, expected value, or existing sleep changes; the tests' phase-3 legs are untouched (never observed red; supported-FS granularity makes them moot).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions --lib opencode_wal_move_within_the_same_millisecond_still_relists`

Expected: PASS (fast, well under 5s — the settle loop's first 10ms poll finds the counter at 2).

- [ ] **Step 5: Refactor while green**

No refactor needed: the new helper mirrors `file_mtime_ms`'s established shape, the token keeps its structure, and the regression test reuses the module's existing fixture and settle idiom. State this explicitly in the task report.

- [ ] **Step 6: Run impacted-test verification**

The token change affects every consumer of `OpencodeSource`'s change token: all directory_index opencode tests (the unchanged-gate tests at :4206 and :2991-3162 use `file_mtime_ms`-era semantics that remain valid — tokens only ever compare for equality within one process lifetime), plus the two previously-flaky pinned tests, plus the dependents that run real sessions code (freshell-server's resolve route drives SessionIndex).

Run (three invocations — cargo takes ONE positional filter each):

1. `cargo test -p freshell-sessions --lib opencode_wal_move_relists_without_rewalking_unchanged_sessions` — Expected: PASS
2. `cargo test -p freshell-sessions --lib opencode_content_identical_relist_does_not_bump_generation` — Expected: PASS
3. `cargo test -p freshell-sessions` (full crate, 319 tests including the new one) — Expected: PASS
4. `cargo test -p freshell-server -p freshell-ws -p freshell-freshagent` (sessions' dependents' lanes — the crates whose Cargo.toml depend on freshell-sessions) — Expected: PASS

Then the flake certification (house idiom: repeated runs, CI-like 2-core pin; the pre-fix evidence was 10/10 green locally so the certification must be strictly stronger than a single pass):

5. Ten repeated 2-core-pinned runs of each of the three same-ms-relevant tests:
   ```bash
   for t in opencode_wal_move_within_the_same_millisecond_still_relists opencode_wal_move_relists_without_rewalking_unchanged_sessions opencode_content_identical_relist_does_not_bump_generation; do
     for i in $(seq 1 10); do taskset -c 0,1 cargo test -p freshell-sessions --lib "$t" > /tmp/wal-deflake-cert-$t-$i.log 2>&1 || { echo "FAIL $t run $i"; break 2; }; done; echo "10/10 $t"; done
   ```
   Expected: `10/10` for each of the three tests, zero failures.
6. One full 2-core-pinned crate pass: `taskset -c 0,1 cargo test -p freshell-sessions --lib` — Expected: PASS.

- [ ] **Step 7: Run the broad gate**

Run (coordinated, cloud vitest): `FRESHELL_TEST_SUMMARY='the-usual wal-move-deflake task-1 gate' FRESHELL_VITEST_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 GCLOUD_ROBOT_HOME=/home/dan/code/skill-gcloud-robot/gcloud-robot pnpm run check`

Expected: PASS — green excluding only the ledger-recorded arm E cloud flake (any OTHER failure is attributable to this run and must be fixed before proceeding).

- [ ] **Step 8: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "fix(sessions): nanosecond opencode change token so same-ms WAL appends re-list deterministically"
```

The commit contains exactly one file: the new regression test with its readback canaries, the `file_mtime_ns` helper, the token's ns switch, and the one-line pre-write settle sleep in each of the two #819 tests (no assertion changes anywhere). The witness `eprintln!` from Step 2 must NOT be in the commit.
