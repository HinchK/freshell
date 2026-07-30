# DEV-0006 spec — Code-Tracer unknowns / caveats

1. **Frozen-worktree vs main divergence.** The spec anchored against
   `.worktrees/rust-tauri-port` @ `8e7482e1` (still exists on disk); all my anchors are
   against `/home/dan/code/freshell` main (HEAD ~`7abe9bff`, working tree dirty). The
   legacy `server/` side on main is the newer Jul-8 tree, NOT the Jul-4 frozen snapshot
   the port targets — legacy ws-handler.ts/index.ts drift (`:928-950`→`:970-990`,
   `:2438-2519`→`:2528-2612`, index.ts `:322-326`→`:366-368`, `:359-365`→`:403`) may be
   partly the main-vs-snapshot delta rather than pure edit drift. I did NOT diff
   against the worktree's frozen `server/` copy.

2. **Committed vs working-tree line offsets.** All cited line numbers are working-tree.
   `terminal_tabs.rs` has an uncommitted −11-line hunk at ~:592, so committed positions of
   the codex regions below :600 are ~+11. `terminal.rs`/`lib.rs` uncommitted hunks do not
   touch cited regions. Other dirty files (`auto_resume.rs`, `backpressure.rs`,
   `create_limit.rs`, client TS files) were not inspected for codex relevance beyond the
   diff hunk headers.

3. **DEV-0008 record vs code state.** `DEVIATIONS.md:652-653` still says
   "`terminal.meta.updated` open gap", yet the Rust tree now HAS a `terminal.meta.updated`
   protocol variant, broadcast helpers, and emitters (codex_identity.rs:258,
   opencode_association.rs:194, terminal.rs create-time slice :4939-5116). I could not
   determine whether the record is stale, or whether these landed slices are considered
   partial (comments call one a "create-time slice") and the record deliberately stays
   open. Needs the WHY/WHAT agents or the DEVIATIONS history.

4. **Whether the locator-lane identity work counts as "S5".** The spec's S5 = consume the
   PROXY's candidates. What actually landed is a server-side rollout-locator lane
   (codex_locator/codex_association/codex_identity) plus a PTY-lane activity port
   (freshell-activity::codex). Whether the campaign now intends the proxy events
   (`CodexTerminalLaunch.events`, held as `_events`) ever to be consumed, or the locator
   lane supersedes them for the flag flip, is not decidable from code alone.

5. **Recovery re-plan-on-loss.** Legacy's `codexRecovery`/`deferLifecycleUntilPublished`
   (ws-handler.ts:2544-2549) — I found no Rust counterpart (consistent with the spec's
   deferral), but I did not exhaustively rule out a recovery seam elsewhere in
   freshell-codex/freshell-ws.

6. **`publishCodexSidecar` equivalent.** Legacy publishes the sidecar to the registry
   after adopt (`ws-handler.ts:2605`, `router.ts:263`). I found adopt/teardown in the Rust
   manager but no explicit `publish` step; whether that concept was deliberately folded
   into `adopt()` was not verified.

7. **Test-coverage depth not audited.** I confirmed test presence and counts
   (launch_lifecycle.rs: 16 fns, remote_proxy_relay.rs: 17 fns, side-effects/envelope
   mod tests) but did not read every test to confirm the spec's specific test list
   (e.g. "shutdown-rejects-new-plans", "ownership reaper runs on close") item-by-item.

8. **`~/freshell-scratch-006/*-codex.json` live captures** referenced by the DEV-0006
   record were not checked for existence.
