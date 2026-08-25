# Kata 0gdd: Session-Index Scanning and Refresh Observations Only

**Date assembled:** 2026-08-16

**Purpose:** Cold-start evidence packet for an independent parallel investigation

**Investigated source revision:** `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`

**Document status:** Uncommitted observations file on local branch `docs/0gdd-handoff`

> **Document rule:** This file records source behavior, experiment construction,
> retained output, arithmetic, chronology, and absent measurements. It contains no
> selected future behavior or next-step judgment.
>
> **Privacy boundary:** No real session title, durable session ID, prompt, message,
> token, request header, or provider path below the structural roots appears here.

## 1. Purpose, evidence tiers, and quarantine boundary

### 1.1 Evidence-tier scheme

Every non-code claim and table in this file inherits the evidence tier declared at
the start of its subsection unless an inline tier overrides it:

| Marker | Evidence tier | Meaning in this file |
|---|---|---|
| **[P]** | Retained primary artifact | A retained JSON/JSONL file, systemd journal entry, git object/ref, filesystem metadata record, process record, or directly read issue metadata field |
| **[D]** | Direct transcript file-read | A captured tool result that directly read a now-vanished Level 1 file; only the neutral extracted value is reproduced here |
| **[R]** | Recomputed in this document | Arithmetic or distribution recomputed from [P] or [D] values, with the formula or method stated |
| **[A]** | Prior analyst output no longer independently reproducible | A neutral numeric extract recorded before reboot whose underlying per-run files are now absent |
| **[I]** | Inference from listed facts | A statement derived from separately listed facts rather than an emitted status or direct field |
| **[C]** | Direct code observation | Text read from source pinned to `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`, or from the separately hashed diagnostic source named in the subsection |

Tables with a single declared tier apply that tier to every row. Mixed-tier tables
carry a `Tier` column. Emitted labels such as `watcher_overflow`, `resource_cpu`, and
`post_arm_watches` are recorded statuses; surrounding explanations do not inherit
causal meaning from those names.

### 1.2 Quarantine before independent analysis

The following conclusion-bearing materials are outside this packet. An independent
parallel investigator can form an analysis from this file and the primary/code
sources it cites without opening them first:

- the earlier decision-bearing 0gdd engineering handoff and its documentation
  commit;
- conversation-level analyst syntheses, final assistant summaries, and decision
  messages;
- the current full render and comment stream of the performance Kata; only its
  creation-time title and original observation fields are extracted in Section 1.3;
- the full body and comments of the naming follow-up Kata;
- the full bodies/comments and associated implementation-plan or handoff prose for
  the related-work records summarized anonymously in Section 8.8.

This quarantine list intentionally omits paths, transcript offsets, and the earlier
handoff commit identifier. No later section links to those materials or summarizes
their decisions.

### 1.3 Original question

**Evidence tier: [P] — local issue title and creation metadata fields only.**

Kata `freshell#0gdd` was created on 2026-08-11 with the title:

> Investigate freshell-server chronic ~50%-of-a-core CPU baseline
> (session-directory polling suspect)

**Evidence tier: [P] — original issue observation fields.**

The original record stated:

- a Rust server process using 43–56% of one CPU core across two observed uptimes;
- requests to
  `GET /api/session-directory?priority=visible&limit=50` approximately every two
  seconds;
- request elapsed times of approximately 100–150 ms;
- a request for attribution before a production behavior change.

### 1.4 Observation-only scope

**Evidence tier: [C] — Level 1 runner and diagnostic-control source.**

The Level 1 code used native WSL processes, temporary boot-time controls, scratch
servers on non-production ports, and process sampling through `/proc`. The provider
source implementations called by the scratch server use read/stat/query operations
for provider storage. Section 4.3 records the isolation boundary in detail.

**Evidence tier: [D] — direct read of the vanished safety file.**

The captured safety-file read recorded 40 production-fingerprint comparisons,
20 exact scratch stops, zero forced scratch kills, and zero invalid runs. Production
remained active during the final Level 1 campaign.

### 1.5 Evidence inventory

| Tier | Evidence class | Location or origin | Present on 2026-08-16 | Contents used here |
|---|---|---|---:|---|
| [C] | Investigated product source | Git object `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` read through `/home/dan/code/freshell/.worktrees/0gdd-handoff` | Yes | Source behavior in Sections 3 and 8.6 |
| [C]/[P] | Level 1 diagnostic source/status | `/home/dan/code/freshell/.worktrees/0gdd-measurement` | Yes | Three modified Rust files, one TypeScript runner, one TypeScript test, hashes, and git status |
| [D] | Direct reads of vanished Level 1 files | Neutral JSON values captured before reboot; broader transcript location withheld by Section 1.2 | Captured values remain; source files do not | Exact run summaries, freshness JSON, safety JSON, and manifest JSON |
| [A] | Prior aggregate Level 1 analysis | Neutral aggregate extracts produced while all 76 files existed | Underlying run files absent | Per-run RSS/I/O/latency table and refresh/source/cache aggregate calculations |
| [C]/[P] | Observer source/status | `/home/dan/code/freshell/.worktrees/0gdd-observer/crates/freshell-sessions/examples/observer_0gdd.rs` | Yes | One untracked 4,776-line Rust example, hash, and test status |
| [P] | Observer aggregate evidence | `/home/dan/.local/state/freshell/0gdd-observer-*` | Yes for `-03`, `-04`, `-06`, `-07`, and `-08` | Private aggregate events, state, and reports where written |
| [P] | Observer host handoffs | `/home/dan/.local/state/freshell/0gdd-observer-preflight-*.json` | Yes, five files | Kernel limits and aggregate file-watch counts |
| [P] | User-service journal | Local user journal for `freshell-0gdd-observer.service` | Yes | Start, exit, status text, CPU time, and reboot boundary |
| [A] | OpenCode visible/native-title count extract | Neutral count-only output from the earlier read-only investigation | Underlying private query result not retained here | The four counts in Section 8.7; no title or ID values |

### 1.6 Evidence that disappeared after reboot

**Evidence tier: [A] — prior file inventory; the directory itself is absent.**

The final Level 1 result directory was created under `/tmp`. A prior inventory
recorded 76 files and 1,265,171 bytes. A later WSL reboot removed the directory. The
following are unavailable for a current direct read:

- the 18 per-run process streams;
- the 18 per-run request streams;
- the 18 per-run diagnostic-event streams;
- the 18 per-run summaries;
- `comparisons.json`;
- `freshness.json`;
- `safety.json`;
- `manifest.json`.

**Evidence tier: [D] — captured direct reads.**

Exact per-run summary objects, freshness objects, safety counters, and manifest
fields in Sections 4.6, 4.10, and 4.11 came from direct reads of those files before
the reboot.

**Evidence tier: [A] — prior aggregate analysis.**

Per-run RSS/I/O/latency values and aggregate refresh/source/cache values in Sections
4.7 and 4.9 were calculated before reboot from all run streams. The vanished streams
prevent an independent recalculation now.

**Evidence tier: [P] — retained observer files.**

Observer run `-07` ended at the WSL reboot boundary. Its `events.jsonl` and latest
`state.json` remain. It has no final `report.json`. Observer run `-08` began after
reboot and its aggregate output remains.

## 2. Environment and production snapshots

The table below is the explicit evidence-tier declaration for every non-code claim
and table in each subsection unless an inline marker overrides it.

| Subsection | Default tier |
|---|---|
| 2.1 Host snapshot | [P] |
| 2.2 Repository revisions and worktrees | [P] |
| 2.3 Production process snapshots | [P] |
| 2.4 Provider storage shapes | [C] |
| 2.5 Corpus counts from different instruments | mixed: [A] for Level 1 counts; [P]/[R] for observer counts and arithmetic |
| 2.6 Observer limits used during `-08` | [A] for captured transient-service properties; [C] for source constants |

### 2.1 Host snapshot

Read-only host facts captured at `2026-08-16T12:53:51Z`:

```text
Environment:     WSL2 / Linux
Kernel:          6.6.87.2-microsoft-standard-WSL2
Architecture:    x86_64
Logical CPUs:    32
Reported memory: 52,623,937,536 bytes
```

These values describe one machine and one boot environment. WSL resource assignment
and kernel versions are time-varying environment fields.

### 2.2 Repository revisions and worktrees

| Item | Path | Revision / branch at 2026-08-16 | Git state relevant to this study |
|---|---|---|---|
| Current main checkout | `/home/dan/code/freshell` | `main` at `e35adfbb0efaac8d3d5d3c3d255ad0746d99c388` | Main had advanced 14 commits beyond the investigated revision |
| Source snapshot used by Level 1 and observer | all `0gdd-*` worktrees | `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` | Merge commit for PR #643 |
| Level 1 worktree | `/home/dan/code/freshell/.worktrees/0gdd-measurement` | `investigation/0gdd-measurement` | 3 tracked modifications and 2 untracked files; no commit or remote branch |
| Observer worktree | `/home/dan/code/freshell/.worktrees/0gdd-observer` | `investigation/0gdd-observer` | exactly one untracked example; no commit or remote observer branch |
| Observations worktree | `/home/dan/code/freshell/.worktrees/0gdd-handoff` | local branch `docs/0gdd-handoff` | This observations file is the only uncommitted worktree change |

All source line references in Section 3 resolve against revision `225a91db3…` in the
observations worktree. Observer line references resolve against the untracked source
whose hash appears in Section 5.1. Measurement-runner line references resolve in the
measurement worktree.

### 2.3 Production process snapshots

During the retained final Level 1 run, the production identity check recorded:

```text
PID:        68716
Executable: /home/dan/code/freshell/target/release/freshell-server
Working dir:/home/dan/code/freshell
Listener:   0.0.0.0:3001
```

The WSL reboot ended that process.

During observer run `-08`, production used PID `12320`. The observer recorded 1,632
identity/listener comparisons and zero mismatches during its observation window.
The startup log records:

```text
[2026-08-14T16:49:40Z] freshell-server listening on http://0.0.0.0:3001
[pid 12320]
[commit 225a91db3e4d48d4b6a7e8bc0987afad8ff31917]
[dirty true]
```

A read-only check at `2026-08-16T12:53:51Z` found:

```text
PID:             12320
Start:           2026-08-14 16:49:38 UTC
Elapsed:         approximately 1 day 20 hours
State:           Ssl
ps `%CPU` field: 110% at the sample time
RSS:             4,616,280 KiB
Threads:         181
Working dir:     /home/dan/code/freshell
Listener:        0.0.0.0:3001, owned by PID 12320
/proc exe link:  target/release/freshell-server (deleted)
```

**[I] Linux process-field interpretation:** the `ps %CPU` field is accumulated
process CPU time divided by elapsed process lifetime at the sample time; it is not an
instantaneous CPU reading. A multithreaded process can report more than 100%. This
host sample is outside the controlled Level 1 windows. The `(deleted)` suffix records
that the executable path's directory entry was replaced after this process started;
it does not identify when or why that replacement occurred.

### 2.4 Provider storage shapes

Only structural roots are named here:

| Provider | Storage shape read by the investigated index |
|---|---|
| Claude | `<real-home>/.claude/projects/<project>/*.jsonl`, plus supported nested `subagents/*.jsonl` files |
| Codex | `<real-home>/.codex/sessions/**/*.jsonl` |
| Amplifier | `<real-home>/.amplifier/projects/**/sessions/**/metadata.json`, with sibling `transcript.jsonl` and `events.jsonl` metadata consulted during discovery/parse |
| OpenCode | the provider data home's `opencode.db` and `opencode.db-wal` |
| Freshell parse cache | `<FRESHELL_HOME-or-HOME>/.freshell/rust-session-cache.json` |

The production source constructors are in
`crates/freshell-server/src/main.rs:658-694`. Claude and Codex traversal is in
`crates/freshell-sessions/src/directory_index.rs:250-608`; OpenCode direct listing
is in `crates/freshell-sessions/src/directory_index.rs:610-683`; Amplifier discovery
is in `crates/freshell-sessions/src/amplifier.rs:62-195`.

### 2.5 Corpus counts from different instruments

The counters below count different units:

| Tier | Instrument and time | Counted unit | Values |
|---|---|---|---|
| [A] | Level 1 `SessionIndex` | parsed/indexed session rows | 31,657 at the beginning of the prior aggregate record; 31,830 at the end |
| [A] | Level 1 refresh source events | provider files discovered per refresh | approximately 30,500; provider-specific exact discovery counts were not preserved |
| [P] | Observer `-08` startup inventory | qualifying file paths plus OpenCode DB/WAL paths | 76,890 |
| [P] | Observer `-08` final inventory | qualifying file paths plus OpenCode DB/WAL paths | 80,324 |

**[C] Counter-unit explanation:** the observer inventory includes three qualifying
Amplifier filenames per session directory when present. The production index has one
discovered Amplifier
`metadata.json` entry and folds sibling activity mtimes into that entry. The
observer OpenCode inventory has at most the database and WAL paths, while an
OpenCode database query returns many session rows.

### 2.6 Observer limits used during `-08`

Systemd properties recorded for the run:

```text
Restart=no
Nice=19
IOSchedulingClass=idle
CPUQuota=5%
MemoryHigh=224M
MemoryMax=256M
MemorySwapMax=128M
TasksMax=16
LimitNOFILE=65536
ProtectSystem=strict
ProtectHome=read-only
NoNewPrivileges=yes
RestrictAddressFamilies=AF_UNIX
PrivateTmp=yes
RuntimeMaxSec=25h
ReadWritePaths=<private run root only>
Environment names: HOME, LANG, LC_ALL
```

