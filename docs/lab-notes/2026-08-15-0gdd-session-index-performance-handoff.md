# Kata 0gdd: Session-Index CPU Investigation and Observer Handoff

**Date:** 2026-08-15

**Status:** Investigation complete through the first 24-hour file-notice
observation; implementation paused before any production performance change

**Repository status:** Maintained on dedicated local branch `docs/0gdd-handoff`
in worktree `/home/dan/code/freshell/.worktrees/0gdd-handoff`. Publication via a
push or PR remains approval-gated.

**Existing Kata:** `freshell#0gdd` / UID `01KZRW1HFB77ZQZJ6F1PJB0GDD`

**Naming-scope follow-up Kata:** `freshell#b5fb` / UID
`01M03BWS22XRB6CCN7HTP7B5FB`

**Main source revision investigated:**
`225a91db3e4d48d4b6a7e8bc0987afad8ff31917`

**Production deployment changed by this work:** No

> Privacy note: this handoff deliberately omits real session titles, session IDs,
> prompts, tokens, provider-file paths below the documented roots, and message
> content. Counts and timings are retained because they are the evidence.

## Executive summary

Kata `0gdd` reported that the Rust Freshell server continuously consumed roughly
half of one CPU core and suspected a browser request made every two seconds. The
CPU problem is real, but the original explanation was incomplete:

1. The browser is not independently polling on a two-second timer. The Rust
   server performs a two-second session sweep, broadcasts `sessions.changed`, and
   the browser refreshes its visible session window in response.
2. A normal session-directory request is wasteful—it processes the full cached
   session set to return a small page—but requests alone cannot explain the full
   baseline.
3. The largest measured cost is repeatedly refreshing the shared session index.
   Every refresh rediscovers and metadata-checks roughly 30,500 source files even
   though only about five files usually require reparsing.
4. The Level 1 experiment measured a 65.28-percentage-point reduction when
   ongoing refreshes stopped after warm-up, a 34.79-point reduction when refresh
   cadence changed to ten seconds, and a 28.56-point upper-bound reduction when
   browser-style requests stopped. These effects overlap and must not be added.
5. A standalone, read-only file-notice observer then ran for exactly 24 hours.
   It saw 8,104 actual file-state changes. Of 8,101 changes with enough time to
   classify, 7,956 had a matching notice (98.21%) and 145 did not. Amplifier
   accounted for 144 of the 145 exact-path misses.
6. File notices were cheap to observe—0.72% of one core on average and 1.96% at
   peak—but extremely noisy: 3,028,908 raw notices, of which 2,752,490 (90.87%)
   were rapid repeats. Any replacement must combine repeats before doing work.
7. Exact-path notice coverage is not the same as correct sidebar rows. Amplifier
   represents one durable session with several files in one session directory;
   a notice on a sibling file may be sufficient to rebuild the correct session.
   The next prototype must compare parsed session rows, not individual paths.

The current decision is **not** to ship a watcher yet and **not** to start another
large passive study. The temporary observer should become an iterative replacement
prototype: build the candidate session list with the real parsers, compare it with
the current full-scan result, stop on the first unexplained row difference, preserve
a small private diagnostic window, root-cause and fix that one discrepancy, and
repeat. Run lengths should grow from minutes to one hour, four hours, and finally
24 hours only after each shorter rung converges.

A newly confirmed naming-scope bug must be addressed before visible titles can be
used as a correctness oracle. Pane and tab organization labels are currently
persisted as durable session-title overrides. That has made many distinct OpenCode
conversations appear identical in the left sidebar even though their IDs and
histories remain distinct. The bug is tracked separately because it concerns name
ownership and lifetime, not index refresh performance.

## 1. Scope, constraints, and current decision

### 1.1 Original question

`freshell#0gdd` was created on 2026-08-11 with the title:

> Investigate freshell-server chronic ~50%-of-a-core CPU baseline
> (session-directory polling suspect)

The issue reported a chronic 43–56% one-core baseline and pointed to
`GET /api/session-directory?priority=visible&limit=50`, observed roughly every two
seconds at 100–150 ms per request. It asked whether `SessionIndex` work should be
cached, combined, or push-driven and mentioned ETags/delta responses as possible
options.

The investigation later measured 78–79% of one core in controlled windows, so the
original 43–56% observation was valid but not an upper bound.

Two parts of the original report remain unresolved rather than proved:

- **True load independence was not established.** The baseline persisted across
  different observed uptimes and ordinary activity levels, but the investigation
  did not produce a controlled idle/no-client comparison against an otherwise
  identical active interval.
- **“Not a regression” was plausible, not demonstrated.** Similar behavior was
  seen before and after a server restart, but there is no historical CPU series
  and no first-bad commit or release boundary. Treat the chronic-versus-regression
  boundary as unknown.

### 1.2 User constraints that governed this work

The following constraints remain binding unless the user explicitly changes them:

- Run **Level 1 only**: native WSL processes, not a container or VM.
- Gather data through recommendations, then pause before a production fix.
- Do not restart, stop, signal, or reconfigure the live Freshell server.
- A live production-server restart requires the literal user approval
  **`APPROVED`**.
- Do not open a PR without explicit approval.
- Prefer plain-language reporting; explain technical terms rather than relying on
  jargon.
- Keep private session data out of reports and retained evidence.
- Use exact process ownership checks; never use broad kill patterns.

A container or VM was deliberately rejected for the primary experiment because it
would share or distort the resource and filesystem behavior under investigation.
Nearby before/after comparisons in the same WSL environment were more relevant
than an artificially quiet machine.

### 1.3 Current technical decision

The supported direction is a **hybrid in-process session index**:

- File notices trigger prompt, provider-scoped candidate updates.
- Provider storage remains authoritative.
- A slower full repair scan detects notices that were missed, watcher overflow,
  suspend/resume gaps, newly created roots, and ordering mistakes.
- Browser requests read an already-prepared shared snapshot and do not initiate a
  provider scan.
- Repeated notices are combined before any parse or refresh work is scheduled.

This is a direction to prove through the temporary prototype, not authorization to
change production.

### 1.4 User correction: iterate, do not over-rotate on science

After the first 24-hour observer run, the proposed next step was another broad
72-hour observation. The user correctly rejected that framing. The investigation
had already shown that notices were useful and had identified the main gap. The
next work must improve the candidate implementation rather than repeatedly measure
an unchanged observer.

The agreed loop is:

1. Build the real candidate session list with existing Freshell parsers.
2. Compare candidate rows with the current full-scan rows.
3. Stop on the first unexplained difference.
4. Preserve only the short, private evidence needed to explain it.
5. Fix one cause.
6. Rerun immediately.
7. Increase run duration only after convergence.

The full scan is the development/reference path and eventual repair path. The goal
is not to build and operate two permanent equal systems.

### 1.5 No permanent ghost process

The observer is a temporary diagnostic executable. It was run as a named,
resource-bounded transient user service with `Restart=no` and a fixed lifetime.
The completed service and process are gone; private reports and retained
owner-only preflight handoff evidence remain.

The intended production design does **not** include a permanent companion daemon.
Once the prototype is correct, the proven coordination logic should replace the
high-frequency polling inside the existing Rust sessions subsystem. A repair path
remains in-process. The temporary example must not be merged as production code.

## 2. Existing system and measured causal path

### 2.1 Current flow

```text
Provider files / OpenCode database
             |
             v
SessionIndex refresh
  - rediscover all file-backed sessions
  - stat every discovered file
  - parse only changed files
  - re-query OpenCode when its change token moves
  - rebuild and sort the complete shared snapshot
             |
             +------------------------------+
             |                              |
             v                              v
2-second sessions sweep             2-second auto-title sweep
compares a broad signature           consumes the same snapshot
             |                              |
             +--------------+---------------+
                            |
                    sessions.changed
                            |
                            v
browser fetches visible page
(handler still decorates/filters/sorts broadly)
```

