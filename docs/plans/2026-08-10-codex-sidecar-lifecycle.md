# Codex Sidecar Lifecycle: Persistent Tracking, Reattach, and Conservative Reaping (katas ynfn + da92)

> **Provenance:** research and requirements come from the original write-plan
> session, which completed all exploration but crashed on an Anthropic provider
> error (`overloaded_error`, 2026-08-10 21:43 UTC) before emitting the plan
> document. This plan was reconstructed from that session's recovered step
> prompt, the verbatim kata bodies (ynfn, da92), and the surviving exploration
> reports under
> `/home/dan/code/freshell/.worktrees/.the-usual-logs/codex-sidecar-lifecycle/reports/`
> (`rust-sidecar.md`, `node-server-parity.md`, `tests-and-persistence.md`,
> `verbatim-snippets.md`). All file:line references below are drawn from those
> reports (extracted from this worktree at branch head); re-locate by content if
> drifted.

> **For agentic workers:** This plan is executed task-by-task by the workflow's
> execute stage: a fresh implementer per task, with a spec + quality review
> after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a freshell Rust-server restart, every codex app-server sidecar
freshell ever spawned is either (a) **reattached** to a restored pane, (b)
**reaped** after provable identity verification, or (c) **intentionally
retained with a recorded reason** — never silently orphaned (kata ynfn). A
restored codex pane whose previous sidecar survived — including one mid-agent-turn
holding the thread's active writer — reattaches its TUI to that surviving
sidecar instead of spawning a fresh one that collides with JSON-RPC `-32600
"thread ... already has an active writer"` (kata da92). Fallback to today's
fresh-spawn path whenever no live, verified, usable survivor exists.

**Architecture:** Everything lands in the Rust server (the live production
lane). Four new pieces, all in `crates/freshell-codex` behind the existing
`real-transport` feature, wired at the existing seams the research identified:

1. **Durable sidecar record store** — `~/.freshell/rust-codex-sidecars/` (a
   Rust-owned directory, deliberately NOT Node's `~/.freshell/codex-sidecars/`;
   see the Node-parity decision below), one JSON record per sidecar keyed by
   ownership id, written with the repo's `atomic_write_durable` pattern
   (`crates/freshell-ws/src/tabs_persist.rs:682-708`) and the
   `PaneLedger::new_locked` flock/disabled-fallback pattern
   (`crates/freshell-ws/src/pane_ledger.rs:236-274`). Records persist pid, ws
   listen URL, ownership id, codex session/thread id (when known), and identity
   evidence: full `/proc/<pid>/cmdline` argv + `/proc/<pid>/stat` starttime.
2. **Identity verification** — a pid is only ever trusted after `(pid,
   starttime, cmdline)` all match the record (the `proc_starttime` pid-reuse
   guard from `crates/freshell-freshagent/src/session_lease.rs:144-160`,
   deliberately duplicated into `freshell-codex` because the dependency
   direction forbids reuse). Never pattern-match process names.
3. **Reattach runtime** — a second `CodexLaunchRuntime` implementation,
   `ReattachedCodexAppServerRuntime`, whose `ensure_ready` verifies + probes the
   surviving listener and returns the EXISTING ws URL instead of spawning. The
   planner's runtime-factory seam (`CodexRuntimeFactory`,
   `crates/freshell-codex/src/launch_lifecycle.rs:46`, minted per-plan at
   `plan_create` `:308`) selects reattach-vs-spawn per plan. The TUI still runs
   `codex --remote ws://127.0.0.1:<proxy-port> … resume <id>` — the proxy
   relays to the existing sidecar port, which is how ALL `--remote` traffic is
   routed in this architecture (`remote_proxy.rs:276-340`); the requirement's
   "reattach via `codex --remote ws://127.0.0.1:<existing-port>`" is realized
   through that relay.
4. **Boot reconciler + conservative reaper** — at boot, load records, prune
   provably-stale ones, hold verified survivors as claimable; restores claim by
   session id; a grace-delayed sweep reaps verified idle unclaimed sidecars
   (SIGTERM the recorded pid only after re-verification) and RETAINS mid-turn
   ones with a recorded reason. Server shutdown retains adopted sidecars
   (records marked `retained: server-shutdown`) instead of killing them —
   surviving restarts is the feature (kata ynfn: "Killing sidecars at shutdown
   is NOT acceptable").

**Tech stack:** Rust 1.96 workspace (`crates/*`), tokio 1.52.3,
tokio-tungstenite 0.24, serde/serde_json, libc (Linux `/proc`), the committed
fake codex app-server fixture
`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (Node, drives
the 3-tier Rust test approach), cargo fmt/clippy pinned toolchain 1.96.0.

## Global Constraints (binding)

- Repo root (git worktree — all commands run here):
  `/home/dan/code/freshell/.worktrees/codex-sidecar-lifecycle`
- **PROCESS SAFETY (critical, applies to every task and every test):**
  - NEVER kill by process-name pattern (no `pkill`, no name matching). Only
    signal pids this code/test **recorded itself AND re-verified** via `(pid,
    starttime, cmdline)` immediately before signalling, or pids carrying our
    exact per-launch `FRESHELL_CODEX_SIDECAR_ID=<uuid>` env tag (the existing
    `reap_owned_codex_sidecars` discipline, `crates/freshell-codex/src/transport.rs:86-121`).
  - NEVER stop, restart, or deploy the production freshell server on port 3001.
    Building is fine; deploying requires the user's explicit "APPROVED".
  - There are ~20 live orphaned codex app-servers on this machine (evidence for
    kata ynfn; PID 545173 is mid-turn on a session the user cares about). NO
    test and NO code written by this plan may signal any of them: the new store
    starts EMPTY, the reaper only ever consults records the store contains, and
    every test uses an isolated temp store + only kills children it spawned.
  - Tests bind loopback ephemeral ports only (`127.0.0.1:0`) — never 3001/3002
    (stated convention, `crates/freshell-codex/tests/launch_lifecycle.rs` doc header).
- **CI runs `cargo fmt --all --check` + `cargo clippy --workspace --all-targets
  -- -D warnings` + `cargo clippy -p freshell-codex --features real-transport
  --all-targets -- -D warnings` — but NO `cargo test`**
  (`.github/workflows/rust-clippy.yml`). Every task must run its cargo tests
  locally and keep fmt/clippy clean; record real pass counts.
- New modules in `freshell-codex` that spawn/probe/signal go behind
  `#[cfg(feature = "real-transport")]` (matching `launch_lifecycle`,
  `remote_proxy`, `transport` — `crates/freshell-codex/src/lib.rs:78-83`). Test
  them with `cargo test -p freshell-codex --features real-transport`.
- Non-Linux platforms: identity can never be verified (no `/proc`), so reattach
  and reaping are disabled there (conservative no-op, matching the existing
  `reap_owned_codex_sidecars` non-Linux stub at `transport.rs:117-121`); the
  fresh-spawn path is unchanged.
- Prefer `SpawnedCodexAppServerRuntime::with_command(...)`-style injection over
  process-global env mutation in tests (`launch_lifecycle.rs:882-887`); any test
  that must set `CODEX_CMD`/`FAKE_CODEX_APP_SERVER_BEHAVIOR` owns its test
  binary or serializes (the `ENV_LOCK` discipline,
  `crates/freshell-freshagent/src/codex.rs:5802-5827`).
- `set_global_codex_launch_manager_for_tests(manager)` is **set-once per test
  binary** (`launch_lifecycle.rs:529-531`): a test file that installs a global
  manager gets its own file and shares one manager across its scenarios.
- Keep new Rust source files under the 1,000-line limit (`port/AGENTS.md:81`);
  split unit tests out via `#[cfg(test)] #[path = "x_tests.rs"] mod tests` as
  `pane_ledger.rs:1002-1004` does. Carry provenance comments mapping new code to
  its precedent (`session_lease.rs`, `runtime.ts:NNN`) per repo convention.
- The fake app-server fixture needs `node` on PATH and the repo's
  `node_modules` (`ws` package) — run `npm ci` once if `node_modules` is absent.
- **Measured baseline at plan commit b3df5227f** (load-bearing validation ran
  every gate + suite; `reports/V5.md`, logs `baseline-*.log` beside it):
  fmt + workspace clippy + both feature clippy legs CLEAN; `freshell-codex`
  (real-transport) 199 passed; `freshell-server` 631 passed / 1 ignored;
  `freshell-platform` 255 passed; **`freshell-ws` 490 passed + 2 pre-existing
  deterministic failures** in `tests/auto_resume_e2e.rs`
  (`crashing_agent_is_resumed_twice_then_settles_exited`,
  `reconcile_after_replacement_attaches_to_the_new_terminal` — both time out
  waiting for a terminal.created frame; reproduced 2/2). "Baseline-identical"
  for freshell-ws means: exactly these 2 and only these 2 fail. Do not chase
  them. `freshell-freshagent` was not baselined (known environmental e2e
  failures; baseline before/after only if a task must run it).
- The worktree has NO node_modules of its own: the fixture's `ws` import
  resolves via the PARENT checkout's `/home/dan/code/freshell/node_modules`
  (verified working — all fixture-driven tests passed). If that resolution
  ever breaks, running `npm ci` in the worktree requires the user's approval;
  record it rather than installing.
- `docs/index.html`: **N/A** — this is backend process-lifecycle work with no
  user-facing UI change.
- Do not touch `server/` (Node lane) — see the recorded parity decision below.

## Recorded decision: Node server parity is OUT OF SCOPE (Rust-only plan)

Per `node-server-parity.md`, the Node server (`server/`) has FULL sidecar
parity of the *spawn* behavior (detached `codex … app-server --listen` per
codex pane, `runtime.ts:1828-1843`) and its own persistence + boot reaper
(`~/.freshell/codex-sidecars/<ownershipId>.json`, `runCodexStartupReaper` at
`server/index.ts:280`). It is demoted but actively developed. This plan fixes
the **Rust lane only**, for these recorded reasons:

1. **The incident is Rust.** The live production server is the Rust server on
   port 3001; the post-restart sidecars in both katas were children of Rust
   server PID 2921377. The kata fix MUST land in the Rust restore path.
2. **No shared store is possible.** The Rust server must NOT read or write
   Node's `~/.freshell/codex-sidecars/` — that directory's semantics are owned
   by the Node boot reaper, and entering it creates a two-writer race. The house
   pattern is the `rust-session-cache.json` precedent
   (`crates/freshell-sessions/src/directory_index.rs:1428-1436`): distinct
   filename, distinct schema, no coupling. This plan therefore introduces the
   Rust-owned `~/.freshell/rust-codex-sidecars/`. Consequently Node parity is
   not a wiring change but an independent TypeScript implementation with its own
   TDD cycle — out of scope here.
