# df1 Campaign Wrap Review — Running Record

External fresh-eyes review loop over the ENTIRE campaign delta in this
worktree (`.worktrees/df1-gate`, branch `df1/integration`). Reviewed delta
each round: `git diff 4c2297667...HEAD` (fork point → current tip; fix
commits land on the tip, so the same expression picks them up next round).
Provider per skill rules: `--gpt` (requesting model family is neither
Claude nor GPT). Driver: df1 wrap-review driver. Max 5 rounds; fix MAJOR
findings only, record MINOR/rejected here.

## Round 1

- **Fresh Eyes verdict:** FAILED (`FRESHPID=3589571`, provider gpt)
- **Majors found: 6 — all fixed:**

  1. **`settings_store.rs` — failed project-color write leaked into live
     in-memory state.** `set_project_color` mutated the in-memory map +
     dirty set before `persist()`; a failed persist left the un-persisted
     color visible via `project_colors()`/`/api/session-directory` and its
     stale dirty mark would tombstone later external disk edits
     (`overlay_dirty_keys`). Diverged from legacy: `saveInternal` assigns
     `this.cache` only after the atomic write succeeds.
     **Fix:** `3a6931dd3` — rollback to prior value + dirty membership on
     persist error (unless a concurrent same-path write raced us); new
     store-level rollback test (new key, overwrite-existing, subsequent
     external-adopt, retry-succeeds) and the router 500 test now also
     asserts no in-memory leak. Verified: `cargo test -p freshell-server
     --bin freshell-server settings_store::` 58/58 + `project_color`
     16/16 (incl. new tests); clippy clean.
  2. **`scripts/e2e-cloud.sh:58` — top-level `gcloud info` killed the
     script under `set -e` on machines without gcloud**, before ANY
     subcommand dispatch (silent 127, stderr suppressed) — broke
     `npm run test:e2e`, `test:e2e:local`, and `help`. Verified the
     `set -e` + bare-assignment command-substitution exit behavior
     empirically.
     **Fix:** `7979e844f` — `command -v gcloud` guard + `|| true`
     substitution; only cloud paths require gcloud. New wrapper-test
     check 12 (help with gcloud's dir filtered off PATH) passes.
  3. **`scripts/e2e-cloud.sh:252` + `docker/cloud-run/entrypoint.sh:52` —
     pass-through args corrupted by space-join → word-split round-trip.**
     `--grep "foo bar"` became `--grep=foo` + bogus spec filter `bar`;
     YAML metacharacters could corrupt/inject. Violates plan R4.
     **Fix:** `42c89d848` — YAML literal block scalar (newline-delimited,
     one arg per line) + entrypoint `while IFS= read -r`; empty sets emit
     `PLAYWRIGHT_ARGS: ""`. New wrapper-test check 13 pins both halves.
     Verified: full `scripts/test/cloud-run-wrapper.test.sh` green
     (13 checks, incl. real local playwright runs).
  4. **`scripts/e2e-cloud.sh:334` — `logs` subcommand passed the JOB name
     to `executions logs read`** instead of resolving a latest execution
     id first (as cmd_run does).
     **Fix:** `1e58a34a6` — resolve latest execution via `executions
     list` exactly like cmd_run; fail loudly when none.
  5. **`docs/plans/2026-08-09-cloud-run-jobs.md:29` (R1) + squash commit
     `ab8d6ed46` claimed `npm run test:e2e` defaults to Cloud Run**; the
     shipped wrapper resolves `FRESHELL_E2E_BACKEND:-local` (local
     unset-default, pinned by wrapper-test checks 9-11). The commit
     message is immutable history (merged PR squash) and is intentionally
     NOT rewritten — the plan doc gets a shipped-deviation note.
     **Fix:** `c1a19b48a`.
  6. **`crates/freshell-platform/src/clock.rs:458` — boundary test was
     flaky by construction**: compared `advance_ms(MAX_ADVANCE_MS)`'s
     snapshot to a second live `snapshot()` with whole-struct equality;
     both sample `system_now_ms()` separately, so a real-time tick
     between the calls fails equality nondeterministically.
     **Fix:** `85aa036f6` — freeze the clock first (frozen `now_ms` is a
     pure function of core state); validation still runs before `drive`
     on both paths so the boundary-inclusive pin is unchanged.
     Verified: `cargo test -p freshell-platform --lib clock` 12/12.

- **Minors: none reported.**
- **Rejected findings: none** (all six reported majors verified genuine).
- **Verification notes:** `nice -n 19 npm run typecheck` clean; `cargo
  clippy -p freshell-server -p freshell-platform --all-targets` clean;
  `cargo fmt` applied to touched Rust files. Pre-existing, environment-
  specific failure observed and confirmed at unmodified HEAD alike:
  `freshell-platform port_forward::tests::live_portproxy_and_firewall_show_
  readonly` fails with "portproxy show should succeed" (live WSL→Windows
  netsh probe; unrelated to this delta's clock change — reproduced via
  `git stash` at HEAD). Not a wrap-review finding; noted for the gate.

## Round 2

- **Fresh Eyes verdict:** FAILED (`FRESHPID=671788`, provider gpt).
  **Polling note for future drivers:** mid-run polls falsely reported
  `state=complete`/`verdict=passed` — the fresheyes verdict detector
  scans the review LOG for the marker text, and the reviewer's `rg`
  output had dumped this repo's own evidence docs (e.g. `HARNESS-05.md`),
  which embed historical `**INDEPENDENT CODE REVIEW PASSED**` strings.
  The false "complete" cleared as soon as the reviewer emitted its true
  final marker (FAILED); the confirming signals at true completion were
  `pid_state=missing` + advancing `line_count` stopping. Never trust a
  `state=complete` whose `pid_state` is still `active` AND whose verdict
  could be a repo-content echo.
- **Majors found: 3 — all fixed:**

  1. **`crates/freshell-ws/src/terminal.rs:2068`/`:2139` — paneReconcile
     adoption success paths never settled `create_dedupe`.** Both the
     §5.4 keyed-adopt and the D8 `session_ref_attached` early returns
     sent `terminal.created` but skipped `settle`, so the caller's
     `clear_if_in_flight` dropped the still-InFlight sentinel AND
     answered cross-connection waiters with `PTY_SPAWN_FAILED` despite
     the success; with no Settled entry, a later same-requestId resend on
     a NON-negotiated (frozen) connection re-entered `handle_create` and
     spawned a duplicate PTY. Verified the seeded states are reachable
     (attacher's cleared requestId; REST lane stamps `create_request_id`
     without populating the WS dedupe map).
     **Fix:** `c00630fec` — both returns now `settle` exactly like the
     main spawn path; new
     `session_ref_adoption_settles_dedupe_for_later_legacy_resends`
     integration pin (winner → attacher → frozen-connection resend
     replays, exactly 1 PTY). RED-verified by stashing the fix (test
     fails without it). Verified: freshell-ws lib 434/434,
     session_ref_singleflight 4/4, create_dedupe 3/3, pane_reconcile
     5/5, create_protection 15/15; clippy clean.
  2. **`docker/cloud-run/entrypoint.sh:60` — split-form value flags were
     corrupted by FLAGS/SPEC_FILTERS partitioning** (`--project chromium
     --grep "auth modal"` reordered to `--project --grep chromium "auth
     modal"`). The r1 newline fix preserved args verbatim but the
     entrypoint's shape-based classification still reordered split-form
     values behind later flags.
     **Fix:** `d390472d0` — `cmd_run` normalizes an allowlist of
     value-taking flags (`--grep`, `--grep-invert`, `--project`,
     `--reporter`, `--retries`, `--workers`, `--timeout`,
     `--global-timeout`, `--max-failures`, `--repeat-each`, `--output`)
     to `=form` before either backend consumes `pw_args` (Playwright
     binds =form identically; boolean switches untouched). New
     wrapper-test check 14 pins the exact corrupted combination (3
     passed via split-form). Full wrapper suite green (14 checks).
  3. **`docs/plans/2026-08-09-cloud-run-jobs.md` — plan internals still
     contradicted shipped behavior**: r1's deviation header acknowledged
     the mismatch, but R1 and the Task-3 rationale still encoded "cloud
     default" as the live contract.
     **Fix:** `b8f1dad1e` — R1 annotated "NOT SHIPPED as written" with
     the shipped local-default contract; Task-3 note records the planned
     repurpose deliberately did not ship. (Squash commit `ab8d6ed46`'s
     message remains immutable history, as recorded in round 1.)

- **Minors: none reported.**
- **Rejected findings: none.**
- **Verification notes:** `nice -n 19 npm run typecheck` clean; `cargo
  clippy -p freshell-ws --all-targets` clean; `cargo fmt` applied to
  touched Rust files.

## Round 3

- **Fresh Eyes verdict:** FAILED (`FRESHPID=1859657`, provider gpt).
- **Majors found: 1 critical + 3 major — 3 fixed, 1 rejected-by-design:**

  1. **CRITICAL — proxy forwarded Freshell's gate credentials to proxied
     apps** (`crates/freshell-server/src/proxy.rs:179`): after
     authenticating, the proxy passed `x-auth-token` and the
     `freshell-auth` cookie verbatim to arbitrary loopback upstreams (the
     legacy `server/proxy-router.ts` did the same; the leak predates the
     port, and new tests on both sides had codified it as intent). In the
     browser pane the same-origin `allow-scripts` iframe makes it
     JS-readable — any app you open gets a bearer token for every
     authenticated API/WS surface.
     **Fix:** `8b13d83a6` — BOTH servers strip `x-auth-token` and filter
     the `freshell-auth` pair out of forwarded Cookie values (app cookies
     survive; auth-only cookie dropped entirely), including the legacy
     WS-upgrade leg. Pins flipped/added: rust in-module + real-binary
     capture asserts, legacy supertest capture route, browser01 e2e
     (root sees no `freshell-auth`; fixture-set `app-session` cookie does
     flow). RED-verified by stashing (legacy vitest 1 failing, rust
     black-box + wire pins failing without the fix).
  2. **`scripts/e2e-cloud.sh` — cloud runs could pass against a stale
     image** (mutable `:latest`; rebuild only on `--build`/missing), a
     vacuously-green test gate.
     **Fix:** `ade55e095` — commit-addressed tags
     (`rev-parse --short=12 HEAD`, `-dirty` suffix for uncommitted/
     untracked trees); `run` resolves the HEAD tag, builds+pushes when
     absent; `:latest` still pushed as a pointer but never consumed.
     Wrapper check 11 rewritten FULLY STUBBED (its previous form invoked
     real gcloud/docker — an authenticated machine could really
     build/push/run from a test; observed a real `docker build` start
     during r3 verification) and now asserts the job targets + pushes the
     HEAD tag. Full wrapper suite green; sibling cloud-run-config/
     dockerfile suites green.
  3. **`crates/freshell-ws/src/create_dedupe.rs:266` — `restore:
     Option<bool>` compared literally**, but the protocol has it optional
     and the SPA omits false (`...(restore ? { restore: true } : {})`), so
     `None` vs `Some(false)` spellings of the SAME request missed the
     replay and could spawn a duplicate PTY.
     **Fix:** `b7b3da712` — canonical key `restore == Some(true)` stored
     + compared; `restore:true` latch-flip mismatching preserved. Unit
     pin (both spelling directions replay; `true` still mismatches) +
     wire pin (`explicit_restore_false_resend_replays_omitted_restore_
     settled`), RED-verified by stashing.
  4. **Commit `ab8d6ed46`'s message claims "Google Cloud Run Jobs as
     default Playwright e2e backend"** while shipped code defaults unset
     `FRESHELL_E2E_BACKEND` to local. **REJECTED (by design):** the
     commit is a merged squash-merged mid-history commit; its message is
     immutable without rewriting every downstream SHA on a shared
     integration branch, and the claimed default deliberately did NOT
     ship — the repo's current contract (wrapper checks 9-11, plan-doc
     annotations from r2, and the top-level AGENTS.md backend-selection
     policy requiring the user's explicit choice for unset backends) all
     say local-unless-opted-in. The doc inaccuracy half was fixed in r2
     (`b8f1dad1e`); no code change is wanted here.

- **Minors (2, both nits; both fixed as safely-trivial):**
  `docs/plans/df1/HARNESS-06.md:140` trailing whitespace → `92dd5f49a`;
  `docs/plans/df1-evidence/WRAP-REVIEW.md` blank line at EOF → removed
  with this round's record edit. `git diff 4c2297667...HEAD --check` is
  clean at the worktree.
- **Verification notes:** `nice -n 19 npm run typecheck` clean; `cargo
  clippy -p freshell-server -p freshell-ws --all-targets` zero warnings;
  `cargo fmt` applied; freshell-server proxy in-module 25/25, browser01
  black-box 1/1, freshell-ws lib create_dedupe 15/15, wire create_dedupe
  4/4 + session_ref_singleflight 4/4; legacy proxy-router vitest 14/14
  (210/210 across the matched files).

## Round 4

- **Fresh Eyes verdict:** FAILED (`FRESHPID=3494485`, provider gpt).
  (A same-window claude-provider launch, `de4956`, errored before final
  output — empty log, `runner_state=complete`, no verdict; the gpt review
  is the round-4 review of record. No provider-error fallback was needed:
  the primary provider completed normally.)
- **Driver note:** the prior driver session was interrupted AFTER staging
  both fixes but BEFORE verifying/committing them; this session verified,
  hardened one test-stub line (see fix 1), committed, and recorded.
- **Majors found: 2 — both fixed:**

  1. **`scripts/e2e-cloud.sh` (image_tag_for_head / cmd_run) — dirty-tree
     cloud runs could reuse a stale image.** Every dirty state on the same
     commit maps to the same `<sha>-dirty` tag, and r3's commit-addressed
     run path skipped the build whenever that tag existed remotely — so a
     second dirty run executed the FIRST dirty build's source, and the
     cloud e2e gate could pass against stale code. `-dirty` tags are not
     content-addressed, so no remote-existence check can ever be sound.
     **Fix:** `8c7bce61a` — an uncommitted/untracked tree
     now ALWAYS rebuilds+pushes on the cloud path (`--build` force and
     clean-tree remote-tag reuse unchanged; docker layer cache keeps an
     unchanged dirty tree cheap). Wrapper check 11 gained a live dirty-leg
     pin (asserts `docker build` ran when `git status --porcelain` is
     non-empty). **Driver-found + fixed during verification:** the new
     stub's unconditional stdin drain (`cat`) blocked forever when stdin
     was a live TTY (`docker build/tag/push` inherit the caller's stdin) —
     narrowed to drain only non-TTY stdin (the `docker login
     --password-stdin` pipe case). Verified: full
     `scripts/test/cloud-run-wrapper.test.sh` green with the dirty tree
     (the new pin executed live), sibling `cloud-run-config.test.sh` +
     `cloud-run-dockerfile.test.sh` green, `bash -n` on all three touched
     shell files, `git diff --check` clean.
  2. **`docs/plans/2026-08-09-cloud-run-jobs.md` — the Cloud Run
     validation runbook no longer selected Cloud Run.** Shipped behavior
     defaults unset `FRESHELL_E2E_BACKEND` to local (r1/r2 record), so the
     runbook's bare `scripts/e2e-cloud.sh run ...` commands would execute
     LOCAL Playwright and could never create a Cloud Run Job, execute two
     tasks, or verify sharding as the expected results claim.
     **Fix:** `f289f4964` — every validation/runbook
     command now prefixes `FRESHELL_E2E_BACKEND=cloud` with an explanatory
     note, and step-1 expectations document BOTH pushed refs
     (commit-addressed tag + rolling `:latest` pointer).

- **Minors: none reported.**
- **Rejected findings: none** (both majors verified genuine by code
  inspection before fixing).
- **Verification notes:** see fix 1 for the suite list; no TS/Rust files
  touched this round, so no typecheck/clippy/cargo run was applicable.

## Round 5 (final)

- **Fresh Eyes verdict:** FAILED (`FRESHPID=1564060`, provider gpt) — but
  triage found **zero genuine majors** (details below). Mid-run polling
  AGAIN showed the r2-documented false `verdict=passed` echo at 18:39
  (`pid_state=active`; the reviewer's tooling had dumped this repo's
  evidence-doc marker strings into its log); true completion at 18:47 was
  confirmed by `pid_state=missing` + stationary `line_count`, yielding the
  real verdict FAILED. The r2 caution held: never trust a `complete` with
  a live PID.
- **Findings: 2 reported as major — 0 majors after triage; 1 repeat
  rejection, 1 minor (fixed as safely-trivial):**

  1. **Commit `ab8d6ed46`'s message claims cloud-as-default while shipped
     behavior is local-default.** **REJECTED — identical to the round-3
     finding already rejected there.** The commit is merged mid-history
     squash history; its message is immutable without rewriting every
     downstream SHA on the shared integration branch. The documented
     contract is unambiguous: wrapper checks 9-11 pin local-unset-default,
     the plan doc's shipped-deviation header says "commit messages are
     immutable history and are not rewritten," and the top-level AGENTS.md
     requires the user's explicit choice for unset backends. Nothing new
     since r3; the code is the contract and it is correct.
  2. **Plan doc's per-task red/green steps no longer fail at merged
     HEAD** (e.g. "verify failure because the Dockerfile does not exist"
     — the Dockerfile now exists). **MINOR (not a defect):** these steps
     are the campaign's execution HISTORY — a TDD plan's red phase
     expects failure only at that point in the execution, before the
     task's implementation lands. Every completed TDD plan has this
     property; the re-runnable surface is the validation runbook, which
     r4 already corrected. Fixed as safely-trivial: `5f59ce176` adds an
     executed-plan scope note at the top of the plan so no future reader
     treats the red/green steps as a currently-reproducible runbook.

- **Majors:** none remaining.
- **Minors:** 1 (finding 2 above — fixed as safely-trivial,
  `5f59ce176`).
- **Rejected findings:** 1 (finding 1 above — repeat of r3 finding 4).
- **Convergence:** round 5 ended with no genuine majors outstanding
  across the 5-round loop. Verdict trail: r1 F, r2 F, r3 F, r4 F, r5 F
  (each FAILED round's genuine majors were fixed in-round; r5's two
  findings triaged to rejected/minor). Cumulative: 14 majors fixed
  (6+3+3+2+0 — r3's reported critical counted among its 3 fixes), 2
  rejected-finding instances total (r3 #4 and its r5 repeat), 3 minors
  recorded across rounds (2 nits in r3, 1 in r5 — all three fixed as
  safely-trivial).

## Final state

Branch `df1/integration` in this worktree carries the full campaign delta
plus all wrap-review fix/record commits. No pushes, no PRs; the final
gate (broad suites) runs separately.
