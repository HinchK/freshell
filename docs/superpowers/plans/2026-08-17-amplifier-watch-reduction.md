# Amplifier inotify watch reduction — final plan

**Status:** approved design, not yet implemented. Survived three adversarial review
rounds; then simplified by dropping the subagent-watch machinery entirely in favor
of a demand-driven rescan cadence (user decision, 2026-08-17).

## Problem

PR #655's event-driven session index watches `~/.amplifier/projects` with
`RecursiveMode::Recursive`, creating **33,165 inotify watches** on this machine
(1,235 project dirs, 22,159 session dirs, ~8K `context-intelligence` subtrees).
Root sessions — the only ones the sidebar shows by default — are just 3,194 dirs
(UUID-named). The other 18,963 are subagent sessions (named
`<16hex>-<16hex>_<agent>`), hidden unless the `showSubagents` sidebar toggle
(default off) is enabled.

## Design

Amplifier only. Claude (417 dirs) and Codex (52) stay recursive; OpenCode unchanged.

### Watch set (one `notify::RecommendedWatcher` = one inotify fd for the provider)

1. `~/.amplifier/projects` root — permanent, absence-tracked.
2. Every `<project>/sessions/` dir — permanent, absence-tracked. If a project has
   no `sessions/` dir, watch the project dir as a stand-in; after arming the
   stand-in, immediately re-check for `sessions/` and swap if present (closes the
   check-then-watch TOCTOU). `Create(sessions)` on the stand-in also swaps.
3. Every **root** session dir — permanent. Classification is by the session dir's
   **basename** only: matches `^[0-9a-f]{16}-[0-9a-f]{16}_` → subagent (not
   watched); anything else (UUIDs, oddballs, unknown formats) → root → watched.
   Fails safe toward watching. Never test the underscore against the full path —
   782/1,235 project names contain underscores.
4. Never watched: subagent session dirs, anything below a session dir
   (`context-intelligence/`), individual files.

Total: ~4,430 watches vs 33,165 today (~87% reduction). A watch on a session dir
sees all direct-child events: `metadata.json` rewrites (in-place or tmp+rename)
and `transcript.jsonl`/`events.jsonl` appends — so every root session, however
old, updates instantly, including external resumes. No age cutoff, ever
(growth is accepted; see Resources).

### Mechanisms

- **Watch-then-scan invariant:** every watch arm is immediately followed by a
  readdir/stat of that dir. Output goes to two streams: structural discoveries
  (subdirs to arm) → the watcher's planner; file states → index dirty marks,
  always shaped as canonical `metadata.json` paths (a mark on a nonexistent
  metadata.json is a safe no-op / correct prune). Skip the file-state stream
  during the startup arming pass (the full discover that follows covers it).
- **New-project cascade:** `create_dir_all` makes `proj/sessions/<id>` in one
  shot, so only the root sees `Create(<proj>)`. On any structural create, cascade:
  arm `<proj>/sessions` (or stand-in) → readdir → arm root session dirs found →
  scan each.
- **Self-correction channel (refresh → watcher, one-way):** each full discover
  reports the session dirs whose parsed metadata has `parent_id` absent (true
  roots). The watcher diffs the report against (armed ∪ retry-pending) — never
  bypassing arm-failure backoff — and arms any missing root dirs with
  watch-then-scan. This is the guard against Amplifier naming drift; without the
  explicit channel it will silently not exist (index parsing has no path back to
  the watcher loop today).
- **Event routing granularity:** classify by **component depth relative to the
  provider root** (never by parent basename — a project literally named
  `sessions` must not misroute): depth 1 = project event and depth 3 =
  sessions-dir child → structural; depth 4: `Create(Folder)` (e.g. a
  `context-intelligence/` mkdir) is **dropped**, every other depth-4 event is
  rewritten to a scoped dirty mark on the sibling `metadata.json` (no filename
  whitelist to go stale; a mark on a nonexistent metadata.json is a safe
  no-op). Anything else — including children of a stand-in project watch that
  aren't `sessions/` (e.g. the live `{project}` dir contains
  `recipe-sessions/`) — is **dropped by default**. `need_rescan` stays
  provider-dirty. Renames at structural depths: `MovedTo`/`Name(Both)` are
  treated as creates by the cascade (a `mv`'d root session dir is re-armed
  first-line rather than waiting for the self-correction channel), and
  `MovedFrom` is treated as a remove — explicit unwatch (WatchNotFound
  tolerated) plus bookkeeping cleanup — since inotify watches follow inodes and
  would otherwise leak, reporting events under the stale old path forever.