Observer-side constants and checks:

| Limit | Value | Source |
|---|---:|---|
| Observation window | 86,400,000 ms | `observer_0gdd.rs:23-27` |
| Minute bucket | 60,000 ms | `observer_0gdd.rs:25` |
| Metadata reconciliation | 900,000 ms | `observer_0gdd.rs:26` |
| Late-notice allowance | 60,000 ms | `observer_0gdd.rs:27` |
| Rapid-repeat window | 250 ms | `observer_0gdd.rs:28` |
| Pending correlation IDs | 200,000 | `observer_0gdd.rs:29` |
| Ingress distinct `(kind,path)` keys | 8,192 | `observer_0gdd.rs:30` |
| Observer-owned file watches | 50,000 | `observer_0gdd.rs:31` |
| Observer-owned watcher instances | 4 | `observer_0gdd.rs:32` |
| Inaccessible same-user processes | 10 | `observer_0gdd.rs:33` |
| Aggregate event file | 64 MiB | `observer_0gdd.rs:37` |
| Software CPU threshold | 6% for two complete windows | `observer_0gdd.rs:38-41`, `observer_0gdd.rs:967-995` |
| Observer RSS | 192 MiB | `observer_0gdd.rs:928-945` |
| Observer file descriptors | 60,000 | `observer_0gdd.rs:928-945` |
| Observer threads | 12 | `observer_0gdd.rs:928-945` |
| Host file-watch and instance use | one fifth of kernel limits | `observer_0gdd.rs:848-889` |

## 3. Source behavior at the investigated revision

**Default evidence tier for Sections 3.1 through 3.12: [C] — direct source reads
pinned to `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`. Section 3.13 separately
labels construction-search evidence and tool limits.**

### 3.1 Index construction and TTL

The server constructs one `SessionIndex` with Claude, Codex, OpenCode, and Amplifier
sources at `crates/freshell-server/src/main.rs:658-694`.

`SessionIndex::new` uses a 1,000 ms freshness window:

- `DEFAULT_TTL`: `crates/freshell-sessions/src/directory_index.rs:46-50`;
- constructor: `crates/freshell-sessions/src/directory_index.rs:856-900`.

The index contains:

- a published `Arc<Vec<IndexedSession>>` and fetch time;
- one refresh lock;
- a file cache keyed by absolute file path;
- a direct-list cache keyed by source position;
- an optional parse-cache path and save bookkeeping.

These fields are declared at
`crates/freshell-sessions/src/directory_index.rs:792-838`.

### 3.2 Snapshot behavior

A call to `snapshot()` delegates to `snapshot_with_failures()`:

- a snapshot younger than the TTL is returned;
- if an older snapshot exists and the caller obtains the refresh lock, that older
  snapshot is returned and a detached refresh starts;
- if an older snapshot exists and another refresh owns the lock, the older snapshot
  is returned;
- if no snapshot exists, the caller waits for an inline refresh or for another cold
  caller's refresh.

Source: `crates/freshell-sessions/src/directory_index.rs:938-1083`.

The refresh's synchronous discovery/parse portion runs via `spawn_blocking`; the
new vector and provider-failure set are published together. Parse-cache persistence,
when selected by its save gate, runs in another detached task. Source:
`crates/freshell-sessions/src/directory_index.rs:1086-1197`.

### 3.3 Production call sites that can encounter the TTL boundary

| Caller | Trigger | Source |
|---|---|---|
| Startup warm | one task at server startup | `crates/freshell-server/src/main.rs:1212-1236` |
| Session-change sweep seed and loop | initial read, then each two-second tick | `crates/freshell-server/src/main.rs:2559-2579` |
| Automatic-title loop | each two-second tick | `crates/freshell-server/src/auto_title_sweep.rs:507-549` |
| Session-directory request | each authenticated GET | `crates/freshell-server/src/session_directory.rs:381-432` |
| Session rename lookup | session PATCH paths that look up an indexed row | `crates/freshell-server/src/sessions.rs:237-245` |
| Resume resolution | when a published snapshot exists | `crates/freshell-server/src/resolve.rs:603-626` |
| Degraded resume retry | explicit `request_refresh()` after a degraded result | `crates/freshell-server/src/resolve.rs:783-788` |
| Terminal/session existence probe | detached `snapshot()` from `kick_refresh` | `crates/freshell-server/src/existence.rs:183-191` |
| Debug endpoint | authenticated debug-body construction | `crates/freshell-server/src/diag.rs:183-200` |

The refresh lock limits simultaneous refresh work from these callers to one refresh.
The calls can still be refresh triggers when a published snapshot is older than one
second.

### 3.4 File-backed provider refresh mechanics

For Claude, Codex, and Amplifier, each refresh calls `discover_checked()` and obtains
a current list of `(path, mtime_ms, size)` values. Each discovered path is compared
with the file cache:

- same mtime and size: cached parsed row or cached exclusion reused;
- changed or new mtime/size: source parser called and cache entry replaced;
- a path absent from the combined discovered set: file-cache entry removed.

After all sources, cached rows are cloned into a new vector. Source:
`crates/freshell-sessions/src/directory_index.rs:1267-1423`.

Provider traversal details:

- Claude sorts project entries, stats direct JSONL files, and stats supported
  `subagents/*.jsonl` files. It reads and parses a file only after cache invalidation.
  Source: `crates/freshell-sessions/src/directory_index.rs:276-413`.
- Codex recursively walks the `sessions` tree and stats JSONL files. It reads and
  parses a file only after cache invalidation. Source:
  `crates/freshell-sessions/src/directory_index.rs:444-608`.
- Amplifier recursively discovers exact `metadata.json` filenames beneath a
  `sessions` path segment. Discovery also stats sibling `transcript.jsonl` and
  `events.jsonl` and folds their latest mtime into the metadata entry's mtime. Parse
  reads `metadata.json` and a bounded prefix of the sibling transcript; it does not
  read `events.jsonl` content. Source:
  `crates/freshell-sessions/src/amplifier.rs:1-42`,
  `crates/freshell-sessions/src/amplifier.rs:86-205`, and
  `crates/freshell-sessions/src/amplifier.rs:407-435`.

A root-listing error from a file-backed provider records the provider name and uses
an empty discovered list for that source during that refresh. The common prune then
removes file-cache entries not present in the combined discovered set. Source:
`crates/freshell-sessions/src/directory_index.rs:1364-1409`.

### 3.5 OpenCode refresh mechanics

OpenCode has no per-session file-cache entry. Its change token is the later mtime of
`opencode.db` and `opencode.db-wal`. Each refresh reads those mtimes. When the token
matches the cached token, the cached OpenCode row vector is reused and a health
query still runs. When the token differs, `direct_list()` queries the database and
replaces the cached vector after a successful result. Source:
`crates/freshell-sessions/src/directory_index.rs:610-683` and
`crates/freshell-sessions/src/directory_index.rs:1304-1362`.

The listing query:

- detects whether `parent_id` exists;
- filters archived rows;
- filters child rows when `parent_id` exists;
- left-joins project metadata;
- orders by `time_updated` descending.

Source: `crates/freshell-sessions/src/parse/opencode.rs:230-344`.

When an OpenCode health or listing read returns an error, the provider failure is
recorded and the previous direct-cache vector remains present. Source:
`crates/freshell-sessions/src/directory_index.rs:1304-1357`.

### 3.6 Combined rebuild, sort, and parse-cache save

Each refresh rebuilds the combined vector from file-cache and direct-cache rows and
sorts it by:

1. `last_activity_at` descending;
2. `provider:session_id` key descending for equal activity times.

Source: `crates/freshell-sessions/src/directory_index.rs:1411-1423`.

The parse-cache save gate has these values:

```text
Schema version:           1
Filename:                 rust-session-cache.json
Changed-entry threshold:  50
Save debounce:            60 seconds
```

The first selected refresh saves once when at least one entry changed. Later saves
are selected when at least one entry changed and either 50 accumulated changes were
reached or 60 seconds elapsed since the previous save. The save clones the complete
file cache before serialization. Source:
`crates/freshell-sessions/src/directory_index.rs:1208-1247` and
`crates/freshell-sessions/src/directory_index.rs:1457-1476`.

### 3.7 Session-directory request work

The authenticated request handler:

1. validates the query;
2. calls `SessionIndex::snapshot()`;
3. maps every indexed row to a `DirItem` vector;
4. overlays session configuration;
5. joins session metadata;
6. copies and joins live terminal identities;
7. calls `apply_query`.

Source: `crates/freshell-server/src/session_directory.rs:374-454`.

For the no-search path, `apply_query`:

- computes revision across all items and identities;
- sorts the full vector again;
- filters subagent, non-interactive, and empty rows;
- applies the cursor filter;
- determines `has_more` from the remaining vector length;
- serializes at most `limit` rows.

Source: `crates/freshell-server/src/session_directory.rs:1170-1294`.

The maximum accepted `limit` at this revision is 50. The `priority` query value is
validated; it is not a field in the internal `DirQuery` used by `apply_query`.

### 3.8 Two-second sweep and browser refetch

`SESSIONS_SWEEP_INTERVAL` is 2,000 ms at
`crates/freshell-server/src/main.rs:2387-2393`.

The sweep:

- obtains one snapshot before the interval loop;
- computes `(row count, maximum last activity, hash of live identity triples)`;
- obtains another snapshot and identity list each tick;
- broadcasts `sessions.changed` when the tuple differs;
- configures missed interval ticks to skip rather than burst.

Source: `crates/freshell-server/src/main.rs:2495-2579`.

The browser receives `sessions.changed`, compares its revision with the last seen
revision, and dispatches `queueActiveSessionWindowRefresh()` when the revision
increases. Source: `src/App.tsx:1142-1149`.

### 3.9 Automatic-title loop interaction

The automatic-title loop uses the same two-second interval and the same index
snapshot accessor. On each tick it:

- maps every indexed row into a `SweepSession` vector;
- reads session overrides;
- passes the vector to `run_auto_title_pass`.

Source: `crates/freshell-server/src/auto_title_sweep.rs:507-549`.

`run_auto_title_pass` iterates the supplied sessions and performs a live-identity
lookup for each row. Only rows with one or more matching identities enter the
metadata/title work vector. Source:
`crates/freshell-server/src/auto_title_sweep.rs:295-320`.

Both the session-change loop and automatic-title loop are started at server startup
at `crates/freshell-server/src/main.rs:1220-1270`.

### 3.10 Existing Node session indexer

`CodingCliSessionIndexer` declares these timing defaults:

```text
debounce:            2,000 ms
throttle:            5,000 ms
periodic full scan:  10 minutes
urgent refresh:      300 ms
urgent throttle:     1,000 ms
```

It stores `fileCache`, `dirtyFiles`, `deletedFiles`, `dirtyProviders`,
`needsFullScan`, `refreshInFlight`, and `refreshQueued` state. `start()` marks a full
scan, awaits `refresh()`, reconfigures watchers, and starts the periodic full-scan
timer when its interval is positive. Source:
`server/coding-cli/session-indexer.ts:430-495`.

Its chokidar session watcher uses provider globs with `ignoreInitial:true`; `add` and
`change` call `markDirty`, `unlink` calls `markDeleted`, and each schedules a
refresh. The root watcher derives existing ancestors within provider watch bases,
sets a maximum depth, watches create/remove events for roots and root files, marks
`needsFullScan`, reconfigures, and schedules refresh. Source:
`server/coding-cli/session-indexer.ts:497-679`.

The dirty/deleted methods normalize paths. File-backed changes move a path between
`dirtyFiles` and `deletedFiles`; direct-listed-provider changes add the provider to
`dirtyProviders`. Source: `server/coding-cli/session-indexer.ts:750-804`.

### 3.11 Existing Node sessions synchronization

`SessionsSyncService` has a default coalescing window of 150 ms. With a positive
window, the first `publish` call flushes immediately and starts a timer; later calls
within the window replace one pending trailing snapshot. When the timer fires, the
latest pending snapshot is flushed and another window begins. A flush compares the
previous and next project snapshots plus project-color maps, increments a revision
when the comparison differs, and calls `broadcastSessionsChanged`. Source:
`server/sessions-sync/service.ts:30-115`.

The Node server constructs `CodingCliSessionIndexer` at `server/index.ts:240-244`,
constructs `SessionsSyncService` at `server/index.ts:537-538`, publishes indexer
updates through the sync service at `server/index.ts:881-882`, starts the indexer at
`server/index.ts:1098`, and shuts down the sync service at `server/index.ts:1263`.

### 3.12 Exported Rust indexer/watcher state machine

`crates/freshell-sessions/src/lib.rs:22` publicly exports `indexer`. The module
contains:

- `ProviderSpec`, `FsProbe`, `Watcher`, `WatcherFactory`, `FsEvent`, and
  `IndexerEvent` at `crates/freshell-sessions/src/indexer.rs:23-93`;
- an `Indexer` state machine with two watcher slots, a discovered-path set,
  `needs_full_scan`, and `rescan_pending` at
  `crates/freshell-sessions/src/indexer.rs:95-127`;
