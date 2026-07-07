# Codex Launch-Leak Remediation Plan — Stage 0a/0b + 1a/1c (v2)

**Date:** 2026-07-06 (v2, evening)
**Target:** freshell `main @ 02f95b70` (TypeScript/Node server)
**Status:** Plan — not yet implemented
**v2 changes:** incorporates all findings from the 2026-07-06 adversarial review
(factual fixes F1–F6, per-stage design flaws, gaps G1–G6) and the results of the
log-dampening validation experiment run the same evening (§3). Terminology note:
`RUST_LOG` is the log-level environment variable of the **codex binary** (OpenAI's
CLI, which happens to be written in Rust). It is unrelated to any freshell code.

**Scope:** the four near-term items (0a, 0b, 1a, 1c) plus a small observability
line-item promoted into scope. Follow-ups — durable resume-TUI boot reaper ("1b")
and the shared-app-server architecture ("Stage 2") — are out of scope and tracked
separately.

---

## 1. Problem (corrected model)

Codex CLI intermittently wedges on launch (blocks in `futex_wait_queue` while opening
`~/.codex/logs_2.sqlite`). The mechanism, corrected per review F1 and confirmed by
measurement:

1. **Per-pane codex processes hold the log DB open around the clock.** freshell
   spawns, **per pane**:
   - one `codex app-server --listen ws://…` via
     `child_process.spawn(..., { detached: true })` —
     `server/coding-cli/codex-app-server/runtime.ts:1246-1261`
   - one `codex … resume <uuid>` node-pty — `server/terminal-registry.ts:1592-1600`
     (recovery re-spawn `:3694-3700`)

   With ~10 panes attached: ~19–21 codex processes permanently connected.

2. **Log churn, not table growth, floods the WAL.** codex persists tracing rows into
   `logs_2.sqlite` and **bounds the table per process (~1,000 rows)** — inserts are
   continuously matched by prune deletes. The table stays small; the **WAL traffic
   does not**. Measured on this machine (2026-07-06): the live pane population writes
   **~22 MB/min** of WAL churn, ~99% `TRACE` rows with `target=log` (the Rust `log`
   facade forwarding **inotify file-event spam**).

3. **The WAL can never reset.** A WAL reset/truncate requires that **no read
   transaction spans the checkpoint** (review F1: it is *not* "zero connections" —
   idle connections alone don't pin it; the continuous overlapping read/write activity
   across ~20 permanent connections does). Under constant churn from many holders, a
   truncating checkpoint never gets its window; the WAL grows to a multi-GB high-water
   mark (~5 GB observed over ~10 days).

4. **The wedge.** A new `codex` must open that DB; against a multi-GB WAL index and
   ~20 active connections it blocks in `futex_wait_queue` during init → "won't
   launch."

**Amplifiers (0 addressed here; 1a/1c partially):**
- `detached: true` children survive ungraceful server exit; teardown runs only on
  graceful `SIGTERM`/`SIGINT` (`server/index.ts:1147-1148`).
- On reboot the client re-creates every pane (restore-all) on top of any orphans.
- The startup reaper covers app-servers only, and can **fail closed**: besides the
  explicit throw in `assertCodexStartupReaperSucceeded` (`runtime.ts:863-876` →
  `index.ts:1151-1154` `process.exit(1)`), three additional paths abort boot —
  `readFile` of a record (`runtime.ts:811`), the `/proc` ownership-proof assert
  (`:800`, per `:360-379`), and non-ENOENT `readdir` errors (`:803-806`) (review F2).

