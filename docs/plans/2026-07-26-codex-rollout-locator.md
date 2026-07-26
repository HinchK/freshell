# Codex Server-Side Rollout Identity Locator Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Give the Rust server its own authoritative identity source for fresh
codex terminal panes — a server-side locator that detects the new
`rollout-<ts>-<threadId>.jsonl` appearing under the codex sessions root,
binds the pane to that thread id (identity registry + terminal meta + durable
pane ledger + activity hub), and retires the client-driven
`terminal.codex.candidate.persisted` channel so exactly one writer owns codex
identity facts (campaign item P1.12, plan §2.3.2).

**Architecture:** A third sibling locator following the amplifier/opencode
precedent (a provider-parameterized locator was explicitly rejected by spec —
see `crates/freshell-ws/src/lib.rs` doc on `opencode_locator`). Pure detection
lives in `crates/freshell-sessions/src/codex_locator.rs` (sync, `Mutex`-guarded,
injected clock, filesystem-snapshot correlation); a thin async controller lives
in `crates/freshell-ws/src/codex_association.rs` (arm at create, submit seam,
150 ms sweep, resolve → adopt). The adoption tail (identity upsert → registry
meta → ledger resolve → pinned broadcasts → activity bind + rollout attach) is
extracted from `codex_candidate.rs` into a shared `codex_identity.rs` before
the candidate channel is deleted. The wire message stays in the protocol enum
but becomes accept-and-ignore-with-debug-log.

**Tech Stack:** Rust (freshell-sessions, freshell-ws, freshell-server crates),
serde_json, tokio; Playwright e2e (`test/e2e-browser/`, RustServer harness);
Node .mjs fake-CLI fixture.

## Global Constraints

- Base: `origin/main` @ `2dfbba58`. Work only inside the worktree
  `/home/dan/code/freshell/.worktrees/codex-rollout-locator`. All paths below
  are relative to the worktree root.
- SCOPE FENCE (Lane B2 of a 4-lane wave). You own:
  `crates/freshell-ws/src/codex_candidate.rs` (retirement), the new locator
  modules, the minimal `crates/freshell-ws/src/terminal.rs` call sites,
  freshell-activity codex identity-bind touchpoints, ledger write calls, plus
  the unavoidable wiring in `crates/freshell-server/src/main.rs` and
  `crates/freshell-ws/src/lib.rs`. Do NOT touch:
  `crates/freshell-ws/src/reconcile.rs`, `crates/freshell-ws/src/existence.rs`,
  `src/lib/ws-client*`, `src/App.tsx` (Lane B1); `tabs_snapshots.rs` + recovery
  UI (Lane B3); ANY file under `crates/freshell-freshagent/` (Lane B4);
  opencode files beyond reading. No kimi/gemini work.
- The frozen client is untouched: `src/components/TerminalView.tsx`'s candidate
  sender stays; the server accepts-and-ignores its frame with a debug log —
  never an error to the client.
- Rust CI gate: `cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets -- -D warnings` (toolchain 1.96.0).
  `cargo test` is a local-only gate — run it anyway, every task.
- Coordinated TS suites: `env -u FRESHELL_BIND_HOST npm test` waits on the
  shared coordinator gate — if another agent holds it, WAIT (3 sibling lanes
  run concurrently). Set `FRESHELL_TEST_SUMMARY="lane B2 codex locator"` for
  broad runs. Focused runs go through `npm run test:vitest -- ...`.
- E2E: every spec owns its RustServer instances on ephemeral ports
  (`findFreePort()`), NEVER 3001/3002. NEVER restart the user's self-hosted
  Freshell server. NEVER use broad kill patterns.
- Worktree may need `npm ci` and the tsx symlink:
  `ln -s ../node_modules/tsx node_modules/tsx` (only if `npm test` complains).
- ~78 GB disk free — halt and report on any ENOSPC.
- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`, report
  branch + proof.
- Server TS uses NodeNext/ESM (relative imports need `.js`) — no server TS is
  modified in this plan; the new fixture is a self-contained `.mjs`.

## Premise Corrections (verified against the codebase — trust these over the task prose)

1. **There is no per-terminal isolated CODEX_HOME.** `CODEX_HOME` is a
   process-global env read (`codex_sessions_root()`, resolved once at boot,
   `crates/freshell-server/src/main.rs:412-417`). All codex terminals of a
   server share ONE sessions tree:
   `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`
   (flat `<id>.jsonl` also supported, used by tests). Pane↔rollout attribution
   therefore needs a disambiguator set: known-files snapshot (taken at arm,
   re-snapshotted at the first Enter) +
   Enter-anchored windows + REQUIRED-cwd match + pending-first-line
   bind-blocking + contested-cwd refusal (see Validated Premises below).
2. **"One watcher, two consumers" is not feasible for discovery.** The wave-2
   status watcher (`activity.rs:349`) watches a SINGLE already-known rollout
   file, NonRecursive, and only exists once identity is known — chicken-and-egg
   for discovery. The locator therefore polls (bounded scan, only while a
   terminal is armed — the opencode/amplifier precedent), and at resolve it
   hands the discovered path to the EXISTING status watcher via
   `attach_codex_rollout` — one file-watcher, both consumers downstream.
   The parsers ARE reused (`first_line_owns`'s ownership predicate shape,
   1 MB bounded first-line read).
3. **`bind_terminal_session` does not exist.** The activity-hub bind path is
   `ActivityHub::bind_codex_session(terminal_id, session_id)`
   (`crates/freshell-ws/src/activity.rs:251`) →
   `CodexActivityTracker::bind_session` (`crates/freshell-activity/src/codex.rs:207`).
4. **The candidate channel is production-DORMANT on the Rust server** — its
   sole trigger (`terminal.codex.durability.updated`) has no Rust emitter.
   Retiring it costs zero Rust production behavior; its only exercisers are
   two Rust integration tests that inject the frame over a raw socket.
5. **The two candidate restore-contract-wall pins are NOT codex-shaped**:
   `:1679` is claude-based, `:1803` is opencode-based. Do not flip pins
   blindly — Task 11 evaluates them by running the wall (Playwright turns an
   unexpected PASS into a hard failure, which is the flip signal).
6. **REST-created codex panes (freshell-freshagent) do not arm in this lane.**
   Arming the shared locator instance from `terminal_tabs.rs` (the way
   opencode does) requires touching `crates/freshell-freshagent/` — explicitly
   forbidden by the scope fence (Lane B4 owns those crates). WS-created panes
   (the frozen client's only path) are covered. This is a spec-directed
   boundary, not a deferral: record it in the final commit message.

### Validated Premises (load-bearing validation, 2026-07-26 — trust these over any stale task prose)

Evidence sources: codex source @ tag `rust-v0.145.0` + installed
`codex-cli 0.145.0`; a 3,858-rollout local corpus (100% first-line parse);
frozen-client code inspection. Full reports:
`.worktrees/.the-usual-logs/codex-rollout-locator/reports/validator-*.md`.
A codex upgrade re-opens every codex-behavior item below.

7. **(A1, FALSIFIED spawn premise) Rollout files are Enter-anchored.** Codex
   creates the rollout file ONLY when the first user prompt is recorded
   (`RolloutRecorder` defers file creation to `persist()`, materialized via
   `ensure_rollout_materialized()`). A rollout can NEVER legitimately appear
   for a pane's own codex before Enter — so the locator has NO spawn window:
   windows open only on `note_submit`. Arm still snapshots immediately.
8. **(A3, FALSIFIED one-shot read) Create→meta-line gap is real.** After
   creating the file codex awaits git-info collection (subprocesses, 5 s
   timeout each; typically ms, worst ~10 s) BEFORE writing the session_meta
   first line. A new file with an empty/incomplete first line is therefore a
   PENDING, BIND-BLOCKING candidate re-probed up to
   `PENDING_FIRST_LINE_GRACE_MS = 10_000` — never dropped by a one-shot read,
   and never outvoted by a readable foreign file while pending.
9. **(A4, FALSIFIED — misbind defenses insufficient as originally planned.)**
   The original snapshot+cwd+same-tick-ambiguity trio allowed clean misbinds
   (same-cwd foreign codex/exec/fork, staggered same-cwd panes, the
   spawn-window pure-foreign capture). Mandatory hardenings, all encoded in
   Tasks 1-4: Enter-only windows (item 7); cwd REQUIRED — a no-cwd
   session_meta NEVER binds (`SessionMeta.cwd` is non-optional at 0.145.0,
   3,858/3,858 corpus; a permissive no-cwd rule is pure attack surface);
   pending-candidate bind-blocking (item 8); CROSS-TICK contested-cwd
   refusal — while ≥2 armed terminals share a normalized cwd nothing binds
   for any of them; the adoption tail refuses a thread id already bound
   to another terminal (retired-inclusive; idempotent same-terminal re-adopt
   allowed); and a FIRST-SUBMIT `known_files` re-snapshot — the first
   `note_submit` replaces the arm-time snapshot with a fresh scan, strictly
   safe by item 7 (the pane's own rollout cannot exist before its first
   Enter), closing the arm→first-Enter foreign-capture gap. The re-snapshot
   is sound ONLY if it completes BEFORE the Enter byte is written to the
   PTY (codex materializes the rollout in response to that very Enter) —
   Task 4's submit seam encodes this ordering; later window re-opens NEVER
   re-snapshot (the pane's own slow-materializing rollout must stay a
   candidate).
10. **(A4 residual risk — documented, NOT solvable in this lane.)** The
    first-submit re-snapshot (item 9) closes the arm→first-Enter capture
    gap, but a foreign same-cwd rollout created AFTER the pane's first
    Enter can still misbind as a sole candidate: every window from the
    first Enter onward diffs against the first-submit snapshot, and there
    is deliberately no time bound (item 7's re-open mitigation depends on
    that). Realistic same-cwd writer: a freshell-freshagent codex agent
    session — freshagent's `codex app-server` sidecar writes rollouts into
    the same `$HOME/.codex/sessions` root — combined with a later bare
    Enter on the pane (empty composer or a codex dialog; `is_submit_input`
    treats any pure CR/LF as a submit). Recommended future fix (Lane B4
    coordination): exclude freshagent-known thread ids (`thread/start`
    results) at adoption. Recorded here so the risk is owned, not silent.
11. **(A5) The post-spawn arm site is safe — but only because of item 7.**
    The planned `maybe_arm` call site (terminal.rs ~:1521-1527) runs AFTER
    the PTY spawn, with awaits in between. Enter-anchored discovery makes
    the spawn→arm gap harmless: the pane's own rollout cannot exist yet. Do
    not describe the snapshot as preceding spawn — it doesn't need to.
12. **(A6, verified with corrections) Walk performance.** Real tree
    (3,858 files): 7-9 ms warm. Synthetic 100k files: p95 96 ms warm, worst
    117 ms under 8-way concurrency (native ext4, WSL2). The earlier
    "35-55 ms on an 8k-file tree" figure did NOT reproduce — do not cite it.
    Cold cache is unmeasured (needs sudo): run the `arm()`, first-submit
    `note_submit()`, and `tick()`
    scans inside `spawn_blocking`, never on the WS dispatch path.
13. **(A2/A9, confirmed) cwd + shape + resume argv.** `payload.cwd` is the
    codex process's physical `getcwd` path recorded verbatim (no
    canonicalization codex-side); equality holds BECAUSE freshell's
    `normalize_cwd` opportunistically canonicalizes the pane side — that
    canonicalize is load-bearing. `payload.id` == the filename threadId, a
    36-char UUID; `codex resume <uuid>` positional is first-class. 0.145.0
    source contains `.jsonl.zst` rollout compression — fresh sessions still
    write plain `.jsonl`; the `.jsonl` suffix filter excludes compressed
    artifacts. Filename timestamp and `YYYY/MM/DD` dir are precomputed at
    session construction — can predate on-disk creation by the whole idle
    gap / cross midnight; the locator never filters on either. Resumed
    sessions append to their existing file (no new file) — consistent with
    the arm gate refusing resume panes.
14. **(A10/A7, confirmed) Env + frozen client.** The PTY child inherits the
    server env minus a STRIP_ENV list that touches neither `CODEX_HOME` nor
    `HOME`, and codex is exec'd directly (no shell rc) — the shared
    sessions-root premise holds. Residual (noted, not fixed): a per-terminal
    `envOverrides` containing `CODEX_HOME` would diverge the child's root.
    The frozen client applies `terminal.session.associated`
    provider-generically (`App.tsx:1004-1017` → panesSlice `sessionRef`) and
    its candidate sender is dormant against the Rust server; its conflict
    guard drops a push only when the pane already holds a DIFFERENT
    sessionRef — impossible for the fresh panes the locator arms.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-sessions/src/codex_locator.rs` | Create | Pure detection: arm/disarm/note_submit/tick over a filesystem-snapshot substrate |
| `crates/freshell-sessions/src/lib.rs` | Modify | `pub mod codex_locator;` |
| `crates/freshell-sessions/src/opencode_locator.rs` | Modify (1 line) | `fn normalize_cwd` → `pub(crate) fn` for reuse |
| `crates/freshell-ws/src/codex_identity.rs` | Create | Shared adoption tail `adopt_codex_identity` + `codex_sessions_root` (moved) |
| `crates/freshell-ws/src/codex_association.rs` | Create | Controller: maybe_arm / note_possible_submit / drain_and_associate / sweep |
| `crates/freshell-ws/src/codex_candidate.rs` | Delete (Task 7) | Retired client candidate channel |
| `crates/freshell-ws/src/lib.rs` | Modify | mod decls, `pub use`, `WsState.codex_locator` field |
| `crates/freshell-ws/src/terminal.rs` | Modify | arm-at-create, submit seam, exit disarm, candidate match arm → debug log |
| `crates/freshell-ws/src/invariants.rs` | Modify (docs) | identity-unresolved alarm doc names the codex locator |
| `crates/freshell-server/src/main.rs` | Modify | Locator construction + WsState field + sweep spawn |
| `crates/freshell-ws/tests/common/mod.rs` | Modify (Task 6) | New spawn helper wiring a codex locator + 150 ms sweep (existing helpers have no locator and spawn no sweep) |
| `crates/freshell-ws/tests/codex_locator_activity.rs` | Create | Fresh pane → locator → turn.complete carries sessionId |
| `crates/freshell-ws/tests/codex_candidate_inert.rs` | Create | Candidate frame is accepted, ignored, logged; no identity written |
| `crates/freshell-ws/tests/codex_candidate_persisted.rs` | Delete (Task 7) | Superseded by inert test + locator tests |
| `crates/freshell-ws/tests/codex_candidate_activity.rs` | Delete (Task 7) | Superseded by `codex_locator_activity.rs` |
| `test/e2e-browser/fixtures/fake-codex-terminal.mjs` | Create | Fake codex CLI that writes a real rollout JSONL |
| `test/e2e-browser/specs/codex-terminal-restore-rust.spec.ts` | Create | Fresh codex pane → server-side identity → restart → `resume <id>` |
| `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts` | Modify | Codex SIGKILL-inside-window fresh-by-race ledger wall |
| `test/e2e-browser/playwright.config.ts` | Modify | Register the new rust-only spec (two places) |