- **Fold-aware scoped stat:** a per-source hook (`stat_scoped`, default
  `stat_file`) that Amplifier overrides to fold sidecar mtimes
  (`fold_activity_mtime`), fixing the raw-vs-folded cache-key asymmetry
  (`directory_index.rs:1652` vs `amplifier.rs:198`). Must return `None` when
  `metadata.json` itself is missing so deletion still prunes (never resurrect a
  ghost entry from surviving sidecars). Lands together with the routing rewrite,
  guarded by regression tests.
- **Absence/retry:** only structural targets (root, stand-ins, `sessions/` dirs)
  get absence tracking. Deleted session dirs are simply forgotten (kernel already
  dropped the watch; explicit unwatch tolerates `WatchNotFound` at debug).
  **Structural removes clean up the whole subtree's bookkeeping**: on
  `Remove`/`MovedFrom` of a project dir, drop all its entries from the armed,
  absent, and retry sets (deleted disposable projects — e.g. evaluation
  workspaces — must not accumulate forever-retrying absent entries); on
  `Remove(sessions)` with the project still present, swap to the stand-in
  project watch. Only the provider root itself re-enters absence tracking when
  it disappears. Arm failures go to a bounded retry set with exponential
  backoff — never the absent list (which retries forever) — and entries with
  deterministic errors (ENOENT/ENOTDIR) are dropped immediately rather than
  retried: a dir's reappearance is a fresh structural create anyway. The
  cascade's readdir classifies entry types (`file_type` is already available)
  so a stray file at project depth never generates a doomed `<file>/sessions`
  arm attempt. If the retry set overflows its bound, evicted dirs are simply
  not retried — the 15-min full reconcile is the designed fallback that bounds
  their staleness (latency-only degradation, e.g. under system-wide
  `max_user_watches` exhaustion by other processes).
- **Debounce:** keep the 200ms quiet-gap flush; add a ~2s max-deferral cap
  (today's deadline resets on every event, so sustained streams can starve the
  flush indefinitely).
- **Overflow (`need_rescan`):** full watch-set replan + provider dirty, not just
  an index dirty mark.
- **One-fd restructure:** the current `ArmedWatch` creates one watcher (one
  inotify fd) per target and unwatches by drop. At 4.4K targets that exhausts
  `max_user_instances` (1,024). Restructure to one watcher per provider with
  explicit `watch()`/`unwatch()` calls; bulk operations in `spawn_blocking`.
  `ProviderLayout` stays pure (no fs I/O in the trait).

### Subagent sessions: demand-driven rescan cadence, no watches

Subagent dirs are **never watched**. Their rows still exist in the index
(`discover_amplifier_metadata` scans everything) and refresh on full discovers.

- New subagent rows appear **typically instantly, ≤15s worst case** with the
  toggle on: the dir creation is a direct-child event on the watched `sessions/`
  dir, but the row exists only once `metadata.json` is written, and the unwatched
  subagent dir can't signal that write — if it lands after the debounce flush,
  the row waits for the next cadence tick. All session dirs are physically flat
  siblings under `sessions/`, verified — nested subagent relationships are
  logical only.
- **Cadence mechanism (IMPORTANT — do not touch the TTL):** there is no
  per-provider TTL; the index-global TTL forces a `force_full` sweep of ALL
  providers plus a global prune and re-sort (`directory_index.rs:1231,1237-1241`),
  so lowering it would full-reconcile Claude/Codex/OpenCode every 15s. The
  correct lever is a 15-second timer calling
  `index.mark_provider_dirty("amplifier")` — an amplifier-only full discover
  (`:1572-1584`) with amplifier-only prune (`:1699-1711`) — active while any
  **connected** client's most recent sessions fetch had `includeSubagents=true`
  (track the flag per WS client; clear on disconnect). Do NOT gate on fetch
  recency alone: client fetches are broadcast-driven, not polled, so a
  time-window flag starves itself after ~5 quiet minutes and an externally
  resumed subagent (all writes inside its unwatched dir) would then sit stale
  for the full 15-min reconcile. Gating on connected-client state keeps the
  cadence alive the whole time the toggle is on. Warm amplifier discover is
  ~0.3s → ~2% of a core while the toggle is in use, zero when idle.