3. **Severity differs.** Node's boot reaper already kills prior-generation
   sidecars (its ynfn analog is "kill", not "orphan"); it lacks only the da92
   reattach. The Rust lane today has NEITHER tracking NOR reattach.
4. **Follow-up recorded, not silent:** the final task requires the PR
   description to state this decision and to file a follow-up kata for Node-lane
   reattach parity (`kata create "Node server: codex pane restore should
   reattach to a surviving sidecar (da92 parity)" --label bug --related da92`).

Scope note within Rust (REVISED after load-bearing validation): the second
spawn site, `freshell-freshagent/src/codex.rs::spawn_sidecar`
(fresh-agent/freshcodex panes), remains excluded from THIS plan — but the
original justification ("not part of either incident") was FALSIFIED:
validation attributed at least one live orphan (pid 44963, matched to a
`freshagent.sidecar.spawned` log line) to the freshagent lane, and that lane
orphans across unclean restarts by the same mechanism (leases are in-memory
only, kill runs only at graceful shutdown, the 5s force-exit skips Drop) —
`reports/V2.md`. The recorded decision: keep this plan terminal-pane-only
(the freshagent lane has its own lease lifecycle needing its own TDD cycle),
Task 11 files a follow-up kata for freshagent-lane tracking, and the ynfn
close-out must state that this PR fixes the terminal-pane lane with the
freshagent lane tracked in the follow-up. Only the terminal-pane path
(`SpawnedCodexAppServerRuntime::ensure_ready`) changes here.

## File Structure

**New production files:**

| File | Responsibility |
|---|---|
| `crates/freshell-codex/src/sidecar_store.rs` (+ `sidecar_store_tests.rs`) | `CodexSidecarRecord` (schema v1) + `CodexSidecarStore` (flock'd dir of atomic JSON rows, disabled fallback) + `/proc` identity evidence capture & verification |
| `crates/freshell-codex/src/sidecar_reconcile.rs` (+ `sidecar_reconcile_tests.rs`) | `SidecarReconciler` (boot load/prune, claim-by-session, grace-delayed conservative reap sweep) + `ReattachedCodexAppServerRuntime` |
| `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs` | da92 end-to-end proof over the WS `terminal.create{restore:true}` door |

**Modified production files:**

| File | Change |
|---|---|
| `crates/freshell-codex/Cargo.toml` | add `serde = { workspace = true }`; new `[dev-dependencies]` with `tempfile` |
| `crates/freshell-codex/src/lib.rs` | declare the two new modules behind `real-transport`; re-export the store/reconciler seams |
| `crates/freshell-codex/src/launch_lifecycle.rs` | persist-on-spawn / scrub-on-teardown in `SpawnedCodexAppServerRuntime`; `kill_on_drop(false)` + `process_group(0)`; `note_session_id` trait seam; plan-aware `CodexRuntimeFactory`; manager shutdown-retention |
| `crates/freshell-ws/src/codex_proxy_route.rs` | forward captured thread id into the sidecar record (one call beside `mark_candidate_persisted`) |
| `crates/freshell-server/src/main.rs` | boot: construct store + reconciler, arm reap sweep; shutdown: retention before `registry.kill_all()` |
| `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs` | verify unchanged-green (it has NO terminal-pane codex assertions — reports/V4.md); optionally add a terminal-pane retention scenario with a re-scoped descendants assertion |

## Background for implementers (read before Task 1)

**The gap (code-verified):** the terminal-pane sidecar's pid lives ONLY in
memory — `struct SpawnedSidecar { ws_url, ownership_id, child: tokio::process::Child }`
(`launch_lifecycle.rs:842-846`); "The pid is never written to disk anywhere"
(`rust-sidecar.md` §1b). `SpawnedCodexAppServerRuntime::adopted_metadata` is
self-documented as "in-memory until S5's durability store lands"
(`launch_lifecycle.rs:894-897`). Restore is CLIENT-driven — no boot pane walk;
the browser replays `terminal.create{restore:true, sessionRef:{provider:"codex",
sessionId}}` frames minutes after boot (12:16 boot vs 12:34 restore in the
incident), so reaping decisions cannot be made instantly at boot.

**The restore decision point:** `prepare_launch` (`freshell-ws/src/terminal.rs:1783-1855`)
derives `resume_session_id` from `sessionRef` and calls

```rust
async fn plan_codex_managed_launch(
    state: &WsState,
    mode: &str,
    raw_cwd: Option<&str>,
    resume_session_id: Option<&str>,
    class: freshell_codex::launch_lifecycle::LaunchClass,
    cancel: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch>, PlanLaunchError>
```

(`terminal.rs:1160-1226`), which delegates to
`CodexTerminalLaunchManager::global()`. The manager owns ONE
`CodexLaunchPlanner`; the per-plan runtime is minted inside
`CodexLaunchPlanner::plan_create` via the stored factory —
`let runtime = (self.runtime_factory)();` — where

```rust
pub type CodexRuntimeFactory = Box<dyn Fn() -> Arc<dyn CodexLaunchRuntime> + Send + Sync>;
```

(`launch_lifecycle.rs:46`). **That factory is the reattach seam:** make it
plan-aware and it can hand back a runtime wrapping the surviving sidecar
instead of a spawning one. `plan_create` then starts the REAL
`CodexRemoteProxy` against whatever ws URL `ensure_ready` returns — reattach
needs zero changes to the proxy or the TUI argv builder
(`resolve_coding_cli_command`, `cli_launch.rs:478-494`).

**Why reattach avoids the -32600:** the surviving sidecar IS the thread's
active writer; `thread/resume` into the same app-server succeeds, while resume
into a fresh app-server is rejected by codex's writer lock (kata da92). The
committed fixture can script both sides: `overrides['thread/resume'] = { error:
{ code: -32600, message: … } }` (precedent
`test/integration/server/codex-session-flow.test.ts:674-684`) and
`loadedThreadIds` for mid-turn detection (`tests-and-persistence.md` §1.5).

**Validated codex behavior (load-bearing validation, `reports/V1.md` — live
experiment on the deployed 0.147.0 binary + codex-rs source at
`rust-v0.147.0`):**

- Reattach WORKS: a surviving app-server accepts new WS connections after its
  client disconnected (including mid-turn), and a new client's `thread/resume`
  into the SAME process succeeds with the in-flight turn's events streaming to
  the new client. Client disconnect does NOT abort a running turn.
- The active-writer lock is a per-thread **file flock** under
  `CODEX_HOME/thread-writer-locks/` (`writer_lock.rs:63-79`), held per LOADED
  thread and released on process exit (even SIGKILL). Consequence: killing a
  verified-unusable survivor releases the lock, so the retry's fresh spawn can
  resume the thread — the Task 6 fallback is semantically sound, not just
  structural.
- **`loaded` ≠ `mid-turn`.** Idle threads stay loaded (and writer-locked)
  indefinitely, so `thread/loaded/list` non-empty must NOT be read as
  "mid-turn" — that would convert every unclaimed idle sidecar into a
  permanent `Retained` row (the ynfn leak relabeled). The correct discriminator
  is per-thread `thread/read` status (`active` vs idle); Task 9 encodes this.
- `-32600` is codex's generic invalid-request code (writer collision, missing
  rollout, config errors all use it) — tests must match on the message
  ("active writer"), not the code alone. Also: a thread that never ran a turn
  has no rollout and is un-resumable anywhere (`-32600 "no rollout found"`) —
  fixture scenarios that script resume success must model threads with ≥1
  recorded turn.

**Why identity is `(pid, starttime, cmdline)` and not the env tag:**
`/proc/<pid>/stat` and `/proc/<pid>/cmdline` are world-readable, but
`/proc/<pid>/environ` requires ptrace access — under YAMA an orphan reparented
to init is not our descendant, so a restarted server may be UNABLE to read the
tag of the very sidecars it must verify (`session_lease.rs:162-184` doc
comment). The env-tag sweep (`reap_owned_codex_sidecars`) remains a best-effort
supplement only. (Validation nuance, `reports/V2.md`: on THIS machine same-uid
environ/fd reads of reparented orphans do work — YAMA is permissive here — but
keep the identity triple as the primary check for portability; the fd-read
ability is what makes Task 9's unreachable-sidecar writer-evidence check
viable.)

**Why sidecars survive today only accidentally:** the spawn is NOT detached —
`cmd.kill_on_drop(true)`, no `process_group`/`setsid` anywhere in `crates/`
(`rust-sidecar.md` §1b) — and graceful shutdown kills them
(`main.rs:1663-1722`: `registry.kill_all()` → … →
`CodexTerminalLaunchManager::global().shutdown()`). The incident cohorts
survived because real restarts die uncleanly (or the 5s
`SHUTDOWN_HARD_TIMEOUT` watchdog force-exits, skipping Drops). Kata ynfn is
explicit: "Killing sidecars at shutdown is NOT acceptable — surviving restarts
is a feature." Task 10 makes survival deliberate (retained + recorded) instead
of accidental (orphaned).

**Preserved constraint (A4 exclusion):** reattach only ever applies to plans
with a `resume_session_id` (restore-class), which set
`require_candidate_persistence = false` — so the 45s candidate-capture timer
(`remote_proxy.rs:117`) is never armed on this path and the A4 restore
exclusion (`terminal.rs:1830-1834`) is untouched.

---

### Task 1: Durable sidecar record store (`rust-codex-sidecars/`)

**Files:**
- Modify: `crates/freshell-codex/Cargo.toml` (add `serde = { workspace = true }`
  to `[dependencies]`; add new `[dev-dependencies]` section with
  `tempfile = "3"`)
- Modify: `crates/freshell-codex/src/lib.rs` (declare
  `#[cfg(feature = "real-transport")] pub mod sidecar_store;`)
- Create: `crates/freshell-codex/src/sidecar_store.rs`
- Create: `crates/freshell-codex/src/sidecar_store_tests.rs` (unit tests via
  `#[cfg(test)] #[path = "sidecar_store_tests.rs"] mod tests;`)

**Interfaces produced:**