Production constructs a single four-provider `SessionIndex` at
`crates/freshell-server/src/main.rs:679-693`. At startup it warms the index and
starts both two-second loops at `crates/freshell-server/src/main.rs:1220-1270`.
The sweep cadence is declared at `crates/freshell-server/src/main.rs:2387-2393`,
and the periodic refresh/broadcast loop is at
`crates/freshell-server/src/main.rs:2521-2579`.

The index provides stale-while-refreshing snapshots at
`crates/freshell-sessions/src/directory_index.rs:938-993`, starts detached warm
refreshes at `crates/freshell-sessions/src/directory_index.rs:1060-1083`, and
performs the incremental refresh at
`crates/freshell-sessions/src/directory_index.rs:1267-1423`. “Incremental” means
unchanged files are not reparsed; it does **not** mean unchanged files are skipped.
Each refresh still rediscovers and metadata-checks the complete corpus.

The auto-title pass is bounded to live matching terminals for its title decisions,
but the loop still maps the entire snapshot every two seconds before that matching:
`crates/freshell-server/src/auto_title_sweep.rs:507-549`. Its title work is at
`crates/freshell-server/src/auto_title_sweep.rs:295-412`.

### 2.2 Why the original “browser polls every two seconds” account was wrong

The request cadence was real—about one request every 1.99 seconds during the
initial observation—but the browser timer was not the source. The server's
2-second loop calls `snapshot()`, detects a changed signature, and sends
`sessions.changed`; the client then refetches. This distinction matters because
eliminating the HTTP handler cannot eliminate the server-side refresh that caused
the notification.

### 2.3 Why page bounding alone is insufficient

The current endpoint returns a bounded page, but the common path still does broad
in-memory response work before truncating. Page-bounding that work remains useful.
It cannot remove the repeated provider discovery/stat/database work that dominated
Level 1.

A separate clean worktree contains an 8,289-line page-bounding implementation plan:

`docs/plans/2026-08-11-session-directory-page-bound.md`

The plan's core page-selection algorithm may be reusable, but the plan is too large
for its likely benefit and should not be executed as written. It also cannot close
`0gdd` by itself.

Separate, narrower request-side work is tracked by `freshell#k68e`, “Resume
page-bounded session list after shared cloud runner lands.” It must not be
conflated with either the rejected 8,289-line plan or the watcher/index work in
this handoff:

- Scope: lazily prepare the ordinary no-search response page so at most
  `limit + 1` lightweight selected records and at most `limit` full response rows
  are prepared, while preserving full-corpus search, ordering, cursors, totals,
  revisions, partial-result behavior, fields, and wire output.
- State: 0 of 7 product tasks accepted; no application or test implementation has
  started.
- Authoritative handoff:
  `docs/plans/2026-08-15-session-directory-lazy-page-prep-handoff.md`.
- Worktree/branch:
  `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep`,
  `the-usual/session-directory-lazy-page-prep`.
- Head: `e57091c7f427f207d39c653adbd87199cc685ad8`, a documentation-only
  handoff commit pushed to its remote feature branch. It is **not** an ancestor of
  the investigated `main` and contains no product implementation.
- Blocker: open master `freshell#589e`, which must complete the cloud-default
  heavy-Linux-test runner and final acceptance before `k68e` resumes.

`k68e` can reduce response-row preparation after a shared snapshot already exists.
It does not stop `SessionIndex` discovery/stat/database refreshes, implement file
notices, define repair scans, or replace the iterative index prototype.

## 3. Complete chronology

### 3.1 Initial read-only investigation

The first pass established:

- The production CPU baseline was real and reproducible.
- Persistence across restarts made a chronic baseline plausible, but neither true
  load independence nor a historical regression boundary was proved.
- The live session index held roughly thirty thousand sessions and discovered
  roughly twenty-nine to thirty thousand provider files at that time.
- Requests used a cached snapshot; they did not synchronously parse all provider
  files on every call.
- A warm request still performed broad row conversion, overrides, joins, filtering,
  and sorting before returning 50 rows.
- Background refreshes, auto-title work, and cache persistence were separate
  contributors that request wall time did not account for.
- The production parse-cache file was about 95 MB and was rewritten three times in
  a two-minute observation. The cache contained sensitive paths and session-derived
  metadata, so all later evidence was field-allowlisted and owner-only.

No production process was changed or restarted.

### 3.2 Baseline blocker and merged PR #643

Repository rules required a green `origin/main` baseline before creating the
measurement worktree. The exact baseline command was:

```bash
FRESHELL_TEST_SUMMARY='0gdd Level 1 measurement baseline on origin/main' npm run check
```

It exposed two deterministic failures in
`test/e2e/pane-context-menu-stability.test.tsx`: right-clicking an inactive pane
header opened the global application menu instead of the pane menu.

Root cause: a newly added `data-context="pane-header"` marker stopped context-target
search at the header, but the parser did not understand that marker and the header
lacked the tab/pane IDs needed to construct a pane target.

The narrow baseline repair:

- taught `parseContextTarget()` to resolve `PaneHeader` as a pane target;
- added `data-tab-id` and `data-pane-id` to `PaneHeader`;
- added direct unit coverage for complete and incomplete marker identities;
- preserved the existing automation marker and accessibility behavior.

Evidence before merge:

- focused behavior: 84 passing tests;
- related unit/integration coverage: 149 passing tests;
- TypeScript typecheck passed;
- lint passed with zero errors;
- accessibility gate passed;
- fresh coordinated `npm run check` passed:
  - client: 5,019 passed, 8 skipped;
  - server: 4,924 passed, 29 skipped;
  - Electron: 350 passed.

Landing details:

- fix commit: `a039287b6367f5e475933268973cef5ef4124bce`;
- PR: `https://github.com/danshapiro/freshell/pull/643`;
- merge commit: `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`.

This repair is unrelated to the CPU cause; it only cleared the required baseline.

### 3.3 Level 1 measurement harness

#### Worktree and scope

```text
Worktree: /home/dan/code/freshell/.worktrees/0gdd-measurement
Branch:   investigation/0gdd-measurement
Base:     225a91db3e4d48d4b6a7e8bc0987afad8ff31917
Remote:   none
Commit:   none
```

Exactly five paths remain changed/untracked:

```text
M  crates/freshell-server/src/auto_title_sweep.rs
M  crates/freshell-server/src/main.rs
M  crates/freshell-sessions/src/directory_index.rs
?? scripts/measure-0gdd-level1.ts
?? test/unit/scripts/measure-0gdd-level1.test.ts
```

The tracked Rust diff is 520 insertions and 62 deletions. The runner is 818 lines;
its test is 543 lines.

The harness is intentionally uncommitted because it is diagnostic instrumentation,
not an approved production design. It adds a master-gated set of counters and
controls that can separately disable or alter:

- the session-change sweep;
- the auto-title sweep;
- ongoing refresh after warm-up;
- cache writes;
- browser-style GET traffic;
- one-second versus ten-second refresh behavior.

It also measures process CPU externally from `/proc`. Internal elapsed timings are
supporting evidence only; they are not treated as CPU attribution.

#### Safety model

The runner:

- started scratch Rust servers on random loopback ports, never port 3001;
- copied the production parse cache into a private scratch home without following
  symlinks;
- kept provider roots read-only and separate from scratch configuration;
- rejected redirects and bounded complete HTTP-body reads;
- verified scratch PID, start time, executable, working directory, listener, and
  socket inode before every authenticated request or signal;
- captured production identity/listener before the run and checked it after each
  scratch condition;