- `start`, watcher reconfiguration, existing-root recursive watches, late-root
  ancestor watches, event handling, and full path rediscovery at
  `crates/freshell-sessions/src/indexer.rs:129-378`;
- Claude, Codex, and OpenCode provider path specifications and `RealFsProbe` at
  `crates/freshell-sessions/src/indexer.rs:389-470`;
- `NotifyWatcherFactory` and `NotifyWatcher`, which map notify events into a supplied
  `std::sync::mpsc::Sender<FsEvent>`, at
  `crates/freshell-sessions/src/indexer.rs:472-538`.

The `Indexer` event handlers schedule `run_pending_rescan`; that method invokes
`list_session_files` for each provider and replaces the complete discovered-path
set. This module does not parse or publish the `IndexedSession` vector used by
`SessionIndex`.

### 3.13 Construction and wiring search at the pinned revision

**Evidence tiers: [P] for exact git-text-search output; [C] for directly read
construction sites; [I] only for the explicitly marked absence statement.**

A pinned-revision `git grep` for `NotifyWatcherFactory`, `Indexer::new`,
`freshell_sessions::indexer`, and `indexer::Indexer`, excluding the implementation
file itself, returned construction references only in
`crates/freshell-sessions/tests/late_root_watcher_liveness.rs`:

- fake-factory constructions at lines 147-151, 239-243, and 279-283;
- a real `NotifyWatcherFactory::new(tx)` construction at lines 308-314.

The real-watcher test creates a temporary Claude root, starts the exported indexer,
creates the previously absent root and a JSONL fixture, pumps notify events, and runs
pending rescans. Source:
`crates/freshell-sessions/tests/late_root_watcher_liveness.rs:297-355`.

**[I]** In the files covered by that exact text search, no Rust server construction
of the exported `Indexer` or `NotifyWatcherFactory` was observed. The Rust server
construction observed in direct source is the separate four-provider `SessionIndex`
at `crates/freshell-server/src/main.rs:658-694`.

Semantic-search limitation: one LSP reference request for `NotifyWatcherFactory`
timed out while starting the Rust language server; another reference request near
`Indexer::new` returned zero results despite the directly read test constructions
above. The construction inventory in this subsection uses pinned `git grep` and
direct file reads rather than treating the LSP result as absence evidence.

## 4. Level 1 harness and measurements

The table below is the explicit evidence-tier declaration for every non-code claim
and table in each subsection unless an inline marker overrides it.

| Subsection | Default tier |
|---|---|
| 4.1 Diagnostic source and test status | [P] for git/hash/test output; [C] for source shape |
| 4.2 Controls | [C] |
| 4.3 Isolation and sampling | [C], with [P] and [I] boundaries marked inline |
| 4.4 Run order and script bounds | [C] |
| 4.5 First real attempt | [A] |
| 4.6 Every retained processor run | mixed: [D] for direct per-run numeric summary fields; [A] for timestamped file stems and aggregate request-response claims; [R] for checks recomputed from [D] values |
| 4.7 Per-run resource and request summary | [A] |
| 4.8 Bracket arithmetic | [R], using [D] inputs |
| 4.9 Refresh/source/sweep/cache events | [A] |
| 4.10 Synthetic freshness | [D] for values; [R] for means, difference, and ratio |
| 4.11 Safety and provenance | [D] for vanished-file reads; [P] for current binary/hash status |
| 4.12 Scope boundaries | [D] or [A], matching the source subsection above |

### 4.1 Diagnostic source and current test status

```text
Worktree: /home/dan/code/freshell/.worktrees/0gdd-measurement
Branch:   investigation/0gdd-measurement
Base:     225a91db3e4d48d4b6a7e8bc0987afad8ff31917
Remote feature branch: absent
Commit containing diagnostics: none
```

Changed paths:

```text
M  crates/freshell-server/src/auto_title_sweep.rs
M  crates/freshell-server/src/main.rs
M  crates/freshell-sessions/src/directory_index.rs
?? scripts/measure-0gdd-level1.ts
?? test/unit/scripts/measure-0gdd-level1.test.ts
```

Tracked Rust diff:

```text
520 insertions, 62 deletions
```

Runner and test:

```text
scripts/measure-0gdd-level1.ts
  lines: 818
  SHA-256: 9aee493d20b2706c7334820b7cda511f7f216a90101ae47afc0e41c67e630d09

test/unit/scripts/measure-0gdd-level1.test.ts
  lines: 543
  SHA-256: da97873eaa11eaa96541407f06e315d8ef565727ee39591c1a4c591ac90ae7b4
```

A focused rerun on 2026-08-16 reported 31 passed tests. Earlier recorded checks for
this unchanged source also reported TypeScript typecheck, code review, and security
review completion.

### 4.2 Controls

The runner defines these boot-time controls behind
`FRESHELL_0GDD_LEVEL1=1`:

| Control | Values used |
|---|---|
| Session-change sweep | on / off |
| Automatic-title sweep | on / off |
| Refresh mode | normal 1-second TTL / 10-second TTL / warm once then no ongoing refresh |
| Parse-cache writes | on / off |
| Browser-style GET stream | one request every two seconds / none |

Runner definitions: `scripts/measure-0gdd-level1.ts:11-24` and
`scripts/measure-0gdd-level1.ts:41-55`. The conditional run order is at
`scripts/measure-0gdd-level1.ts:127-211`.

The quiet condition used:

```text
session sweep: off
automatic-title sweep: off
refresh: warm-only
cache writes: off
GET stream: off
```

### 4.3 Isolation and sampling

**[C] Process/configuration separation implemented by the runner:**

Each condition started a new scratch server with:

- a random loopback port other than 3001;
- a random token;
- a condition-private home and `FRESHELL_HOME`;
- a condition-private config and log directory;
- a copied regular parse-cache file for real-corpus conditions;
- listener ownership verification before authenticated HTTP;
- production process/listener capture before the condition and comparison after it;
- exact scratch PID/start-time/executable/cwd/inode checks before any scratch signal.

Relevant runner source:

- environment: `scripts/measure-0gdd-level1.ts:41-55`;
- production and listener identity: `scripts/measure-0gdd-level1.ts:241-340`;
- cache copy: `scripts/measure-0gdd-level1.ts:341-361`;
- exact scratch stop: `scripts/measure-0gdd-level1.ts:441-558`;
- run startup and warm boundary: `scripts/measure-0gdd-level1.ts:621-673`.

**[C] Campaign-directory lifetime:**

One campaign root contained the seed cache, sanitized staging output, and one
condition directory at a time. `finishRun()` stopped the exact scratch process,
checked the condition directory, and deleted that directory after each condition.
The campaign root remained shared across the sequence until outer cleanup; the final
sanitized output lived in a separate output root. Source:
`scripts/measure-0gdd-level1.ts:497-558`,
`scripts/measure-0gdd-level1.ts:621-716`, and
`scripts/measure-0gdd-level1.ts:719-810`.

**[I] Shared-machine boundary derived from [D] process records and [C] runner
source:**

Scratch and production process records place both processes in the same WSL VM. The
runner contains no container, nested VM, CPU-set, or condition-specific cgroup
setup. In that configuration they share the WSL logical CPUs, Linux kernel,
underlying storage, kernel page cache, and real provider corpus. **[D]** Production
remained active on port 3001 across the recorded safety comparisons.

**[C] Provider-storage boundary:**

The scratch process received the real provider-root environment values. The provider
source paths exercised by `SessionIndex` use listing, metadata, file-read, and
read-only database-query operations. Unlike the later systemd observer, Level 1 did
not mount provider roots read-only and did not use a mount namespace to enforce
read-only access. Its writable Freshell configuration/cache/log paths were under the
private condition directory.

**[C] Sampling schedule:**

Each processor condition requested 150 seconds of measurement:

- `/proc/<pid>/stat`, `/proc/<pid>/status`, and `/proc/<pid>/io` sampled every
  second;
- browser-style GET scheduled every two seconds when enabled;
- sample and GET schedules ran independently;
- missed schedule points were skipped rather than replayed;
- measurement ended after the full wall-clock window;
- refresh and cache-save lifecycle sets had to remain empty for one second at the
  post-window boundary.

CPU formula:

```text
100 × (last process ticks - first process ticks)
-----------------------------------------------
      CLK_TCK × elapsed wall-clock seconds
```

Source: `scripts/measure-0gdd-level1.ts:26-35`,
`scripts/measure-0gdd-level1.ts:103-125`,
`scripts/measure-0gdd-level1.ts:214-239`, and
`scripts/measure-0gdd-level1.ts:695-716`.

### 4.4 Run-order and script bounds

The final sequence contained:

1. normal → quiet → normal;
2. normal → warm-only → normal;
3. automatic-title off between adjacent normal conditions;
4. session-change sweep off between adjacent normal conditions;
5. GET stream off between adjacent normal conditions;
6. cache writes off between adjacent normal conditions;
7. 10-second refresh between adjacent normal conditions;
8. three synthetic additions under normal refresh;
9. three synthetic additions under 10-second refresh.

The script's `validateRun` bounds for a 150-second condition were:

```text
elapsed:          145–180 seconds
process samples:  145–151
GET-enabled:      73–76 requests
GET-disabled:     exactly 0 requests
```

The bracket predicate was:

```text
abs(control 1 - control 2)
  <= max(5 percentage points, 15% of the two-control mean)
```

The `isMaterial` boolean required both adjacent control-minus-test differences to
be at least five points and the control mean-minus-test difference to be at least
10% of the control mean. These are script definitions, not evaluation language in
this document. Source: `scripts/measure-0gdd-level1.ts:127-138` and
`scripts/measure-0gdd-level1.ts:214-220`.

### 4.5 First real attempt before the retained final run

A real run from `2026-08-13T04:34:14.437Z` through
`2026-08-13T05:24:50.819Z` reached the synthetic freshness stage after its CPU
conditions. The first synthetic row was non-interactive; the request omitted
`includeNonInteractive=1`; the request count did not increase before the 30-second
timeout. The run ended with `freshness timeout`.

The cleanup path removed the scratch root, including per-condition sanitized files,
before final top-level files were written. No numeric CPU output from that attempt
survives.

**[A] Historical sequence:** the captured campaign record places the following
source changes after that attempt:

- use `includeNonInteractive=1` in synthetic freshness requests;
- copy sanitized CPU files to a separate private output before freshness;
- retain only the specified numeric fields for a freshness timeout;
- remove the raw root separately from retained sanitized output.

**[C] Current source:** those behaviors are visible at
`scripts/measure-0gdd-level1.ts:141-171`,
`scripts/measure-0gdd-level1.ts:364-403`, and
`scripts/measure-0gdd-level1.ts:729-810`.

### 4.6 Every retained processor run

**[D]** CPU, elapsed time, sample count, request count, and cache-save-start count
were preserved in direct reads of the per-run summaries before those files
disappeared. CPU is percentage of one CPU core. Elapsed is seconds.

**[A]** Timestamped file stems were preserved only in prior analyst output; their
underlying directory listing is absent.

| # | [A] File stem / condition | [D] CPU | [D] Elapsed | [D] Samples | [D] Requests | [D] Cache-save starts |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `normal-1-1786601081862` | 67.70328403026156 | 151.01187699300002 | 150 | 75 | 4 |
| 2 | `quiet-1786601254029` | 0.3666629830725619 | 150.00150694 | 150 | 0 | 0 |
| 3 | `normal-2-1786601409991` | 77.23685036674735 | 151.44325467 | 150 | 75 | 3 |
| 4 | `normal-1-1786601570770` | 93.70716838905945 | 152.12283377100005 | 150 | 75 | 3 |
| 5 | `warm-only-1786601738661` | 27.193034492217627 | 150.00164844299994 | 150 | 75 | 0 |
| 6 | `normal-2-1786601896463` | 91.2409833722121 | 151.31358178899995 | 150 | 75 | 4 |
| 7 | `auto-title-off-1786602069542` | 45.78226101472448 | 150.10180466599996 | 150 | 75 | 3 |
| 8 | `normal-3-1786602231920` | 65.74798773022783 | 151.44189721600011 | 150 | 75 | 3 |
| 9 | `session-sweep-off-1786602400088` | 68.49931823085237 | 150.0014929399998 | 150 | 75 | 4 |
| 10 | `normal-4-1786602572112` | 74.43949323032169 | 150.00102117100008 | 150 | 75 | 4 |
| 11 | `get-off-1786602735388` | 45.86254697561457 | 151.21270965800016 | 150 | 0 | 6 |
| 12 | `normal-5-1786602902030` | 74.40242143317047 | 151.11067332799988 | 150 | 75 | 5 |
| 13 | `cache-normal-1-1786603068331` | 77.96035489600683 | 150.10193342000014 | 150 | 75 | 5 |
| 14 | `cache-writes-off-1786603247455` | 80.4521927411905 | 150.10156452600006 | 150 | 75 | 0 |
| 15 | `cache-normal-2-1786603414972` | 80.56560264373505 | 150.00198103699972 | 150 | 75 | 3 |
| 16 | `refresh-normal-1-1786603578398` | 75.51700047039377 | 151.2109846640001 | 150 | 75 | 3 |
| 17 | `refresh-10s-1786603744536` | 39.966251292620996 | 150.00155896800013 | 150 | 75 | 2 |
| 18 | `refresh-normal-2-1786603904388` | 73.98812319386167 | 153.02456004100014 | 150 | 75 | 4 |