```rust
pub const SIDECAR_RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSidecarRecord {
    pub record_version: u32,
    pub ownership_id: String,          // "codex-sidecar-<uuid>" (durability.rs:36)
    pub pid: u32,
    pub starttime: u64,                // /proc/<pid>/stat field 22 — pid-reuse guard
    pub cmdline: Vec<String>,          // /proc/<pid>/cmdline argv, NUL-split
    pub ws_url: String,                // the app-server's --listen URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,    // codex thread id, enriched when known
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,   // enriched at adopt
    pub server_instance_id: String,    // durability.rs::default_server_instance_id()
    pub created_at: i64,
    pub updated_at: i64,
    pub state: SidecarRecordState,     // Active | Retained { reason }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SidecarRecordState { Active, Retained { reason: String } }

pub struct CodexSidecarStore { /* root: Option<PathBuf> (None = disabled), _lock file */ }

impl CodexSidecarStore {
    pub fn new_locked(root: Option<std::path::PathBuf>) -> Self;   // flock, disabled on contention
    pub fn new(root: std::path::PathBuf) -> Self;                  // lock-free (tests)
    pub fn disabled() -> Self;
    pub fn is_enabled(&self) -> bool;
    pub fn write(&self, record: &CodexSidecarRecord) -> std::io::Result<()>; // atomic, fsync'd
    pub fn remove(&self, ownership_id: &str) -> std::io::Result<()>;
    pub fn load_all(&self) -> Vec<CodexSidecarRecord>;             // corrupt rows quarantined loudly
}
```

Layout: `<root>/<ownership_id>.json` (ownership ids are
`codex-sidecar-<uuid-v4>` — filesystem-safe as-is), `<root>/lock`, corrupt rows
renamed to `<name>.quarantined-<millis>`. Production root (wired in Task 10):
`<home>/.freshell/rust-codex-sidecars/` — the `rust-` prefix is the
anti-collision convention (see the Node-parity decision; precedent
`rust-session-cache.json`). The atomic write helper is a deliberate,
provenance-commented duplicate of
`freshell_ws::tabs_persist::atomic_write_durable(destination, temporary, bytes)`
(`tabs_persist.rs:682-708`: sibling tmp → write → `sync_all` → rename → fsync
parent dir; tmp name `{file}.tmp-{pid}-{millis}` per `pane_ledger.rs:983-1000`)
— `freshell-ws` depends on `freshell-codex`, so the helper cannot be imported
(same reason the repo already duplicates `CODEX_MANAGED_REMOTE_CONFIG_ARGS`).

- [ ] **Step 1: Write the failing unit tests** in
  `crates/freshell-codex/src/sidecar_store_tests.rs` (tempfile tempdirs, no
  global state, no processes):
  - `record_roundtrips_through_disk` — write, `load_all`, byte-equal record.
  - `write_is_atomic_sibling_tmp_then_rename` — after `write`, no `*.tmp-*`
    residue remains and the destination parses.
  - `disabled_store_is_a_silent_noop` — `disabled()`: `write`/`remove` return
    `Ok(())`, `load_all` is empty, `is_enabled()` is false.
  - `corrupt_record_is_quarantined_not_fatal` — hand-write garbage JSON +
    one healthy record; `load_all` returns the healthy one and the garbage file
    is renamed `*.quarantined-*` (fail-loud-per-row policy,
    `pane_ledger.rs` module header).
  - `second_locked_open_comes_up_disabled` — two `new_locked` on one root: the
    second is disabled (single-writer flock, `pane_ledger.rs:236-274` pattern).
- [ ] **Step 2: Verify they fail** (module doesn't exist yet → compile error is
  the red state for a new module; after stubbing the API with `todo!()`, the
  tests must fail, not pass):
  `cargo test -p freshell-codex --features real-transport sidecar_store`
- [ ] **Step 3: Implement** `sidecar_store.rs` per the interface above.
  `new_locked` follows `PaneLedger::new_locked`: `flock(LOCK_EX|LOCK_NB)` via
  `libc` on `<root>/lock`; on failure log a structured `tracing::error!` and
  come up disabled (`root: None` ⇒ every write `Ok(())` no-op). Open the lock
  file via `std::fs::File` (O_CLOEXEC by default) and KEEP it that way — a
  leaked lock fd inherited by a detached, retained sidecar (Task 3 removes
  kill_on_drop) would hold the flock after the server dies and silently
  disable the store for every future generation (reports/V6.md NA-3; add a
  comment pinning this). Keep the file <1,000 lines.
- [ ] **Step 4: Verify green:**
  `cargo test -p freshell-codex --features real-transport sidecar_store`
- [ ] **Step 5: Gates:** `cargo fmt --all --check` and
  `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings`
- [ ] **Step 6: Commit**

```bash
git add crates/freshell-codex/Cargo.toml crates/freshell-codex/src/lib.rs \
  crates/freshell-codex/src/sidecar_store.rs crates/freshell-codex/src/sidecar_store_tests.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(codex): durable rust-owned sidecar record store (rust-codex-sidecars)

Schema-v1 JSON records (pid, starttime, cmdline, ws url, ownership id,
session/terminal ids, state) in ~/.freshell/rust-codex-sidecars/, written
atomically (sibling tmp + fsync + rename, tabs_persist.rs precedent) under a
flock single-writer with the PaneLedger disabled-fallback and per-row
quarantine policies. Deliberately a distinct store from Node's
~/.freshell/codex-sidecars/ (rust-session-cache.json anti-two-writer
precedent). Groundwork for kata ynfn/da92.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 2: Pid identity evidence capture + verification

**Files:**
- Modify: `crates/freshell-codex/src/sidecar_store.rs` (add the identity
  section) and `sidecar_store_tests.rs`

**Interfaces produced** (Linux bodies `#[cfg(target_os = "linux")]`; non-Linux
stubs return `None`/`IdentityVerdict::Unverifiable` — never verified ⇒ never
killed):

```rust
/// /proc/<pid>/stat field 22; None for gone/zombie. (pid, starttime) is the
/// pid-reuse guard. Deliberate duplicate of the private
/// freshell-freshagent/src/session_lease.rs:144-160 helper (dependency
/// direction forbids importing it) — keep the parsing identical: split at the
/// LAST ')' then index 19, rejecting Z/X states.
pub fn proc_starttime(pid: i32) -> Option<u64>;

/// /proc/<pid>/cmdline, NUL-split into argv. World-readable (no ptrace/YAMA
/// constraint, unlike /proc/<pid>/environ).
pub fn proc_cmdline(pid: i32) -> Option<Vec<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityVerdict {
    /// (pid, starttime, cmdline) all match the record — this IS our sidecar.
    Verified,
    /// pid gone or zombie — the sidecar is dead; the record is stale.
    Dead,
    /// pid alive but starttime or cmdline differ — pid reuse; NEVER signal.
    Mismatch,
    /// non-Linux / evidence unreadable — NEVER signal.
    Unverifiable,
}

pub fn verify_sidecar_identity(record: &CodexSidecarRecord) -> IdentityVerdict;
```

- [ ] **Step 1: Write the failing tests** (each test spawns and reaps ONLY its
  own child — `std::process::Command::new("sleep").arg("300")` — and kills it
  in a `defer`-style guard; nothing else on the machine is ever signalled):
  - `proc_starttime_identifies_a_live_child_and_none_after_exit`
  - `verify_identity_confirms_own_spawned_child` — build a record from the
    spawned child's real `/proc` evidence → `Verified`.
  - `verify_identity_rejects_cmdline_mismatch_without_signalling` — record
    carries the live child's pid+starttime but a DIFFERENT cmdline →
    `Mismatch`; assert the child is still alive afterwards.
  - `verify_identity_reports_dead_for_missing_pid` — pid far beyond
    `/proc/sys/kernel/pid_max` reads or a reaped child → `Dead`.
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport verify_identity`
- [ ] **Step 3: Implement**, with the provenance comment citing
  `session_lease.rs:144-160` verbatim semantics.
- [ ] **Step 4: Verify green**, then `cargo fmt --all --check` and the
  `real-transport` clippy leg.
- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex/src/sidecar_store.rs crates/freshell-codex/src/sidecar_store_tests.rs
git commit -m "$(cat <<'EOF'
feat(codex): pid identity evidence + verification for sidecar records

(pid, starttime, cmdline) capture from /proc and a four-way verdict
(Verified/Dead/Mismatch/Unverifiable). Stale pids are never trusted: only
Verified may ever be signalled; environ tags are not required (YAMA can hide
them for reparented orphans). starttime parsing duplicated with provenance
from session_lease.rs (kata ynfn groundwork).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 3: Persist on spawn, scrub on teardown, survive server death

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs`
- Modify: `crates/freshell-codex/src/lib.rs` (re-export the store seam)
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs`

**Interfaces:** `SpawnedCodexAppServerRuntime` gains an injectable store:

```rust
pub fn with_command_and_store(command: impl Into<String>, store: Arc<CodexSidecarStore>) -> Self;
```

Production resolution: a process-global
`pub fn set_codex_sidecar_store(store: Arc<CodexSidecarStore>)` /
`fn codex_sidecar_store() -> Option<Arc<CodexSidecarStore>>` pair in
`sidecar_store.rs` using a `RwLock<Option<Arc<…>>>` (re-settable, unlike the
manager's `OnceLock` — tests inject per-instance instead and never touch the
global). `SpawnedCodexAppServerRuntime::new()` reads the global; absent global
⇒ disabled store ⇒ behavior identical to today (all existing tests unaffected).

The trait seam it modifies —

```rust
pub trait CodexLaunchRuntime: Send + Sync {
    fn ensure_ready(&self, cwd: Option<String>)
        -> BoxFuture<'_, Result<CodexRuntimeReady, String>>;
    fn update_ownership_metadata(&self, terminal_id: String, generation: u64)
        -> BoxFuture<'_, Result<(), String>>;
    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>>;
}
```

(`launch_lifecycle.rs:66-98`) — is unchanged in this task.

- [ ] **Step 1: Write the failing integration tests** in
  `crates/freshell-codex/tests/launch_lifecycle.rs` (the file is already
  `#![cfg(feature = "real-transport")]` and has `fake_app_server_command()` at
  `:876-895`; use `with_command_and_store(fake_app_server_command(),
  temp_store)`):
  - `ensure_ready_persists_a_verified_sidecar_record` — after `ensure_ready`,
    `store.load_all()` has exactly one `Active` record whose pid ==
    `runtime.child_pid().await`, whose `ws_url` matches the returned one, and
    whose `(starttime, cmdline)` verify as `Verified` against the live child.
  - `runtime_shutdown_removes_the_sidecar_record` — after
    `runtime.shutdown()`, the store is empty and the pid is gone
    (poll `/proc/<pid>` like the existing
    `spawned_runtime_launches_the_app_server_and_relays_through_the_proxy`).
  - `update_ownership_metadata_enriches_the_record` — record gains
    `terminal_id`.
  - `spawned_sidecar_survives_runtime_drop_without_shutdown` — call
    `ensure_ready`, then `drop(runtime)` WITHOUT `shutdown()`; assert the child
    pid is still alive (kill_on_drop is now off) **and the record still
    exists** (this is the whole point: an uncleanly-dying server leaves a
    tracked, reconcilable sidecar — not an invisible orphan). The test then
    kills its own child: re-verify identity via the record, `libc::kill(pid,
    SIGTERM)`, poll gone (only the pid this test spawned).
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport --test launch_lifecycle ensure_ready_persists`
- [ ] **Step 3: Implement** inside
  `impl CodexLaunchRuntime for SpawnedCodexAppServerRuntime` (`:939-1055`):
  - In `ensure_ready`, after the probe loop breaks (listener up): capture
    `pid = child.id()`, `starttime = proc_starttime(pid)`,
    `cmdline = proc_cmdline(pid)` (fall back to the constructed
    `program + args` if `/proc` momentarily unreadable), build the record
    (`session_id: None`, `server_instance_id: default_server_instance_id()`),
    `store.write(&record)` — write failures are logged loudly, never abort the
    launch (pane-ledger write-failure policy).
  - Change `cmd.kill_on_drop(true)` → `cmd.kill_on_drop(false)` and add
    `cmd.process_group(0);` (tokio 1.52 exposes it on Unix) with a comment
    citing kata ynfn ("surviving restarts is a feature") and the Node
    `detached: true` parity (`runtime.ts:1828-1843`). The store record now
    plays the safety-net role kill_on_drop played: an unclean death leaves a
    tracked record for boot reconcile (Task 5/9).
  - In `shutdown` (`:894-905` today: `start_kill` → 5s wait →
    `reap_owned_codex_sidecars`): after the reap, `store.remove(&ownership_id)`.
  - In both `ensure_ready` failure arms that already call
    `reap_owned_codex_sidecars(&ownership_id)` (`:861`, `:868`): also
    `store.remove(...)` if a record was written.
  - In `update_ownership_metadata` (`:883-892`): keep the in-memory tuple and
    additionally rewrite the record with `terminal_id`/`updated_at`.
- [ ] **Step 4: Full crate green:**
  `cargo test -p freshell-codex --features real-transport` — the pre-existing
  `spawned_runtime_launches_…` test must still pass (explicit `shutdown()`
  still kills; only *drop-without-shutdown* semantics changed).
- [ ] **Step 5: Cross-crate check** (consumers of the changed spawn):
  `cargo test -p freshell-ws --test codex_managed_launch_e2e` and
  `cargo test -p freshell-ws --test restore_storm` — baseline-identical.
- [ ] **Step 6: Gates:** `cargo fmt --all --check`;
  `cargo clippy --workspace --all-targets -- -D warnings`;
  `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings`
- [ ] **Step 7: Commit**

```bash
git add crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-codex/src/lib.rs \
  crates/freshell-codex/src/sidecar_store.rs crates/freshell-codex/tests/launch_lifecycle.rs