- retained only allowlisted aggregate records;
- removed raw logs, tokens, copied cache, fixture files, and scratch homes on
  success, failure, and signals;
- checkpointed sanitized CPU results before optional freshness tests.

Code, test-coverage, and security reviews all passed before the real rerun.

#### First real attempt and freshness harness bug

The first 50-minute run completed the CPU comparison stages but failed in the first
freshness fixture. The fixture was intentionally non-interactive, while the probe
used the endpoint's default filter that hides non-interactive sessions. The file
was discovered, but the probe could never see its row.

Fail-safe cleanup then deleted the entire scratch root, including already-sanitized
per-condition CPU summaries. This was a harness failure, not evidence of a Freshell
freshness failure.

The repair:

- used `includeNonInteractive=1` for synthetic freshness probes;
- copied sanitized CPU evidence to a separate private output before freshness;
- converted only typed freshness timeouts to an “inconclusive” result;
- preserved fatal handling for every unexpected error;
- continued deleting raw state on every path.

The repaired harness passed 31 focused TypeScript tests, typecheck, code review,
and security review before the final run.

#### Final Level 1 comparison results

CPU is shown as percentage points of one CPU core. Each changed condition was
bracketed by normal runs to reduce distortion from changing host activity.

| Condition | Bracketing normal average | Changed run | Difference | Interpretation |
|---|---:|---:|---:|---|
| Disable all investigated periodic/request work | 72.47% | 0.37% | **-72.10** | The combined pipeline explains almost the entire baseline |
| Warm once, then stop ongoing refresh | 92.47% | 27.19% | **-65.28** | Strongest causal result; repeated refresh is the first target |
| Refresh every ten seconds | 74.75% | 39.97% | **-34.79** | Cadence strongly affects cost, but harms freshness |
| Disable browser-style list requests | 74.42% | 45.86% | **-28.56** | Strong upper bound; requests can also trigger refresh |
| Disable auto-title sweep | 78.49% | 45.78% | apparent **-32.71** | Inconclusive: its controls differed by 25.49 points |
| Disable session-change sweep body | 70.09% | 68.50% | -1.59 | Not material in this workload |
| Disable cache writes | 79.26% | 80.45% | +1.19 | No CPU benefit; cache writes are a disk-I/O concern |

Do not add these differences. The conditions interact. In particular, removing GET
traffic also removes refreshes that stale GETs could initiate. The 28.56-point GET
result is therefore an upper bound on eliminating the whole request stream, not an
estimate for merely constructing 50 rows more efficiently.

Normal runs varied from 65.75% to 93.71% of one core (median 75.52%, mean 77.50%).
That variation is why the brackets are part of the evidence, and why the auto-title
comparison is not accepted despite its large apparent change.

Every one of the 18 retained CPU runs met the validity rules:

- 150 `/proc` samples per run;
- 75 successful HTTP 200 requests in every GET-enabled run;
- no requests in GET-disabled runs;
- balanced refresh/cache lifecycle events;
- clean, fingerprint-verified scratch shutdowns;
- no authenticated request before listener verification.

#### Refresh cost and freshness trade-off

Supporting events showed:

- complete refresh: about 1.93 seconds on average (roughly 2.0 seconds median);
- provider discovery/database work: about 1.86 seconds and roughly 92% of the
  recorded refresh time;
- combined-list rebuild: roughly 55 ms;
- combined sort: roughly 14 ms;
- files rediscovered/checked per refresh: roughly 30,500;
- files reparsed per refresh: roughly five;
- Amplifier source work: roughly 984 ms per measured refresh;
- OpenCode source work: roughly 845 ms when its database query ran.

Freshness results:

- normal refresh: new synthetic rows appeared in about 0.6–1.4 seconds;
- ten-second refresh: new rows appeared in about 7.7–10.1 seconds.

The user did not accept ten-second freshness as the primary fix. Preserve prompt
updates and remove unnecessary whole-corpus work instead.

#### Level 1 evidence durability limitation

The final sanitized Level 1 output was originally retained at:

```text
/tmp/freshell-0gdd-output-1130474-ycH6V9
```

That directory no longer exists after the later WSL reboot. It was independently
parsed and cross-checked before the reboot, and the validated numeric findings are
preserved above. The harness and tests remain reproducible, but a future engineer
who needs machine-readable Level 1 raw summaries must rerun the harness. Do not
represent the vanished `/tmp` directory as current evidence.

### 3.4 Standalone file-notice observer

#### Worktree and source

```text
Worktree: /home/dan/code/freshell/.worktrees/0gdd-observer
Branch:   investigation/0gdd-observer
Base:     225a91db3e4d48d4b6a7e8bc0987afad8ff31917
Upstream: origin/main (base tracking only; no remote observer feature branch)
Commit:   none
Source:   crates/freshell-sessions/examples/observer_0gdd.rs
Lines:    4,776
SHA-256:  4f63ec349e61745509afbd8d3481851e12cb6c21099547948ec81c84eea75a3f
```

The worktree contains exactly that one untracked source file. It is intentionally
uncommitted because it is a temporary diagnostic/prototype, not approved
production code.

#### Observer architecture

The observer:

- binds no network port and makes no HTTP request;
- uses `notify` file notices directly;
- watches Claude, Codex, and Amplifier roots recursively;
- watches the OpenCode database directory non-recursively, including database-log
  changes;
- stores no source paths in evidence—paths are reduced to run-local identifiers;
- reads file metadata for reconciliation but not prompts/messages/titles;
- maintains a bounded map of `(raw path, notice kind)` entries;
- combines repeats in the callback before they enter the main work loop;
- preserves raw notice counts and timing-aware rapid-repeat counts;
- performs a complete metadata reconciliation every 15 minutes;
- allows 60 seconds for late notices before classifying a change as missed;
- records one aggregate bucket per minute;
- fingerprints production read-only and stops on a mismatch;
- finalizes a private state/report on normal completion, signal, watcher failure,
  production change, or resource failure.

#### Isolation and limits

The successful run used a transient WSL user service with:

- clean environment: only `HOME`, `LANG`, and `LC_ALL`;
- read-only system and home views except one private output root;
- no usable IP address family (`AF_UNIX` only);
- `CPUQuota=5%` of one core;
- `MemoryHigh=224M`, `MemoryMax=256M`, and bounded swap;
- `TasksMax=16`;
- `LimitNOFILE=65536`;
- low process and disk-I/O priority;
- `Restart=no`;
- fixed runtime limit;
- owner-only `0700` output directory and `0600` files.

Because the systemd filesystem sandbox cannot inspect other processes' file
handles, global file-watch accounting is performed immediately before launch by a
host-side `preflight` command. It writes a bounded owner-only handoff. Sandboxed
`run` validates the handoff's owner, type, link count, age, boot ID, UID, kernel
limits, and projected count before arming watchers. The running observer measures
its own watch/instance counts exactly.

Two fail-closed launches occurred before run `-03`; neither armed watchers:

1. With `ProtectSystem=strict` and `ProtectHome=read-only`, the service entered a
   separate user/mount namespace. It could read `/proc/<pid>/stat`, status, and
   command-line bytes, but following production's special
   `/proc/<pid>/exe` and `/proc/<pid>/cwd` links returned `EACCES`. The observer
   stopped at production preflight. The fingerprint was changed to sandbox-readable
   facts: securely read PID-file bytes, PID/start ticks, bounded command-line bytes,
   UID/GID facts, metadata for the absolute executable path in `argv[0]`, and the
   listener address/port/inode set. Current implementation:
   `crates/freshell-sessions/examples/observer_0gdd.rs:1138-1202`.
