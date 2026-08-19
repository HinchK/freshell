# Amplifier Watch Reduction Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the outstanding work of freshell kata v0h9 ("Replace session-directory continuous polling with event-driven inotify watching"): the approved 2026-08-17 "Amplifier inotify watch reduction" follow-up design at docs/superpowers/plans/2026-08-17-amplifier-watch-reduction.md, using the "the usual" development workflow.

### Explicit constraints
- Run "the usual" workflow: dedicated worktree branch from origin/main, a written plan, load-bearing validation, independent review rounds, red/green/refactor TDD execution, a final independent delta review, and a recap.
- Implement on a worktree branch from origin/main; never push directly to origin/main; the PR to main is created only after the user explicitly approves PR creation.
- Zero latency regression for Amplifier root sessions (all cases, including external resume of arbitrarily old sessions) is a hard requirement of the approved design.
- Scope: the Amplifier provider's session watching changes from one recursive watch tree to a managed watch set; Claude and Codex providers stay recursive; OpenCode is unchanged.

### Accepted tradeoffs and residuals
- Unbounded root-session watch growth is explicitly accepted (~4,430 watches ≈ 0.8% of max_user_watches today; ~31K/yr accrual pace), with a WARN at 25% of the kernel inotify watch limit and a drift alarm on unknown-format arms.
- Subagent-session freshness is demand-driven: a 15s mark_provider_dirty("amplifier") rescan cadence active while any connected WebSocket client's most recent sessions fetch had includeSubagents=true; with the subagent toggle off, subagent rows refresh only at the 15-minute reconcile.

**Goal:** Replace the Amplifier provider's single recursive inotify watch tree (~33K watches on the developer's real `~/.amplifier`) with a managed, deliberately-enumerated watch set (~4.4K watches: projects root + every `<project>/sessions/` + every root-basename session dir), while preserving sub-second freshness for every root session — including external resumes of arbitrarily old sessions — and moving subagent-row freshness to a demand-driven 15s `mark_provider_dirty("amplifier")` cadence active only while a connected WS client has declared `includeSubagents` interest.

**Architecture:** One `notify::RecommendedWatcher` (one inotify fd) per provider; the amplifier engine runs an explicit arm/unwatch managed watch set driven by a pure planner (basename classifier + readdir scan + diff), with depth-relative event routing (structural ops at recv, scoped metadata.json marks for file events), watch-then-scan on every arm, structural-only absence tracking, bounded backoff retry, drift/watch-budget alarms, a refresh→watcher self-correction channel, and a per-connection interest registry + cadence task for subagent freshness. Claude/Codex keep the recursive single-base behavior; OpenCode is untouched.

**Tech Stack:** Rust (workspace crates `freshell-sessions`, `freshell-protocol`, `freshell-ws`, `freshell-server`; toolchain 1.96.0), notify 6 (inotify), tokio; TypeScript/React/Redux client (`src/store`, `shared/ws-protocol.ts`); Vitest for TS-side tests.

## Global Constraints