#### 4.6.1 Exact scope of the GET-disabled condition

**Evidence tier: [C] for removed code paths; [D] for the measured condition and
request counts; [R] for the bracket delta.**

The `get-off` condition changed only the runner's GET scheduler from enabled to
disabled. Its session-change sweep, automatic-title sweep, normal TTL, and cache
writes remained enabled. Source: `scripts/measure-0gdd-level1.ts:11-24`,
`scripts/measure-0gdd-level1.ts:127-138`, and
`scripts/measure-0gdd-level1.ts:695-716`.

The disabled scheduler removed 75 calls to
`GET /api/session-directory?priority=visible&limit=50`. For each absent request, the
following request-path work was also absent:

- `SessionIndex::snapshot()` call;
- mapping the full indexed snapshot to response rows;
- session-override overlay;
- session-metadata join;
- live-terminal identity list and join;
- revision computation;
- full-vector sort;
- visibility and cursor filtering;
- page-row serialization and HTTP response-body serialization.

Source: `crates/freshell-server/src/session_directory.rs:381-454` and
`crates/freshell-server/src/session_directory.rs:1170-1294`.

When a request-originated `snapshot()` call encountered a snapshot older than the
one-second TTL and obtained the refresh lock, that call could also initiate a
detached refresh. Removing the 75 request calls removed any refresh initiations that
would have originated from those calls. Background-loop and other call-site refresh
initiations remained possible. Source:
`crates/freshell-sessions/src/directory_index.rs:938-1083` and the call-site
inventory in Section 3.3.

The recorded GET-disabled CPU value was 45.86254697561457%. Its two adjacent control
values averaged 74.42095733174608%; the recomputed difference is 28.55841035613151
percentage points. That difference describes removal of the complete set above; the
experiment did not separately measure any member of that set.

**[R]** All 18 direct per-run numeric summaries met the script bounds in Section
4.4.

**[A]** Prior analyst output stated that all 1,200 measurement requests had HTTP
status 200 and response size 39,855 bytes. The vanished request streams prevent a
current independent recount of those status and body-size fields.

### 4.7 Per-run resource and request summary

This table is also **transcribed from vanished Level 1 output**. Memory and Linux
`/proc/<pid>/io` values were rounded to the displayed MiB units by the prior
analysis. The I/O columns are deltas of Linux fields `read_bytes` and `write_bytes`;
no direct block-device measurement was retained. The prior output labeled request
columns `p50` and `p95` but did not preserve the percentile/interpolation algorithm,
so that algorithm is not independently reproducible.

| Stem | Mean / max RSS MiB | `/proc/<pid>/io` `read_bytes` / `write_bytes` delta MiB | Requests | p50 / p95 ms |
|---|---:|---:|---:|---:|
| `normal-1-1786601081862` | 1,517 / 1,751 | 0.0 / 369.7 | 75 | 97 / 141 |
| `quiet-1786601254029` | 230 / 230 | 0.0 / 0.0 | 0 | — |
| `normal-2-1786601409991` | 1,508 / 1,730 | 0.1 / 277.4 | 75 | 116 / 233 |
| `normal-1-1786601570770` | 1,449 / 1,730 | 0.0 / 277.6 | 75 | 165 / 220 |
| `warm-only-1786601738661` | 969 / 1,012 | 0.0 / 0.1 | 75 | 165 / 245 |
| `normal-2-1786601896463` | 1,517 / 1,682 | 150.4 / 370.0 | 75 | 170 / 253 |
| `auto-title-off-1786602069542` | 1,319 / 1,519 | 460.9 / 277.6 | 75 | 139 / 236 |
| `normal-3-1786602231920` | 1,494 / 1,749 | 0.2 / 277.7 | 75 | 122 / 178 |
| `session-sweep-off-1786602400088` | 1,495 / 1,681 | 0.2 / 370.3 | 75 | 123 / 176 |
| `normal-4-1786602572112` | 1,407 / 1,761 | 0.5 / 370.3 | 75 | 120 / 178 |
| `get-off-1786602735388` | 1,640 / 1,883 | 0.3 / 463.0 | 0 | — |
| `normal-5-1786602902030` | 1,483 / 1,633 | 0.4 / 463.1 | 75 | 115 / 160 |
| `cache-normal-1-1786603068331` | 1,481 / 1,733 | 0.2 / 463.2 | 75 | 108 / 189 |
| `cache-writes-off-1786603247455` | 1,313 / 1,522 | 0.1 / 0.2 | 75 | 130 / 197 |
| `cache-normal-2-1786603414972` | 1,436 / 1,729 | 0.4 / 278.1 | 75 | 131 / 188 |
| `refresh-normal-1-1786603578398` | 1,574 / 1,817 | 0.3 / 278.1 | 75 | 114 / 183 |
| `refresh-10s-1786603744536` | 1,221 / 1,424 | 0.0 / 185.4 | 75 | 123 / 180 |
| `refresh-normal-2-1786603904388` | 1,515 / 1,717 | 0.3 / 370.9 | 75 | 114 / 165 |

Across request-enabled runs:

```text
Request count:       1,200
Mean latency:        135.6 ms
Median latency:      126.5 ms
95th percentile:     208.6 ms
Maximum latency:     515.6 ms
Response bytes:      39,855 for every request
```

Across all process samples:

```text
Average RSS:         1,364.8 MiB
Maximum RSS:         1,882.5 MiB
Maximum high-water:  1,975.0 MiB
Linux `read_bytes` delta:   614.4 MiB
Linux `write_bytes` delta:  5,092.6 MiB
Linux `syscr` delta:        119,554,317
Linux `syscw` delta:        52,107
```

### 4.8 Bracket arithmetic

The table states only the arithmetic and the script predicates. A positive
`control mean - condition` value means the condition's measured CPU number was
lower than its two-control mean.

| Condition | Control 1 | Condition | Control 2 | Control mean | Control spread | Rule threshold | `isStable` | Control mean − condition | Relative arithmetic |
|---|---:|---:|---:|---:|---:|---:|:---:|---:|---:|
| Quiet | 67.703284 | 0.366663 | 77.236850 | 72.470067 | 9.533566 | 10.870510 | true | 72.103404 | 99.494% |
| Warm-only | 93.707168 | 27.193034 | 91.240983 | 92.474076 | 2.466185 | 13.871111 | true | 65.281041 | 70.594% |
| Automatic-title off | 91.240983 | 45.782261 | 65.747988 | 78.494486 | 25.492996 | 11.774173 | false | 32.712225 | 41.675% |
| Session-change sweep off | 65.747988 | 68.499318 | 74.439493 | 70.093740 | 8.691506 | 10.514061 | true | 1.594422 | 2.275% |
| GET stream off | 74.439493 | 45.862547 | 74.402421 | 74.420957 | 0.037072 | 11.163144 | true | 28.558410 | 38.374% |
| Cache writes off | 77.960355 | 80.452193 | 80.565603 | 79.262979 | 2.605248 | 11.889447 | true | -1.189214 | -1.500% |
| 10-second refresh | 75.517000 | 39.966251 | 73.988123 | 74.752562 | 1.528877 | 11.212884 | true | 34.786311 | 46.535% |

The 11 runs whose condition name contains a normal control had:

```text
Minimum CPU: 65.747988%
Maximum CPU: 93.707168%
Mean CPU:    77.500843%
Median CPU:  75.517000%
```

The seven condition deltas overlap in runtime work and are not components of a
single sum.

### 4.9 Refresh, source, sweep, and cache events

The following values are **transcribed from vanished Level 1 output**:

```text
Refresh starts:                624
Refresh finishes:              624
Source records:                2,496 (4 per refresh)
Refreshes reporting changes:   612
Initial indexed rows:          31,657
Final indexed rows:            31,830
Mean refresh duration:         1,931.9 ms
95th percentile refresh:       2,910.9 ms
Source elapsed total:          1,102,961 ms
Combined rebuild elapsed:      50,916 ms
Combined sort elapsed:         9,507 ms
```

Elapsed source records:

| Provider | Calls | Total elapsed | Mean | p95 | Parsed count | Row range |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 624 | 11.1 s | 17.8 ms | 28.0 ms | 180 | 1,462–1,466 |
| Codex | 624 | 72.5 s | 116.3 ms | 290.3 ms | 679 | 7,008–7,024 |
| OpenCode | 624 | 383.2 s | 614.1 ms | 1,263.6 ms | 349 | 1,231 |
| Amplifier | 624 | 636.2 s | 1,019.5 ms | 1,297.0 ms | 2,073 | 21,956–22,110 |

One OpenCode source event recorded 30,756 ms. Its containing refresh recorded
31,987 ms. Both occurred during `auto-title-off-1786602069542`.

Additional aggregate events:

```text
Automatic-title pass records:  1,209
Mean auto-title elapsed:        417.8 ms
Identity count on every pass:   0
Session-change sweep records:   1,207
Mean sweep-body elapsed:        0.27 ms
Identity count on every sweep:  0
Cache-save starts/finishes:     56 / 56
Cache-save failures:            0
Cache-save overlap:             0
Serialized total:               5,182.6 MiB
Per-save size:                  approximately 92.4–92.7 MiB
Mean save elapsed:              654.7 ms
Writes in cache-writes-off:     0.152 MiB
```

Source `duration_ms` fields are elapsed time inside an instrumented boundary. The
vanished schema did not record per-boundary CPU ticks.

### 4.10 Synthetic freshness records

These values are **transcribed from vanished Level 1 output**. Each mode added three
single-message synthetic Claude files and polled the isolated session-directory
endpoint every 100 ms until the visible count increased.

| Mode | Exact delay values, ms | Mean | Median | Range |
|---|---|---:|---:|---:|
| Normal TTL | 1,117.717103; 1,021.082601; 1,020.360119 | 1,053.053274 | 1,021.082601 | 1,020.360119–1,117.717103 |
| 10-second TTL | 7,725.936470; 10,070.586401; 10,073.860568 | 9,290.127813 | 10,070.586401 | 7,725.936470–10,073.860568 |

**[R] Arithmetic from the six [D] delay values:**

The unrounded means are 1,053.0532743333217 ms and 9,290.127813000077 ms.

```text
Mean difference: 8,237.074538666755 ms
Mean ratio:      8.822087200556469
Displayed ratio: 8.8221 (rounded to four decimal places)
```

### 4.11 Level 1 safety and provenance records

These values are **transcribed from vanished Level 1 output**:

```text
Production fingerprint checks:                 40
Verified scratch PID/listener stops:            20
Scratch already exited:                          0
Forced scratch kills:                            0
Invalid runs:                                    0
Private-tree checks:                            20
Cache-source regular-file checks:                1
Listener verifications:                         20
Authenticated requests:                      1,527
Authenticated requests before verification:      0
```

Of the authenticated requests, 1,200 were retained measurement requests; 327 were
startup and synthetic freshness requests.

The former manifest recorded:

```text
command:      run
commit:       225a91db3e4d48d4b6a7e8bc0987afad8ff31917
build_dirty:  true
binary hash:  72683921b800ade96edf58f39d80d8c08e5a6de5304e5c07c5f767a5ba363221
```

On 2026-08-16, the diagnostic binary remained at
`/home/dan/code/freshell/.worktrees/0gdd-measurement/target/release/freshell-server`
and its SHA-256 still matched the manifest value. The source worktree remains dirty
with the five diagnostic paths listed in Section 4.1.

### 4.12 Level 1 scope boundaries in the retained record

The vanished output did not include:

- host-wide CPU or load samples;
- child-process CPU attribution;
- function-level profiles;
- a run with live terminal identities (`identity_count` was zero in all relevant
  diagnostic events);
- a controlled, otherwise-identical idle-versus-active corpus pair;
- more than three synthetic freshness additions per mode;
- a clean-source build (`build_dirty` was true);
- a historical CPU series or first differing commit.

The `comparisons.json` file contained line-separated JSON objects despite its `.json`
suffix. The captured direct file read preserved 20 objects: 18 processor conditions
and two freshness summaries.

## 5. Temporary observer implementation and attempt chronology

The table below is the explicit evidence-tier declaration for every non-code claim
and table in each subsection unless an inline marker overrides it.

| Subsection | Default tier |
|---|---|
| 5.1 Source and verification status | [P] |
| 5.2 through 5.7 implementation behavior | [C] |
| 5.8 chronology overview | [P], except the `-05` row [A] |
| 5.9 pre-`-03` A | [P] for journal; [I] for launch-stage placement; [A] for controlled follow-up; [C] for later source state |
| 5.10 pre-`-03` B | [P] for journal; [A] for the controlled probe; [C] for later source state |
| 5.11 `-03` | [P] for report/events; [A] for run-era ingress and historical sequence; [C] for current source state |
| 5.12 `-04` | [P] for report/events; [A] for attempt-time CPU-clock implementation, later recalculation, and historical sequence; [C] for current source state |
| 5.13 `-05` | [A] for captured command/sample values; [C] for later source state |
| 5.14 `-06` | [P] for journal/handoff/files; [A], [I], or [C] only where marked |
| 5.15 `-07` | [P] |
| 5.16 `-08` | [P] |

### 5.1 Source and verification status