2. The next launch reached global file-watch accounting inside that namespace, but
   could inspect only its own file descriptors: a controlled probe saw 307 of 308
   same-user processes as unreadable. Raising that threshold would have made the
   safety claim meaningless. The fix moved global accounting to a host-side
   `preflight` command and passed only bounded counts and system identity through a
   secure `0600`, single-link, no-symlink handoff. The sandbox validates freshness
   and identity but scans only its own file descriptors. Current implementation:
   `crates/freshell-sessions/examples/observer_0gdd.rs:1563-1717`.

#### Meaningful failed runs and the fixes they produced

| Gate/run | Outcome | Root cause | Improvement made |
|---|---|---|---|
| Pre-`-03` gate 1 | Rejected safely before watchers | Filesystem sandbox denied `/proc/<pid>/exe` and `/cwd` link traversal across its namespace | Use only exact sandbox-readable production fingerprint fields |
| Pre-`-03` gate 2 | Rejected safely before watchers | Cross-namespace file-descriptor visibility made in-service global file-watch accounting impossible | Secure, fresh host-side preflight handoff plus exact own-process accounting |
| `-03` | Stopped safely after 80m 58s, `watcher_overflow` | 8,192 raw queued events filled during a burst | Combine identical path/kind notices before enqueue; bounded map; preserve raw counts; timing-aware repeat accounting |
| `-04` | Stopped after about 2h 51m, reported `resource_cpu` | CPU ticks were divided by scheduled rather than actual elapsed time after a long scan; 5.85% false reading was about 3.12% corrected | Pair CPU ticks with actual monotonic sample times; require two complete 6% software windows; retain external 5% hard quota |
| `-05` | Rejected before launch | Dead/zombie child processes counted as uninspectable live file-watch users | Read process state first and after inspection races; skip `Z`, `X`, and `x`; keep live inaccessible processes bounded |
| `-06` | Rejected during startup; empty event file, no report | Required exact equality between recursive directory estimate and actual watches while the tree was changing | Enforce safe actual limits, not unstable projection equality; retain estimate-versus-actual evidence |
| `-07` | Interrupted by the user's WSL reboot | External reboot, not observer failure; 536 complete minute buckets (about 8h 56m), zero production mismatches, no final report | Relaunch from a fresh root after reboot; no product change |
| `-08` | **Complete** | Exactly 24 hours observed; normal finalization | Evidence used below |

Run `-03` also proved why coalescing is mandatory: it received 341,869 raw notices
in 81 minutes; 317,108 were rapid repeats. All seven classified exact-path misses
were Amplifier. Run `-04` again found all 12 misses in Amplifier. These partial runs
are supporting pattern evidence, not substitutes for `-08`.

#### Final run `-08`

Evidence directory:

```text
/home/dan/.local/state/freshell/0gdd-observer-20260814-08
```

Files:

```text
events.jsonl  # 1,635 aggregate records, schema_version 1
state.json     # final cumulative state, schema_version 1
report.json    # final result, schema_version 1
```

Timing:

```text
Observation start: 2026-08-14T16:58:01.998217351Z
Observation span:  86,400,000 ms (exactly 24 hours)
Final report:      2026-08-15T16:58:40.024779323Z
Finalization:      about 38 seconds after observation window
Status:            complete
Stop reason:       observation_complete
```

Record integrity:

- 1 start record;
- 1,440 complete minute buckets;
- 97 reconciliation records;
- 96 watch-accounting records;
- 1 stop record;
- zero malformed JSON records;
- zero missing or duplicate bucket sequence values;
- totals in minute buckets, `state.json`, and `report.json` agree;
- 1,632 production fingerprint checks, zero mismatches;
- zero watcher errors, overflows, or rearms.

##### Notice coverage

The observer found 8,104 metadata-level file-state changes:

| Classification | Count | Share of 8,101 fully classified changes |
|---|---:|---:|
| Matching notice already available | 7,802 | 96.31% |
| Matching notice within 60-second grace | 154 | 1.90% |
| No matching exact-path notice | 145 | 1.79% |
| Unresolved at shutdown | 3 | excluded from rate |
| Covered (immediate + delayed) | **7,956** | **98.21%** |

Provider breakdown:

| Provider | Actual changes | Immediate | Delayed | Missed | Exact-path coverage |
|---|---:|---:|---:|---:|---:|
| Amplifier | 7,607 | 7,309 | 151 | **144** | 98.11% of classified |
| Claude | 22 | 21 | 1 | 0 | 100% in a small sample |
| Codex | 284 | 281 | 2 | 1 | 99.65% |
| OpenCode | 191 | 191 | 0 | 0 | 100% in a small sample |
| **Total** | **8,104** | **7,802** | **154** | **145** | **98.21% classified** |

The zero-miss Claude and OpenCode samples are encouraging, not proof of perfection.

##### Notice volume and repetition

```text
Raw notices:            3,028,908
Rapid repeats:          2,752,490
Rapid-repeat rate:          90.87%
Actual file changes:        8,104
Raw notices per change:       ~374
```

By provider:

| Provider | Raw notices | Rapid repeats | Actual changes | Approx. notices/change |
|---|---:|---:|---:|---:|
| Amplifier | 1,982,994 | 1,809,444 | 7,607 | 261 |
| Claude | 769 | 400 | 22 | 35 |
| Codex | 66,920 | 46,562 | 284 | 236 |
| OpenCode | 978,225 | 896,084 | 191 | **5,121** |

OpenCode is provider-level work: thousands of database/WAL notices must collapse
into one pending OpenCode refresh. It is not meaningful to schedule work per raw
notice.

##### Resource and repair-scan results

- CPU average across complete 5-minute windows: 0.718% of one core;
- peak recorded CPU: 1.963% of one core;
- peak observer RSS: 53,592,064 bytes (about 51.1 MiB);
- peak file descriptors: 17;
- peak threads: 5;
- peak own watches: 29,817 across four watcher instances;
- reconciliation count: 97;
- reconciliation time total: 2,214,064 ms;
- reconciliation average: about 22.8 seconds;
- reconciliation maximum: 40,998 ms.

The watcher itself was cheap; the periodic complete metadata reconciliation was
still substantial. Production should not simply embed a 15-minute copy of the same
expensive full scan without re-measuring it.

##### Privacy and safety validation

The completed evidence passed a read-only audit:

- run directory mode `0700`;
- all three files mode `0600`, owner-only, single-linked;
- no symlinks, hard links, extra ACLs, or unexpected file types;
- no paths, tokens, credentials, session IDs, messages, titles, or request bodies;
- no observer process, cgroup, open output handle, or socket remained;
- production identity and its port-3001 listener were unchanged throughout the
  run.

Global file-watch accounting was incomplete for two inaccessible processes but was
within the explicitly bounded allowance. Own-process accounting was exact.

#### What `-08` proves—and what it does not

It proves:

- notices are useful enough to drive prompt candidate updates;
- notices alone are not a correctness mechanism;
- coalescing must happen at ingress;
- Amplifier exact-path matching is the primary unresolved provider case;
- observing notices can be low CPU and low memory under WSL;
- complete repair scans remain expensive.

It does **not** prove:

- that a matching notice produces the correct parsed sidebar row;
- that an exact-path miss produces a stale sidebar row;
- that a 15-minute repair interval is acceptable;
- that ordering between a notice-driven update and a repair scan is race-free;
- that the approach behaves the same on Windows, macOS, mounted Windows paths,
  network filesystems, or after suspend/resume;
- that production integration will remain as cheap as metadata-only observation.

### 3.5 Why Amplifier must be compared by session directory

Amplifier represents one session with related files in one session directory,
including metadata, transcript, and event/activity files. The observer's 144
Amplifier misses are exact-path misses: it asked whether the same path changed and
had a matching notice.