git commit -m "$(cat <<'EOF'
feat(codex): persist terminal-pane sidecar records at spawn; detach from server death

SpawnedCodexAppServerRuntime writes a verified (pid, starttime, cmdline,
ws url) record on successful spawn, enriches it at adopt, and removes it on
explicit shutdown. kill_on_drop(true) -> false + process_group(0): a dying
server no longer silently kills or silently orphans sidecars — an unclean
death now leaves a TRACKED record for boot reconciliation (kata ynfn).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 4: Session-id enrichment (`note_session_id` seam)

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs`
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs`
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs`,
  `crates/freshell-ws/tests/codex_candidate_inert.rs` harness pattern for the ws leg

**Interfaces:** one new trait method with a default no-op (so `FakeRuntime`
implementations in tests keep compiling), plus a manager forwarder mirroring the
existing manager-level seam it sits beside —
`pub async fn mark_candidate_persisted(&self, terminal_id: &str)`
(`launch_lifecycle.rs:762-780`):

```rust
// on trait CodexLaunchRuntime (default impl: Ok(()))
fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
    let _ = session_id;
    Box::pin(async { Ok(()) })
}

// on CodexTerminalLaunchManager (adopted-map lookup, silent no-op for unknown ids)
pub async fn note_session_id(&self, terminal_id: &str, session_id: &str);
```

Resume launches get the id at plan time; fresh launches get it when the proxy
captures the thread candidate.

- [ ] **Step 1: Write the failing tests:**
  - `plan_create_notes_the_resume_session_id_on_the_runtime`
    (freshell-codex integration): extend the existing `FakeRuntime`
    (`crates/freshell-codex/tests/launch_lifecycle.rs:37-118`) to record
    `note_session_id` calls; plan with `resume_session_id: Some("s-1")` →
    the runtime saw `"s-1"`; plan fresh → no call.
  - `manager_note_session_id_reaches_adopted_runtime` — adopt, call the
    manager seam, assert the runtime recorded it; unknown terminal id is a
    silent no-op.
  - `spawned_runtime_note_session_id_enriches_the_record` — with a temp
    store: after `ensure_ready` + `note_session_id("s-1")`, the record's
    `session_id == Some("s-1")`.
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport note_session_id`
- [ ] **Step 3: Implement:**
  - Trait default as above; `SpawnedCodexAppServerRuntime` override rewrites
    the record.
  - In `CodexLaunchPlanner::plan_create` (`:238-299`), after `ensure_ready`
    succeeds: `if let Some(sid) = plan.session_id.clone() { let _ =
    runtime.note_session_id(sid).await; }`.
  - Manager forwarder beside `mark_candidate_persisted`.
  - In `freshell-ws/src/codex_proxy_route.rs` (`route_proxy_event` →
    candidate arm, `:47-115`), where the router already calls
    `CodexTerminalLaunchManager::global().mark_candidate_persisted(terminal_id)`
    after `adopt_codex_identity` returned true, add
    `.note_session_id(terminal_id, thread_id)` — the thread id is in hand at
    that call site (it just flowed through `apply_codex_identity`,
    `codex_identity.rs:182-227`).
- [ ] **Step 4: ws-side check:** run the candidate-path suites that drive that
  router — `cargo test -p freshell-ws --test codex_candidate_inert` and
  `cargo test -p freshell-ws --test codex_managed_launch_e2e` —
  baseline-identical (the new call is a no-op without an adopted spawned
  runtime + store; full ws-side proof of fresh-launch enrichment rides Task 8's
  harness).
- [ ] **Step 5: Gates:** fmt + both clippy legs.
- [ ] **Step 6: Commit**

```bash
git add crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-ws/src/codex_proxy_route.rs \
  crates/freshell-codex/tests/launch_lifecycle.rs
git commit -m "$(cat <<'EOF'
feat(codex): record the codex session/thread id in the sidecar record

New note_session_id seam (default no-op on the runtime trait): plan_create
notes resume ids at plan time; the freshell-ws proxy-event router notes
captured thread candidates beside mark_candidate_persisted. Records now carry
the session id restore-time reattach keys on (katas ynfn/da92).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 5: Boot reconciler — load, prune, claim

**Files:**
- Create: `crates/freshell-codex/src/sidecar_reconcile.rs` (+
  `sidecar_reconcile_tests.rs`), declared in `lib.rs` behind `real-transport`

**Interfaces produced:**

```rust
pub struct SidecarReconciler {
    store: Arc<CodexSidecarStore>,
    /// ALL held records, keyed by ownership_id — NOT by session id. Two live
    /// records can legitimately share a session id (a mid-turn survivor
    /// retained at sweep + a later fresh spawn enriched with the same session;
    /// validated reachable — reports/V3.md), and Verified-without-session /
    /// Unverifiable records must also be held for the sweep. Keying by
    /// session_id would silently drop records (a fifth-fate ynfn violation).
    held: Mutex<HashMap<String /*ownership_id*/, CodexSidecarRecord>>,
    /// Secondary index for restore-time claims.
    by_session: Mutex<HashMap<String /*session_id*/, Vec<String /*ownership_id*/>>>,
}

impl SidecarReconciler {
    /// Boot: load_all(); prune records whose identity verdict is Dead
    /// (remove) or Mismatch (remove — the pid is NOT ours, never signal);
    /// hold every remaining record by ownership_id (Verified with session =
    /// claimable via the index; Verified without session and Unverifiable =
    /// held for the sweep only). Returns a summary for boot logs.
    pub fn boot_reconcile(store: Arc<CodexSidecarStore>) -> (Self, BootReconcileReport);

    /// Restore-time claim: re-verify identity at claim time and return ONE
    /// record for this session. With duplicates, pick the WRITER: prefer the
    /// candidate whose live sidecar reports this session in
    /// thread/loaded/list (a bounded probe), else newest updated_at. Losers
    /// STAY held (they keep their sweep fate — never silently dropped).
    /// Retained-state records ARE claimable (re-verified; adopt flips them
    /// back to Active) — a late restore after the sweep must still reattach
    /// a mid-turn survivor instead of reproducing the -32600 (reports/V3.md).
    /// Only the returned record leaves `held`; each record is claimable ONCE.
    pub fn claim_for_session(&self, session_id: &str) -> Option<CodexSidecarRecord>;

    pub fn unclaimed_len(&self) -> usize;
}

pub fn set_codex_sidecar_reconciler(r: Arc<SidecarReconciler>);
pub fn codex_sidecar_reconciler() -> Option<Arc<SidecarReconciler>>;   // RwLock seam
```

- [ ] **Step 1: Write the failing tests** (temp store + records; live pids are
  test-spawned `sleep` children only):
  - `boot_reconcile_prunes_dead_and_mismatched_records` — three records
    (dead pid / live-`sleep`-child pid with wrong cmdline / verified child):
    after boot, store holds only the verified one, `unclaimed_len() == 1`,
    nothing was signalled (children still alive).
  - `boot_reconcile_holds_sessionless_records_for_the_sweep` — a verified
    record WITHOUT a session_id: held (`unclaimed_len()` counts it), not
    claimable by any session, not dropped.
  - `claim_for_session_returns_each_record_once` — two claims for one
    session: first `Some`, second `None`.
  - `claim_reverifies_identity_at_claim_time` — kill the test's own child
    between boot and claim → claim returns `None` and the record is removed.
  - `duplicate_session_records_claim_one_keep_the_loser_held` — two verified
    records sharing one session id (two live test children): claim returns
    one, the OTHER remains held for the sweep (`unclaimed_len() == 1` after
    the claim), and both children are still alive (nothing signalled).
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport sidecar_reconcile`
- [ ] **Step 3: Implement** per the interface. Removal on prune uses
  `store.remove`; every prune/claim decision emits a structured
  `tracing::info!/warn!` with ownership id + verdict (auditability is half the
  invariant).
