# Fix log — pbh-20260807

## F1 — freshAgent WS control messages silently dropped  [CONFIRMED, LANDED 6c5f9ad86]
- Promise: in freshclaude, Approve/Deny a tool, answer a question, fork/compact — it takes effect.
- Observed: approval.respond / question.respond / fork / compact hit a silent `_ => true` catch-all in
  crates/freshell-ws/src/terminal.rs (dispatch :524, catch-all :951); no handler anywhere in Rust →
  click Approve → nothing happens, pane wedges. Severity S2/S3 (blocked + wrong-silent).
- Fix: intercept the 4 frames, log warn, answer freshAgent.error{UNSUPPORTED_MESSAGE} → client renders a
  visible pane error (fails loudly, not silently). Catch-all comment corrected.
- Test: crates/freshell-ws/tests/freshagent_control_reply.rs (4 tests) — RED verified via git stash, GREEN after.
- Verify: cargo test -p freshell-ws lib 421/421; e2e failures identical to untouched baseline (environmental).
- Review: PASS (independent, cold, promise+repro only) — confirmed the pre-fix silent drop, test non-vacuous (4 frames time out pre-fix), no regressions, "fail loudly with visible pane error" judged a legitimate satisfaction since the approval channel is genuinely out of scope in this port.

## F2 — idle reaper silently kills detached background terminals  [CONFIRMED, LANDED 082206711]
- Promise: detached/background terminals keep running (tmux-like); "PTY keeps running and buffering".
- Observed: TerminalRegistry::enforce_idle_kills (crates/freshell-terminal/src/registry.rs) treats "detached" as
  subscribers.is_empty(), so a mere socket drop (browser closed / laptop asleep / network blip) = SIGKILL after
  DEFAULT_AUTO_KILL_IDLE_MINUTES=15; UI slider min=5 so a user cannot disable it. Scrollback + running session lost.
  Severity S1 (silent, irreversible data loss).
- Fix: track released_by_client (explicit detach of last subscriber) vs mere disconnect; apply the existing 24h
  hard cap to disconnected-but-wanted terminals; reap only genuinely-orphaned rows at the configured threshold.
- Test: enforce_idle_kills_spares_disconnect_detached_terminal_past_threshold (+hard-cap +reattach) — RED then GREEN.
- Verify: cargo test -p freshell-terminal green (173+2+1); ws/server pre-existing e2e failures unrelated (baseline-identical).
- Review: PASS (independent) — confirmed pre-fix disconnect=reap-at-15min; fix correctly separates explicit-release from disconnect, bounds every case at 24h (no leak), flag resets on reattach (not a latch), tests non-vacuous.
- Review: pending (independent).

## F3 — provider resume after server restart (codex/opencode 404)  [AUDIT_WRONG — already fixed]
- Candidate: codex/opencode sessions unresumable after restart (snapshot only in memory).
- Adjudication: NOT a bug. All providers reconstruct from disk on the cold path — codex via sidecar
  thread/resume (freshagent/src/codex.rs:1358, doc :1287-1294 records this exact bug as ALREADY fixed),
  opencode via serve by-id (opencode_ws.rs:1024-1046), existence gate fails-open (resume_validation.rs).
  Regression tests already pin it (codex_session_ref_resume.rs, opencode_switch_rebind.rs). No change made.
- Lesson: several top-map candidates sit in freshly-hardened areas (#614 attention, #615 remote, auto-resume);
  the map surfaced real historical pain that is already addressed. Confirm-before-fix earned its keep.

## F4 — recovery inventory silently omits a whole device  [CONFIRMED, LANDED 75f641d47]
- Promise: after a server restart, the recover-my-panes offer shows everything that is on disk — never a
  silent "nothing to recover" for a recoverable workspace.
- Observed: GET /api/recovery/inventory does two separately-locked store reads
  (recovery_inventory.rs:492-500); a concurrent tabs.sync.push at the retention cap prunes a just-selected
  generation between them, and the ComponentsUnion::Missing arm dropped the WHOLE device: 200 OK,
  recoverable:false, zero log. Correlated with restart (every window re-pushes exactly when the fresh
  window fetches inventory). Severity S3 wrong-silent (contradicts the module's own "never a silent empty
  inventory" policy at recovery_inventory.rs:373-375).
- Fix: bounded per-device re-read (3 attempts; fresh overview re-selects what survives); still-incoherent
  after retries -> tracing::error + 500 via the existing fail-loud arm. Test-only injection seam for the
  interleaved prune (same idiom as INJECTED_DELETE_FAILURES); no-op in production.
- Tests: transient_prune_between_reads_never_silently_drops_a_device (RED->GREEN);
  persistent_union_incoherence_fails_loud_not_silent_empty (RED->GREEN).
- Verify: cargo test -p freshell-server fully green (558 unit + integration binaries); fmt/clippy clean.