For row correctness, the useful unit is the **session directory**. A notice on any
relevant file in that directory can mark the whole session for rebuilding. A
metadata change without a metadata-path notice may still be correctly covered by a
transcript or event-file notice in the same session directory.

The next prototype must therefore compare:

```text
exact-path notice evidence (diagnostic only)
                vs.
provider work unit (Amplifier session directory)
                vs.
final parsed session row (correctness oracle)
```

Do not claim that 144 Amplifier sessions would have been stale. That has not been
measured.

### 3.6 Newly discovered naming-scope bug pauses visible-row oracle work

While preparing to make the observer compare real rows, the user reported dozens
of same-named OpenCode entries in the left sidebar. A read-only investigation found
that they are distinct durable conversations, not duplicate IDs or duplicated
React rows. Different OpenCode-native titles had been replaced by the same durable
Freshell `titleOverride` after pane/tab labels were cascaded into session history.

Current code intentionally does this:

- pane/tab rename calls `syncRenameToServer`:
  `src/store/titleSync.ts:22-57`, `src/store/titleSync.ts:82-129`;
- terminal rename cascades to the durable session override:
  `crates/freshell-server/src/terminals.rs:1010-1035`;
- agent API pane rename also cascades:
  `crates/freshell-freshagent/src/rename_persistence.rs:41-123` and
  `crates/freshell-server/src/main.rs:93-145`;
- stopped-terminal and fresh-agent client PATCHes arrive at the direct session
  route, which marks a nonempty title as `titleSource:"user"`, persists it,
  cascades to a matching live terminal, and broadcasts terminal/session changes
  as applicable: `crates/freshell-server/src/sessions.rs:143-220`;
- the sidebar overlay replaces the provider title:
  `crates/freshell-server/src/session_directory.rs:736-778`.

The sidebar keys and click routing remain provider/session-ID based:
`src/components/Sidebar.tsx:424-533`, `src/components/Sidebar.tsx:920-947`.
Thus two same-titled rows still resume different conversations.

This behavior is tracked in the separate naming-scope Kata. Until it is fixed or
the comparator explicitly distinguishes provider-native data from display
overrides, **visible title equality is not a valid session-row correctness oracle**.

Related Kata `freshell#3psp` is historical rather than an open implementation
dependency for this work. Commit
`305b0557260c3fdf61769bea76fc7851124afb8d`, which is already an ancestor of
the investigated `main`, implemented its provider-generated read guard and tests.
That guard suppresses only `dir`/`first-message` rows over provider-generated
titles; `ai`, `user`, and absent-source overrides still apply. It therefore does
not solve `b5fb`'s pane/tab-to-`user` scope bug. Kata `3psp` remains open pending
separate closure authority, with implementation evidence recorded in a comment.

## 4. Current artifacts and reproducibility

### 4.1 Repository/worktree inventory

Verified on 2026-08-15:

| Purpose | Path | Branch / revision | State | Merge? |
|---|---|---|---|---|
| Main checkout | `/home/dan/code/freshell` | `main` at `225a91db3` | Tracked files clean; unrelated untracked resource-containment plan intentionally untouched | Production source of record |
| Level 1 harness | `/home/dan/code/freshell/.worktrees/0gdd-measurement` | `investigation/0gdd-measurement` at `225a91db3` | 3 tracked modified + 2 untracked files | **Do not merge** as production code |
| File observer | `/home/dan/code/freshell/.worktrees/0gdd-observer` | `investigation/0gdd-observer` at `225a91db3` | exactly 1 untracked example | **Do not merge** as production code |
| Page-bound plan | `/home/dan/code/freshell/.worktrees/session-directory-page-bound` | `the-usual/session-directory-page-bound`, HEAD `d1ef097ec` | clean, 8,289-line plan | Do not execute as written |
| Lazy page preparation | `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep` | `the-usual/session-directory-lazy-page-prep`, local/remote HEAD `e57091c7f` | clean; documentation handoff committed/pushed; product progress 0/7 | Paused; blocked by open `freshell#589e`; distinct from watcher/index work |
| This handoff | `/home/dan/code/freshell/.worktrees/0gdd-handoff` | `docs/0gdd-handoff` at `225a91db3` | this handoff markdown file | Maintained on its dedicated local branch/worktree; publication via push or PR remains approval-gated |

Neither investigation branch has a matching remote feature branch. The measurement
branch has no upstream; the observer and handoff branches track `origin/main` only
as their base.

### 4.2 Durable evidence

Current, validated final observer evidence:

```text
/home/dan/.local/state/freshell/0gdd-observer-20260814-08/
  events.jsonl
  state.json
  report.json
```

Historical partial observer evidence is also retained:

```text
/home/dan/.local/state/freshell/0gdd-observer-20260813-03
/home/dan/.local/state/freshell/0gdd-observer-20260813-04
/home/dan/.local/state/freshell/0gdd-observer-20260814-06
/home/dan/.local/state/freshell/0gdd-observer-20260814-07
```

`-06` contains an empty event file and no report because it failed before arming.
`-07` contains 536 minute buckets and state but no report because WSL rebooted.

Five host-side preflight handoffs are also retained:

```text
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260813T233832Z.json  # -03
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T015442Z.json  # -04
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T072617Z.json  # -06
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T074515Z.json  # -07
/home/dan/.local/state/freshell/0gdd-observer-preflight-20260814T165650Z.json  # -08
```

All match the pattern
`/home/dan/.local/state/freshell/0gdd-observer-preflight-*.json`. They are
regular, owner-only `0600` files with one link, parse as schema version 1, and
contain only boot/UID/time, kernel limits, projected/existing watch counts, and
the number of uninspectable processes—no provider paths or session content.

Their launch validity expired five minutes after creation
(`PREFLIGHT_MAX_AGE_MS`, observer source line 43), so **none may be reused as a
future launch input**. The final `...165650Z.json` is useful provenance for
`-08` and should stay with that evidence until review/archive is complete. The
four older handoffs are optional setup/partial-run provenance. They are safe to
remove in a deliberate post-review evidence-cleanup step, but remain retained
because this handoff revision is not authorized to alter evidence. There is no
handoff for the two pre-`-03` launch gates or `-05`: those failures occurred
before a valid host handoff was written.

The Level 1 `/tmp/freshell-0gdd-output-1130474-ycH6V9` directory is **not** durable
and is currently absent. See Section 3.3.

### 4.3 Evidence schemas

Observer schema version is `1`.

`events.jsonl` record types:

- `start`;
- `bucket` (one aggregate per minute);
- `reconcile`;
- `watch_accounting`;
- `stop`.

`state.json` is the latest cumulative state. `report.json` is written only after
normal or controlled finalization and contains:

- run status/reason and timing;
- configuration intervals;
- record/byte counts;
- production-guard counts;
- provider notice and reconciliation totals;
- correlation totals;
- latest/peak resources;
- watcher error/overflow/rearm totals.

All path correlation uses run-local identifiers; the retained schema has no path,
session title, session ID, message, or token field.

The Level 1 output schema (when rerun) is:

- `manifest.json`—source/binary provenance and run list;
- `comparisons.json`—sanitized per-condition summaries;
- `freshness.json`—freshness runs or typed inconclusive failures;
- `safety.json`—listener/auth/cleanup counters;
- `runs/*.summary.jsonl`, `*.proc.jsonl`, `*.requests.jsonl`, `*.events.jsonl`.

### 4.4 Commands already verified

Baseline repair/full repository gate:

```bash
FRESHELL_TEST_SUMMARY='0gdd Level 1 measurement baseline on origin/main' npm run check
```

Level 1 harness (focused):

```bash
npm run test:vitest -- run test/unit/scripts/measure-0gdd-level1.test.ts
npm run typecheck
```

Level 1 real runner (do not run casually; it uses real read-only provider roots and
takes roughly an hour under the conditional plan):

