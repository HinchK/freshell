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

## F5 — amplifier sessions freeze with stale recency/preview (effectively invisible in history)  [CONFIRMED, LANDED 73ad20d6c]
- Promise: every past coding-agent session shows up in my history with correct recency/preview; a real session is never silently buried.
- Observed: SessionIndex re-parses only when the discovered FileStat (mtime,size) changes
  (crates/freshell-sessions/src/directory_index.rs:1342-1357), but AmplifierSource discovery statted ONLY
  metadata.json (amplifier.rs:149-168), while recency + first-message preview come from the transcript/events
  sidecars (folded at parse, amplifier.rs:379-386). Real amplifier turns/resumes append to sidecars without
  touching metadata.json -> once cached, last_activity_at + preview freeze forever -> the session sinks to the
  bottom of recency-sorted history and never resurfaces. Parity break vs Node (refreshes activityMtimeMs every
  scan). Severity S3/S4 (wrong-silent: session there but unfindable where the user looks).
- Fix: fold_activity_mtime() folds the two sidecars' mtimes (stat-only) into the discovered FileStat.mtime_ms,
  so a sidecar write invalidates the cache and refreshes recency+preview. Provider-local; one call-site.
- Test: session_index_refreshes_amplifier_recency_when_only_sidecar_changes (through the real incremental sweep) — RED (stuck at Some(1000)) -> GREEN.
- Verify: cargo test -p freshell-sessions green (lib 176; parity/resolve/locators/liveness suites). Only amplifier.rs touched.
- Review: PASS (independent) — confirmed the (mtime,size)-on-metadata-only gate froze sidecar-driven recency; fold is stat-only (no content read), test drives the REAL incremental sweep and fails pre-fix deterministically, other providers byte-identical, no churn.

## F6 — terminal.exit overtakes queued output/replay, discarding scrollback  [CONFIRMED, LANDED 108f1365b]
- Promise: what the terminal shows is what the program printed; scrollback survives detach/reattach; no lost/truncated output.
- Observed: output frames go through the bounded ConnectionOutputQueue but TerminalExit went straight to conn_tx
  (crates/freshell-ws/src/backpressure.rs route; drain arm terminal.rs:339-351 sends all direct frames before
  queued output). Attaching to an EXITED terminal → wire order ready→exit→replay; client clears terminalId on
  exit (TerminalView.tsx:4464-4527) so the replay is dropped → blank exited pane / scrollback lost on reattach.
  Deterministic. Severity S3 (wrong-silent: lost output the program actually produced).
- Fix: route TerminalExit through the same per-connection FIFO as output via new push_sequenced() (zero-weight,
  non-evictable, keeps FIFO slot; overflow eviction skips sequenced frames). Preserves output→exit order
  unconditionally; attach.ready-before-replay untouched. 2 files.
- Tests: terminal_exit_never_overtakes_queued_output (RED→GREEN) + 2 output_queue mechanism tests.
- Verify: cargo test -p freshell-terminal -p freshell-ws green (175/175, lib 422/422); auto_resume_e2e 2 failures baseline-identical (pre-existing).
- Review: PASS (independent) — confirmed the deterministic ready→exit→replay inversion (direct exit vs queued output, drain sends direct first) and the blank-exited-pane consequence; fix preserves output→exit FIFO order, sequenced frame non-evictable/zero-weight/can't be lost, eviction+gap accounting intact, attach.ready ordering held; test fails pre-fix.

## F7 — opencode locator can silently bind a pane to the WRONG session  [CONFIRMED, LANDED 5aeae9c10]
- Promise: resuming/attaching a coding session gives ME my session — never silently bound to another pane's or a fresh-agent's session.
- Observed: opencode locator drain (crates/freshell-ws/src/opencode_association.rs:105-133) adopted a Located
  candidate WITHOUT the claim guards codex pins as required misbind hardening (codex_identity.rs:128-179) and that
  the opencode signal lane already has; and OpencodeLocator::resolve_windows (crates/freshell-sessions/src/opencode_locator.rs:284-366)
  had no contested-cwd census. Two same-cwd opencode panes (or a fresh-agent opencode serve sharing opencode.db)
  → one new session row visible to ≥2 windows binds to whichever pane evaluates first → wrong conversation resumes
  later, silently. Severity S3 (wrong-silent, near-undiagnosable).