- [ ] **Step 4: Green + gates** (fmt, both clippy legs).
- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex/src/sidecar_reconcile.rs crates/freshell-codex/src/sidecar_reconcile_tests.rs \
  crates/freshell-codex/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(codex): boot-time sidecar reconciler with verified claim-by-session

Loads rust-codex-sidecars records at boot, prunes Dead records and removes
Mismatch ones without ever signalling (pid reuse is never trusted), and holds
Verified survivors as one-shot claimable by codex session id, re-verifying at
claim time (katas ynfn/da92).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 6: `ReattachedCodexAppServerRuntime`

**Files:**
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (+ tests file)

**Interfaces:** a second `CodexLaunchRuntime` impl wrapping a claimed record:

```rust
pub struct ReattachedCodexAppServerRuntime {
    record: CodexSidecarRecord,
    store: Arc<CodexSidecarStore>,
    verified_usable: AtomicBool,   // set by ensure_ready; gates shutdown's kill
}
```

- `ensure_ready(cwd)`: ignore `cwd` (the survivor already has one); re-verify
  identity; probe-dial `record.ws_url` with a bounded
  `tokio::time::timeout(…, tokio_tungstenite::connect_async(&ws_url))` (the
  same probe shape as the spawn path's A6-fixed loop, `:831-872`, but a single
  short budget — reattach must fail FAST into fallback, use 3s). On success:
  mark `verified_usable`, return `CodexRuntimeReady { ws_url:
  record.ws_url.clone() }`. On failure:
  - `Mismatch`/`Unverifiable` → `store.remove(...)`, return `Err` — **no
    signal is ever sent** (this pid is not provably ours).
  - `Dead` → `store.remove(...)`, `Err`.
  - `Verified` but probe failed (dead port / handshake failure) → the
    survivor is unusable: `kill_verified_sidecar_tree(&record)` (below),
    `store.remove(...)`, `Err`. (Spec: "Fall back … when … the surviving one
    is unusable (dead port, identity mismatch, handshake failure)"; an
    unusable tracked sidecar must not leak. Killing it releases codex's
    per-thread writer-lock files on exit, so the retry's fresh spawn can
    resume the thread — validated, reports/V1.md.)
- `update_ownership_metadata` / `note_session_id`: rewrite the record (new
  terminal id, updated_at).
- `shutdown()`: pane closed or plan raced shutdown —
  `kill_verified_sidecar_tree(&record)` + `store.remove`.
  `Mismatch`/`Dead`/`Unverifiable` ⇒ remove record only.

**Shared tree-aware kill helper** (introduced here, reused by Task 9's sweep).
A3 was FALSIFIED (reports/V2.md): sidecars are process TREES (14 of the 24
live orphans have live children right now, e.g. `codex-code-mode-host`),
children live in their OWN pgids/sessions (so neither single-pid signalling
nor a pgid group-kill covers them), codex's SIGTERM handler is a graceful
drain, and SIGKILL provably orphans its children (no PDEATHSIG; cleanup is
userspace-only). "Reaped" must mean the whole tree is gone:

```rust
/// Re-verify (pid, starttime, cmdline); capture the pid's live descendant
/// set from /proc (children recursively, each snapshotted with its own
/// (pid, starttime, cmdline) so nothing is ever signalled on a stale pid);
/// SIGTERM the root; poll-gone with a drain-tolerant budget (5s, not 500ms —
/// codex drains gracefully); SIGKILL the root once if needed; then SIGTERM →
/// poll → SIGKILL each captured descendant that survived, re-verified by its
/// snapshot immediately before each signal. Returns what happened per pid.
/// Never signals anything whose snapshot no longer matches.
pub fn kill_verified_sidecar_tree(record: &CodexSidecarRecord) -> KillTreeOutcome;
```

`plan_create`'s existing cleanup-on-plan-failure (`:290-298` calls
`sidecar.shutdown()` on `ensure_ready` error) composes with this: a failed
reattach tears down via the SAME conservative path, and the retry loop
(`plan_create_with_retry`, `:312-339`) re-invokes the factory, which — the
claim being consumed — mints a fresh `SpawnedCodexAppServerRuntime`: **fallback
is structural, not special-cased.**