```bash
node --import tsx scripts/measure-0gdd-level1.ts smoke
node --import tsx scripts/measure-0gdd-level1.ts run
```

Observer verification:

```bash
cargo test -p freshell-sessions --example observer_0gdd
# final focused result: 58 passed, 0 failed

cargo test -p freshell-sessions
# final result: 299 passed, 1 ignored, 0 failed

cargo fmt --check --all
cargo clippy -p freshell-sessions --example observer_0gdd -- -D warnings
cargo build --release -p freshell-sessions --example observer_0gdd
```

Observer smoke template:

```bash
RUN_ROOT="$(mktemp -d)"
chmod 700 "$RUN_ROOT"
target/release/examples/observer_0gdd smoke --run-root "$RUN_ROOT"
```

Signal cleanup was also tested with `smoke --wait-for-signal` in a test-owned
sandbox. Never use a production PID in smoke cleanup.

### 4.5 Observer preflight/launch model

This is a reproducibility template, not a request to relaunch now. Substitute
verified absolute provider roots and a fresh owner-only output/preflight path.
Do not include credentials; the observer needs none.

Host-side preflight, immediately before launch:

```bash
BIN=/home/dan/code/freshell/.worktrees/0gdd-observer/target/release/examples/observer_0gdd
PREFLIGHT=/home/dan/.local/state/freshell/0gdd-observer-preflight-<utc>.json

/usr/bin/env -i HOME="$HOME" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  "$BIN" preflight \
  --claude-root <absolute-claude-projects-root> \
  --codex-root <absolute-codex-sessions-root> \
  --amplifier-root <absolute-amplifier-projects-root> \
  --opencode-db <absolute-opencode-db-path> \
  --output "$PREFLIGHT"
```

The handoff expires after five minutes. The run root must already exist, be empty,
be owned by the current user, and have mode `0700`.

The successful service used the equivalent of:

```bash
systemd-run --user \
  --unit=freshell-0gdd-observer.service \
  --property=Restart=no \
  --property=Nice=19 \
  --property=IOSchedulingClass=idle \
  --property=CPUQuota=5% \
  --property=MemoryHigh=224M \
  --property=MemoryMax=256M \
  --property=MemorySwapMax=128M \
  --property=TasksMax=16 \
  --property=LimitNOFILE=65536 \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property=NoNewPrivileges=yes \
  --property=RestrictAddressFamilies=AF_UNIX \
  --property=PrivateTmp=yes \
  --property=RuntimeMaxSec=25h \
  --property="ReadWritePaths=<absolute-run-root>" \
  /usr/bin/env -i HOME="$HOME" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  "$BIN" run \
  --run-root <absolute-run-root> \
  --claude-root <absolute-claude-projects-root> \
  --codex-root <absolute-codex-sessions-root> \
  --amplifier-root <absolute-amplifier-projects-root> \
  --opencode-db <absolute-opencode-db-path> \
  --production-pid-file <absolute-freshell-pid-file> \
  --production-port 3001 \
  --preflight-file "$PREFLIGHT"
```

Before any future launch, re-review this template against the current observer
source and current systemd behavior. The completed run does not authorize an
unattended relaunch.

### 4.6 Safe status and cleanup commands

Status (temporary units disappear after completion, so “unit not found” must be
followed by checking `report.json`):

```bash
systemctl --user show freshell-0gdd-observer.service \
  -p ActiveState -p SubState -p MainPID -p Result \
  -p CPUUsageNSec -p MemoryCurrent -p MemoryPeak -p TasksCurrent

jq '{status, stop_reason, duration_ms, bucket_count}' \
  <absolute-run-root>/report.json
```

Graceful stop of the observer only:

```bash
systemctl --user stop freshell-0gdd-observer.service
```

Then verify:

```bash
systemctl --user show freshell-0gdd-observer.service \
  -p ActiveState -p SubState -p MainPID -p Result
jq '{status, stop_reason}' <absolute-run-root>/report.json
```

Do not use `pkill`, `killall`, `pkill node`, `pkill freshell`, or a broad command
pattern. Never stop port 3001 as part of observer cleanup.

### 4.7 Diagnostic-only artifacts

Do **not** merge these as production implementation:

- the Level 1 environment-variable controls and diagnostic event instrumentation;
- `scripts/measure-0gdd-level1.ts` and its private orchestration assumptions;
- `observer_0gdd.rs` in its current one-file diagnostic form;
- the 8,289-line page-bounding plan as written;
- systemd launch scaffolding for a permanent observer daemon.

Extract the minimum proven algorithm only after the iterative row comparator
converges and a production design is approved.

## 5. Next agreed iteration loop

### 5.1 Goal

Create a candidate session index that is behaviorally equivalent to the current
full-scan result for the fields Freshell actually uses, while avoiding repeated
whole-corpus discovery on the fast path.

The candidate and reference must use the same provider parsers. Do not create a
second interpretation of provider data.

### 5.2 Candidate/reference structure

The temporary observer should maintain:

1. **Candidate state**—updated from combined file notices at provider work-unit
   granularity.
2. **Reference state**—rebuilt at explicit repair points with the current
   full-scan implementation.
3. **Comparator**—compares canonical internal rows before presentation-only title
   overlays, unless the naming-scope bug has been fixed and explicitly included.

Compare at least:

- provider + durable session ID;
- existence/deletion;
- provider-native title and title source;
- first user message presence plus a run-local keyed digest, never retained text;
- working directory identity through a run-local keyed digest, never retained path;
- project identity through a run-local keyed digest;
- created and last-activity timestamps;
- subagent/non-interactive flags;
- provider scan health/degraded state;
- ordering keys used by the sidebar.

Use HMAC-SHA-256 or keyed BLAKE3 with a fresh random key per run. Keep that key
only in the disposable private run root and destroy it at cleanup; never retain
the key with the report. A plain unsalted hash is not acceptable because paths
and common messages can be guessed offline. Do not retain raw text or paths.

### 5.3 Stop-on-first-difference loop

1. Start from a reference snapshot.
2. Arm notices before or atomically with snapshot publication so no change can fall
   between “scanned” and “watching.”
3. Run candidate updates.
4. At the next repair point, compute the reference snapshot.
5. If rows differ unexpectedly:
   - stop candidate processing;
   - stop the run cleanly;
   - preserve a bounded private ring buffer covering the discrepancy;
   - include only run-local keyed row/work-unit digests, notice kinds/times,
     candidate/reference field-difference names, and operation sequence;
   - root-cause immediately;
   - add a red/green test and fix one cause;
   - rerun from minutes, not from 24 hours.
6. If equal, continue to the next duration rung.

Duration ladder:

```text
minutes -> 1 hour -> 4 hours -> 24 hours
```

A longer run is earned by convergence at the previous rung. It is final confidence,
not the primary debugging method.

### 5.4 Provider-specific work units

#### Claude

Work unit: one durable Claude transcript/session file.

- Combine create/modify/remove notices for the same path.
- Parse that one session when stable enough to read.
- Treat directory/root structural changes as a repair trigger.
- Preserve provider-error semantics when a root is inaccessible.

#### Codex

Work unit: one durable Codex rollout/session file.

- Combine events for the same rollout.
- Handle date-directory creation and rename/move behavior.
- Preserve the durable-ID contract; transient shell snapshots are not sessions.

#### Amplifier

Work unit: one Amplifier **session directory**, not one file.

- Any relevant metadata/transcript/event notice marks the directory dirty.
- Rebuild one session row from the complete sibling set.
- Coalesce the frequent activity/event writes.
- Test create, metadata-first, transcript-first, activity-only, rename, partial
  write, deletion, and directory removal.