Key existing reference files (read, don't modify beyond what tasks say):
`crates/freshell-sessions/src/opencode_locator.rs` (the detection template),
`crates/freshell-ws/src/opencode_association.rs` (the controller template),
`crates/freshell-ws/src/codex_reconcile.rs` (`locate_codex_rollout`,
`first_line_owns`), `crates/freshell-ws/src/pane_ledger.rs`
(`ledger_resolve_identity`), `test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts`
(the e2e template).

---

### Task 1: CodexLocator skeleton — types, arm gates, scan substrate, Enter-anchored happy path

**Files:**
- Create: `crates/freshell-sessions/src/codex_locator.rs`
- Modify: `crates/freshell-sessions/src/lib.rs` (add `pub mod codex_locator;` alphabetically among the existing `pub mod` lines)
- Modify: `crates/freshell-sessions/src/opencode_locator.rs` (make `fn normalize_cwd` → `pub(crate) fn normalize_cwd`; it is currently private at ~`:369`)
- Test: in-file `mod tests` in `codex_locator.rs`

**Interfaces:**
- Consumes: `crate::opencode_locator::normalize_cwd(&str) -> String`
- Produces (later tasks rely on these EXACT signatures):

```rust
pub const CODEX_WINDOW_MS: i64 = 2_000;
pub const PENDING_FIRST_LINE_GRACE_MS: i64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub terminal_id: String,
    pub thread_id: String,
    pub rollout_path: std::path::PathBuf,
    pub cwd: String,
}

pub struct CodexLocator { /* private */ }

impl CodexLocator {
    pub fn new(sessions_root: std::path::PathBuf) -> Self;
    pub fn with_config(sessions_root: std::path::PathBuf, window_ms: i64) -> Self;
    pub fn armed_count(&self) -> usize;
    pub fn fs_scan_count(&self) -> u64;
    pub fn arm(&self, terminal_id: &str, mode: &str, status_running: bool,
               resume_session_id: Option<&str>, cwd: Option<&str>) -> bool;
    pub fn disarm(&self, terminal_id: &str);
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool;
    pub fn tick(&self, now_ms: i64) -> Vec<Located>;
}
```

Design notes to encode in the module doc (deliberate deviations from the
opencode locator, each with rationale — the codex-behavior facts below are
validated against codex source @ rust-v0.145.0 and a 3,858-rollout local
corpus; see "Validated Premises" above):
- Substrate is a filesystem snapshot-diff, not SQLite row-diff: codex persists
  one JSONL rollout file per session under the sessions root.
- There is NO `pre_epsilon_ms` and NO created-at time bound: filesystems have
  no reliable cross-platform creation time. The `known_files` snapshot is the
  primary safety (same as opencode's `known_ids`): a file already present in
  the snapshot can never bind to this terminal. The locator
  also never filters by the FILENAME timestamp or by today's `YYYY/MM/DD`
  directory: the filename timestamp is precomputed at codex session
  construction and can predate on-disk creation by the entire user idle gap,
  and the dated dir can be a previous day across midnight — the full-tree
  snapshot-diff sidesteps both.
- FIRST-SUBMIT re-snapshot (A4 hardening; fresh-eyes iteration 1): the first
  `note_submit` replaces `known_files` with a fresh scan. Strictly safe by
  the Enter-anchored premise — the pane's own rollout cannot exist before its
  first Enter, so everything that appeared between arm and the first Enter is
  foreign by construction (freshagent sidecar, `codex exec`, codex outside
  freshell). SOUNDNESS PRECONDITION: the caller must complete the first
  `note_submit` BEFORE the Enter byte is written to the PTY — codex
  materializes the rollout in response to that very Enter, so a re-snapshot
  racing after the write could capture (and permanently exclude) the pane's
  own file. Task 4's submit seam encodes this ordering. Later window
  re-opens NEVER re-snapshot: the slow-materialization mitigation (a >2 s
  Enter→creation latency recovered by a later Enter) depends on the pane's
  own late file staying a candidate.
- Windows are ENTER-ANCHORED ONLY — there is NO spawn-anchored window (a
  deliberate deviation from opencode). Real codex (0.145.0) defers rollout
  file creation until the first user prompt is recorded (`RolloutRecorder`
  defers to `persist()`, materialized via `ensure_rollout_materialized()`),
  so a rollout can NEVER legitimately appear for this pane's codex before
  Enter — a spawn window would be a pure FOREIGN-capture window. `arm()`
  still takes the known-files snapshot immediately; it schedules no deadline
  until `note_submit`. Deadline is `enter_ms + window_ms`; evaluation happens
  once per open window (`resolved` flag), and a later Enter re-opens it.
- cwd is REQUIRED: a first line whose `session_meta.payload` lacks `cwd` is
  never a candidate (`SessionMeta.cwd` is non-optional at 0.145.0;
  3,858/3,858 real rollouts carry it — a no-cwd rule would be pure foreign
  attack surface). The cwd match relies on `normalize_cwd`'s opportunistic
  `fs::canonicalize` of the pane side being load-bearing: `payload.cwd` is
  the codex process's physical `getcwd` path, recorded verbatim.
- Pending first-line grace: codex CREATES the file, then awaits git-info
  collection (subprocesses, 5 s timeout each, worst ~10 s) BEFORE writing the
  `session_meta` line — a deadline scan can see an empty/incomplete first
  line. Such a NEW file is a PENDING candidate: re-probed each sweep up to
  `PENDING_FIRST_LINE_GRACE_MS`, and while ANY pending candidate exists the
  terminal binds NOTHING (bind-blocking — a readable foreign file must not
  win while the pane's own file sits in its git-info gap). An Enter→creation
  latency exceeding the 2 s window (slow first-prompt recording) is mitigated
  by this grace plus window re-open on a later Enter.
- Contested-cwd refusal is CROSS-TICK: while ≥2 armed terminals share a
  normalized cwd, no candidate with that cwd binds for any of them —
  staggered deadlines must not let one pane grab a sibling's rollout
  uncontested.
- Resumed codex sessions append to their EXISTING rollout file (no new file)
  — consistent with the arm gate refusing resume panes. Compressed rollout
  artifacts (`.jsonl.zst`, present in 0.145.0 source) are excluded by the
  `.jsonl` suffix filter; fresh sessions always write plain `.jsonl`.
- Scans happen ONLY at arm time, at the FIRST `note_submit` (the re-snapshot
  above), and at deadline evaluations (never on idle
  ticks — proven by `fs_scan_count`; a pending candidate keeps its window's
  evaluation due, so re-probes ride the same gate), bounded to walk depth 5
  (the tree is `sessions/YYYY/MM/DD/rollout-*.jsonl`; flat `<id>.jsonl` in
  tests). Measured (A6, native ext4 under WSL2): 7-9 ms on the real
  3.8k-file tree; synthetic 100k files p95 96 ms warm, worst 117 ms under
  8-way concurrency. Cold-cache is unmeasured — callers run BOTH `arm()` and
  `tick()` inside `spawn_blocking`.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-sessions/src/codex_locator.rs` with ONLY the test
module and a `#![allow(dead_code)]`-free skeleton that does not yet exist —
i.e. write the tests first; the file will not compile until Step 3 adds the
implementation above the tests. Test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Same convention as opencode_locator.rs tests: no tempfile crate.
    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-codex-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    /// Write a rollout file whose FIRST line is the session_meta identity
    /// record, exactly the shape the real codex CLI writes
    /// (payload.id = identity; payload.cwd = the session's working dir).
    fn write_rollout(root: &Path, rel_dir: &str, thread_id: &str, cwd: Option<&str>) -> PathBuf {
        let dir = root.join(rel_dir);
        std::fs::create_dir_all(&dir).expect("create rollout dir");
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{thread_id}.jsonl"));
        let payload = match cwd {
            Some(c) => format!(r#"{{"id":"{thread_id}","cwd":"{c}"}}"#),
            None => format!(r#"{{"id":"{thread_id}"}}"#),
        };
        let line = format!(
            r#"{{"timestamp":"2026-07-26T08:00:00.000Z","type":"session_meta","payload":{payload}}}"#
        );
        std::fs::write(&file, format!("{line}\n")).expect("write rollout");
        file
    }

    const TID: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn fresh_rollout_after_first_enter_resolves_via_enter_window() {
        let root = unique_temp_dir("enter-happy");
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_string_lossy().to_string();
        let locator = CodexLocator::new(root.clone());

        assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
        // No submit yet -> no deadline exists; nothing to evaluate.
        assert!(locator.tick(10_000).is_empty());
        // Enter at 20_000; the rollout appears AFTER the submit (real codex
        // materializes the file only when the first user prompt is recorded).
        assert!(locator.note_submit("t1", 20_000));
        let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));

        // Before the Enter-anchored deadline: nothing yet.
        assert!(locator.tick(20_000 + CODEX_WINDOW_MS - 1).is_empty());
        let located = locator.tick(20_000 + CODEX_WINDOW_MS);
        assert_eq!(
            located,
            vec![Located {
                terminal_id: "t1".into(),
                thread_id: TID.into(),
                rollout_path: path,
                cwd: crate::opencode_locator::normalize_cwd(&cwd_s),
            }]
        );
        // Success fully resolves and disarms; tick() drains.
        assert_eq!(locator.armed_count(), 0);
        assert!(locator.tick(20_000 + CODEX_WINDOW_MS + 1).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_after_arm_without_submit_is_never_bound_and_never_scanned() {
        // A1 (validated): real codex creates the rollout ONLY at the first
        // user prompt, so before Enter every new same-cwd rollout is by
        // construction FOREIGN. With no submit there is NO window: the file
        // must never bind and no deadline scans may run.
        let root = unique_temp_dir("no-submit");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.fs_scan_count(), 1); // the arm snapshot
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert!(locator.tick(100 * CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        assert_eq!(locator.fs_scan_count(), 1); // still only the arm snapshot
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_created_between_arm_and_first_enter_never_binds() {
        // A4 hardening (first-submit re-snapshot): Premise 7 guarantees the
        // pane's own rollout cannot exist before its first Enter, so EVERY
        // file that appears between arm and the first submit is foreign by
        // construction (freshagent sidecar, `codex exec`, codex outside
        // freshell in the same cwd). The FIRST note_submit re-snapshots
        // known_files, so a bare Enter (empty composer, trust dialog) can
        // never hand the window to that foreign file as a sole candidate.
        let root = unique_temp_dir("resnapshot");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        // Foreign rollout lands AFTER arm but BEFORE the first Enter.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.note_submit("t1", 1_000)); // first submit re-snapshots
        assert_eq!(locator.fs_scan_count(), 2); // arm + first-submit scans
        assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn arm_admission_gates() {
        let root = unique_temp_dir("gates");
        let locator = CodexLocator::new(root.clone());
        // wrong mode
        assert!(!locator.arm("t1", "opencode", true, None, Some("/tmp")));
        // not running
        assert!(!locator.arm("t1", "codex", false, None, Some("/tmp")));
        // resume id present — the ONLY already-bound gate (no restore flag)
        assert!(!locator.arm("t1", "codex", true, Some(TID), Some("/tmp")));
        // missing / empty cwd
        assert!(!locator.arm("t1", "codex", true, None, None));
        assert!(!locator.arm("t1", "codex", true, None, Some("")));
        // happy arm, then idempotent re-arm returns false
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(!locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disarmed_terminal_never_resolves() {
        let root = unique_temp_dir("disarm");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        locator.disarm("t1");
        assert!(locator.tick(CODEX_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tick_while_unarmed_performs_zero_fs_scans() {
        let root = unique_temp_dir("idle");
        let locator = CodexLocator::new(root.clone());
        // Construction must not scan eagerly either.
        assert_eq!(locator.fs_scan_count(), 0);
        assert!(locator.tick(10_000).is_empty());
        assert_eq!(locator.fs_scan_count(), 0);
        // Arming scans once (the known-files snapshot)…
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.fs_scan_count(), 1);
        // …and a tick BEFORE any Enter-anchored deadline is due (here: no
        // submit at all, so no deadline exists) still scans nothing.
        let before = locator.fs_scan_count();
        assert!(locator.tick(1).is_empty());
        assert_eq!(locator.fs_scan_count(), before);
        let _ = std::fs::remove_dir_all(&root);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/codex-rollout-locator
cargo test -p freshell-sessions codex_locator 2>&1 | tail -20
```
Expected: COMPILE ERROR — `CodexLocator` / `Located` / `CODEX_WINDOW_MS` not
found (the module exists with only tests). A compile failure of the new test
module is the RED state for a new module.

- [ ] **Step 3: Write the implementation (above the test module, same file)**

```rust
//! Server-side codex terminal-pane session locator (Lane B2, campaign §2.3.2).
//!
//! Third sibling of `amplifier_locator` / `opencode_locator` (a
//! provider-parameterized locator was explicitly rejected — the substrates
//! share zero code). Substrate: codex persists ONE JSONL rollout file per
//! session under a process-global sessions root
//! (`<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`,
//! flat `<id>.jsonl` in tests). A new session is a NEW FILE — so the locator
//! does a snapshot-diff of the file set, not a row-diff.
//!
//! Codex-behavior facts below are validated against codex source @
//! rust-v0.145.0 and a 3,858-rollout corpus; a codex upgrade re-opens them.
//!
//! Deliberate deviations from the opencode locator, with rationale:
//! - Windows are ENTER-ANCHORED ONLY — no spawn window. Real codex defers
//!   rollout file creation until the first user prompt is recorded
//!   (`RolloutRecorder` defers to `persist()`, materialized via
//!   `ensure_rollout_materialized()`), so before the pane's first Enter every
//!   new same-cwd rollout is by construction FOREIGN. `arm()` takes the
//!   known-files snapshot immediately but schedules NO deadline until
//!   `note_submit`.
//! - NO `pre_epsilon_ms` and NO created-at time bound: filesystems have no
//!   reliable cross-platform creation time (mtime moves on every append).
//!   The `known_files` snapshot is the primary safety — a file
//!   already present in the snapshot can never bind to this terminal. The FILENAME
//!   timestamp and the dated `YYYY/MM/DD` dir are never used as filters
//!   either: both are precomputed at codex session construction and can
//!   predate on-disk creation by the entire user idle gap (the dir can even
//!   be "yesterday" across midnight). The full-tree snapshot-diff sidesteps
//!   both.
//! - FIRST-SUBMIT re-snapshot (A4 hardening): the first `note_submit`
//!   replaces `known_files` with a fresh scan — strictly safe because the
//!   pane's own rollout cannot exist before its first Enter, so everything
//!   that appeared between arm and the first Enter is foreign by
//!   construction. SOUNDNESS PRECONDITION: the caller completes the first
//!   `note_submit` BEFORE the Enter byte is written to the PTY (codex
//!   materializes the rollout in response to that very Enter) — the
//!   `codex_association` submit seam encodes this ordering. Later window
//!   re-opens NEVER re-snapshot: a >2 s Enter→creation latency is recovered
//!   by a later Enter only if the pane's own late file stays a candidate.
//! - Attribution disambiguator: the rollout's own first-line
//!   `session_meta.payload.cwd` is REQUIRED and must match the armed
//!   terminal's cwd (`SessionMeta.cwd` is non-optional at 0.145.0;
//!   3,858/3,858 real rollouts carry it — accepting a no-cwd line would be
//!   pure foreign attack surface). `payload.cwd` is the codex process's
//!   physical `getcwd` path recorded verbatim; equality holds because
//!   `normalize_cwd` opportunistically canonicalizes the pane side — that
//!   canonicalize is load-bearing for symlinked spawn dirs.
//! - Pending first-line grace: codex CREATES the file, then awaits git-info
//!   collection (subprocesses, 5 s timeout each, worst ~10 s) BEFORE writing
//!   the `session_meta` line. A NEW file whose first line is empty/incomplete
//!   is a PENDING candidate: re-probed each sweep up to
//!   `PENDING_FIRST_LINE_GRACE_MS`, and while ANY pending candidate exists
//!   this terminal binds NOTHING (bind-blocking — a readable foreign file
//!   must not win while the pane's own file sits in its git-info gap).
//!   Enter→creation latency beyond the 2 s window is mitigated by this grace
//!   plus window re-open on a later Enter.
//! - Contested-cwd refusal is CROSS-TICK: while ≥2 armed terminals share a
//!   normalized cwd, no candidate with that cwd binds for any of them.
//! - Ownership is proven ONLY by `payload.id` on line 1 — NEVER the filename
//!   (prefilter-grade at best), NEVER `payload.session_id` (fork/resume
//!   LINEAGE: matches a FOREIGN session in 54/144 sampled real rollouts) —
//!   same predicate as `freshell-ws`'s `first_line_owns`.
//! - Resumed codex sessions append to their EXISTING rollout file (no new
//!   file) — consistent with the arm gate refusing resume panes. Compressed
//!   artifacts (`.jsonl.zst`, present in 0.145.0 source) fail the `.jsonl`
//!   suffix filter; fresh sessions always write plain `.jsonl`.
//!
//! Zero cost when idle: scans happen only at arm, at the FIRST `note_submit`
//! (the re-snapshot), and at due Enter-anchored
//! evaluations (a pending candidate keeps its evaluation due, so re-probes
//! ride the same gate), proven by `fs_scan_count`. Callers run `arm()`,
//! `note_submit()`, and `tick()` inside `tokio::task::spawn_blocking` (cold
//! dentry cache is the one unmeasured tail — A6).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::opencode_locator::normalize_cwd;

/// Correlation window after a submit (Enter-anchored deadline). There is NO
/// spawn-anchored window: real codex (0.145.0) creates the rollout file only
/// when the first user prompt is recorded, so before the pane's first Enter
/// every new same-cwd rollout is by construction foreign.
pub const CODEX_WINDOW_MS: i64 = 2_000;

/// Bounded re-probe grace for a NEW file whose first line is not yet
/// readable: codex creates the file, then awaits git-info collection
/// (subprocesses, 5 s timeout each, worst ~10 s) before writing the
/// `session_meta` line. Matches codex's worst case and the magnitude of the
/// existing `IDENTITY_RESOLUTION_GRACE_MS`.
pub const PENDING_FIRST_LINE_GRACE_MS: i64 = 10_000;

/// Bounded first-line read cap — real rollouts reach 152 MB; observed real
/// first lines are ≤ 22.4 KB. Mirrors `codex_reconcile.rs`.
const MAX_FIRST_LINE_BYTES: u64 = 1024 * 1024;

/// Bounded walk depth — `sessions/YYYY/MM/DD/` is depth 3; 5 mirrors
/// `locate_codex_rollout`.
const MAX_WALK_DEPTH: u8 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub terminal_id: String,
    pub thread_id: String,
    pub rollout_path: PathBuf,
    pub cwd: String,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    known_files: HashSet<PathBuf>,
    enter_ms: Option<i64>,
    resolved: bool,
    /// NEW files whose first line was empty/incomplete when probed, keyed to
    /// first-seen ms. While any un-expired entry exists, this terminal binds
    /// NOTHING (bind-blocking); entries older than
    /// `PENDING_FIRST_LINE_GRACE_MS` are merged into `known_files`
    /// (permanently excluded — fail toward refusal).
    pending_first_line: HashMap<PathBuf, i64>,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
}

pub struct CodexLocator {
    sessions_root: PathBuf,
    window_ms: i64,
    inner: Mutex<Inner>,
    fs_scan_count: AtomicU64,
}

impl CodexLocator {
    pub fn new(sessions_root: PathBuf) -> Self {
        Self::with_config(sessions_root, CODEX_WINDOW_MS)
    }

    pub fn with_config(sessions_root: PathBuf, window_ms: i64) -> Self {
        Self {
            sessions_root,
            window_ms,
            inner: Mutex::new(Inner::default()),
            fs_scan_count: AtomicU64::new(0),
        }
    }

    pub fn armed_count(&self) -> usize {
        self.inner.lock().unwrap().armed.len()
    }

    pub fn fs_scan_count(&self) -> u64 {
        self.fs_scan_count.load(Ordering::SeqCst)
    }

    /// Admission rules (mirrors `OpencodeLocator::arm`): codex mode, running,
    /// NO resume id (the only already-bound gate — never a restore flag, so
    /// restore-created identity-less panes re-arm for free), non-empty cwd,
    /// not already armed. On success takes the arm-time known-files snapshot.
    /// Arming schedules NO deadline — windows open only on `note_submit`
    /// (Enter-anchored; see module doc).
    pub fn arm(
        &self,
        terminal_id: &str,
        mode: &str,
        status_running: bool,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
    ) -> bool {
        if mode != "codex" || !status_running || resume_session_id.is_some() {
            return false;
        }
        let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
            return false;
        };
        let mut inner = self.inner.lock().unwrap();
        if inner.armed.contains_key(terminal_id) {
            return false;
        }
        let known_files = self.scan_rollout_files();
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                known_files,
                enter_ms: None,
                resolved: false,
                pending_first_line: HashMap::new(),
            },
        );
        true
    }

    pub fn disarm(&self, terminal_id: &str) {
        self.inner.lock().unwrap().armed.remove(terminal_id);
    }

    /// The FIRST submit is what opens a window at all (windows are
    /// Enter-anchored — arm schedules no deadline), and it RE-SNAPSHOTS
    /// `known_files` (see module doc: strictly safe because the pane's own
    /// rollout cannot exist before its first Enter; the caller must complete
    /// this call BEFORE the Enter byte reaches the PTY, and must run it on
    /// the blocking pool — the re-snapshot walks the sessions tree).
    /// Re-open semantics mirror
    /// opencode: a mid-turn Enter never re-opens a still-pending evaluation;
    /// a resolved (zero-candidate / ambiguous / contested) terminal gets a
    /// fresh Enter-anchored deadline. Re-opens NEVER re-snapshot.
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            return false;
        };
        if !armed.resolved && armed.enter_ms.is_some() {
            return false;
        }
        if armed.enter_ms.is_none() {
            // FIRST submit: everything that appeared between arm and this
            // Enter is foreign by construction (A1/A4) — replace the
            // snapshot. Holding the lock across the scan is deliberate and
            // bounded (warm walks are 7-9 ms — A6; callers are on the
            // blocking pool); it also keeps the re-snapshot atomic with the
            // window open.
            armed.known_files = self.scan_rollout_files();
        }
        armed.enter_ms = Some(at_ms);
        armed.resolved = false;
        true
    }

    /// A terminal is due only when an Enter-anchored deadline exists and has
    /// passed. No submit -> no window -> never evaluated (see module doc).
    fn due(&self, armed: &Armed, now_ms: i64) -> bool {
        matches!(armed.enter_ms, Some(enter_ms) if !armed.resolved && now_ms >= enter_ms + self.window_ms)
    }

    /// Evaluation at (or after) an Enter-anchored deadline. Outcomes:
    /// any NEW file with an empty/incomplete first line (codex's
    /// create→session_meta git-info gap) → PENDING: bind NOTHING for this
    /// terminal, stay unresolved, re-probe each sweep up to
    /// `PENDING_FIRST_LINE_GRACE_MS` (grace-expired files are permanently
    /// excluded);
    /// 0 candidates → keep watching (stays armed, `resolved = true`);
    /// >1 candidates for one terminal → WARN + refuse (never guess);
    /// exactly one candidate but ≥2 ARMED terminals share this cwd → WARN +
    /// refuse (contested cwd — cross-tick, so staggered deadlines can't grab
    /// a sibling's rollout uncontested);
    /// one candidate claimed by ≥2 terminals in the same tick → WARN + refuse
    /// ALL claimants (defense-in-depth behind the cwd census);
    /// exactly one clean match → emit `Located` and disarm. `tick()` drains.
    pub fn tick(&self, now_ms: i64) -> Vec<Located> {
        {
            let inner = self.inner.lock().unwrap();
            if inner.armed.is_empty() {
                return Vec::new();
            }
            if !inner.armed.values().any(|a| self.due(a, now_ms)) {
                return Vec::new();
            }
        }
        let current = self.scan_rollout_files();
        let mut inner = self.inner.lock().unwrap();

        // Cross-tick contested-cwd census over ALL armed terminals (not just
        // the due ones): two armed same-cwd panes are indistinguishable on
        // this substrate, whatever their deadlines.
        let mut cwd_counts: HashMap<String, usize> = HashMap::new();
        for a in inner.armed.values() {
            *cwd_counts.entry(a.cwd_normalized.clone()).or_insert(0) += 1;
        }

        // Pass 1: per-terminal candidate evaluation.
        let mut claims: Vec<(String, Located)> = Vec::new();
        for (terminal_id, armed) in inner.armed.iter_mut() {
            if !matches!(armed.enter_ms, Some(e) if !armed.resolved && now_ms >= e + self.window_ms)
            {
                continue;
            }
            let new_paths: Vec<PathBuf> =
                current.difference(&armed.known_files).cloned().collect();
            let mut matches: Vec<(PathBuf, RolloutMeta)> = Vec::new();
            let mut pending_blocking = false;
            for path in new_paths {
                match probe_rollout(&path) {
                    Probe::Candidate(meta) => {
                        armed.pending_first_line.remove(&path);
                        if normalize_cwd(&meta.cwd) == armed.cwd_normalized {
                            matches.push((path, meta));
                        }
                    }
                    Probe::NotYet => {
                        let first_seen =
                            *armed.pending_first_line.entry(path.clone()).or_insert(now_ms);
                        if now_ms - first_seen >= PENDING_FIRST_LINE_GRACE_MS {
                            // Grace exhausted: permanently excluded (fail
                            // toward refusal — A4 hardening 1).
                            armed.pending_first_line.remove(&path);
                            armed.known_files.insert(path);
                        } else {
                            pending_blocking = true;
                        }
                    }
                    Probe::Never => {}
                }
            }
            if pending_blocking {
                // A new file is still inside codex's create→session_meta gap
                // (git-info collection, worst ~10 s). It may be THIS pane's
                // rollout — binding any other candidate now could hand the
                // window to a foreign file while the true owner is unreadable.
                // Bind nothing, stay unresolved, re-probe next sweep.
                tracing::debug!(
                    terminal_id = %terminal_id,
                    "codex_locator_pending: new rollout first line not yet readable; deferring evaluation"
                );
                continue;
            }
            armed.resolved = true;
            match matches.len() {
                0 => {} // keep watching
                1 => {
                    if cwd_counts.get(&armed.cwd_normalized).copied().unwrap_or(0) >= 2 {
                        tracing::warn!(
                            terminal_id = %terminal_id,
                            "codex_locator_contested_cwd: >=2 armed terminals share this cwd; refusing to bind"
                        );
                    } else {
                        let (path, meta) = matches.remove(0);
                        claims.push((
                            terminal_id.clone(),
                            Located {
                                terminal_id: terminal_id.clone(),
                                thread_id: meta.thread_id,
                                rollout_path: path,
                                cwd: armed.cwd_normalized.clone(),
                            },
                        ));
                    }
                }
                n => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        candidates = n,
                        "codex_locator_ambiguous: multiple new rollouts in one window; refusing to bind"
                    );
                }
            }
        }

        // Pass 2: same-tick cross-terminal conflict — the same rollout (or
        // thread id) claimed by two armed terminals in one tick is
        // unattributable. (Defense-in-depth: the contested-cwd census above
        // already refuses same-cwd claimants across ticks.)
        let mut located = Vec::new();
        for (terminal_id, candidate) in &claims {
            let contested = claims.iter().any(|(other_tid, other)| {
                other_tid != terminal_id
                    && (other.rollout_path == candidate.rollout_path
                        || other.thread_id == candidate.thread_id)
            });
            if contested {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    thread_id = %candidate.thread_id,
                    "codex_locator_contested: rollout claimed by multiple armed terminals; refusing to bind"
                );
                continue;
            }
            located.push(candidate.clone());
        }
        for l in &located {
            inner.armed.remove(&l.terminal_id);
        }
        located
    }

    fn scan_rollout_files(&self) -> HashSet<PathBuf> {
        self.fs_scan_count.fetch_add(1, Ordering::SeqCst);
        fn walk(dir: &Path, depth: u8, out: &mut HashSet<PathBuf>) {
            if depth > MAX_WALK_DEPTH {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return; // missing/corrupt root tolerated, never a panic
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, depth + 1, out);
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false)
                {
                    out.insert(path);
                }
            }
        }
        let mut out = HashSet::new();
        walk(&self.sessions_root, 0, &mut out);
        out
    }
}

struct RolloutMeta {
    thread_id: String,
    /// REQUIRED — `SessionMeta.cwd` is non-optional at codex 0.145.0
    /// (3,858/3,858 real rollouts carry it); a no-cwd first line is a
    /// foreign shape, never a candidate (A4 hardening).
    cwd: String,
}

/// Tri-state probe result. The distinction between `NotYet` and `Never` is
/// load-bearing: codex writes the whole session_meta line + '\n' in one
/// write-then-flush, so a COMPLETE (newline-terminated) line that fails the
/// candidate shape will never become one, while an empty file or a line
/// without its trailing newline is codex's create→meta gap (or a raced
/// write) — "not yet", not "never" (A3, validated).
enum Probe {
    /// Parseable `session_meta` with a bare-UUID `payload.id` AND a
    /// `payload.cwd` — a real candidate shape.
    Candidate(RolloutMeta),
    /// Empty file, transient open/read failure, or first line still missing
    /// its trailing newline — re-probe within the pending grace.
    NotYet,
    /// Complete first line that is not a codex session_meta candidate
    /// (non-JSON, wrong type, non-UUID id, missing cwd, oversized) — never
    /// a candidate; the locator stays silent on foreign files.
    Never,
}

/// Identity probe: bounded first-line read (see `Probe` for the tri-state
/// semantics).
fn probe_rollout(path: &Path) -> Probe {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return Probe::NotYet;
    };
    let mut reader = std::io::BufReader::new(file).take(MAX_FIRST_LINE_BYTES);
    let mut first_line = Vec::new();
    if reader.read_until(b'\n', &mut first_line).is_err() {
        return Probe::NotYet;
    }
    if first_line.len() as u64 >= MAX_FIRST_LINE_BYTES && !first_line.ends_with(b"\n") {
        return Probe::Never; // oversized: will never fit the cap
    }
    if first_line.is_empty() || !first_line.ends_with(b"\n") {
        return Probe::NotYet; // create→meta gap, or a raced partial write
    }
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(&first_line) else {
        return Probe::Never;
    };
    if record.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return Probe::Never;
    }
    let Some(thread_id) = record.pointer("/payload/id").and_then(|v| v.as_str()) else {
        return Probe::Never;
    };
    if !is_uuid_shaped(thread_id) {
        return Probe::Never;
    }
    let Some(cwd) = record.pointer("/payload/cwd").and_then(|v| v.as_str()) else {
        return Probe::Never; // cwd REQUIRED (A4 hardening)
    };
    Probe::Candidate(RolloutMeta {
        thread_id: thread_id.to_string(),
        cwd: cwd.to_string(),
    })
}