```text
Worktree: /home/dan/code/freshell/.worktrees/0gdd-observer
Branch:   investigation/0gdd-observer
Base:     225a91db3e4d48d4b6a7e8bc0987afad8ff31917
Source:   crates/freshell-sessions/examples/observer_0gdd.rs
Lines:    4,776
Bytes:    180,425
SHA-256:  4f63ec349e61745509afbd8d3481851e12cb6c21099547948ec81c84eea75a3f
Git state: exactly one untracked example directory/file
Commit:   none
```

Recorded checks for this source:

```text
Observer example tests:       58 passed, 0 failed
Full freshell-sessions crate:  299 passed, 1 ignored, 0 failed
cargo fmt --check --all:       exit 0
Clippy with -D warnings:       exit 0
Release example build:         exit 0
Ordinary synthetic smoke:      observer_complete
Signal cleanup smoke:          completed in a test-owned sandbox
```

The 58-test example suite was rerun on 2026-08-16 and again reported 58 passed,
0 failed.

### 5.2 Data read by the observer

The observer does not call `SessionIndex`. Its metadata scan builds a map keyed by a
run-local path ID. Each signature contains:

- provider;
- file size;
- mtime seconds and nanoseconds;
- ctime seconds and nanoseconds;
- device number;
- inode number.

Source: `observer_0gdd.rs:358-483`.

Qualified paths:

- Claude: JSONL files under the configured recursive root;
- Codex: JSONL files under the configured recursive root;
- Amplifier: `metadata.json`, `transcript.jsonl`, and `events.jsonl` under a path
  containing `sessions`;
- OpenCode: exact `opencode.db` and `opencode.db-wal` paths.

Source: `observer_0gdd.rs:385-422` and `observer_0gdd.rs:510-512`.

The scan uses metadata only. It does not parse session rows or read message/title
content.

### 5.3 Watch topology

The observer creates up to four `notify::RecommendedWatcher` instances:

- Claude root, recursive;
- Codex root, recursive;
- Amplifier root, recursive;
- nearest existing OpenCode database parent, non-recursive.

Source: `observer_0gdd.rs:2130-2152`.

Missing recursive roots are tracked by presence checks. A change in root presence
causes watcher re-creation and an immediate metadata reconciliation in the runtime
loop. Source: `observer_0gdd.rs:2870-2941`.

### 5.4 Ingress combining and bounds

The current callback maps each notice into one of:

```text
Error
(Create, raw path)
(Modify, raw path)
(Remove, raw path)
```

A mutex-protected map holds at most 8,192 distinct keys. A second notice with the
same key increments a raw counter instead of adding another map entry. The callback
also stores first and last monotonic times and increments a rapid-repeat counter
when two consecutive same-key arrivals are no more than 250 ms apart. A capacity-1
wake channel tells the main loop that a batch is available.

The main loop atomically swaps out the map before processing it. Source:
`observer_0gdd.rs:1894-2106`.

The evidence retains aggregate raw counts and aggregate rapid-repeat counts. It does
not retain raw paths or individual notices.

### 5.5 Metadata reconciliation and classification definitions

A startup scan occurs after watchers are armed. A periodic metadata scan is
scheduled every 900,000 ms. A final scan occurs during controlled finalization.
Source: `observer_0gdd.rs:2544-2595`, `observer_0gdd.rs:2812-2867`, and
`observer_0gdd.rs:2870-2931`.

`diff_inventory` compares two path-ID/signature maps:

- path ID only in new map: `added`;
- path ID in both maps with different signature: `modified`;
- path ID only in old map: `removed`.

Source: `observer_0gdd.rs:514-536`.

Notice/change compatibility is:

```text
added    ↔ create or modify
modified ↔ modify or create
removed  ↔ remove or modify
```

Source: `observer_0gdd.rs:765-774`.

The report classifications have these exact operational definitions:

- **matched**: at metadata reconciliation, an unconsumed compatible notice for the
  same provider and exact path ID already exists and its first time is no later
  than the reconciliation time;
- **delayed**: no compatible notice existed at reconciliation, the change entered a
  pending list, and a compatible notice arrived after the reconciliation time but
  within 60,000 ms;
- **missed**: a pending metadata change remained unmatched for more than 60,000 ms;
- **unresolved at shutdown**: a pending metadata change still existed when the
  report was assembled;
- **notice-only**: one unconsumed `(provider, exact path ID, notice kind)` aggregate
  remained when a reconciliation interval closed, plus any unconsumed aggregates
  still present at report time;
- **rapid repeat**: a same-provider, same-path-ID, same-kind notice followed the
  preceding one by no more than 250 ms, including across batch swaps.

Source: `observer_0gdd.rs:560-719`.

A `notice-only` unit is an aggregate key, not a raw notice. A metadata modification
is the difference between two periodic snapshots; multiple writes between scans
remain one modified path in that interval.

### 5.6 Per-minute path-appearance counter

`unique_ids` in a provider's report is not a global distinct-path count. Within each
minute bucket, a provider-local set counts a path ID once. The set is cleared when
the bucket is emitted. The report total is the sum of those per-bucket distinct-path
appearances. A path active in ten separate buckets contributes ten.

Source: `observer_0gdd.rs:998-1127`.

The output does not retain path IDs. The number of globally distinct paths that
produced notices over the day cannot be reconstructed from the aggregate files.
The inventory counts at scan boundaries are separate point-in-time distinct-path
counts.

### 5.7 Output schema and privacy behavior

Observer schema version is 1. `events.jsonl` contains:

- `watch_accounting`;
- `reconcile`;
- `start`;
- `bucket`;
- `stop`.

`state.json` is atomically replaced with cumulative state. `report.json` is written
at controlled finalization. Record construction is at
`observer_0gdd.rs:2462-2541`; output creation and private-file checks are at
`observer_0gdd.rs:1754-1855`.

Retained aggregate fields include counters, durations, resource samples, inventory
counts, run status, and production-guard counts. No retained schema field carries a
raw path, path ID, title, durable session ID, message, token, or request body.

### 5.8 Chronology overview

Times are UTC. Service starts/exits come from the user-systemd journal. Observation
times come from state/report records.

| Attempt | Service / command start | Observation start | End or last record | Status text / stop reason | Retained artifact |
|---|---|---|---|---|---|
| Pre-`-03` A | 2026-08-13 22:45:41 | none | 22:45:42 | exit 3, `production_exe` | none |
| Pre-`-03` B | 2026-08-13 23:08:21 | none | 23:08:49 | exit 2, `preflight_uninspectable` | none |
| `-03` | 2026-08-13 23:38:33 | 23:40:51.914424058 | 2026-08-14 01:01:49.942272060 | failed, `watcher_overflow` | `0gdd-observer-20260813-03` |
| `-04` | 2026-08-14 01:54:43 | 01:56:51.976848404 | 04:48:06.974658351 | failed, `resource_cpu` | `0gdd-observer-20260813-04` |
| `-05` host preflight | captured result at 2026-08-14 07:07:24.773 | none | elapsed not retained | exit 2, `preflight_uninspectable` | none; former empty root absent |
| `-06` | 2026-08-14 07:26:20 | none | 07:29:26 | exit 5, `post_arm_watches` | `0gdd-observer-20260814-06`, empty event file |
| `-07` | 2026-08-14 07:45:17 | 07:47:29.877079785 | last bucket 16:43:30.898763906; systemd stop 16:43:54 | no report; reboot boundary | `0gdd-observer-20260814-07` |
| `-08` | 2026-08-14 16:56:50 | 16:58:01.998217351 | 2026-08-15 16:58:40.024779323 | complete, `observation_complete` | `0gdd-observer-20260814-08` |

### 5.9 Pre-`-03` A

Journal record:

```text
start: 2026-08-13T22:45:41Z
exit:  2026-08-13T22:45:42Z
stderr/status text: production_exe
exit code: 3
```

**[I]** The `production_exe` label, launch order in source, and absence of run output
place the exit during production fingerprint capture before watcher setup.

**[A]** A controlled follow-up recorded `EACCES` while reading special links under
another process's `/proc` entry inside the filesystem sandbox. No run root or
observer output remains.

**[A] Historical sequence:** the campaign record places later source changes in this
area after the exit above.

**[C] Current source:** production fingerprint capture uses PID-file bytes,
PID/start ticks, bounded command-line bytes, UID/GID fields, metadata for the
absolute executable path in `argv[0]`, and listener address/port/inode values. It
does not read `/proc/<pid>/exe` or `/proc/<pid>/cwd`. Source:
`observer_0gdd.rs:1138-1215`.

### 5.10 Pre-`-03` B

Journal record:

```text
start: 2026-08-13T23:08:21Z
exit:  2026-08-13T23:08:49Z
stderr/status text: preflight_uninspectable
exit code: 2
systemd CPU time: 1.424 seconds
```

**[A]** A controlled probe in the same sandbox saw 308 same-UID processes and could
inspect file descriptors for one. It counted 307 as inaccessible. No probe output
file remains.

**[A] Historical sequence:** the campaign record places later source changes in this
area after the exit above.

**[C] Current source:** a host-side `preflight` command writes a private handoff
containing aggregate kernel/file-watch facts. Sandboxed `run` validates the handoff
and measures its own file-watch use. Current structures and checks:
`observer_0gdd.rs:785-889`, `observer_0gdd.rs:1563-1717`, and
`observer_0gdd.rs:2945-2953`.

### 5.11 Run `-03`

Report facts:

```text
Observation duration:       4,857,994 ms (80m 57.994s)
Buckets:                    76
Status:                     failed
Stop reason:                watcher_overflow
Raw notices:                341,869
Per-bucket path appearances:3,816
Rapid repeats:              317,108
Metadata changes:           1,245
Matched:                    1,036
Delayed:                    8
Missed:                     7
Unresolved at shutdown:     194
Notice-only aggregates:     281
Watcher errors:             1
Watcher overflows:          1
Watcher rearms:             1
Reconciliations:            8
Reconciliation total:       208,466 ms
Reconciliation maximum:     30,848 ms
Production checks:          90
Production mismatches:      0
Peak report CPU field:      6.476667%
Peak RSS:                   42,471,424 bytes
Peak file descriptors:      17
Peak threads:               5
Peak pending IDs:           353
Peak own watches:           27,006
```

Provider classification:

| Provider | Raw notices | Changes | Matched | Delayed | Missed | Notice-only |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 1 | 1 | 1 | 0 | 0 | 0 |
| Codex | 5,986 | 49 | 40 | 0 | 0 | 16 |
| Amplifier | 198,832 | 1,181 | 983 | 8 | 7 | 265 |
| OpenCode | 137,050 | 14 | 12 | 0 | 0 | 0 |

**[P]** The last retained bucket's provider event counts sum to 8,192. The report
records one overflow and one rearm.

**[A] Historical implementation record:** the run-era ingress was identified as the
pre-map implementation. The campaign record places the map implementation after
this run.

**[C] Current source:** the bounded same-kind/raw-path map and timing-aware
rapid-repeat counts are at `observer_0gdd.rs:1894-2106`.

### 5.12 Run `-04`

Report facts:

```text
Observation duration:       10,274,027 ms (2h 51m 14.027s)
Buckets:                    166
Status:                     failed
Stop reason:                resource_cpu
Raw notices:                658,933
Per-bucket path appearances:7,412
Rapid repeats:              610,586
Metadata changes:           1,895
Matched:                    1,868
Delayed:                    3
Missed:                     12
Unresolved at shutdown:     12
Notice-only aggregates:     556
Watcher errors:             0
Watcher overflows:          0
Watcher rearms:             0
Reconciliations:            13
Reconciliation total:       506,640 ms
Reconciliation maximum:     161,804 ms
Production checks:          190
Production mismatches:      0
Peak report CPU field:      7.136667%
Peak RSS:                   44,113,920 bytes
Peak file descriptors:      17
Peak threads:               5
Peak pending IDs:           329
Peak own watches:           27,528
```

Provider classification:

| Provider | Raw notices | Changes | Matched | Delayed | Missed | Notice-only |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 23 | 6 | 6 | 0 | 0 | 1 |
| Codex | 6,645 | 32 | 32 | 0 | 0 | 3 |
| Amplifier | 430,992 | 1,833 | 1,806 | 3 | 12 | 552 |
| OpenCode | 221,273 | 24 | 24 | 0 | 0 | 0 |

The retained tail records:

```text
periodic reconciliation: 161,804 ms
next bucket CPU field:    5.85%
shutdown reconciliation:  93,979 ms
final bucket CPU field:   7.136667%
```

**[A] Attempt-time implementation record:** the run-era source was recorded as
pairing current process CPU ticks with scheduled bucket boundaries. A later
recalculation, whose raw process-tick inputs are no longer retained, reported
3.1228% for the triggering window, approximately 3.55% for the final post-shutdown
window, and approximately 1.07% over the run through the triggering bucket. The
retained aggregate schema does not contain raw process tick values, so those three
recalculated values cannot be independently recomputed from the remaining JSONL.

**[A] Historical sequence:** the campaign record places later CPU-window and
software-stop changes after this run.

**[C] Current source:** CPU ticks are paired with actual monotonic sample times, and
the software stop counter requires two complete windows above 6%, separated by at
least one minute. Source: `observer_0gdd.rs:38-41`,
`observer_0gdd.rs:967-995`, and `observer_0gdd.rs:2765-2809`.

**[A] Captured transient-service property:** the service configuration for this
attempt recorded an external systemd CPU quota of 5%.

### 5.13 Attempt `-05`

**[A]** A captured host-preflight command result, without a retained primary output
file, records `2026-08-14T07:07:24.773Z`:

```text
exit code: 2
stderr: preflight_uninspectable
stdout: empty
```

The exact command start time, elapsed duration, and inaccessible-process list from
that command were not retained. No systemd observer service began, no host handoff
was written, and no `-05` evidence directory remains.

**[A]** A subsequent one-minute read-only sample saw four to seven inaccessible
same-user processes: three long-running processes and one to four dead Python
children.

**[A] Historical sequence:** the campaign record places later process-state
classification changes after this attempt.

**[C] Current source:** process state is read before and after file-descriptor
inspection, and `Z`, `X`, and `x` states are excluded from the inaccessible-live
count. Source: `observer_0gdd.rs:1352-1481`.

### 5.14 Run `-06`

Journal facts:

```text
service start:        2026-08-14T07:26:20Z
service ready record: 2026-08-14T07:26:21Z
exit text:            post_arm_watches
exit record:          2026-08-14T07:29:26Z
systemd CPU time:     9.354 seconds
```

The run root contains one zero-byte `events.jsonl` created at
`2026-08-14T07:27:17Z`. It contains no start, bucket, reconciliation, or stop record.
No state or report exists.

The host handoff at `2026-08-14T07:26:18.421193355Z` recorded:

```text
existing watches:       8,626
existing instances:     95
projected watches:      27,733
projected instances:    4
uninspectable processes:3
```

**[A] Prior source/diagnostic extract no longer independently reproducible:** the
attempt-time source was recorded as requiring equality between recursive-directory
projection and installed-watch count and retrying that comparison 40 times. A later
count recorded by the same prior analysis was 27,739. The intermediate count series
and attempt-time source snapshot were not retained as primary artifacts.

**[I]** The six-watch difference between the retained projection (27,733) and the
later reported count (27,739) does not identify what changed between measurements.
No retained artifact assigns the `post_arm_watches` exit to a specific directory
creation, deletion, race, or backend event.

**[C] Current source state:** current source retains an estimate and one actual
reading, records their difference, and checks numeric watch/instance ceilings
without equality. Source: `observer_0gdd.rs:2245-2323`.

### 5.15 Run `-07`

Journal and state facts:

```text
service start:               2026-08-14T07:45:17Z
observation start:           2026-08-14T07:47:29.877079785Z
last saved elapsed:          32,160,021 ms
complete minute buckets:     536
last bucket UTC:             2026-08-14T16:43:30.898763906Z
systemd stopping record:     2026-08-14T16:43:54Z
next journal entry:          a new WSL boot ID
final report:                absent
production checks:           607
production mismatches:       0
watcher errors/overflows/
rearms in latest state:      0 / 0 / 0
```

Latest-state aggregate counters:

```text
Raw notices:                 1,118,783
Per-bucket path appearances: 18,237
Rapid repeats:               1,005,595
Metadata changes:            4,342
Matched:                     4,208
Delayed:                     68
Missed:                      66
Notice-only aggregates:      963
Reconciliations:             36
Reconciliation total:        859,312 ms
Reconciliation maximum:      52,019 ms
Peak CPU field:              1.878968%
Peak RSS:                    44,351,488 bytes
Peak own watches:            28,396
```

Provider counters at the final saved minute:

| Provider | Raw notices | Changes | Matched | Delayed | Missed | Notice-only |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 1,001 | 23 | 23 | 0 | 0 | 1 |
| Codex | 19,925 | 175 | 173 | 1 | 1 | 109 |
| Amplifier | 938,129 | 4,074 | 3,942 | 67 | 65 | 853 |
| OpenCode | 159,728 | 70 | 70 | 0 | 0 | 0 |

`state.json` does not contain the report-only `unresolved_at_shutdown` field. Its
last resource sample reports 108 pending IDs, which is the union of current notice
and pending-change keys rather than a count of unresolved metadata changes alone.

**[A] Historical sequence:** the campaign record does not identify an observer
source change between the reboot interruption and the next run.

**[P]** Run `-08` used a new run root after boot.

### 5.16 Run `-08`

Run `-08` is detailed in Section 6. It has a final report with status `complete` and
stop reason `observation_complete`.

**[A] Historical sequence:** the campaign record identifies no observer source
change after the `-08` report within the observation campaign.

## 6. Completed 24-hour `-08` evidence

The table below is the explicit evidence-tier declaration for every non-code claim
and table in each subsection unless an inline marker overrides it.

| Subsection | Default tier |
|---|---|
| 6.1 Timing and record integrity | [P] |
| 6.2 Inventory start and end | [R], using [P] report/state inputs |
| 6.3 Notice type totals | [P] for counters; [R] for rates |
| 6.4 Per-minute distributions | [R], using [P] bucket records |
| 6.5 Hour-by-hour aggregates | [R], using [P] bucket records |
| 6.6 Classification totals | [P] for counters; [R] for formulas/fractions |
| 6.7 Reconciliation timing | [R], using [P] reconciliation records |
| 6.8 Process-resource distributions | [R] for distributions; [P] for emitted peaks/systemd fields |
| 6.9 Production and watcher counters | [P] |
| 6.10 Output size, permissions, hashes, and privacy scan | [P] |

### 6.1 Timing and record integrity

Evidence root:

```text
/home/dan/.local/state/freshell/0gdd-observer-20260814-08
```

Timing:

```text
Observation start:    2026-08-14T16:58:01.998217351Z
Observation duration: 86,400,000 ms
Report completion:    2026-08-15T16:58:40.024779323Z
Time after window:    approximately 38.027 seconds
Status:               complete
Stop reason:          observation_complete
```

Record counts:

```text
watch_accounting: 96
reconcile:        97
start:             1
bucket:         1,440
stop:              1
Total:          1,635
```

All 1,440 bucket sequence numbers from 1 through 1,440 exist exactly once. Every
bucket has `interval_ms:60000` and `partial:false`. JSON parsing, run IDs, timestamps,
record counts, and report/state aggregate totals were rechecked on 2026-08-16.

### 6.2 Inventory start and end

The startup reconciliation recorded 76,890 qualifying paths. Final state recorded
80,324. Per-provider startup counts below are derived from:

```text
start = final - added + removed
```

| Provider | Start | Added | Modified | Removed | End | Count arithmetic |
|---|---:|---:|---:|---:|---:|---|
| Claude | 1,235 | 6 | 13 | 3 | 1,238 | 1,235 + 6 − 3 = 1,238 |
| Codex | 7,230 | 104 | 180 | 0 | 7,334 | 7,230 + 104 = 7,334 |
| Amplifier | 68,423 | 3,330 | 4,274 | 3 | 71,750 | 68,423 + 3,330 − 3 = 71,750 |
| OpenCode | 2 | 0 | 191 | 0 | 2 | 2 + 0 − 0 = 2 |
| **Total** | **76,890** | **3,440** | **4,658** | **6** | **80,324** | **76,890 + 3,440 − 6 = 80,324** |

The metadata-change total is:

```text
3,440 added + 4,658 modified + 6 removed = 8,104
```

### 6.3 Notice type totals

| Provider | Create | Modify | Remove | Structural | Raw total | Rapid repeats | Per-bucket path appearances |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude | 6 | 719 | 3 | 41 | 769 | 400 | 43 |
| Codex | 103 | 66,816 | 0 | 1 | 66,920 | 46,562 | 2,104 |
| Amplifier | 1,784 | 1,930,628 | 3 | 50,579 | 1,982,994 | 1,809,444 | 30,137 |
| OpenCode | 0 | 950,957 | 0 | 27,268 | 978,225 | 896,084 | 2,316 |
| **Total** | **1,893** | **2,949,120** | **6** | **77,889** | **3,028,908** | **2,752,490** | **34,600** |

Arithmetic rates over 86,400 seconds:

```text
Raw notices per second:       35.056806
Raw notices per minute:       2,103.408333
Rapid-repeat fraction:        2,752,490 / 3,028,908 = 90.874005%
Raw notices per metadata
change:                       3,028,908 / 8,104 = 373.754689
```

Provider raw notices per metadata change:

```text
Claude:     34.954545
Codex:     235.633803
Amplifier: 260.680163
OpenCode: 5,121.596859
```

These ratios compare different counters: raw operating-system notices and net
signature differences at 15-minute snapshots.

### 6.4 Per-minute distributions

**[R] Distribution method used in Sections 6.4, 6.5, 6.7, and 6.8:**

- values are sorted ascending;
- the median uses Python `statistics.median`: the single middle value for an odd
  count and the arithmetic mean of the two middle values for an even count;
- p95 and p99 use nearest rank, at zero-based index `ceil(p * n) - 1`;
- means are arithmetic means;
- integer-displayed table values use Python `:.0f` formatting, which rounds to the
  nearest integer and uses ties-to-even for an exact half;
- three-decimal resource and hourly values use Python `:.3f`, also with ties-to-even
  at the displayed precision.

The per-minute table uses 1,440 complete buckets.

| Per-minute field | Minimum | Median | Mean | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|---:|---:|
| Raw notices | 36 | 1,856 | 2,103.41 | 4,781 | 6,281 | 13,743 |
| Rapid repeats | 0 | 1,668 | 1,911.45 | 4,472 | 5,838 | 13,424 |
| Distinct path appearances within bucket | 1 | 20 | 24.03 | 57 | 85 | 125 |
| Metadata changes | 0 | 0 | 5.63 | 44 | 138 | 243 |
| Matched classifications | 0 | 0 | 5.42 | 42 | 134 | 238 |
| Delayed classifications | 0 | 0 | 0.11 | 0 | 3 | 18 |
| Missed classifications | 0 | 0 | 0.10 | 0 | 3 | 12 |
| Notice-only aggregates | 0 | 0 | 1.42 | 8 | 36 | 83 |

Activity counts:

```text
Minutes with at least one raw notice:       1,440
Minutes recording metadata changes:            96
Minutes recording at least one miss:           36
```

Raw-notice distribution by provider:

| Provider | Active minutes | Minimum | Median | Mean | p95 | p99 | Maximum | Maximum bucket sequence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude | 24 | 0 | 0 | 0.53 | 0 | 1 | 166 | 867 |
| Codex | 1,059 | 0 | 16 | 46.47 | 74 | 1,014 | 3,138 | 612 |
| Amplifier | 1,356 | 0 | 1,146 | 1,377.08 | 3,420 | 4,883 | 5,937 | 376 |
| OpenCode | 1,440 | 16 | 518 | 679.32 | 1,810 | 3,307 | 12,055 | 869 |

Maximum aggregate buckets:

| Field | Sequence | UTC record time | Value |
|---|---:|---|---:|
| Raw notices | 869 | 2026-08-15T07:27:06.995061835Z | 13,743 |
| Rapid repeats | 869 | 2026-08-15T07:27:06.995061835Z | 13,424 |
| Per-bucket path appearances | 333 | 2026-08-14T22:31:04.996974932Z | 125 |
| Metadata changes | 360 | 2026-08-14T22:59:15.992497173Z | 243 |

### 6.5 Hour-by-hour aggregates

Each row contains 60 minute buckets beginning at the displayed UTC offset from the
observation start. `CPU mean` averages only complete five-minute CPU windows in that
hour.

| Hour | UTC start | Raw | Repeats | Path appearances | Changes | Matched | Delayed | Missed | Notice-only | CPU mean | CPU max |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 08-14 16:58 | 12,754 | 8,806 | 102 | 25 | 25 | 0 | 0 | 3 | 0.379% | 0.780% |
| 2 | 08-14 17:58 | 31,105 | 25,730 | 333 | 113 | 108 | 3 | 0 | 28 | 0.448% | 0.823% |
| 3 | 08-14 18:58 | 93,658 | 84,440 | 926 | 253 | 223 | 24 | 2 | 39 | 0.517% | 0.987% |
| 4 | 08-14 19:58 | 148,335 | 132,648 | 1,718 | 455 | 451 | 2 | 8 | 115 | 0.560% | 1.047% |
| 5 | 08-14 20:58 | 165,799 | 151,264 | 1,934 | 518 | 510 | 3 | 5 | 139 | 0.595% | 1.065% |
| 6 | 08-14 21:58 | 244,566 | 225,686 | 3,997 | 805 | 772 | 14 | 14 | 206 | 0.958% | 1.756% |
| 7 | 08-14 22:58 | 242,275 | 223,978 | 2,643 | 672 | 656 | 10 | 11 | 114 | 1.045% | 1.937% |
| 8 | 08-14 23:58 | 157,639 | 144,405 | 1,784 | 426 | 399 | 6 | 9 | 129 | 1.145% | 1.963% |
| 9 | 08-15 00:58 | 175,236 | 158,204 | 2,650 | 651 | 635 | 10 | 15 | 175 | 0.783% | 1.593% |
| 10 | 08-15 01:58 | 115,198 | 102,518 | 1,744 | 470 | 459 | 6 | 5 | 107 | 0.649% | 1.243% |
| 11 | 08-15 02:58 | 151,281 | 137,827 | 1,809 | 474 | 466 | 3 | 8 | 149 | 0.805% | 1.443% |
| 12 | 08-15 03:58 | 151,943 | 139,037 | 1,713 | 387 | 380 | 0 | 2 | 101 | 0.656% | 1.233% |
| 13 | 08-15 04:58 | 127,325 | 115,590 | 1,740 | 418 | 404 | 9 | 8 | 111 | 0.678% | 1.163% |
| 14 | 08-15 05:58 | 110,271 | 102,635 | 771 | 123 | 122 | 0 | 2 | 26 | 0.587% | 1.263% |
| 15 | 08-15 06:58 | 185,043 | 171,363 | 1,495 | 327 | 322 | 1 | 0 | 61 | 0.968% | 1.897% |
| 16 | 08-15 07:58 | 130,763 | 119,938 | 1,339 | 245 | 237 | 6 | 7 | 59 | 0.916% | 1.878% |
| 17 | 08-15 08:58 | 84,961 | 76,111 | 875 | 170 | 167 | 3 | 0 | 38 | 0.725% | 1.286% |
| 18 | 08-15 09:58 | 91,186 | 81,680 | 959 | 249 | 209 | 3 | 4 | 47 | 0.835% | 1.763% |
| 19 | 08-15 10:58 | 154,811 | 140,824 | 1,683 | 374 | 333 | 48 | 25 | 99 | 0.820% | 1.508% |
| 20 | 08-15 11:58 | 97,923 | 86,243 | 1,199 | 243 | 238 | 0 | 4 | 63 | 0.645% | 1.153% |
| 21 | 08-15 12:58 | 93,905 | 84,385 | 872 | 158 | 158 | 0 | 2 | 44 | 0.582% | 1.103% |
| 22 | 08-15 13:58 | 107,007 | 98,618 | 962 | 197 | 192 | 3 | 2 | 68 | 0.606% | 1.173% |
| 23 | 08-15 14:58 | 77,921 | 70,816 | 774 | 227 | 223 | 0 | 4 | 91 | 0.677% | 1.472% |
| 24 | 08-15 15:58 | 78,003 | 69,744 | 578 | 124 | 113 | 0 | 8 | 26 | 0.634% | 1.257% |