- Reclassify the 144 exact-path misses at directory level before drawing further
  conclusions.

#### OpenCode

Work unit: the OpenCode provider database.

- Database and database-log notices collapse into one pending provider refresh.
- Never query per notice.
- Debounce while guaranteeing eventual progress under continuous writes (a maximum
  delay/deadline, not an endlessly extended timer).
- Preserve the current root-session/archived filtering and provider health behavior
  at `crates/freshell-sessions/src/parse/opencode.rs:239-339`.

### 5.5 Current provider-failure parity versus proposed improvement

The candidate/reference comparison must encode the current asymmetric behavior
accurately:

- **OpenCode (direct-listed source):** when its change token is unchanged but the
  health check fails, the index records the provider failure and retains the
  existing direct cache. When the token changed but `direct_list()` fails, it
  also records the failure and explicitly preserves previously cached OpenCode
  rows. See
  `crates/freshell-sessions/src/directory_index.rs:1304-1357`.
- **Claude, Codex, and Amplifier (file-backed sources):** a root-listing failure
  records the provider failure and substitutes an empty listing for that source.
  The common prune then removes cached file rows that were not rediscovered,
  which prunes that failed provider's rows from the published snapshot. See
  `crates/freshell-sessions/src/directory_index.rs:1364-1409`. Comments in the
  current implementation identify this as exact Node parity.

The prototype must first match those semantics so a comparator difference is not
mistaken for a watcher bug. Preserving last-good rows for file-backed root failures
may be a desirable reliability improvement, but it changes visible outage/deletion
behavior and is **not current parity**. Treat it as a separate production design
decision requiring explicit approval and dedicated failure/recovery tests.

### 5.6 Correctness gates

Before production design:

- zero unexplained candidate/reference row differences at each duration rung;
- no dropped create, modify, rename, or delete in provider fixture tests;
- after watcher overflow, root recreation, or suspend/resume simulation, the
  candidate converges to the reference's exact current state;
- candidate and repair operations cannot publish out of order;
- a repair snapshot based on older storage state cannot overwrite a newer
  notice-driven update;
- only one update per provider work unit runs at a time;
- burst work is bounded globally and per provider;
- provider failures match the exact current asymmetry above and surface the same
  degraded-health information; any uniform last-good preservation is separately
  approved rather than smuggled into the watcher prototype;
- any separately approved last-good preservation defines and tests recovery-time
  convergence: successful reads replace stale rows, while a confirmed deletion
  eventually removes them;
- client `sessions.changed` publication occurs after the candidate snapshot is
  coherent;
- visible title is excluded as an oracle until the naming-scope bug is resolved.

### 5.7 Performance gates

Measure against the Level 1 baseline with the same corpus/environment:

- steady server CPU materially below the 65–94% normal range;
- browser requests do not initiate provider scans;
- no per-notice parse/query work;
- memory and queue sizes remain bounded under the observed 13,000+ notices/minute
  burst shape;
- OpenCode query rate is bounded despite ~5,121 notices per actual change;
- repair scans are infrequent enough to matter and do not create latency/CPU cliffs;
- update freshness remains near the normal 0.6–1.4-second range for active work;
- no cache-write storm or sensitive evidence leakage.

Exact acceptance thresholds should be set after the first production-shaped
prototype measurements; do not invent percentages before seeing the integrated
cost.

### 5.8 Ordering and recovery requirements

A robust implementation needs explicit sequencing, not incidental task timing:

- assign monotonically increasing provider/work-unit generations;
- publish only if a result is still current;
- make repair scans and targeted updates use the same generation rules;
- on watcher overflow or error, mark the candidate untrusted, run repair, rearm,
  and only then return to notice-driven operation;
- if a watched root disappears, the parity comparator must first reproduce the
  current file-backed pruning behavior. A proposal to retain last-good rows as
  degraded state is a separate, approval-gated behavior change and must define
  how confirmed deletion eventually removes rows;
- on restart, load cache for responsiveness but verify it before treating it as
  authoritative;
- skip missed timer bursts rather than immediately repeating identical repairs;
- preserve clean shutdown and join in-flight update work.

## 6. Naming-scope bug boundary

The separate naming bug must be solved as an entity/lifetime decision:

```text
durable provider conversation
        may be run by a terminal process
        may be displayed by a pane
        is organized inside a tab
```

A pane/tab label is temporary UI organization. A durable session title belongs to
the provider conversation/history. These names can be intentionally synchronized,
but one must not silently overwrite the other simply because a pane currently
displays that session.

The new Kata records the outcome and acceptance matrix. This handoff intentionally
does not choose the final API/data model or delete existing overrides; some current
session-title overrides are intentional user renames and cannot be distinguished
from accidental pane-label propagation by value alone.

Stopping new collision-group growth is not sufficient closure. Existing affected
histories need a user-reviewed path that previews/reveals the provider-native title,
selectively clears only chosen accidental overrides, preserves ambiguous or
intentional renames by default, and provides backup/rollback before mutation.

## 7. Risks, non-goals, rejected directions, and open questions

### 7.1 Explicit non-goals/rejections

- **No database replacement.** Provider files and OpenCode's own database remain
  authoritative; do not add a second Freshell session database to solve polling.
- **No notices-only design.** The observer missed 145 exact paths in one day and
  watcher failure modes are real.
- **No per-notice work.** More than three million notices represented 8,104 actual
  changes.
- **No permanent companion service.** The observer is temporary; production logic
  should live in the existing process.
- **No oversized page-limit plan as the first fix.** Page bounding is secondary to
  refresh/source scanning.
- **No immediate production cutover.** Row equivalence, ordering, and failure
  recovery are not yet proved.
- **No ten-second timer as the final answer.** It lowered CPU but delayed freshness
  to 7.7–10.1 seconds.
- **No blind deletion of title overrides.** Some represent explicit durable session
  renames.
- **No title-based deduplication.** Same-titled sidebar entries can be different
  conversations.

### 7.2 Cross-platform risk

The completed observation covers WSL2's Linux filesystem behavior on this machine.
File-notice semantics, rename events, watch limits, suspend behavior, and path
identity can differ on:

- native Windows;
- macOS;
- provider roots under `/mnt/c` or other mounted Windows drives;
- network filesystems;
- containers and VMs.

Production implementation must retain the repair path and add platform-specific
integration coverage. Do not generalize 98.21% WSL exact-path coverage to every
platform.

### 7.3 Open technical questions

1. How many of the 144 Amplifier exact-path misses disappear when correlated by
   session directory and final parsed row?
2. What notice-stability rule avoids parsing a partially written file without
   imposing visible delay?
3. What bounded maximum debounce gives OpenCode eventual progress under continuous
   database-log traffic?
4. How should a targeted update and a simultaneous repair scan be serialized or
   generation-checked?
5. What repair cadence meets freshness/recovery needs without recreating the CPU
   problem?
6. Can the current persistent cache be updated incrementally without rewriting
   roughly 95 MB after small changes?
7. Which fields form the canonical row comparator before and after the naming bug
   is fixed?
8. What platform capability/fallback matrix is required for native Windows and
   mounted filesystems?

### 7.4 What requires user approval

Obtain explicit user approval before:

- implementing production behavior from the prototype;
- changing public/session naming semantics after presenting the design;
- migrating or deleting existing session-title overrides;
- launching another unattended long observer run;
- committing or pushing either diagnostic worktree;
- opening a PR;
- deploying client files;
- restarting/stopping the live Rust server (literal **`APPROVED`** required).

This document is maintained on its dedicated local handoff branch/worktree. Local
maintenance does not authorize publication: a push or PR remains approval-gated,
and it does not authorize commits to the measurement or observer prototypes.

Short, test-owned fixture runs and read-only analysis can proceed under the already
agreed iterative process, but the user should be told when a run will consume the
real provider corpus or last beyond the current interaction.