/// Bare hyphenated 36-char UUID shape gate (deliberate small duplicate of
/// `freshell-ws`'s predicate — this crate sits below it in the dep graph).
fn is_uuid_shaped(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let is_hyphen_pos = matches!(i, 8 | 13 | 18 | 23);
        if is_hyphen_pos {
            if *b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}
```

Also add to `crates/freshell-sessions/src/lib.rs`: `pub mod codex_locator;`
and in `crates/freshell-sessions/src/opencode_locator.rs` change
`fn normalize_cwd(input: &str) -> String` to
`pub(crate) fn normalize_cwd(input: &str) -> String`.

Check whether `tracing` is already a dependency of `freshell-sessions`
(`grep tracing crates/freshell-sessions/Cargo.toml`); if not, add
`tracing = { workspace = true }` (matching how other crates declare it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions codex_locator`
Expected: PASS (6 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/codex_locator.rs crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/opencode_locator.rs crates/freshell-sessions/Cargo.toml
git commit -m "feat(sessions): CodexLocator skeleton - arm gates, fs-snapshot substrate, Enter-anchored resolve with pending-first-line grace"
```
(Omit `Cargo.toml` from the add list if it was not modified.)

---

### Task 2: CodexLocator window semantics and correlation guards

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs` (test module only — the Task 1 implementation is expected to already satisfy these; any test that fails RED-for-real reveals an implementation gap to fix minimally)
- Test: same file, `mod tests`

**Interfaces:**
- Consumes: Task 1's full `CodexLocator` API and test helpers (`unique_temp_dir`, `write_rollout`, `TID`).
- Produces: no new API — behavioral pins later tasks and reviewers rely on.

- [ ] **Step 1: Write the tests (append to `mod tests`)**

```rust
    const TID2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[test]
    fn rollout_present_at_arm_is_never_a_candidate() {
        let root = unique_temp_dir("snapshot");
        // File exists BEFORE arm — the known-files snapshot must exclude it
        // forever, regardless of any timing.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 1_000));
        assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn foreign_cwd_rollout_is_never_a_candidate() {
        let root = unique_temp_dir("cwd");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/home/me/project-a")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/home/me/project-b"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_without_cwd_field_never_binds() {
        // cwd is REQUIRED (A4 hardening): `SessionMeta.cwd` is non-optional
        // at codex 0.145.0 and 3,858/3,858 + 500/500 real rollouts carry it.
        // A no-cwd first line is a foreign shape — accepting it would be
        // pure attack surface (a location-blind universal candidate).
        let root = unique_temp_dir("no-cwd");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, None);
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_new_rollouts_in_one_window_refuse_to_bind() {
        let root = unique_temp_dir("ambiguous");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // Refusal marks the evaluation resolved but stays armed…
        assert_eq!(locator.armed_count(), 1);
        // …and a later Enter re-opens a fresh window (both files are now
        // still absent from known_files, so still ambiguous — proves the
        // refusal is repeatable, never a guess).
        assert!(locator.note_submit("t1", CODEX_WINDOW_MS + 100));
        assert!(locator.tick(CODEX_WINDOW_MS + 100 + CODEX_WINDOW_MS).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_rollout_claimed_by_two_armed_terminals_refuses_both() {
        let root = unique_temp_dir("contested");
        let locator = CodexLocator::new(root.clone());
        // Two panes, SAME cwd, armed concurrently, submitting in the same
        // tick; ONE new rollout. The contested-cwd census refuses both
        // (Pass 2's same-tick claim check remains as defense-in-depth).
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.arm("t2", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.note_submit("t2", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staggered_same_cwd_armed_terminals_never_bind_uncontested() {
        // Cross-tick contested guard (A4 hardening): ambiguity refusal must
        // not be same-tick-only. While ≥2 ARMED terminals share a normalized
        // cwd, NO candidate with that cwd binds for any of them — staggered
        // deadlines must not let pane A grab pane B's rollout uncontested.
        let root = unique_temp_dir("staggered");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.arm("t2", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.note_submit("t2", 5_000));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        // t1's deadline fires alone: contested cwd → refuse.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // t2's deadline: still contested → refuse.
        assert!(locator.tick(5_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 2);
        // One pane exits (disarm); the survivor re-opens with a fresh Enter
        // and may now bind — re-evaluation is legitimate once uncontested.
        locator.disarm("t2");
        assert!(locator.note_submit("t1", 10_000));
        let located = locator.tick(10_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zero_candidate_window_keeps_watching_and_later_enter_reopens() {
        let root = unique_temp_dir("reopen");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        // Window closes with zero candidates → keep watching (stays armed).
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // A later Enter re-opens; the rollout appears; resolves via the new
        // Enter-anchored window.
        let enter_at = 10 * CODEX_WINDOW_MS;
        assert!(locator.note_submit("t1", enter_at));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(enter_at + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn later_enter_reopen_keeps_the_first_submit_snapshot() {
        // Slow materialization (>2 s Enter→creation) is recovered by a later
        // Enter ONLY if re-opens never re-snapshot: the pane's own late
        // rollout appears between the first window's close and the second
        // Enter, and must STAY a candidate. Only the FIRST submit
        // re-snapshots (pinned via fs_scan_count).
        let root = unique_temp_dir("reopen-snapshot");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0)); // first submit: re-snapshot
        // First window closes empty.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // The pane's own rollout lands LATE — after the window, before the
        // next Enter.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let scans_before = locator.fs_scan_count();
        assert!(locator.note_submit("t1", 10_000)); // re-open: NO re-snapshot
        assert_eq!(locator.fs_scan_count(), scans_before);
        let located = locator.tick(10_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mid_turn_enter_never_reopens_a_pending_evaluation() {
        let root = unique_temp_dir("midturn");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 100));
        // Second Enter while the first evaluation is still pending: no-op.
        assert!(!locator.note_submit("t1", 200));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_session_meta_or_malformed_first_line_is_never_a_candidate() {
        // COMPLETE (newline-terminated) garbage lines are `Probe::Never` —
        // not pending: codex writes the whole meta line + '\n' in one
        // write-then-flush, so a complete non-candidate line never becomes
        // one. (Empty/torn lines are the pending case — see the tests below.)
        let root = unique_temp_dir("badmeta");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl")),
            format!("{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"{TID}\"}}}}\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join(format!("rollout-2026-07-26T08-00-01-{TID2}.jsonl")),
            "not json at all\n",
        )
        .unwrap();
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_first_line_file_is_pending_and_binds_once_meta_lands() {
        // A3 (validated): codex CREATES the rollout file, then awaits
        // git-info collection (subprocesses, 5 s timeout each, worst ~10 s)
        // BEFORE writing the session_meta first line. A deadline scan can
        // observe the empty file — it must be a re-probed PENDING candidate,
        // never dropped by a one-shot read.
        let root = unique_temp_dir("pending");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&file, "").unwrap(); // created, meta not yet written
        // Deadline scan: pending candidate → bind NOTHING, stay unresolved.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // Meta line lands (well within grace); the next sweep binds it.
        // (write_rollout reuses the same filename — same ts, same TID.)
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(CODEX_WINDOW_MS + 300);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn readable_candidate_never_binds_while_another_new_file_is_pending() {
        // A4 (validated, CRITICAL): the pane's OWN rollout can sit
        // unreadable in the git-info gap while a FOREIGN same-cwd rollout is
        // already readable. Pending candidates are BIND-BLOCKING — the
        // readable file must not win the window.
        let root = unique_temp_dir("pending-block");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        // Pane's own file: created, first line not yet written.
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&own, "").unwrap();
        // Foreign file: fully readable, same cwd.
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        // Deadline: NOTHING binds while the pending file exists.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // Own meta line lands → TWO candidates → ambiguity refusal (fail
        // toward refusal, never a guess).
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS + 300).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pending_file_that_never_parses_expires_after_grace() {
        // Grace is bounded (A4 hardening 1): once PENDING_FIRST_LINE_GRACE_MS
        // elapses without a readable first line, the file is permanently
        // excluded and stops blocking; a surviving sole candidate may then
        // bind.
        let root = unique_temp_dir("pending-expiry");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&own, "").unwrap(); // never gains a first line
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        // First due scan sees the pending file (grace clock starts here).
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // Still blocked just before grace expiry…
        assert!(locator
            .tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS - 1)
            .is_empty());
        // …then the never-parsed file expires and the sole survivor binds.
        let located = locator.tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_sessions_root_is_tolerated_and_resolves_once_it_appears() {
        let base = unique_temp_dir("missing-root");
        let root = base.join("does-not-exist-yet");
        let locator = CodexLocator::new(root.clone());
        // arm() scans the missing root — tolerated, never a panic.
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty()); // no panic, keep watching
        assert_eq!(locator.armed_count(), 1);
        assert!(locator.note_submit("t1", 2 * CODEX_WINDOW_MS));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(3 * CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn flat_test_shape_rollout_resolves() {
        // locate_codex_rollout supports flat `<id>.jsonl`; the locator's walk
        // must too (integration fixtures seed this shape).
        let root = unique_temp_dir("flat");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, ".", TID, Some("/tmp"));
        let located = locator.tick(CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
```

- [ ] **Step 2: Run the new tests, observe each result honestly**

Run: `cargo test -p freshell-sessions codex_locator`
Expected: most pass against Task 1's implementation (these are pins of
designed behavior). Any failure is a real implementation gap — fix the
implementation minimally (never weaken a test) and note which test caught it
in the commit message.

- [ ] **Step 3: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/codex_locator.rs
git commit -m "test(sessions): pin CodexLocator window semantics and correlation guards"
```

---

### Task 3: Extract the shared adoption tail into `codex_identity.rs`

**Files:**
- Create: `crates/freshell-ws/src/codex_identity.rs`
- Modify: `crates/freshell-ws/src/codex_candidate.rs` (handler delegates its adoption tail; `codex_sessions_root` moves out)
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub(crate) mod codex_identity;` after the `codex_candidate` line at `:26`; change `:42` to `pub use codex_identity::codex_sessions_root;`)
- Test: existing `crates/freshell-ws/tests/codex_candidate_persisted.rs` and `codex_candidate_activity.rs` are the refactor guard