**Out of scope / codex-internal (upstream asks):** even with a clean DB,
`codex doctor` synchronously scans all ~6,000 rollout files ("Checking thread
inventory…"). Excluded from this plan's acceptance gate. Upstream asks: bound own WAL
(`journal_size_limit`/`wal_autocheckpoint` + periodic passive checkpoints); stop
persisting inotify events at TRACE by default; lazy thread-inventory scan; a
documented log-level knob.

## 2. Hard constraints (design invariants)

- **I1 — Lossless.** Never delete or risk Codex sessions/long-term state
  (`~/.codex/sessions/`, goals, memories, thread graph). Cleanup = checkpoint/VACUUM
  only, behind a **consistent** backup. Never `rm` live data (including `-wal` files).
- **I2 — No cap.** Unlimited simultaneous panes is the product's core value. Nothing
  here limits pane/session count.
- **I3 — Never touch a live pane** in steady-state operation. No reaper/teardown may
  signal a client-attached pane. The idle reaper's `clients.size > 0` skip
  (`terminal-registry.ts:1409-1422`) stays intact. **Explicit carve-out:** Stage 0b is
  a one-time, user-acknowledged **maintenance window** that terminates all codex
  processes, including live panes (§5). This is declared, consented downtime — not a
  steady-state behavior.
- **I4 — Never fail-closed at boot.** No fix may introduce (or leave) a "won't
  launch" path.
- **I5 — Accepted tradeoff.** Log dampening thins codex `/feedback` telemetry.

---

## 3. Stage 0-pre — Validate the dampening mechanism (BLOCKS 0a implementation)

The v1 plan bet its sequencing on `RUST_LOG=error` gating codex's SQLite log sink.
The review demanded validation first; the experiment was run 2026-07-06 evening.

**Results so far (evidence, this machine, codex-cli 0.142.5):**

| Test (idle TUI, 78 s, cwd=$HOME, pty) | Attributable rows written |
|---|---|
| Control — `RUST_LOG` unset | 1 |
| Treatment — `RUST_LOG=error` | **1,013** (not silenced; more than control) |
| Ambient — live pane population, no test proc | ~64k rows/min ≈ **22 MB/min** |

**Conclusions:**
1. **Plain `RUST_LOG=error` is NOT validated** — initial evidence is negative.
2. **An idle, freshly-launched TUI is not the firehose.** The firehose is the
   long-running pane population (insert+prune churn, `TRACE`/`target=log` inotify
   events). Any acceptance test must use a representative long-running workload.
3. The binary embeds a default filter string (`codex_cli=info,codex_core=info,…`) and
   the sink schema (`feedback_log_body`, `bounded_feedback_logs`), so a filter layer
   exists — the right directive just isn't confirmed yet.

**Required protocol before 0a is implemented (no code until one candidate passes):**
- Workload: a freshell-spawned codex pane pair (app-server + resume) left running
  ≥15 min; attribute rows/bytes by `process_uuid`
  (`SELECT count(*), sum(estimated_bytes) FROM logs WHERE process_uuid=… AND id>…`
  on a `mode=ro` connection).
- Candidates, in order:
  1. `RUST_LOG='log=off'` (or `log=error`) — a **scoped directive** silencing the
     `log`-facade target that carries ~99% of rows, without touching `codex_*` module
     levels.
  2. A codex `-c` config knob (the arg channel already exists:
     `CODEX_MANAGED_REMOTE_CONFIG_ARGS`, `codex-managed-config.ts:1-4`); candidate
     keys to probe: `log.level`, `tui.*` logging toggles.
  3. If neither works: **0a is dropped**, the upstream ask is filed as the only
     firehose fix, and this plan's protection reduces to 0b + observability + 1a/1c
     (see §10 residual risk — recurrence to the cliff in days-to-weeks of heavy use,
     now *detectable* instead of silent).
- **Pass bar:** ≥90% reduction in the pane pair's attributable bytes over 15 min, and
  the pane still functions (turn completes, rollout file written).

## 4. Stage 0a — Codex spawn-env log dampening (conditional on §3)

### Change

One shared helper; the value comes from whichever candidate §3 validated.

```ts
// server/coding-cli/codex-log-dampening.ts  (new)
export const CODEX_LOG_DIRECTIVE = 'log=off' // placeholder: whatever §3 validates

export function withCodexLogDampening<T extends NodeJS.ProcessEnv>(env: T): T {
  // Consult ONLY the env the child will actually see (review 0a-2: both call sites
  // already spread process.env, so a separate process.env fallback is dead-or-wrong).
  if (env.RUST_LOG !== undefined) return env // set — even '' — is an explicit choice
  if (process.env.FRESHELL_CODEX_LOG_DAMPENING === '0') return env // kill switch
  return { ...env, RUST_LOG: CODEX_LOG_DIRECTIVE }
}
```

Call sites — **three**, not two (review G1):

1. **App-server spawn** — `runtime.ts:1255-1259`:
   `env: withCodexLogDampening({ ...process.env, ...this.env, FRESHELL_CODEX_SIDECAR_ID: ownershipId })`.
   Covers all planner-owned and fresh-agent-adapter runtimes (they flow through this
   constructor — `index.ts:338`, `:372`).
2. **Resume-TUI spawn** — inside `buildSpawnSpec` (`terminal-registry.ts:~1059`) on
   the env it returns, **only when the pane mode is codex** (don't thin
   claude/opencode telemetry). Covers both pty consumers (`:1594` primary, `:3694`
   recovery; fed at `:1573`/`:3684`).
3. **`CodingCliSession` spawn** — `server/coding-cli/session-manager.ts:88-92`
   (spawns `codex exec --json …`/`codex resume …` via
   `providers/codex.ts:479-501`), currently `env: { ...process.env }` with no
   dampening. Apply the same helper when the provider is codex.

If §3 validated the `-c` knob instead of an env var, the helper becomes an args
helper appended next to `CODEX_MANAGED_REMOTE_CONFIG_ARGS` (same three call sites;
same guard semantics via an explicit opt-out env).

### Platform note (review G3)

On a native-Windows host, `buildSpawnSpec` wraps codex in `wsl.exe …`
(`terminal-registry.ts:1127-1139`); an env var set on the Windows-side process does
not cross into WSL without `WSLENV`. The current deployment is WSL2-native (unaffected),
but the helper's coverage claim is platform-conditional; add `WSLENV` plumbing or
document Windows-host as out of scope.

### Why safe

- Additive env/args; no lifecycle change; no effect on pane count (I2) or boot (I4).
- Only-if-unset guard: a developer's explicit `RUST_LOG` (any value, including empty)
  is never overridden.
- Dampening gates codex's tracing sink only; sessions/goals/memories/thread-graph are
  written by normal code paths, not tracing (I1).

### Acceptance test

1. Repeat the §3 protocol (representative pane pair, 15 min, per-`process_uuid`
   attribution) with the helper active: ≥90% byte reduction vs an undampened control
   window run the same evening (controls for ambient variation).
2. Unit tests: helper is a no-op when `RUST_LOG` is preset (any value incl. `''`) or
   the kill switch is set; `FRESHELL_CODEX_SIDECAR_ID` and `this.env` overrides are
   preserved; non-codex modes in `buildSpawnSpec` are untouched (review G5).
3. Launch check: codex TUI reaches `Ready`; a turn completes; new rollout appears.

### Rollback

`FRESHELL_CODEX_LOG_DAMPENING=0` **plus a server restart** (env is read at spawn
time; there is no live-toggle — review F3), or revert the three call sites.

### User-facing risk

Sparse codex `/feedback` traces (I5, accepted). Masks — does not fix — the inotify
storm generation (upstream ask). **Severity: Low.**

---

## 5. Stage 0b — One-time lossless cleanup (maintenance-window runbook)

**What this is (honest framing, review 0b-3):** a **declared maintenance window**
that terminates **all codex processes, including live attached panes**. In-flight
codex turns are lost (their transcripts up to that point are already on disk in
rollout files). Long-term state is untouched. Get explicit operator acknowledgment
before starting. This is the documented I3 carve-out (§2).

**Preconditions (review 0b-4, 0b-5):**
- **Run from outside freshell** — an ssh/tmux/console session that is *not* a
  freshell pane. (Otherwise the runbook's own server is in the operator's ancestry
  and can never be paused/stopped — the ancestry deadlock.)
- Check for supervisors/watchdogs (`systemd`, pm2, `tsx watch`) that would restart or
  kill a paused server; prefer **gracefully stopping** the freshell servers for the
  window (their existing `SIGTERM` teardown reaps their codex children for you,
  `index.ts:1078-1145`) over `SIGSTOP`. Expect the window to last **minutes** (a
  ~6 GB VACUUM), not seconds.

### Runbook (ordered; each step gates the next)

1. **Consistent backup + baseline (review F4/0b-1).** With writers still live, a
   plain file copy is *not* guaranteed consistent. Use SQLite's online-consistent
   mechanisms for the DB backups:
   `sqlite3 ~/.codex/<db>.sqlite ".backup '<backup-dir>/<db>.sqlite'"` (or
   `VACUUM INTO`) for each of `logs_2`, `state_5`, `goals_1`, `memories_1`; copy
   `history.jsonl`, `auth.json`, `config.toml` normally. Verify
   `PRAGMA integrity_check` = `ok` on every backup. Record **provisional** row counts
   (final baselines are taken at step 4). Belt-and-braces: after step 3 (0 holders),
   also take plain file copies (`.sqlite` + `-wal` + `-shm` together) — these are the
   byte-identical restore set.
2. **Announce + stop freshell servers (prod and dev — both hold the DB).** Graceful
   `SIGTERM`; their teardown reaps their codex children. Then **reap stragglers**:
   kill set from `lsof ~/.codex/logs_2.sqlite` filtered to codex cmdlines; dry-run
   and print first; protected-PID guard (never the operator's own session ancestry);
   **SIGTERM first, grace ≥10 s** (codex flushes rollout `.jsonl` appends on TERM —
   review 0b-3), then SIGKILL survivors.
3. **Reach 0 holders.** `lsof ~/.codex/logs_2.sqlite` empty. Nothing may respawn
   (servers are stopped — no SIGSTOP theatrics needed in the normal path).
4. **Final baselines at 0 holders (review 0b-2).** Row counts: `sessions/` file
   count, `goals_1.thread_goals`, `state_5.threads`, `state_5.thread_spawn_edges`,
   `memories_1.*` (checkpoint `memories_1`'s WAL first before trusting counts), and
   **`logs_2` `count(*)` + `max(id)`** (needed for the VACUUM equality check).
5. **Checkpoint — never rm.** For each `~/.codex/*.sqlite` with a non-empty `-wal`:
   `PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE);`
6. **Compact.** Prefer `VACUUM INTO '<new-file>'` (original untouched; verify the new
   file, then atomically swap; strictly safer — review 0b-6). Plain in-place `VACUUM`
   is acceptable (crash mid-VACUUM rolls back transactionally). Requires 0 holders +
   free disk ≈ DB size.
7. **Verify.**
   - `PRAGMA integrity_check` = `ok` on all live DBs.
   - **`logs_2` row count and `max(id)` equal step 4 exactly** (VACUUM must not change
     row population — this is the meaningful equality check).
   - All other counts **≥ step-4 baseline with any delta explained** (nothing should
     write during the window; an unexplained delta = stop and investigate).
   - `sessions/` file count unchanged; holders = 0; `logs_2.sqlite-wal` = 0 bytes.
   - **Never auto-restore on a mismatch** (review 0b-2: a stale-backup restore would
     itself destroy data). Mismatch = halt, investigate, decide manually.
8. **Restart freshell servers**; restore-all respawns the (dampened, if 0a landed)
   generation; spot-check a codex pane reaches `Ready`.

### Why safe

DB backups are online-consistent (`.backup`/`VACUUM INTO`); the WAL is folded in via
checkpoint, never deleted; VACUUM preserves all rows (checked by exact `logs_2`
equality); baselines are taken at a quiesced moment so the oracle is coherent; no
`sessions/` file is ever touched; restore is a manual decision, never automatic (I1).

### Rollback

Restore the step-1 `.backup` set (consistent by construction) or the step-3 file
copies (byte-identical, taken at 0 holders).

### User-facing risk

All codex panes terminate for the window (minutes); in-flight turns lost; panes
restore from rollouts afterward. **Severity: Medium** (declared downtime), not "Low"
(review 0b-5).

---

## 6. Stage 1a — Exception/signal-safe teardown on server exit

*(renamed from "crash-safe" — review 1a-1)*

### What `process.on('exit')` actually covers (honest enumeration)

**Covered:** normal exit (`process.exit()` — both the graceful path `index.ts:1144`
and the fatal path `:1153`), event-loop drain, default-fatal uncaught
exceptions/unhandled rejections, and signals we handle (SIGTERM/SIGINT/SIGHUP →
`shutdown()` → `process.exit`).
**Not covered:** `SIGKILL`, **V8 OOM abort** (a realistic failure mode for a leaking
long-lived server), native segfault/abort, unhandled default-fatal signals. Hard-crash
coverage requires the durable on-disk ownership + boot reaper (follow-up **1b**, out
of scope) — this stage narrows the orphan window; it does not close it.

### Change

1. **Registry** (`server/coding-cli/codex-child-registry.ts`, new): `{ pid, pgid,
   kind }` for every codex child.
   - app-server: pgid == `child.pid` (`processGroupId`, `runtime.ts:1291-1292`).
     Register on spawn. **Deregister only on confirmed group death** — after
     `teardownOwnedProcessGroup` returns `true` (`runtime.ts:692-734`), *not* at
     wrapper exit (`:1533-1575`), which can leave live grandchildren untracked
     (review 1a-2).
   - resume pty: register `pty.pid` at both spawn sites (`terminal-registry.ts:1594`,
     `:3694`). **Deregister on the pty's `exit` event**, not in `kill()` (`:4008` only
     *sends* a signal — review 1a-2).
2. **Bindings** (installed once, near `index.ts:1147-1148`):
   - `process.on('exit', reapSync)` — synchronous best-effort
     `process.kill(-pgid, 'SIGKILL')` per still-registered group, try/catch'd.
     Guards: only registered pgids; never `-1`/`0`/`1`/our own pgid; cheap sync
     identity re-check (`/proc/<pid>/cmdline` contains codex) before signalling.
     **Residual pgid-reuse window:** the sync check-then-kill race is narrower than
     nothing but wider than the async reaper's fresh-classification
     (`runtime.ts:698-711`); accepted at process-death time and documented
     (review 1a-4).
   - `process.on('SIGHUP', …)` — route into the existing graceful
     `shutdown('SIGHUP')` (idempotent via `isShuttingDown`, `index.ts:1079`). Add a
     **hard-exit timeout** to `shutdown()` so a throw from `joinCodexShutdownOwners`
     (`:1102-1113` has no catch) cannot leave the process alive without ever reaching
     `process.exit(0)` at `:1144` (review 1a-6).
   - `process.on('uncaughtExceptionMonitor', …)` — **observe/log only.** The default
     fatal behavior of `uncaughtException` is left in place; the fatal path then runs
     `'exit'` → `reapSync`.
3. **Platform gating (review 1a-3):** negative-pid group kill and `/proc` checks are
   POSIX/Linux; gate the registry's reap on POSIX and document Windows-host as out of
   scope (consistent with the sidecar's existing Linux-only stance,
   `assertUnixSidecarSupport`, `runtime.ts:360-364`).

### Why safe

`exit` cannot fire on a recoverable, *caught* error — a survivable blip can never
nuke live panes (I3). At true termination the children's transport is dying anyway;
reaping prevents orphan accumulation. Guarded, synchronous, try/catch'd; cannot block
boot (I4).

### Acceptance tests (review F6, 1a-5)

1. Dev server + ≥2 codex panes; terminate via `SIGHUP` and via normal exit →
   **zero survivors from that instance**, scoped via the registry contents (or
   matching `FRESHELL_CODEX_SIDECAR_ID` env in `/proc/<pid>/environ`) — *not* a bare
   `pgrep` (prod + dev coexist).
2. **Uncaught-exception test** (replaces v1's vacuous caught-exception test): throw an
   uncaught exception → process dies → registered groups are gone. Separately assert
   the I3 property at unit level: no code path signals a registered group while the
   process is alive.
3. `SIGKILL` the server → survivors expected; documented boundary (1b's job).
4. **Empirical check:** verify whether the codex resume TUI exits on pty-master close
   (kernel SIGHUP). If codex ignores it, resume ptys outlive the server on paths 1a
   doesn't cover — record the result; it sets 1b's priority (review 1a-5).

### Rollback

Remove the three listeners + registry wiring; behavior reverts to
SIGTERM/SIGINT-only.

### User-facing risk

None in steady state. SIGHUP now tears down a dev server left in a closing terminal.
**Severity: Low.**

---

## 7. Stage 1c — Startup reaper: complete fail-open + minimal observability

### Change (review F2, 1c-1..4; G4, G6)

1. **Per-record isolation.** Wrap the *per-record* body of the reap loop
   (`runtime.ts:808-848`) in try/catch so an unreadable record file (`:811` —
   permissions, torn write) affects only that record (introduce the `unreadable`
   classification the plan names but the code lacks). Treat non-ENOENT `readdir`
   failures (`:803-806`) and an unavailable `/proc` ownership proof (`:800`,
   `:360-379`) as **degrade-and-continue** (log, skip reaping this boot), not aborts.
2. **Backstop.** try/catch around the `runCodexStartupReaper` call at `index.ts:256`:
   log and continue. Boot must never die in the reaper (I4).
3. **Quarantine — only for provably-dead or unparseable records (review 1c-2).**
   - Owner PID **provably dead** (`isPidAlive` false) but group unkillable, or record
     unparseable → move to `~/.freshell/codex-sidecars/quarantine/` (atomic rename;
     preserve `0600` — records embed command lines and cwd's, review G6) with a
     `{ reason, firstSeen, attempts }` note.
   - Owner **alive but identity-mismatched** (`runtime.ts:826-831` — reachable via
     transient `/proc` races) → **retry in place** with time-based backoff keyed on
     `firstSeen`. Never quarantine a possibly-live sidecar's only tether — that would
     mint a permanent, invisible DB holder (the exact leak this plan fights).
   - Retry semantics are **time-based, not boot-count-based** (review 1c-3): the
     shared `~/.freshell/codex-sidecars` dir serves prod + dev, and a dev server under
     `tsx watch` can boot dozens of times an hour. On concurrent boots, rename-ENOENT
     = the other instance won; treat as success.
4. **Remove the fail-closed assert.** `assertCodexStartupReaperSucceeded`
   (`runtime.ts:863-876`) is deleted/reduced to a warning aggregator. **Test impact
   is a contract inversion, not an update** (review 1c-4): ~8 tests in
   `test/unit/server/coding-cli/codex-app-server/runtime.test.ts` assert the throwing
   contract, plus the exported alias `reapOrphanedCodexAppServerSidecarsOnStartup`
   (`runtime.ts:861`) — rewrite them to assert no-throw + quarantine/backoff behavior.
5. **Boot-time observability line (review G4 — promoted into scope, ~10 lines).** At
   every boot (and hourly thereafter on a timer), log one structured line:
   `codex-log-db: wal_bytes=<stat of logs_2.sqlite-wal> holders=<count via /proc fd scan> quarantined=<n>`
   with a `warn` if `wal_bytes > 500 MB` or holders exceed a threshold. Read-only:
   `stat` + `/proc` fd scan; **never opens the SQLite DB, never signals anything.**
   This converts every silent failure mode in this plan (0a ineffective, 1c orphan,
   regrowth) into a detectable one.

### Why safe

Fail-open at every layer (I4); reap decisions still require the same ownership proof
(I3 unchanged); quarantine can no longer orphan a live sidecar's record; the monitor
is observation-only.

### Acceptance tests

1. Seed an un-reapable-but-dead record → server boots; record quarantined `0600`;
   warning logged.
2. Seed an **unreadable** record file (chmod 000) → server boots; that record
   isolated; others still processed.
3. Simulate `/proc` proof unavailable → server boots; reaping skipped with a warning.
4. Seed an alive-but-mismatched record → retried in place with backoff; **not**
   quarantined; still present next boot.
5. Reapable orphan → still reaped exactly as before.
6. Boot line appears with correct WAL size/holder count against fixtures; `warn`
   fires above thresholds; verify the monitor holds no fd on the SQLite files.

### Rollback

Restore the assert (one function); disable the boot line.

### User-facing risk

Ambiguous records now linger (flagged, retried with backoff) instead of blocking
boot. Strictly better availability. **Severity: Low, net-positive.**

---

## 8. Deploy choreography (review G2)

Deploying 0a/1a/1c requires restarting freshell — **prod and dev both** (both hold
the DB). A restart is itself a pane-recycling event (graceful teardown + restore-all).
Sequence the whole rollout as **one declared window**:

1. Merge 0a (if §3 validated) + 1a + 1c.
2. Announce the maintenance window (§5 framing).
3. Restart/stop both servers → run the **0b runbook** (servers stay stopped through
   step 7) → restart both servers.
4. Post-checks: pane reaches `Ready`; boot observability line shows
   `wal_bytes≈0, holders == 2×(open codex panes)`; over the next day, the hourly line
   shows WAL bounded (0a working) or growing (0a failed → §10).

## 9. Sequencing & dependencies

```
§3 validation experiment  ──►  0a implementation (only if a candidate passes)
1a, 1c                    ──►  independent; implement in parallel with §3
merge (0a?, 1a, 1c)       ──►  §8 window: stop servers → 0b → restart
boot/hourly observability ──►  ships inside 1c; watches everything afterward
```

- 0a and 0b remain complementary: 0a (if validated) shrinks churn volume; 0b clears
  the accumulated WAL/dead pages. Neither reduces holder count — that is Stage 2's
  job (out of scope).
- 1b (durable resume-TUI ownership + boot reaper) is the committed follow-up that
  closes 1a's SIGKILL/OOM boundary.

## 10. Residual risk (honest statement)

- **Holders remain by design** (I2/I3): ~2 codex processes per open pane keep the DB
  open around the clock. This plan does not change that.
- **If §3 validates a knob:** WAL churn ≈ 0; the cliff should not recur before
  Stage 2 lands. Remaining exposure: the unvalidated-in-production knob (watched by
  the hourly line) and codex-internal behavior changes on upgrade.
- **If §3 fails:** churn continues at ~22 MB/min of active use; the WAL re-approaches
  the cliff in **days-to-weeks**. The observability line makes this loudly visible
  (500 MB warn threshold ≈ weeks of margin before the ~5 GB wedge), and 0b can be
  re-run as a stopgap during any maintenance window. Stage 2 (shared app-server,
  holders==1) becomes urgent and should be scheduled immediately.
- 1a/1c reduce orphan accumulation and boot fragility but do not change WAL
  mechanics.

## 11. Constraint traceability (corrected)

| Constraint | Honored by |
|---|---|
| I1 lossless | 0b: online-consistent backups, checkpoint/VACUUM only, exact `logs_2` row/`max(id)` equality check, **no auto-restore**; 1a/1c reap processes, never data; rollouts remain source of truth |
| I2 no cap | No stage limits panes; observability is read-only |
| I3 no live-pane kills (steady state) | 1a binds `exit` (cannot fire on recoverable errors), monitor observe-only; 1c reaps only proven-dead owners, retries ambiguity in place; idle-reaper attached-pane skip untouched. **0b is the one declared, consented exception** (maintenance window, §5) — not claimed otherwise |
| I4 no new won't-launch | 1c: per-record isolation + degrade-and-continue + backstop try/catch (covers `:800`, `:803-806`, `:811`, `:863-876`); 0a additive; 1a exit-path only, try/catch'd |
| I5 telemetry tradeoff | 0a documented, only-if-unset (incl. `''`), kill switch (restart required — stated honestly) |

## 12. Definition of done

1. **§3:** a documented pass/fail result for each candidate; 0a proceeds only on a
   pass (≥90% byte reduction on the representative workload).
2. **0a (if implemented):** acceptance re-run post-deploy passes; unit tests green
   (incl. `''`-preset, kill switch, `this.env`, sidecar-id preservation, non-codex
   modes untouched); TUI `Ready` + turn completes.
3. **0b:** integrity `ok`; `logs_2` rows/`max(id)` exactly equal step-4 baseline;
   other counts ≥ baseline with deltas explained; `sessions/` count unchanged;
   holders 0 at completion; WAL 0 bytes; ~2 GB reclaimed; no auto-restore occurred.
4. **1a:** SIGHUP/normal-exit → zero survivors (registry-scoped assertion);
   uncaught-exception path reaps; pty-master-close behavior of codex recorded;
   POSIX-gated; Windows documented out of scope.
5. **1c:** all six acceptance tests pass, including the three formerly-fatal boot
   paths; test-suite contract inversions completed; boot/hourly observability line
   live with thresholds.
