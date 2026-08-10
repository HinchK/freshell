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

<!-- Round 2+ records go below. -->