- Fix: mirror codex's guards — contested-cwd census (a sole candidate shared by ≥2 same-cwd contenders binds nobody;
  no starvation of a solo contender) + drain-side claim refusal (bound-elsewhere incl. retired, fresh-agent live
  session, durable fresh-agent ledger row), all warn-logged not silent.
- Tests: located_session_bound_elsewhere_is_rejected, located_freshagent_known_session_is_rejected,
  one_row_inside_two_same_cwd_windows_binds_neither_terminal, solo_enter_still_binds_when_same_cwd_sibling_has_no_open_window — RED→GREEN.
- Verify: freshell-sessions green (178 lib+integration); freshell-ws 424 lib green, integration failures baseline-identical (env-dependent e2e).
- Review: PASS (independent) — confirmed opencode lacked codex's misbind guards; census + drain refusal mirror codex one-for-one (with the correct !resolved translation for opencode's spawn-window), tests fail pre-fix, no starvation of a solo contender, rightful owner never rejected, all refusals warn-logged.

## F8 — freshclaude pane wedged "working" forever after unrequested sidecar death  [CONFIRMED, LANDED f401dd7d0]
- Promise: freshclaude/freshcodex/freshopencode chat behaves consistently; one provider isn't silently broken where others work.
- Observed: member asymmetry — when the claude/kilroy sidecar dies UNREQUESTED mid-turn (crash/OOM/SIGKILL), the
  claude adapter's stdout consumer evicted the session in TOTAL SILENCE (crates/freshell-freshagent/src/claude.rs:1190-1220),
  so the pane stays "working"/streaming forever. codex (codex.rs:3289-3311 exit watcher) and opencode
  (opencode_ws.rs:721-723 unconditional idle) both self-heal; Node reference broadcasts idle on claude stream death too.
  Severity S2/S3 (blocked + wrong-silent).
- Fix: in the unrequested-death (evicted) branch only, broadcast one freshAgent.error{SIDECAR_EXITED} stamped with the
  session broadcast_id; client folds it to a visible banner + running/streaming->idle. No false completion chime
  (ADR 2.1 "death never yields false completion" preserved). Matches the sibling adapters. claude.rs only.
- Test: unrequested_sidecar_death_broadcasts_a_pane_unwedging_error (SIGKILL child directly, not via handle_kill) — RED->GREEN.
- Verify: cargo test -p freshell-freshagent — 334 pass; the 24 failures are pre-existing terminal_tabs e2e, byte-identical to baseline. claude:: module 34/34 green.
- Review: PASS (independent) — confirmed claude was the one silent provider on unrequested death (codex exit-watcher + opencode unconditional idle both self-heal); exactly-once frame structurally guaranteed (remove-before-signal on every requested path + identity guard), no false completion, envelope stamped to the pane's current durable id, test SIGKILLs the child directly and times out pre-fix.

## Holistic fresh-eyes review of the full changeset (superpowers:code-reviewer, cold, 2 iterations)
- Iteration 1: FAIL — 2 CI-gate blockers in the changeset's own new test code (cargo fmt violations in
  recovery_inventory_tests.rs; clippy len_zero in a claude.rs test assertion) + 1 stale TERM-09 comment in
  ws/terminal.rs still claiming terminal.exit bypasses the output queue (contradicted the F6 invariant).
  All fixed + verified (fmt --all --check green, clippy --workspace --all-targets -D warnings green,
  targeted tests green) in 4ee87cb03.
- Iteration 2: PASS (APPROVED) — fresh cold session; reviewer independently re-ran fmt/clippy/targeted suites
  (freshell-terminal 178, freshell-sessions 269, recovery_inventory 20, ws backpressure/association 16,
  freshagent_control_reply 5, claude:: 34 — all green; terminal_tabs failures = pre-declared env baseline).
  Zero blocking, zero important issues. Nice-to-haves noted for PR description: wire-string helpers could
  derive from serde; one-device incoherence 500s the whole recovery inventory (documented fail-loud choice);
  fold_activity_mtime adds 2 stats/session/sweep (matches Node cost profile).