- [ ] **Step 1: Write the failing tests** (each spawns its own fake app-server:
  `node test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs --listen
  ws://127.0.0.1:<port>` as a direct `tokio::process::Command` child with env
  `FRESHELL_CODEX_SIDECAR_ID=<test-ownership-id>`; the test records the pid and
  kills only that pid in cleanup):
  - `reattach_ensure_ready_returns_the_existing_listener` — record built
    from the live fixture's real `/proc` evidence; `ensure_ready` returns the
    fixture's ws URL; fixture pid still alive; NO new process spawned.
  - `reattach_refuses_on_identity_mismatch_without_signalling` — record
    with the fixture's pid but a wrong cmdline → `Err`, record removed,
    fixture still alive.
  - `reattach_reaps_verified_but_unusable_survivor` — kill the fixture's
    listener by scripting `exitProcessAfterMethodsOnce`… simpler: point the
    record's `ws_url` at a port nothing listens on while pid evidence stays
    valid (spawn the fixture on port A, record port B) → `Err`, fixture pid
    reaped (gone), record removed.
  - `reattach_shutdown_kills_only_after_reverification` — successful
    `ensure_ready`, then `shutdown()` → fixture gone, record removed; and the
    negative: replace the record's starttime, `shutdown()` → fixture alive.
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport reattach_`
- [ ] **Step 3: Implement** per the sketch (keep `sidecar_reconcile.rs` under
  1,000 lines — split the runtime into `sidecar_reattach.rs` if needed).
- [ ] **Step 4: Green + gates.**
- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex/src/sidecar_reconcile.rs crates/freshell-codex/src/sidecar_reconcile_tests.rs \
  crates/freshell-codex/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(codex): reattach runtime — adopt a surviving verified sidecar instead of spawning

ReattachedCodexAppServerRuntime implements CodexLaunchRuntime over a claimed
record: ensure_ready re-verifies identity and probes the existing listener
(3s budget, fail-fast into the structural fresh-spawn fallback via the plan
retry loop). Unusable-but-verified survivors are reaped; mismatched pids are
never signalled. Teardown kills only after re-verification (kata da92).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 7: Plan-aware runtime factory (the selection seam)

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (factory type +
  `plan_create` + `global()`), `crates/freshell-codex/src/sidecar_reconcile.rs`
  (`select_codex_runtime`)
- Modify every factory construction site (mechanical closure-arity change):
  `crates/freshell-codex/tests/launch_lifecycle.rs`,
  `crates/freshell-codex/tests/global_manager_install.rs`,
  `crates/freshell-ws/tests/*` files calling
  `CodexTerminalLaunchManager::new/with_plan_budget` (locate with
  `grep -rn "CodexTerminalLaunchManager::\(new\|with_plan_budget\)" crates/`)

**Interface change** (quoting the current seam):

```rust
// BEFORE (launch_lifecycle.rs:46):
pub type CodexRuntimeFactory = Box<dyn Fn() -> Arc<dyn CodexLaunchRuntime> + Send + Sync>;
// AFTER:
pub type CodexRuntimeFactory =
    Box<dyn Fn(&CodexLaunchPlan) -> Arc<dyn CodexLaunchRuntime> + Send + Sync>;
```

`plan_create` (`:238-299`) moves the factory call AFTER
`plan_codex_launch(input)` succeeds and passes `&plan`. New pure-ish selector
(unit-testable without globals):

```rust
/// The production selection: a claimable verified survivor for the plan's
/// resume session ⇒ reattach; otherwise the spawn runtime. Reattach applies
/// only to resume plans (plan.session_id is Some ⇔ resume, launch_lifecycle.rs:169),
/// so the A4 fresh-restore exclusion and the 45s candidate-capture timer are
/// untouched.
pub fn select_codex_runtime(
    reconciler: Option<&Arc<SidecarReconciler>>,
    store: Option<&Arc<CodexSidecarStore>>,
    plan: &CodexLaunchPlan,
) -> Arc<dyn CodexLaunchRuntime>;
```

`CodexTerminalLaunchManager::global()` (`:584-590`) installs
`Box::new(|plan| select_codex_runtime(codex_sidecar_reconciler().as_ref(),
codex_sidecar_store().as_ref(), plan))`.

- [ ] **Step 1: Write the failing tests:**
  - `select_codex_runtime_prefers_a_claimable_survivor` (unit, in
    `sidecar_reconcile_tests.rs`): reconciler with a verified record for
    session `s-1` (live test-spawned fixture) — a resume plan for `s-1` gets a
    reattach runtime (probe its `ensure_ready` ws URL == the record's); a
    fresh plan or unknown session gets the spawn type; `None` reconciler gets
    spawn.
  - `plan_retry_falls_back_to_fresh_spawn_after_reattach_failure`
    (integration, `tests/launch_lifecycle.rs`): planner whose factory wraps a
    reconciler holding a **dead** record for `s-1` plus a spawn fallback using
    `fake_app_server_command()`; `plan_create_with_retry(input(resume s-1),
    attempts=2, …)` succeeds and the resulting launch is served by a fresh
    fixture (record removed, no signal sent anywhere).
- [ ] **Step 2: Verify red** (the factory-arity change won't compile until
  implemented — stub first, then red on assertions):
  `cargo test -p freshell-codex --features real-transport select_codex_runtime`
- [ ] **Step 3: Implement** the type change, thread `&plan` through
  `plan_create`, fix every closure site (`Box::new(move |_plan| …)` for
  existing fakes), implement `select_codex_runtime`, update `global()`.
- [ ] **Step 4: Whole-workspace compile + affected suites:**
  `cargo test -p freshell-codex --features real-transport` and
  `cargo test -p freshell-ws` (factory closures in ws tests updated;
  behavior baseline-identical since no reconciler global is installed there).
- [ ] **Step 5: Gates:** fmt; `cargo clippy --workspace --all-targets -- -D warnings`;
  the two `real-transport` clippy legs.
- [ ] **Step 6: Commit**

```bash
git add crates/freshell-codex/src crates/freshell-codex/tests crates/freshell-ws/tests
git commit -m "$(cat <<'EOF'
feat(codex): plan-aware runtime factory selects reattach over spawn

CodexRuntimeFactory now receives the pure launch plan; the global manager's
factory claims a verified surviving sidecar for resume plans via the
reconciler and mints ReattachedCodexAppServerRuntime, else the spawn runtime.
Claim consumption makes fresh-spawn fallback structural through the existing
plan retry loop (kata da92).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 8: da92 end-to-end — restore reattaches through the WS door

**Files:**
- Create: `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs`

**Harness (all pieces exist per the reports):** copy the `spawn_server()`
`WsState` construction + `connect_and_handshake` + `create_codex_terminal`
helpers from `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:116-200` and
`codex_session_ref_resume.rs:202-241` (`NoIndexProbe` satisfies
`gate_wire_resume` — `Unknown` ⇒ proceed, §16c of `verbatim-snippets.md`);
`write_codex_dispatcher()` from `codex_managed_launch_e2e.rs:40-114` for the
TUI/sidecar dual role via `CODEX_CMD`; the fixture's
`appendThreadOperationLogPath` behavior knob for "which listener served
`thread/resume`". Install ONE global manager for the whole binary via
`set_global_codex_launch_manager_for_tests(CodexTerminalLaunchManager::new(factory))`
whose factory closes over a test-owned `SidecarReconciler` behind a
`static Mutex<Option<Arc<…>>>` the scenarios swap (set-once global ⇒ single
test binary; scenarios run under one `#[tokio::test]` or serialized). This
binary owns process env (`CODEX_CMD`, `FAKE_CODEX_APP_SERVER_BEHAVIOR`,
`CODEX_ARGV_CAPTURE_PATH`) — note it in the file header like
`resume_validation_gate.rs:692` does.

- [ ] **Step 1: Write the failing e2e tests** (test frame fields verbatim per
  §17: `{"type":"terminal.create","requestId":…,"mode":"codex","shell":"system",
  "cwd":…,"restore":true,"sessionRef":{"provider":"codex","sessionId":…}}`):
  - `restore_reattaches_tui_to_surviving_sidecar_preserving_in_flight_turn` —
    (1) spawn the SURVIVOR: fixture on an ephemeral port with
    `FRESHELL_CODEX_SIDECAR_ID=<oid>`, behavior
    `{"appendThreadOperationLogPath": <log-A>, "loadedThreadIds": ["<sid>"]}`
    (mid-turn shape); write its verified record (session `<sid>`) into a temp
    store; reconciler over it. (2) send the restore create. (3) assert: the
    captured TUI argv contains `--remote ws://127.0.0.1:<proxy>` +
    `resume <sid>`; then, playing the TUI, dial that proxy URL with
    tokio-tungstenite, send `initialize`/`initialized` + `thread/resume
    {threadId: <sid>}` and assert a SUCCESS result — and that log-A (the
    survivor's op log) recorded the `thread/resume`, proving the pane is wired
    to the surviving mid-turn sidecar; survivor pid still alive; store record
    now carries the new `terminal_id`.
  - `restore_falls_back_to_fresh_sidecar_without_tracked_survivor` — empty
    reconciler; same create; a NEW fixture instance serves the plan (its op
    log — log-B via `FAKE_CODEX_APP_SERVER_BEHAVIOR` for the dispatcher-spawned
    sidecar — records the traffic); pane creates fine (today's path preserved).
  - `active_writer_collision_surfaces_minus32600_only_on_the_fresh_path` —
    the da92 control: empty reconciler + behavior `{"overrides":
    {"thread/resume": {"error": {"code": -32600, "message": "thread already
    has an active writer"}}}}` (the scripted rejection the fixture already
    supports, `tests-and-persistence.md` §1.6 Route A); create the pane, dial
    the proxy as the TUI, send `thread/resume` → assert the `-32600` error
    frame comes back AND its message contains "active writer" (codex uses
    -32600 generically for many rejections — reports/V1.md; the code alone
    is not the incident signature). (The incident's failure mode, now
    confined to the no-survivor path; the reattach test above proves the
    same resume SUCCEEDS when a survivor exists.)
  - Cleanup in every scenario: kill ONLY the pids the test spawned (survivor
    fixture child; `registry.kill(&terminal_id)` for panes), matching the
    existing suites.
- [ ] **Step 2: Verify red on the first test** (before Task-7's factory is
  given the test reconciler, the reattach assertion fails — if implementing
  strictly in order, red here means: with the reconciler deliberately absent,
  the survivor's op log stays empty):
  `cargo test -p freshell-ws --test codex_sidecar_reattach_e2e`
- [ ] **Step 3: Implement/fix** anything the e2e flushes out (expected: none —
  Tasks 5–7 carry the logic; this task is the proof at the wire).
- [ ] **Step 4: Green:**
  `cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --nocapture`
  plus baseline re-runs: `cargo test -p freshell-ws --test codex_session_ref_resume
  --test restore_spawn_gate --test restore_storm`
- [ ] **Step 5: Gates:** fmt + workspace clippy.
- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs
git commit -m "$(cat <<'EOF'
test(ws): e2e — codex pane restore reattaches to a surviving sidecar (da92)

terminal.create{restore:true, sessionRef} against a tracked surviving fake
app-server routes the TUI's thread/resume to the SURVIVOR (mid-turn state
preserved, pid untouched); with no tracked survivor the fresh-spawn path is
byte-compatible with today, and the scripted -32600 active-writer rejection
is confined to that fresh path — the incident shape, now guarded.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 9: Conservative reap sweep + the never-silently-orphaned invariant (ynfn)

**Files:**
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (+ tests file)

**Interfaces:**

```rust
pub const FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS_ENV: &str = "FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS";
pub const CODEX_SIDECAR_REAP_GRACE_MS_DEFAULT: u64 = 30 * 60 * 1000; // incident gap was 18 min

#[derive(Debug, PartialEq)]
pub enum SweepOutcome { Reaped, RetainedMidTurn, RetainedWriterHeld, RecordRemovedStale, RetainedUnverifiable }

impl SidecarReconciler {
    /// For every still-held, unclaimed record: re-verify identity, then
    ///   Dead / Mismatch      -> remove record, NEVER signal        (RecordRemovedStale)
    ///   Unverifiable         -> retain, state = Retained{reason:"identity-unverifiable"}
    ///   Verified + ws probe (initialize -> thread/loaded/list -> thread/read
    ///   per loaded thread; `loaded` alone does NOT mean mid-turn — idle
    ///   threads stay loaded forever, reports/V1.md):
    ///     any thread/read status ACTIVE -> retain, Retained{reason:"mid-turn-active-thread"}
    ///     reachable, no active thread   -> kill_verified_sidecar_tree, remove record (Reaped)
    ///     ws UNREACHABLE                -> /proc/<pid>/fd writer-evidence check
    ///                                      (open rollout .jsonl write handle or
    ///                                      thread-writer-locks/ file — readable
    ///                                      same-uid on this host, reports/V2.md):
    ///        evidence held  -> retain, Retained{reason:"ws-unreachable-writer-held"}
    ///        no evidence    -> kill_verified_sidecar_tree, remove record (Reaped)
    /// Sweep CONSUMES only Reaped/RecordRemovedStale entries from `held`;
    /// every Retained row STAYS held and claimable (a late restore must still
    /// reattach a mid-turn survivor — reports/V3.md), and is re-evaluated at
    /// next boot. Every decision logged with ownership id + verdict + outcome.
    pub async fn sweep_unclaimed(&self) -> Vec<(String, SweepOutcome)>;
}
```

The mid-turn probe reuses the crate's own client
(`CodexAppServerClient` over `WsTransport`, already `real-transport`):
connect → `initialize`/`initialized` → `thread/loaded/list` → `thread/read`
per loaded thread, discriminating on its status (`active` vs idle). The
fixture implements `thread/loaded/list` (`loadedThreadIds` knob,
`tests-and-persistence.md` §1.3/§1.5); EXTEND it with a scriptable
`thread/read` status knob (e.g. `threadStatuses: {"<id>": "active"|"idle"}`)
if not already present — the fixture is repo-owned. Kill mechanics use
Task 6's `kill_verified_sidecar_tree` (tree-aware — A3 falsified, sidecars
have children in their own pgids) plus the tag sweep supplement,
`reap_owned_codex_sidecars(ownership_id)` (`transport.rs:86-121`, quoted:
"we only signal processes carrying OUR unique tag").

- [ ] **Step 1: Write the failing tests** (all pids test-spawned):
  - `sweep_reaps_verified_idle_unclaimed_sidecar` — fixture with
    `{"loadedThreadIds": ["t-1"], "threadStatuses": {"t-1": "idle"}}` +
    verified record, unclaimed → after `sweep_unclaimed`: pid gone (whole
    tree), record removed, outcome `Reaped`. (Deliberately loaded-but-idle:
    pins the `loaded ≠ mid-turn` discriminator, reports/V1.md.)
  - `sweep_retains_mid_turn_sidecar_with_recorded_reason` — fixture with
    `{"loadedThreadIds": ["t-1"], "threadStatuses": {"t-1": "active"}}` →
    pid ALIVE, record present with
    `state == Retained{reason:"mid-turn-active-thread"}` (spec: "A sidecar
    mid-turn must end up reattached, not killed and not leaked" — unclaimed
    mid-turn ⇒ retained + recorded, STILL claimable, re-evaluated at next
    boot).
  - `late_restore_after_sweep_reattaches_mid_turn_survivor` — after the
    sweep retained the mid-turn fixture above, `claim_for_session` for its
    session STILL returns the record (re-verified) — a late restore
    reattaches instead of fresh-spawning into the `-32600` (A5 fix,
    reports/V3.md).
  - `sweep_never_touches_unverified_pids` — record naming a live
    test-`sleep` pid with mismatched cmdline → `RecordRemovedStale`, sleep
    child still alive.
  - `kill_verified_sidecar_tree_reaps_descendants` (unit-level, own
    processes only) — spawn a small tree the test owns (e.g. `bash -c
    'sleep 300 & sleep 300 & wait'`), build a verified record for the root,
    kill via the helper → root AND both children gone; and the negative:
    a snapshot-mismatched descendant is never signalled.
  - `restart_reconciliation_leaves_no_sidecar_silently_orphaned` — **the
    invariant test.** Seed five records: (a) claimable verified survivor,
    (b) dead pid, (c) verified idle, (d) verified mid-turn, (e) a DUPLICATE
    verified record sharing (a)'s session id (the A4 shape, reports/V3.md).
    Run `boot_reconcile` → `claim_for_session` for (a)'s session →
    `sweep_unclaimed`. Assert the exhaustive end-state: one of {(a),(e)}
    claimed (reattached-by-construction), (b) removed at boot, (c) reaped,
    (d) retained with recorded reason, and the claim LOSER of {(a),(e)}
    swept to its own fate (reaped here — idle) — `store.load_all()` contains
    ONLY the claimed Active record and (d)'s retained record. Every sidecar
    is accounted for: reattached, reaped, or intentionally retained with a
    recorded reason — never silently dropped from the books.
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport sweep_`
- [ ] **Step 3: Implement.** (Optional extra isolation: these tests signal only
  self-spawned children — same discipline as the existing
  `spawned_runtime_…` kill test — but they may also be run under the repo's
  sandbox: `scripts/sandbox-test.sh "cargo test -p freshell-codex --features
  real-transport sweep_"`.)
- [ ] **Step 4: Green + gates.**
- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex/src/sidecar_reconcile.rs crates/freshell-codex/src/sidecar_reconcile_tests.rs
git commit -m "$(cat <<'EOF'
feat(codex): conservative reap sweep — tracked, verified, never mid-turn (ynfn)

sweep_unclaimed reaps only sidecars freshell recorded AND re-verified by
(pid, starttime, cmdline) at kill time, tree-aware (descendants snapshotted
and verified before any signal); mid-turn survivors (thread/read status
active — loaded alone is NOT mid-turn) are retained with a recorded reason
and stay claimable by late restores; unreachable-but-writer-holding survivors
are retained, not killed; mismatched/unverifiable pids are never signalled.
Invariant encoded in
restart_reconciliation_leaves_no_sidecar_silently_orphaned: every tracked
sidecar (including session-id duplicates) ends reattached, reaped, or
retained-with-reason.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 10: Server wiring — boot reconcile + shutdown retention

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (manager retention)
- Modify: `crates/freshell-server/src/main.rs`
- Modify: `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs`
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs`

**Manager retention interface:**

```rust
impl CodexTerminalLaunchManager {
    /// Server-shutdown mode: adopted (terminal-owned) sidecars are RETAINED
    /// across the restart — proxies close, runtimes are asked to
    /// prepare_retention(reason) instead of shutdown. Unadopted planner
    /// sidecars (mid-plan) are still torn down. Call BEFORE registry.kill_all()
    /// so PTY-exit hooks (notify_terminal_exit) also retain instead of reap.
    pub fn begin_shutdown_retention(&self);
}

// on trait CodexLaunchRuntime (default: Ok(())):
fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>>;
```

`SpawnedCodexAppServerRuntime::prepare_retention` drops the `Child` handle
without killing (kill_on_drop is already false, Task 3) and rewrites the record
`state = Retained { reason }`. `ReattachedCodexAppServerRuntime` does the same
(no signal). `notify_terminal_exit` (`:616-623`) checks the retention flag: when
set, route the entry through retention instead of the teardown worker.
`shutdown()` (`:631-641`) with the flag set: `planner.shutdown()` still tears
down unadopted sidecars (they have no pane to reattach to and a fresh-plan
proxy may hold the candidate timer); adopted entries get proxy-close +
`prepare_retention("server-shutdown")`.

**main.rs wiring** (quoting the touch points from §14 of
`verbatim-snippets.md`):
- Boot, beside the `PaneLedger` construction (`main.rs:383-395`):
  ```rust
  let codex_sidecar_store = std::sync::Arc::new(
      freshell_codex::sidecar_store::CodexSidecarStore::new_locked(
          home.as_ref().map(|h| h.join(".freshell").join("rust-codex-sidecars")),
      ),
  );
  freshell_codex::sidecar_store::set_codex_sidecar_store(codex_sidecar_store.clone());
  ```
- Beside the `pane_ledger.boot_scan` call (`main.rs:975-999`): run
  `SidecarReconciler::boot_reconcile(store)`, log the report,
  `set_codex_sidecar_reconciler(...)`, then
  `tokio::spawn` the grace-delayed sweep
  (`sleep(reap_grace_from_env()).await; reconciler.sweep_unclaimed().await;`).
- **Disablement must be LOUD** (A10 validation, reports/V6.md: the restart
  script provably waits for old-process exit, so contention is not expected on
  the normal path — but a same-HOME scratch server on another port, e.g. the
  evidenced `--port 3499` runs, would silently disable the store with no
  timing race at all): when `!store.is_enabled()`, emit a dedicated
  `tracing::error!` at boot and carry `codex_sidecar_store_enabled: bool` in
  the logged reconcile report so a disabled generation is diagnosable from
  logs alone.
- Supervisor caveat (recorded, no code): the in-repo systemd unit is NOT
  installed today (restarts are script-driven). If it is ever adopted, its
  KillMode must not be `control-group` — cgroup kill would slaughter the
  retained sidecars that this task deliberately keeps alive
  (`process_group(0)` detaches the pgid, not the cgroup). reports/V6.md NA-1.
- Shutdown (`main.rs:1663-1722`): insert
  `freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global().begin_shutdown_retention();`
  immediately BEFORE `registry.kill_all();` (`:1329`), and leave the existing
  `…global().shutdown().await` (`:1355-1357`) in place — it now retains adopted
  sidecars and still reaps unadopted ones. Update the surrounding SAFE-11
  comment block to record the new deliberate behavior (kata ynfn).

- [ ] **Step 1: Write the failing manager tests** in
  `crates/freshell-codex/tests/launch_lifecycle.rs`:
  - `shutdown_retention_retains_adopted_sidecars_and_records_reason` — real
    spawned runtime (fake fixture) + temp store; plan, adopt,
    `begin_shutdown_retention()`, `shutdown().await` → fixture pid STILL
    ALIVE, record `Retained{reason:"server-shutdown"}`. Test then reaps its
    own fixture pid (verified) in cleanup.
  - `shutdown_still_tears_down_unadopted_planner_sidecars` — plan WITHOUT
    adopt, retention on, `shutdown()` → pid gone, record removed.
  - `notify_terminal_exit_retains_under_retention_flag` — adopted +
    retention on + `notify_terminal_exit` → pid alive, record retained
    (vs. the default flag-off behavior: teardown worker reaps — existing
    behavior, assert both arms).
- [ ] **Step 2: Verify red:**
  `cargo test -p freshell-codex --features real-transport retention`
- [ ] **Step 3: Implement** manager + trait + both runtimes + main.rs wiring.
- [ ] **Step 4: Reconcile SAFE-11.** Run
  `cargo test -p freshell-server --test safe11_term22_shutdown_reaping`
  (black-box: spawns the built binary on an ephemeral port — NEVER 3001 — and
  drives real `/ws` frames). VALIDATED (reports/V4.md): the test contains NO
  terminal-pane codex sidecar assertions — its codex coverage is a
  freshagent-lane sidecar (`freshAgent.create {sessionType:"freshcodex"}`)
  plus a shell PTY, both outside this plan's retention. Expectation:
  **the suite passes UNCHANGED** (it now doubles as a tripwire that retention
  did not leak into the freshagent lane or shell-PTY reaping). If it is
  cheap, ADD a terminal-pane codex retention scenario: create a codex
  terminal pane, graceful shutdown, assert the sidecar pid is ALIVE and the
  store row (test-owned `FRESHELL_HOME`) reads
  `Retained{reason:"server-shutdown"}`, then reap the pid from the test
  (verified) — and re-scope the test's generic "no live descendants"
  assertion to exclude the intentionally retained pid. Record the documentary
  deviation: the parity checklist's acceptance text "terminate exact
  terminal/provider/extension trees"
  (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:615`) is
  deliberately inverted for tracked codex terminal-pane sidecars (kata ynfn:
  "killing sidecars at shutdown is NOT acceptable — surviving restarts is a
  feature") — one bullet in the test header comment and in the PR description
  (Task 11).
- [ ] **Step 5: Green:** `cargo test -p freshell-codex --features
  real-transport` + `cargo test -p freshell-server`; fmt + workspace clippy +
  both feature clippy legs.
- [ ] **Step 6: Commit**

```bash
git add crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-codex/tests/launch_lifecycle.rs \
  crates/freshell-server/src/main.rs crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs
git commit -m "$(cat <<'EOF'
feat(server): boot sidecar reconcile + reap sweep; retain adopted sidecars at shutdown

Boot constructs the flock'd rust-codex-sidecars store, reconciles records
(prune stale, hold verified survivors claimable), and arms the grace-delayed
conservative sweep (FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS, default 30m —
restores arrived 18m post-boot in the incident). Graceful shutdown now
RETAINS adopted codex sidecars with a recorded reason instead of killing them
(kata ynfn: surviving restarts is a feature); unadopted mid-plan sidecars are
still torn down. SAFE-11 expectations updated with recorded rationale.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 11: Full verification sweep + parity follow-up recording

**Files:** test/verification only; fix-forward anything the sweep flushes out
in files this plan already touched.

- [ ] **Step 1: Per-crate cargo tests with real counts** (no npm wrapper
  exists for cargo; run from the worktree root; NOT `--workspace` — it drags
  tauri's GTK deps):
  ```bash
  cargo test -p freshell-codex --features real-transport
  cargo test -p freshell-ws
  cargo test -p freshell-server
  cargo test -p freshell-platform
  cargo test -p freshell-freshagent   # baseline the known environmental e2e failures before/after
  ```
  Record pass counts; `freshell-freshagent` must be baseline-identical.
- [ ] **Step 2: Mirror CI exactly:**
  ```bash
  cargo fmt --all --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo clippy -p freshell-codex   --features real-transport --all-targets -- -D warnings
  cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
  ```
- [ ] **Step 3: Safety audit of the diff** (grep-verifiable, binding):
  `git diff origin/main --stat` touches ONLY the files this plan names; grep
  the diff for `pkill|killall|kill -9 [0-9]` → zero hits; every `libc::kill`
  in new code is preceded by an identity re-verification or the ownership-tag
  needle match; no test binds port 3001; nothing writes
  `~/.freshell/codex-sidecars/` (Node's dir) —
  `grep -rn "codex-sidecars" crates/` must show only the `rust-codex-sidecars`
  literal and comments.
- [ ] **Step 4: Record the follow-ups and deviations.** Add to the eventual PR
  description: the Node-parity decision (verbatim from this plan's "Recorded
  decision" section), the freshagent-lane scope decision (revised scope note;
  the orphan cohort is NOT all terminal-pane — reports/V2.md), and the SAFE-11
  documentary deviation (Task 10 Step 4). File BOTH follow-up katas:
  `kata create "Node server: codex pane restore should reattach to a surviving sidecar (da92 parity)" --label bug --related da92 --agent --body "<summary + pointer to this plan's decision section>"`
  and
  `kata create "freshagent-lane codex sidecars orphan across unclean restarts (ynfn residue)" --label bug --related ynfn --agent --body "<summary: in-memory leases, graceful-kill-only, 5s force-exit skips Drop; evidence pid 44963 in reports/V2.md; extend rust-codex-sidecars tracking or lease persistence>"`.
  Known minor limitation to note in the PR (hub-side, out of scope): a
  reattached mid-turn pane's FIRST turn completion lands in the status hub's
  Idle arm, so its completion chime may not fire once
  (`codex_proxy_route.rs:419-423`, reports/V4.md).
  `docs/index.html`: N/A (backend lifecycle work; no user-facing UI change).
- [ ] **Step 5: Commit (only if fixes were needed)** — same trailer convention:

```bash
git add -A crates/
git commit -m "$(cat <<'EOF'
test(codex): regression fixes from the full sidecar-lifecycle sweep

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Spec-requirement → coverage map

| Requirement (task-description.md §A) | Task | Proof |
|---|---|---|
| Persist pid, ws port, session/thread id + identity evidence (cmdline + starttime); stale pids never trusted | 1, 2, 3, 4 | `record_roundtrips_through_disk`, `verify_identity_rejects_cmdline_mismatch_without_signalling`, `ensure_ready_persists_a_verified_sidecar_record`, `spawned_runtime_note_session_id_enriches_the_record` |
| Reattach on restore when alive + usable, incl. mid-turn, in-flight turn intact | 5, 6, 7, 8 | `reattach_ensure_ready_returns_the_existing_listener`, `select_codex_runtime_prefers_a_claimable_survivor`, `restore_reattaches_tui_to_surviving_sidecar_preserving_in_flight_turn` (mid-turn `loadedThreadIds` fixture, resume served by the SURVIVOR) |
| Fallback to fresh spawn (dead port / identity mismatch / handshake failure) | 6, 7, 8 | `reattach_reaps_verified_but_unusable_survivor`, `plan_retry_falls_back_to_fresh_spawn_after_reattach_failure`, `restore_falls_back_to_fresh_sidecar_without_tracked_survivor` |
| Reap tracked-but-unclaimed ONLY after provable identity verification, never by name pattern; never touch non-freshell codex processes | 2, 9 | `sweep_never_touches_unverified_pids`, `sweep_reaps_verified_idle_unclaimed_sidecar`; new tracking starts EMPTY ⇒ the ~20 live orphans (incl. PID 545173) are structurally out of reach |
| Mid-turn ⇒ reattached, not killed, not leaked | 8, 9 | reattach e2e (claimed) + `sweep_retains_mid_turn_sidecar_with_recorded_reason` (unclaimed ⇒ retained with reason, still claimable) + `late_restore_after_sweep_reattaches_mid_turn_survivor` |
| Invariant: after restart every freshell-spawned sidecar is reattached / reaped / intentionally-retained-with-reason — never silently orphaned | 9 | `restart_reconciliation_leaves_no_sidecar_silently_orphaned` (exhaustive five-record end-state assertion, incl. the duplicate-session claim loser) |
| Sidecars survive restarts (ynfn: shutdown kills are unacceptable) | 3, 10 | `spawned_sidecar_survives_runtime_drop_without_shutdown`, `shutdown_retention_retains_adopted_sidecars_and_records_reason`, SAFE-11 adjustment with recorded rationale |
| da92 incident shape (`-32600` active-writer) encoded with the existing fixture | 8 | `active_writer_collision_surfaces_minus32600_only_on_the_fresh_path` (fixture Route A override) |
| Node parity decision recorded, not silent | header + 11 | "Recorded decision" section; PR description + follow-up kata step |
| TDD, unit + integration, fmt/clippy clean, local cargo test (CI runs none) | every task | failing-test-first steps; per-task fmt/clippy; Task 11 mirrors CI + records counts |

## Self-Review

Checks performed on the draft before finalizing, and fixes applied:

- **(a) Failing-test-first ordering** — every behavior task (1–10) opens with a
  named failing test and an explicit red-verification step before
  implementation. Fixed during review: Task 7's Step 2 originally said "verify
  red" for a change that is compile-breaking — reworded to stub-first so red is
  an assertion failure, not a compile error; Task 8's red state clarified
  (survivor op-log empty when the reconciler is withheld). Task 11 is
  verification-only by design (like the exemplar's Task 5).
- **(b) Exact paths/symbols exist per the reports** — re-checked every quoted
  seam against `verbatim-snippets.md`/`rust-sidecar.md`: `CodexRuntimeFactory`
  (`launch_lifecycle.rs:46`), factory mint at `plan_create` `:308`
  (report §4 note), `SpawnedCodexAppServerRuntime` struct/ctors `:840-907`,
  trait `:66-98`, manager `mark_candidate_persisted(&self, terminal_id)`
  `:762-780`, `reap_owned_codex_sidecars` `transport.rs:86-121`,
  `proc_starttime`/`scan_tagged_pids` `session_lease.rs:130-188` (private ⇒
  duplicated with provenance, dependency direction verified),
  `plan_codex_managed_launch` `terminal.rs:1160-1226`, main.rs shutdown
  `:1663-1722` / PaneLedger boot `:383-395` / `boot_scan` `:975-999`,
  `atomic_write_durable` `tabs_persist.rs:682-708`, dispatcher + `WsState`
  harness `codex_managed_launch_e2e.rs:40-200`, `NoIndexProbe` gate
  satisfaction (§16c), create-frame field names (§17), fixture knobs
  (`overrides` -32600, `loadedThreadIds`, `appendThreadOperationLogPath`,
  `thread/loaded/list` — `tests-and-persistence.md` §1.3–1.6). Fixed during
  review: an earlier draft imported `atomic_write_durable` from `freshell-ws`
  — impossible (freshell-ws depends on freshell-codex); switched to the
  documented deliberate-duplication pattern. Also corrected the earlier
  assumption that the manager mints "a new planner per plan"
  (verbatim-snippets §5c: it does not — one planner, per-plan runtime via the
  stored factory), which is why the factory type, not the manager, is the
  selection seam. One residual risk flagged honestly:
  `tokio::process::Command::process_group` availability was reasoned from the
  resolved tokio 1.52.3 (API added well before), not grepped from vendored
  sources — if absent, fall back to `unsafe pre_exec(setsid)` with the same
  test coverage (`spawned_sidecar_survives_runtime_drop_without_shutdown`
  pins the behavior either way).
- **(c) Invariant coverage** — the four fates (reattached / reaped / retained
  with reason / stale-record-removed) are each individually tested AND jointly
  asserted in `restart_reconciliation_leaves_no_sidecar_silently_orphaned`
  (Task 9), with retention-at-shutdown (Task 10) writing the recorded reason.
  Fixed during review: the unclaimed-mid-turn case originally had no recorded
  fate — added `Retained{reason:"mid-turn-active-thread"}` + re-evaluation at
  next boot, closing the "never silently orphaned" hole for panes the client
  never restores.
- **(d) Process-safety compliance** — no name-pattern kills anywhere; every
  signal path re-verifies `(pid, starttime, cmdline)` at kill time or matches
  the per-launch env tag; non-Linux ⇒ `Unverifiable` ⇒ never signalled; the
  new store starts empty so the ~20 live orphans (incl. mid-turn PID 545173)
  are structurally unreachable by the reaper and by every test (tests signal
  only self-spawned children); no test or step touches port 3001 (SAFE-11
  black-box test uses an ephemeral port per its existing harness); Task 11
  Step 3 makes the audit mechanical.
- **(e) Node-parity decision recorded** — explicit "Recorded decision" section
  (Rust-only, four reasons, `rust-codex-sidecars/` distinct-store constraint
  honored — the plan never reads or writes Node's `~/.freshell/codex-sidecars/`)
  plus Task 11 Step 4 carries it into the PR description and a follow-up kata,
  satisfying "do not let the Node side rot silently without a decision".

## Load-bearing validation pass (post-planning; ledger + evidence in `.worktrees/.the-usual-logs/codex-sidecar-lifecycle/`)

Ten load-bearing assumptions were surfaced and validated (finder → strategist
→ 6 parallel validators; full evidence in `reports/finder.md`,
`reports/strategist.md`, `reports/V1.md`–`V6.md`, ledger in
`load-bearing-ledger.md`). Plan changes applied from the verdicts:

- **VERIFIED — reattach works** (V1, live experiment on the deployed 0.147.0
  binary): new-client `thread/resume` into a surviving mid-turn app-server
  succeeds and streams the in-flight turn; disconnect doesn't abort turns;
  writer lock is a per-thread file flock released on process death. Recorded
  in Background ("Validated codex behavior").
- **FALSIFIED — `loaded` ≠ `mid-turn`** (V1): Task 9's discriminator changed
  to per-thread `thread/read` status, with a `/proc/<pid>/fd` writer-evidence
  arm for unreachable survivors; fixture gains a `threadStatuses` knob.
- **FALSIFIED — single-pid kill** (V2): sidecars are process trees (children
  in their own pgids; SIGKILL orphans them). Task 6 introduces
  `kill_verified_sidecar_tree` (snapshot-verified, drain-tolerant, tree-wide);
  Task 9 reuses it; "Reaped" now means the whole tree is gone.
- **FALSIFIED — one-record-per-session** (V3): reconciler re-keyed by
  ownership_id with a session index; writer-aware deterministic claim;
  losers keep sweep fates; invariant test seeds the duplicate case.
- **FALSIFIED — restores-arrive-in-grace-window** (V3): Retained rows stay
  claimable after the sweep; `late_restore_after_sweep_reattaches_mid_turn_survivor`
  pins it.
- **FALSIFIED — orphans are all terminal-pane-lane** (V2): scope note revised;
  freshagent-lane follow-up kata added to Task 11; ynfn close-out wording
  updated.
- **FALSIFIED (favorably) — SAFE-11 "adjust expectations"** (V4): the test has
  no terminal-pane codex assertions; Task 10 Step 4 rewritten to
  verify-unchanged + optional added retention scenario + recorded documentary
  deviation.
- **FALSIFIED — clean baseline** (V5): measured baseline recorded in Global
  Constraints (freshell-ws has exactly 2 pre-existing deterministic failures;
  node_modules resolves from the parent checkout).
- **VERIFIED — proxy needs zero changes** (V4) and **restart choreography
  releases the flock** (V6), with recorded hardening: loud store-disablement,
  O_CLOEXEC lock fd, systemd KillMode caveat.

Self-review re-run over every edited task against (a) failing-test-first
ordering (new/changed tests remain Step-1 items with red verification),
(b) paths/symbols grounded (all new claims cite validator reports with
file:line evidence), (c) invariant coverage (five fates incl. duplicate
loser; retained rows claimable), (d) process-safety (tree kills are
snapshot-verified per pid; nothing signals unverified pids; the ~20 live
orphans remain structurally unreachable — the store starts empty),
(e) scope decisions recorded (Node parity + freshagent lane + SAFE-11
deviation all carried into Task 11/PR description).