Delayed and missed classifications can appear in a later bucket than the metadata
change that created the pending entry. Hour-row fields are independent bucket sums,
not a per-hour partition of `changes`.

### 6.6 Classification totals and arithmetic

| Provider | Changes | Matched | Delayed | Missed | Unresolved | Notice-only |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 22 | 21 | 1 | 0 | 0 | 7 |
| Codex | 284 | 281 | 2 | 1 | 0 | 136 |
| Amplifier | 7,607 | 7,309 | 151 | 144 | 3 | 1,895 |
| OpenCode | 191 | 191 | 0 | 0 | 0 | 0 |
| **Total** | **8,104** | **7,802** | **154** | **145** | **3** | **2,038** |

Partition arithmetic:

```text
Fully classified = matched + delayed + missed
                 = 7,802 + 154 + 145
                 = 8,101

All metadata changes = fully classified + unresolved
                     = 8,101 + 3
                     = 8,104
```

Arithmetic fractions over 8,101 fully classified changes:

```text
Matched:                    7,802 / 8,101 = 96.309098%
Delayed:                      154 / 8,101 =  1.901000%
Missed:                       145 / 8,101 =  1.789902%
Matched plus delayed:       7,956 / 8,101 = 98.210098%
```

These are exact-path classifications under Section 5.5. They are not session-row
comparisons.

### 6.7 Metadata reconciliation timing

```text
Reconciliations:       97
Startup:                1
Periodic:              95
Shutdown:               1
Total duration: 2,214,064 ms
Minimum:           14,042 ms
Median:            21,022 ms
Mean:              22,825 ms
95th percentile:   35,005 ms
99th percentile:   40,998 ms
Maximum:           40,998 ms
Scan errors:             0
Ignored symlinks:        0 in retained reconciliation records
```

The nominal schedule has 96 15-minute boundaries in 24 hours. The record set has 95
periodic scans plus startup and shutdown.

### 6.8 Process-resource distributions

The observer calculates CPU across a trailing five-minute actual-time window. The
first four minute buckets did not contain a complete five-minute window. Across the
remaining 1,436 buckets:

```text
CPU minimum: 0.200%
CPU median:  0.598%
CPU mean:    0.718%
CPU p95:     1.508%
CPU p99:     1.783%
CPU maximum: 1.963%
```

RSS over all minute buckets:

```text
Minimum: 28.938 MiB
Median:  41.109 MiB
Mean:    41.195 MiB
p95:     44.359 MiB
p99:     48.609 MiB
Maximum: 51.109 MiB (53,592,064 bytes)
```

Other peaks from `report.json`:

```text
File descriptors:      17
Threads:                5
Pending correlation IDs:275
Output bytes before stop record/report: 2,162,110
Own watches:            29,817
Watcher instances:      4
Estimated global watches:33,192
Estimated global instances:48
Inaccessible processes: 2
```

Systemd recorded 10 minutes 0.392 seconds of process CPU time and an 81.7 MiB cgroup
memory peak. The report's RSS peak and systemd's cgroup memory peak use different
measurement sources.

### 6.9 Production and watcher counters

```text
Production identity/listener checks: 1,632
Production mismatches:                   0
Watcher errors:                          0
Watcher overflows:                       0
Watcher rearms:                          0
```

The startup host handoff recorded:

```text
created UTC:             2026-08-14T16:56:50.141079424Z
kernel max watches:      524,288
kernel max instances:    1,024
kernel max queued events:16,384
open-file limit:         65,536
existing watches:        3,375
existing instances:      44
projected observer watches:28,396
projected observer instances:4
aggregate accounting complete:false
inaccessible processes:  2
```

### 6.10 Output size, permissions, hashes, and privacy scan

Files:

| File | Bytes | Mode | SHA-256 |
|---|---:|---:|---|
| `events.jsonl` | 2,163,713 | `0600` | `846368a96adf75a4e99d1fc092eafd48765020d5a7cd0e63a8bbdf2d5454358a` |
| `report.json` | 2,694 | `0600` | `bac9da474ad062a2d68402be7f320b007b4546af4b92c49d74f98172f6c89fb9` |
| `state.json` | 2,517 | `0600` | `29c179c51b3a43f936f6a92ee5434a1b1a47bb3c6101b33f9dd9686f38b2b3b6` |
| **Total** | **2,168,924** | — | — |

The directory mode is `0700`; files are owned by the user, have one link, and are
regular files. Read-only scans on 2026-08-15 and 2026-08-16 found:

- no malformed JSON;
- no unexpected record type or schema version;
- no symlink or hard-linked evidence file;
- no path field or absolute-path value;
- no token, credential, title, message, durable session ID, request body, or header;
- no open file holder after completion;
- no remaining observer service process, cgroup process, or socket.

## 7. Side-by-side partial-run records

**Evidence tiers: [P] for retained emitted fields; [R] for the two repeat fractions;
[A] for run-era ingress/CPU-clock implementation statements and the later `-04`
recalculation. Current implementation statements, where present, are [C].**

Every row except the repeat fraction contains fields present in the retained final
reports for `-03` and `-04`. The repeat fraction is recomputed from each retained raw
notice and rapid-repeat pair.

| Field | `-03` | `-04` |
|---|---:|---:|
| Observation duration ms | 4,857,994 | 10,274,027 |
| Buckets | 76 | 166 |
| Stop reason | `watcher_overflow` | `resource_cpu` |
| Raw notices | 341,869 | 658,933 |
| Rapid repeats | 317,108 | 610,586 |
| Repeat fraction | 92.757% | 92.663% |
| Per-bucket path appearances | 3,816 | 7,412 |
| Metadata changes | 1,245 | 1,895 |
| Matched | 1,036 | 1,868 |
| Delayed | 8 | 3 |
| Missed | 7 | 12 |
| Unresolved at shutdown | 194 | 12 |
| Notice-only aggregates | 281 | 556 |
| Watcher errors | 1 | 0 |
| Watcher overflows | 1 | 0 |
| Watcher rearms | 1 | 0 |
| Reconciliations | 8 | 13 |
| Reconciliation total ms | 208,466 | 506,640 |
| Reconciliation max ms | 30,848 | 161,804 |
| Production checks | 90 | 190 |
| Production mismatches | 0 | 0 |
| Recorded peak CPU field | 6.476667% | 7.136667% |
| Peak RSS bytes | 42,471,424 | 44,113,920 |
| Peak FDs | 17 | 17 |
| Peak threads | 5 | 5 |
| Peak pending IDs | 353 | 329 |
| Peak own watches | 27,006 | 27,528 |
| Peak global watches | 36,384 | 37,185 |
| Peak global instances | 101 | 102 |
| Inaccessible processes | 7 | 5 |

Recorded limitations by run:

- **[P]** `-03` emitted `watcher_overflow`, one overflow, and one rearm; its final
  resource and stop records occur after the last ordinary bucket.
- **[A]** The historical implementation record identifies `-03` as using pre-map
  ingress.
- **[P]** `-04` emitted zero watcher overflows.
- **[A]** The historical implementation record identifies `-04` as using the
  callback map and pairing CPU ticks with scheduled bucket time. The [A]
  recalculation with no retained raw tick inputs is stated in Section 5.12.
- **[A]** The run-era implementation record identifies both runs as using exact-path
  metadata signatures, 15-minute reconciliations, and a 60-second late-notice
  allowance.
- **[R]** Their retained durations are both less than 24 hours.

## 8. Observed edge cases and adjacent facts

The table below is the explicit evidence-tier declaration for every non-code claim
and table in each subsection unless an inline marker overrides it.

| Subsection | Default tier |
|---|---|
| 8.1 Event volume | [P] |
| 8.2 Watch-accounting values | [P] for retained fields; [A]/[I] only where marked |
| 8.3 systemd `/proc` visibility | [P] for exit labels; [A] for controlled-probe counts |
| 8.4 Dead-process accounting | [A] |
| 8.5 Reboot boundary | [P] |
| 8.6 Provider row retention | [C] |
| 8.7 Visible/native-title counts | [A] for counts; [C] for overlay behavior |
| 8.8 Anonymous adjacent tracking metadata | [P] |

### 8.1 Event volume and repeated events

The callback observed multiple notices for the same path/kind key. Run `-08`
recorded 3,028,908 raw notices and 2,752,490 arrivals within 250 ms of the preceding
same-key arrival. Every minute contained at least 36 raw notices. Maximum minute
volume was 13,743.

### 8.2 Watch-accounting values around `-06`

**[P] Retained fields:** the host handoff projected 27,733 observer watches and four
instances. The service journal recorded `post_arm_watches`, exit status 5, and 9.354
seconds of CPU time. The run root contains a zero-byte event file and no state or
report.

**[A] Prior numeric extract:** a later equivalent count was recorded as 27,739. The
intermediate count sequence and attempt-time source snapshot are absent.

**[I]** The six-count difference does not identify a mechanism. No retained primary
artifact attributes the exit label to directory creation, deletion, watcher
installation timing, or another event.

### 8.3 Systemd `/proc` visibility

**[A] Controlled-probe extracts with no retained probe output file:**

Under `ProtectSystem=strict` plus `ProtectHome=read-only`, the observer's user
namespace could read another process's `stat`, `status`, and command-line bytes but
received `EACCES` when following that process's special `/proc/<pid>/exe` and
`/proc/<pid>/cwd` links.

A same-sandbox process survey saw 307 of 308 same-UID processes as inaccessible for
file-descriptor-link inspection. A user-systemd probe without those filesystem
sandbox properties saw 299 inspectable and 7 inaccessible processes, 12,696 known
watches, and 112 known instances at that probe time.

### 8.4 Dead-process accounting

A later one-minute sample saw four to seven inaccessible same-UID processes. Three
were long-running; the remaining one to four were dead Python children waiting for
parent collection. The failed `-05` command retained only the aggregate exit text,
not the exact process list at failure time.

### 8.5 Reboot boundary

Run `-07` has no stop or report record. Its final event is bucket 536 at
`2026-08-14T16:43:30.898763906Z`. The user journal records systemd stopping the unit
at `16:43:54Z`, followed by a new WSL boot ID. Run `-08` used a new user-systemd
manager PID, new production PID, new preflight handoff, and new output root.

### 8.6 Provider row retention on read failures

At the investigated revision:

- an OpenCode direct health/list failure records a provider failure and keeps the
  prior direct-cache vector;
- a Claude, Codex, or Amplifier root-list failure records a provider failure, uses
  an empty discovered list for that source, and the common prune removes file-cache
  entries not rediscovered in that refresh.

Source: `crates/freshell-sessions/src/directory_index.rs:1304-1409`.

### 8.7 Visible-title collision adjacent to row comparison

A separate read-only investigation sampled 1,000 consecutive sidebar rows, including
556 OpenCode rows. It found:

```text
Repeated provider/session IDs: 0
Overlapping IDs across pages:   0
Largest same-visible-title group:
  durable OpenCode rows:        35
  distinct provider IDs:        35
  distinct native titles:       35
  saved Freshell title values:   1 shared override
```

The database rows were unique. At the investigated revision, the session-directory
handler overlays a nonempty saved `titleOverride` onto the provider title for most
title-source values at
`crates/freshell-server/src/session_directory.rs:736-778`.

In the sampled stored data, displayed title strings and provider-native title
strings were separate observed fields. No actual title or ID is included here.

### 8.8 Anonymous adjacent tracking metadata

**[P] Metadata-only fields observed on 2026-08-16:**

- a separate open request-side work item existed;
- its recorded implementation progress was 0 of 7;
- another open work item had a blocking relation to it.