## 8. References

### 8.1 Katas

- Existing performance issue: `freshell#0gdd`
  - short ID: `0gdd`
  - UID: `01KZRW1HFB77ZQZJ6F1PJB0GDD`
  - status at handoff: open
  - inspect with: `kata show 0gdd --json`
- Naming-scope bug: `freshell#b5fb` / UID `01M03BWS22XRB6CCN7HTP7B5FB`,
  “Pane/tab labels overwrite durable session titles, making distinct histories
  look identical.”
- Historical adjacent issue: `freshell#3psp` / UID
  `01KYWPNTQACD7XKWNYB2DN3PSP`; implementation is present in
  `305b0557260c3fdf61769bea76fc7851124afb8d`, while the Kata remains open pending
  separate closure authority.
- Related request-side work: `freshell#k68e` / UID
  `01M03CT4BB6BQ1KCDJWMD6K68E`; open at P2 with product progress 0/7, paused behind
  blocker `freshell#589e`.
- Cloud-testing blocker: `freshell#589e` / UID
  `01M03DNJ380M2W30PKENRC589E`; open at P1 and explicitly blocks `k68e`.

### 8.2 Commits and PRs

- `0538c5a82113c1a23c4a54a4f58d39bf71c94b8d`—PR #387,
  “stable, aligned naming”; introduced pane/tab-to-session rename synchronization.
- `ab9affe85d3a246e7ba0d624bb54a66f31d34792`—extended agent API pane
  rename persistence/cascade.
- `305b0557260c3fdf61769bea76fc7851124afb8d`—implemented the adjacent
  `3psp` provider-generated `dir`/`first-message` read guard; it deliberately
  leaves `user` overrides applicable and therefore does not fix `b5fb`.
- `e57091c7f427f207d39c653adbd87199cc685ad8`—documentation-only handoff
  commit for `k68e` on `the-usual/session-directory-lazy-page-prep`; pushed to
  that remote feature branch, not merged into the investigated `main`, and not a
  product implementation.
- `a039287b6367f5e475933268973cef5ef4124bce`—context-menu baseline fix.
- `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`—merge commit for PR #643.
- PR #643: `https://github.com/danshapiro/freshell/pull/643`.

### 8.3 Performance code

- Index construction: `crates/freshell-server/src/main.rs:658-694`.
- Warm/sweep/auto-title startup: `crates/freshell-server/src/main.rs:1212-1270`.
- Two-second cadence: `crates/freshell-server/src/main.rs:2387-2393`.
- Session sweep: `crates/freshell-server/src/main.rs:2521-2579`.
- Session-directory handler: `crates/freshell-server/src/session_directory.rs:380-454`.
- Override application: `crates/freshell-server/src/session_directory.rs:736-778`.
- Query page derivation: `crates/freshell-server/src/session_directory.rs:1173-1282`.
- Auto-title pass: `crates/freshell-server/src/auto_title_sweep.rs:295-412`.
- Auto-title loop: `crates/freshell-server/src/auto_title_sweep.rs:507-549`.
- Snapshot refresh lifecycle:
  `crates/freshell-sessions/src/directory_index.rs:938-1197`.
- Incremental discovery/rebuild:
  `crates/freshell-sessions/src/directory_index.rs:1267-1423`.
- Persistent cache write gate:
  `crates/freshell-sessions/src/directory_index.rs:1208-1247`.
- OpenCode root-session query:
  `crates/freshell-sessions/src/parse/opencode.rs:239-339`.

### 8.4 Naming/click behavior code

- Client pane/tab rename synchronization: `src/store/titleSync.ts:22-57` and
  `src/store/titleSync.ts:82-129`.
- Direct durable session rename endpoint:
  `crates/freshell-server/src/sessions.rs:80-88`,
  `crates/freshell-server/src/sessions.rs:116-220`.
- Session override ladder and best-effort disk persistence:
  `crates/freshell-server/src/settings_store.rs:909-996`.
- Terminal rename-to-session cascade:
  `crates/freshell-server/src/terminals.rs:1010-1035`.
- Agent API pane rename-to-session cascade:
  `crates/freshell-freshagent/src/rename_persistence.rs:41-123` and
  `crates/freshell-server/src/main.rs:93-145`.
- Sidebar click/dedup by provider + session ID:
  `src/components/Sidebar.tsx:424-533`.
- Sidebar React key: `src/components/Sidebar.tsx:920-947`.
- Resume content carries durable session reference:
  `src/lib/session-type-utils.ts:86-163`.
- Pagination deduplicates by session key:
  `src/store/sessionsThunks.ts:120-209`.
- Existing rename tests:
  `test/unit/client/store/titleSync.serverSync.test.ts:25-53`,
  `test/unit/client/store/tab-pane-title-sync.test.ts`,
  `test/unit/client/store/paneSessionTitleSync.test.ts`,
  `crates/freshell-server/src/sessions_tests.rs`,
  `crates/freshell-freshagent/src/rename_cascade_tests.rs`.

### 8.5 Evidence paths

- Final observer report:
  `/home/dan/.local/state/freshell/0gdd-observer-20260814-08/report.json:1`.
- Final observer state:
  `/home/dan/.local/state/freshell/0gdd-observer-20260814-08/state.json:1`.
- Final observer event stream:
  `/home/dan/.local/state/freshell/0gdd-observer-20260814-08/events.jsonl`.
- Historical Level 1 output (now absent after reboot):
  `/tmp/freshell-0gdd-output-1130474-ycH6V9`.

## Appendix A: concise decision ledger

| Decision | Status | Evidence/reason |
|---|---|---|
| `0gdd` is valid | Accepted | Live 65–94% normal range; quiet pipeline 0.37% |
| HTTP handler is the sole cause | Rejected | Request removal is only an overlapping 28.56-point upper bound |
| Repeated refresh is first target | Accepted | -65.28 points when stopped after warm-up |
| Raise timer to ten seconds | Rejected as final fix | -34.79 points but 7.7–10.1-second freshness |
| Session-change signature body is expensive | Rejected | -1.59 points |
| Cache writes cause CPU baseline | Rejected | disabling writes was +1.19 points; disk I/O remains concern |
| Auto-title is definitely dominant | Unresolved | apparent saving, unstable controls |
| Notices can drive prompt updates | Accepted for prototype | 98.21% exact-path classified coverage |
| Notices can be sole truth | Rejected | 145 exact-path misses + watcher failure modes |
| Process every notice | Rejected | 3.03M notices / 8,104 changes |
| Amplifier should update per path | Rejected | one session spans sibling files; use directory work unit |
| Permanent observer service | Rejected | user requires no ghost process; integrate proven logic in-process |
| Run another broad study first | Rejected | user correction: improve on first discrepancy |
| Visible title is current row oracle | Rejected | pane/tab labels polluted durable session overrides |

## Appendix B: resume checklist

Before making any change:

- [ ] Read this handoff and `kata show 0gdd --json`.
- [ ] Read the naming-scope Kata; do not use visible-title equality as truth.
- [ ] Verify all worktree statuses; do not clean or commit another agent's work.
- [ ] Confirm final `-08` report integrity and privacy.
- [ ] Confirm the live server is not being restarted or signaled.
- [ ] Decide the first candidate/reference row schema and write tests first.
- [ ] Implement only one provider work unit or one discrepancy fix at a time.
- [ ] Stop at the first unexplained difference.
- [ ] Keep diagnostics private, bounded, and free of source text/paths.
- [ ] Rerun minutes before attempting one hour.
- [ ] Bring any naming data migration decision to the user.
- [ ] Obtain explicit approval before PR/deployment; obtain literal `APPROVED`
      before a live server restart.