- Subagent-dir mkdir events escalate to provider-dirty (full amplifier discover)
  ONLY while the subagents-subscribed flag is set; with the toggle off they
  are dropped (rows ride the 15-min reconcile — invisible anyway), avoiding a
  ~0.3s discover per flush during heavy delegation bursts that nobody can see.
- Result with toggle on: subagent titles/turn counts/completion lag at most ~15s.
  With toggle off: subagent rows refresh at the 15-min reconcile.

Explicitly deleted (previous iterations, rejected as over-engineering once the
toggle-driven cadence existed): transient subagent watches, promotion-on-create,
24h release, re-promotion channel, hot sets, LRU caps, activity sweeps. Both
MAJOR findings of adversarial round 3 were bugs in that machinery; it is gone.

### Resources and growth

- ~4,430 permanent watches ≈ 0.8% of `max_user_watches` (524,288); ~1KB kernel
  memory each; watches on dead dirs cost no CPU and produce no events.
- Root-session accrual is real (~2,576 created in July 2026 alone, ~31K/yr at
  that pace). Growth is **accepted explicitly** — it preserves instant resume of
  arbitrarily old sessions. Startup logs the armed count; WARN when total exceeds
  25% of `/proc/sys/fs/inotify/max_user_watches`.
- Drift alarm: count arms of unknown-format (non-UUID, non-subagent-pattern) dir
  names and WARN if they exceed a small daily threshold — if Amplifier ever
  changes subagent naming, this surfaces in days instead of silently minting
  ~609 permanent watches/day.
- Startup: one readdir sweep (spawn_blocking) builds the plan; ~4.4K `watch()`
  calls (well under a second); then a full discover. Persisted cache serves reads
  meanwhile.

### Regression tests (accumulated across review rounds)

1. Folded-sidecar-mtime freshness on both the discover path and the scoped path
   (activity sort must not freeze under scoped-stat optimization).
2. Unwatched-subagent row refreshes via the reconcile cadence; cadence drops to
   15s while `includeSubagents` requests are recent and reverts after.
3. Classification: underscore-bearing PROJECT names don't misclassify root
   sessions; unknown basename formats default to watched.
4. Misnamed-root self-correction round trip (name says subagent, `parent_id`
   absent → armed via the refresh report).
5. Scoped rewrite: sidecar/tmp/backup events at canonical depth produce scoped
   metadata.json marks, not provider-dirty; steady heavy activity triggers no
   repeated full discovers.
6. `context-intelligence/` mkdir inside a session dir does not trigger a full
   discover.
7. Stand-in swap: `sessions/` created between check and arm is still picked up.
8. Deletion: session-dir removal prunes rows; metadata.json-only deletion with
   surviving sidecars prunes (fold-aware stat returns None) — never resurrects.
9. Arm-failure backoff is not bypassed by the self-correction diff.
10. Debounce max-deferral: sustained sub-200ms event stream still flushes ≤2s.
11. Transient scan failure (EACCES/EIO) never causes mass prune (existing
    `discover_checked` protection stays intact through the refactor).
12. Cadence uses `mark_provider_dirty("amplifier")`, never the global TTL: while
    the 15s cadence is active, Claude/Codex/OpenCode see no extra sweeps.
13. Renamed root session dir is re-armed via the cascade (structural
    `MovedTo` treated as create).
14. With the toggle off, a subagent-dir mkdir triggers no full discover; events
    under a stand-in watch that aren't `sessions/` are dropped.
15. Cadence gating: the 15s cadence stays active through arbitrarily long quiet
    periods while a subagents-subscribed client remains connected (an externally
    resumed subagent after 10 idle minutes is picked up within ~15s, not the
    15-min reconcile), and stops when the last such client disconnects.
16. Structural `MovedFrom`/`Remove` of a project cleans armed/absent/retry
    bookkeeping (no forever-retrying entries after project deletion; no leaked
    inode-following watches after `mv`).
17. A stray file created at project depth causes no arm attempt; a
    deterministic arm error (ENOENT/ENOTDIR) leaves the retry set immediately.

### Measured facts the design rests on (2026-08-17, this machine)

- Session dirs are all physically flat at `<proj>/sessions/<session>`.
- Basename pattern ⇔ `parent_id` presence: 100% in 480 sampled dirs.
- ~7% of recent session dirs lack `metadata.json`; they are not indexable today
  and this design does not change their visibility.
- Warm full discover ≈ 0.3s (readdir 1,235 projects + stat/fold 22K sessions).