No identifier, title, priority, body, comment, worktree path, branch name, commit
identifier, command, proposed approach, or acceptance criterion for either item is
included in this packet.

## 9. Artifact map and read-only reproduction commands

**Default evidence tier for retained-path/hash/status claims in Section 9: [P].
Command behavior stated from source is [C].**

### 9.1 Retained artifact paths

Level 1 source:

```text
/home/dan/code/freshell/.worktrees/0gdd-measurement/
  crates/freshell-server/src/auto_title_sweep.rs
  crates/freshell-server/src/main.rs
  crates/freshell-sessions/src/directory_index.rs
  scripts/measure-0gdd-level1.ts
  test/unit/scripts/measure-0gdd-level1.test.ts
```

Observer source:

```text
/home/dan/code/freshell/.worktrees/0gdd-observer/
  crates/freshell-sessions/examples/observer_0gdd.rs
```

Observer evidence:

```text
/home/dan/.local/state/freshell/0gdd-observer-20260813-03/
/home/dan/.local/state/freshell/0gdd-observer-20260813-04/
/home/dan/.local/state/freshell/0gdd-observer-20260814-06/
/home/dan/.local/state/freshell/0gdd-observer-20260814-07/
/home/dan/.local/state/freshell/0gdd-observer-20260814-08/
```

Host handoffs:

```text
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260813T233832Z.json
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T015442Z.json
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T072617Z.json
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T074515Z.json
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T165650Z.json
```

Missing Level 1 output:

```text
/tmp/freshell-0gdd-output-1130474-ycH6V9
```

That path is absent. Commands that name files below it cannot currently reproduce a
read.

### 9.2 Retained observer hashes

```text
# -03
ef141338716fbe68c2b6fb1a8a515fb574ddb96ca7ce3105819880bf6e6e0fd2  events.jsonl
d1be175206b039a9d87b9bb9be2ad68e1970a61a472e36111ff2fb82f36f81b8  report.json
b9d1a4bcb26fff0df575a9387cee81286292d62f97b043249aad0a25d528f3da  state.json

# -04
94e2c6766147dbe0ca91a1d43bd62f1c5346f2ac05e9a8c8681819ad7f7b1b22  events.jsonl
65f9848476d78abf47af1e05015fe87bab096a934bc31d78d3eb9e4788c5fcb9  report.json
a2e616a61cc64ed82c2e0dec90f07d5173104b552b7b315b668a25639a2486de  state.json

# -06
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  events.jsonl

# -07
6af3de14fa900d5b825998436780b7c70ab4fc3921c582c551e6658e0d29c8b5  events.jsonl
0e7e95db6678fedbbc6c5193dfc834bd310571829188c04cff24a6e84a97069e  state.json

# -08
846368a96adf75a4e99d1fc092eafd48765020d5a7cd0e63a8bbdf2d5454358a  events.jsonl
bac9da474ad062a2d68402be7f320b007b4546af4b92c49d74f98172f6c89fb9  report.json
29c179c51b3a43f936f6a92ee5434a1b1a47bb3c6101b33f9dd9686f38b2b3b6  state.json
```

Preflight hashes:

```text
05c99f054979e1491c7cc4f49694528fe939f6b43aa78b64eac2d6c6f786085a  ...20260813T233832Z.json
6ec300f51440e49f91b9ddab6d00bfc915f1feea4b414a0b6a9a8796e8f8ef43  ...20260814T015442Z.json
b9c4c1105aef83ef4ae34200eb119c78ec4526714530ef772dde2128ac88fe0f  ...20260814T072617Z.json
cf993c17509597b5b9e0fbe31f3e03385cecf9e676aa15eb7f79d18cffe10f05  ...20260814T074515Z.json
4228a725c829578acffefbcca9792a3b9051c6e40a572658c7c31dae3873ecef  ...20260814T165650Z.json
```

### 9.3 Read-only evidence commands

Final report summary:

```bash
jq '{status, stop_reason, start_utc, complete_utc, duration_ms,
     bucket_count, production_guard_checks, production_guard_mismatches,
     correlation, stats}' \
  /home/dan/.local/state/freshell/0gdd-observer-20260814-08/report.json
```

Record counts:

```bash
jq -r '.record_type' \
  /home/dan/.local/state/freshell/0gdd-observer-20260814-08/events.jsonl \
  | sort | uniq -c
```

Final hashes:

```bash
sha256sum /home/dan/.local/state/freshell/0gdd-observer-20260814-08/*
```

Permissions and sizes:

```bash
stat -c '%n %F mode=%a links=%h size=%s owner=%U:%G' \
  /home/dan/.local/state/freshell/0gdd-observer-20260814-08 \
  /home/dan/.local/state/freshell/0gdd-observer-20260814-08/*
```

Current source/worktree states:

```bash
git -C /home/dan/code/freshell/.worktrees/0gdd-measurement status --short --branch
git -C /home/dan/code/freshell/.worktrees/0gdd-observer status --short --branch
git -C /home/dan/code/freshell/.worktrees/0gdd-handoff status --short --branch
```

Production identity without an HTTP request:

```bash
pid="$(tr -d '\n' < "$HOME/.freshell/rust-server-3001.pid")"
ps -p "$pid" -o pid=,lstart=,etime=,stat=,%cpu=,rss=,nlwp=,args=
readlink -f "/proc/$pid/exe"
readlink -f "/proc/$pid/cwd"
ss -ltnp | awk -v p="$pid" '$4 ~ /:3001$/ && $0 ~ ("pid=" p ",") {print}'
```

User-service history without starting or stopping a unit:

```bash
journalctl --user -u freshell-0gdd-observer.service \
  --since '2026-08-13 20:00:00 UTC' \
  --until '2026-08-15 18:00:00 UTC' \
  --output=short-iso --no-pager
```

### 9.4 Focused source verification commands

Measurement harness tests:

```bash
cd /home/dan/code/freshell/.worktrees/0gdd-measurement
npm run test:vitest -- run test/unit/scripts/measure-0gdd-level1.test.ts
```

Observer example tests:

```bash
cd /home/dan/code/freshell/.worktrees/0gdd-observer
cargo test -p freshell-sessions --example observer_0gdd
```

Recorded source checks:

```bash
cd /home/dan/code/freshell/.worktrees/0gdd-observer
cargo fmt --check --all
cargo clippy -p freshell-sessions --example observer_0gdd -- -D warnings
cargo build --release -p freshell-sessions --example observer_0gdd
```

Synthetic observer smoke using only a temporary fixture tree:

```bash
cd /home/dan/code/freshell/.worktrees/0gdd-observer
RUN_ROOT="$(mktemp -d)"
chmod 700 "$RUN_ROOT"
target/release/examples/observer_0gdd smoke --run-root "$RUN_ROOT"
```

None of the commands in Sections 9.3–9.4 restarts production or writes provider
storage. The test/build commands can write ignored build outputs inside their
worktrees and temporary fixture/output roots.

## 10. Evidence-selection audit and measurements not present

### 10.1 Counterevidence and boundary inventory included in this packet

| Tier | Included item |
|---|---|
| [C] | The existing Node watcher/indexer and 150 ms synchronization service, including the Node indexer's 10-minute default full scan |
| [C]/[P] | The exported Rust watcher/indexer module, its real-watcher test construction, and the text-search result that did not find Rust-server construction at the pinned revision |
| [D]/[R] | All 18 final Level 1 processor runs, including the GET-disabled complete work set, bracket control spread, and the automatic-title bracket whose `isStable` value was false |
| [A] | Aggregate Level 1 refresh/source/cache values whose raw run streams disappeared after reboot |
| [P]/[A] | Both finalized partial observer runs, both pre-`-03` exits, `-05`, `-06`, reboot-interrupted `-07`, and complete `-08` |
| [P] | Zero watcher errors/overflows in `-08` alongside nonzero exact-path misses and notice-only aggregates |
| [P]/[R] | Raw notice volume in every minute, periodic metadata-scan duration, resource distributions, and provider-specific sample sizes |
| [C] | Different OpenCode and file-backed row-retention behavior during source-read failures |
| [A]/[C] | Stored display-title/native-title divergence counts and the title-overlay code path |
| [P] | Anonymous metadata records a separate open request-side work item with 0-of-7 implementation progress and a blocking relation from another open item |
| [C]/[P] | Shared WSL/kernel/storage/page-cache boundaries and the absence of a Level 1 mount-enforced provider read-only boundary |

No counterexample in this table is treated as a selected future behavior.

### 10.2 Unknowns and absent measurements

The table below maps every numbered item to its evidence tier. [P] means the retained
schema/output lacks the named field or run; [A] means the absence is known only from
the pre-reboot aggregate record; [I] marks a stated possibility rather than an
emitted classification.

| Items | Tier |
|---|---|
| 1–4 | [P] |
| 5–6 | [I], bounded by [P] aggregate schema |
| 7–9 | [P] |
| 10 | [P] |
| 11–17 | [A] or [D] matching their Level 1 source tier |
| 18–19 | [P] |
| 20 | [I], bounded by [P] zero recorded-overflow count |
| 21–22 | [P] |
| 23 | [I], based on [C] observer/product scope separation |
| 24 | [P] |
| 25 | [A]/[C] |
| 26 | [P]/[C] |

1. **Session-row equivalence:** No retained run maintained a notice-updated parsed
   session list and compared it field-by-field with a full-scan parsed list.

2. **Displayed-row equivalence:** No observer output contains sidebar rows,
   presentation overlays, cursor pages, or project groups.

3. **Actual UI update delay from a file notice:** The observer recorded callback and
   reconciliation counters, not the time from provider write to a browser-rendered
   row.

4. **One notice per provider write:** Operating-system notices were not paired with
   provider write syscalls. The evidence has aggregate notices and periodic net
   metadata differences.

5. **Changes that revert between reconciliations:** A file can change and return to
   the same retained signature before the next scan. Such a sequence is not present
   in the metadata diff.

6. **Meaning of notice-only aggregates:** A notice-only aggregate can represent a
   metadata-neutral operation, a transient change that reverted, a non-qualifying
   structural event, a timing-boundary case, or another unmeasured sequence. The
   aggregate schema does not distinguish these cases.

7. **Amplifier sibling-file grouping:** The 144 Amplifier exact-path misses in `-08`
   were not reclassified by session directory. The output does not retain path IDs,
   so that reclassification cannot be performed from the aggregate files.

8. **Globally distinct notice paths:** The observer retained per-minute path
   appearances and point-in-time inventory counts. It did not retain a run-wide set
   of notice path IDs.

9. **Provider file roles:** The observer treated three Amplifier filenames as
   independent exact paths. It did not record whether a sibling notice preceded a
   metadata-row change. OpenCode DB and WAL notices were counted separately by kind
   internally but only provider aggregates remain.

10. **Function-level CPU attribution:** No retained `perf`, tokio-console, stack
    sample, or per-function CPU profile exists.

11. **Child-process CPU:** Level 1 sampled the scratch server process. CPU from any
    child process was not added to that process's tick count.

12. **Host activity:** Level 1 did not retain host-wide CPU, disk queue, WSL VM load,
    or competing-process counters.

13. **True idle comparison:** The corpus changed during 612 of 624 Level 1 refreshes.
    No otherwise-identical interval with provider activity held constant exists.

14. **Automatic-title behavior with live identities:** Every retained Level 1
    automatic-title and session-sweep event had `identity_count:0`.

15. **Historical CPU series:** No long-term process CPU record or first differing
    source revision was captured.

16. **Clean diagnostic build:** The Level 1 manifest says `build_dirty:true`. The
    hash-matching diagnostic binary remained present on 2026-08-16; no clean-source
    Level 1 result was retained.

17. **Freshness sample size:** The Level 1 synthetic freshness result contains three
    additions per mode.

18. **Platform and filesystem portability:** The retained observer run covers WSL2
    Linux storage on one machine. No equivalent run exists for native Windows,
    macOS, `/mnt/c`, a network filesystem, a container, or a separate VM.

19. **Suspend/resume without reboot:** Run `-07` ended at reboot. No retained run
    isolates WSL suspend/resume while preserving the same process and boot ID.

20. **Watcher queue loss below the observer's aggregate overflow flag:** The
    observer saw zero reported watcher errors/overflows in `-08`. The retained
    output has no independent operating-system sequence number with which to detect
    an unreported kernel/backend loss.

21. **Targeted parse behavior during partial writes:** No observer run parsed an
    actively written provider record as a notice-driven update.

22. **Ordering between overlapping targeted work and full reconciliation:** The
    observer did metadata comparison only; it did not publish two competing parsed
    snapshots.

23. **Production integration resource use:** The observer did metadata-only scanning
    and aggregation outside the server. No retained measurement includes parser,
    cache, HTTP, automatic-title, and watcher work in one changed production binary.

24. **Alternative reconciliation intervals:** Observer runs used 15 minutes. Level 1
    compared one-second and ten-second TTLs. No retained run used other full-metadata
    reconciliation intervals.

25. **Visible title as a provider-native field:** Current saved overrides can replace
    provider-native titles. The sanitized 35-row collision count records this for
    one OpenCode group; no full-corpus native-versus-display-title comparison was
    retained.

26. **Current-main behavior after 14 later commits:** Detailed source tracing in this
    document targets `225a91db3…`. Main was `e35adfbb…` at assembly time. This file
    does not enumerate semantic differences across those 14 commits.