**Repo / process rules (root + worktree AGENTS.md):**
- Work happens only on this worktree branch (`the-usual/amplifier-watch-reduction`, from `origin/main`). Never commit to or push `main`; never create a PR until the user explicitly approves PR creation. One commit per task, conventional-commit message.
- Never restart or deploy the production server (the live Rust server on port 3001; `scripts/launch-rust.sh --restart/--stop` require the user's explicit "APPROVED"). Building and testing are fine; deploying is not.
- Never use broad kill patterns (`pkill -f ...`, `pkill node`); never kill another agent's test coordinator holder. Broad repo-supported test runs go through the shared coordinator: `npm run test:status` to inspect, `FRESHELL_TEST_SUMMARY` set for holder visibility.
- Rust gates mirror CI exactly (toolchain pinned 1.96.0): `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- TDD: red-green-refactor for every behavior change; never skip, weaken, or mock out production behavior to make a test pass. Existing tests may not be loosened or deleted to fit this change.
- File-size guidance is ~1K lines/file (port/AGENTS.md:81). `session_watcher.rs` is 687 lines today; the amplifier engine will exceed the budget if tests stay inline, so Task 3 splits tests out with the `#[path = "session_watcher_tests.rs"] mod tests;` precedent (`crates/freshell-sessions/src/codex_locator.rs:725`).
- The frozen WS contract: any change to `shared/ws-protocol.ts` or `crates/freshell-protocol/src/*` requires `npm run contract:generate` and committing the regenerated `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`, plus the Rust pins, in the SAME commit (see `docs/plans/2026-07-29-znhn-bccd-followups.md:17`). Additive messages do NOT bump `WS_PROTOCOL_VERSION` (stays 7).
- `.kata.toml` is untouched by this work.
- No e2e specs are affected (no UI change); the e2e cloud backend is unavailable this run. System-level evidence is the Rust integration tests (real notify watchers on temp trees) plus the npm suite.

**Design hard requirements (design doc `docs/superpowers/plans/2026-08-17-amplifier-watch-reduction.md` — the authority):**
- Zero latency regression for amplifier root sessions in ALL cases, including external resume of arbitrarily old sessions: every root-named session dir is watched permanently; no age cutoff, ever.
- Subagent session dirs and everything below a session dir (`context-intelligence/`) are NEVER watched.
- Watch classification is by session-dir BASENAME ONLY: `^[0-9a-f]{16}-[0-9a-f]{16}_` → subagent; anything else (UUID, oddball, unknown) → root → watched. Fails safe toward watching. Never test the underscore against a full path (782/1,235 real project names contain underscores).
- WARN when total armed watches exceed 25% of the kernel limit read from `/proc/sys/fs/inotify/max_user_watches`; the check is re-evaluated after EVERY arm-batch application (startup apply, cascade arms, retry-drain batch, replan apply, absent-root-return cascade) — edge-triggered so it warns once per ≤25%→>25% crossing and re-arms when the count falls back below (Task 4 pins the semantics); startup logs the armed count. Drift alarm: WARN when unknown-format (non-UUID, non-subagent-pattern) arms exceed a small daily threshold.
- The cadence lever is ONLY `index.mark_provider_dirty("amplifier")` (amplifier-only discover at `directory_index.rs:1575-1585`, amplifier-only prune at `:1699-1711`). Never touch the global TTL (`directory_index.rs:47-52`, force_full at `:1237-1241`), and never a fetch-recency window (that starves itself after quiet periods — design lines 134-140). Gating is connected-client state, cleared on disconnect.
- `ProviderLayout` stays pure (no fs I/O in the trait); `AmplifierLayout` keeps `watch_mode() == Recursive` at `provider_layout.rs:188-190` (the managed engine supersedes it at arming time; other consumers like the index's discover are unaffected).
- Unwatch tolerates `WatchNotFound`-class errors at debug level (the kernel already dropped the watch; inotify watches follow inodes, so MovedFrom/Remove MUST unwatch explicitly or they leak and report under stale paths forever).
- Scope: amplifier only. The Node server (`server/`) has its own chokidar watch tree — deliberately untouched (it's not what the self-hosted deployment runs).
- `docs/index.html` is unchanged: no user-facing UI change (the `showSubagents` toggle exists already at `src/components/settings/WorkspaceSettings.tsx:83-85`; only its server-side freshness semantics change).

**Test-harness conventions to follow:** real notify watchers on real temp dirs via the hand-rolled `unique_temp_dir` helpers (no `tempfile` dev-dep in freshell-sessions); observation via `index.subscribe_changes()` generation counter with ≤5s `tokio::time::timeout` and 20×100ms settle polls; call-count assertions via `CountingWrapper`/`CountingSource` (`directory_index.rs:2010-2062`), never wall-clock counts; test-only knobs via `#[cfg(test)]` builders like `with_rearm_interval` (`session_watcher.rs:167-171`). Deterministic-time timer tests: add `test-util` to freshell-sessions' tokio features ONLY if a task below explicitly names that need (none does — every new timer test uses short real intervals or direct helper invocation, mirroring the crate's existing real-time idiom).

## Definition of green (final gate — run in Task 11, nowhere before)

```bash
cargo test -p freshell-sessions -p freshell-server -p freshell-ws --no-fail-fast
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
FRESHELL_VITEST_BACKEND=local npm test
```

Plus two addenda forced by the diff surface: `cargo test -p freshell-protocol --no-fail-fast` (protocol crate touched in Task 8) and `npm run contract:generate && git diff --exit-code -- port/contract/` (regeneration is a committed no-op after Task 8).

## Regression coverage map (design "Regression tests" lines 169-205; rows 18-19 pin the design's watch-then-scan invariant (design lines 44-51) and absence/retry lifecycle (design lines 84-102) — added in fresh-eyes remediation; round-2 remediation then added the projects-root absorb/re-arm lifecycle pin (Task 4), the kind-correct replan-cascade pin (Task 6), the startup-barrier raced-write pin (Task 9), the watch-budget edge-crossing test (Task 4), and observable-work counter pins (CountingWrapper call counters, not generation waits) on the negative no-scan tests (Tasks 3 and 5))

| # | Design requirement | Task | Test(s) |
|---|---|---|---|
| 1 | Folded-sidecar-mtime freshness on BOTH discover and scoped paths | 5 | discover: existing `amplifier.rs:622` + `amplifier.rs:863-914` stay green; scoped: new `scoped_mark_with_sidecar_only_activity_refreshes_amplifier_recency_without_discover` |
| 2 | Subagent rows refresh on the cadence; 15s while subscribed; stops when the last subscribed client disconnects | 8, 9 | `subagent_interest_registry_clears_on_disconnect` (ws integration) + `cadence_marks_amplifier_only_while_interested_and_stops_when_last_interest_leaves`. NOTE: the bullet's "while includeSubagents requests are recent" wording is superseded by connected-client gating (design lines 132-140 are authoritative). |
| 3 | Classification: underscore-bearing PROJECT names never misclassify; unknown basenames default to watched | 1, 3 | `classifier_never_confuses_project_name_underscores` + planner test with `my_proj_x`-style names + watcher integration `amplifier_startup_arms_exactly_the_managed_set` |
| 4 | Misnamed-root self-correction round trip | 7 | `misnamed_subagent_named_root_is_armed_via_refresh_report` + pure `roots_needing_arm` tests |
| 5 | Sidecar/tmp/backup events at canonical depth → scoped metadata.json marks, never provider-dirty; no repeated full discovers | 5 | `amplify_file_depth_events_route_to_scoped_metadata_marks_and_never_escalate` (CountingWrapper discover-count pin) |
| 6 | `context-intelligence/` mkdir inside a session dir → no full discover | 5 | `mkdir_inside_watched_session_dir_is_dropped_no_discover` |
| 7 | Stand-in swap: `sessions/` appearing between check and arm is picked up | 3 | `arm_sessions_or_standin_rechecks_sessions_after_arming` (direct) + `sessions_dir_created_after_standin_arm_is_picked_up` (integration) |
| 8 | Deletion: session-dir removal prunes rows; metadata.json-only deletion with surviving sidecars prunes (stat_scoped None) and never resurrects | 4, 5 | `session_dir_removal_prunes_rows_and_forgets_bookkeeping` + `metadata_json_deleted_but_sidecars_survive_still_prunes_never_resurrects` + existing `deleted_file_pruned`/`scoped_dirty_path_handles_deleted_file` |
| 9 | Arm-failure backoff never bypassed by the self-correction diff | 7 | `roots_needing_arm_respects_retry_backoff` |
| 10 | Debounce max-deferral: sustained sub-200ms stream flushes ≤2s | 6 | `sustained_sub_gap_event_stream_flushes_within_max_deferral` |
| 11 | Transient scan failure (EACCES/EIO) never mass-prunes | (existing) | Existing protection is untouched by this plan and stays green: `real_codex_and_amplifier_unlistable_roots_propagate_from_discover_checked` (directory_index.rs:4561-4633), `a_failing_file_backed_root_listing_records_a_scan_failure_too`, `one_failed_file_source_does_not_block_pruning_a_healthy_source`, `persisted_cache_prunes_and_saves_legacy_nested_amplifier_entry`. No new test needed — asserted by the impacted-set runs of Tasks 2-7 and the final gate. |
| 12 | Cadence marks ONLY amplifier: while active, Claude/Codex/OpenCode see no extra DISCOVER/PRUNE sweeps (opencode's cheap change-token read per scoped sweep is unchanged and allowed) | 9 | `cadence_marks_amplifier_only_while_interested_and_stops_when_last_interest_leaves` pins per-source discover calls; opencode-token caveat recorded in the test comment |
| 13 | Renamed root session dir re-armed via the cascade (MovedTo/Name(Both) as create) | 4 | `renamed_root_session_dir_is_rearmed_immediately` |
| 14 | Toggle off: subagent-dir mkdir triggers no full discover; stand-in children that aren't `sessions/` are dropped | 3, 5 | `standin_project_children_other_than_sessions_are_dropped` + `subagent_mkdir_dropped_when_no_interest_escalates_when_interested` |
| 15 | Cadence stays live through arbitrarily long quiet periods while a subscribed client is connected; stops at last disconnect | 8, 9 | quiet-period phase of the Task 9 cadence test (no fetch traffic at all between ticks) + Task 8 disconnect-clear integration |
| 16 | Structural MovedFrom/Remove of a project cleans armed/absent/retry bookkeeping; no leaked inode-following watches after mv | 4 | `project_move_or_remove_cleans_all_bookkeeping` + `moved_away_session_dir_is_explicitly_unwatched` |
| 17 | Stray file at project depth → no arm attempt; deterministic arm error (ENOENT/ENOTDIR) leaves the retry set immediately | 1, 3 | `planner_ignores_stray_files_at_project_depth` + `deterministic_arm_failure_never_enters_retry_set` |
| 18 | Watch-then-scan at startup: a root session dir created between the initial plan scan and the structural arms is armed via the post-arm rescan union (zero-latency hard requirement) | 3 | `startup_arms_session_dirs_created_in_the_scan_arm_window` |
| 19 | Transient arm failure retries on the rearm-tick drain until it arms; failures re-enter with doubled, capped backoff; replan/self-correction never bypass backoff | 3 | `transient_arm_failure_is_retried_by_the_rearm_drain_and_eventually_arms` + pure `retry_backoff_doubles_to_a_sixty_second_cap` |

---

### Task 1: Pure watch-set planner (basename classifier + plan scan + armed-set diff)

**Files:**
- Create: crates/freshell-sessions/src/watch_plan.rs
- Modify: crates/freshell-sessions/src/lib.rs:28-32 (module list; add `pub mod watch_plan;` between `provider_layout` and `resume_input`)

**Interfaces:**
- Consumes: `crate::directory_index::open_root_dir` (pub(crate), `directory_index.rs:242-255` — NotFound/NotADirectory → `Ok(None)`, other errors propagate). The planner is deliberately STRICT-EVERYWHERE and does NOT mirror the strict-root/tolerant-nested traversal convention of `discover_amplifier_metadata` (`amplifier.rs:120-183`): the plan feeds Task 6's replan unwatch diff, so a partial plan built over a nested read error would mass-unwatch healthy root sessions.
- Produces (all `pub(crate)`):
  - `enum BasenameClass { Subagent, UuidRoot, Unknown }`
  - `fn classify_basename(name: &str) -> BasenameClass` (static `regex::Regex` via `std::sync::LazyLock`, mirroring `resume_input.rs:84-87`; the crate already depends on `regex = "1"`)
  - `fn is_watch_target(class: BasenameClass) -> bool` (`!= Subagent`; fails safe toward watching)
  - `struct PlanTargets { root_exists: bool, sessions_dirs: Vec<PathBuf>, standins: Vec<PathBuf>, root_session_dirs: Vec<PathBuf>, unknown_format_arms: usize, stray_file_projects: usize }`
  - `fn plan_amplifier_targets(projects_root: &Path) -> Result<PlanTargets, std::io::Error>`
  - `enum ArmKind { ProjectsRoot, SessionsDir, Standin, SessionDir }` — the four arm semantics of the design's watch set, carried by every planned/desired target so NO consumer ever flattens target categories back to bare paths (the planner is the single authority on "what kind of arm is this path"; the session_watcher only consumes kinds). `SessionDir` arms classify the basename inside `arm_managed_dir` (Task 4's drift-counter input).
  - `struct ArmTarget { pub path: PathBuf, pub kind: ArmKind }` + `struct PlanDiff { pub arm: Vec<ArmTarget>, pub unwatch: Vec<PathBuf> }`
  - `fn diff_armed(desired: &HashMap<PathBuf, ArmKind>, armed: &HashSet<PathBuf>) -> PlanDiff` — `desired` is the kind-tag map every caller builds from a `PlanTargets` plus the `{ projects_root: ArmKind::ProjectsRoot }` entry (when the root exists); `diff.arm` entries carry their kind straight from the map, so Task 6's replan re-arms a newly-planned `sessions/` dir AS a `SessionsDir` (with the cascade) and a stand-in AS a `Standin` (with the swap) rather than as a flattened bare path. `arm` is sorted by path (deterministic apply/log order).
  - `enum ArmErr { Deterministic, Transient }`; `fn classify_arm_error(err: &notify::Error) -> ArmErr` — match `&err.kind`: `notify::ErrorKind::PathNotFound` → Deterministic; `ErrorKind::Io(io)` → Deterministic iff `io.kind()` is `std::io::ErrorKind::NotFound | NotADirectory`, else Transient; `ErrorKind::MaxFilesWatch` → Transient (watch-limit exhaustion clears; evicted paths re-arm after pressure releases); everything else → Transient

- [ ] **Step 1: Write the failing behavioral test**
  New file `crates/freshell-sessions/src/watch_plan.rs` containing ONLY the test module first (compile-and-fail red; the module declares no items yet), AND register `pub mod watch_plan;` in `crates/freshell-sessions/src/lib.rs` (alphabetical, after `pub mod provider_layout;`) IN THE SAME EDIT — module registration is part of the test edit, so the failing tests compile into the tree and fail for the missing-behavior reason:

  ```rust
  //! (Task 1 adds the module doc + implementation above these tests.)

  #[cfg(test)]
  mod tests {
      use super::*;
      use std::path::{Path, PathBuf};

      fn unique_temp_dir(label: &str) -> PathBuf {
          static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
          std::env::temp_dir().join(format!(
              "freshell-watch-plan-{label}-{}-{}",
              std::process::id(),
              COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
          ))
      }

      fn mkdir(p: &Path) { std::fs::create_dir_all(p).unwrap(); }

      #[test]
      fn classify_basename_pins_the_amplifier_naming_contract() {
          // Subagent: ^[0-9a-f]{16}-[0-9a-f]{16}_ — incl. the all-zeros first
          // segment observed on the real machine.
          assert_eq!(classify_basename("0000000000000000-014b6af1c2ac4ab5_foundation-session-analyst"), BasenameClass::Subagent);
          assert_eq!(classify_basename("0123456789abcdef-fedcba9876543210_x"), BasenameClass::Subagent);

          // Root UUID (real sample): lowercase 8-4-4-4-12.
          assert_eq!(classify_basename("012584be-9478-4801-a62d-4e5da428b3a0"), BasenameClass::UuidRoot);

          // Fail safe toward watching: 16hex-16hex WITHOUT the `_name` suffix
          // (real oddball `3857d6bf9587425b-345eb38395044eab`), arbitrary
          // oddballs, uppercase hex, empty — all Unknown (watched, drift-counted).
          assert_eq!(classify_basename("3857d6bf9587425b-345eb38395044eab"), BasenameClass::Unknown);
          assert_eq!(classify_basename("tmp-usual-bench"), BasenameClass::Unknown);
          assert_eq!(classify_basename("sess-identity-1"), BasenameClass::Unknown);
          assert_eq!(classify_basename("0123456789ABCDEF-fedcBA9876543210_x"), BasenameClass::Unknown);
          assert_eq!(classify_basename(""), BasenameClass::Unknown);
          for class in [BasenameClass::UuidRoot, BasenameClass::Unknown] {
              assert!(is_watch_target(class));
          }
          assert!(!is_watch_target(BasenameClass::Subagent));
      }

      #[test]
      fn classifier_never_confuses_project_name_underscores() {
          // 782/1,235 real project names contain `_`. Classification consumes the
          // SESSION-DIR basename only; a project-named string must never satisfy
          // the subagent pattern unless it genuinely matches ^16hex-16hex_.
          assert_eq!(classify_basename("-home-dan-code-my_project"), BasenameClass::Unknown);
          assert_eq!(classify_basename("recipe-sessions"), BasenameClass::Unknown);
      }

      #[test]
      fn planner_ignores_stray_files_at_project_depth() {
          // Regression 17a: a stray file at project depth (`repl_history` exists
          // on the real machine) never generates a doomed `<file>/sessions` arm.
          let root = unique_temp_dir("planner-stray");
          let projects = root.join("projects");
          std::fs::create_dir_all(&projects).unwrap();
          std::fs::write(projects.join("repl_history"), b"nope").unwrap();
          mkdir(&projects.join("my_proj_x").join("sessions").join("012584be-9478-4801-a62d-4e5da428b3a0"));
          mkdir(&projects.join("my_proj_x").join("sessions").join("0000000000000000-014b6af1c2ac4ab5_a"));
          mkdir(&projects.join("no_sessions_proj")); // stand-in

          let plan = plan_amplifier_targets(&projects).unwrap();
          assert!(plan.root_exists);
          assert_eq!(plan.sessions_dirs, vec![projects.join("my_proj_x").join("sessions")]);
          assert_eq!(plan.standins, vec![projects.join("no_sessions_proj")]);
          assert_eq!(plan.root_session_dirs, vec![
              projects.join("my_proj_x").join("sessions").join("012584be-9478-4801-a62d-4e5da428b3a0"),
          ]);
          assert_eq!(plan.unknown_format_arms, 0);
          assert_eq!(plan.stray_file_projects, 1);
          // The stray file appears nowhere:
          let flat: Vec<&PathBuf> = plan.sessions_dirs.iter()
              .chain(plan.standins.iter()).chain(plan.root_session_dirs.iter()).collect();
          assert!(!flat.iter().any(|p| p.ends_with("repl_history")));
          std::fs::remove_dir_all(&root).ok();
      }

      #[test]
      fn planner_counts_unknown_format_root_dirs_as_drift_input() {
          let root = unique_temp_dir("planner-drift");
          let projects = root.join("projects");
          mkdir(&projects.join("p").join("sessions").join("3857d6bf9587425b-345eb38395044eab")); // oddball
          mkdir(&projects.join("p").join("sessions").join("012584be-9478-4801-a62d-4e5da428b3a0"));
          let plan = plan_amplifier_targets(&projects).unwrap();
          assert_eq!(plan.unknown_format_arms, 1);
          assert_eq!(plan.root_session_dirs.len(), 2); // both are watched
          std::fs::remove_dir_all(&root).ok();
      }

      #[test]
      fn planner_missing_root_is_absent_not_error() {
          let root = unique_temp_dir("planner-absent");
          let plan = plan_amplifier_targets(&root.join("projects")).unwrap();
          assert!(!plan.root_exists);
          assert!(plan.sessions_dirs.is_empty() && plan.root_session_dirs.is_empty() && plan.standins.is_empty());
      }

      /// A nested read error ANYWHERE (here: one project's `sessions/` dir is
      /// unreadable while the projects root and the project dir list fine)
      /// fails the WHOLE plan — never a partial plan. Task 6's replan aborts
      /// on `Err`, so a transient nested EACCES/EIO tears nothing down.
      #[cfg(unix)]
      #[test]
      fn planner_nested_scan_error_fails_the_whole_plan() {
          use std::os::unix::fs::PermissionsExt;
          let root = unique_temp_dir("planner-nested-err");
          let projects = root.join("projects");
          mkdir(&projects.join("good").join("sessions").join("012584be-9478-4801-a62d-4e5da428b3a0"));
          let bad_sessions = projects.join("bad").join("sessions");
          mkdir(&bad_sessions.join("aa2584be-9478-4801-a62d-4e5da428b3a0"));
          std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
          if std::fs::read_dir(&bad_sessions).is_ok() {
              eprintln!("skipping: euid can list a 0o000 dir");
              std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
              std::fs::remove_dir_all(&root).ok();
              return;
          }
          assert!(
              plan_amplifier_targets(&projects).is_err(),
              "a nested readdir error fails the whole plan (no partial plans)"
          );
          std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
          std::fs::remove_dir_all(&root).ok();
      }

      #[test]
      fn diff_armed_partitions_missing_and_extra_and_keeps_kinds() {
          // Desired targets carry their ArmKind; the diff's arm entries must
          // keep it so replan applies each arm with its own semantics (never
          // a flattened bare-path arm).
          let desired: std::collections::HashMap<PathBuf, ArmKind> = [
              (PathBuf::from("/a"), ArmKind::SessionsDir),
              (PathBuf::from("/b"), ArmKind::SessionDir),
          ]
          .into_iter()
          .collect();
          let armed: std::collections::HashSet<PathBuf> =
              ["/b", "/c"].iter().map(PathBuf::from).collect();
          let diff = diff_armed(&desired, &armed);
          assert_eq!(
              diff.arm,
              vec![ArmTarget {
                  path: PathBuf::from("/a"),
                  kind: ArmKind::SessionsDir,
              }]
          );
          assert_eq!(diff.unwatch, vec![PathBuf::from("/c")]);
      }

      #[test]
      fn classify_arm_error_splits_deterministic_io_from_transient() {
          use std::io::ErrorKind;
          // notify 6.1.1 API (verified against the vendored error.rs):
          // `Error::io` and `Error::path_not_found` are pub constructors;
          // `ErrorKind::MaxFilesWatch` exists but has no pub constructor, so
          // its Transient arm is default-covered (not test-constructible).
          assert!(matches!(classify_arm_error(&notify::Error::path_not_found()), ArmErr::Deterministic));
          assert!(matches!(classify_arm_error(&notify::Error::io(std::io::Error::from(ErrorKind::NotFound))), ArmErr::Deterministic));
          assert!(matches!(classify_arm_error(&notify::Error::io(std::io::Error::from(ErrorKind::NotADirectory))), ArmErr::Deterministic));
          assert!(matches!(classify_arm_error(&notify::Error::io(std::io::Error::from(ErrorKind::PermissionDenied))), ArmErr::Transient));
          assert!(matches!(classify_arm_error(&notify::Error::io(std::io::Error::from(ErrorKind::Other))), ArmErr::Transient));
      }
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib watch_plan`
  Expected: FAIL because `freshell-sessions` does not compile: `watch_plan::tests` (registered in `lib.rs` by the Step-1 edit, so the module DOES compile into the tree) references `classify_basename`, `plan_amplifier_targets`, `diff_armed`, `ArmKind`, `ArmTarget`, `classify_arm_error`, none of which exist yet. (E0432/E0425-family compile errors, not syntax accidents.)

- [ ] **Step 3: Add the minimal production implementation**
  Prepend to `crates/freshell-sessions/src/watch_plan.rs` (before `mod tests`; `pub mod watch_plan;` in `lib.rs` already landed with the Step-1 test edit):

  ```rust
  //! Pure watch-set planning for the amplifier provider's managed inotify
  //! watch set (kata v0h9 follow-up, design doc
  //! `docs/superpowers/plans/2026-08-17-amplifier-watch-reduction.md`).
  //!
  //! Everything here is either pure (string/path classification, set
  //! arithmetic, error classification) or ONE standalone readdir scan. No
  //! watcher state, no index knowledge — the `session_watcher` module owns
  //! arming; this module owns "what SHOULD be armed".

  use std::collections::HashSet;
  use std::path::{Path, PathBuf};
  use std::sync::LazyLock;

  use regex::Regex;

  static SUBAGENT_BASENAME_RE: LazyLock<Regex> = LazyLock::new(|| {
      Regex::new(r"^[0-9a-f]{16}-[0-9a-f]{16}_").expect("static regex")
  });
  static UUID_BASENAME_RE: LazyLock<Regex> = LazyLock::new(|| {
      Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
          .expect("static regex")
  });

  /// Basename classification of a session-dir name (design: classification is
  /// by the session dir's BASENAME only, never the full path — 782/1,235 real
  /// project names contain underscores).
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub(crate) enum BasenameClass {
      /// `^[0-9a-f]{16}-[0-9a-f]{16}_` — a delegated subagent session dir.
      /// NEVER watched (design: subagent dirs and everything below them are
      /// excluded from the watch set).
      Subagent,
      /// Lowercase 8-4-4-4-12 UUID — a root session dir. Watched forever.
      UuidRoot,
      /// Anything else — oddballs and unknown formats FAIL SAFE toward
      /// watching (a misclassified subagent would silently lose freshness; an
      /// over-watched oddball only costs one watch and feeds the drift alarm).
      Unknown,
  }

  pub(crate) fn classify_basename(name: &str) -> BasenameClass {
      if SUBAGENT_BASENAME_RE.is_match(name) {
          BasenameClass::Subagent
      } else if UUID_BASENAME_RE.is_match(name) {
          BasenameClass::UuidRoot
      } else {
          BasenameClass::Unknown
      }
  }

  /// Only subagent dirs are excluded (design's fail-safe default).
  pub(crate) fn is_watch_target(class: BasenameClass) -> bool {
      !matches!(class, BasenameClass::Subagent)
  }

  /// The desired amplifier watch set for one `<amplifier_home>/projects` root
  /// (design "Watch set" items 1-4, excluding the root itself which the
  /// engine always attempts first).
  #[derive(Debug, Default, PartialEq, Eq)]
  pub(crate) struct PlanTargets {
      /// Whether `<projects>` itself exists (drives root absence tracking).
      pub root_exists: bool,
      /// `<project>/sessions` dirs that exist — permanent watches.
      pub sessions_dirs: Vec<PathBuf>,
      /// `<project>` dirs with no `sessions/` child — watched as stand-ins so
      /// a later-created `sessions/` is observed (design item 2).
      pub standins: Vec<PathBuf>,
      /// Root-classified session dirs (UuidRoot or Unknown) — permanent
      /// watches. Subagent-classified dirs never appear here.
      pub root_session_dirs: Vec<PathBuf>,
      /// Count of `root_session_dirs` entries classified Unknown — the
      /// drift-alarm counter input.
      pub unknown_format_arms: usize,
      /// Stray non-dir entries at project depth (e.g. `repl_history`) — never
      /// armed, counted for the regression-17 pin.
      pub stray_file_projects: usize,
  }

  /// ONE readdir sweep (never recursive) building the managed watch set.
  /// Root-open semantics match the discover contract (`open_root_dir`): a
  /// missing projects root is `Ok(plan with root_exists:false)`, other root
  /// errors PROPAGATE (a transient EACCES/EIO must not look like "nothing to
  /// arm"). Nested reads are STRICT, not tolerant like
  /// `discover_project_session_metadata`: ANY readdir/stat error at ANY depth
  /// (projects-root entry, a `sessions/` stat or readdir, a session entry,
  /// an entry's `file_type`) fails the WHOLE plan with `Err` — never a
  /// partial plan. The plan is authoritative for Task 6's replan unwatch
  /// diff; a partial plan over a transient nested error would tear every
  /// healthy root watch it failed to see. A plain MISSING `sessions/` dir
  /// (NotFound) is NOT an error — it yields the stand-in — and a non-dir
  /// `sessions` FILE is not an error either (classification by entry
  /// file_type stays; only ERRORS fail the plan).
  pub(crate) fn plan_amplifier_targets(projects_root: &Path) -> Result<PlanTargets, std::io::Error> {
      let mut plan = PlanTargets::default();
      let Some(entries) = crate::directory_index::open_root_dir(projects_root)? else {
          return Ok(plan);
      };
      plan.root_exists = true;
      let mut projects: Vec<PathBuf> = Vec::new();
      for entry in entries {
          let entry = entry?;
          if entry.file_type()?.is_dir() {
              projects.push(entry.path());
          } else {
              plan.stray_file_projects += 1;
          }
      }
      projects.sort(); // determinism (readdir order is filesystem-dependent)
      for project in projects {
          let sessions = project.join("sessions");
          match std::fs::metadata(&sessions) {
              // Plain missing `sessions/` ⇒ stand-in. NOT an error.
              Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                  plan.standins.push(project);
              }
              // Strict: any stat error fails the whole plan.
              Err(e) => return Err(e),
              // `sessions` exists but is a FILE — treat like the stand-in
              // (classification by file_type stays; never a doomed arm).
              Ok(meta) if !meta.is_dir() => {
                  plan.standins.push(project);
              }
              Ok(_) => {
                  plan.sessions_dirs.push(sessions.clone());
                  // Strict: the readdir AND every entry/file_type error
                  // propagate — no partial plans.
                  let mut dirs: Vec<PathBuf> = Vec::new();
                  for entry in std::fs::read_dir(&sessions)? {
                      let entry = entry?;
                      if entry.file_type()?.is_dir() {
                          dirs.push(entry.path());
                      }
                  }
                  dirs.sort();
                  for session_dir in dirs {
                      let name = session_dir
                          .file_name()
                          .and_then(|n| n.to_str())
                          .unwrap_or("");
                      match classify_basename(name) {
                          BasenameClass::Subagent => {} // never watched
                          BasenameClass::UuidRoot => plan.root_session_dirs.push(session_dir),
                          BasenameClass::Unknown => {
                              plan.root_session_dirs.push(session_dir);
                              plan.unknown_format_arms += 1;
                          }
                      }
                  }
              }
          }
      }
      Ok(plan)
  }

  /// The arm semantics of one managed-watch target (design "Watch set"
  /// items 1-3). Carried end-to-end — plan → diff → retry entry → arm call —
  /// so no consumer re-derives (or loses) the kind: a `SessionsDir` arm
  /// cascades its root-session children, a `Standin` arm performs the
  /// stand-in swap, a `SessionDir` arm does the watch-then-scan scoped
  /// file-state mark, and `ProjectsRoot` alone re-enters absence tracking.
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub(crate) enum ArmKind {
      /// `<amplifier_home>/projects` itself — depth-0 structural watch.
      ProjectsRoot,
      /// `<project>/sessions` — arm + cascade its root-classified children.
      SessionsDir,
      /// `<project>` with no `sessions/` yet — arm + post-arm recheck swap.
      Standin,
      /// A root-classified session dir — arm + scoped metadata.json mark.
      SessionDir,
  }

  /// One path to arm, tagged with the semantics its arm must apply.
  #[derive(Debug, PartialEq, Eq)]
  pub(crate) struct ArmTarget {
      pub path: PathBuf,
      pub kind: ArmKind,
  }

  /// Set difference between the desired (kind-tagged) and currently-armed
  /// paths (sorted by path — call sites log/apply deterministically).
  #[derive(Debug, Default, PartialEq, Eq)]
  pub(crate) struct PlanDiff {
      pub arm: Vec<ArmTarget>,
      pub unwatch: Vec<PathBuf>,
  }

  pub(crate) fn diff_armed(
      desired: &std::collections::HashMap<PathBuf, ArmKind>,
      armed: &HashSet<PathBuf>,
  ) -> PlanDiff {
      let mut arm: Vec<ArmTarget> = desired
          .iter()
          .filter(|(path, _)| !armed.contains(*path))
          .map(|(path, kind)| ArmTarget {
              path: path.clone(),
              kind: *kind,
          })
          .collect();
      arm.sort_by(|a, b| a.path.cmp(&b.path));
      let mut unwatch: Vec<PathBuf> = armed
          .iter()
          .filter(|p| !desired.contains_key(*p))
          .cloned()
          .collect();
      unwatch.sort();
      PlanDiff { arm, unwatch }
  }

  /// Arm-failure classification (design: ENOENT/ENOTDIR entries are dropped
  /// immediately — a dir's reappearance arrives as a fresh structural create;
  /// everything else is a transient error that gets bounded backoff retry).
  /// Arms fail with `notify::Error` (`watch()` returns
  /// `Result<(), notify::Error>`), so the classifier consumes that type and
  /// matches its pub `kind` field, never a bare `std::io::Error`.
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub(crate) enum ArmErr {
      Deterministic,
      Transient,
  }

  pub(crate) fn classify_arm_error(err: &notify::Error) -> ArmErr {
      match &err.kind {
          notify::ErrorKind::PathNotFound => ArmErr::Deterministic,
          notify::ErrorKind::Io(io) => match io.kind() {
              std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                  ArmErr::Deterministic
              }
              _ => ArmErr::Transient,
          },
          // `ErrorKind::MaxFilesWatch` → Transient via this default arm:
          // watch-limit exhaustion clears and evicted paths re-arm after the
          // pressure releases. `MaxFilesWatch` has no pub constructor in
          // notify 6.1.1 (verified against the vendored error.rs), so it is
          // exercised only through this default coverage, not a unit test.
          _ => ArmErr::Transient,
      }
  }
  ```

  Note: the production items are `pub(crate)` (consumed by Task 3's `session_watcher` code only); the `pub enum BasenameClass` and `PlanTargets` tests above reference them via `super::*` inside the crate.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib watch_plan`
  Expected: PASS (8 tests).

- [ ] **Step 5: Refactor while green**
  No refactor needed: the module is new and minimal; the traversal is deliberately strict-everywhere (the discover path's tolerant-nested idiom is intentionally NOT mirrored — the plan feeds Task 6's unwatch diff, so a partial plan is a mass-unwatch hazard); the two regexes follow the crate's `LazyLock<Regex>` precedent. `cargo fmt --all -- --check` must be clean.

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: the whole `freshell-sessions` crate (a new public(crate) module + one `lib.rs` line; no existing code paths change, but the suite is cheap and this is the crate's safety net). Behavior untouched elsewhere.
  Run: `cargo test -p freshell-sessions`
  Expected: PASS (all existing tests green plus the 8 new ones).

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/watch_plan.rs crates/freshell-sessions/src/lib.rs
  git commit -m "feat(sessions): pure watch-set planner for the amplifier managed watch set"
  ```

---

### Task 2: One inotify watcher per provider (explicit watch/unwatch restructure)

**Files:**
- Modify: crates/freshell-sessions/src/session_watcher.rs:52-58 (replace `ArmedWatch`), :124-155 (replace `arm_watcher`), :196-264 (initial arming), :334-399 (rearm tick)

**Interfaces:**
- Consumes: `make_watcher_callback` (:86-120), `WatchEvent`, `WatchedProvider`, `nearest_existing_ancestor` (:406-419) — all unchanged.
- Produces (module-private, consumed by every later task):
  - `struct ProviderWatch { watcher: notify::RecommendedWatcher, targets: Vec<ArmedTarget> }` — ONE watcher (one inotify fd) per provider, explicit per-path arms; `struct ArmedTarget { requested_base: PathBuf, actual_target: PathBuf }`
  - `fn create_provider_watcher(tx: &mpsc::UnboundedSender<WatchEvent>, provider_name: &str, is_direct: bool) -> Option<notify::RecommendedWatcher>`
  - `fn watch_path(watcher: &mut notify::RecommendedWatcher, provider_name: &str, target: &Path, mode: notify::RecursiveMode) -> Result<(), notify::Error>` (warns + propagates on failure; no swallowing)
  - `fn unwatch_tolerated(watcher: &mut notify::RecommendedWatcher, provider_name: &str, target: &Path)` — ignore `notify::ErrorKind::WatchNotFound` at debug (kernel already dropped the watch), warn on anything else
  - `enum WatchKind { Create, CreateFolder, Remove, NameFrom, NameTo, NameBoth, Modify, Other }` + `fn kind_of(event: &notify::Event) -> WatchKind` (pure; `need_rescan()` events never carry it — they short-circuit to `ProviderRescan` in the callback; `CreateKind::Folder` maps to the distinct `CreateFolder` variant — every other `Create(_)` is `Create` — so Task 5's depth-4 routing can DROP a folder creation (`context-intelligence/` mkdir) while scoped-marking a file creation; structural depths 1-3 treat `CreateFolder` as create-ish alongside `Create`, since a mkdir IS a `Create(Folder)` under inotify. `Remove` carries NO dir-vs-file tag: an armed dir's self-delete surfaces as `Remove(File)` because the kernel doesn't tag IN_DELETE_SELF with ISDIR (LB-01 probe), so structural-remove consumers never filter on the tag)
  - `WatchEvent::FileChanged` gains `paths: Vec<PathBuf>` + `kind: WatchKind` (one message per event, preserving rename pairing; legacy flush iterates paths and ignores kind)
  - `watches: HashMap<usize, ProviderWatch>` keyed by provider index replaces `armed: Vec<ArmedWatch>`; unwatching a base = `unwatch_tolerated` on the OLD `actual_target` + `targets.retain(...)` — never by drop.

- [ ] **Step 1: Write the failing behavioral test**
  Append to `#[cfg(test)] mod tests` at the bottom of `crates/freshell-sessions/src/session_watcher.rs` (before the closing brace):

  ```rust
      /// Drain FileChanged paths into a set until `done` holds or the window
      /// closes (ProviderRescan carries no paths and is skipped; a closed
      /// channel or the expired deadline ends the drain). Module scope: Task
      /// 3's amplifier tests reuse this collector after the test-file move.
      async fn collect_file_paths(
          rx: &mut mpsc::UnboundedReceiver<WatchEvent>,
          window: Duration,
          done: impl Fn(&std::collections::HashSet<PathBuf>) -> bool,
      ) -> std::collections::HashSet<PathBuf> {
          let mut seen = std::collections::HashSet::new();
          let until = tokio::time::Instant::now() + window;
          while !done(&seen) {
              match tokio::time::timeout_at(until, rx.recv()).await {
                  Ok(Some(WatchEvent::FileChanged { paths, .. })) => seen.extend(paths),
                  Ok(Some(WatchEvent::ProviderRescan { .. })) => {}
                  Ok(None) | Err(_) => break,
              }
          }
          seen
      }

      /// The one-fd-per-provider restructure's behavioral contract: one shared
      /// `RecommendedWatcher` can arm SEVERAL paths; unwatching one path must
      /// not disturb the others; unwatch of a never-armed path is tolerated.
      ///
      /// Events are COLLECTED into a set under a deadline with set-membership
      /// assertions — never per-`recv` identity: one `std::fs::write` emits
      /// several notifications (commonly Create + Modify), so the recv after
      /// a second write can deliver the FIRST write's queued companion.
      #[tokio::test]
      async fn one_watcher_supports_many_targets_and_tolerated_unwatch() {
          let a = unique_temp_dir("onefd-a");
          let b = unique_temp_dir("onefd-b");
          std::fs::create_dir_all(&a).unwrap();
          std::fs::create_dir_all(&b).unwrap();

          let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
          let mut watcher =
              create_provider_watcher(&tx, "claude", false).expect("create shared watcher");
          watch_path(&mut watcher, "claude", &a, notify::RecursiveMode::NonRecursive).unwrap();
          watch_path(&mut watcher, "claude", &b, notify::RecursiveMode::NonRecursive).unwrap();

          // Both armed paths deliver events through the ONE watcher (early
          // exit once BOTH prefixes observed; companion events interleave with
          // the second write's, which is exactly why membership — not recv
          // order — is the assertion).
          std::fs::write(a.join("one.txt"), b"x").unwrap();
          std::fs::write(b.join("one.txt"), b"x").unwrap();
          let saw = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
              s.iter().any(|p| p.starts_with(&a)) && s.iter().any(|p| p.starts_with(&b))
          })
          .await;
          assert!(saw.iter().any(|p| p.starts_with(&a)), "events for a: {saw:?}");
          assert!(saw.iter().any(|p| p.starts_with(&b)), "events for b: {saw:?}");

          // Unwatch a (twice: the second proves the tolerated path), then
          // verify a's further writes produce nothing while b still delivers.
          // One fixed 700ms window collects every straggler, so the negative
          // assertion runs over the COMPLETE set.
          unwatch_tolerated(&mut watcher, "claude", &a);
          unwatch_tolerated(&mut watcher, "claude", &a); // tolerated no-op, no panic
          std::fs::write(a.join("two.txt"), b"x").unwrap();
          std::fs::write(b.join("two.txt"), b"x").unwrap();
          let after = collect_file_paths(&mut rx, Duration::from_millis(700), |_| false).await;
          assert!(
              after.iter().any(|p| p.starts_with(&b)),
              "b still delivers: {after:?}"
          );
          assert!(
              !after.iter().any(|p| p.starts_with(&a)),
              "no events from the unwatched path may arrive: {after:?}"
          );
          drop(watcher);
          std::fs::remove_dir_all(&a).ok();
          std::fs::remove_dir_all(&b).ok();
      }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL because `create_provider_watcher`, `watch_path`, and `unwatch_tolerated` do not exist on the current one-watcher-per-target `ArmedWatch` model (compile error, unresolved names — the new test's set-under-deadline assertions only add the helper; the red reason is unchanged).

- [ ] **Step 3: Add the minimal production implementation**
  Precise patch to `crates/freshell-sessions/src/session_watcher.rs`:

  1. Replace `struct ArmedWatch` (:52-58) with:

     ```rust
     /// One notify watcher per provider armed on many paths. Watch lifetimes
     /// are explicit (`watch_path`/`unwatch_tolerated`); dropping the loop's
     /// `ProviderWatch` drops every remaining watch with the watcher.
     struct ProviderWatch {
         watcher: notify::RecommendedWatcher,
         /// legacy-model bookkeeping parity with old `ArmedWatch`:
         targets: Vec<ArmedTarget>,
     }

     struct ArmedTarget {
         requested_base: PathBuf,
         actual_target: PathBuf,
     }
     ```

  2. Replace `arm_watcher` (:124-155) with the three helpers:

     ```rust
     /// Create THE provider's watcher. One watcher == one inotify fd per
     /// provider (PR #655's per-target model would mint ~4.4K watchers on the
     /// managed set — a `max_user_instances` (1024) violation).
     fn create_provider_watcher(
         tx: &mpsc::UnboundedSender<WatchEvent>,
         provider_name: &str,
         is_direct: bool,
     ) -> Option<notify::RecommendedWatcher> {
         let cb = make_watcher_callback(tx.clone(), provider_name.to_owned(), is_direct);
         match notify::recommended_watcher(cb) {
             Ok(watcher) => Some(watcher),
             Err(e) => {
                 tracing::warn!(
                     provider = %provider_name,
                     error = %e,
                     "session-watcher: failed to create watcher",
                 );
                 None
             }
         }
     }

     /// Arm one path on the provider's shared watcher. Errors propagate (the
     /// caller decides absent-vs-retry policy); failures are logged here.
     fn watch_path(
         watcher: &mut notify::RecommendedWatcher,
         provider_name: &str,
         target: &Path,
         mode: notify::RecursiveMode,
     ) -> Result<(), notify::Error> {
         if let Err(e) = watcher.watch(target, mode) {
             tracing::warn!(
                 provider = %provider_name,
                 path = %target.display(),
                 error = %e,
                 "session-watcher: failed to arm watch",
             );
             return Err(e);
         }
         Ok(())
     }

     /// Explicit unwatch. IN_IGNORED on delete means the kernel already
     /// dropped the watch, so WatchNotFound-class errors are tolerated at
     /// debug (design: "explicit unwatch tolerates WatchNotFound").
     fn unwatch_tolerated(
         watcher: &mut notify::RecommendedWatcher,
         provider_name: &str,
         target: &Path,
     ) {
         match watcher.unwatch(target) {
             Ok(()) => {}
             Err(e) if matches!(&e.kind, notify::ErrorKind::WatchNotFound) => {
                 tracing::debug!(
                     provider = %provider_name,
                     path = %target.display(),
                     "session-watcher: unwatch of already-dropped watch (tolerated)",
                 );
             }
             Err(e) => {
                 tracing::warn!(
                     provider = %provider_name,
                     path = %target.display(),
                     error = %e,
                     "session-watcher: unwatch failed",
                 );
             }
         }
     }
     ```

     (`use notify::Watcher;` is already imported at :19.)

  3. Extend `WatchEvent` (:38-44) and its producer/consumer plumbing (behavior-preserving):

     ```rust
     /// A coarse, provider-agnostic classification of one notify event. The
     /// amplifier managed engine (later tasks) consumes it; the legacy
     /// providers' flush ignores it. `CreateFolder` deliberately preserves the
     /// `CreateKind::Folder` distinction: depth-4+ routing (Task 5) drops a
     /// folder creation (`context-intelligence/` mkdir) while scoped-marking
     /// a file creation, and structural depths (Tasks 3-4) treat
     /// `CreateFolder` as create-ish because a mkdir IS a `Create(Folder)`
     /// under inotify. `Remove` deliberately does NOT carry the notify
     /// dir-vs-file tag: a directly-armed directory's self-delete surfaces as
     /// `Remove(File)`, NOT `Remove(Folder)` (the kernel does not set ISDIR
     /// on IN_DELETE_SELF — LB-01 probe), so remove routing by path depth
     /// must dispatch on the `Remove` kind WITHOUT filtering on the
     /// dir-vs-file tag.
     #[derive(Debug, Clone, Copy, PartialEq, Eq)]
     enum WatchKind {
         Create,
         CreateFolder,
         Remove,
         NameFrom,
         NameTo,
         NameBoth,
         Modify,
         Other,
     }

     fn kind_of(event: &notify::Event) -> WatchKind {
         use notify::event::{CreateKind, ModifyKind, RenameMode};
         match event.kind {
             notify::EventKind::Create(CreateKind::Folder) => WatchKind::CreateFolder,
             notify::EventKind::Create(_) => WatchKind::Create,
             notify::EventKind::Remove(_) => WatchKind::Remove,
             notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => WatchKind::NameFrom,
             notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => WatchKind::NameTo,
             notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => WatchKind::NameBoth,
             notify::EventKind::Modify(_) => WatchKind::Modify,
             _ => WatchKind::Other,
         }
     }

     enum WatchEvent {
         /// One notify event's full path set (one FileChanged message per
         /// notify event). Rename vocabulary as observed by the LB-01
         /// real-notify probe (notify 6.1.1, kernel 6.6.87.2-WSL2, ext4): an
         /// intra-`sessions/` rename emits THREE events sharing one tracker
         /// cookie — `Name(From)` with paths [from], `Name(To)` with paths
         /// [to], and `Name(Both)` carrying paths [from, to] — so a rename
         /// surfaces as three FileChanged messages and the dispatch handles
         /// both the From/To pair shape and the paired Both shape.
         FileChanged {
             paths: Vec<PathBuf>,
             kind: WatchKind,
             provider: String,
         },
         /// This provider needs a full re-discovery (direct-listed change,
         /// `need_rescan()` flag, or watcher error).
         ProviderRescan { provider: String },
     }
     ```

     `make_watcher_callback` (:86-120): the non-rescan branch now sends ONE `WatchEvent::FileChanged { paths: event.paths.clone(), kind: kind_of(&event), provider }` instead of one message per path. The recv arm (:287-297) fans paths back out into `pending.insert((path, provider), Instant::now())` per path — the coalescing semantics are identical (same keys, same stamp). Flush (:303-332) unchanged.

  4. Rework `run_watcher_loop` (:196-402): replace `let mut armed: Vec<ArmedWatch>` (:207) with `let mut watches: HashMap<usize, ProviderWatch> = HashMap::new();`. The initial arming loop (:213-264) creates the provider's watcher once (first successful arm creates the `ProviderWatch`; later bases of the same provider reuse it via `watches.entry(prov_idx).or_insert_with_key(...)` — if creation fails the base goes to `absent` exactly as today) and pushes `ArmedTarget { requested_base, actual_target }` instead of `ArmedWatch`. The rearm tick (:334-399) keeps the same two responsibilities: (a) sweep every target — `actual_target != requested_base && requested_base.exists()` OR `!actual_target.exists()` ⇒ `unwatch_tolerated` the OLD `actual_target`, remove the `ArmedTarget`, push `(prov_idx, requested_base)` to `absent`, `mark_provider_dirty`; (b) `absent.retain` re-arm on the precise base using the provider's EXISTING watcher via `watch_path` (creating the `ProviderWatch` first if the provider has none yet). Rename the flush branches' references accordingly. Absolute behavior parity is required: same info/warn log messages, same mark_provider_dirty call sites, same absent-rearm semantics.

  The debounce loop state (:270-283) and flush-to-index logic (:303-332) are NOT touched in this task.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS (the 10 existing tests are behavior-preserved; the new `one_watcher_supports_many_targets_and_tolerated_unwatch` passes).

- [ ] **Step 5: Refactor while green**
  Update the module doc comment (:1-12) which already claims "One `notify::RecommendedWatcher` per provider" to note that it is now *literal* (one fd per provider, multiple paths per watcher) rather than per-base. Remove the now-dead "Dropping an ArmedWatch drops the watcher" comment block (:205-206). No further abstraction: the struct exists only to hold the watcher + targets pair.

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: all of freshell-sessions (the watcher feeds every provider's index freshness; provider-agnostic behavior must not drift).
  Run: `cargo test -p freshell-sessions`
  Expected: PASS.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher.rs
  git commit -m "refactor(sessions): one inotify watcher per provider with explicit watch/unwatch"
  ```

---

### Task 3: Amplifier managed watch set — arm engine, stand-in swap, cascade, retry bookkeeping

**Files:**
- Modify: crates/freshell-sessions/src/session_watcher.rs (the amplifier engine; also the `#[cfg(test)] #[path]` test split)
- Create: crates/freshell-sessions/src/session_watcher_tests.rs (all tests — existing suite moved verbatim, plus the new ones)
- Modify: crates/freshell-sessions/src/directory_index.rs:1891 (`mod tests` → `pub(crate) mod tests` + the counting-double visibility seam below — Task 3's negative no-escalation test asserts on CountingWrapper call counters, i.e. OBSERVABLE WORK, because `subscribe_changes()`'s generation only bumps on CONTENT changes and cannot see an erroneous index-equivalent sweep)

**Interfaces:**
- Consumes: Task 1's `plan_amplifier_targets`, `is_watch_target`, `classify_basename`, `classify_arm_error` + `ArmErr`; Task 2's `create_provider_watcher`/`watch_path`/`unwatch_tolerated`, `WatchKind`, the enriched `WatchEvent`; `SessionIndex::mark_dirty`/`mark_provider_dirty` (`directory_index.rs:1000-1022`).
- Produces (module-private unless noted):
  - `struct ManagedBook`: amplifier watch-set bookkeeping —
    ```rust
    /// Bookkeeping for the amplifier managed watch set (design "Watch set" +
    /// "Absence/retry"). Owned by the watcher task; an Arc clone is held by
    /// SessionWatcher so tests can observe armed state without racing the loop.
    #[derive(Default)]
    struct ManagedBook {
        /// Every armed path (projects root, sessions dirs, stand-ins, root
        /// session dirs).
        armed: std::collections::HashSet<PathBuf>,
        /// Structural targets (the projects root chiefly) whose path is
        /// currently absent — re-checked by the rearm tick. Session dirs are
        /// never absence-tracked (design).
        absent: std::collections::HashSet<PathBuf>,
        /// Transient arm failures under bounded exponential backoff
        /// (retry_backoff doubling to its 60s cap, RETRY_CAP entries).
        retry: std::collections::HashMap<PathBuf, RetryEntry>,
        /// Count of replans performed (observability for the Task 6 test).
        replans: usize,
    }
    struct RetryEntry { failures: u32, next_attempt: std::time::Instant, kind: ArmKind }
    ```
  - `const RETRY_CAP: usize = 256;` `retry_backoff(failures: u32) -> Duration` (base 1s, doubling, cap 60s — computation expressed via a pure fn so tests assert the schedule without sleeping)
  - `ArmKind` is Task 1's `crate::watch_plan::ArmKind` (imported, not redefined): the planner owns the kind vocabulary; `RetryEntry.kind` retains the failed target's kind so the retry drain re-arms with the SAME behavior as first-line arming (never a flattened bare path). `ArmKind::SessionDir` arms classify the basename inside `arm_managed_dir` (Task 4's drift counter input, and debug logging everywhere).
  - The arm helpers are FREE FUNCTIONS, not `SessionWatcher` methods: the recv loop calls them with ITS watcher + locked book + a fresh `ArmOutcome`; tests drive the identical helpers DIRECTLY on a locally-constructed watcher (Task 2's `create_provider_watcher`) and a fresh `ManagedBook::default()` — no spawned loop needed for bookkeeping assertions. `ManagedBook` holds neither the `RecommendedWatcher` nor the provider context (both live inside the spawned loop), which is exactly why probes on `SessionWatcher` cannot drive a real arm.
  - `struct ArmOutcome { marks: Vec<PathBuf>, provider_dirty: bool }` (`#[derive(Default)]`) — the ONLY output channel of the arm helpers. `marks` are watch-then-scan scoped `metadata.json` paths (drained by the async caller into `index.mark_dirty` with provider `"amplifier"`); `provider_dirty = true` asks the caller for `index.mark_provider_dirty("amplifier")`. The helpers NEVER take `&Arc<SessionIndex>` and never touch the index: they are `spawn_blocking`-safe, which is what lets the bulk phases (startup apply, replan apply, retry-drain batch, absent-root-return cascade) run off the async worker and hand marks/routing back — index mutation ALWAYS happens on the async loop. (Design line 111: "explicit `watch()`/`unwatch()` calls; bulk operations in `spawn_blocking`".)
  - `fn arm_managed_dir(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, provider: &str, path: &Path, arm_kind: ArmKind, emit_marks: bool)` — the ONE arming site, KIND-AWARE so first-line, retry-drain, replan, and self-correction arms behave identically for the same target:
    - `ArmKind::ProjectsRoot`: `watch_path(NonRecursive)` + `book.armed` insert on success. On a DETERMINISTIC failure (the projects root was deleted between the plan scan and the arm): `book.absent.insert(path)` + `outcome.provider_dirty = true` + debug — the design's "only the provider root itself re-enters absence tracking when it disappears"; a scan-to-arm ENOENT race is NEVER silently dropped.
    - `ArmKind::SessionsDir`: `watch_path(NonRecursive)` + `book.armed` insert, then `cascade_session_children` immediately (the watch-then-scan union).
    - `ArmKind::Standin`: the full `arm_sessions_or_standin` body (stand-in arm + post-arm recheck swap + cascade).
    - `ArmKind::SessionDir`: `watch_path(NonRecursive)` + `book.armed` insert + scoped `metadata.json` mark into `outcome.marks` when `emit_marks` (file-state watch-then-scan).
    - Shared success clause: `book.retry.remove(path)` (a successful arm clears any stale retry entry). Shared failure clause for the non-root kinds: Deterministic → insert nowhere + debug (reappearance is a fresh structural create anyway) ONLY where a watched parent guarantees that reappearance signal — `Standin` (parent: the projects root) and `SessionDir` (parent: the sessions dir); a `SessionsDir`'s would-be parent (the project dir) is NOT watched in that corner (the plan listed a sessions dir, so no stand-in was armed), so a deterministic `SessionsDir` failure instead absent-tracks the sessions dir and arms the project dir as the stand-in (as-built correction, commit 3e41e683d; a re-created sessions/ then surfaces as the depth-2 create → swap); Transient → `retry.insert(path, RetryEntry { failures: 1, next_attempt: now + retry_backoff(1), kind })` retaining the kind (RETRY_CAP eviction logs a warn and drops).
  - `fn cascade_session_children(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, sessions_dir: &Path, emit_marks: bool)` — readdir a sessions dir, classify each child dir by basename, `arm_managed_dir(.., ArmKind::SessionDir, ..)` each watch target (the watch-then-scan invariant: `<sess>/metadata.json` pushed to `outcome.marks` when `emit_marks`, safe no-op if missing)
  - `fn arm_sessions_or_standin(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, project_dir: &Path, emit_marks: bool)` — design's stand-in rule incl. the post-arm re-check: if `<proj>/sessions` didn't exist before the arm but exists immediately after, unwatch the stand-in and arm the real sessions dir as `ArmKind::SessionsDir` (which cascades its children)
  - `fn cascade_new_project(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, project_dir: &Path, emit_marks: bool)` — `Create(<proj>)`/`CreateFolder(<proj>)` on the root watch: `arm_sessions_or_standin` (+ stray-file guard: skip non-dirs)
  - `fn apply_amplifier_startup_plan(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, projects_root: &Path, plan: PlanTargets)` — the startup half of the watch-then-scan invariant; the exact ordered pipeline is specified in Step 3. Always `emit_marks: false` at boot (the boot warm sweep covers file state — it runs only AFTER the startup arms land, gated by the watcher-ready barrier Task 9 wires into main.rs) — and `emit_marks: true` when Task 3's absent re-check re-applies it over a RETURNED root (the structural cascade then also scans so sessions created while the root was gone are visible immediately).
  - `SessionWatcher::amplifier_book_handle() -> Option<Arc<Mutex<ManagedBook>>>` — `#[cfg(test)]` accessor so tests assert armed/absent/retry without racing the loop
  - SessionWatcher-internal amplifier dispatch in `run_watcher_loop`'s recv arm: `provider == "amplifier"` routes FileChanged by depth computed as `path.strip_prefix(&projects_root).map(|r| r.components().count())` (depth 0 = the projects root's OWN self-event — its removal wiring is Task 4's; depth 1 = a project child of the root watch; depth 3 = a sessions-dir child; everything else falls through to the legacy pending map for now — Task 5 takes the rest). At structural depths the create-ish kinds are `Create | CreateFolder | NameTo | NameBoth` (a mkdir surfaces as `CreateFolder` — Task 2 keeps the `CreateKind::Folder` distinction).

- [ ] **Step 1: Write the failing behavioral test**
  Move `session_watcher.rs`'s `#[cfg(test)] mod tests { ... }` (:421-687) verbatim into the new `crates/freshell-sessions/src/session_watcher_tests.rs`, AND in the SAME EDIT replace the inline mod in `session_watcher.rs` with the `#[path]` declaration —
  ```rust
  #[cfg(test)]
  #[path = "session_watcher_tests.rs"]
  mod tests;
  ```
  (registration is part of the test edit, precedent `codex_locator.rs:725`, so the RED run compiles the moved/new tests into the tree) — then add these amplifier tests at the end:

  ```rust
  // ---------- amplifier managed watch set ----------

  /// Mirrors `amplifier.rs::tests::write_session` (private to that module —
  /// deliberate duplication per crate convention).
  fn write_amplifier_session(home: &Path, slug: &str, id: &str) -> PathBuf {
      let dir = home
          .join("projects")
          .join(slug)
          .join("sessions")
          .join(id);
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(
          dir.join("metadata.json"),
          format!(
              r#"{{"session_id":"{id}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"s","turn_count":1}}"#
          ),
      )
      .unwrap();
      dir
  }

  fn amplifier_index(home: &Path) -> Arc<SessionIndex> {
      Arc::new(SessionIndex::with_ttl_and_cache_path(
          vec![Arc::new(crate::amplifier::AmplifierSource::new(home.to_path_buf()))
              as Arc<dyn crate::directory_index::SessionSource>],
          Duration::from_secs(3600),
          None,
      ))
  }

  fn amplifier_watcher(
      index: &Arc<SessionIndex>,
      home: &Path,
  ) -> SessionWatcher {
      SessionWatcher::new(
          Arc::clone(index),
          vec![WatchedProvider {
              layout: Box::new(crate::provider_layout::AmplifierLayout),
              home: home.to_path_buf(),
          }],
      )
  }

  /// Amplifier index over a `CountingWrapper`, returning the source's call
  /// counters next to the index. Negative no-scan tests assert on these
  /// counters (OBSERVABLE WORK: an erroneous full/provider discover or
  /// scoped stat ALWAYS increments its counter) — never only on
  /// `subscribe_changes()`, whose generation bumps only when the published
  /// CONTENT changes, so an index-equivalent erroneous sweep would leave
  /// the receiver silent while the prohibited CPU work ran anyway. (Task 5
  /// grows the struct with `stat_scoped_calls` when the counted passthrough
  /// lands; only fields a test actually reads live here, or the clippy
  /// `-D warnings` gate would flag a dead one.)
  struct CountedAmplifierIndex {
      index: Arc<SessionIndex>,
      discover_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
  }

  fn counted_amplifier_index(home: &Path) -> CountedAmplifierIndex {
      let amplifier = crate::amplifier::AmplifierSource::new(home.to_path_buf());
      let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
      let (discover_calls, _parse_calls, _direct_list_calls) =
          crate::directory_index::tests::wrapper_counters(&wrapped);
      let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
          vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
          Duration::from_secs(3600),
          None,
      ));
      CountedAmplifierIndex {
          index,
          discover_calls,
      }
  }

  /// Regression 3 & the start of the watch-reduction proof: startup arms
  /// exactly {projects root, per-project sessions dir (or stand-in),
  /// root-named session dirs} — never a subagent dir, never a stray file.
  #[tokio::test]
  async fn amplifier_startup_arms_exactly_the_managed_set() {
      let home = unique_temp_dir("amp-startup");
      // Project named WITH underscore components (regression 3).
      let root_session = write_amplifier_session(&home, "my_proj_x", "012584be-9478-4801-a62d-4e5da428b3a0");
      write_amplifier_session(&home, "my_proj_x", "0000000000000000-014b6af1c2ac4ab5_agent");
      // Stand-in project (no sessions/ dir) and a stray file at project depth.
      std::fs::create_dir_all(home.join("projects").join("no_sessions_proj")).unwrap();
      std::fs::write(home.join("projects").join("repl_history"), b"x").unwrap();

      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().expect("amplifier book");
      let handle = watcher.start();
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              {
                  let b = book.lock().unwrap();
                  if b.armed.contains(&root_session) && !book_has_path_named(&b, "repl_history") {
                      break;
                  }
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("startup arming completes");

      let b = book.lock().unwrap();
      let armed = &b.armed;
      assert!(armed.contains(&home.join("projects")));
      assert!(armed.contains(&home.join("projects").join("my_proj_x").join("sessions")));
      assert!(armed.contains(&root_session));
      assert!(armed.contains(&home.join("projects").join("no_sessions_proj")));
      // Subagent dirs and stray files: never.
      assert!(!book_has_path_named(&b, "0000000000000000-014b6af1c2ac4ab5_agent"));
      assert!(!book_has_path_named(&b, "repl_history"));
      // Exact count: root + 1 sessions + 1 stand-in + 1 root session dir.
      assert_eq!(armed.len(), 4);
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  fn book_has_path_named(b: &ManagedBook, name: &str) -> bool {
      b.armed.iter().any(|p| p.ends_with(name))
  }

  /// Regression 17b: a deterministic arm failure (path missing by the time
  /// the arm runs) leaves the retry set immediately — a reappearance is a
  /// fresh structural create anyway.
  #[tokio::test]
  async fn deterministic_arm_failure_never_enters_retry_set() {
      let home = unique_temp_dir("amp-armerr");
      std::fs::create_dir_all(home.join("projects")).unwrap();

      // The arm helpers are free functions; drive them on a locally-
      // constructed shared watcher + a fresh book + a fresh mark sink — the
      // same helpers the spawned loop calls with ITS watcher/book/sink, but
      // with no loop and no inotify timing at all. (The dropped target here
      // is a SessionDir kind — for the root kind a deterministic failure
      // enters ABSENT instead; see Task 3's Interfaces and Task 4's root
      // lifecycle test.)
      let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
      let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
      let mut book = ManagedBook::default();
      let mut outcome = ArmOutcome::default();
      let ghost = home.join("projects").join("ghost");
      arm_managed_dir(
          &mut book,
          &mut watcher,
          &mut outcome,
          "amplifier",
          &ghost,
          crate::watch_plan::ArmKind::SessionDir,
          false,
      );

      assert!(book.retry.is_empty(), "deterministic failures never retry");
      assert!(!book.armed.contains(&ghost));
      drop(watcher);
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 7 (check→arm window): the stand-in arm IMMEDIATELY re-checks
  /// for sessions/ and swaps when it has appeared in the window.
  #[tokio::test]
  async fn arm_sessions_or_standin_rechecks_sessions_after_arming() {
      let home = unique_temp_dir("amp-toctou");
      let proj = home.join("projects").join("proj");
      std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet
      let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
      let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
      let mut book = ManagedBook::default();
      let mut outcome = ArmOutcome::default();

      // Phase 1: drive the project arm with NO sessions/ — a stand-in arms.
      arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
      assert!(book.armed.contains(&proj));
      assert!(!book.armed.contains(&proj.join("sessions")));

      // Phase 2: sessions/ appears; the armed stand-in must swap to the real
      // sessions dir (the swap path `arm_sessions_or_standin` re-checks after
      // arming AND serves as the recheck on repeat arms), cascading the
      // session child.
      let session = write_amplifier_session(&home, "proj", "012584be-9478-4801-a62d-4e5da428b3a0");
      arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
      assert!(book.armed.contains(&proj.join("sessions")), "sessions/ armed");
      assert!(!book.armed.contains(&proj), "stale stand-in removed: {:?}", book.armed);
      assert!(
          book.armed.contains(&session),
          "the post-arm recheck cascades session children"
      );
      drop(watcher);
      std::fs::remove_dir_all(&home).ok();
  }

  /// Startup race regression (watch-then-scan applied AT STARTUP): a root
  /// session dir created AFTER the initial plan scan but BEFORE the
  /// structural arms is nevertheless armed — the post-arm readdir union, not
  /// the stale scan, decides session-dir arms. Driven deterministically by
  /// splitting startup into the same ordered steps the production loop runs
  /// and creating the dir at the window; no sleeps, no spawned loop.
  #[tokio::test]
  async fn startup_arms_session_dirs_created_in_the_scan_arm_window() {
      let home = unique_temp_dir("amp-startup-race");
      let pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let _ = pre; // one pre-existing session (present in the initial scan)
      let index = amplifier_index(&home);
      let projects_root = home.join("projects");

      // Step A of production startup: the initial plan scan.
      let plan = crate::watch_plan::plan_amplifier_targets(&projects_root).unwrap();
      // THE WINDOW: the dir appears after the scan, before the arms (in
      // production the loop calls apply_amplifier_startup_plan immediately
      // after the plan, in the same order, just wrapped in spawn_blocking).
      let windowed = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
      // Step B: the structural arms + post-arm rescans (in production this
      // whole step runs inside `spawn_blocking` with the arm outcome handed
      // back to the async loop; here the sync core is driven directly).
      let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
      let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
      let mut book = ManagedBook::default();
      let mut outcome = ArmOutcome::default();
      apply_amplifier_startup_plan(&mut book, &mut watcher, &mut outcome, &projects_root, plan);

      assert!(
          book.armed.contains(&windowed),
          "created between scan and arm ⇒ caught by the post-arm rescan: {:?}",
          book.armed
      );

      // The arm is LIVE: a sidecar write surfaces through the armed watch.
      std::fs::write(windowed.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
      let seen = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
          s.iter().any(|p| p.starts_with(&windowed))
      })
      .await;
      assert!(
          seen.iter().any(|p| p.starts_with(&windowed)),
          "events flow through the window-armed watch: {seen:?}"
      );

      // …and visible in the index once the boot discover runs (startup arms
      // skip file marks by design; the discover covers initial state).
      let snap = index.snapshot().await;
      assert!(
          snap.iter().any(|s| s.provider == "amplifier"
              && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
          "window-created session is visible at the first snapshot"
      );
      drop(watcher);
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 7 (event path): a `sessions/` dir created under a stand-in
  /// project is observed — the stand-in swaps to the real sessions watch, and
  /// existing session dirs under it are armed and scanned.
  #[tokio::test]
  async fn sessions_dir_created_after_standin_arm_is_picked_up() {
      let home = unique_temp_dir("amp-standin-swap");
      let proj = home.join("projects").join("late_proj");
      std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet

      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;

      // Stand-in armed.
      assert!(book.lock().unwrap().armed.contains(&proj));

      // sessions/ + a root session appear while only the stand-in is armed.
      let session = write_amplifier_session(&home, "late_proj", "550e8400-e29b-41d4-a716-4466554400aa");
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().armed.contains(&session) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("stand-in swap observed events and armed the session dir");
      // The stand-in itself is gone; the sessions dir is armed.
      {
          let b = book.lock().unwrap();
          assert!(b.armed.contains(&proj.join("sessions")));
          assert!(!b.armed.contains(&proj));
      }
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// New-project cascade: `create_dir_all(proj/sessions/<id>)` surfaces ONE
  /// `Create(<proj>)` at the root; the cascade arms sessions + root session
  /// and the watch-then-scan marks metadata.json (the row appears).
  #[tokio::test]
  async fn new_project_cascade_arms_and_scans() {
      let home = unique_temp_dir("amp-cascade");
      std::fs::create_dir_all(home.join("projects")).unwrap();
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;

      let session = write_amplifier_session(&home, "brand_new", "550e8400-e29b-41d4-a716-4466554400bb");

      tokio::time::timeout(Duration::from_secs(5), rx.changed())
          .await
          .expect("cascade's watch-then-scan mark refreshes the index")
          .unwrap();

      assert!(book.lock().unwrap().armed.contains(&session));
      let snap = index.snapshot().await;
      assert!(
          snap.iter().any(|s| s.provider == "amplifier"
              && s.session_id == "550e8400-e29b-41d4-a716-4466554400bb"),
          "the cascade's scoped mark made the new session visible immediately"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 14 (first half): with no subagent interest, a subagent-named
  /// mkdir under a watched sessions dir is dropped silently (no provider
  /// dirty, no arm) — the 15-minute reconcile owns it. The negative phase pins
  /// OBSERVABLE WORK (`discover_calls`), not just the generation wait: an
  /// erroneous escalation runs a full amplifier discover whose identical
  /// content would NOT bump the generation, so a `subscribe_changes()` timeout
  /// alone is vacuous for the prohibited CPU work.
  #[tokio::test]
  async fn subagent_mkdir_dropped_when_no_interest_escalates_when_interested() {
      use std::sync::atomic::{AtomicUsize, Ordering};
      let home = unique_temp_dir("amp-subgate");
      let root_session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let _ = root_session;
      let counted = counted_amplifier_index(&home);
      let index = counted.index.clone();
      let interest = Arc::new(AtomicUsize::new(0));
      let mut watcher = amplifier_watcher(&index, &home).with_subagent_interest(Arc::clone(&interest));
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);

      // Off: subagent dir creation is ignored — no index traffic AND no
      // discover sweep ran at all (the 700ms window covers the 200ms
      // debounce flush and the fire-and-forget background refresh).
      let sub = home
          .join("projects")
          .join("p")
          .join("sessions")
          .join("0000000000000000-014b6af1c2ac4ab5_new");
      std::fs::create_dir_all(&sub).unwrap();
      assert!(
          tokio::time::timeout(Duration::from_millis(700), rx.changed()).await.is_err(),
          "no-interest subagent mkdir must not refresh the index"
      );
      assert_eq!(
          counted.discover_calls.load(Ordering::SeqCst),
          baseline_discovers,
          "an erroneous escalation would have run a discover (observable work)"
      );
      assert!(!book.lock().unwrap().armed.contains(&sub));

      // On: provider dirty — a full amplifier discover picks the row up
      // (observable: both the generation bump AND the discover counter).
      interest.store(1, Ordering::SeqCst);
      std::fs::write(
          sub.join("metadata.json"),
          r#"{"session_id":"s","working_dir":"/p/x","parent_id":"par","created":"2026-03-01T00:00:00.000Z"}"#,
      )
      .unwrap();
      let sub2 = sub.parent().unwrap().join("0000000000000000-014b6af1c2ac4ab5_second");
      std::fs::create_dir_all(&sub2).unwrap();
      tokio::time::timeout(Duration::from_secs(5), rx.changed())
          .await
          .expect("interested subagent mkdir escalates to provider dirty")
          .unwrap();
      assert!(
          counted.discover_calls.load(Ordering::SeqCst) > baseline_discovers,
          "the interested escalation ran a real discover"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Retry lifecycle (design "Absence/retry"): a transient arm failure lands
  /// in `retry`; the rearm tick's drain re-attempts it once `next_attempt`
  /// arrives — a STILL-failing attempt re-enters with doubled backoff, and
  /// once the dir's access is restored the drain arms it. One transient
  /// failure must never suppress the watch indefinitely. Uses the crate's
  /// established `with_rearm_interval` short-interval seam so the REAL loop's
  /// tick drives the drain.
  #[cfg(unix)]
  #[tokio::test]
  async fn transient_arm_failure_is_retried_by_the_rearm_drain_and_eventually_arms() {
      use std::os::unix::fs::PermissionsExt;
      let home = unique_temp_dir("amp-retry");
      let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);

      // Make the session dir unwatchable: inotify_add_watch needs read
      // permission, so watch() fails EACCES (Transient ⇒ retry, never absent).
      std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o000)).unwrap();
      if std::fs::read_dir(&victim).is_ok() {
          eprintln!("skipping retry-drain assertions: euid can list a 0o000 dir");
          std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
          std::fs::remove_dir_all(&home).ok();
          return;
      }

      let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1); // 1s tick
      let book = watcher.amplifier_book_handle().unwrap();
      let handle = watcher.start();

      // Phase 1: the startup arm fails transiently and the entry sits in
      // `retry` (startup arms run inside the loop; no tick wait needed).
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().retry.contains_key(&victim) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("transient arm failure lands in retry");
      let failures_at_insert = book.lock().unwrap().retry[&victim].failures;

      // Phase 2: a re-attempt while access is STILL denied re-enters with an
      // incremented failure count (backoff doubled). Force due immediacy via
      // the book handle so the 1s tick processes it at once.
      book.lock().unwrap().retry.get_mut(&victim).unwrap().next_attempt =
          std::time::Instant::now() - Duration::from_secs(1);
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              let grown = {
                  let b = book.lock().unwrap();
                  !b.armed.contains(&victim)
                      && b.retry.get(&victim).is_some_and(|e| e.failures > failures_at_insert)
              };
              if grown {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("failed re-attempt re-enters retry with doubled backoff");

      // Phase 3: restore access and force due again — the drain re-arms the
      // dir and clears the retry entry, with no new filesystem event.
      std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
      book.lock().unwrap().retry.get_mut(&victim).unwrap().next_attempt =
          std::time::Instant::now() - Duration::from_secs(1);
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              {
                  let b = book.lock().unwrap();
                  if b.armed.contains(&victim) && !b.retry.contains_key(&victim) {
                      break;
                  }
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("retry drain eventually arms the restored dir");

      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Absence lifecycle, startup half (design: the provider root is the ONLY
  /// target that re-enters absence tracking): root missing at startup →
  /// absent; once it appears, the rearm tick re-arms it AND runs the full
  /// structural cascade (plan + apply, `emit_marks: true`), so sessions
  /// created while it was absent are armed AND scanned first-line — no
  /// reconcile wait. Uses the established `with_rearm_interval` idiom. (The
  /// deletion half — armed root → depth-0 removal routing → absent — is
  /// Task 4's `deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return`.)
  #[tokio::test]
  async fn absent_projects_root_at_startup_rearms_with_full_cascade_on_return() {
      let home = unique_temp_dir("amp-absent-boot");
      std::fs::create_dir_all(&home).unwrap(); // no projects/ yet
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      let projects = home.join("projects");
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().absent.contains(&projects) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("root missing at startup enters absent tracking");

      // The root appears — WITH a session created underneath it while absent,
      // so only the cascade (not any in-flight event) can see it.
      let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      tokio::time::timeout(Duration::from_secs(8), rx.changed())
          .await
          .expect("the return cascade's marks refresh the index (1s rearm tick)")
          .unwrap();
      {
          let b = book.lock().unwrap();
          assert!(b.armed.contains(&projects), "returned root re-armed");
          assert!(b.armed.contains(&projects.join("p").join("sessions")));
          assert!(b.armed.contains(&session), "cascade armed the session dir");
          assert!(!b.absent.contains(&projects));
      }
      let snap = index.snapshot().await;
      assert!(
          snap.iter().any(|s| s.provider == "amplifier"
              && s.session_id == "012584be-9478-4801-a62d-4e5da428b3a0"),
          "visible first-line — never deferred to the 15-minute reconcile"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// The retry schedule is bounded exponential: 1, 2, 4, … 60s cap, no
  /// overflow — asserted against the pure fn without sleeping.
  #[test]
  fn retry_backoff_doubles_to_a_sixty_second_cap() {
      assert_eq!(retry_backoff(0), Duration::from_secs(1));
      assert_eq!(retry_backoff(1), Duration::from_secs(2));
      assert_eq!(retry_backoff(2), Duration::from_secs(4));
      assert_eq!(retry_backoff(4), Duration::from_secs(16));
      assert_eq!(retry_backoff(6), Duration::from_secs(60), "hits the cap");
      assert_eq!(retry_backoff(7), Duration::from_secs(60), "capped");
      assert_eq!(retry_backoff(100), Duration::from_secs(60), "no overflow");
  }
  ```

  Import note for the moved test file: the `#[path]` directive makes this file the `session_watcher::tests` module, so its header is exactly the current test module's two imports, verbatim:
  ```rust
  use super::*;
  use crate::directory_index::{ClaudeSource, SessionIndex, SessionSource};
  ```
  plus `use std::sync::Arc;` (the new amplifier helpers use `Arc::new`/`Arc::clone` unqualified; the current tests don't import it). NO `use crate::amplifier;` — every amplifier reference in the tests stays fully qualified (`crate::amplifier::AmplifierSource`), so that import would be dead weight and the `cargo clippy --workspace --all-targets -- -D warnings` gate would reject it.

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL because `ManagedBook` (`#[derive(Default)]`), `ArmOutcome`, `amplifier_book_handle`, `with_subagent_interest`, the arm helpers (`arm_managed_dir`, `arm_sessions_or_standin`, `cascade_session_children`, `cascade_new_project`), `apply_amplifier_startup_plan`, and `retry_backoff` do not exist, and `crate::directory_index::tests` is still private (E0603 for the `CountingWrapper`/`wrapper_counters` references in `counted_amplifier_index`) — unresolved names in the compiled test module (the `#[path]` registration landed with the test file in Step 1, so the red compile failure is inside the tree, not a zero-tests-matched pass), and not because of a syntax or fixture accident. (`ArmKind` itself already exists — Task 1 landed it in `crate::watch_plan`.)

- [ ] **Step 3: Add the minimal production implementation**
  1. The test split already landed in Step 1: the inline `#[cfg(test)] mod tests {…}` in `session_watcher.rs` was replaced by the `#[path = "session_watcher_tests.rs"] mod tests;` declaration as part of the test edit (precedent: `codex_locator.rs:725`; keeps `session_watcher.rs` under the ~1K-line guidance). Nothing further here.
  2. Add the amplifier engine to `session_watcher.rs`:

     ```rust
     /// Exponential backoff schedule for transient arm failures: 1,2,4,…,60s,
     /// expressed as a pure fn so tests pin the schedule without sleeping.
     fn retry_backoff(failures: u32) -> Duration {
         let step = 2u64.checked_pow(failures.min(6)).unwrap_or(64);
         Duration::from_secs(step.min(60))
     }
     ```
      Plus `ManagedBook`, `ArmOutcome`, the free arm helpers (`arm_managed_dir`,
      `cascade_session_children`, `arm_sessions_or_standin`,
      `cascade_new_project`), and `apply_amplifier_startup_plan` per the
      Interfaces section (`ArmKind` comes from `crate::watch_plan` — Task 1
      owns it). Key semantics, verbatim:
      - **Startup arm (Task-2 `watches` map) — the watch-then-scan invariant
        applied AT STARTUP (design lines 44-51), with the WHOLE batch inside
        `spawn_blocking` (design line 111: "explicit `watch()`/`unwatch()`
        calls; bulk operations in `spawn_blocking`"):** for the provider with
        `layout.name() == "amplifier"`, replace the generic watch_bases arming
        entirely: create the provider watcher on the async side, then run ONE
        `tokio::task::spawn_blocking` closure covering the ENTIRE startup
        batch — `crate::watch_plan::plan_amplifier_targets(&projects_root)` AND
        `apply_amplifier_startup_plan` (the root arm, the structural arms, the
        post-arm rescans/cascades: every `watch()`/`unwatch()` syscall and
        every readdir). The closure owns the freshly-created
        `RecommendedWatcher` (it is `Send`; move it in and return it out) and
        locks the book (`Arc<Mutex<ManagedBook>>` clone) for the apply; the
        thousands of blocking syscalls therefore never stall the async worker
        running the watch loop. The helpers feed an `ArmOutcome` sink (never
        the index — see Interfaces); the closure returns the watcher plus the
        outcome, and the async side then inserts the watcher into the Task-2
        `watches` map and drains the outcome (`provider_dirty` →
        `index.mark_provider_dirty("amplifier")`; `marks` is empty at boot —
        `emit_marks: false`). `apply_amplifier_startup_plan` itself runs this
        exact ordered pipeline:
        1. Arm the projects root FIRST (NonRecursive, `ArmKind::ProjectsRoot`).
           A deterministic failure here (the root was deleted between the
           plan scan and the arm) does NOT fall into the shared
           deterministic-drop clause: the root enters `book.absent` +
           `outcome.provider_dirty = true` (the design's "only the provider
           root itself re-enters absence tracking when it disappears" — the
           scan-to-arm ENOENT race is never silently dropped).
        2. Arm every plan-listed STRUCTURAL target kind-correctly: each
           `sessions_dirs` entry via `arm_managed_dir(.., ArmKind::SessionsDir,
           ..)` and each `standins` entry via `ArmKind::Standin` —
           kind-correct means each arm does its own cascade/swap inline
           (Interfaces).
        3. Post-arm rescan — the union step, the invariant's core: every
           session-dir arm comes from a readdir taken AFTER its parent watch
           is live, never from the initial scan's possibly-stale listing:
           (a) readdir the ARMED projects root and `cascade_new_project` every
               project dir the plan did not cover (a project created between
               the initial scan and the root arm) — its cascade arms +
               post-arm-readdir's its sessions dir;
           (b) `cascade_session_children` on every ARMED sessions dir —
               re-finds the initial scan's session dirs AND catches any dir
               created between the initial scan and that dir's arm. (The
               step-2 kind-aware arms already cascade; 3(b) re-runs the same
               idempotent helper as the explicit union re-pass — double
               discovery is a bookkeeping no-op and the invariant statement
               stays unconditional.)
           Anything present in EITHER the initial scan OR a post-arm rescan
           is armed; events observed during arming are queued on the watcher's
           channel and processed normally by the recv arm (every arm helper
           is bookkeeping-idempotent, so double-discovery is a no-op).
        The race this closes: before the root arm, creations are re-found by
        step 3(a); after it, they are Create/CreateFolder events; likewise per
        sessions dir via 3(b) — the scan-before-watch window (a session dir
        created between the scan and its parent's arm producing no event and
        appearing in no scan) cannot lose a root session's freshness, which
        the hard zero-latency requirement demands. ("Arm order root-first"
        alone never closed this: the scan itself was stale.)
        ONLY the file-state stream stays skipped at startup: `emit_marks:
        false` threads through the whole pass (the boot warm sweep covers
        initial file state — and it is ORDERED after this pass by the
        watcher-ready barrier Task 9 wires into main.rs, so "the discover
        that follows" is deterministic) — the structural stream (arms +
        rescans) is NOT skipped. No marks for startup arms beyond the case
        below.
        On a missing root (`!plan.root_exists`): `book.absent.insert(projects_root)` +
        `outcome.provider_dirty = true` (same resilience contract as
        the generic late-root path — the drained provider-dirty covers the
        old `index.mark_provider_dirty` call). On a planner `Err` (transient
        read failure at ANY depth — the planner is strict-everywhere): same
        branch (absent + provider dirty) — startup has nothing to tear down,
        the rearm tick retries, and the data plane recovers through
        discover's own root-listing-failure protection; a planner error must
        never block or delay the Task 9 readiness signal, which fires after
        every provider's startup application SETTLES, success or failure.
        Absence-track via `book.absent`, re-checked at the rearm tick (add an
        amplifier-specific branch there — the same branch that drains `retry`,
        see below). The re-check is the design's return semantics, in full:
        when the ABSENT projects root exists again, the branch runs the WHOLE
        recovery inside `spawn_blocking` (same hand-back shape as startup):
        `plan_amplifier_targets` + `apply_amplifier_startup_plan` with
        `emit_marks: TRUE` — the watch-then-scan rescan equivalent (readdir →
        arm/swap every child) — so sessions created while the root was gone
        are armed AND scoped-marked first-line, never deferred to the
        15-minute reconcile; the root leaves `absent` only on a successful
        re-arm. Non-root absent entries (a stand-in or sessions dir present
        again) re-arm kind-correctly with `emit_marks: true`.
      - **Absence/retry hygiene (design lines 84-102):** only structural
        targets (root, stand-ins, sessions dirs) use `book.absent`. Deleted
        session dirs are forgotten outright (kernel dropped the watch — see
        Task 4). Transient arm failures land in `retry` as
        `RetryEntry { failures: 1, next_attempt: now + retry_backoff(1), kind }`
        — the entry RETAINS the target's `ArmKind`, so re-arming is
        behavior-identical to first-line arming (a `SessionsDir` retry
        cascades its children; a `Standin` retry performs the swap; a
        `SessionDir` retry does the watch-then-scan scoped file-state mark);
        RETRY_CAP eviction logs a warn and drops (latency-only degradation;
        the 15-minute reconcile owns it). Deterministic
        (`ArmErr::Deterministic`) failures insert nothing for the non-root
        kinds; for `ArmKind::ProjectsRoot` they route to `book.absent` +
        provider dirty (per the startup bullet — the scan-to-arm ENOENT race
        is never silently dropped, and the root is the only target that
        re-enters absence tracking).
        **Retry drain — the retry set is WORKED, not just accumulated:** the
        amplifier branch of the rearm tick (the same bounded periodic check
        that re-checks `book.absent`, paced by the established
        `with_rearm_interval` seam) runs the drain after the absent re-check:
        collect the retry keys AND their kinds whose `next_attempt <= now`
        FIRST (no mutation during iteration), then run the due re-arm batch
        inside `spawn_blocking` (same hand-back shape as startup: the batch of
        `arm_managed_dir(path, kind, …, emit_marks: true)` calls — watch()
        syscalls plus cascade readdirs — runs off the async worker; the
        outcome drains to the index afterwards). Success: the entry clears
        (a successful arm lands in `armed` with the watch-then-scan mark).
        A still-Transient re-failure re-enters
        `retry` with `failures += 1`, the SAME kind, and `next_attempt = now +
        retry_backoff(failures)` — doubled backoff, still bounded by the 60s
        cap and RETRY_CAP eviction. A now-Deterministic failure is dropped
        like a fresh one (`ProjectsRoot` kind: routed to absent instead).
        Replan (Task 6) and self-correction (Task 7) keep
        SKIPPING retry members — the drain is the only path that works them,
        and only when due (no backoff bypass anywhere).
      - **Dispatch (recv arm, amplifier provider only):** compute depth =
        components below the projects root via `amplifier_depth(path) ->
        Option<usize>` (`strip_prefix`; path == root ⇒ depth 0 — the root's
        own self-events, wired in Task 4). `watch_path` events are delivered
        per-event with Task 2's `WatchKind`; the create-ish set at structural
        depths is `Create | CreateFolder | NameTo | NameBoth` (a mkdir is a
        `CreateFolder`). Depth 1 create-ish on a directory →
        `cascade_new_project`. Depth 2 where the child is
        `..sessions` under a stand-in (create-ish) → swap to sessions arm
        (unwatch stand-in + arm `ArmKind::SessionsDir`, which cascades).
        Depth 3 create-ish: classify basename — watch target →
        `arm_managed_dir(.., ArmKind::SessionDir, ..)` + scoped mark;
        subagent → `pending_rescans` escalation ONLY when the interest counter
        is non-zero. All other events: legacy pending-map flow (Task 5 takes
        over). Every dispatch call site passes `emit_marks: true` (runtime
        events must scan what they arm; only startup skips marks) and uses a
        fresh `ArmOutcome`, draining it immediately afterwards on the async
        loop: `marks` → `index.mark_dirty` as `(path, "amplifier")` pairs, a set
        `provider_dirty` → `index.mark_provider_dirty("amplifier")`. The
        per-event dispatch path STAYS on the async loop (single events are
        not bulk work; design line 111's `spawn_blocking` rule is for the
        batch phases only).
     - **Interest counter:** `SessionWatcher` gains a
       ```rust
       /// Connected subagent interest (WS clients with the toggle on). The
       /// count handle is shared from freshell-ws' SubagentInterestRegistry;
       /// the subagent-mkdir escalation consults it (>0 = escalate).
       pub fn with_subagent_interest(mut self, interested: Arc<std::sync::atomic::AtomicUsize>) -> Self
       ```
       (default `Arc::new(AtomicUsize::new(0))` — production wires Task 9;
       a `#[cfg(test)]` variant setter is unnecessary because the builder is
       the injection point).
     - **Test-only probe (the seam Task 3 owns):**
       ```rust
       #[cfg(test)]
       pub(crate) fn amplifier_book_handle(&self) -> Option<Arc<std::sync::Mutex<ManagedBook>>>
       ```
       `SessionWatcher::new` creates `amplifier_book: Option<Arc<Mutex<ManagedBook>>>`
       (Some iff a provider with `layout.name() == "amplifier"` is configured),
       `start()` clones the Arc into `run_watcher_loop`, and the
       `#[cfg(test)]` accessor returns a clone, so started-loop tests assert
       armed/absent/retry without racing the loop. There are deliberately NO
       `test_arm_*_for_probe` methods on `SessionWatcher`: `ManagedBook`
       contains neither the `RecommendedWatcher` nor the provider context
       (both are owned inside the spawned loop, and `start()` drains the
       providers), so a probe on `SessionWatcher` cannot drive a real arm.
       Bookkeeping tests instead call the arm helpers DIRECTLY — they are
       free functions taking `&mut RecommendedWatcher` + `&mut ManagedBook` +
       context — on a locally-constructed watcher (Task 2's
       `create_provider_watcher` + `mpsc::unbounded_channel`) and a fresh
       `ManagedBook::default()`: the identical code path the loop uses, with
       no spawned loop and no inotify timing. The loop holds the book behind
       the Arc<Mutex<>>; its calls lock the guard and pass `&mut *guard`.
   3. `run_watcher_loop` signature gains the amplifier context: `{ Optional projects_root per provider; book Arc; interest counter }` — passed from `SessionWatcher::start`. Claude/codex/opencode take the Task-2 legacy path unchanged.
   4. `directory_index.rs`: the counting-double seam for this task's negative no-escalation test (behavioural no-op): `mod tests` (:1891) becomes `pub(crate) mod tests`; `CountingWrapper` and its `new` constructor become pub(crate) (`CountingSource` stays private; counters are read only through the accessor); the test module gains
      ```rust
      pub(crate) fn wrapper_counters<S: SessionSource>(
          w: &CountingWrapper<S>,
      ) -> (Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>)
      ```
      returning `(discover_calls, parse_calls, direct_list_calls)` clones. (Task 5 later adds the counted `stat_scoped` passthrough and a 4th counter to this accessor.)

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS — the moved pre-existing tests, plus the 10 new amplifier tests.

- [ ] **Step 5: Refactor while green**
  Check the module header comment (:1-12): update the architecture bullets to describe the managed watch set for amplifier (one fd per provider; amplifier arms a managed set vs. recursive). Verify `session_watcher.rs` stays under ~1000 lines of production code after the split. No further refactor: the engine is the smallest complete form of the design's watch-set semantics.

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: all of freshell-sessions (watcher+cascade; amplifier discover path in amplifier.rs shares concepts) plus a freshell-server build check (main.rs constructs `SessionWatcher`; `new` is unchanged but stop on compile errors early).
  Run: `cargo test -p freshell-sessions && cargo check -p freshell-server`
  Expected: PASS / clean.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs crates/freshell-sessions/src/directory_index.rs
  git commit -m "feat(sessions): amplifier managed watch set — plan/arm/cascade with stand-in and backoff retry"
  ```

---

### Task 4: Structural remove/rename lifecycle + resource alarms (25% watch budget, unknown-format drift)

**Files:**
- Modify: crates/freshell-sessions/src/session_watcher.rs (amplifier dispatch grows depth-0/Remove/MovedFrom/MovedTo handling; ManagedBook grows remove bookkeeping + `budget_warned`; alarm helpers incl. the edge-triggered budget check)
- Test: crates/freshell-sessions/src/session_watcher_tests.rs

**Interfaces:**
- Consumes: Task 3's `ManagedBook`, amplifier dispatch, `unwatch_tolerated`, `cascade_new_project`; the depth-routing helper.
- Produces:
  - `fn amplifier_teardown_project(book, watcher, index, project_dir)` — drops the whole subtree from `armed`/`absent`/`retry` (design lines 88: "Structural removes clean up the whole subtree's bookkeeping": on Remove/MovedFrom of `<proj>`, unwatch every armed path under it, drop absent/retry entries under it; disposable evaluation workspaces must not forever-retry) and enqueues a scoped prune mark per removed session dir
  - `fn amplifier_remove_session(book, watcher, index, session_dir)` — forget one session dir: explicit `unwatch_tolerated` (LB-01 sub-claim 3 nuance: in the managed-set shape — the same watcher owns the armed parent — notify auto-drops the old-path watch on MOVED_FROM, so unwatch of the moved path returns `WatchNotFound`, already tolerated; the explicit unwatch stays as belt-and-braces for the inode-follow case, which the probe's isolated-arm tier confirmed keeps reporting under the stale path) + bookkeeping cleanup + scoped metadata.json mark so the row prunes
  - `fn structural_remove(book, path)` — the shared absent/retry/armed cleanup for one removed path (and anything below it, by `starts_with` prefix)
  - MovedFrom / `Name(From)` handling at depths 0, 1, 2, 3: unwatch + forget (depth 0 = the ARMED projects root's own self-removal — see `amplifier_root_vanished` below; depth 1 = full project teardown; depth 3 = per-session-dir removal). IDEMPOTENT: renaming an ARMED child emits a 4th, UNTRACKED duplicate `Name(From)` after the paired trio (LB-01 probe on notify 6.1.1 — notify's mapping of the child watch's IN_MOVE_SELF), so re-processing a From for a path already removed from armed/absent/retry must be a clean no-op — `unwatch_tolerated` absorbs the already-auto-dropped watch (`WatchNotFound` at debug) and the bookkeeping remove hits nothing
  - MovedTo / `Name(To)` / `Name(Both)` at depths 1, 3: treated as creates routed into Task 3's cascade/arm helpers (a `mv`'d root session dir is re-armed first-line — regression 13)
  - `fn amplifier_root_vanished(book, watcher, projects_root)` — the DEPTH-0 self-removal of the armed projects root (LB-01: it surfaces tagless as `Remove(File)`/untracked `Name(From)`; nothing watches the root's parent, so depth-0 self-events are the ONLY way the watcher learns the root is gone — there is no depth-0 Create to route): `unwatch_tolerated` EVERY armed entry prefixed by the root FIRST (as-built correction, commit 0162c5b19 — the root's own watch is kernel-dropped via IN_IGNORED, but a MOVED root leaves its descendant watches live following their inodes under stale paths, so each must be explicitly released), then drop every armed/absent/retry entry prefixed by the root via `structural_remove` (the whole managed set is under it), `book.absent.insert(projects_root)` (the design's "only the provider root itself re-enters absence tracking when it disappears"). Pure bookkeeping like the other removal helpers; the dispatch issues the provider-dirty escalation on the async loop right after (mirroring depth 1). On the root's return, the late-root ancestor watch (armed from the absence, commit 99cbb489c) observes the creation and the deferred full return cascade (plan + kind-correct apply, marks on) re-arms the tree — commit 57082bc8e additionally closes the ancestor sync's check→arm windows so a root already standing at the sync is never left tick-owned; the rearm tick stays the safety net behind both, so delete-and-recreate always leaves a live watcher.
  - `fn write_remove_dispatch(...)`: depth-0 Remove/MovedFrom (path == the armed projects root) → `amplifier_root_vanished` + `mark_provider_dirty("amplifier")` (a provider discover reconciles the now-empty tree) — dispatched on the `Remove` kind WITHOUT the dir-vs-file tag (the root's IN_DELETE_SELF surfaces as `Remove(File)` — LB-01). depth-1 Remove/MovedFrom → `amplifier_teardown_project` + `mark_provider_dirty("amplifier")` (survivors' children are gone; a provider discover reconciles rows). depth-2 `Remove(sessions)` under an armed sessions-dir-less stand-in → nothing (already stand-in); under a real sessions watch → (a) unwatch EVERY armed subtree member (as-built correction, commit 0162c5b19 — same inode-follow hazard as depth 1/0: a MOVED sessions/ tree leaves its session-dir watches live under stale paths), (b) scoped-prune-mark each removed session dir's `metadata.json` so cached rows prune promptly, then (c) swap to stand-in. depth-3 Remove/MovedFrom of a session dir → `amplifier_remove_session` — dispatched on the `Remove` kind WITHOUT filtering on the notify dir-vs-file tag: a directly-armed session dir's self-delete surfaces as `Remove(File)`, not `Remove(Folder)` (the kernel does not set ISDIR on IN_DELETE_SELF — LB-01 probe), so no refactor may add a Folder-only gate.
  - `fn read_max_user_watches() -> Option<usize>` — parse `/proc/sys/fs/inotify/max_user_watches`; None on non-Linux/parse failure (WARN sites no-op)
  - `fn watch_budget_warn_needed(armed: usize, max_user_watches: usize) -> bool` — `armed > max / 4` (pure)
  - `fn watch_budget_edge(warned: bool, armed: usize, max_user_watches: usize) -> (bool, bool)` — (new `warned` state, emit-WARN-now) — PURE and EDGE-TRIGGERED: emits exactly once when the armed count CROSSES from ≤25% to >25% of the limit; while it stays >25% no further warn (no per-arm spam); when it falls back to ≤25% the edge RE-ARMS so the next crossing warns again. `ManagedBook` gains `budget_warned: bool` holding the edge state; `max_user_watches` is a parameter so tests inject the limit.
  - `fn check_watch_budget(book: &mut ManagedBook)` — reads `read_max_user_watches()` (None → no-op, edge state untouched) and applies `watch_budget_edge` against `book.budget_warned` + `book.armed.len()`, logging the WARN when the edge fires. Called after EVERY arm-batch application, because the armed set grows unboundedly at RUNTIME (the accepted ~31K/yr accrual) and a startup-only check would sleep through a runtime crossing: startup apply, the cascade arms of a structural-create dispatch (once per drained batch, not per arm), the retry-drain batch, the replan apply, and the absent-root-return cascade.
  - Startup log + alarm wiring: after the initial plan application, `tracing::info!(armed_count, …)`; then `check_watch_budget(&mut book)` (the first of its per-batch call sites list above).
  - `struct DailyCounter { day_stamp: u32, count: u32 }` + `fn note_unknown_arm(&mut self, now: SystemTime) -> Option<String>` — day-bucketed (UTC days since epoch via `now.duration_since(UNIX_EPOCH)/86400`); first arm of unknown format above `DRIFT_DAILY_WARN_THRESHOLD` (= 50/day; real corpus has 21 oddball arms at boot, so 50 is comfortably above steady-state but under a naming-drift flood of ~609/day) returns the WARN message to log; None otherwise
  - Drift alarm wiring: Task 3's `arm_managed_dir` classifies the basename on `ArmKind::SessionDir` arms → a `BasenameClass::Unknown` result increments the counter via the book's `DailyCounter` → `tracing::warn!` once per threshold-crossing day

- [ ] **Step 1: Write the failing behavioral test**
  Append to `crates/freshell-sessions/src/session_watcher_tests.rs`:

  ```rust
  // ---------- removes / renames / resource alarms ----------

  /// Regression 13: `mv` of a root session dir within the same sessions/ dir
  /// shows up as Name(Both) (or From+To); the new basename is re-armed
  /// first-line and its files keep producing events.
  #[tokio::test]
  async fn renamed_root_session_dir_is_rearmed_immediately() {
      let home = unique_temp_dir("amp-rename");
      let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      assert!(book.lock().unwrap().armed.contains(&old));

      let new = old.parent().unwrap().join("aa2584be-9478-4801-a62d-4e5da428b3a0");
      std::fs::rename(&old, &new).unwrap();

      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              {
                  let b = book.lock().unwrap();
                  if b.armed.contains(&new) && !b.armed.contains(&old) {
                      break;
                  }
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("renamed session dir re-armed first-line, old entry forgotten");

      // Keep proving the new watch is live: a transcript append refreshes
      // the index without a provider discover.
      std::fs::write(
          new.join("transcript.jsonl"),
          "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
      )
      .unwrap();
      let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
      assert!(changed.is_ok(), "events flow through the re-armed watch");
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// LB-01 probe (notify 6.1.1): renaming an ARMED session dir emits the
  /// tracked From/To/Both trio AND a 4th, UNTRACKED duplicate `Name(From)`
  /// on the old path (notify's mapping of the child watch's IN_MOVE_SELF),
  /// arriving after the trio. Structural-remove handling must be idempotent:
  /// the duplicate re-processes a path already removed from every
  /// bookkeeping set.
  #[tokio::test]
  async fn armed_child_rename_duplicate_name_from_is_idempotent() {
      let home = unique_temp_dir("amp-rename-idem");
      let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      assert!(book.lock().unwrap().armed.contains(&old));

      let new = old.parent().unwrap().join("aa2584be-9478-4801-a62d-4e5da428b3a0");
      std::fs::rename(&old, &new).unwrap();

      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              {
                  let b = book.lock().unwrap();
                  if b.armed.contains(&new) && !b.armed.contains(&old) {
                      break;
                  }
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("renamed dir re-armed under the new path, old forgotten");
      // Settle past the 4th, untracked duplicate Name(From) (it arrives
      // after the trio), then re-assert the settled bookkeeping.
      tokio::time::sleep(Duration::from_millis(300)).await;
      {
          let b = book.lock().unwrap();
          assert_eq!(
              b.armed.iter().filter(|p| **p == new).count(),
              1,
              "exactly one armed entry for the new path"
          );
          assert!(!b.armed.contains(&old), "duplicate From re-removal is a no-op");
          assert!(!b.absent.contains(&old) && !b.retry.contains_key(&old));
          // No double-WARN is structural on this path: re-processing the
          // duplicate From hits only the book-miss no-op and
          // `unwatch_tolerated`'s debug-tier tolerated arm (the managed-set
          // auto-drop makes unwatch of the moved path return WatchNotFound)
          // — no warn site is reachable, so there is no log to count.
      }

      // Events from the renamed dir keep flowing (the duplicate From did not
      // tear down the fresh arm).
      let _ = rx.borrow_and_update();
      std::fs::write(
          new.join("transcript.jsonl"),
          "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
      )
      .unwrap();
      let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
      assert!(changed.is_ok(), "events flow through the re-armed watch");
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 8 (first half): removing a watched session dir prunes its row
  /// promptly (scoped metadata.json mark → stat None → prune) and forgets all
  /// bookkeeping.
  #[tokio::test]
  async fn session_dir_removal_prunes_rows_and_forgets_bookkeeping() {
      let home = unique_temp_dir("amp-sessrm");
      let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let handle = watcher.start();
      let snap0 = index.snapshot().await;
      assert_eq!(snap0.iter().filter(|s| s.provider == "amplifier").count(), 1);
      tokio::time::sleep(Duration::from_millis(300)).await;

      std::fs::remove_dir_all(&victim).unwrap();

      let mut pruned = false;
      for _ in 0..50 {
          if index.snapshot().await.iter().filter(|s| s.provider == "amplifier").count() == 0
              && !book.lock().unwrap().armed.contains(&victim)
          {
              pruned = true;
              break;
          }
          tokio::time::sleep(Duration::from_millis(100)).await;
      }
      assert!(pruned, "row pruned AND watch bookkeeping forgotten");
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 16: structural removal of a whole project cleans armed/absent/
  /// retry bookkeeping (no forever-retrying entries after project deletion).
  #[tokio::test]
  async fn project_move_or_remove_cleans_all_bookkeeping() {
      let home = unique_temp_dir("amp-projrm");
      let proj = home.join("projects").join("doomed");
      let sess = write_amplifier_session(&home, "doomed", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      tokio::time::sleep(Duration::from_millis(300)).await;
      // Seed a retry entry under the project to prove cleanup reaches it.
      book.lock().unwrap().retry.insert(
          proj.join("should_never_exist"),
          RetryEntry {
              failures: 1,
              next_attempt: std::time::Instant::now(),
              kind: crate::watch_plan::ArmKind::SessionDir,
          },
      );
      assert!(book.lock().unwrap().armed.contains(&sess));

      std::fs::remove_dir_all(&proj).unwrap();

      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              {
                  let b = book.lock().unwrap();
                  let proj_prefix = proj.to_path_buf();
                  let clean = !b.armed.iter().any(|p| p.starts_with(&proj_prefix))
                      && !b.absent.iter().any(|p| p.starts_with(&proj_prefix))
                      && !b.retry.keys().any(|p| p.starts_with(&proj_prefix));
                  if clean {
                      break;
                  }
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("project subtree dropped from armed/absent/retry");
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 16 second clause: a session dir `mv`'d OUT of the watched
  /// tree is explicitly unwatched (inotify watches follow inodes — without
  /// this, events keep arriving under the stale old path forever).
  /// Caveat (LB-01 sub-claim 3 nuance): in the managed-set shape the parent
  /// arm's MOVED_FROM auto-drops the old-path watch, so the negative window
  /// below cannot catch a MISSING explicit-unwatch regression (post-move
  /// writes would be silent either way); the explicit unwatch stays as
  /// belt-and-braces for the unowned-parent (inode-follow) shape.
  #[tokio::test]
  async fn moved_away_session_dir_is_explicitly_unwatched() {
      let home = unique_temp_dir("amp-mvout");
      let sess = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      tokio::time::sleep(Duration::from_millis(300)).await;

      let outside = home.join("outside-escaped-session");
      std::fs::rename(&sess, &outside).unwrap();
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if !book.lock().unwrap().armed.iter().any(|p| p.ends_with("012584be-9478-4801-a62d-4e5da428b3a0")) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("moved-away dir forgotten");

      // Writing where the dir moved to must produce NO further index traffic
      // (the watch would still fire under the stale path if it leaked).
      let _ = rx.borrow_and_update(); // clear any pending
      std::fs::write(outside.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
      assert!(
          tokio::time::timeout(Duration::from_millis(700), rx.changed()).await.is_err(),
          "no events from an unwatched inode"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// 25% watch-budget WARN: pure verdict + real procfs probe.
  #[test]
  fn watch_budget_warn_needed_trips_only_above_a_quarter_of_the_limit() {
      assert!(!watch_budget_warn_needed(524_288 / 4, 524_288));
      assert!(watch_budget_warn_needed(524_288 / 4 + 1, 524_288));
      assert!(!watch_budget_warn_needed(2, 524_288));
      // Real machine (Linux/WSL always has procfs here): parser sanity.
      if std::path::Path::new("/proc/sys/fs/inotify/max_user_watches").exists() {
          let max = read_max_user_watches().expect("parse the kernel limit");
          assert!(max > 1_000);
      }
  }

  /// Drift alarm: daily-bucketed, warns once per day on crossing.
  #[test]
  fn unknown_format_drift_alarm_is_daily_bucketed() {
      let mut counter = DailyCounter::default();
      let day0 = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000u64);
      // Below the threshold: quiet.
      for _ in 0..DRIFT_DAILY_WARN_THRESHOLD - 1 {
          assert!(counter.note_unknown_arm(day0).is_none());
      }
      // Crossing: exactly one WARN.
      assert!(counter.note_unknown_arm(day0).is_some());
      assert!(counter.note_unknown_arm(day0).is_none(), "warn once per day");
      // Next day: fresh budget.
      let day1 = day0 + Duration::from_secs(86_400);
      assert!(counter.note_unknown_arm(day1).is_none());
  }

  /// Projects-root absence lifecycle (design: "Only the provider root itself
  /// re-enters absence tracking when it disappears"): deleting the ARMED
  /// projects root routes it from `armed` to `absent` via the DEPTH-0
  /// self-removal (the kernel surfaces it tagless — LB-01 `Remove(File)`),
  /// with the subtree's bookkeeping wiped; re-creating the root re-arms it
  /// at the rearm tick and the FULL structural cascade (plan + apply,
  /// `emit_marks: true`) arms sessions created while the root was absent —
  /// first-line, without waiting for the 15-minute reconcile.
  #[tokio::test]
  async fn deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return() {
      let home = unique_temp_dir("amp-rootabsent");
      let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let _ = session;
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      let projects = home.join("projects");
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().armed.contains(&projects) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("projects root armed at startup");

      // Delete the whole root: the depth-0 self-removal routes it to absent
      // and wipes the subtree bookkeeping.
      std::fs::remove_dir_all(&projects).unwrap();
      // The teardown's provider-dirty publish lands first (generation bump);
      // consume it so the later `changed()` await is the RETURN's publish.
      let _ = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              let gone = {
                  let b = book.lock().unwrap();
                  b.absent.contains(&projects)
                      && !b.armed.iter().any(|p| p.starts_with(&projects))
                      && !b.retry.keys().any(|p| p.starts_with(&projects))
              };
              if gone {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("deleted root enters absent; whole subtree forgotten");

      // Re-create the root WITH a session while it is tracked absent — this
      // session was created while NO watch covered it, so only the
      // absent → re-arm full cascade can pick it up first-line.
      let _ = rx.borrow_and_update();
      let returned = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
      tokio::time::timeout(Duration::from_secs(8), rx.changed())
          .await
          .expect("the return cascade's marks refresh the index promptly (1s rearm tick)")
          .unwrap();
      {
          let b = book.lock().unwrap();
          assert!(b.armed.contains(&projects), "returned root re-armed");
          assert!(b.armed.contains(&projects.join("p").join("sessions")));
          assert!(
              b.armed.contains(&returned),
              "session created during the absence armed by the cascade"
          );
          assert!(!b.absent.contains(&projects));
      }
      let snap = index.snapshot().await;
      assert!(
          snap.iter().any(|s| s.provider == "amplifier"
              && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
          "the returned session is visible without waiting for the reconcile"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// The 25% watch-budget WARN is edge-triggered and re-evaluated after
  /// EVERY arm batch (startup apply, cascade, retry drain, replan,
  /// absent-return), not only at startup: crossing ≤25% → >25% warns exactly
  /// once, staying above stays quiet, and falling back below re-arms the
  /// edge so the NEXT crossing warns again. The kernel limit is injected —
  /// no procfs dependency and no real 4.4K-arm corpus needed.
  #[test]
  fn watch_budget_warn_fires_once_per_crossing_and_rearms_below() {
      let max = 100usize; // injected max_user_watches (test-only injection)
      let mut warned = false;
      // Exactly 1/4 (25 of 100): NOT above the quarter — no warn.
      let (w, emit) = watch_budget_edge(warned, 25, max);
      assert!(!emit, "at exactly the quarter: silent");
      warned = w;
      // Cross above: the edge fires exactly once.
      let (w, emit) = watch_budget_edge(warned, 26, max);
      assert!(emit, "crossing above 25% warns");
      warned = w;
      // More arms while already warned: no per-arm spam.
      let (w, emit) = watch_budget_edge(warned, 40, max);
      assert!(!emit, "already warned: silent");
      warned = w;
      // Falling back below re-arms the edge silently...
      let (w, emit) = watch_budget_edge(warned, 20, max);
      assert!(!emit, "falling back below: silent");
      warned = w;
      // ...and the next crossing warns again.
      let (_, emit) = watch_budget_edge(warned, 27, max);
      assert!(emit, "re-armed edge warns on the next crossing");
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL because `amplifier_teardown_project`, `amplifier_remove_session`, `amplifier_root_vanished`, `watch_budget_warn_needed`, `watch_budget_edge`, `read_max_user_watches`, `DailyCounter`/`budget_warned`, and the MovedFrom/MovedTo dispatch do not exist (the nine new tests — including `armed_child_rename_duplicate_name_from_is_idempotent`, which hangs at its 5s re-arm timeout awaiting dispatch that does not exist yet, and `deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return`, which awaits a depth-0 removal routing that does not exist — hang past their timeouts or fail to compile; the pure `watch_budget_warn_fires_once_per_crossing_and_rearms_below` fails at compile on the missing `watch_budget_edge`).

- [ ] **Step 3: Add the minimal production implementation**
  In `session_watcher.rs`:
   1. Implement the lifecycle functions per Interfaces (`amplifier_teardown_project`, `amplifier_remove_session`, `amplifier_root_vanished`, `structural_remove`, and the MovedFrom/MovedTo dispatch). Dispatch stays inside the amplifier recv branch added in Task 3, extended: at depth 0 (path == the armed projects root) `WatchKind::Remove | WatchKind::NameFrom` → `amplifier_root_vanished` then `index.mark_provider_dirty("amplifier")` (the armed root's own tagless self-removal — its return is then observed via the late-root ancestor watch and applied by the deferred full return cascade, per commits 99cbb489c + 57082bc8e, with Task 3's absent re-check as the safety net); at depth 1 `WatchKind::Remove | WatchKind::NameFrom` → `amplifier_teardown_project` then `index.mark_provider_dirty("amplifier")`; at depth 2 the ONLY sessions-child removal under a real sessions dir → unwatch EVERY armed subtree member + scoped-prune-mark each removed session dir's `metadata.json` + drop its children bookkeeping via `structural_remove` (as-built correction, commit 0162c5b19 — a MOVED sessions/ tree leaves its session-dir watches live under stale paths otherwise), then swap to stand-in (arm project); at depth 3 `Remove | NameFrom` → `amplifier_remove_session`, dispatched on the `Remove` kind WITHOUT any dir-vs-file tag filter (the kernel does not set ISDIR on IN_DELETE_SELF — a directly-armed session dir's self-delete surfaces as `Remove(File)`, never `Remove(Folder)`; LB-01 — so a Folder-only gate would silently miss it; no refactor may add one); depth 3 `Create | CreateFolder | NameTo | NameBoth` routes to Task 3's classifier arm path (already exists — this is what makes regression 13 immediate); depth ≤3 `Name(Both)` handles both endpoints (From → remove-handling on `paths[0]`, To → create-handling on `paths[1]`). Structural-remove handling is IDEMPOTENT: an ARMED child's rename emits a 4th, untracked duplicate `Name(From)` after the trio (LB-01), and re-processing it must be a clean no-op — the path is already absent from armed/absent/retry and `unwatch_tolerated` absorbs the already-auto-dropped watch (`WatchNotFound` at debug, no second WARN). (Note: Task 4's removal helpers — `amplifier_teardown_project`, `amplifier_remove_session`, `amplifier_root_vanished` — run strictly on the async loop and therefore call `index.mark_dirty`/`mark_provider_dirty` directly; only the Task 3 arm helpers take the `ArmOutcome` sink, so they can run inside `spawn_blocking`.)
   2. Add the alarms:
      ```rust
     /// Read the kernel inotify watch limit (Linux). `None` elsewhere — the
     /// 25% WARN simply stays off (design line 160 budgets against it).
     fn read_max_user_watches() -> Option<usize> {
         std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
             .ok()?
             .trim()
             .parse()
             .ok()
     }

      /// WARN when total armed watches exceed 25% of the kernel limit.
      fn watch_budget_warn_needed(armed: usize, max_user_watches: usize) -> bool {
          armed > max_user_watches / 4
      }

      /// Edge-triggered budget state transition: (new warned state, emit WARN
      /// now). The edge fires on the ≤25% → >25% CROSSING only — already-warned
      /// growth stays silent (no per-arm spam), and falling back below the
      /// threshold silently re-arms the edge so the NEXT crossing warns again.
      /// `max_user_watches` is a parameter so tests inject the limit.
      fn watch_budget_edge(
          warned: bool,
          armed: usize,
          max_user_watches: usize,
      ) -> (bool, bool) {
          let over = watch_budget_warn_needed(armed, max_user_watches);
          match (warned, over) {
              (false, true) => (true, true),   // crossing: warn once
              (true, false) => (false, false), // recovered: re-arm the edge
              (w, _) => (w, false),
          }
      }

      /// Daily-bucketed counter for unknown-format (non-UUID, non-subagent)
     /// arms — surfaces amplifier naming drift in days instead of silently
     /// minting ~609 permanent watches/day (design lines 160-164).
     #[derive(Default)]
     struct DailyCounter {
         day_stamp: u64,
         count: u32,
     }
     const DRIFT_DAILY_WARN_THRESHOLD: u32 = 50;
     impl DailyCounter {
         fn note_unknown_arm(&mut self, now: std::time::SystemTime) -> Option<String> {
             let day = now
                 .duration_since(std::time::UNIX_EPOCH)
                 .map(|d| d.as_secs() / 86_400)
                 .unwrap_or(0);
             if day != self.day_stamp {
                 self.day_stamp = day;
                 self.count = 0;
             }
             self.count += 1;
             (self.count == DRIFT_DAILY_WARN_THRESHOLD).then(|| {
                 format!(
                     "session-watcher: {DRIFT_DAILY_WARN_THRESHOLD} unknown-format amplifier session dirs armed today — possible naming drift (each costs a permanent inotify watch)"
                 )
             })
         }
     }
     ```
      Wire `DailyCounter` and `budget_warned: bool` into `ManagedBook`; in
      `arm_managed_dir`'s
      `BasenameClass::Unknown` branch call `note_unknown_arm(SystemTime::now())`
      and `tracing::warn!("{msg}")` on `Some(msg)`.
   3. In the startup arm block: `tracing::info!(armed = book.armed.len(), "session-watcher: amplifier managed set armed")`, then the FIRST `check_watch_budget(&mut book)` — and per the Interfaces list, `check_watch_budget` is re-run after EVERY later arm-batch application (cascade arms in a structural-create dispatch — once per batch, the retry-drain batch, the replan apply, the absent-root-return cascade), because unbounded runtime growth (the accepted ~31K/yr accrual) can cross 25% long after startup. `check_watch_budget` reads `/proc` via `read_max_user_watches()` (None → no-op), applies `watch_budget_edge` to `book.budget_warned`/`book.armed.len()`, and `tracing::warn!`s only when the edge fires.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS (all prior tests + the 9 new ones).

- [ ] **Step 5: Refactor while green**
  The depth-3 Remove/MovedFrom handling and `amplifier_remove_session` share enough with the stand-in swap that the discoverable names should stay as stated; confirm no double-log for rename-vs-delete (MoveFrom must not log 'watch target disappeared' at info — it is debug now) and no double-WARN from the armed-child duplicate `Name(From)` (its re-processing is the book-miss no-op plus a tolerated `WatchNotFound` unwatch). No further dedup justified.

- [ ] **Step 6: Run impacted-test verification**
  Run: `cargo test -p freshell-sessions`
  Expected: PASS.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs
  git commit -m "feat(sessions): amplifier watch-set rename/remove lifecycle + watch-budget and drift alarms"
  ```

---

### Task 5: Depth-4 routing rewrite + fold-aware `stat_scoped` hook

**Files:**
- Modify: crates/freshell-sessions/src/session_watcher.rs (amplifier file-depth routing replaces the legacy pending-map flow)
- Modify: crates/freshell-sessions/src/directory_index.rs:214-225 (`SessionSource` gains `stat_scoped`), :1647-1680 (scoped loop uses the hook), :1891-2062 (test mod — the `pub(crate)` visibility landed in Task 3; here the counted `stat_scoped` passthrough + the 4-counter accessor)
- Modify: crates/freshell-sessions/src/amplifier.rs:107-110 (`AmplifierSource::stat_scoped` override)
- Test: crates/freshell-sessions/src/session_watcher_tests.rs, crates/freshell-sessions/src/directory_index.rs (mod tests), crates/freshell-sessions/src/amplifier.rs (mod tests)

**Interfaces:**
- Consumes: Task 3's amplifier dispatch + subagent gate; `stat_file` (`directory_index.rs:381-394`); amplifier's `stat_metadata_file` + `fold_activity_mtime` (`amplifier.rs:216-229`, `:198-210`); `parse_scoped_path` (:1440-1459).
- Produces:
  - `SessionSource::stat_scoped(&self, path: &Path) -> Option<FileStat>` with a default impl of raw `stat_file(path)`:
    ```rust
    /// Fold-aware stat for a watcher-scoped dirty path. The incremental
    /// cache key written for `path` comes from whatever this returns, so a
    /// source whose discover stats fold sibling state into the cache key
    /// (amplifier's sidecar mtimes) MUST fold identically here — otherwise
    /// the discover and scoped paths write different cache keys for the same
    /// file (raw-vs-folded thrash + frozen recency, design lines 77-83).
    /// `None` means the file is gone/unreadable and prunes the entry — a
    /// source override must therefore return None when ITS canonical file is
    /// missing regardless of surviving sidecars (never resurrect a ghost).
    fn stat_scoped(&self, path: &Path) -> Option<FileStat> {
        stat_file(path)
    }
    ```
  - `AmplifierSource::stat_scoped` override: `stat_metadata_file(path).map(fold_activity_mtime)` — None when metadata.json itself is gone
  - Scoped loop rewire (:1648-1679): the `match stat_file(path)` at :1652 resolves the hinted source first and calls `source.stat_scoped(path)`; no-hint fallback stays `stat_file`
  - `CountingWrapper` gets a COUNTED `fn stat_scoped(&self, path) -> Option<FileStat>` passthrough (`stat_scoped_calls.fetch_add(1, …)` then `self.inner.stat_scoped(path)`) so amplification survives wrapping AND scoped-mark processing is observable work in tests (a negative test can now assert that a dropped event produced NO scoped mark either). The `pub(crate) mod tests` visibility + `wrapper_counters` accessor landed in Task 3; this task extends the accessor to FOUR counters:
    ```rust
    pub(crate) fn wrapper_counters<S: SessionSource>(
        w: &CountingWrapper<S>,
    ) -> (Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>)
    ```
    (`discover_calls, parse_calls, direct_list_calls, stat_scoped_calls`), and the Task 3 `CountedAmplifierIndex` fixture grows a `stat_scoped_calls` field wired from the 4th return.
  - Amplifier file-event routing (replaces the Task 3 fall-through): amplifier `WatchEvent::FileChanged` never again reaches the legacy provider-escalation path. Depth computed by `amplifier_depth(path)`:
    - depth ≤ 3: Task 3/4 structural machinery (unchanged)
    - depth 4: `WatchKind::CreateFolder` → DROP (regression 6: the `context-intelligence/` mkdir — Task 2's `kind_of` preserves `CreateKind::Folder` precisely so this branch can distinguish it); everything else → rewrite to a scoped mark on the sibling `metadata.json` (`session_dir.join("metadata.json")`), batched into the existing `pending` map (which dedupes per flush) — NO filename whitelist (temp/backup files fold onto the canonical mark)
    - depth ≥ 5: DROP (unreachable under NonRecursive arms — defensive)
    - stand-in project children that are not exactly `<proj>/sessions` (depth 2 events under an armed stand-in, e.g. the real `recipe-sessions/` tree): DROP — regression 14b

- [ ] **Step 1: Write the failing behavioral test**
  (a) Append to `crates/freshell-sessions/src/amplifier.rs`'s `mod tests`:

  ```rust
  // ---------- stat_scoped (fold-aware scoped stat) ----------

  #[test]
  fn stat_scoped_folds_sidecar_mtime_and_none_when_metadata_missing() {
      let home = unique_temp_dir("stat-scoped-fold");
      let dir = write_session(&home, "slug", "sess-1", &sample_metadata("sess-1", "/p/x", "t"), Some("{\"type\":\"user\"}\n"));
      let meta = dir.join("metadata.json");
      let source = AmplifierSource::new(home.clone());

      // Make the sidecar DETERMINISTICALLY newer than metadata.json (the 20ms
      // mtime-separation idiom used throughout): with a newer sidecar present
      // the folded key must be STRICTLY greater than the raw metadata mtime —
      // a raw (unfolded) scoped stat would merely TIE it, which `>=` accepts.
      std::thread::sleep(std::time::Duration::from_millis(20));
      std::fs::write(
          dir.join("transcript.jsonl"),
          "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n",
      )
      .unwrap();

      let raw = std::fs::metadata(&meta).unwrap().modified().unwrap();
      let folded = <AmplifierSource as crate::directory_index::SessionSource>::stat_scoped(&source, &meta)
          .expect("scoped stat when metadata exists");
      assert_eq!(folded.path, meta);
      assert!(
          folded.mtime_ms > raw.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64,
          "a newer sidecar raises the folded key strictly above the raw metadata mtime (a raw-stat key ties and fails)"
      );

      // Regression 8's second half: metadata.json gone but transcript.jsonl
      // survives → None (never resurrect a ghost from surviving sidecars).
      std::fs::remove_file(&meta).unwrap();
      assert!(
          <AmplifierSource as crate::directory_index::SessionSource>::stat_scoped(&source, &meta).is_none(),
          "missing metadata.json ⇒ None even with surviving sidecars"
      );
      std::fs::remove_dir_all(&home).ok();
  }
  ```

  (b) Append to `crates/freshell-sessions/src/directory_index.rs`'s `mod tests`:

  ```rust
  // Regression 1 (scoped path): a sidecar-only change on an active amplifier
  // session refreshes recency WITHOUT a full discover and without parse thrash
  // — TWICE in sequence: the second sidecar-only change is the raw-key trap
  // (a raw-stat cache key would be raw-equal and skip the third parse).
  #[tokio::test]
  async fn scoped_mark_with_sidecar_only_activity_refreshes_amplifier_recency_without_discover() {
      let home = unique_temp_dir("scoped-fold");
      let session_dir = {
          let dir = home
              .join("projects")
              .join("slug")
              .join("sessions")
              .join("012584be-9478-4801-a62d-4e5da428b3a0");
          std::fs::create_dir_all(&dir).unwrap();
          std::fs::write(
              dir.join("metadata.json"),
              r#"{"session_id":"s1","working_dir":"/p/w","created":"2026-03-01T00:00:00.000Z","name":"t","description":"d","turn_count":1}"#,
          )
          .unwrap();
          std::fs::write(dir.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
          dir
      };
      let metadata = session_dir.join("metadata.json");

      let amplifier = crate::amplifier::AmplifierSource::new(home.clone());
      let wrapped = CountingWrapper::new(amplifier);
      let (discover_calls, parse_calls, _, _) = wrapper_counters(&wrapped);
      let index = test_index_with_ttl(
          vec![Arc::new(wrapped) as Arc<dyn SessionSource>],
          Duration::from_secs(3600),
      );

      let snap = index.snapshot().await;
      let row = snap.iter().find(|s| s.provider == "amplifier").unwrap();
      let before = row.last_activity_at;
      assert_eq!(discover_calls.load(Ordering::SeqCst), 1);

      // Sidecar-only activity: transcript grows, metadata.json untouched.
      tokio::time::sleep(Duration::from_millis(20)).await;
      std::fs::write(session_dir.join("transcript.jsonl"),
          "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n").unwrap();
      index.mark_dirty(&[(metadata.clone(), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);

      let snap2 = index.snapshot().await;
      let row2 = snap2.iter().find(|s| s.provider == "amplifier").unwrap();
      assert!(
          row2.last_activity_at > before,
          "recency ADVANCES on a sidecar-only change (equality would mean the sidecar never fed the key)"
      );
      // Scoped path: NO second discover; exactly one re-parse (folded key changed).
      assert_eq!(discover_calls.load(Ordering::SeqCst), 1, "no full/provider discover");
      assert_eq!(parse_calls.load(Ordering::SeqCst), 2, "one initial + one scoped re-parse");

      // A steady second scoped mark (no file movement) re-parses nothing,
      // proving the folded-vs-folded cache keys match (no raw-fold thrash).
      index.mark_dirty(&[(metadata.clone(), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);
      assert_eq!(parse_calls.load(Ordering::SeqCst), 2, "folded keys agree on both paths");

      // The raw-key trap: a SECOND sidecar-only change must force a THIRD
      // parse. A raw-stat implementation cached the raw metadata key above
      // (unchanged again here), so it skips this re-parse and freezes
      // activity ordering at row2 — the exact bug this regression guards.
      tokio::time::sleep(Duration::from_millis(20)).await;
      std::fs::write(
          session_dir.join("transcript.jsonl"),
          "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"type\":\"user\"}\n",
      )
      .unwrap();
      index.mark_dirty(&[(metadata.clone(), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);

      let snap3 = index.snapshot().await;
      let row3 = snap3.iter().find(|s| s.provider == "amplifier").unwrap();
      assert_eq!(
          parse_calls.load(Ordering::SeqCst),
          3,
          "the second sidecar-only change re-parses via the folded key (a raw key is raw-equal and is skipped)"
      );
      assert!(
          row3.last_activity_at > row2.last_activity_at,
          "activity ordering advances STRICTLY on every sidecar-only change ({} > {})",
          row3.last_activity_at,
          row2.last_activity_at
      );
      assert_eq!(discover_calls.load(Ordering::SeqCst), 1, "still no full/provider discover");

      std::fs::remove_dir_all(&home).ok();
  }

  // Regression 8: metadata.json deleted, sidecars survive — scoped mark prunes.
  #[tokio::test]
  async fn metadata_json_deleted_but_sidecars_survive_still_prunes_never_resurrects() {
      let home = unique_temp_dir("scoped-prune");
      let session_dir = {
          let dir = home
              .join("projects")
              .join("slug")
              .join("sessions")
              .join("012584be-9478-4801-a62d-4e5da428b3a0");
          std::fs::create_dir_all(&dir).unwrap();
          std::fs::write(
              dir.join("metadata.json"),
              r#"{"session_id":"s1","working_dir":"/p/w","created":"2026-03-01T00:00:00.000Z"}"#,
          )
          .unwrap();
          std::fs::write(dir.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
          std::fs::write(dir.join("events.jsonl"), "{}\n").unwrap();
          dir
      };
      let metadata = session_dir.join("metadata.json");
      let index = test_index_with_ttl(
          vec![Arc::new(crate::amplifier::AmplifierSource::new(home.clone()))
              as Arc<dyn SessionSource>],
          Duration::from_secs(3600),
      );
      assert_eq!(index.snapshot().await.iter().filter(|s| s.provider == "amplifier").count(), 1);

      std::fs::remove_file(&metadata).unwrap();
      index.mark_dirty(&[(metadata.clone(), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);
      assert_eq!(
          index.snapshot().await.iter().filter(|s| s.provider == "amplifier").count(),
          0,
          "metadata.json deletion prunes even with surviving sidecars"
      );
      // A repeat mark must not resurrect the row.
      index.mark_dirty(&[(metadata.clone(), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);
      assert_eq!(index.snapshot().await.iter().filter(|s| s.provider == "amplifier").count(), 0);
      std::fs::remove_dir_all(&home).ok();
  }
  ```

  (c) Append to `crates/freshell-sessions/src/session_watcher_tests.rs`:

  ```rust
  // ---------- file-depth routing ----------

  /// Regression 5: sidecar/tmp/backup churn inside a watched root session dir
  /// produces scoped metadata.json marks — never provider-dirty; steady
  /// activity triggers no repeated full discovers.
  #[tokio::test]
  async fn amplify_file_depth_events_route_to_scoped_metadata_marks_and_never_escalate() {
      use std::sync::atomic::Ordering;
      let home = unique_temp_dir("amp-filedepth");
      let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let amplifier = crate::amplifier::AmplifierSource::new(home.clone());
      let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
      let (discover_calls, _, _, _) = crate::directory_index::tests::wrapper_counters(&wrapped);
      let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
          vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
          Duration::from_secs(3600),
          None,
      ));
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      assert!(book.lock().unwrap().armed.contains(&session));
      let baseline_discovers = discover_calls.load(Ordering::SeqCst);

      // Steady heavy activity: sidecar append + tmp+rename metadata (VALID
      // content, so the row stays) + backup + the other sidecar.
      std::fs::write(session.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
      std::fs::write(
          session.join("metadata.json.tmp"),
          r#"{"session_id":"s1","working_dir":"/p/p","created":"2026-03-01T00:00:00.000Z","name":"t2"}"#,
      ).unwrap();
      std::fs::rename(session.join("metadata.json.tmp"), session.join("metadata.json")).unwrap();
      std::fs::write(session.join("metadata.json.backup"), b"{}").unwrap();
      std::fs::write(session.join("events.jsonl"), "{}\n").unwrap();

      let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
      assert!(changed.is_ok(), "scoped marks refresh the index");
      let mut settles = 0;
      for _ in 0..20 {
          if !index.has_dirty() {
              settles += 1;
              if settles >= 2 {
                  break;
              }
          }
          tokio::time::sleep(Duration::from_millis(100)).await;
      }
      assert!(
          discover_calls.load(Ordering::SeqCst) == baseline_discovers,
          "no repeated full discovers: baseline {baseline_discovers}, now {}",
          discover_calls.load(Ordering::SeqCst)
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 6: a `context-intelligence/` mkdir inside a session dir
  /// results in NO index activity at all (dropped at depth 4). The pins are
  /// OBSERVABLE WORK, not just the generation wait: a directory created at
  /// depth 4 must produce NO scoped mark (`stat_scoped_calls` never moves —
  /// had the mkdir been rewritten to a metadata.json mark, the background
  /// refresh would have stat'ed it) AND no provider-scan work
  /// (`discover_calls` never moves — an erroneous escalation's discover over
  /// identical content would not bump the generation, so the receiver timeout
  /// alone would be vacuous). The `WatchKind::CreateFolder` distinction
  /// (Task 2) is what lets this routing exist.
  #[tokio::test]
  async fn mkdir_inside_watched_session_dir_is_dropped_no_discover() {
      use std::sync::atomic::Ordering;
      let home = unique_temp_dir("amp-mkdir-drop");
      let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let counted = counted_amplifier_index(&home);
      let index = counted.index.clone();
      let mut watcher = amplifier_watcher(&index, &home);
      let _book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
      let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

      std::fs::create_dir_all(session.join("context-intelligence")).unwrap();
      std::fs::write(session.join("context-intelligence").join("index.json"), b"{}").unwrap();
      assert!(
          tokio::time::timeout(Duration::from_millis(800), rx.changed()).await.is_err(),
          "folder mkdir + its contents never reach the index"
      );
      // Past the 200ms debounce flush and the fire-and-forget refresh: the
      // mkdir produced no mark and no sweep.
      assert_eq!(
          counted.discover_calls.load(Ordering::SeqCst),
          baseline_discovers,
          "no discover ran for the depth-4 mkdir"
      );
      assert_eq!(
          counted.stat_scoped_calls.load(Ordering::SeqCst),
          baseline_scoped_stats,
          "no scoped stat ran — the mkdir created NO mark either"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Regression 14b: events under a stand-in watch that aren't `sessions/`
  /// (the real `{project}/recipe-sessions/` tree) are dropped by default.
  /// Same observable-work pins as the other negative tests: neither a
  /// discover nor a scoped stat may run for the dropped tree.
  #[tokio::test]
  async fn standin_project_children_other_than_sessions_are_dropped() {
      use std::sync::atomic::Ordering;
      let home = unique_temp_dir("amp-standin-drop");
      let proj = home.join("projects").join("{project}");
      std::fs::create_dir_all(&proj).unwrap(); // stand-in target
      let counted = counted_amplifier_index(&home);
      let index = counted.index.clone();
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;
      assert!(book.lock().unwrap().armed.contains(&proj));
      let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
      let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

      let odd = proj.join("recipe-sessions").join("nested");
      std::fs::create_dir_all(&odd).unwrap();
      std::fs::write(odd.join("data.json"), b"{}").unwrap();
      assert!(
          tokio::time::timeout(Duration::from_millis(800), rx.changed()).await.is_err(),
          "recipes tree is dropped"
      );
      assert_eq!(
          counted.discover_calls.load(Ordering::SeqCst),
          baseline_discovers,
          "no discover ran for dropped stand-in children"
      );
      assert_eq!(
          counted.stat_scoped_calls.load(Ordering::SeqCst),
          baseline_scoped_stats,
          "no scoped mark was created for dropped stand-in children"
      );
      // And nothing under it got armed.
      let b = book.lock().unwrap();
      assert!(!b.armed.iter().any(|p| p.to_string_lossy().contains("recipe-sessions")));
      drop(b);
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib stat_scoped` then `cargo test -p freshell-sessions --lib scoped_mark_with_sidecar` then `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL — (a) `stat_scoped` method does not exist on `SessionSource`/`AmplifierSource`; (b) the COUNTED `stat_scoped` passthrough on `CountingWrapper` (and the fixture's `stat_scoped_calls` field) do not exist — the visibility seam and the 3-counter `wrapper_counters` already landed in Task 3; (c) the file-depth router does not exist, so sidecar writes still escalate to provider-dirty AND the depth-4 mkdir's `Create(Folder)` event falls through to the escalation path (the `discover_calls`/`stat_scoped_calls` and timeout pins fail — the counter pins, not just the generation waits).

- [ ] **Step 3: Add the minimal production implementation**
  1. `directory_index.rs`: add the `stat_scoped` default to `SessionSource` after `discover_checked` (:222-225); rewire the scoped-stat block at :1652:
     ```rust
     let hinted = sources
         .iter()
         .find(|s| s.provider_name() == Some(watcher_provider.as_str()));
     match hinted.map(|s| s.stat_scoped(path)).unwrap_or_else(|| stat_file(path)) {
     ```
     Keep every other line of the scoped block (:1647-1680) byte-identical — the Some/None arms are unchanged; only the stat source changes.
   2. Counting-double extension (the visibility seam landed in Task 3's Step 3.4 — here only the counters grow): `CountingWrapper` gains `stat_scoped_calls: Arc<AtomicUsize>` and the counted `stat_scoped` passthrough (`fetch_add(1, …)` then `self.inner.stat_scoped(path)`); `wrapper_counters` gains its 4th return; the Task 3 `CountedAmplifierIndex` fixture in `session_watcher_tests.rs` gains the `stat_scoped_calls` field wired from it.
  3. `amplifier.rs`: add the `stat_scoped` override to `impl SessionSource for AmplifierSource` (after `discover_checked`, :107-109):
     ```rust
     /// Fold-aware scoped stat: same cache key as the discover path
     /// (`fold_activity_mtime`). `None` whenever metadata.json itself is
     /// missing so the scoped deletion prune still fires — surviving sidecars
     /// never resurrect a ghost entry (design lines 80-83).
     fn stat_scoped(&self, path: &Path) -> Option<FileStat> {
         stat_metadata_file(path).map(fold_activity_mtime)
     }
     ```
   4. `session_watcher.rs`: in the amplifier recv dispatch, replace the residual "fall through to legacy pending flow" for file-depth events with explicit routing per Interfaces (depth ≤3 → structural; depth 4 → `WatchKind::CreateFolder` dropped / everything else scoped-metadata-mark; ≥5 → drop; stand-in children → drop). Scoped marks are inserted into the existing `pending` coalescing map as `(metadata_path, "amplifier")` pairs so the flush (`:305-332`) still batches them through `index.mark_dirty`; the Task 3/4 structural arms' `ArmOutcome.marks` drain into the SAME pending insertion path (event-time arm marks coalesce with depth-4 rewrites); `AmplifierLayout::qualifies` (`provider_layout.rs:192-208`) stays as the flush-side safety check and passes every rewritten mark. Amplifier events NEVER reach the `dirty_provider_names` escalation branch after this task.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib`
  Expected: PASS — including the existing amplifier fold tests (discover-path side of regression 1: `amplifier_source_folds_sidecar_mtime_into_last_activity_at`, `session_index_refreshes_amplifier_recency_when_only_sidecar_changes`) and the scoped-delete tests (`scoped_dirty_path_handles_deleted_file`, `deleted_file_pruned`).

- [ ] **Step 5: Refactor while green**
  Update the stale paragraphs: the `SessionSource` doc (:158) and the scoped handling comment (:1643-1646 "scoped paths … already qualified") to describe `stat_scoped`. Verify no remaining `stat_file(` call inside the scoped loop besides the no-hint fallback. If `session_watcher.rs` is past ~950 lines, no further split is needed yet (tests are already external).

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: the whole sessions crate (the `SessionSource` trait gained a default method — every implementor's behavior is inherited: `ClaudeSource`, `CodexSource`, `OpencodeSource`, test doubles; the amplifier override is the only semantic change) plus a freshell-server build check.
  Run: `cargo test -p freshell-sessions && cargo check -p freshell-server`
  Expected: PASS / clean.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs crates/freshell-sessions/src/directory_index.rs crates/freshell-sessions/src/amplifier.rs
  git commit -m "feat(sessions): depth-4 routing to scoped metadata marks + fold-aware stat_scoped hook"
  ```

---

### Task 6: Debounce max-deferral cap + need_rescan full watch-set replan

**Files:**
- Modify: crates/freshell-sessions/src/session_watcher.rs:270-301 (debounce deadline logic), :303-332 (flush arm adds the replan branch), plus `SessionWatcher` test seam
- Test: crates/freshell-sessions/src/session_watcher_tests.rs

**Interfaces:**
- Consumes: Task 3's `ManagedBook` (`replans` counter), amplifier provider context; `crate::watch_plan::plan_amplifier_targets` + `diff_armed`; Task 2's `watch_path`/`unwatch_tolerated`.
- Produces:
  - `const MAX_FLUSH_DEFERRAL: Duration = Duration::from_secs(2)` (design value)
  - Debounce rule change: after the FIRST event of a pending burst (`pending_since: Option<tokio::time::Instant>`, latched when pending goes empty→non-empty, cleared on flush), the deadline is `min(now + DEBOUNCE_MS, pending_since + MAX_FLUSH_DEFERRAL)` — sustained sub-200ms streams can no longer starve the flush
  - `fn replan_amplifier_watch_set(book: &mut ManagedBook, watcher: &mut RecommendedWatcher, outcome: &mut ArmOutcome, projects_root: &Path, provider: &str) -> bool` (returns "applied" for the `replans` counter) — the SYNC core: `plan_amplifier_targets` → build the desired kind-map → `diff_armed(desired, armed)` → apply. The ASYNC flush wrapper runs the whole core inside `spawn_blocking` (design line 111 — the replan's `watch()`/`unwatch()` batch plus cascade readdirs, not just the plan scan, never stalls the watch-loop worker): it moves the amplifier `ProviderWatch` out of the Task-2 `watches` map (`RecommendedWatcher` is `Send`), passes it and the locked book guard into the closure, awaits, re-inserts the watcher, and drains the returned `ArmOutcome` (`marks` → `index.mark_dirty`, `provider_dirty` → `index.mark_provider_dirty("amplifier")`) plus `book.replans += 1` when applied. Events arriving during the await buffer on the unbounded channel and dispatch after re-insertion — the loop already serializes arms this way today; `spawn_blocking` only moves the syscalls off the core worker.
    DESIRED SET, precisely — a kind-tagged `HashMap<PathBuf, ArmKind>` (`diff_armed` no longer works on bare paths): `plan.sessions_dirs → SessionsDir`, `plan.standins → Standin`, `plan.root_session_dirs → SessionDir`, PLUS `{ projects_root → ProjectsRoot }` — but ONLY when `plan.root_exists` (R2: the replan consults root_exists). `PlanTargets` deliberately excludes the permanent projects-root watch (it is the engine's startup context, not a plan product), so a healthy root is UNIONED in before diffing the COMPLETE armed set; otherwise every successful replan would classify the structural root watch as stale and unwatch it. When `plan.root_exists` is FALSE (the root vanished): the root is NOT in the desired set — instead the replan routes it to absence tracking itself (`unwatch_tolerated(projects_root)`, `armed.remove`, `absent.insert(projects_root)`, `outcome.provider_dirty = true`; the return is then owned by the rearm tick's full-cascade re-arm), and the diff against the now-rootless desired set unwatches the dead subtree (all `WatchNotFound`-tolerated) — delete-and-recreate can never end up with no watch or ancestor able to detect the return.
    APPLY: each `diff.arm` entry is armed via `arm_managed_dir(path, entry.kind, emit_marks: true)` — KIND-CORRECT, never flattened: a `sessions/` dir first seen by the replan enters as `SessionsDir` and therefore CASCADES its root-session children (plus scoped marks); a stand-in enters as `Standin` and performs the post-arm swap; a session dir does the watch-then-scan file-state mark. Honors backoff: an entry whose path is in `retry` is NOT re-armed (Task 7's pure fold-in makes this a shared `roots_needing_arm` predicate — this task uses the simpler "not armed and not in retry" check inline). Each `diff.unwatch` path: `unwatch_tolerated` + bookkeeping cleanup via Task 4's `structural_remove`.
    ABORT discipline (unchanged from round 1): when `plan_amplifier_targets` returns `Err`, the replan ABORTS — a warn-level log, the armed set and ALL bookkeeping stay untouched, no unwatch diffs are applied (a transient scan error is NOT an empty listing — the same transient-failure protection philosophy as `discover_checked`; with Task 1's strict planner this also covers nested read errors); the provider-dirty mark STILL fires (the wrapper drains `outcome.provider_dirty` — set on the abort path too — so the data plane recovers through discover's own root-listing-failure protection), the sync core returns `false`, and `book.replans` is NOT incremented (the counter counts APPLIED replans).
  - Flush-arm change (:305-307): `pending_rescans` entries route: `provider == "amplifier"` → `replan_amplifier_watch_set` + `mark_provider_dirty`; everything else → the legacy `mark_provider_dirty` (need_rescan for claude/codex/opencode is unchanged)
  - The `WatchEvent` channel moves from `start()` to CONSTRUCTION time (today it is created at the top of `run_watcher_loop`): `SessionWatcher::new` creates the channel once, stores the sender in a field (cloned into every provider-watcher callback exactly as today) and the receiver in an `Option` field that `start()` `take()`s and moves into the loop unchanged. On this, the `#[cfg(test)] SessionWatcher` event-injection seam is:
    ```rust
    #[cfg(test)]
    pub(crate) fn test_event_tx(&self) -> Option<mpsc::UnboundedSender<WatchEvent>>
    ```
    which simply clones the stored sender — always `Some` BEFORE `start()` (no production behavior change: same channel, same senders, same consumer; the replan tests obtain the sender pre-start by design, so the channel must exist at construction).

- [ ] **Step 1: Write the failing behavioral test**
  Append to `crates/freshell-sessions/src/session_watcher_tests.rs`:

  ```rust
  // ---------- debounce cap + rescan replan ----------

  /// Regression 10: a sustained sub-200ms event stream can no longer starve
  /// the flush — it fires within the 2s max-deferral cap even while events
  /// keep arriving. Timing discipline (the crate's real-time idiom, with
  /// margins so a CORRECT implementation can never flake this): measure from
  /// the stream's start (the first write lands ~immediately after spawn,
  /// milliseconds before the first event is processed); the outer timeout is
  /// 5s — comfortably larger than the 2s cap, so it can only trip on a
  /// genuinely starved flush, never on a correct cap-limited one; the cap
  /// assertion itself carries 500ms of notify/scheduling slack.
  #[tokio::test]
  async fn sustained_sub_gap_event_stream_flushes_within_max_deferral() {
      let home = unique_temp_dir("amp-debounce-cap");
      let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      let _ = rx.borrow_and_update();
      tokio::time::sleep(Duration::from_millis(300)).await;

      // Producer: 100ms-spaced sidecar writes; spans ~3s of continuous input.
      let transcript = session.join("transcript.jsonl");
      let stream_started = tokio::time::Instant::now();
      let producer = tokio::spawn(async move {
          for i in 0..28u32 {
              std::fs::write(&transcript, format!("{{\"i\":{i}}}\n")).unwrap();
              tokio::time::sleep(Duration::from_millis(100)).await;
          }
      });

      // Without the cap the flush lands at producer-end (~2.8s) + 200ms quiet
      // gap ≈ 3.0s from stream start; with it, ≈2s after the first event.
      tokio::time::timeout(Duration::from_secs(5), rx.changed())
          .await
          .expect("flush never starves past 5s (outer timeout ≫ 2s cap)")
          .unwrap();
      let elapsed = stream_started.elapsed();
      assert!(
          elapsed >= Duration::from_millis(150),
          "the 200ms quiet gap is still respected (asserted with 50ms slack): {elapsed:?}"
      );
      assert!(
          elapsed <= Duration::from_millis(2_500),
          "flush within cap + 500ms slack of the stream start (first event ≈ start): {elapsed:?}"
      );
      producer.abort();
      let _ = producer.await;
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// need_rescan (IN_Q_OVERFLOW) on amplifier = full watch-set replan AND
  /// provider dirty; on claude it stays provider-dirty only.
  #[tokio::test]
  async fn need_rescan_on_amplifier_replans_the_watch_set() {
      let home = unique_temp_dir("amp-replan");
      let _s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      // The event channel is allocated at construction (Interfaces), so the
      // sender is valid BEFORE start() — this ordering is intentional.
      let tx = watcher.test_event_tx().expect("test event seam");
      let handle = watcher.start();
      let _ = index.snapshot().await;
      tokio::time::sleep(Duration::from_millis(300)).await;
      let initial_replans = book.lock().unwrap().replans;

      // Inject a synthetic queue-overflow rescan for amplifier.
      tx.send(WatchEvent::ProviderRescan {
          provider: "amplifier".to_string(),
      })
      .unwrap();

      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().replans > initial_replans {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("rescan triggered a replan");
      // Bookkeeping is still consistent afterwards.
      assert!(book.lock().unwrap().armed.contains(&_s1));
      // The permanent projects-root watch survives the replan — the desired
      // kind-map includes `{ projects_root → ProjectsRoot }` whenever the
      // root exists, so the diff can never classify the structural root
      // watch as stale and unwatch it.
      assert!(
          book.lock().unwrap().armed.contains(&home.join("projects")),
          "the structural projects-root watch is never replanned away"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// Replan abort discipline, two phases: (1) a chmod-000 projects root
  /// propagates EACCES from `open_root_dir`; (2) the NESTED partial-scan
  /// case — root and project listable, `p/sessions` unreadable, which Task
  /// 1's strict planner turns into a whole-plan `Err` rather than a partial
  /// plan. In both, the replan ABORTS — no arm/unwatch diff is applied, the
  /// armed set and all bookkeeping stay untouched, `book.replans` (APPLIED
  /// replans only) does not move — while the provider-dirty mark STILL
  /// fires, observable in phase 1 as a recorded `amplifier` scan failure via
  /// discover's own root-listing protection.
  #[cfg(unix)]
  #[tokio::test]
  async fn replan_aborts_and_keeps_armed_set_on_planner_error() {
      use std::os::unix::fs::PermissionsExt;
      let home = unique_temp_dir("amp-replan-abort");
      let s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      // Construction-time channel: the sender is valid before start().
      let tx = watcher.test_event_tx().expect("test event seam");
      let handle = watcher.start();
      let _ = index.snapshot().await;
      assert!(index.scan_failures().is_empty());
      tokio::time::sleep(Duration::from_millis(300)).await;

      let mut armed_before: Vec<PathBuf> =
          book.lock().unwrap().armed.iter().cloned().collect();
      armed_before.sort();
      let replans_before = book.lock().unwrap().replans;
      assert!(armed_before.iter().any(|p| p == &s1));

      // Transient planner failure: the projects root becomes UNLISTABLE.
      // (stat still succeeds — only read_dir fails — so the rearm tick sees
      // `exists() == true` and does not churn the armed set.)
      let projects = home.join("projects");
      std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
      if std::fs::read_dir(&projects).is_ok() {
          eprintln!("skipping planner-error assertions: euid can list a 0o000 dir");
          std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
          watcher.stop();
          let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
          std::fs::remove_dir_all(&home).ok();
          return;
      }

      tx.send(WatchEvent::ProviderRescan {
          provider: "amplifier".to_string(),
      })
      .unwrap();

      // The provider-dirty mark STILL fired: discover's root-listing
      // protection records a scan failure instead of gutting the snapshot
      // (data plane recovers through discover's own protection).
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if index.scan_failures().iter().any(|n| n == "amplifier") {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(100)).await;
          }
      })
      .await
      .expect("provider dirty still fired (amplifier scan failure recorded)");

      // The ABORT left every watch-set facet untouched: no arm/unwatch diff
      // was applied, bookkeeping is unchanged, and the applied-only replan
      // counter did not increment.
      {
          let b = book.lock().unwrap();
          let mut armed_after: Vec<PathBuf> = b.armed.iter().cloned().collect();
          armed_after.sort();
          assert_eq!(armed_after, armed_before, "aborted replan applies no diff");
          assert!(b.absent.is_empty() && b.retry.is_empty());
          assert_eq!(
              b.replans, replans_before,
              "book.replans counts APPLIED replans only"
          );
      }

      // Phase 2 — the NESTED partial-scan case: the projects root lists fine
      // and project `p` lists fine, but `p/sessions` is unreadable. Task 1's
      // strict planner fails the WHOLE plan on this (no partial plan), so the
      // replan must abort identically — before the strict-everywhere contract
      // this shape silently produced a partial plan whose unwatch diff would
      // tear down p's healthy root-session watch.
      std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
      let sessions = projects.join("p").join("sessions");
      std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
      tx.send(WatchEvent::ProviderRescan {
          provider: "amplifier".to_string(),
      })
      .unwrap();
      // Bounded settle (the suite's negative-window idiom): long enough for a
      // buggy diff-applying replan to have run, then assert nothing changed.
      tokio::time::sleep(Duration::from_millis(700)).await;
      {
          let b = book.lock().unwrap();
          let mut armed_nested: Vec<PathBuf> = b.armed.iter().cloned().collect();
          armed_nested.sort();
          assert_eq!(
              armed_nested, armed_before,
              "nested scan error also aborts: the armed set is untouched"
          );
          assert!(b.absent.is_empty() && b.retry.is_empty());
          assert_eq!(b.replans, replans_before, "still no applied replan");
      }
      std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();

      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  /// The replan applies arm diffs KIND-CORRECTLY (never flattened): a
  /// `sessions/` dir first discovered by the REPLAN (not startup, not an
  /// event cascade — its create events were lost) is armed as
  /// `ArmKind::SessionsDir`, so the arm CASCADES: its root-session children
  /// are armed first-line and their scoped metadata.json marks are emitted.
  /// A flattened bare-path arm would leave those children unwatched —
  /// silent staleness against the hard zero-latency requirement. Driven
  /// through the sync core with the established no-loop idiom.
  #[tokio::test]
  async fn replan_arms_newly_appeared_sessions_dir_kind_correctly_with_cascade() {
      let home = unique_temp_dir("amp-replan-kind");
      let session = write_amplifier_session(&home, "late", "550e8400-e29b-41d4-a716-4466554400aa");
      let metadata = session.join("metadata.json");
      let projects_root = home.join("projects");
      let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
      let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
      let mut book = ManagedBook::default();
      // Seed the book as if startup armed ONLY the projects root (the `late`
      // project appeared later and its events were lost — the replan is the
      // recovery path, so nothing below the root is armed yet).
      book.armed.insert(projects_root.clone());
      let mut outcome = ArmOutcome::default();

      let applied = replan_amplifier_watch_set(
          &mut book,
          &mut watcher,
          &mut outcome,
          &projects_root,
          "amplifier",
      );

      let sessions_dir = projects_root.join("late").join("sessions");
      assert!(applied, "a clean plan applies");
      assert!(book.armed.contains(&sessions_dir), "sessions dir armed");
      assert!(
          book.armed.contains(&session),
          "the kind-correct arm CASCADED: the root-session child is armed"
      );
      assert!(
          outcome.marks.contains(&metadata),
          "watch-then-scan: the cascaded session's scoped mark was emitted"
      );
      assert!(outcome.provider_dirty, "the replan escalates provider dirty");
      drop(watcher);
      std::fs::remove_dir_all(&home).ok();
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL — `sustained_sub_gap_event_stream_flushes_within_max_deferral` fails its `elapsed <= 2.5s` cap assertion: today's deadline resets on every event, so the flush lands ≈3.0s from stream start (the 5s outer timeout deliberately does NOT trip — the red signal is the cap assertion, and a correct implementation can never flake the outer timeout); `need_rescan_on_amplifier_replans_the_watch_set` and `replan_aborts_and_keeps_armed_set_on_planner_error` fail to compile (`test_event_tx`, and the construction-time channel field, do not exist) and/or the replan counter never increments; `replan_arms_newly_appeared_sessions_dir_kind_correctly_with_cascade` fails to compile (`replan_amplifier_watch_set` and the outcome sink do not exist yet).

- [ ] **Step 3: Add the minimal production implementation**
  1. Debounce cap — the flush-deadline computation at :278-283 becomes:
     ```rust
     let flush_deadline = if pending.is_empty() && pending_rescans.is_empty() {
         pending_since = None;
         None
     } else {
         let start = pending_since.get_or_insert_with(tokio::time::Instant::now);
         let capped = *start + MAX_FLUSH_DEFERRAL;
         Some(capped.min(tokio::time::Instant::now() + debounce))
     };
     ```
     with `let mut pending_since: Option<tokio::time::Instant> = None;` next to `pending` (:272) and `pending_since = None;` inside the flush arm after draining (:303-332). The coalescing map's per-key `Instant` (:272) remains intentionally unused — a refactor would remove it, but no task needs the stamp: the cap needs only burst-start time (explicitly left as-is per the stale-stamp rule).
   2. Rescan replan — `replan_amplifier_watch_set` per Interfaces, called from the flush loop's `pending_rescans` branch when `provider == "amplifier"`. The flush wrapper moves the amplifier `ProviderWatch` out of the watched map and runs the SYNC core (plan scan + kind-map diff + arm/unwatch batch + cascade readdirs) inside ONE `spawn_blocking` closure over the locked book guard, then re-inserts the watcher and drains the returned `ArmOutcome` to the index (marks → `index.mark_dirty`; `provider_dirty` → `index.mark_provider_dirty("amplifier")` — set on both the applied and the aborted paths) and applies the returned "applied" flag to `book.replans`. Design-line-111 conformance note: `notify::RecommendedWatcher` is `Send` (the inotify handle), so the whole batch leaves the async worker; only the mark/routing drain comes back to the loop, and the per-event dispatch path never moves (those are single-event arms, not bulk). On planner `Err` the core ABORTS before any diff application: warn-level log, the armed set and all bookkeeping stay untouched (a transient scan error — root OR nested, Task 1's planner is strict-everywhere — is not an empty listing — `discover_checked`'s protection philosophy), `outcome.provider_dirty` is still set (the data plane recovers through discover's own root-listing protection), the core returns `false`, and `book.replans` is NOT incremented (it counts APPLIED replans). On `Ok`, the core builds the desired kind-map FIRST — `sessions_dirs → SessionsDir`, `standins → Standin`, `root_session_dirs → SessionDir`, and `{ projects_root → ProjectsRoot }` ONLY when `plan.root_exists` (the permanent root watch is not a `PlanTargets` member, so it must be UNIONED in when the root exists, or the diff against the complete armed set would unwatch it; when the root has VANISHED the replan excludes it and instead routes it to absence tracking — `unwatch_tolerated` + `armed.remove` + `absent.insert` + provider dirty — so the rearm tick's full-cascade re-arm owns the return) — then diffs via `diff_armed` (kinds preserved) and applies: `arm` entries → `arm_managed_dir(path, entry.kind, emit_marks: true)` (kind-correct: SessionsDir arms cascade, Standin arms swap, SessionDir arms scan-and-mark; paths still in `retry` are skipped), `unwatch` paths → `unwatch_tolerated` + `structural_remove`, and returns `true`. No additional test byte for the off-loop property itself: the direct-call tests (this task's `replan_arms_newly_appeared_sessions_dir_kind_correctly_with_cascade` and Task 3's `startup_arms_session_dirs_created_in_the_scan_arm_window`) exercise the sync core, and the off-loop property is structural — the wrapper's `spawn_blocking` shape plus a clippy-clean compile is the gate (a guaranteed-blocking probe would add harness machinery the crate does not have, without behavioral information).
  3. Test seam / channel placement: the `WatchEvent` channel is allocated in `SessionWatcher::new` (not in `start()`): `new` stores the sender in a field (provider-watcher callbacks clone it as today) and the receiver in an `Option` field that `start()` `take()`s and moves into `run_watcher_loop` unchanged. `test_event_tx()` (a `#[cfg(test)]` accessor) clones the stored sender, so it returns `Some` at construction time and the replan tests' pre-start ordering is correct by construction.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS.

- [ ] **Step 5: Refactor while green**
  The flush-arm structure should read as: drain rescans (amplifier ⟹ replan+dirty, others ⟹ dirty), drain pending (existing). If the replan branch bloats the flush arm, extract `flush_rescans(book, watches, index, pending_rescans)` as a private fn — one-line structural cleanup only. The staler per-event `Instant` stamps in `pending` stay untouched (no task needs them; removing them is out of scope).

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: freshell-sessions (debounce logic is provider-shared; the rescan path also feeds claude/codex/opencode).
  Run: `cargo test -p freshell-sessions`
  Expected: PASS.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs
  git commit -m "fix(sessions): debounce max-deferral cap and need_rescan watch-set replan"
  ```

---

### Task 7: Refresh→watcher self-correction channel (misnamed-root recovery)

**Files:**
- Modify: crates/freshell-sessions/src/directory_index.rs (SessionIndex gains the report sink; `refresh_snapshot` computes the report; `perform_refresh` publishes it)
- Modify: crates/freshell-sessions/src/session_watcher.rs (watch for the report; arm loop)
- Test: crates/freshell-sessions/src/directory_index.rs (mod tests), crates/freshell-sessions/src/session_watcher_tests.rs

**Interfaces:**
- Consumes: `file_cache` (private `HashMap<PathBuf, FileEntry>`, :841); `fully_discovered_providers` (:1495, populated at :1583-1585); `IndexedSession.is_subagent` (:113); Task 3's `arm_managed_dir`.
- Produces:
  - `SessionIndex::set_amplifier_root_report_sink(&self, sink: tokio::sync::mpsc::UnboundedSender<Vec<PathBuf>>)` + field:
    ```rust
    /// One-way refresh→watcher report (amplifier watch-reduction design,
    /// "Self-correction channel"). After a sweep that fully discovered
    /// amplifier, the watcher receives every amplifier session dir whose
    /// parsed metadata has `parent_id` absent (true roots). Amplifier
    /// IndexedSession rows publish `source_file: None` (amplifier.rs:415-419),
    /// so dirs are derived from the private `file_cache` KEYS (canonical
    /// metadata.json paths), never from published rows.
    amplifier_root_report: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<PathBuf>>>>>,
    ```
  - `refresh_snapshot` computes `amplifier_root_dirs: Option<Vec<PathBuf>>` — `Some(sorted dirs)` iff `"amplifier" ∈ fully_discovered_providers`; entries: `cache` items with `source_name == Some("amplifier") && item.as_ref().is_some_and(|i| !i.is_subagent)` mapped to `path.parent()`. (Cached exclusions `item: None` contribute nothing: they are already name-classified fail-safe.)
  - `perform_refresh` sends the list on the sink (best-effort `send`, drop when the watcher is absent/disinterested) immediately after the snapshot publish (`:1317-1328`)
  - Watcher side: SessionWatcher creates the channel in `start()` iff the amplifier book exists, registers it via `index.set_amplifier_root_report_sink(tx)`, and the loop gets a new select arm: on report → for each dir in `roots_needing_arm(&dirs, &book)` → `arm_managed_dir(.., ArmKind::SessionDir, emit_marks: true)` (the kind-correct file-state arm — idempotent bookkeeping, so a dir already armed via the race is a no-op) driving a fresh `ArmOutcome` drained to the index afterwards (this select arm stays on the async loop: reports carry handfuls of dirs, not bulk batches)
  - `fn roots_needing_arm(reported: &[PathBuf], armed: &HashSet<PathBuf>, retry: &HashMap<PathBuf, RetryEntry>) -> Vec<PathBuf>` (PURE — the regression-9 hook: retry membership suppresses arming outright):

    ```rust
    /// Design: diffs against (armed ∪ retry-pending) — never bypassing
    /// arm-failure backoff.
    fn roots_needing_arm(
        reported: &[PathBuf],
        armed: &std::collections::HashSet<PathBuf>,
        retry: &std::collections::HashMap<PathBuf, RetryEntry>,
    ) -> Vec<PathBuf> {
        reported
            .iter()
            .filter(|d| !armed.contains(*d))
            .filter(|d| !retry.contains_key(*d))
            .cloned()
            .collect()
    }
    ```

- [ ] **Step 1: Write the failing behavioral test**
  (a) `crates/freshell-sessions/src/directory_index.rs` `mod tests`:

  ```rust
  // ---------- refresh→watcher self-correction report ----------

  #[tokio::test]
  async fn amplifier_report_carries_only_parsed_root_session_dirs() {
      let home = unique_temp_dir("amp-report");
      let mk = |slug: &str, id: &str, metadata: &str| {
          let dir = home.join("projects").join(slug).join("sessions").join(id);
          std::fs::create_dir_all(&dir).unwrap();
          std::fs::write(dir.join("metadata.json"), metadata).unwrap();
          dir
      };
      // True root (parent_id absent).
      let root = mk("p", "012584be-9478-4801-a62d-4e5da428b3a0",
          r#"{"session_id":"r","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#);
      // Misnamed root: subagent-PATTERN name, but parent_id absent.
      let misnamed = mk("p", "0000000000000000-014b6af1c2ac4ab5_agent",
          r#"{"session_id":"m","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#);
      // True subagent: parent_id present.
      let _sub = mk("p", "1111111111111111-2222222222222222_sub",
          r#"{"session_id":"s","working_dir":"/p/x","parent_id":"r","created":"2026-03-01T00:00:00.000Z"}"#);
      // Excluded (cwd-less) root-named dir: contributes nothing (unparseable rows are already fail-safe-watched).
      let _excluded = mk("p", "222584be-9478-4801-a62d-4e5da428b3a0",
          r#"{"session_id":"e","created":"2026-03-01T00:00:00.000Z"}"#);

      let index = test_index_with_ttl(
          vec![Arc::new(crate::amplifier::AmplifierSource::new(home.clone()))
              as Arc<dyn SessionSource>],
          Duration::from_secs(3600),
      );
      let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<PathBuf>>();
      index.set_amplifier_root_report_sink(tx);
      let _ = index.snapshot().await;
      let report = tokio::time::timeout(Duration::from_secs(5), rx.recv())
          .await
          .expect("report fires after a full discover")
          .expect("channel open");
      assert_eq!(report, {
          let mut v = vec![misnamed.clone(), root.clone()];
          v.sort();
          v
      });

      // A scoped-only refresh must NOT re-report (amplifier was not fully discovered).
      index.mark_dirty(&[(home.join("nonexistent.json"), "amplifier".to_string())]);
      assert!(wait_until(Duration::from_secs(2), || !index.has_dirty()).await);
      assert!(
          tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err(),
          "scoped-only sweeps produce no report"
      );
      std::fs::remove_dir_all(&home).ok();
  }
  ```

  (b) `session_watcher_tests.rs`:

  ```rust
  // Regression 4 (round trip): a subagent-NAMED dir holding root CONTENT
  // (parent_id absent) is name-classified as subagent → never armed at
  // startup — and is recovered by the refresh→watcher report. The
  // not-armed-then-armed sequence is observed WITHOUT sleeps or races:
  // phase 1 asserts the startup classification BEFORE any discover/snapshot
  // has run (so no report can exist yet — the sink only fires from a full
  // refresh, and startup itself is markless for an existing root); phase 2
  // triggers the discover and awaits the arm.
  #[tokio::test]
  async fn misnamed_subagent_named_root_is_armed_via_refresh_report() {
      let home = unique_temp_dir("amp-misname");
      let dir = home
          .join("projects")
          .join("p")
          .join("sessions")
          .join("0000000000000000-014b6af1c2ac4ab5_actually_a_root");
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(
          dir.join("metadata.json"),
          r#"{"session_id":"mis","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
      )
      .unwrap();
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let handle = watcher.start();

      // Phase 1 (no report can exist yet — `index.snapshot()` has not been
      // called): wait for the startup structural arm pass to complete (the
      // `p/sessions` watch is the deepest structural arm in this fixture),
      // then assert the misnamed dir is UNARMED — name classification, with
      // no report in flight to race it.
      let sessions = home.join("projects").join("p").join("sessions");
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().armed.contains(&sessions) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("startup structural arm pass completes");
      assert!(
          !book.lock().unwrap().armed.contains(&dir),
          "at startup the name says subagent ⇒ unarmed"
      );

      // Phase 2: NOW the first full discover runs — the root report fires
      // and the self-correction channel arms the misnamed root.
      let _ = index.snapshot().await;
      tokio::time::timeout(Duration::from_secs(5), async {
          loop {
              if book.lock().unwrap().armed.contains(&dir) {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("misnamed root armed via the refresh report");
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  // Regression 9: the diff never bypasses arm-failure backoff.
  #[test]
  fn roots_needing_arm_respects_retry_backoff() {
      let ghost = PathBuf::from("/tmp/amplifier-retry-ghost");
      let reported = vec![ghost.clone(), PathBuf::from("/tmp/fresh")];
      let mut armed: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
      let mut retry: std::collections::HashMap<PathBuf, RetryEntry> =
          std::collections::HashMap::new();
      retry.insert(ghost.clone(), RetryEntry {
          failures: 2,
          next_attempt: std::time::Instant::now() + Duration::from_secs(60),
          kind: crate::watch_plan::ArmKind::SessionDir,
      });
      let to_arm = roots_needing_arm(&reported, &armed, &retry);
      assert_eq!(to_arm, vec![PathBuf::from("/tmp/fresh")]);

      // Rust: a dir that's already armed is also skipped.
      let report2 = vec![ghost.clone()];
      armed.insert(ghost.clone());
      assert!(roots_needing_arm(&report2, &armed, &retry).is_empty());
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib amplifier_report` then `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL — `set_amplifier_root_report_sink` and `roots_needing_arm` do not exist; the misnamed-dir test never sees the arm.

- [ ] **Step 3: Add the minimal production implementation**
  1. `directory_index.rs`: add the `amplifier_root_report` field (initialized `None`), the setter, the `refresh_snapshot` computation, and the `perform_refresh` send:
     ```rust
     // In refresh_snapshot, at the end of the file-backed loop region before
     // prune bookkeeping — place after `discovered` processing is complete:
     let amplifier_root_dirs = fully_discovered_providers
         .contains("amplifier")
         .then(|| {
             let mut dirs: Vec<PathBuf> = cache
                 .iter()
                 .filter(|(_, entry)| entry.source_name.as_deref() == Some("amplifier"))
                 .filter(|(_, entry)| entry.item.as_ref().is_some_and(|i| !i.is_subagent))
                 .filter_map(|(path, _)| path.parent().map(Path::to_path_buf))
                 .collect();
             dirs.sort();
             dirs
         });
     // … thread `amplifier_root_dirs` out of the closure through
     // refresh_snapshot's return (change the tuple to include it) and send:
     if let Some(dirs) = amplifier_root_dirs {
         if let Some(sink) = self_amplifier_root_report.lock().unwrap().as_ref() {
             let _ = sink.send(dirs);
         }
     }
     ```
     (`perform_refresh` is a free-standing associated fn, so the sink field rides the existing `Arc` clones — add it to the parameter list of `perform_refresh` and `spawn_background_refresh`'s cloning block at :1184-1194.)
   2. `session_watcher.rs`: start() creates the channel + registers it; the loop adds a select arm `Some(dirs) = root_report_rx.recv()` → `let mut outcome = ArmOutcome::default(); for dir in roots_needing_arm(&dirs, &book.armed, &book.retry) { arm_managed_dir(.., crate::watch_plan::ArmKind::SessionDir, emit_marks: true, &mut outcome, ..) }` then drain the outcome to the index.

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib`
  Expected: PASS.

- [ ] **Step 5: Refactor while green**
  `refresh_snapshot`'s signature/return growth is the ugliest part of the diff; if the tuple return becomes unwieldy, bundle `(items, changed, amplifier_root_dirs)` into a small private `SweepOutcome` struct (same scope, no API change). No other refactor.

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: freshell-sessions (index sweep plumbing) + freshell-server check (it constructs `SessionIndex`; only an additive setter is added).
  Run: `cargo test -p freshell-sessions && cargo check -p freshell-server`
  Expected: PASS / clean.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/directory_index.rs crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs
  git commit -m "feat(sessions): refresh-to-watcher self-correction channel for amplifier root discovery"
  ```

---

### Task 8: Per-connection `sessions.prefs` plumbing (protocol + registry + client)

**Files:**
- Modify: crates/freshell-protocol/src/client_messages.rs:16-123 (new variant + struct + CLIENT_MESSAGE_TYPES + header comment)
- Modify: crates/freshell-protocol/src/lib.rs:39-41 (stale doc-count comment)
- Modify: shared/ws-protocol.ts (new schema beside the other client-message schemas; union member in `ClientMessageSchema` :688-719)
- Modify: port/contract/ws-protocol.schema.json, port/contract/ws-server-messages.schema.json, port/contract/ws-message-inventory.json (regenerated via `npm run contract:generate`)
- Modify: crates/freshell-protocol/tests/inventory.rs:33-70 (30→31; 88→89), crates/freshell-protocol/tests/roundtrip.rs (breadth case)
- Create: crates/freshell-ws/src/subagent_interest.rs
- Modify: crates/freshell-ws/src/lib.rs (mod + WsState field), crates/freshell-ws/src/terminal.rs (dispatch arm + teardown), crates/freshell-server/src/main.rs:991-1045 (WsState literal), plus every other WsState literal workspace-wide (test constructors all gain `subagent_interest: Default::default(),`)
- Create: crates/freshell-ws/tests/sessions_prefs.rs
- Modify: src/store/subagentInterestMiddleware.ts (create), src/store/store.ts:73-90 (register), src/lib/ws-client.ts (no change needed — `send` queues-till-ready)
- Test: test/unit/client/subagent-interest-middleware.test.ts

**Interfaces:**
- Consumes: client-side send path (`getWsClient().send(...)`, `ws-client.ts:741-781`); local toggle state (`state.settings.settings.sidebar.showSubagents`, mirroring `sessionsThunks.ts:354-356`); ScreenshotBroker shape (`screenshot.rs:43-100`); dispatch + teardown seams (`terminal.rs:1208-1211`, `:582-595`).
- Produces:
  - Protocol: `ClientMessage::SessionsPrefs(SessionsPrefs)` = `{ "type": "sessions.prefs", "includeSubagents": bool }`, serde `rename_all = "camelCase"`; added to the frozen client list (`CLIENT_MESSAGE_TYPES` grows 30→31). Contract regenerated in the same commit.
  - `freshell_ws::subagent_interest::SubagentInterestRegistry` (`Clone + Default`, internally `Arc`):
    ```rust
    pub fn set(&self, conn_id: u64, interested: bool);   // idempotent; call with false on unknown ids (harmless)
    pub fn remove(&self, conn_id: u64);                  // == set(conn_id, false)
    pub fn any(&self) -> bool;
    pub fn count_handle(&self) -> std::sync::Arc<std::sync::atomic::AtomicUsize>; // cross-crate read (session watcher's subagent-mkdir gate reads `> 0`)
    ```
  - `WsState.subagent_interest: SubagentInterestRegistry`
  - `handle_client_text` arm (immediately after `ClientMessage::UiLayoutSync`, :1208-1211):
    ```rust
    /// `sessions.prefs` — the client's includeSubagents listing preference.
    /// Per-connection (design: "track the flag per WS client; clear on
    /// disconnect"); no reply frame (parity with ui.layout.sync).
    ClientMessage::SessionsPrefs(prefs) => {
        state.subagent_interest.set(conn_id, prefs.include_subagents);
        true
    }
    ```
  - Teardown line in the existing block (:582-595, alongside `registry.remove_connection`):
    ```rust
    state.subagent_interest.remove(conn_id);
    ```
  - Client middleware `subagentInterestMiddleware` (sends on change + on WS reconnect; see code below).

- [ ] **Step 1: Write the failing behavioral test**
  (a) freshness of the Rust protocol surface — append to `crates/freshell-protocol/tests/roundtrip.rs`:
  ```rust
  #[test]
  fn client_sessions_prefs_roundtrips_and_conforms() {
      let msg: ClientMessage = serde_json::from_str(
          r#"{"type":"sessions.prefs","includeSubagents":true}"#,
      )
      .expect("parse");
      assert!(
          matches!(msg, ClientMessage::SessionsPrefs(ref p) if p.include_subagents),
      );
      let back = serde_json::to_value(&msg).expect("serialize");
      assert_eq!(
          back,
          serde_json::json!({"type": "sessions.prefs", "includeSubagents": true})
      );
      // Validate against the ClientMessageSchema UNION (the same target the
      // existing `client_roundtrip` helper uses) — never the top-level
      // contract document, which constrains nothing about a message instance.
      let schema = inbound_schema()["schemas"]["ClientMessageSchema"].clone();
      assert!(!schema.is_null(), "frozen client-message schema must exist");
      assert_conforms(&validator(&schema), &back, "sessions.prefs");
  }
  ```
  (b) registry unit tests — bottom of the new `subagent_interest.rs`:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      #[test]
      fn set_any_remove_semantics() {
          let r = SubagentInterestRegistry::default();
          assert!(!r.any());
          r.set(7, true);
          assert!(r.any());
          r.set(7, true); // idempotent
          assert!(r.any());
          r.set(9, true);
          assert!(r.any());
          r.remove(7);
          assert!(r.any(), "other connection still interested");
          r.remove(42); // unknown id is a no-op
          assert!(r.any());
          r.remove(9);
          assert!(!r.any());
      }
  }
  ```
  (c) WS integration — new `crates/freshell-ws/tests/sessions_prefs.rs`, harness modeled on `ui_layout_sync.rs`. Copy wholesale from `crates/freshell-ws/tests/ui_layout_sync.rs`: the `test_settings_value()` fixture, the full `WsState { ... }` literal in `spawn_server` (all forty-odd fields, with `activity: None`, `opencode_locator: None`, `codex_locator: None`, `config_fallback: None`, `PaneLedger::disabled()` etc. exactly as they appear there; do NOT copy the layout-store/rest-router wiring), the `connect_and_hello` helper, and the `next_frame_of_type` helper. Then adapt:

  - `spawn_server` signature becomes `async fn spawn_server() -> (String, freshell_ws::subagent_interest::SubagentInterestRegistry)`: it constructs `let interest = freshell_ws::subagent_interest::SubagentInterestRegistry::default();` BEFORE the `WsState` literal, puts `subagent_interest: interest.clone(),` into the literal, serves only `freshell_ws::router(state)` (no rest_router), and returns `(format!("ws://{addr}/ws"), interest)`.

  The test itself:

  ```rust
  #[tokio::test]
  async fn subagent_interest_registry_clears_on_disconnect() {
      let (url, interest) = spawn_server().await;
      let mut ws = connect_and_hello(&url).await;
      assert!(!interest.any());

      ws.send(WsMessage::Text(
          serde_json::json!({"type":"sessions.prefs","includeSubagents":true}).to_string(),
      ))
      .await
      .unwrap();
      // Ordering barrier: ping/pong proves the frame was ingested.
      ws.send(WsMessage::Text(r#"{"type":"ping"}"#.into())).await.unwrap();
      let _ = next_frame_of_type(&mut ws, "pong").await;
      assert!(interest.any(), "frame registered");

      // Second connection subscribes too.
      let mut ws2 = connect_and_hello(&url).await;
      ws2.send(WsMessage::Text(
          serde_json::json!({"type":"sessions.prefs","includeSubagents":true}).to_string(),
      ))
      .await
      .unwrap();
      ws2.send(WsMessage::Text(r#"{"type":"ping"}"#.into())).await.unwrap();
      let _ = next_frame_of_type(&mut ws2, "pong").await;
      assert!(interest.any());

      // First disconnects: still armed (second remains).
      drop(ws);
      tokio::time::sleep(Duration::from_millis(200)).await;
      assert!(interest.any(), "one remaining connection keeps the gate on");

      // Last disconnect: clears (regression 15's stop-on-disconnect).
      drop(ws2);
      tokio::time::timeout(Duration::from_secs(3), async {
          loop {
              if !interest.any() {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("cleared when the last interested connection left");
  }
  ```
  (d) TS middleware test — `test/unit/client/subagent-interest-middleware.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { configureStore } from '@reduxjs/toolkit'
  import { settingsSlice, updateSettingsLocal } from '../../../src/store/settingsSlice'
  import { subagentInterestMiddleware } from '../../../src/store/subagentInterestMiddleware'

  const { mockSend, reconnectHandlers } = vi.hoisted(() => ({
    mockSend: vi.fn(),
    reconnectHandlers: [] as Array<() => void>,
  }))

  vi.mock('@/lib/ws-client', () => ({
    getWsClient: () => ({
      send: mockSend,
      onReconnect: (h: () => void) => {
        reconnectHandlers.push(h)
      },
    }),
  }))

  function makeStore() {
    return configureStore({
      reducer: { settings: settingsSlice.reducer },
      middleware: (g) => g().concat(subagentInterestMiddleware),
    })
  }

  describe('subagentInterestMiddleware', () => {
    it('sends sessions.prefs on the first observed action and on toggle changes', () => {
      mockSend.mockClear()
      const store = makeStore()
      store.dispatch({ type: 'any/action' })
      expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: false })
      mockSend.mockClear()

      store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: true } }))
      expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: true })
      mockSend.mockClear()

      store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: false } }))
      expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: false })
    })

    it('re-sends current preference after a WS reconnect', () => {
      mockSend.mockClear()
      reconnectHandlers.length = 0
      const store = makeStore()
      store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: true } }))
      mockSend.mockClear()
      for (const h of reconnectHandlers) h()
      expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: true })
    })
  })
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run:
  - `cargo test -p freshell-protocol`
  - `cargo test -p freshell-ws --lib subagent_interest`
  - `cargo test -p freshell-ws --test sessions_prefs`
  - `npm run test:vitest -- run test/unit/client/subagent-interest-middleware.test.ts`
  Expected: FAIL — `ClientMessage::SessionsPrefs` does not exist (roundtrip parse/assert fails; inventory still declares 30/88 so `inventory.rs` fails too); `subagent_interest` module missing; integration test gets no registry (module missing → harness doesn't compile); TS middleware file missing (module resolution error).

- [ ] **Step 3: Add the minimal production implementation**
  1. Protocol — `crates/freshell-protocol/src/client_messages.rs`:
     ```rust
     #[serde(rename = "sessions.prefs")]
     SessionsPrefs(SessionsPrefs),
     ```
     (place after `Ping` in the enum); and:
     ```rust
     // --- sessions.prefs ---------------------------------------------------------
     /// The client's includeSubagents listing preference (amplifier watch
     /// reduction). Per-connection, pushed mid-session and on (re)connect;
     /// old servers never receive it (frozen client) and new servers ignore
     /// it on connections that never send one.
     #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
     #[serde(rename_all = "camelCase")]
     pub struct SessionsPrefs {
         pub include_subagents: bool,
     }
     ```
     Header comment :1 "30 discriminants" → 31; `CLIENT_MESSAGE_TYPES: [&str; 31]`, insert `"sessions.prefs"` alphabetically. `crates/freshell-protocol/src/lib.rs:39-40` doc "(29 client→server + 56 server→client = 85)" is already stale (tests pin 30+58=88) — correct it to "(31 client→server + 58 server→client = 89)". `tests/inventory.rs`: `Some(31)`, `actual.len(), 31`, `all.len(), 89`, `unique.len(), 89`.
  2. shared/ws-protocol.ts (after `PingSchema`, wherever the other client schemas live):
     ```ts
     export const SessionsPrefsSchema = z.object({
       type: z.literal('sessions.prefs'),
       includeSubagents: z.boolean(),
     })
     export type SessionsPrefs = z.infer<typeof SessionsPrefsSchema>
     ```
     and add `SessionsPrefsSchema` to `ClientMessageSchema`'s union list (:688-719).
  3. Regenerate + pin, all in this commit:
     ```bash
     npm run contract:generate
     git diff -- port/contract/
     npm run test:port
     ```
     Commit every regenerated file (`ws-protocol.schema.json`, `ws-server-messages.schema.json`, `ws-message-inventory.json` — the last adds `"sessions.prefs"`, count 30→31).
  4. Registry — the `SubagentInterestRegistry` module exactly as in Interfaces; `pub mod subagent_interest;` in freshell-ws `lib.rs` (alphabetical); `WsState` field immediately after `screenshots` (:224-228) with the doc comment; EVERY `WsState {}` literal gets the field (production `main.rs:991-1045` gets the real instance — create `let subagent_interest = freshell_ws::subagent_interest::SubagentInterestRegistry::default();` beside `screenshots` at :317-321; test constructors get `subagent_interest: Default::default(),`). The compiler lists every missing site — iterate until `cargo check -p freshell-ws --all-targets` and `cargo check -p freshell-server --all-targets` are clean. Known sites today: `main.rs:991`; `freshell-ws/src/lib.rs:863`; `terminal.rs:5942/6172`; `codex_association.rs:284`; `codex_proxy_route.rs:233`; `opencode_association.rs:408`; `spawn_gate.rs` test state; `freshell-ws/tests/common/mod.rs` + 27 more test files with a `WsState {}` literal (48 literals total at this base).
  5. Dispatch arm + teardown (see Interfaces code).
  6. Client middleware — `src/store/subagentInterestMiddleware.ts`:
     ```ts
     import type { Middleware } from '@reduxjs/toolkit'
     import { getWsClient } from '@/lib/ws-client'

     /**
      * Pushes the sidebar's `showSubagents` preference to the server
      * (`sessions.prefs`). The server's per-connection registry (amplifier
      * watch reduction: subagent rescan cadence) is connection-scoped, so we
      * re-send on every reconnect. `ws.send` queues until the connection is
      * ready, so the first send during boot/order is safe.
      */
     export const subagentInterestMiddleware: Middleware = (store) => {
       let lastSent: boolean | null = null

       const sendCurrent = () => {
         const interested =
           (store.getState() as { settings?: { settings?: { sidebar?: { showSubagents?: boolean } } } })
             .settings?.settings?.sidebar?.showSubagents === true
         if (interested === lastSent) return
         lastSent = interested
         getWsClient().send({ type: 'sessions.prefs', includeSubagents: interested })
       }

       getWsClient().onReconnect(() => {
         lastSent = null
         sendCurrent()
       })

       return (next) => (action) => {
         const result = next(action)
         sendCurrent()
         return result
       }
     }
     ```
     Register in `src/store/store.ts` concat list right after `layoutMirrorMiddleware,` (:85):
     ```ts
     subagentInterestMiddleware,
     ```
     (with the import). NOTE the deprecated alias: if eslint's `import/no-cycle` complains about ws-client at middleware-init time, defer `getWsClient()` to the first `sendCurrent()` — current import shape already behaves (layoutMirrorMiddleware does the same lazy pattern).

- [ ] **Step 4: Run the focused tests**
  Run: `cargo test -p freshell-protocol && cargo test -p freshell-ws --lib subagent_interest && cargo test -p freshell-ws --test sessions_prefs && npm run test:vitest -- run test/unit/client/subagent-interest-middleware.test.ts && npm run typecheck:client`
  Expected: PASS across the board.

- [ ] **Step 5: Refactor while green**
  Old servers/clients stay compatible (accept-and-strip on the server for unknown frames; the message is additive). Frozen clients (an older bundle) never send `sessions.prefs`, so the cadence defaults to OFF for them — deliberate and safe: subagent rows then refresh at the existing 15-minute TTL reconcile, exactly today's post-watch-reduction idle behavior anyway; the toggle simply becomes "event-driven + ≤15s cadence" only for clients with the new bundle. Confirm no double-send risk at boot (the first send carries `false` when the toggle is off — harmless: the server treats an explicit false identically to never-sent). Check `sessionsPrefs` isn't validated into the TS `ClientMessage` runtime on the client for OUTBOUND (it isn't — outbound is raw objects; the zod union only guards the port contract).

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: freshell-protocol (whole), freshell-ws (whole — WsState field touched ALL constructors and it's the connect path), freshell-server (compile + unit — it holds the production literal), the client unit suite + port contract.
  Run: `cargo test -p freshell-protocol -p freshell-ws --no-fail-fast && cargo test -p freshell-server --no-fail-fast && npm run test:vitest -- run test/unit/client && npm run test:port`
  Expected: PASS.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/lib.rs crates/freshell-protocol/tests/inventory.rs crates/freshell-protocol/tests/roundtrip.rs shared/ws-protocol.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json crates/freshell-ws/src/subagent_interest.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/sessions_prefs.rs crates/freshell-server/src/main.rs src/store/subagentInterestMiddleware.ts src/store/store.ts test/unit/client/subagent-interest-middleware.test.ts
  # plus any other WsState-literal files the compiler forced to change (list them via git status)
  git add -A crates/freshell-ws
  git commit -m "feat(protocol,ws): per-connection includeSubagents interest via sessions.prefs"
  ```

---

### Task 9: Demand-driven 15s amplifier subagent rescan cadence + startup watcher-ready barrier

**Files:**
- Create: crates/freshell-server/src/subagent_cadence.rs
- Modify: crates/freshell-server/src/main.rs (mod registration; construction; watcher construction at :702-728 gains `.with_subagent_interest(...)`; new spawn next to `spawn_sessions_sweep` at :1279-1284; the gate install `index.set_startup_gate(watcher.startup_ready())` inside the :702-731 closure, BETWEEN construction and `watcher.start()` :726)
- Modify: crates/freshell-sessions/src/session_watcher.rs (the startup-ready watch channel + signal inside `run_watcher_loop` + the receiver-cloning `startup_ready()` accessor)
- Modify: crates/freshell-sessions/src/directory_index.rs (the cold-start publish gate: `startup_gate` field + `set_startup_gate` + the cold-only consult on the two publish entries)
- Test: crates/freshell-sessions/src/session_watcher_tests.rs (extends the Task 3 startup-race fixture with the production-order gate coverage)

**Interfaces:**
- Consumes: `SubagentInterestRegistry` (Task 8); `SessionIndex::mark_provider_dirty` (`directory_index.rs:1016-1022`); the scoped sweep semantics (`:1575-1585` discover gate; `:1699-1711` provider-scoped prune); Task 3's `SessionWatcher::with_subagent_interest`.
- Produces:
  - `SUBAGENT_CADENCE_INTERVAL: Duration = Duration::from_secs(15)` (design value)
  - `pub fn spawn_subagent_cadence(index: Arc<SessionIndex>, interest: SubagentInterestRegistry, interval: Duration) -> tokio::task::JoinHandle<()>` — separate task per the explorer's recommendation (option 1; NOT a third select arm of `spawn_sessions_sweep`):
    ```rust
    //! Demand-driven amplifier subagent rescan cadence (amplifier watch
    //! reduction design, lines 114-146).
    //!
    //! While ANY connected WS client has declared includeSubagents interest
    //! (see `freshell_ws::subagent_interest`), a 15s heartbeat calls
    //! `index.mark_provider_dirty("amplifier")` — an amplifier-only full
    //! `discover` (refresh gate directory_index.rs:1575-1585) with
    //! amplifier-only prune (:1699-1711) — NEVER the index-global TTL (a
    //! `force_full` sweep would reconcile Claude/Codex/OpenCode every 15s,
    //! :1237-1241) and NEVER a fetch-recency window (broadcast-driven clients
    //! quiet-starve; the interest gate is per-connection, cleared on
    //! disconnect — Task 8).
    use std::sync::Arc;
    use std::time::Duration;

    use freshell_sessions::directory_index::SessionIndex;
    use freshell_ws::subagent_interest::SubagentInterestRegistry;

    /// Design cadence: 15s. Warm amplifier discover ≈ 0.65s warm (measured
    /// 2026-08-18 on the 22,300-dir real corpus; supersedes the design's
    /// ~0.3s estimate) — ~4.2% of a core while any interested client is
    /// connected; zero while none.
    pub const SUBAGENT_CADENCE_INTERVAL: Duration = Duration::from_secs(15);

    pub fn spawn_subagent_cadence(
        index: Arc<SessionIndex>,
        interest: SubagentInterestRegistry,
        interval: Duration,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.tick().await; // consume the immediate first tick (main.rs cadence convention)
            loop {
                ticker.tick().await;
                if interest.any() {
                    index.mark_provider_dirty("amplifier");
                }
            }
        })
    }
    ```
  - Startup watcher-ready barrier + cold-start publish gate (makes the design's "the full discover that FOLLOWS covers it" (lines 48-49, 165-167) deterministic — Task 3's startup arms deliberately skip the file-state stream, so the FIRST session-index publish of the process must be provably ordered AFTER those arms; a metadata.json written after an early scan's readdir but before its session dir's structural arm would otherwise be armed marklessly and sit stale until the 15-minute reconcile):
    - EVERY boot-time `snapshot()`/discover entry point (verified against current `main.rs` and its callees): ① the boot warm spawn (`main.rs:1264-1273`, `snapshot()` at :1266), ② `spawn_sessions_sweep`'s initial signature snapshot (`main.rs:2606`, spawned :1279-1284 — UNGATED today: it can populate a fresh 15-minute TTL cache before the watcher finishes arming, after which even a gated warm `snapshot()` would serve that cache without discovering again — the production race this task closes), ③ `spawn_auto_title_sweep`'s first pass (`auto_title_sweep.rs:548` — first wake on a change notification or the 5s tick; spawned `main.rs:1290-1307`), ④ request-serving handlers reachable once the listener binds, pre-readiness: the session-directory listing (`session_directory.rs:421`), the sessions key lookup (`sessions.rs:273`), the diag debug body (`diag.rs:198`), and the WS existence probe's `kick_refresh` (`existence.rs:189`), ⑤ `mark_dirty`/`mark_provider_dirty` → `request_refresh` (`directory_index.rs:990-994` — this task's own cadence included). ALL of these POPULATE the TTL snapshot cache when it is cold or stale — that is how they behave today (cold: run the full discover inline and publish, `run_refresh_inline` directory_index.rs:1076-1077; stale: `spawn_background_refresh`, :1073) — there is no persisted ROW cache a handler could serve instead (the persisted parse cache only accelerates the inline sweep), so the gate goes on the populating path itself, not on any callsite.
    - The formulation — ONE cold-start gate inside `SessionIndex`, airtight because TTL publishes flow through exactly two entries: `SessionIndex::set_startup_gate(&self, ready: tokio::sync::watch::Receiver<bool>)` installs an optional gate (field default `None`; no watcher ⇒ no gate ⇒ today's exact behavior). `run_refresh_inline` AND the spawned task inside `spawn_background_refresh` open with a cold-only consult: while a gate is installed AND no snapshot has ever been published, await `gate.wait_for(|done| *done)` before sweeping (fail-OPEN on sender drop — a crashed watcher task must never wedge session serving; holding the refresh lock across the wait is deadlock-free because the readiness send happens in the watch loop and every index touch on that path reaches `request_refresh`'s non-blocking `try_lock`). After the first publish the consult is a one-lock `is_some` no-op — steady-state request/sweep paths pay nothing. Cold pre-readiness requests now await readiness inside the index instead of running their own inline pre-arm discover (bounded by the boot window; `/api/health` and every non-session route never touch the index). NO boot callsite — warm spawn, sessions sweep, auto-title sweep, routes — grows a per-site barrier.
    - The watcher side (receiver-CLONING accessor — production call order construct → consumers subscribe → `start()`; no moved-sender trap): `SessionWatcher::new` creates the `tokio::sync::watch::channel(false)` pair ONCE and stores BOTH ends; `SessionWatcher::startup_ready(&self) -> tokio::sync::watch::Receiver<bool>` returns a CLONE of the retained `Receiver` (`watch::Receiver` is `Clone` — any number of consumers subscribe, before or after `start()`, identically); `start()` moves ONLY the `Sender` into `run_watcher_loop`. `watch`, not a bare `Notify`: the sender may fire BEFORE any awaiter exists, and `Notify::notify_waiters` loses such signals (the task would hang forever); the watch receiver's `wait_for(|done| *done)` returns immediately once the value is set regardless of when it was set. `run_watcher_loop` sends `true` ONCE after the initial startup arming pass for EVERY configured provider has SETTLED (legacy recursive arms completed; the amplifier `spawn_blocking` plan+apply JoinHandle resolved AND its `ArmOutcome` drained into the index — `marks` → `index.mark_dirty`, `provider_dirty` → `index.mark_provider_dirty("amplifier")` — so the first post-gate publish consumes them; success OR planner-`Err` absent-branch alike: a failed plan must never wedge the boot sweeps), before the select loop begins.
    - main.rs wiring (production call order: construct → subscribe+install → start): inside the watcher construction closure (:702-731), between the `SessionWatcher::new(...)`/`.with_subagent_interest(...)` construction and `watcher.start()` (:726):
      ```rust
      // Watch-reduction cold-start gate: every boot-time session-index
      // publish (warm spawn :1266, sessions-sweep initial :2606, auto-title
      // first pass, pre-readiness routes, mark-driven background refreshes)
      // funnels through the index's two publish entries; installing the
      // receiver HERE — before start() — orders the FIRST publish after the
      // watcher reports startup arms settled.
      index.set_startup_gate(watcher.startup_ready());
      ```
- [ ] **Step 1: Write the failing behavioral test**
  Create `crates/freshell-server/src/subagent_cadence.rs` containing ONLY the `#[cfg(test)] mod tests` below, AND register `mod subagent_cadence;` in `crates/freshell-server/src/main.rs` (alphabetical with the other `mod` decls at the top, ~:46 region) IN THE SAME EDIT — module registration is part of the test edit, so the RED run compiles the failing tests into the tree. The test module is import-self-contained (its own `Duration` and `SubagentInterestRegistry` imports — the file has no production header yet), so its only unresolved names are the production items reaching it through `use super::*`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use std::time::Duration;

      use freshell_sessions::directory_index::{
          FileStat, IndexedSession, SessionIndex, SessionSource,
      };
      use freshell_ws::subagent_interest::SubagentInterestRegistry;
      use std::path::{Path, PathBuf};
      use std::sync::atomic::{AtomicUsize, Ordering};
      use std::sync::Arc;

      async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
          let start = std::time::Instant::now();
          loop {
              if predicate() {
                  return true;
              }
              if start.elapsed() >= timeout {
                  return false;
              }
              tokio::time::sleep(Duration::from_millis(10)).await;
          }
      }

      /// Local in-crate counting double (mirror of directory_index.rs'
      /// CountingSource — private there). One fake item per source.
      struct CountingSource {
          name: &'static str,
          calls: Arc<AtomicUsize>,
      }

      impl SessionSource for CountingSource {
          fn discover(&self) -> Vec<FileStat> {
              self.calls.fetch_add(1, Ordering::SeqCst);
              vec![FileStat {
                  path: PathBuf::from(format!("mem://{}", self.name)),
                  mtime_ms: 0,
                  size: 0,
              }]
          }
          fn parse(&self, _path: &Path) -> Option<IndexedSession> {
              None
          }
          fn provider_name(&self) -> Option<&'static str> {
              Some(self.name)
          }
      }

      /// Regressions 2 / 12 / 15: while ANY connection is interested, the
      /// cadence marks amplifier and ONLY amplifier; through quiet periods; and
      /// stops when the last interest goes away.
      #[tokio::test]
      async fn cadence_marks_amplifier_only_while_interested_and_stops_when_last_interest_leaves() {
          let amp_calls = Arc::new(AtomicUsize::new(0));
          let claude_calls = Arc::new(AtomicUsize::new(0));
          let codex_calls = Arc::new(AtomicUsize::new(0));
          let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
              vec![
                  Arc::new(CountingSource { name: "amplifier", calls: Arc::clone(&amp_calls) })
                      as Arc<dyn SessionSource>,
                  Arc::new(CountingSource { name: "claude", calls: Arc::clone(&claude_calls) })
                      as Arc<dyn SessionSource>,
                  Arc::new(CountingSource { name: "codex", calls: Arc::clone(&codex_calls) })
                      as Arc<dyn SessionSource>,
              ],
              Duration::from_secs(3600),
              None,
          ));
          let _ = index.snapshot().await; // seed all three providers (1 discover each)
          assert_eq!(amp_calls.load(Ordering::SeqCst), 1);
          assert_eq!(claude_calls.load(Ordering::SeqCst), 1);

          let interest = SubagentInterestRegistry::default();
          let handle = spawn_subagent_cadence(
              Arc::clone(&index),
              interest.clone(),
              Duration::from_millis(60), // fast test cadence
          );

          // No interest: nothing ticks.
          tokio::time::sleep(Duration::from_millis(300)).await;
          assert_eq!(amp_calls.load(Ordering::SeqCst), 1, "no interest ⇒ no marks");

          // Interested: cadence ticks amplifier only — and keeps ticking through
          // quiet periods with NO further fetch traffic (connected-client
          // gating, regression 15's quiet-period clause).
          interest.set(7, true);
          assert!(
              wait_until(Duration::from_secs(2), || amp_calls.load(Ordering::SeqCst) >= 4).await,
              "≥3 cadence ticks mark amplifier"
          );
          assert_eq!(claude_calls.load(Ordering::SeqCst), 1, "claude untouched (regression 12)");
          assert_eq!(codex_calls.load(Ordering::SeqCst), 1, "codex untouched");
          // NOTE (regression 12 precision): opencode's cheap change-token read
          // still runs per scoped sweep (directory_index.rs:1509-1514) — by
          // design — but its discover/direct_list is NOT re-armed. Not pinned
          // here (no opencode source in this index).
          tokio::time::sleep(Duration::from_millis(400)).await;
          assert!(
              amp_calls.load(Ordering::SeqCst) >= 5,
              "ticks continue through quiet periods ({} ≥ 5)",
              amp_calls.load(Ordering::SeqCst)
          );

          // Second connection joins, first leaves: still armed (regression 15
          // middle clause).
          interest.set(9, true);
          interest.remove(7);
          let keep = amp_calls.load(Ordering::SeqCst);
          assert!(
              wait_until(Duration::from_secs(2), || amp_calls.load(Ordering::SeqCst) > keep).await,
              "one remaining interest keeps the cadence live"
          );

          // Last disconnect: the cadence stops (regressions 2/15 ending clause).
          interest.remove(9);
          let stop_at = amp_calls.load(Ordering::SeqCst);
          tokio::time::sleep(Duration::from_millis(400)).await;
          assert_eq!(
              amp_calls.load(Ordering::SeqCst),
              stop_at,
              "no interested connection ⇒ no marks"
          );

          handle.abort();
      }
  }
  ```

  (b) the startup-barrier regression — append to `crates/freshell-sessions/src/session_watcher_tests.rs` (extends Task 3's `startup_arms_session_dirs_created_in_the_scan_arm_window` fixture with the raced metadata write, in PRODUCTION boot order — no `mark_provider_dirty` the production boot sequence does not make):

  ```rust
  /// Startup-barrier race, PRODUCTION ORDER (extends
  /// `startup_arms_session_dirs_created_in_the_scan_arm_window`): the real
  /// boot race is the detached sweep tasks issued while the watcher arms —
  /// the warm spawn (`main.rs:1266`) AND `spawn_sessions_sweep`'s initial
  /// signature snapshot (`main.rs:2606`). The cold-start publish gate
  /// (`SessionIndex::set_startup_gate`, fed by `SessionWatcher::startup_ready`)
  /// must hold the FIRST publish until the startup arms settle, so a metadata
  /// write landing in the scan↔arm window is visible in that SAME boot
  /// snapshot — never stale until the 15-minute reconcile.
  #[tokio::test]
  async fn boot_snapshot_gate_covers_window_raced_writes() {
      let home = unique_temp_dir("amp-barrier");
      let _pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      // Production order (main.rs): construct → consumers subscribe via
      // `startup_ready()` → `start()`. The accessor clones the retained
      // receiver, so the gate install AND this test's awaiter both subscribe
      // before start — exactly as the main.rs wiring does.
      index.set_startup_gate(watcher.startup_ready());
      let mut ready = watcher.startup_ready();
      let book = watcher.amplifier_book_handle().unwrap();

      // The sessions sweep's boot snapshot (main.rs:2606): issued
      // immediately, pre-start — the task that raced ahead ungated in
      // production.
      let mut early = tokio::spawn({
          let index = Arc::clone(&index);
          async move { index.snapshot().await }
      });

      // The raced write: lands after the sweep's call, before its arm
      // (startup is markless by design).
      let racer = write_amplifier_session(&home, "p", "cc2584be-9478-4801-a62d-4e5da428b3a0");

      // Deterministic gate proof (no sleep-race): `timeout` DRIVES `early` —
      // ungated, the snapshot completes right here (a pre-arm publish, the
      // bug, and the assertion fails); gated, it can only still be pending —
      // the gate cannot open because `start()` has not been called, so the
      // 250ms window's length decides nothing.
      assert!(
          tokio::time::timeout(Duration::from_millis(250), &mut early)
              .await
              .is_err(),
          "the boot sweep's snapshot is gated: no publish before watcher readiness"
      );

      let handle = watcher.start();

      // Readiness fires only AFTER the startup arms settle; the raced dir is
      // provably armed by then.
      tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|done| *done))
          .await
          .expect("startup readiness fires")
          .expect("sender alive");
      assert!(
          book.lock().unwrap().armed.contains(&racer),
          "readiness implies the raced dir is armed"
      );

      // The boot sweep's OWN snapshot — the first post-readiness publish —
      // covers the window-raced write. NO provider-dirty kick: the production
      // boot sequence makes no such call.
      let items = tokio::time::timeout(Duration::from_secs(5), early)
          .await
          .expect("the gated snapshot completes after readiness")
          .unwrap();
      assert!(
          items.iter().any(|s| s.provider == "amplifier"
              && s.session_id == "cc2584be-9478-4801-a62d-4e5da428b3a0"),
          "the first post-readiness publish covers the window-raced write"
      );
      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-server subagent_cadence` and `cargo test -p freshell-sessions --lib session_watcher`
  Expected: FAIL because the tests — compiled into the tree (the module IS registered; registration was part of the Step-1 test edit) — reference `spawn_subagent_cadence` through `use super::*`, and it does not exist yet (E0425-family unresolved-name compile errors, not a syntax accident); and because the sessions test references `SessionWatcher::startup_ready` AND `SessionIndex::set_startup_gate`, neither of which exists yet (same E0425/E0599-family compile failures in `session_watcher_tests`).

- [ ] **Step 3: Add the minimal production implementation**
  1. Prepend the module doc + imports + `SUBAGENT_CADENCE_INTERVAL` + `spawn_subagent_cadence` code (the Interfaces block above) to `crates/freshell-server/src/subagent_cadence.rs`, ABOVE the tests written in Step 1. The production header's own `use std::time::Duration;` / `use std::sync::Arc;` / `use freshell_ws::subagent_interest::SubagentInterestRegistry;` imports are used by the const and the fn signature; the test module's same-named explicit imports shadow the `super::*` glob cleanly (no unused-import or ambiguity fallout under the clippy `-D warnings` gate).
  2. `main.rs`: `mod subagent_cadence;` is already registered (Step 1) — nothing further here.
  3. `main.rs` construction: `let subagent_interest = freshell_ws::subagent_interest::SubagentInterestRegistry::default();` beside `screenshots` (:317-321) if Task 8 didn't already add it; wire the same instance into the `WsState` literal (`subagent_interest: subagent_interest.clone(),` at :991-1045 — Task 8 did the field) and into the session watcher construction (:722-725):
     ```rust
     let mut watcher = freshell_sessions::session_watcher::SessionWatcher::new(
         Arc::clone(index),
         providers,
     )
     .with_subagent_interest(subagent_interest.count_handle());
     ```
   4. Spawn the cadence inside the `if let Some(index) = &session_index { ... }` block, immediately after `spawn_sessions_sweep` (:1279-1284):
      ```rust
      // Amplifier watch-reduction kata: demand-driven subagent rescan cadence
      // (15s while any connected WS client lists subagents; zero otherwise).
      subagent_cadence::spawn_subagent_cadence(
          Arc::clone(index),
          subagent_interest.clone(),
          subagent_cadence::SUBAGENT_CADENCE_INTERVAL,
      );
      ```
   5. The watcher-ready channel + cold-start publish gate (per Interfaces):
      - `session_watcher.rs` — `SessionWatcher::new` creates the `watch::channel(false)` pair ONCE and stores BOTH ends (the `Sender` field AND the retained `Receiver` field). `startup_ready(&self) -> tokio::sync::watch::Receiver<bool>` returns a CLONE of the retained receiver (`watch::Receiver` is `Clone` — consumers subscribe before or after `start()`, identically). `start()` moves ONLY the `Sender` into `run_watcher_loop`, which sends `true` once, after the full initial arming pass for every provider has settled (for amplifier: after the `spawn_blocking` plan+apply JoinHandle has resolved AND the returned `ArmOutcome` has been drained into the index — `marks` → `index.mark_dirty`, `provider_dirty` → `index.mark_provider_dirty("amplifier")` — so the first post-gate publish consumes them; including the planner-`Err` absent branch, which must never wedge the sweeps), before the select loop begins. The round-3 review's moved-sender contradiction cannot arise: the accessor never touches the sender.
      - `directory_index.rs` — `SessionIndex` gains the `startup_gate` field (`Arc<StdMutex<Option<tokio::sync::watch::Receiver<bool>>>>`, default `None`) and `pub fn set_startup_gate(&self, ready: tokio::sync::watch::Receiver<bool>)` (install-once at boot; `None` watcher ⇒ no gate ⇒ today's exact behavior). `run_refresh_inline` AND the spawned task inside `spawn_background_refresh` open with a cold-only consult: while a gate is installed AND no snapshot has ever been published, `let _ = gate.wait_for(|done| *done).await;` before sweeping (fail-OPEN on sender drop — a crashed watcher task must never wedge session serving). Holding the refresh lock across the wait is deadlock-free: the readiness send is in the watch loop, and every index touch on that path goes through `request_refresh`'s non-blocking `try_lock`. After the first publish the consult is a one-lock `is_some` no-op — steady-state request/sweep paths pay nothing.
      - `main.rs` — inside the watcher construction closure (:702-731), insert the gate install BETWEEN the `SessionWatcher::new(...)`/`.with_subagent_interest(...)` construction (item 3) and `watcher.start()` (:726): `index.set_startup_gate(watcher.startup_ready());` (exact code block in Interfaces). NO other main.rs site changes: the boot warm spawn (:1257-1273), `spawn_sessions_sweep`'s initial snapshot (:2606), and `spawn_auto_title_sweep` (:1290-1307) all funnel through the gated publish entries and need no per-callsite barrier; the request routes are code-untouched (a cold pre-readiness request now awaits readiness inside the index instead of running its own inline pre-arm discover — bounded by the boot window; `/api/health` and non-session routes never touch the index).

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-server subagent_cadence && cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS (cadence tests + the barrier test + the existing watcher suite).

- [ ] **Step 5: Refactor while green**
  The module is standalone and small; nothing to refactor. Confirm the spawn is inside the `session_index.is_some()` block (no index ⇒ no cadence, matching the sessions sweep), that the gate consult fires only while NO snapshot has ever been published (a post-boot stale-while-revalidate refresh never waits on it), and that no sweep/route callsite grew a per-site barrier.

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: freshell-server full suite (main.rs construction changed: four interaction points — registry instance, watcher builder call, gate install, cadence spawn) + the FULL freshell-sessions lib suite (the gate touches `directory_index.rs`'s two publish entries — the cold-path, stale-while-revalidate, and persisted-cache tests there must stay green alongside session_watcher).
  Run: `cargo test -p freshell-server --no-fail-fast && cargo test -p freshell-sessions --lib`
  Expected: PASS.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-server/src/subagent_cadence.rs crates/freshell-server/src/main.rs crates/freshell-sessions/src/session_watcher.rs crates/freshell-sessions/src/session_watcher_tests.rs crates/freshell-sessions/src/directory_index.rs
  git commit -m "feat(server): demand-driven 15s amplifier subagent rescan cadence + startup watcher-ready barrier"
  ```

---

### Task 10: Watch-count reduction proof + root-latency pin + real-corpus discover measure

**Files:**
- Test: crates/freshell-sessions/src/session_watcher_tests.rs
- Modify: crates/freshell-sessions/src/amplifier.rs (ignored probe test only)

**Interfaces:**
- Consumes: `SessionWatcher::amplifier_book_handle` (Task 3); everything above.

- [ ] **Step 1: Write the failing behavioral test**
  Append to `session_watcher_tests.rs`:

  ```rust
  /// THE proof: a 12-project corpus arms EXACTLY
  /// 1 (projects root) + 12 (sessions dirs) + 4 (stand-ins) + 12×3 (root session dirs) = 53
  /// watches — never a subagent dir, never context-intelligence — while every
  /// root session (incl. one old+externally-resumed) updates instantly through
  /// the real watcher path and all 72 subagent rows still index.
  #[tokio::test]
  async fn amplifier_managed_watch_set__proof_of_reduction_and_root_liveness() {
      let home = unique_temp_dir("amp-proof");
      let projects_with_sessions = 12usize;
      let roots_per = ["012584be-9478-4801-a62d-4e5da428b3a0", "aa2584be-9478-4801-a62d-4e5da428b3a0"];
      let subagents_per = [
          "0000000000000000-014b6af1c2ac4ab5_a",
          "1111111111111111-2222222222222222_b",
          "3333333333333333-4444444444444444_c",
      ];
      // Twelve with sessions/, four stand-ins.
      for i in 0..projects_with_sessions {
          let slug = format!("proj_{i}");
          for id in roots_per {
              let dir = write_amplifier_session(&home, &slug, id);
              std::fs::write(
                  dir.join("metadata.json"),
                  format!(
                      r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"d","turn_count":1}}"#
                  ),
              )
              .unwrap();
          }
          for id in subagents_per {
              let dir = write_amplifier_session(&home, &slug, id);
              // parent_id present ⇒ subagent row content (rows still index).
              std::fs::write(
                  dir.join("metadata.json"),
                  format!(
                      r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","parent_id":"x","created":"2026-03-01T00:00:00.000Z"}}"#
                  ),
              )
              .unwrap();
          }
          // One oddball root per project (drift alarm input) + a CI subtree.
          write_amplifier_session(&home, &slug, &format!("oddball-{i}"));
          std::fs::create_dir_all(
              projects_with_sessions_path(&home, &slug, roots_per[0]).join("context-intelligence"),
          )
          .unwrap();
      }
      for i in 0..4usize {
          std::fs::create_dir_all(home.join("projects").join(format!("standin_{i}"))).unwrap();
      }

      let index = amplifier_index(&home);
      let mut watcher = amplifier_watcher(&index, &home);
      let book = watcher.amplifier_book_handle().unwrap();
      let mut rx = index.subscribe_changes();
      let handle = watcher.start();
      let _ = index.snapshot().await;
      tokio::time::timeout(Duration::from_secs(10), async {
          loop {
              if book.lock().unwrap().armed.len() >= 53 {
                  break;
              }
              tokio::time::sleep(Duration::from_millis(50)).await;
          }
      })
      .await
      .expect("full arm pass");

      let expected = 1 + projects_with_sessions + 4 + projects_with_sessions * 3;
      {
          let b = book.lock().unwrap();
          assert_eq!(b.armed.len(), expected, "exact planned watch count");
          // Never watched: any subagent-pattern dir or anything below a
          // session dir (context-intelligence).
          for p in &b.armed {
              let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
              assert!(
                  crate::watch_plan::classify_basename(name) != crate::watch_plan::BasenameClass::Subagent,
                  "armed a subagent dir: {}",
                  p.display()
              );
              assert!(!name.starts_with("context-intelligence"));
          }
          drop(b);
      }

      // Subagent rows still exist (discover covers the whole corpus).
      let snap = index.snapshot().await;
      let amps = snap.iter().filter(|s| s.provider == "amplifier").count();
      assert_eq!(amps, projects_with_sessions * (2 + 3 + 1), "every row indexed (roots + subagents + oddball)");

      // Zero-latency-regression pin: an OLD root session (created at startup,
      // never touched since) gets an external-resume write and still updates
      // instantly through the real watched path.
      let _ = rx.borrow_and_update();
      let old_root = projects_with_sessions_path(&home, "proj_3", roots_per[0]);
      std::fs::write(old_root.join("transcript.jsonl"), "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"resumed\"}}\n").unwrap();
      let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
      assert!(changed.is_ok(), "old root session stays instantly fresh");

      watcher.stop();
      let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
      std::fs::remove_dir_all(&home).ok();
  }

  fn projects_with_sessions_path(home: &Path, slug: &str, id: &str) -> PathBuf {
      home.join("projects").join(slug).join("sessions").join(id)
  }
  ```

  Plus the real-corpus timing probe in `amplifier.rs`'s `mod tests`:

  ```rust
  /// Manual probe: warm full-discover duration on the REAL amplifier home.
  /// The 15s cadence's cost was the design's ~0.3s/~2% estimate; measured
  /// 2026-08-18 on the real corpus (22,300 session dirs and growing): ~0.65s
  /// warm mean → ~4.2% of a core at the 15s cadence, with ~1.9× headroom to
  /// the 1.0s falsification threshold (LB-02). The probe here re-measures it
  /// on demand rather than gating CI.
  ///
  ///   cargo test -p freshell-sessions --lib measure_real_home_discover -- --ignored --nocapture
  #[test]
  #[ignore = "manual real-corpus probe"]
  fn measure_real_home_discover() {
      let home = std::env::var("FRESHELL_AMPLIFIER_HOME")
          .map(std::path::PathBuf::from)
          .or_else(|| std::env::var("HOME").ok().map(|h| std::path::PathBuf::from(h).join(".amplifier")))
          .filter(|h| h.join("projects").is_dir());
      let Some(home) = home else {
          eprintln!("no real amplifier home present; skipping");
          return;
      };
      let source = AmplifierSource::new(home);
      // Cold-ish pass, then two warm passes.
      let _ = source.discover();
      for pass in 0..3 {
          let start = std::time::Instant::now();
          let stats = source.discover();
          println!("real-home warm discover pass {pass}: {} files in {:?}", stats.len(), start.elapsed());
      }
  }
  ```

- [ ] **Step 2: Run the test and verify the intended failure**
  Run: `cargo test -p freshell-sessions --lib proof_of_reduction`
  Expected: PASS on the completed branch — this task pins PROOF of behavior the earlier tasks built; its red significance is real (it fails on any variant without the managed set: before Task 3 there is no `amplifier_book_handle`, and the exact-count assertion returns ≠53 under any recursive/double-arming variant). Verify the pin has teeth by confirming both failure shapes still apply. The probe is `#[ignore]`d by default.

- [ ] **Step 3: Add the minimal production implementation**
  No new production code — this task is the proof fixture itself. If the exact-count assertion exposes a planner inconsistency (e.g. a stray `_` file in `proj_i` being armed), fix THAT in `watch_plan`/`session_watcher` (never the test). Verify the classifier visibility: `watch_plan` items are `pub(crate)` — already crate-visible to the test file (same crate). If unreachable, adjust the assertion to use `classify_basename(name) == BasenameClass::Subagent` directly (same crate; no production code change).

  Run the real-home probe once and record the number in the commit message body:
  ```bash
  cargo test -p freshell-sessions --lib measure_real_home_discover -- --ignored --nocapture
  ```

- [ ] **Step 4: Run the focused test**
  Run: `cargo test -p freshell-sessions --lib session_watcher`
  Expected: PASS.

- [ ] **Step 5: Refactor while green**
  None — this is a measurement/proof task. If the 53-number arithmetic reads unclearly in the test, add one comment line restating the formula (`1 root + 12 sessions + 4 stand-ins + 36 root session dirs = 53`).

- [ ] **Step 6: Run impacted-test verification**
  Impacted set: freshell-sessions complete suite (the proof exercises the whole engine end-to-end), plus a freshell-server compile check (no server code changed since Task 9, but its construction sites consume the watcher API).
  Run: `cargo test -p freshell-sessions && cargo check -p freshell-server`
  Expected: PASS / clean.

- [ ] **Step 7: Commit the task**
  ```bash
  git add crates/freshell-sessions/src/session_watcher_tests.rs crates/freshell-sessions/src/amplifier.rs
  git commit -m "test(sessions): amplifier watch-count reduction proof and root-liveness pin"
  ```

---

### Task 11: Final verification gate

**Files:** none (verification only)

**Interfaces:** the whole diff.

- [ ] **Step 1: Record the diff surface**
  Run: `git diff origin/main --stat`
  Expected: only files under `crates/freshell-sessions/`, `crates/freshell-protocol/`, `crates/freshell-ws/`, `crates/freshell-server/src/main.rs`, `crates/freshell-server/src/subagent_cadence.rs`, `shared/ws-protocol.ts`, `port/contract/*`, `src/store/`, `test/unit/client/subagent-interest-middleware.test.ts`, plus this plan + the design doc.

- [ ] **Step 2: Run the full gate** (definition of green — see top of this plan)
  Run:
  ```bash
  cargo test -p freshell-sessions -p freshell-server -p freshell-ws --no-fail-fast
  cargo test -p freshell-protocol --no-fail-fast
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  npm run contract:generate && git diff --exit-code -- port/contract/
  FRESHELL_VITEST_BACKEND=local npm test
  ```
  Expected: all green. `npm test` goes through the shared coordinator — set `FRESHELL_TEST_SUMMARY="amplifier-watch-reduction final gate"` when running it, and check `npm run test:status` first if another agent holds the gate.

- [ ] **Step 3: Regression-map closure**
  Re-read the 17-row table at the top of this plan; mark each row verified-by (test name + latest green run log line). Any row that cannot be pointed at a passing assertion is a blocking finding — resolve it before declaring green.

- [ ] **Step 4: Sanity-check the diff**
  ```bash
  git diff origin/main -- crates/freshell-sessions/src/directory_index.rs | grep -n "stat_file\|stat_scoped" | head -20
  git log --oneline origin/main..HEAD
  git status --short
  ```
  Expected: no leftover debug prints, no `--cfg(test)`-only production paths, clean status.

- [ ] **Step 5: Refactor while green**
  Not applicable (verification task).

- [ ] **Step 6: Impacted-test verification**
  Already covered by Step 2's full gate. Nothing further.

- [ ] **Step 7: Commit the task**
  Only if Step 2-4 flushed out fixes (fix-forward; don't amend):
  ```bash
  git add -p   # only the fix files
  git commit -m "fix: <whatever the gate exposed>"
  ```
  Otherwise no commit.

  The executable workflow ends here, at the full-suite gate plus the
  whole-branch review above. What follows is still part of THIS run and needs
  NO further user authorization (the User Request's workflow constraints
  explicitly require them): the final independent delta review round(s) over
  the whole branch diff (`origin/main..HEAD`), and then the recap. The only
  user-authorized gates are exactly these, and they stay in force regardless:
  never push or merge to `origin/main` (a PR is created ONLY after the user
  explicitly approves PR creation — per the Global Constraints), and never
  restart or redeploy the self-hosted production Rust server without the
  user's explicit "APPROVED".