**Interfaces:**
- Consumes: `crate::pane_ledger::ledger_resolve_identity` (`pane_ledger.rs:699`),
  `state.identity.upsert` / `state.identity.find_by_session_including_retired`
  (`identity.rs:65`, `:176-188`), `state.registry.set_meta`,
  `ActivityHub::bind_codex_session` / `attach_codex_rollout` (`activity.rs:251`, `:271`),
  the existing broadcast frames (`TerminalSessionAssociated`, `TerminalMetaUpdated`).
- Produces (Tasks 5-7 rely on these EXACT signatures):

```rust
// crates/freshell-ws/src/codex_identity.rs
pub fn codex_sessions_root() -> Option<std::path::PathBuf>;           // moved verbatim

pub(crate) struct CodexAdoption<'a> {
    pub terminal_id: &'a str,
    pub thread_id: &'a str,
    pub rollout_path: Option<&'a std::path::Path>,
    pub cwd: Option<&'a str>,
}

/// Bind a codex identity into every home, in the load-bearing order.
/// Returns false (and adopts nothing) when the session is already bound to a
/// DIFFERENT terminal — retired-INCLUSIVE (ledger A8), preserving the
/// cross-pane hijack defense the candidate channel had.
pub(crate) async fn adopt_codex_identity(state: &crate::WsState, a: CodexAdoption<'_>) -> bool;
```

- [ ] **Step 1: Establish the green refactor baseline**

