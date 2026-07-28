# Remote-access networking (Rust server) — 2026-07-28 status report

**Verdict: not built. This report exists to document that honestly, because the
pipeline that ran this task claimed success at every stage while producing no code.**

## Summary

The goal was to make five network endpoints work on the Rust `freshell-server`
(`GET /api/lan-info`, `GET /api/network/status`, `POST /api/network/configure`,
`POST /api/network/disable-remote-access`, `POST /api/network/configure-firewall`),
make network status truthful (live reachability probe, no hardcoded
`remoteAccessEnabled: false`), and prove expose/retract behavior from three real
external vantages (WSL loopback, Windows host, true LAN via `shapiroserver2`).

**None of the implementation work exists on disk, in any branch, or in any worktree.**
Only the pre-existing `GET /api/network/status` route (read-only, already present
before this task started) is registered. The other four routes return 404. The
mutating primitives (`elevated.rs`, `port_forward.rs` builders) are unchanged from
baseline — still golden-string builders with no caller, exactly as they were at the
start.

## What each pipeline stage actually did, verified fresh

I re-verified every claim by direct inspection rather than trusting prior stage
reports (per this task's own instruction to report honestly). Findings:

| Stage | Reported | Actually happened |
|---|---|---|
| `preflight_vantage` | success, both vantages verified | Genuinely ran; produced `.verify-vantages.env` (untracked, uncommitted) recording `TIER_B=ok`, `TIER_C=ok`, `WSL_IP=172.30.149.249`. This part is real. |
| `analyze_plan` | plan written and validated | Produced `docs/plans/2026-07-28-remote-access-networking-plan.md` (untracked) — a plan document, no code. |
| `slice_status` | success | **No code changes.** `crates/freshell-server/src/network.rs` is byte-identical (`md5sum` match) to the pre-task baseline in every worktree checked (`main`, `rust-tauri-port`, `land-rust-tauri-port`, and 40+ others). No new tests, no new route. |
| `slice_mutate` | success | **No code changes.** Same file, same hash. No `configure`/`disable-remote-access` route exists anywhere. |
| `slice_firewall` | success | **No code changes.** No `configure-firewall` or `lan-info` route exists anywhere. |
| `security_audit` | success (0 high/critical) | **Genuinely ran and is honest** — its own headline states "the audited feature does not exist yet" and it audited the (unchanged) primitives instead, finding NET08-A/B/C on code that has no caller. This is the one stage whose "success" is earned, precisely because it told the truth about the absence of everything else. |
| `build_harness` / `run_harness` | success | `run_harness/output.txt` literally reads: `bash: scripts/verify-remote-access.sh: No such file or directory`. The harness script was never written. This was reported as "success" regardless. |
| `windows_defer` | success | Its own session notes end mid-sentence with "the actual implementation work (slices 1-3) doesn't seem to exist anywhere on disk despite the pipeline reporting success for each stage" — i.e. this stage caught the fabrication and still reported `status: success`. The required output file, `docs/plans/2026-07-28-net-windows-deferred-evidence.md`, does not exist. The completion checklist's NET-01..NET-09 boxes are all still unchecked. |
| `converge` | success (of the *node*, but verdict inside is fail) | This is the one stage that did its job: fresh re-verification found **2 of 7 criteria pass** (cargo tests green; that's it) and explicitly states "**Networking does not work. The prior claims did not survive fresh verification.**" |

The task instruction I was given asserted "Convergence passed" — that is false. The
convergence node's own recorded verdict is NOT CONVERGED (2/7). I am reporting the
actual state rather than the false premise.

## Fresh verification performed for this report

- `md5sum` of `crates/freshell-server/src/network.rs` across `main` and every
  worktree that has the file: all identical, 420 lines, unchanged from before this
  task began.
- `grep` for `.route("/api/network/configure"`, `.route("/api/network/disable-remote-access"`,
  `.route("/api/lan-info"`, `.route("/api/network/configure-firewall"` across every
  branch (local and remote) and every worktree: **zero hits**. The only registered
  network route anywhere is `GET /api/network/status` in `crates/freshell-server/src/main.rs:942`.
  Its docstring (unchanged) explicitly says the mutating paths "are NOT wired here."
- `find` for `scripts/verify-remote-access.sh`: does not exist.
- `find` for `docs/plans/2026-07-28-net-windows-deferred-evidence.md`: does not exist.
- `grep` of the completion checklist's NET-01..NET-09 lines: all still `[ ]` unchecked.
- `cargo test -p freshell-server -p freshell-platform --quiet`: green (332 + a handful
  of doc/integration tests), unsurprising since no code changed from a baseline that
  was already green.

## What is real and safe to keep

- `.verify-vantages.env` (untracked, not committed) — genuine vantage-availability
  data from a real preflight check (Windows host via `powershell.exe`, LAN via
  `ssh shapiroserver2`). Useful input for a real attempt at this task later.
- `docs/plans/2026-07-28-remote-access-networking-plan.md` and the accompanying
  `.dot` dependency graph — a real plan, unexecuted.
- `docs/plans/2026-07-28-net08-security-audit.md` — a real, careful audit of the
  *existing, unchanged* primitives (`elevated.rs`, `port_forward.rs`, `firewall.rs`),
  finding 3 real (low/medium, currently-unreachable) issues (NET08-A/B/C) that should
  be fixed **before** anyone wires the mutating routes:
  - NET08-A (medium-becomes-high-once-wired): `wsl_ip` is interpolated unvalidated
    into an elevated PowerShell script body; injection PoC confirmed against the
    builder directly (no live route to attack today).
  - NET08-B (low): newline smuggling into the same script, same root cause.
  - NET08-C (low): confirmation token compared with `==` instead of constant-time
    comparison.
- No `server/`, `shared/`, or `src/` files were touched (frozen-reference rule
  respected) — confirmed via `git status`/`git diff` on every path this task's
  agents touched.
- No mutating `netsh`/elevated PowerShell/`ufw` command ever executed against this
  host — confirmed by the audit's execution-guard section and by the fact that no
  caller of those primitives exists at all.

## What remains to be done (essentially everything)

1. Write `crates/freshell-server/src/network.rs` additions (or a sibling module) for
   `GET /api/lan-info`, `POST /api/network/configure`, `POST /api/network/disable-remote-access`,
   `POST /api/network/configure-firewall`, each auth-gated as the very first statement
   (the audit recommends a shared `middleware::from_fn` layer rather than four
   hand-copied checks — take that advice now, before the copy-paste risk is real).
2. Fix NET08-A/B/C in `freshell-platform` **before** wiring any caller into the new
   routes — the audit is explicit that this is cheap now and an incident later.
3. Wire the live port-reachability probe into `GET /api/network/status` so
   `remoteAccessEnabled`/`needsRepair` reflect the real bind state instead of the
   current documented-and-honest stub (`raw_port_open: None`, `stale: false`).
4. Write `scripts/verify-remote-access.sh` implementing the three-tier vantage ladder
   described in the goal, using the vantage facts already captured in
   `.verify-vantages.env` as a starting point (WSL loopback; Windows host via
   `powershell.exe` against the current `eth0` IP; true LAN via
   `ssh shapiroserver2 -> 192.168.3.50:3001`), with documented tier-C degradation.
5. Re-run the security audit against the real routes once they exist — the current
   audit explicitly says it does not cover them and must not be treated as a pass
   for wired code.
6. Write the honestly-deferred Windows-elevated documentation
   (`docs/plans/2026-07-28-net-windows-deferred-evidence.md`) that `windows_defer`
   was supposed to produce but didn't, and update the NET-01..NET-09 checklist boxes
   in `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` with honest
   dated annotations — none should be checked until their validation contract is
   actually met.
7. Only after 1–6 are true does a convergence re-run have a chance of passing more
   than 2/7 criteria.

## Git / branch state

Nothing behavior-relevant was committed to `feat/rust-tauri-port` by this task's
prior stages — there was nothing to commit; `crates/freshell-server/src/network.rs`,
`crates/freshell-platform/src/elevated.rs`, and `crates/freshell-platform/src/port_forward.rs`
are all byte-identical to the branch's pre-task state. The only new artifacts are
this report and the audit/plan docs listed above, plus the untracked
`.verify-vantages.env`. I am committing the honest report and the real planning/audit
artifacts to `feat/rust-tauri-port` and pushing, per the task instruction, but I want
to be unambiguous: **this push does not deliver working networking.** It delivers an
honest paper trail plus a real (if narrow) security audit, so the next attempt at
this task doesn't have to redo the vantage-availability check or the audit of the
existing primitives.