Run:
```bash
cargo test -p freshell-ws --test codex_candidate_persisted --test codex_candidate_activity -- --nocapture 2>&1 | tail -5
```
Expected: PASS (these integration tests are the refactor's safety net).
If not green on the base, STOP and report — do not refactor on red.

- [ ] **Step 2: Create `codex_identity.rs` by MOVING code (not copying)**

Move from `codex_candidate.rs` into the new module:
1. `pub fn codex_sessions_root()` (`codex_candidate.rs:102-114`) — verbatim,
   including its doc comment.
2. The private `fn broadcast_terminal_session_associated(...)`
   (`codex_candidate.rs:260-296`) — verbatim, including the PINNED-ORDER doc
   comment (`terminal.session.associated` FIRST, `terminal.meta.updated`
   SECOND; the integration tests await them in exactly this order).
3. The adoption tail (`codex_candidate.rs:204-250`) — reshaped into:

```rust
pub(crate) struct CodexAdoption<'a> {
    pub terminal_id: &'a str,
    pub thread_id: &'a str,
    pub rollout_path: Option<&'a std::path::Path>,
    pub cwd: Option<&'a str>,
}

pub(crate) async fn adopt_codex_identity(state: &crate::WsState, a: CodexAdoption<'_>) -> bool {
    // Cross-pane hijack / replay defense, retired-INCLUSIVE (ledger A8): a
    // victim's binding retires at exit, so a live-only lookup would allow
    // replaying a DEAD pane's identity onto a fresh terminal. Copied from
    // candidate guard 3b (codex_candidate.rs:167-186) — keep the exact
    // comparison semantics that code uses today; re-adopting the SAME
    // terminal is an idempotent allow. This guard is also a REQUIRED A4
    // misbind hardening for the locator path: the adoption tail must refuse
    // a thread id already bound to another terminal (Validated Premise 9),
    // so it must never be weakened when the candidate channel is deleted.
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("codex", a.thread_id)
    {
        if existing != a.terminal_id {
            tracing::warn!(
                terminal_id = %a.terminal_id,
                thread_id = %a.thread_id,
                "codex_adopt_rejected: session_bound_elsewhere"
            );
            return false;
        }
    }
    // Both identity homes — different consumers (see opencode_association.rs:135-148).
    state.identity.upsert(a.terminal_id, Some("codex"), Some(a.thread_id), a.cwd, now_ms());
    state.registry.set_meta(
        a.terminal_id,
        None,
        None,
        Some("codex".to_string()),
        Some(a.thread_id.to_string()),
    );
    // Durable ledger: binding row FIRST, pending marker delete SECOND —
    // awaited before the broadcast (fsync-before-announce).
    crate::pane_ledger::ledger_resolve_identity(state, a.terminal_id, "codex", a.thread_id, a.cwd)
        .await;
    broadcast_terminal_session_associated(state, a.terminal_id, a.thread_id, a.cwd.map(str::to_string));
    // Activity hub (channel-deferred, safe off the dispatch path): G3 —
    // codex.activity.updated / terminal.turn.complete carry the sessionId;
    // G9 — the rollout reconcile lane gets its file.
    if let Some(hub) = &state.activity {
        hub.bind_codex_session(a.terminal_id, a.thread_id);
        if let Some(path) = a.rollout_path {
            hub.attach_codex_rollout(a.terminal_id, a.thread_id, path);
        }
    }
    true
}
```

IMPORTANT adaptation notes for the mover:
- `find_by_session_including_retired`'s exact return type and comparison are
  whatever `codex_candidate.rs:167-186` does today — transplant that code, do
  not re-derive it. Same for the `now_ms()` helper import and the exact
  `identity.upsert` / `set_meta` argument forms at `codex_candidate.rs:204-218`.
- `attach_codex_rollout` at the old site passed the CLIENT's path; here the
  path is server-discovered. The hub signature takes `&Path` — pass it through.

4. Rewrite `handle_codex_candidate_persisted` so that after guards 0-3a it
   calls `adopt_codex_identity(state, CodexAdoption { terminal_id: &msg.terminal_id, thread_id, rollout_path: Some(Path::new(&msg.rollout_path)), cwd: row.cwd.as_deref() }).await`
   — deleting the now-duplicated guard 3b block and the old inline tail.
   Guard 4 (`verify_rollout_path`) STAYS in the handler for now (client paths
   are untrusted; the locator never uses it) — it is deleted with the whole
   file in Task 7.
5. Update `lib.rs` as listed above. `main.rs` continues to compile unchanged
   because the `pub use ...::codex_sessions_root` re-export path is stable.

- [ ] **Step 3: Verify the refactor is behavior-preserving**

Run:
```bash
cargo test -p freshell-ws --test codex_candidate_persisted --test codex_candidate_activity
cargo test -p freshell-ws
```
Expected: PASS, same tests as Step 1. (The `session_bound_elsewhere` reject
now logs target `codex_identity` instead of `codex_candidate` — the
integration test asserts silence-to-client, not log text, so it stays green.)

- [ ] **Step 4: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/codex_identity.rs crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/src/lib.rs
git commit -m "refactor(ws): extract adopt_codex_identity shared adoption tail from the candidate channel"
```

---

### Task 4: Controller module + wiring (WsState, main.rs, terminal.rs call sites)

**Files:**
- Create: `crates/freshell-ws/src/codex_association.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (mod decl + `WsState.codex_locator` field)
- Modify: `crates/freshell-ws/src/terminal.rs` (arm at create, submit seam, exit disarm)
- Modify: `crates/freshell-server/src/main.rs` (construct + field + sweep)
- Test: in-file `mod tests` in `codex_association.rs`

**Interfaces:**
- Consumes: `freshell_sessions::codex_locator::CodexLocator` (Task 1),
  `crate::codex_identity::{codex_sessions_root, adopt_codex_identity, CodexAdoption}` (Task 3).
- Produces (Task 5 relies on these EXACT signatures):

```rust
// crates/freshell-ws/src/codex_association.rs
pub(crate) fn is_submit_input(data: &str) -> bool;
pub(crate) fn maybe_arm(state: &WsState, terminal_id: &str, mode: &str,
                        cwd: Option<&str>, resume_session_id: Option<&str>);
// async, unlike the opencode sibling: the FIRST submit re-snapshots
// known_files on the blocking pool, and the caller must await completion
// BEFORE writing the Enter to the PTY (see the submit seam below).
pub(crate) async fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str);
pub(crate) async fn drain_and_associate(state: &WsState);
pub fn spawn_codex_locator_sweep(state: WsState, interval: std::time::Duration);
```
plus the new state field:
```rust
// crates/freshell-ws/src/lib.rs (next to opencode_locator at ~:242)
pub codex_locator: Option<Arc<freshell_sessions::codex_locator::CodexLocator>>,
```

- [ ] **Step 1: Write the failing controller unit tests**

Create `codex_association.rs` containing (initially) only the test module.
Mirror `opencode_association.rs`'s test harness EXACTLY: copy its
`state_with_locator(...)` helper (`opencode_association.rs:227+` builds a full
literal `WsState` with `pane_ledger: PaneLedger::disabled()`), adapting the
locator field to `codex_locator: Some(Arc::new(CodexLocator::new(data_home)))`
(and `opencode_locator: None`). Tests:

```rust
    #[test]
    fn is_submit_input_matches_enter_only_sequences() {
        for yes in ["\r", "\n", "\r\n", "\r\r\n\n"] {
            assert!(is_submit_input(yes), "{yes:?} should be a submit");
        }
        for no in ["", "hello", "hello\r\n", "\u{1b}[A"] {
            assert!(!is_submit_input(no), "{no:?} should not be a submit");
        }
    }

    #[test]
    fn maybe_arm_arms_a_fresh_codex_terminal_and_ignores_others() {
        let dir = unique_temp_dir("assoc-arm");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None); // wrong mode
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), Some("resume-id")); // resuming
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None); // fresh
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn note_possible_submit_feeds_only_enter_sequences() {
        let dir = unique_temp_dir("assoc-submit");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None);
        note_possible_submit(&state, "t1", "hello").await;
        // Observable proof via the locator's own seam: "hello" must not have
        // consumed the window — a direct note_submit still returns true.
        assert!(locator.note_submit("t1", freshell_sessions::time::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
    }
```

(If `opencode_association.rs`'s tests source `now_ms` differently, copy that
exact form — the harness copy is authoritative over this sketch.)

- [ ] **Step 2: Run to verify RED**

Run: `cargo test -p freshell-ws codex_association`
Expected: COMPILE ERROR (module functions and `codex_locator` field missing).

- [ ] **Step 3: Implement the controller + wiring**

`codex_association.rs` implementation — transplant `opencode_association.rs`
(`:38-225`) with these substitutions; the drain body defers adoption to
`adopt_codex_identity`:

```rust
//! Codex terminal-pane association controller (Lane B2): arm the
//! CodexLocator at create, feed Enter submits, and on resolution adopt the
//! identity through the shared `codex_identity::adopt_codex_identity` tail.
//! Structure mirrors `opencode_association.rs` — deliberately (spec §5-shape
//! duplication over a premature provider-generic controller). One deliberate
//! deviation: the locator's windows are ENTER-ANCHORED ONLY (no spawn
//! window) — real codex materializes its rollout only at the first user
//! prompt, so `maybe_arm` only takes the snapshot and `note_possible_submit`
//! is what opens a correlation window (async: the FIRST submit re-snapshots
//! `known_files` on the blocking pool and MUST complete before the Enter is
//! written to the PTY — see the terminal.rs seam).

use crate::WsState;

/// Deliberate one-line duplicate of `opencode_association::is_submit_input`.
pub(crate) fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
) {
    if mode != "codex" {
        return;
    }
    if let Some(locator) = &state.codex_locator {
        locator.arm(terminal_id, mode, true, resume_session_id, cwd);
    }
}

/// Async, unlike the opencode sibling: the FIRST `note_submit` re-snapshots
/// `known_files` (a bounded sessions-tree walk), so it runs on the blocking
/// pool, and the CALLER MUST AWAIT this BEFORE writing the Enter to the PTY
/// — codex materializes the rollout in response to that very Enter, and a
/// re-snapshot racing after the write could capture (permanently exclude)
/// the pane's own file. Non-submit data returns immediately; later submits
/// are a cheap mutex hop.
pub(crate) async fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str) {
    if !is_submit_input(data) {
        return;
    }
    let Some(locator) = state.codex_locator.clone() else {
        return;
    };
    let terminal_id = terminal_id.to_string();
    let at_ms = now_ms();
    if let Err(err) =
        tokio::task::spawn_blocking(move || locator.note_submit(&terminal_id, at_ms)).await
    {
        tracing::warn!(error = %err, "codex_note_submit_panicked");
    }
}

pub(crate) async fn drain_and_associate(state: &WsState) {
    let Some(locator) = state.codex_locator.clone() else {
        return;
    };
    // The tick does bounded filesystem walks + first-line reads — never on
    // an async worker (same discipline as the opencode sweep).
    let located = match tokio::task::spawn_blocking(move || locator.tick(now_ms())).await {
        Ok(located) => located,
        Err(err) => {
            tracing::warn!(error = %err, "codex_locator_tick_panicked; skipping cycle");
            return;
        }
    };
    for hit in located {
        // Defense-in-depth rejects against registry truth (mirrors
        // opencode_association.rs:105-133).
        let Some(entry) = state.registry.directory().into_iter().find(|e| e.id == hit.terminal_id) else {
            tracing::warn!(terminal_id = %hit.terminal_id, "codex_association_rejected: terminal_missing");
            continue;
        };
        if entry.mode.as_deref() != Some("codex")
            || entry.status != freshell_terminal::TerminalRunStatus::Running
        {
            tracing::warn!(terminal_id = %hit.terminal_id, "codex_association_rejected: terminal_not_codex_or_not_running");
            continue;
        }
        if entry.resume_session_id.is_some() {
            tracing::warn!(terminal_id = %hit.terminal_id, "codex_association_rejected: terminal_already_bound");
            continue;
        }
        crate::codex_identity::adopt_codex_identity(
            state,
            crate::codex_identity::CodexAdoption {
                terminal_id: &hit.terminal_id,
                thread_id: &hit.thread_id,
                rollout_path: Some(&hit.rollout_path),
                cwd: entry.cwd.as_deref(),
            },
        )
        .await;
    }
}

pub fn spawn_codex_locator_sweep(state: WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            drain_and_associate(&state).await;
        }
    });
}
```

CRITICAL adaptation instruction: the registry access pattern, the exact
`directory()` entry field names/types, and the `now_ms()` import in the sketch
above MUST be transplanted from `opencode_association.rs:86-169` — that file
is the compile-truth for those forms. Where the sketch and the transplant
disagree, the transplant wins.

Wiring edits:

1. `crates/freshell-ws/src/lib.rs`:
   - `pub mod codex_association;` (next to `opencode_association` at `:36`-ish, alphabetical)
   - Add the `codex_locator` field to `WsState` next to `opencode_locator`
     (~`:242`), doc comment mirroring opencode's shape but Enter-anchored
     ("correlates a fresh codex PTY's first Enter with the new rollout JSONL
     codex writes under the sessions root — real codex materializes the file
     only at the first user prompt — so the terminal can be bound and
     `terminal.rs`'s generic resume derivation can drive `codex resume <id>`
     on restart").
   - The compiler will enumerate every literal `WsState` constructor that now
     misses the field (association tests, other in-crate tests, the
     `tests/common/mod.rs` spawn helpers, main.rs).
     Add `codex_locator: None,` everywhere except the sites Tasks 4-6 say
     otherwise (Task 6 adds ONE locator-wired spawn helper to
     `tests/common/mod.rs`; that file's existing helpers stay `None`).
2. `crates/freshell-server/src/main.rs`:
   - Next to the opencode locator construction (`:340-345` area):
     ```rust
     // Lane B2 (campaign §2.3.2): server-side codex identity locator. Same
     // sessions root the resume-time rollout locator below walks. `None`
     // when HOME/CODEX_HOME are unresolvable — every codex_association
     // entry point no-ops in that case.
     let codex_locator = freshell_ws::codex_sessions_root().map(|root| {
         std::sync::Arc::new(freshell_sessions::codex_locator::CodexLocator::new(root))
     });
     ```
   - Add `codex_locator: codex_locator.clone(),` to the `WsState` literal.
   - Next to the opencode sweep spawn (`:634-640`):
     ```rust
     // Lane B2: codex locator sweep — same cadence as the sibling sweeps.
     if codex_locator.is_some() {
         freshell_ws::codex_association::spawn_codex_locator_sweep(
             ws_state.clone(),
             AMPLIFIER_LOCATOR_SWEEP_INTERVAL,
         );
     }
     ```
3. `crates/freshell-ws/src/terminal.rs`:
   - Arm at create — immediately after the opencode `maybe_arm` (`:1518-1527`):
     ```rust
     // Lane B2: arm the codex rollout locator for a FRESH (non-resuming)
     // codex pane. Restore-created panes WITHOUT identity arm too — arm()
     // gates on resume_session_id, never a restore flag (the wave-A re-arm
     // contract).
     //
     // ORDERING NOTE (A5, validated): this arm runs AFTER the PTY spawn
     // (registry.create + adopt() have already awaited above). That is safe
     // ONLY because windows are Enter-anchored: real codex materializes its
     // rollout at the first user prompt, never in the spawn→arm gap, so the
     // snapshot cannot miss the pane's own file. Do not reinterpret this as
     // "snapshot precedes spawn" — it does not need to.
     //
     // The arm() snapshot walks the sessions tree; run it on the blocking
     // pool, not the WS dispatch path (A6: warm walks are 7-9 ms today and
     // ~100 ms at 100k files, but cold dentry cache after a reboot is the
     // one unmeasured tail).
     {
         let state = state.clone();
         let terminal_id = terminal_id.clone();
         let mode = mode.clone();
         let cwd = resolved_cwd.clone();
         let resume = resume_session_id.clone();
         let _ = tokio::task::spawn_blocking(move || {
             crate::codex_association::maybe_arm(
                 &state,
                 &terminal_id,
                 &mode,
                 cwd.as_deref(),
                 resume.as_deref(),
             );
         })
         .await;
     }
     ```
     (Adapt the exact clone set to the local variable types at the call site
     — the compile-truth is the surrounding function; the requirement is that
     `maybe_arm` executes on the blocking pool and completes before the
     create handler returns.)
   - Submit seam — ORDERING IS LOAD-BEARING, do NOT copy the opencode seam
     placement. In the `TerminalInput` match arm of `handle_client_text`
     (`terminal.rs:526-548`), the PTY write
     (`state.registry.input(&input.terminal_id, input.data.as_bytes())`,
     `:527-529`) is currently the FIRST statement, and the amplifier/opencode
     `note_possible_submit` calls come after it. The codex call must go
     BEFORE the `registry.input(...)` line and be awaited:
     ```rust
     // Lane B2: MUST complete before the Enter reaches the PTY — the codex
     // locator's FIRST-submit re-snapshot has to finish before codex can
     // materialize the rollout this very Enter triggers (else the pane's
     // own file could land in the snapshot and be permanently excluded).
     // Sound here: this socket task processes frames sequentially, and the
     // enclosing handler is already async. Non-submit data returns
     // immediately; only the first Enter of an armed codex pane scans
     // (7-9 ms warm — A6).
     crate::codex_association::note_possible_submit(state, &input.terminal_id, &input.data).await;
     ```
     Leave the amplifier/opencode seams where they are (they are in-memory
     and order-insensitive).
   - Exit disarm — in the `ExitHook` closure (`:1354`, `:1377-1379` pattern):
     clone `let codex_locator = state.codex_locator.clone();` next to the
     opencode clone, and inside the closure after the opencode disarm add
     `if let Some(locator) = &codex_locator { locator.disarm(&tid); }`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cargo test -p freshell-ws codex_association
cargo test -p freshell-ws
cargo test -p freshell-server 2>&1 | tail -3
```
Expected: PASS (new tests + no regressions across the two crates).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/codex_association.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-server/src/main.rs
git commit -m "feat(ws): codex locator controller + arm/submit/disarm seams + 150ms sweep wiring"
```
(Include any other files the WsState-field compile sweep touched.)

---

### Task 5: drain_and_associate end-to-end behavior (identity, ledger, broadcasts, re-arm, hijack)

**Files:**
- Modify: `crates/freshell-ws/src/codex_association.rs` (test module)
- Test: same file

**Interfaces:**
- Consumes: everything from Tasks 1-4; `PaneLedger::new(Some(dir))`,
  `state.pane_ledger` (`pane_ledger.rs`), broadcast receiver from the harness.
- Produces: behavioral pins (no new API).

- [ ] **Step 1: Write the failing tests**

Copy the two `#[tokio::test]` patterns from `opencode_association.rs:434` and
`:530` (they spawn a REAL shell PTY via `freshell_platform::build_spawn_spec`
+ `registry.create`, then poll `drain_and_associate` up to 40× / 100 ms) and
adapt to codex. Also copy `state_with_locator_and_ledger(data_home, ledger_dir)`
(`opencode_association.rs` harness) so the ledger assertions run against a
REAL `PaneLedger::new(Some(dir))`. The codex adaptations, per test:

```rust
    /// Fresh codex pane: rollout appears after arm → sweep binds identity,
    /// writes the durable binding row, and broadcasts both frames in the
    /// pinned order.
    #[tokio::test]
    async fn drain_and_associate_binds_identity_ledger_and_broadcasts() {
        // Harness: state_with_locator_and_ledger; register a real PTY as
        // terminal "t1" with mode "codex" and cwd <dir> exactly the way the
        // opencode sibling test does; maybe_arm(&state, "t1", "codex",
        // Some(&cwd), None).
        //
        // Then OPEN THE WINDOW FIRST:
        // note_possible_submit(&state, "t1", "\r").await — windows are
        // Enter-anchored (no spawn window), so resolution requires a submit,
        // and the FIRST submit re-snapshots known_files, so the rollout MUST
        // be seeded AFTER this call (a pre-seeded file would be captured by
        // the re-snapshot and never bind — that exclusion is the Task 1/2
        // hardening, not a bug).
        //
        // THEN write the rollout the locator must find:
        //   write a file <sessions_root>/2026/07/26/rollout-2026-07-26T08-00-00-<TID>.jsonl
        //   whose first line is {"timestamp":"...","type":"session_meta",
        //   "payload":{"id":"<TID>","cwd":"<the pane's cwd>"}}
        // (reuse the write_rollout shape from codex_locator.rs tests inline;
        // the file lands well inside the 2 s window, and the 40×100 ms drain
        // poll comfortably covers the Enter-anchored deadline).
        //
        // Poll drain_and_associate until resolution, then assert:
        //   state.identity.session_ref_for("t1") == Some(codex/<TID>)  (provider + id)
        //   registry directory entry for t1: resume_session_id == Some(<TID>)
        //   ledger.lookup_by_session("codex", <TID>).unwrap().row.live_terminal_id == Some("t1")
        //   ledger.pending_for_terminal("t1").is_none()
        //   broadcast rx yields terminal.session.associated THEN terminal.meta.updated
        //   (frame type assertions exactly as the opencode sibling does them)
    }

    /// Wave-A re-arm contract (the codex mirror of P1.10): a restore-created
    /// pane WITHOUT identity (resume None) arms like a fresh pane, records a
    /// pending marker, and resolves into the ledger — binding row first,
    /// marker gone after.
    #[tokio::test]
    async fn restore_created_pane_without_identity_arms_and_resolves_into_the_ledger() {
        // Mirror opencode_association.rs:530 verbatim, swapping: mode "codex",
        // the rollout-file seed above instead of the sqlite row, and provider
        // "codex" in the ledger lookups. Record the pending marker via
        // state.pane_ledger.record_pending("t1", "codex", Some(cwd), now)
        // before resolution, exactly as the sibling does. As in the first
        // test, call note_possible_submit(&state, "t1", "\r").await BEFORE
        // seeding the rollout — Enter-anchored windows need the submit, and
        // the first-submit re-snapshot would exclude a pre-seeded file.
    }

    /// One-writer defense survives the channel swap: a session already bound
    /// to ANOTHER terminal (including a retired binding) is never re-adopted.
    #[tokio::test]
    async fn located_session_bound_elsewhere_is_rejected() {
        // Arrange: state_with_locator; upsert identity for terminal "victim"
        // with ("codex", <TID>) via state.identity.upsert(...), then retire it
        // via state.identity.retire("victim") (the exit-path call —
        // terminal.rs:1370 area shows the exact form).
        // Register a real PTY "t1" (codex mode), arm it, then
        // note_possible_submit(&state, "t1", "\r").await to open the
        // Enter-anchored window, THEN seed the rollout for <TID> (after the
        // submit — the first-submit re-snapshot would exclude a pre-seeded
        // file), and poll drain_and_associate past the window.
        // Assert: t1 gained NO identity (state.identity.session_ref_for("t1")
        // is None) and its registry entry's resume_session_id is None.
    }
```

Write these as REAL tests (full bodies) by transplanting the opencode sibling
bodies — the comments above are the complete adaptation delta, and the
opencode file is the compile-truth for harness forms. Do not invent new
harness helpers; copy.

- [ ] **Step 2: Run to verify RED-for-the-right-reason**

Run: `cargo test -p freshell-ws codex_association -- --nocapture`
Expected: the first two tests FAIL only if Tasks 1-4 left a real gap —
otherwise they PASS immediately, which for TRANSPLANTED pins of
already-implemented behavior is acceptable ONLY after you verify each test
can fail: temporarily invert one core assertion per test (e.g. assert the
identity is `None`), watch it fail, restore it. Record "verified-red by
inversion" in the commit message. The third test (bound-elsewhere) exercises
Task 3's new guard end-to-end for the first time — if it passes first try,
apply the same inversion check.

- [ ] **Step 3: Fix any real gaps minimally; re-run to GREEN**

Run: `cargo test -p freshell-ws`
Expected: PASS.

- [ ] **Step 4: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/codex_association.rs
git commit -m "test(ws): codex drain_and_associate binds identity+ledger+broadcasts; re-arm and hijack pins"
```

---

### Task 6: Fresh-pane turn.complete carries sessionId (activity integration)

**Files:**
- Create: `crates/freshell-ws/tests/codex_locator_activity.rs`
- Modify: `crates/freshell-ws/tests/common/mod.rs` (ONE new spawn helper — see Step 1; without it this test CANNOT pass)
- Test: same file

**Interfaces:**
- Consumes: the per-test helpers in
  `crates/freshell-ws/tests/codex_candidate_activity.rs` (`write_fake_codex`
  `:24`, `codex_capture_spec` `:44`, `send_create` `:64`, `wait_for_frame`
  `:110` — all local to that file; copy them, that file is deleted next
  task, so the new file must be self-contained), the shared harness in
  `tests/common/mod.rs`, and the locator pipeline from Tasks 1-5.
- HARNESS GAP (load-bearing): every existing `spawn_server_*` helper in
  `tests/common/mod.rs` builds its `WsState` literal with
  `amplifier_locator: None, opencode_locator: None` (`:135/:215/:291/:356`)
  — after Task 4's compile sweep they all get `codex_locator: None` too —
  and NO test harness spawns any locator sweep (sweeps live only in
  `main.rs:626/:636`). A test spawned through the unmodified harness has no
  locator and no sweep, so identity can never resolve and every await below
  would time out. Step 1 therefore adds a locator-wired helper.
- Produces: the closing pin for the identity-less status gap — fresh codex
  panes' `codex.activity.updated` / `terminal.turn.complete` carry
  `sessionId` with NO client candidate frame.

- [ ] **Step 1: Write the failing test (and the harness helper it needs)**

First, in `crates/freshell-ws/tests/common/mod.rs`, add ONE new spawn helper
following that file's established copy-a-variant convention: copy
`spawn_server_with_specs_and_activity` (`:243-307`) into a sibling

```rust
pub async fn spawn_server_with_specs_activity_and_codex_locator(
    specs: /* same as the donor */,
    codex_sessions_root: &std::path::Path,
) -> /* same return type as the donor */
```

with exactly two deltas from the copied body (everything else identical):
1. In the `WsState` literal, set
   `codex_locator: Some(std::sync::Arc::new(freshell_sessions::codex_locator::CodexLocator::new(codex_sessions_root.to_path_buf()))),`
   instead of `None`.
2. Immediately BEFORE the `freshell_ws::router(state)` line, spawn the sweep
   on a clone (`WsState` is `Clone` with shared-`Arc` fields, so the sweep
   and the router see the same locator/registry/identity):
   ```rust
   // Mirrors main.rs's sweep wiring; 150 ms is re-declared here because
   // main.rs's AMPLIFIER_LOCATOR_SWEEP_INTERVAL is private to the server
   // binary.
   freshell_ws::codex_association::spawn_codex_locator_sweep(
       state.clone(),
       std::time::Duration::from_millis(150),
   );
   ```
The other spawn helpers in `common/mod.rs` keep `codex_locator: None`
(Task 4's compile sweep). The test passes
`<CODEX_HOME>/sessions` as `codex_sessions_root` — the same root
`codex_sessions_root()` resolves in the real server.

Then create `crates/freshell-ws/tests/codex_locator_activity.rs`:

```rust
//! Lane B2: a FRESH codex terminal (no resume id, NO client candidate frame)
//! gains identity from the server-side rollout locator, and its activity
//! frames carry the sessionId — closing the "terminals created before any
//! candidate" status gap.
//!
//! Harness copied from the (retired) codex_candidate_activity.rs: real
//! server, real socket, real PTY running a fake codex binary, CODEX_HOME
//! pointed at a tempdir.
```

Body (single `#[tokio::test(flavor = "multi_thread")] #[cfg(unix)]`), copied
from `codex_candidate_activity.rs::adopted_candidate_identity_reaches_codex_activity`
(`:133+`) with this exact delta:
1. Keep: `CODEX_HOME` tempdir env, server spawn, fake codex
   binary/`codex_capture_spec()`, creating a FRESH codex terminal over the
   socket, the `codex.activity.updated` await helper.
2. SPAWN through the new helper: set the `CODEX_HOME` tempdir env exactly as
   the donor does, then call
   `spawn_server_with_specs_activity_and_codex_locator(vec![codex_capture_spec()], &codex_home.join("sessions"))`
   instead of `spawn_server_with_specs_and_activity(...)`.
3. DELETE the candidate-frame send. Instead, AFTER the terminal is created
   (locator armed at create), run this exact sequence — the order is
   load-bearing because the FIRST submit re-snapshots `known_files` (Task 1
   hardening), so the rollout must NOT exist yet at the first Enter:
   a. Send a single `terminal.input` of `"\r"` over the socket: windows are
      Enter-anchored (validated A1 — real codex materializes the rollout
      only at the first user prompt; there is no spawn window), and this
      first Enter takes the re-snapshot and opens the 2 s window.
   b. Sleep ~3 s (`tokio::time::sleep`) so that first window resolves with
      zero candidates (deadline 2 s + 150 ms sweep, with margin).
   c. Write the rollout file the locator must find:
      `<CODEX_HOME>/sessions/2026/07/24/rollout-2026-07-24T12-00-00-<THREAD>.jsonl`
      with first line
      `{"timestamp":"2026-07-24T12:00:00.000Z","type":"session_meta","payload":{"id":"<THREAD>","cwd":"<terminal cwd>"}}`
      — the terminal's cwd is whatever the harness passed to
      terminal.create; use that same value.
   d. Send a second `terminal.input` of `"\r"`: a later Enter re-opens a
      resolved window WITHOUT re-snapshotting (pinned by Task 2's
      `later_enter_reopen_keeps_the_first_submit_snapshot`), so the file
      written in (c) is deterministically the sole new candidate.
4. Await `codex.activity.updated` carrying `sessionId == <THREAD>` (the
   harness helper spawns the same 150 ms sweep main.rs uses; give the await
   the same generous timeout the donor test used — it must cover the ~2 s
   Enter-anchored deadline after (d)).
5. Then append two task-event lines to the SAME rollout file (copy the
   `event_msg` line shapes from `activity.rs`'s `codex_event_line` helper,
   `:2381-2385` — `task_started` then `task_complete`, timestamps now-ish),
   and await a `terminal.turn.complete` frame asserting
   `provider == "codex"` AND `session_id == Some(<THREAD>)` — this proves the
   locator's `attach_codex_rollout` handed the file to the status watcher and
   completions are stamped.

Note on determinism: resolution REQUIRES an Enter — there is no spawn
window — and the rollout must be written strictly BETWEEN the first Enter's
re-snapshot and a later Enter's re-opened window; the two-Enter sequence in
step 3 guarantees that ordering without racing the server (the test cannot
observe when the server finishes processing an input frame, so "write the
file right after sending the first `\r`" would race the re-snapshot and
could permanently exclude the file). If flake appears, lengthen the (b)
sleep or send another `"\r"` — every later Enter re-opens the window against
the same frozen snapshot (pinned by Task 2's
`zero_candidate_window_keeps_watching_and_later_enter_reopens` and
`later_enter_reopen_keeps_the_first_submit_snapshot`).

- [ ] **Step 2: Run to verify it fails for the right reason**

Run: `cargo test -p freshell-ws --test codex_locator_activity -- --nocapture`
Expected: with Tasks 1-5 landed this may already PASS — apply the inversion
check (assert `session_id` is `None`, watch it fail, restore). If it fails
for a REAL reason (e.g. `turn.complete` lacks sessionId because
`attach_codex_rollout` wasn't reached), that is the red this task exists to
fix — fix in the Task 3/4 modules, minimally. If instead the awaits time out
with identity never resolving at all, first suspect THIS task's harness
wiring (the new `common/mod.rs` helper: locator field set, sweep spawned,
root == `<CODEX_HOME>/sessions`) before touching Task 3/4 code.

- [ ] **Step 3: Run to GREEN**

Run: `cargo test -p freshell-ws --test codex_locator_activity`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/tests/codex_locator_activity.rs crates/freshell-ws/tests/common/mod.rs
git commit -m "test(ws): fresh codex pane turn.complete carries sessionId via server-side locator (adds locator-wired spawn helper to the shared harness)"
```

---

### Task 7: Retire the client candidate channel

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs:511-517` (match arm → accept-and-ignore + debug log)
- Delete: `crates/freshell-ws/src/codex_candidate.rs`
- Delete: `crates/freshell-ws/tests/codex_candidate_persisted.rs`, `crates/freshell-ws/tests/codex_candidate_activity.rs`
- Create: `crates/freshell-ws/tests/codex_candidate_inert.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (remove `pub(crate) mod codex_candidate;` at `:26`)
- Modify: `crates/freshell-ws/src/invariants.rs` (doc text only)
- Test: `crates/freshell-ws/tests/codex_candidate_inert.rs`

**Interfaces:**
- Consumes: `TerminalCodexCandidatePersisted` protocol struct — which STAYS in
  `crates/freshell-protocol` (wire-compat: the frozen client still sends it;
  contract inventory files stay valid).
- Produces: the message is out of the accepted-writer set. One writer per
  codex identity fact: the server locator (plus create-time resume ids).

- [ ] **Step 1: Write the failing inert-channel test**

Create `crates/freshell-ws/tests/codex_candidate_inert.rs` by copying the
server/socket harness AND the `send_candidate_expect_silence` ping/pong helper
from `codex_candidate_persisted.rs` (`:112-131`, before deleting it), plus its
`CODEX_HOME` tempdir setup. Single test:

```rust
//! Lane B2 / campaign §2.3.2: terminal.codex.candidate.persisted is RETIRED
//! as a writer. The frozen client still SENDS it (TerminalView.tsx:4009-4018),
//! so the server must accept-and-ignore with a debug log — never an error to
//! the client, and NEVER an identity write.

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn candidate_frame_is_accepted_ignored_and_writes_nothing() {
    // 1. Spawn the real server; create a REAL fresh codex terminal t1 (fake
    //    codex binary, exactly as the donor harness does).
    // 2. Seed a VALID rollout on disk for thread id T (the donor's
    //    session_meta seed) — i.e. a frame that would have passed all four
    //    old guards.
    // 3. Send terminal.codex.candidate.persisted{terminalId: t1,
    //    candidateThreadId: T, rolloutPath: <seeded>, capturedAt: now}.
    // 4. send_candidate_expect_silence-style ping/pong round trip: nothing
    //    is sent back, the connection stays healthy.
    // 5. Assert NO identity was written: create/list probe shows t1 with no
    //    sessionRef and no resume_session_id (use the same identity-probe
    //    assertion form the donor test used for its REJECT paths).
    // 6. The terminal still works: send terminal.input "\r" and expect no
    //    protocol error.
}
```

IMPORTANT: seed the rollout in a cwd that does NOT match t1's cwd, or create
the terminal with `resume_session_id` unset and the rollout BEFORE the
terminal exists — otherwise the LOCATOR may legitimately adopt the identity
and turn step 5 into a false failure. Simplest deterministic arrangement:
write the rollout file BEFORE creating the terminal (arm-time snapshot then
excludes it forever).

- [ ] **Step 2: Run to verify RED**

Run: `cargo test -p freshell-ws --test codex_candidate_inert -- --nocapture`
Expected: FAIL — today the handler ADOPTS the valid candidate, so step 5's
no-identity assertion fails. (If it fails to compile because the harness
helpers were copied wrong, fix the copy first; the RED must be the adoption.)

- [ ] **Step 3: Retire the channel**

1. `crates/freshell-ws/src/terminal.rs:511-517` — replace the match arm body:
   ```rust
   // RETIRED (campaign §2.3.2, Lane B2): codex identity has exactly one
   // writer — the server-side rollout locator (codex_association). The
   // frozen client still sends this frame (TerminalView.tsx durability
   // handler), so accept-and-ignore with a debug breadcrumb; never an
   // error to the client, never an identity write.
   ClientMessage::TerminalCodexCandidatePersisted(candidate) => {
       tracing::debug!(
           terminal_id = %candidate.terminal_id,
           "codex_candidate_ignored: client candidate channel retired (server locator is authoritative)"
       );
       true
   }
   ```
2. Delete `crates/freshell-ws/src/codex_candidate.rs` and its `lib.rs` mod
   line. (`verify_rollout_path` and `is_uuid_shaped` die with it: the locator
   proves ownership from paths it discovered itself under the sessions root,
   with its own shape gate — the containment check existed only for
   client-supplied paths. Coverage re-homes: ownership predicate edges live in
   `codex_locator.rs` probe tests + `codex_reconcile.rs`'s decoy test.)
3. Delete `crates/freshell-ws/tests/codex_candidate_persisted.rs` and
   `crates/freshell-ws/tests/codex_candidate_activity.rs` (superseded by
   `codex_candidate_inert.rs` and `codex_locator_activity.rs`). Dead code is
   context poison — no commented-out remnants, no "reference" copies.
4. `crates/freshell-ws/src/invariants.rs` — update the
   `terminal_identity_unresolved` doc comment (`:39-47` area): the grace
   window (`IDENTITY_RESOLUTION_GRACE_MS = 5 × AMPLIFIER_DIR_APPEAR_WINDOW_MS`
   = 10 s) now also covers the codex locator (`CODEX_WINDOW_MS` = 2 s,
   Enter-anchored, plus `PENDING_FIRST_LINE_GRACE_MS` = 10 s that applies
   ONLY in the anomalous empty-first-line gap — no numeric change here);
   mention that fresh codex panes are expected to resolve via
   `codex_association` within grace of their first Enter, and that a
   maximally slow codex git-info gap can legitimately outlast the alarm
   grace (the alarm is advisory in that case). Doc text only — no logic
   change.

- [ ] **Step 4: Run to GREEN + full-crate regression**

Run:
```bash
cargo test -p freshell-ws --test codex_candidate_inert
cargo test -p freshell-ws --test codex_session_ref_resume   # restore path UNCHANGED: sessionRef → `codex … resume <id>` argv
cargo test --workspace 2>&1 | tail -5
```
Expected: all PASS. The `codex_session_ref_resume` run is the explicit
"restore path unchanged" verification the spec demands.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/freshell-ws
git commit -m "feat(ws)!: retire terminal.codex.candidate.persisted writer - accept-and-ignore with debug log

One writer per codex identity fact (campaign §2.3.2): the server-side
rollout locator is authoritative. The protocol variant stays for
wire-compat with the frozen client; the write path, its four guards,
and both candidate integration tests are deleted (superseded by
codex_candidate_inert.rs and codex_locator_activity.rs)."
```

---

### Task 8: E2E fixture — fake codex terminal CLI that writes a real rollout

**Files:**
- Create: `test/e2e-browser/fixtures/fake-codex-terminal.mjs`

**Interfaces:**
- Consumes: env `CODEX_HOME` (set per-server by the RustServer harness),
  `FAKE_CODEX_TERMINAL_ARGV_LOG`, `FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH`.
- Produces (Tasks 9-10 rely on these EXACT behaviors):
  - fresh mode: prints `codex> `, and on the FIRST stdin chunk containing an
    Enter (CR or LF) writes
    `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
    (first line `session_meta` with `payload.id` + `payload.cwd`) then prints
    `codex: session <uuid> started`. Enter-gating (NOT first-data) is
    load-bearing: it mirrors validated Premise 7 (real codex materializes
    the rollout only at the first user prompt), and the server re-snapshots
    `known_files` before forwarding the first Enter to the PTY — a fixture
    that wrote on mere typing would land its rollout PRE-snapshot and be
    permanently excluded;
  - gate: when `FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH` is set, the write
    waits (50 ms poll) until that file exists — a never-created gate makes
    "identity never resolves" deterministic;
  - resume mode (`resume` anywhere in argv): prints
    `codex: resumed session <id>`, writes NO rollout;
  - always mirrors argv as JSONL to `FAKE_CODEX_TERMINAL_ARGV_LOG`.

- [ ] **Step 1: Write the fixture (the e2e spec in Task 9 is its failing test)**

```js
#!/usr/bin/env node
// Fake codex TERMINAL CLI for the rollout-locator e2e specs (Lane B2).
// Mirrors fake-opencode-terminal.mjs's contract, on codex's substrate: the
// identity artifact is a rollout JSONL under CODEX_HOME/sessions whose FIRST
// line is the session_meta ownership record (payload.id — never the
// filename — is the identity; payload.cwd is the locator's disambiguator).
// - fresh: prints `codex> `; on the FIRST stdin chunk containing an Enter
//   (CR/LF) writes the rollout (gated by
//   FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH when set) and prints
//   `codex: session <uuid> started`. Enter-gating mirrors real codex
//   (Premise 7: the rollout materializes only at the first user prompt) and
//   keeps the fixture on the safe side of the server's first-submit
//   known_files re-snapshot, which completes before the Enter reaches this
//   process.
// - resume (`resume` ANYWHERE in argv — resumeArgs are appended LAST after
//   `-c` overrides): prints `codex: resumed session <id>`, writes nothing.
// - argv mirrored to FAKE_CODEX_TERMINAL_ARGV_LOG as JSONL.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_CODEX_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

function codexSessionsDir() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(process.env.HOME ?? '', '.codex')
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return path.join(home, 'sessions', yyyy, mm, dd)
}

function writeRollout(threadId) {
  const now = new Date()
  const ts = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const dir = codexSessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${ts}-${threadId}.jsonl`)
  const meta = {
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: { id: threadId, cwd: process.cwd() },
  }
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`)
}

const resumeIndex = argv.indexOf('resume')
if (resumeIndex !== -1) {
  const sessionId = argv[resumeIndex + 1] ?? ''
  process.stdout.write(`codex: resumed session ${sessionId}\r\n`)
} else {
  process.stdout.write('codex> \r\n')
  let wrote = false
  process.stdin.on('data', (chunk) => {
    if (wrote) return
    const s = String(chunk)
    // Enter-anchored, like real codex (Premise 7): typing alone must not
    // create the rollout — only the first Enter does.
    if (!s.includes('\r') && !s.includes('\n')) return
    wrote = true
    const threadId = crypto.randomUUID()
    const finish = () => {
      writeRollout(threadId)
      process.stdout.write(`codex: session ${threadId} started\r\n`)
    }
    const gate = process.env.FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH
    if (gate) {
      const poll = setInterval(() => {
        if (fs.existsSync(gate)) {
          clearInterval(poll)
          finish()
        }
      }, 50)
    } else {
      finish()
    }
  })
}
process.stdin.resume()
```

- [ ] **Step 2: Smoke the fixture standalone (cheap sanity, not the real test)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/codex-rollout-locator
CODEX_HOME=/tmp/fake-codex-home-$$ node test/e2e-browser/fixtures/fake-codex-terminal.mjs <<'EOF'
hello
EOF
find /tmp/fake-codex-home-$$ -name 'rollout-*.jsonl' -exec head -c 200 {} \; ; rm -rf /tmp/fake-codex-home-$$
```
Expected: prints `codex> `, then `codex: session <uuid> started`, and the
find shows one rollout whose first line is the `session_meta` JSON with the
uuid and cwd. (stdin EOF ends the process.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/fixtures/fake-codex-terminal.mjs
git commit -m "test(e2e): fake codex terminal fixture that writes a real gated rollout JSONL"
```

---

### Task 9: E2E — fresh codex pane gains server-side identity and resumes across restart

**Files:**
- Create: `test/e2e-browser/specs/codex-terminal-restore-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (TWO edits — see step 3)

**Interfaces:**
- Consumes: `test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts`
  (the donor — copy its helper set verbatim; helpers are per-spec-owned by
  convention, copied not imported), the Task 8 fixture, the RustServer
  harness (`createE2eServerHandle`, isolated HOME, ephemeral port).
- Produces: the end-to-end user-story proof: fresh codex terminal → identity
  captured SERVER-SIDE with no client candidate → restart → relaunched with
  `codex … resume <id>`.

- [ ] **Step 1: Write the spec (this IS the failing e2e test)**

Create the spec by copying `opencode-terminal-restore-rust.spec.ts` wholesale
and applying this delta (everything not listed stays structurally identical —
boot, harness waits, leaf-diff pane identification, `persist/flushNow`,
restart-same-port, negative control):

1. Header comment: codex Lane B2; rust-only (legacy has no codex terminal
   locator).
2. Fixture install:
   ```ts
   const FAKE_CODEX_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs')
   // installFakeCli(source, 'codex', binDir) — copy the donor's helper.
   ```
3. Server env: `CODEX_CMD: fakeCodexPath`,
   `FAKE_CODEX_TERMINAL_ARGV_LOG: argLogPath` (no gate var — this is the
   positive path).
4. `setupHome` seeds `settings.codingCli.enabledProviders: ['codex']`.
5. Pane open: picker button `/^Codex CLI$/i` (manifest label is "Codex CLI" —
   `/^Codex$/` matches nothing), then the Starting-directory combobox Enter,
   exactly the donor's `openOpencodePaneAndGetLeaf` flow renamed for codex;
   wait for `codex> ` in the buffer.
6. Submit: type `hello codex` + Enter → fixture writes the rollout and prints
   `codex: session <uuid> started`.
7. Identity assertion (the server-side capture proof): poll
   `leaf.content.sessionRef?.sessionId ?? leaf.content.resumeSessionId` until
   it matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
   and `sessionRef.provider === 'codex'`. NO client candidate can exist here:
   the Rust server never emits `terminal.codex.durability.updated`, so the
   frozen client's candidate sender never fires — identity arriving at all IS
   the server-locator proof. State this in a comment, citing the validated
   client path (A7): the frozen client applies `terminal.session.associated`
   provider-generically (`App.tsx:1004-1017` → panesSlice `sessionRef`,
   `resumeSessionId` cleared), and its conflict guard only drops a push when
   the pane ALREADY holds a different sessionRef — impossible for fresh panes
   (the locator arms only unbound panes).
8. Restart + reload (donor flow). Post-restart positive proofs (BOTH):
   - buffer contains `codex: resumed session <id>`;
   - the argv log's post-restart entries contain the ADJACENT PAIR
     `resume, <id>`:
     ```ts
     const entries = await readArgvLog(argLogPath)
     const resumed = entries.some((e) => {
       const i = e.argv.indexOf('resume')
       return i !== -1 && e.argv[i + 1] === associatedSessionId
     })
     expect(resumed).toBe(true)
     ```
     (codex's `resumeArgs: ["resume", "{{sessionId}}"]` is a subcommand
     appended LAST — never assert `argv[0]`.)
9. Negative control (donor's shape): a second codex pane that NEVER submits —
   the fixture writes no rollout, so after restart it restores fresh:
   `sessionRef`/`resumeSessionId` both undefined, status not `error`, fresh
   `codex> ` in the buffer.

- [ ] **Step 2: Run to verify RED-then-GREEN honestly**

The spec is new; with Tasks 1-7 landed it should pass. Prove it tests the
right thing exactly like the wall convention does: first run it, and if it
passes first try, re-run once with the gate env
(`FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH` pointed at a never-created path)
temporarily added to the server env — the identity poll in step 7 must then
time out (RED), proving the assertion depends on the real locator resolution.
Remove the temporary gate. Run:
```bash
cd /home/dan/code/freshell/.worktrees/codex-rollout-locator
npx playwright test -c test/e2e-browser/playwright.config.ts --project=rust-chromium codex-terminal-restore-rust
```
Expected: 1 passed (after the deliberate gate-RED check).
Note: e2e builds `freshell-server` in release mode on first run — allow a
long timeout (10+ min) for the first invocation.

- [ ] **Step 3: Register the spec (two edits, both required)**

In `test/e2e-browser/playwright.config.ts`:
1. Add to `RUST_ONLY_SPECS` (`:81-130`):
   ```ts
   // Lane B2 codex rollout locator: rust-only (legacy has no codex terminal
   // locator); imports the RustServer-backed harness for same-port restart.
   /codex-terminal-restore-rust\.spec\.ts$/,
   ```
2. Repeat the same regex (with the same comment) in the `rust-chromium`
   project's explicit `testMatch` array (`:183-287`). Do NOT add to
   `MATRIX_SPECS`.
Re-run the Step 2 command; also run
`npx playwright test -c test/e2e-browser/playwright.config.ts --project=chromium --list | grep -c codex-terminal-restore`
Expected: rust-chromium runs it (1 passed); the chromium `--list` count is 0
(ignored in match-all projects).

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/codex-terminal-restore-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): fresh codex pane gains server-side identity and resumes via 'codex resume <id>' across restart"
```

---

### Task 10: E2E — SIGKILL inside the codex locator window leaves a durable fresh-by-race marker

**Files:**
- Modify: `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts`

**Interfaces:**
- Consumes: that file's own helpers (`installFakeCli(binDir, name, source)` —
  NOTE the argument order differs from the Task 9 donor; `seedConfig()`,
  `openCliPane`, `listFiles`, `within5s`, `selectShellIfPickerShowing`), the
  Task 8 fixture with `FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH`.
- Produces: the codex fresh-by-race durability pin — pending marker survives
  SIGKILL, zero binding rows.

- [ ] **Step 1: Write the failing-shaped test**

Append a sibling of the opencode test at `:194` (copy its body verbatim,
then apply this delta):

```ts
  test('SIGKILL inside the codex locator window leaves a durable fresh-by-race marker', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Delta from the opencode sibling above:
    // - fixture: fake-codex-terminal.mjs installed as 'codex'
    //   (this file's installFakeCli argument order: (binDir, name, source)).
    // - env: CODEX_CMD + FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH pointed at a
    //   path we NEVER create — the rollout deterministically never lands, so
    //   identity provably cannot resolve pre-kill and the pending marker is
    //   the only evidence.
    // - pane: openCliPane(page, /^Codex CLI$/i), then click the pane's xterm
    //   and type + Enter (the codex ledger pending marker exists from spawn —
    //   codex is already in MARKER_MODES — and the typed Enter is what opens
    //   the locator window at all: windows are Enter-anchored, so this is a
    //   true inside-the-window kill).
    // - assertions: identical — pending/*.json survives restartAbrupt(),
    //   bindings/ has zero *.json.
  })
```

Write the FULL body (no elisions) by transplanting `:194-255` with the delta
above.

- [ ] **Step 2: Run it**

```bash
npx playwright test -c test/e2e-browser/playwright.config.ts --project=rust-chromium pane-ledger-restart-rust
```
Expected: ALL tests in the file pass, including the new codex one and the
pre-existing codex pending-marker test at `:149`. The new test's premise is
made deterministic by the never-created gate (mirror of the opencode
DETERMINISM note). If the new test passes first try, verify it can fail:
temporarily flip the bindings assertion to `toBeGreaterThan(0)`, watch it
fail, restore.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts
git commit -m "test(e2e): codex SIGKILL-inside-locator-window leaves durable fresh-by-race pending marker"
```

---

### Task 11: Full verification, contract-wall pin evaluation, push (STOP before PR)

**Files:**
- Possibly modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (pin deletions ONLY if the wall run demands them)

**Interfaces:**
- Consumes: everything above.
- Produces: green evidence across all gates; pushed branch; NO PR.

- [ ] **Step 1: Rust gates (the CI-exact commands)**

```bash
cd /home/dan/code/freshell/.worktrees/codex-rollout-locator
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all clean/PASS. Fix anything real; never `#[allow]` your way past
clippy without a stated reason in the code comment.

- [ ] **Step 2: Coordinated TS suites**

```bash
FRESHELL_TEST_SUMMARY="lane B2 codex rollout locator - full verification" env -u FRESHELL_BIND_HOST npm test
```
Expected: PASS. If the coordinator gate is held by a sibling lane, WAIT (check
`npm run test:status`) — never kill a foreign holder. If the worktree lacks
deps: `npm ci` and, if tsx is missing, `ln -s ../node_modules/tsx node_modules/tsx`.

- [ ] **Step 3: E2E suite for the touched specs + the contract wall**

```bash
npx playwright test -c test/e2e-browser/playwright.config.ts --project=rust-chromium \
  codex-terminal-restore-rust pane-ledger-restart-rust codex-terminal-bounce-rust compound-restart-rust
npx playwright test -c test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust
```
Expected for the first command: all pass — `codex-terminal-bounce-rust` and
`compound-restart-rust` pin `not.toContain('terminal_identity_unresolved')`,
which the locator must keep green.

Contract-wall interpretation (Playwright semantics: a `test.fail`-pinned test
that PASSES is reported as a hard failure — that is the flip signal):
- Pins `:1679` (claude-shaped) and `:1803` (opencode-shaped) are expected to
  STILL FAIL-AS-PINNED — this lane's locator is codex-scoped. Leave them.
- If any pinned test reports "passed unexpectedly", DELETE that test's
  `test.fail(...)` line (nothing else), re-run the wall, and name the flipped
  pin in the commit message.
- The un-pinned codex contracts `:738` (sessionRef-bound codex resumes with
  `resume <id>` after SIGKILL) and `:925` (freshcodex rebind) MUST still pass
  — any regression here is a stop-the-line bug in this lane.

- [ ] **Step 4: Commit any pin flips (only if Step 3 demanded them)**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(e2e): flip restore-contract-wall pins now green under the codex server-side locator"
```

- [ ] **Step 5: One-writer merge-time gate (mechanical, before push)**

Sibling lanes run concurrently; the "one writer per codex identity fact"
claim must be re-proven against the integration base, not just this
worktree. After rebasing/merging onto the integration base (and again if the
base moves before push), run:

```bash
rg "adopt_codex_identity|ledger_resolve_identity|codex.candidate|session\.associated" crates/ --type rust
git diff "$(git merge-base origin/main HEAD)"..HEAD -- crates/freshell-ws/src/terminal.rs
```

Confirm: (a) the only codex identity writers are `codex_identity.rs` /
`codex_association.rs` and the create-time resume path — no sibling lane
added another; (b) no sibling lane moved the `terminal.rs` seams this lane
edited (arm at create, submit seam, exit disarm, retired candidate match
arm). Investigate ANY unexpected hit BEFORE the final "one writer" commit
message is written; do not push over an unexplained conflict.

- [ ] **Step 6: Push the branch and STOP**

```bash
git log --oneline origin/main..HEAD          # review the task commits
git push -u origin "$(git branch --show-current)"
```
Then STOP — PR creation is NOT approved. Report: branch name, the commit
list, and the proof summary (cargo gates, coordinated suite result, e2e
results incl. wall disposition, and the scope-fence note that REST-lane
(freshell-freshagent) arming is deferred to Lane B4 by the wave's fence).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- Server-side rollout-appear locator, arm at create, Enter-anchored
  correlation windows (Validated Premise 7: real codex materializes the
  rollout only at the first user prompt — there is no spawn window; arm
  takes only the snapshot) → Tasks 1-2, 4.
- Misbind hardenings from the A4 adversarial validation (required cwd,
  pending-first-line bind-blocking grace, cross-tick contested-cwd refusal,
  bound-elsewhere adoption refusal, first-submit known_files re-snapshot with
  Task 4's before-PTY-write seam ordering) → Tasks 1-4, pinned by Task 1/2's
  guard tests and Task 5 test 3; the post-first-Enter same-cwd residual
  (freshagent sidecar) is documented in
  Validated Premise 10 and named in Task 11's report, not silently absorbed.
- Reuse-don't-duplicate the wave-2 watcher → Premise Correction 2: discovery
  cannot ride the per-file status watcher (verified structural fact); the
  locator polls only-while-armed and hands the discovered path to the
  EXISTING watcher via `attach_codex_rollout` (Task 3/6) — one file-watcher,
  two consumers downstream, parsers' ownership predicate reused.
- Ledger pending marker at spawn → already live (`MARKER_MODES` includes
  "codex", `terminal.rs:101`/`:1604`); binding row at resolve → Task 3
  (`ledger_resolve_identity` inside adopt), pinned by Task 5 + Task 10.
- Broadcasts `terminal.session.associated` + `terminal.meta.updated` (pinned
  order) → Task 3 (moved verbatim), pinned by Task 5.
- Activity-hub identity bind → Task 3 (`bind_codex_session` — the real name
  of the spec's "bind_terminal_session path"), pinned by Task 6.
- Retire candidate channel: accept-and-ignore + debug log, never an error;
  write path deleted; dead code removed; reusable helpers kept only where
  reused → Task 7 (protocol variant retained for wire-compat; containment
  helper deleted WITH its only consumer; ownership-predicate coverage
  re-homed).
- Invariants reflect the locator → Task 7 step 3.4.
- Restore path (sessionRef → codex resume argv) unchanged → Task 7 step 4
  runs `codex_session_ref_resume` explicitly; Task 9 proves it end-to-end.
- Re-arm on restore-created identity-less panes → arm() gates on
  resume_session_id only (Task 1 gate test), controller comment (Task 4),
  end-to-end pin (Task 5 test 2).
- TDD red-first list: locator-resolves-after-first-Enter (T1),
  no-submit-never-binds (T1), SIGKILL-inside-window fresh-by-race
  pending-marker-no-binding (T10 e2e + T5 ledger pins), window re-open on a
  later Enter (T2), no-cwd-never-binds (T2), pending-first-line
  bind-blocking + grace expiry (T2), staggered contested-cwd refusal (T2),
  candidate inert (T7), binding row at resolve (T5), turn.complete carries
  sessionId (T6). E2E fixture + fresh → no-candidate → restart →
  `resume <id>` (T8-9). Pin flips + one-writer merge gate (T11).
- Scope fence → Global Constraints + Premise Correction 6 (freshell-freshagent
  untouched; REST-lane arming named in the final report, not silently
  dropped).

**1b. No silent deferrals:** Every user-facing behavior lands with production
code and a real end-to-end proof (Task 9 drives a real browser, real server,
real PTY, restart, argv evidence). The fixtures are test doubles for the
external codex binary only — the identity substrate they write (rollout JSONL
with session_meta first line) is the REAL production artifact shape, verified
against the repo's own real-data documentation (`durability.rs:9`,
`codex_reconcile.rs` tests). REST-created panes not arming is a spec-directed
scope fence (Lane B4 owns those crates), surfaced loudly in Task 11's report
— not silently deferred. No other requirement is stubbed.

**2. Placeholder scan:** Two tests in Task 5 and one in Task 10 direct
transplantation from a named donor test with a complete, enumerated delta
instead of repeating ~80-line harness bodies whose exact forms (55-field
WsState literals) only the donor file can supply — each names the donor
file:line and every changed element, and instructs "the transplant wins" on
any conflict. No TBDs, no "handle edge cases", no undefined names: every
type/function a later task uses is defined in an earlier task's Interfaces
block or exists on main at a cited file:line.

**3. Type consistency:** `Located { terminal_id, thread_id, rollout_path, cwd }`
(T1) is consumed field-for-field in T4's drain; `CodexAdoption`/`adopt_codex_identity`
(T3) match T4's call site; `spawn_codex_locator_sweep(WsState, Duration)` (T4)
matches main.rs wiring; `with_config(PathBuf, i64)` has no pre-epsilon
anywhere; fixture env names (`FAKE_CODEX_TERMINAL_ARGV_LOG`,
`FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH`) are identical across T8/T9/T10.
