# Send-During-Compact Queue Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
A message typed into a freshopencode pane while that pane's compaction is still running is queued server-side in the Rust freshopencode runtime and automatically sent once the compaction finishes, instead of being refused with "send while a compact is in progress is not supported" — the user's typed message is never lost.

### Explicit constraints
- Server-side FIFO pending-send queue in crates/freshell-freshagent (Rust), restoring the retired Node adapter's sendQueue semantics for the send-during-compact direction only.
- Queued messages drain one at a time after the compact drive settles, on compact success AND failure.
- freshAgent.kill (pane close/retire) drops queued messages; an interrupted compact still drains them afterward.
- The captured ownership fence (observed epoch/generation) is re-validated at drain time so stale queued sends stay typed-refused.
- Any remaining refusal path is request-correlated (reply error carrying the requestId), never an uncorrelated session-scoped broadcast.
- A structured WARN log records every queueing and queue-drop.
- Red/green/refactor TDD throughout: unit tests in the freshell-freshagent crate for queue semantics, and browser e2e coverage of the pane behavior; affected e2e specs must pass on the configured cloud backend.
- The client-side UX queue stays unchanged (two-queue design is intentional: client queue for UX, server queue as correctness boundary).
- The compact-during-turn refusal ("compact while a turn is in progress is not supported") is not changed by this run.
- All work in a worktree branch from origin/main; no commits to main; no PR without explicit user approval.

### Accepted tradeoffs and residuals
- A send can still slip past the client queue in the busy-status race window; landing in the server-side pending queue is the designed behavior, not a defect.

**Goal:** A freshAgent.send that arrives while the session's compact drive is in flight — or while older queued sends are still pending — is parked in a per-session FIFO queue (with an immediate `freshAgent.send.accepted` and a WARN), and the drain machinery automatically re-drives exactly one queued send at a time; kill/handoff drop the queue with a WARN per entry; drain-time refusals are request-correlated and fence-validated.

**Architecture:** The queue is a `VecDeque<FreshAgentSend>` field on `OpencodeSession`, guarded by the existing per-session mutex (no new locks, no lock-order changes). The queue point replaces the refusal arm at `handle_send` (opencode_ws.rs:1479-1493): a send queues when a compact drive is in flight (the original refusal condition, including its settling tail — a settling compact still owns FIFO ordering) OR when older entries are still queued (a fresh send must never jump ahead of a pending one — the client fires one send the moment the compact's idle broadcast clears its flush gate). Queueing broadcasts `freshAgent.send.accepted` immediately (the client's echo/accepted machinery is audited to tolerate accepted-now-driven-later) and every push arms a detached drain (a no-op when a live drive exists — the self-healing sliver closer). `handle_send`'s post-gate body is extracted into `send_locked` so the drain re-enters the exact send path with `already_accepted = true` (the accepted frame never double-fires). Because the drain's three triggers run inside the very tasks that `turn_task` still names — and tokio's `JoinHandle::is_finished()` stays false until the future returns — `TurnTask` gains a `settling: Arc<AtomicBool>` that each drive task flips at the START of its settle tail; the drain's in-flight gate is `!t.is_finished() && !t.settling.load()`, so a task's own tail passes its own registration while a genuinely live OTHER drive still blocks (the no-stacking/orphaning rule). The three drain triggers: the compact drive's settle tail (after `settle_turn_outcome` — runs on success AND failure), the send drive's settle tail (advances the FIFO), and `handle_interrupt` after the aborted compact settles (the aborted task's own tail never runs). `handle_kill` phase 3 and `opencode_kill_for_handoff` clear the queue under their existing session-lock sections with one WARN per dropped entry. The existing `is_finished()` readers at :3595 (compact busy gate), :4596 (rollback BUSY_TURN), :5213/:5483 (attach status labels) are untouched — `settling` is consulted ONLY by the drain gate. The client needs no changes (audited: FreshAgentView's echo/accepted/re-poll machinery fully tolerates immediate-accept + later-drive). Design evidence: `.worktrees/.the-usual-logs/send-during-compact-queue/reports/{plan-send-compact-architecture,plan-lifecycle-paths,plan-client-send-flow,load-bearing-finder,load-bearing-strategist}.md`.

**Tech Stack:** Rust (tokio, tracing), crates/freshell-freshagent + freshell-protocol; Playwright e2e (test/e2e-browser) with the fake-opencode fixture; no client-side changes.

## Global Constraints

- All line numbers refer to commit 855dae72a (`crates/freshell-freshagent/src/opencode_ws.rs`, 18,084 lines). Adapt harmless drift when the intent is clear.
- Lock discipline (pinned by tests at :9199/:9287): the sessions-map guard is NEVER held across a per-session lock acquisition; session→map is the one permitted pair. Every new code path below takes the session mutex exactly like the existing handlers.
- Every refusal for a `freshAgent.send` request must use `send_error(&request_id, code, message)` (opencode_ws.rs:826-842 — the top-level `error` frame the client correlates by requestId at FreshAgentView.tsx:2356-2414), never `emit_fresh_agent_error` (:686-696 — session-scoped nested broadcast). SCOPE: this binds the send-during-compact path's refusals (the queue arm's fence parse, every drain-time refusal, the killed/close_pending gate). The PRE-EXISTING first-send materialization arms (nested SESSION_RESERVED / LEDGER_WRITE_FAILED broadcasts at :1670-:1883) are out of scope: they have their own intentional client recovery (the SESSION_RESERVED redrive at FreshAgentView.tsx:2315-2326, markSessionLost for INVALID_SESSION_ID) and belong to a different feature lane.
- The compact-during-turn refusal (:3595-3605) is NOT touched. The client (src/) is NOT touched.
- Structured WARNs use `tracing::warn!(target: "freshell_freshagent::opencode", …)` (precedents :1512-1517, :3917-3923). WARN-capture assertions use the crate's existing `info_capture::capture()` facility (:6786-6797 → `(Arc<Mutex<Vec<CapturedEvent{message, fields}>>>, DefaultGuard)`; user precedent :6807-6851) — the request id is a structured FIELD, never message text.
- Test-facility facts (pinned by the load-bearing finder, report `load-bearing-finder.md`): `insert_compact_session` is ASYNC (:12991-12998 — every call needs `.await`); `compact_state_gated(config_body: &str, …)` (:12935-12987 — pass e.g. `r#"{"model":null}"#`); `send_msg_fenced(…, Option<u64>, Option<u64>)` (:6868-6886); there is NO `kill_msg`/`interrupt_msg` helper — build `FreshAgentKill`/`FreshAgentInterrupt` inline exactly as :15293-15300/:15353-15358 do; `fenced_observed(&registry, id) -> (Option<u64>, Option<u64>)` (:11413-11419); `seed_live_fresh_owner` (:11421-11452); `CompactFakeHttp` has NO bounded prompt waiter (only sync `recorded()` :12753 / `summarize_requests()` :12757) — Task 2 adds one modeled on `await_summarize_posted` (:15172-15181).
- Focused Rust command: `cargo test -p freshell-freshagent --lib <filter> --locked` (narrowed selectors are uncoordinated).
- The new e2e test must NOT be added to `CLOUD_SKIP_SPECS` (test/e2e-browser/playwright.cloud.config.ts:30-76) and must pass on the cloud backend (scoped cloud runs take POSITIONAL spec paths — `npm run test:e2e:cloud -- test/e2e-browser/specs/<spec>.ts`).

---

### Task 1: Queue the send at the compact-in-flight seam (field + immediate accept + WARN)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (struct `OpencodeSession` ~:317-397; ctor ~:414-438; `handle_send` gate ~:1479-1493; fence parse currently at :1507-1521)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (replace `send_during_an_in_flight_compact_is_refused_and_leaves_the_compact_owned` at :15401-15507)

**Interfaces:**
- Consumes: `FreshAgentSend` (freshell-protocol, client_messages.rs:809-830; already `Clone`), `FreshAgentSendAccepted` (server_messages.rs:832-841), `wire_fence` (lib.rs:338-347), `send_error` (:826-842).
- Produces: `OpencodeSession.pending_sends: VecDeque<FreshAgentSend>` (used by Tasks 2-4).

**Step 1: Write the failing behavioral test** — replace the refusal test at :15401 with the queue-semantics test (keep its compact-ownership and kill-tail invariants where noted):

```rust
#[tokio::test]
async fn send_during_an_in_flight_compact_is_queued_accepted_and_leaves_the_compact_owned() {
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        r#"{"model":null}"#,
        SummarizeOutcome::OkAnswered,
        Some(summarize_gate.clone()),
        None,
    )
    .await;
    insert_compact_session(&st, "ses_q1", Some("prov/model")).await;
    // The compact drive: parked summarize = deterministic in-flight window.
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q1")),
    )
    .await
    .expect("handle_compact returns after registering the detached drive");
    await_summarize_posted(&http).await;

    // WARN capture: the crate's real facility (user precedent :6807-6851).
    let (events, _guard) = info_capture::capture();

    // THE SEND — arrives while the compact drive is in flight.
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q1", "queued text")),
    )
    .await
    .expect("handle_send queues inline (no refusal path)");

    // (1) The client contract: immediate `freshAgent.send.accepted` with the
    // original requestId (send_msg mints request_id = Some("req-queued text")).
    let frames = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted").await;
    assert!(
        frames
            .iter()
            .any(|f| f["requestId"] == "req-queued text"),
        "accepted carries the send's original requestId"
    );

    // (2) NO refusal: the D2-F1 nested INTERNAL_ERROR broadcast is gone.
    assert!(
        !drain_frames(&mut rx)
            .iter()
            .any(|f| is_event(f, "freshAgent.error", None)
                && f["event"]["code"] == "INTERNAL_ERROR"),
        "the refusal must not fire — the send is queued"
    );

    // (3) NO prompt POST left the building while the compact is parked.
    assert!(
        !http
            .recorded()
            .iter()
            .any(|r| r.url.contains("prompt_async")
                && r.body.to_string().contains("queued text")),
        "the queued send must NOT POST while the compact is in flight"
    );

    // (4) The compact's turn_task is untouched (the original test's
    // ownership invariant, kept) and the send is parked FIFO.
    {
        let session_arc = st
            .sessions
            .lock()
            .await
            .get("ses_q1")
            .cloned()
            .expect("session present");
        let session = session_arc.lock().await;
        assert!(
            session
                .turn_task
                .as_ref()
                .is_some_and(|t| t.kind == TurnTaskKind::Compact && !t.is_finished()),
            "the compact still owns the session's turn_task"
        );
        assert_eq!(
            session.pending_sends.len(),
            1,
            "the send is parked in the FIFO queue"
        );
    }

    // (5) The structured WARN named the queueing (message + field).
    {
        let captured = events.lock().unwrap();
        assert!(
            captured
                .iter()
                .any(|e| e.message.contains("fresh_agent_send_queued_behind_compact")),
            "queueing is observable in the structured log"
        );
    }

    // (6) The kill tail of the replaced test stays: a kill mid-compact
    // aborts the compact with no fabricated freshAgent.turn.complete and
    // lands freshAgent.killed (kill also drops the queue — Task 3 adds the
    // dropped-entry WARN).
    // … keep the replaced test's kill assertions here verbatim (the
    // inline FreshAgentKill literal at :15293-15300 is the message shape) …
}
```

(`info_capture` is the in-file test module's name for the capture facility at :6786-6797 — use its actual path; `CapturedEvent` exposes `message` and `fields`.)

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::send_during_an_in_flight_compact_is_queued --locked`

Expected: FAIL — make the struct/ctor additions from Step 3 first so it compiles; then the failure is the intended one: the current code refuses (`freshAgent.error{INTERNAL_ERROR}` arrives, no `send.accepted`, nothing queued).

**Step 3: Add the minimal production implementation**

(a) Field on `OpencodeSession` (after `turn_task`, ~:333):

```rust
    /// send-during-compact queue: a `freshAgent.send` arriving while the
    /// session's `turn_task` is an in-flight COMPACT — or while older
    /// entries are still queued — is parked here (FIFO, under this same
    /// session mutex) instead of being refused. The retired Node adapter
    /// chained both onto `state.sendQueue` (adapter.ts:825-829); the D2-F1
    /// refusal this replaces dropped the user's typed message (the
    /// composer stays interactive, so the busy-status race makes the seam
    /// reachable by design). The entry is the complete wire message: the
    /// drain (compact settle tail / send settle tail / handle_interrupt /
    /// the push-armed drain) re-enters the send path with it.
    /// `freshAgent.kill` and the handoff prior-stop drop the queue (WARN
    /// per entry); the drain re-checks the killed/close_pending gates
    /// before every re-drive.
    pending_sends: std::collections::VecDeque<FreshAgentSend>,
```

and in `OpencodeSession::new` (~:427): `pending_sends: std::collections::VecDeque::new(),` (add `use std::collections::VecDeque;` to the module imports if absent).

(b) Move the fence-parse block (verbatim, :1507-1521) to BEFORE the compact gate, still inside the lock: a half-sent fence is refused immediately, request-correlated — garbage must never enter the queue. The parsed `send_fence` then feeds the queue arm's fall-through and (until Task 2 extracts `send_locked`) stays in scope for the existing materialization claim at :1642.

(c) Replace the refusal arm (:1479-1493) with the queue arm:

```rust
        // send-during-compact queue: a send arriving while a COMPACT is in
        // flight — including the compact's settling tail (the tail is
        // still the compact's FIFO turn; Task 2's settling-flag gate
        // decides when a drain may act) — or while older entries are still
        // queued (a fresh send must never jump ahead of a pending one:
        // the client fires one send the moment the compact's idle
        // broadcast clears its flush gate) is QUEUED (FIFO) instead of
        // refused. Queue-time side effects are ONLY the client
        // contract's immediate `freshAgent.send.accepted` (the exact
        // shape the normal path broadcasts, request_id preserved,
        // submitted_turn_id: None) and the structured WARN: every other
        // side effect happens at DRAIN time with `already_accepted =
        // true` so the frame never double-fires. The push and the
        // compact's `turn_task` registration (:3935) share this session
        // mutex, so the in-flight observation is exact.
        if session
            .turn_task
            .as_ref()
            .is_some_and(|t| t.kind == TurnTaskKind::Compact && !t.is_finished())
            || !session.pending_sends.is_empty()
        {
            let real_id = session
                .real_session_id
                .clone()
                .unwrap_or_else(|| session.placeholder_id.clone());
            self.broadcast(&ServerMessage::FreshAgentSendAccepted(
                FreshAgentSendAccepted {
                    provider: PROVIDER.to_string(),
                    request_id: msg.request_id.clone().unwrap_or_default(),
                    session_id: real_id,
                    session_type: SESSION_TYPE.to_string(),
                    cwd: session.cwd.clone(),
                    submitted_turn_id: None,
                },
            ));
            session.pending_sends.push_back(msg.clone());
            tracing::warn!(target: "freshell_freshagent::opencode",
                session_id = %session_id,
                request_id = ?msg.request_id,
                queued_depth = session.pending_sends.len(),
                "fresh_agent_send_queued_behind_compact");
            // Task 2 appends the push-armed detached drain here
            // (`this.drain_pending_sends`) — the self-healing sliver
            // closer. In THIS task the parked entry simply waits for the
            // drain machinery the next task adds.
            return;
        }
```

**Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::send_during_an_in_flight_compact_is_queued --locked`

Expected: PASS.

**Step 5: Refactor while green** — extract the accepted-broadcast into a tiny private helper used by both the queue arm and the normal path (dedupe the `FreshAgentSendAccepted` construction):

```rust
    fn broadcast_send_accepted(&self, session_id: &str, request_id: &Option<String>, cwd: &Option<String>) {
        self.broadcast(&ServerMessage::FreshAgentSendAccepted(FreshAgentSendAccepted {
            provider: PROVIDER.to_string(),
            request_id: request_id.clone().unwrap_or_default(),
            session_id: session_id.to_string(),
            session_type: SESSION_TYPE.to_string(),
            cwd: cwd.clone(),
            submitted_turn_id: None,
        }));
    }
```

**Step 6: Run impacted-test verification**

The queue arm, the fence-parse move, and the field touch every send-path test: run the whole crate.

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (the replaced refusal test is the only intentional deletion; `compact_while_a_turn_is_in_flight_is_refused_and_never_posts` :15194 must stay green).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): queue freshopencode sends during an in-flight compact (FIFO field + immediate accept + WARN)"
```

---

### Task 2: Drain the queue — settling flag, settle-tail/interrupt hooks, push-armed drain (FIFO, one at a time)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`TurnTask` :202-210; `handle_send` body → `send_locked` extraction ~:1507-2024; `handle_compact` drive task ~:3751-3934; send drive task ~:1976-2019; `handle_interrupt` ~:3459-3475; the Task 1 queue arm)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new tests beside the Task 1 test; mechanical updates to the three planted-TurnTask literals :7758/:15201/:16818)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 1).
- Produces:
  - `TurnTask { kind, handle, compact_settled_rx, settling: Arc<AtomicBool> }` — the settle-tail marker each drive task flips before its tail (tokio's `JoinHandle::is_finished()` stays false until the future returns, so a task's own registration would otherwise trip the drain gate — the load-bearing finder's Critical finding, reports/load-bearing-finder.md + load-bearing-strategist.md);
  - `async fn send_locked(&self, session_arc: &Arc<TokioMutex<OpencodeSession>>, session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>, msg: FreshAgentSend, session_id: String, send_fence: Option<crate::ownership_lane::ObservedFence>, already_accepted: bool)`;
  - `async fn drain_pending_sends(&self, lookup_id: &str)`;
  - test-only: `await_prompt_posted(&http, text)` bounded async waiter on the compact fake's recordings.

**Step 1: Write the failing behavioral tests**

The FIFO test below doubles as the self-deadlock red: without the `settling` flag, the compact tail's drain trips over its own still-registered task and the queued prompts NEVER post — the test fails for exactly that reason.

```rust
#[tokio::test]
async fn a_queued_send_drains_after_the_compact_settles_in_fifo_order() {
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q2", Some("prov/model")).await;
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q2"))).await.expect("compact registers");
    await_summarize_posted(&http).await;

    // TWO queued sends — FIFO order is the assertion target.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "first queued"))).await.expect("queues inline");
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "second queued"))).await.expect("queues inline");

    // Both accepted at queue time.
    let frames = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted").await;
    assert!(frames.iter().any(|f| f["requestId"] == "req-first queued"));
    assert!(frames.iter().any(|f| f["requestId"] == "req-second queued"));

    // Release: the compact POST answers, the drive settles, the drain runs.
    summarize_gate.notify_waiters();

    // (1) BOTH prompt POSTs land — in queue order, after the summarize
    // (bounded async waits: the POSTs happen inside spawned tasks —
    // never assert them against a fixed sleep).
    await_prompt_posted(&http, "first queued").await;
    await_prompt_posted(&http, "second queued").await;
    let recorded = http.recorded();
    let summarize_ix = recorded.iter().position(|r| r.url.contains("summarize"))
        .expect("summarize POST recorded");
    let first_ix = recorded.iter().position(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("first queued"))
        .expect("first queued send drained");
    let second_ix = recorded.iter().position(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("second queued"))
        .expect("second queued send drained");
    assert!(summarize_ix < first_ix, "drain waits for the compact settle");
    assert!(first_ix < second_ix, "FIFO order");

    // (2) The queue drains completely and the pane settles idle.
    let _ = frames_until(&mut rx, |f| is_event(f, "freshAgent.session.snapshot", Some("idle"))).await;
    let session_arc = st.sessions.lock().await.get("ses_q2").cloned().unwrap();
    assert!(session_arc.lock().await.pending_sends.is_empty());
}

#[tokio::test]
async fn a_send_arriving_behind_pending_queue_entries_appends_fifo() {
    // MUST #4 (the client contract): a fresh send arriving while older
    // entries are still queued appends — never drives ahead of them.
    // The exact window: a live (unsettled) SEND drive with an
    // already-queued entry the drain has not popped yet.
    let (st, _http, _rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, None, None).await;
    insert_compact_session(&st, "ses_q2b", Some("prov/model")).await;
    let session_arc = st.sessions.lock().await.get("ses_q2b").cloned().unwrap();
    {
        let mut session = session_arc.lock().await;
        // Plant the live SEND drive + the pending older entry white-box
        // (same-crate test style): the drain has not popped it.
        session.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
            settling: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        session.pending_sends.push_back(send_msg("ses_q2b", "older entry"));
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2b", "newer entry"))).await
        .expect("appends behind pending entries");
    let session = session_arc.lock().await;
    let texts: Vec<String> = session.pending_sends.iter()
        .map(|m| m.text.clone()).collect();
    assert_eq!(texts, vec!["older entry".to_string(), "newer entry".to_string()],
        "a send behind pending queue entries appends in FIFO order");
}

#[tokio::test]
async fn a_settling_registration_does_not_block_the_drain_but_a_live_one_does() {
    // The settling-flag gate semantics, planted deterministically.
    let (st, _http, _rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, None, None).await;
    insert_compact_session(&st, "ses_q2c", Some("prov/model")).await;
    let session_arc = st.sessions.lock().await.get("ses_q2c").cloned().unwrap();
    // (a) live (unsettling) registration → the drain returns without popping.
    {
        let mut session = session_arc.lock().await;
        session.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Compact,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
            settling: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        session.pending_sends.push_back(send_msg("ses_q2c", "held"));
    }
    st.drain_pending_sends("ses_q2c").await;
    assert_eq!(session_arc.lock().await.pending_sends.len(), 1,
        "a live registration blocks the drain");
    // (b) settling registration → the drain pops and drives.
    {
        let mut session = session_arc.lock().await;
        session.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Compact,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
            settling: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        });
    }
    st.drain_pending_sends("ses_q2c").await;
    assert!(session_arc.lock().await.pending_sends.is_empty(),
        "a settling registration is past its outcome — the drain proceeds");
}
```

```rust
#[tokio::test]
async fn an_interrupted_compact_still_drains_the_queued_send() {
    // Same rig; park the compact, queue one send, then interrupt. The
    // aborted compact's own settle tail NEVER runs (TurnTask doc
    // :199-201), so the drain must fire from handle_interrupt after
    // abort_and_settle — the queued prompt POST is the proof.
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, _rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q3", Some("prov/model")).await;
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q3"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q3", "survives the interrupt"))).await;
    // The inline FreshAgentInterrupt literal the :15333-15400 interrupt
    // test uses (same field shape, adapted to ses_q3).
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_interrupt(FreshAgentInterrupt { /* inline literal per :15353-15358 */ })).await
        .expect("interrupt answers");
    await_prompt_posted(&http, "survives the interrupt").await;
}

#[tokio::test]
async fn a_queued_send_drains_after_a_failed_compact_too() {
    // Same rig with SummarizeOutcome::Answered500 + the gate: queue a send
    // while parked, release, the compact FAILS — the settle tail still
    // runs → the drain still fires.
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::Answered500, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q4", Some("prov/model")).await;
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q4"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q4", "drains past the failure"))).await;
    summarize_gate.notify_waiters();
    // The failure is LOUD (pre-existing), and the queued send STILL drains.
    let _ = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)
        && f["event"]["code"] == "OPENCODE_COMPACT_FAILED").await;
    await_prompt_posted(&http, "drains past the failure").await;
}
```

Mechanical ripple: the three existing planted-TurnTask test literals (:7758, :15201, :16818) gain `settling: Arc::new(std::sync::atomic::AtomicBool::new(false))` (and any other literal the compiler flags).

**Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains opencode_ws::tests::a_settling_registration opencode_ws::tests::an_interrupted_compact_still --locked`

Expected: FAIL — `TurnTask` has no `settling` field (compiles only after the struct change); with the struct change alone, the FIFO test fails because the drain gate trips over the calling task's own registration (the self-deadlock), the settling test fails at assertion (a), and the interrupt test times out on `await_prompt_posted` (which does not exist yet — add the test helper first; its absence is a compile error, the intended red is the assertions).

**Step 3: Add the minimal production implementation**

(a) **`TurnTask` gains the settle marker** (:202-210):

```rust
struct TurnTask {
    kind: TurnTaskKind,
    handle: tokio::task::JoinHandle<()>,
    /// … (existing compact_settled_rx doc unchanged) …
    compact_settled_rx: Option<tokio::sync::oneshot::Receiver<()>>,
    /// Settled-outcome marker (send-during-compact queue): the drive task
    /// flips this at the START of its settle tail. tokio's
    /// `JoinHandle::is_finished()` stays false until the task's future
    /// RETURNS — so a settle tail that consults the session's `turn_task`
    /// would otherwise trip over its OWN registration. The drain's
    /// in-flight gate is `!t.is_finished() && !t.settling.load(SeqCst)`: a
    /// settling registration is provably past its outcome (its own drain
    /// is next, or kill/interrupt own the queue), while a LIVE unsettled
    /// drive still blocks — the no-stacking/orphaning rule. Consulted
    /// ONLY by the drain gate: :3595 (compact busy), :4596 (rollback
    /// BUSY_TURN), :5213/:5483 (attach labels) keep reading
    /// `is_finished()` alone.
    settling: Arc<std::sync::atomic::AtomicBool>,
}
```

(b) **Spawn-site plumbing** — at the send spawn (in the extracted `send_locked`) and the compact spawn (:3775): create `let settling = Arc::new(std::sync::atomic::AtomicBool::new(false));`, clone it into the task (`let settling_task = Arc::clone(&settling);`), store the Arc in the `TurnTask` literal (:2020/:3935). In each drive task, the FIRST statement of the settle tail sets it:

- send task — after `let result = manager.run_turn(…).await;` resolves:
  `settling_task.store(true, Ordering::SeqCst);`
- compact task — immediately after the result match closes (:3878), BEFORE the disarm match, `settle_turn_outcome`, and every broadcast:
  `settling_task.store(true, Ordering::SeqCst);`

(c) **Extract `send_locked`** — move `handle_send`'s entire post-gate body (flag resets → … → run_turn spawn → `turn_task` registration, :1507-2024 as originally numbered) into:

```rust
    /// The post-gate send body (flag resets → … → run_turn spawn →
    /// turn_task registration), extracted from `handle_send` so the
    /// send-during-compact drain re-enters the EXACT send path for a
    /// queued entry. CONTRACT: the caller HOLDS this session's mutex for
    /// the whole call (the same discipline the inline body had — the
    /// session→map lock pair stays the only permitted ordering).
    /// `already_accepted` suppresses the `freshAgent.send.accepted`
    /// broadcast when the queue arm already emitted it (never
    /// double-fire).
    async fn send_locked(
        &self,
        session_arc: &Arc<TokioMutex<OpencodeSession>>,
        session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>,
        msg: FreshAgentSend,
        session_id: String,
        send_fence: Option<crate::ownership_lane::ObservedFence>,
        already_accepted: bool,
    ) {
        // … the moved body, with exactly three edits:
        // (1) request_id/session_id derive from the params;
        // (2) the accepted broadcast (:1959-1968) becomes
        //     if !already_accepted { self.broadcast_send_accepted(
        //         &acked_session_id, &request_id, &route); }
        // (3) the spawned drive task gains the settling Arc (b) and the
        //     drain hook (e) below. Registration and return stay identical.
    }
```

`handle_send` becomes: map lookup → session lock → killed/close_pending gate → fence parse → queue arm (Task 1; Task 2 appends the push-armed drain, (f)) → `self.send_locked(&session_arc, &mut session, msg, session_id, send_fence, false).await`.

(d) **The drain function:**

```rust
    /// Send-during-compact drain: drives at most ONE queued send (FIFO)
    /// when the session is quiescent; the driven send's own settle tail
    /// re-invokes this for the next entry (one at a time). Triggers:
    /// (a) the compact drive's settle tail — success AND failure;
    /// (b) the send drive's settle tail; (c) `handle_interrupt` after the
    /// aborted compact settles (the aborted task's tail never runs);
    /// (d) the queue arm's push-armed spawn (the self-healing sliver
    /// closer: a push landing behind a settling/finished registration
    /// with no upcoming tail gets drained immediately; a no-op when a
    /// live drive exists). The in-flight gate uses the `settling` marker
    /// so a tail never trips over its OWN registration. Refused entries
    /// are discarded with a request-correlated `send_error` (the
    /// client's owned-failure cleanup correlates by requestId) and the
    /// drain continues with the next entry. Kill and the handoff stop
    /// DROP the queue instead — the killed/close_pending re-check here
    /// is the belt-and-braces gate for a drain racing those paths'
    /// lock sections.
    async fn drain_pending_sends(&self, lookup_id: &str) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(lookup_id).cloned()
        };
        let Some(session_arc) = session_arc else { return };
        let mut session = session_arc.lock().await;
        loop {
            if session.killed.load(Ordering::SeqCst) || session.close_pending > 0 {
                return;
            }
            if session
                .turn_task
                .as_ref()
                .is_some_and(|t| !t.is_finished() && !t.settling.load(Ordering::SeqCst))
            {
                return; // a live drive's settle tail is the next trigger
            }
            let Some(msg) = session.pending_sends.front().cloned() else { return };
            let real_id = session
                .real_session_id
                .clone()
                .unwrap_or_else(|| msg.session_id.clone());
            let send_fence = match crate::ownership_lane::wire_fence(
                msg.observed_epoch,
                msg.observed_generation,
            ) {
                Ok(fence) => fence,
                Err(err) => {
                    session.pending_sends.pop_front();
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        session_id = %lookup_id, request_id = ?msg.request_id,
                        "fresh_agent_send_drain_refused: half-sent observed fence");
                    self.send_error(&msg.request_id, err.code(), err.message());
                    continue;
                }
            };
            // (Task 4 inserts the coordinator staleness consult here.)
            session.pending_sends.pop_front();
            self.send_locked(&session_arc, &mut session, msg, real_id, send_fence, true).await;
            return; // one entry driven; its settle tail continues the FIFO
        }
    }
```

(e) **Hook — the compact drive's settle tail.** Before the `tokio::spawn` at :3775 add `let this = self.clone();` (move into the task); inside the task, after the failure WARN/error-broadcast block (:3908-3933), before the closing `});`:

```rust
            // send-during-compact queue: the compact settled (success OR
            // failure) — drain one queued send; its own settle tail
            // continues the FIFO.
            this.drain_pending_sends(&compact_id).await;
```

**Hook — the send drive's settle tail.** In `send_locked`'s spawned task, after `settle_turn_outcome(…)` (:2011-2018):

```rust
            // send-during-compact queue: FIFO one-at-a-time — after this
            // send settles, drive the next queued entry (no-op when the
            // queue is empty).
            this.drain_pending_sends(&real_id).await;
```

**Hook — `handle_interrupt`.** After the daemon-abort `match` (:3460-3474) in the materialized path, outside any held session lock (the lock scope ends at :3447):

```rust
        // send-during-compact queue: an interrupted compact never runs its
        // own settle tail (TurnTask doc :199-201), so THIS handler is the
        // drain trigger — after the abort settled and the daemon-side
        // abort resolved. Only kill drops the queue; interrupt does not.
        self.drain_pending_sends(&real_id).await;
```

(f) **The push-armed drain** — in the Task 1 queue arm, after the WARN, before `return`:

```rust
            // Self-healing sliver closer: arm a drain for this push. A
            // no-op when a live drive exists (the gate returns and that
            // drive's tail drains later); acts immediately when the
            // registration is settling/finished/absent with no upcoming
            // tail (the post-drain window where nothing else would
            // trigger). The spawned drain parks on the session mutex —
            // never deadlocks (detached; the arm holds no other locks).
            let this = self.clone();
            let drain_id = real_id.clone();
            tokio::spawn(async move { this.drain_pending_sends(&drain_id).await; });
```

(g) **Test helper** — add the bounded async prompt waiter beside `await_summarize_posted` (:15172-15181), same shape (tokio timeout + short async sleep), polling `http.recorded()` for a `prompt_async` whose body contains the text; panic with a clear message on the 5s budget.

**Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains opencode_ws::tests::a_settling_registration opencode_ws::tests::a_send_arriving_behind opencode_ws::tests::an_interrupted_compact_still --locked`

Expected: PASS.

**Step 5: Refactor while green** — the `send_locked` extraction must have moved code VERBATIM (only the three documented edits); re-verify no accidental logic drift against the pre-extraction diff. Confirm the three planted-literal updates use one shared constructor shape if one reads better, but do not otherwise restructure tests.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — every send-path test crosses the extraction; the compact suite covers hooks (e)/(interrupt); `compact_while_a_turn_is_in_flight_is_refused_and_never_posts` stays green (the drain never registers on a live task — the settling gate guarantees it, and the :3595 gate is untouched).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): drain freshopencode queued sends — settling marker, settle-tail/interrupt hooks, push-armed drain (FIFO)"
```

---

### Task 3: Kill and handoff drop the queue (WARN per dropped entry)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_kill` phase 3 ~:3216-3239; `opencode_kill_for_handoff` lock section ~:2267-2277)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new test beside the kill-mid-compact test :15256)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 1); the kill paths' existing session-lock sections; the `info_capture` facility.

**Step 1: Write the failing behavioral test**

```rust
#[tokio::test]
async fn kill_with_a_queued_send_drops_it_with_a_warn_and_it_never_posts() {
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, _rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q5", Some("prov/model")).await;
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q5"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q5", "must die with the pane"))).await;

    let (events, _guard) = info_capture::capture();

    // The kill — the inline FreshAgentKill literal the :15256 test uses
    // (:15293-15300 is the field shape), adapted to ses_q5.
    tokio::time::timeout(std::time::Duration::from_secs(10),
        st.handle_kill(FreshAgentKill { /* inline literal per :15293-15300 */ })).await
        .expect("kill completes");

    // (1) The queued message is gone and never POSTs (causally safe: the
    // queue was dropped under the phase-3 lock; no drain trigger exists).
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("must die with the pane")),
        "kill drops the queue — the message must never reach the daemon");
    // (2) The drop is observable: one WARN naming the dropped request
    // (message + the structured request_id field).
    let captured = events.lock().unwrap();
    assert!(captured.iter().any(|e|
        e.message.contains("fresh_agent_send_dropped_on_kill")
            && format!("{:?}", e.fields).contains("req-must die with the pane")),
        "every dropped entry is WARNed with its request id");
}
```

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`

Expected: FAIL — no drop site exists yet; the WARN assertion fails first.

**Step 3: Add the minimal production implementation**

(a) `handle_kill` phase 3, inside the same session-lock section that sets `killed` (:3225), immediately AFTER the `killed.store(true)`:

```rust
            // send-during-compact queue: a killed pane drops its queued
            // sends (WARN per entry — a message must never silently
            // disappear). Under the SAME phase-3 lock so the drop is
            // atomic with `killed`: a queueing send parked on this lock
            // serializes either before (its entry is dropped here) or
            // after (it observes killed at the :1455 gate and refuses
            // typed). The drain's killed re-check is the backstop for a
            // drain mid-drive racing this lock.
            while let Some(msg) = s.pending_sends.pop_front() {
                tracing::warn!(target: "freshell_freshagent::opencode",
                    session_id = %session_id, request_id = ?msg.request_id,
                    "fresh_agent_send_dropped_on_kill");
            }
```

(Adapt `s`/`session_id` to the phase-3 section's actual guard and identifier names verbatim.)

(b) `opencode_kill_for_handoff`, inside its session-lock section (:2267-2277), same block with `"fresh_agent_send_dropped_on_handoff"` — the queue must NOT follow the session to the handoff target (the target rebuilds a fresh session object via `resume_durable_session`; silently carrying user-typed prompts across the transition would fire them on a pane that never typed them).

**Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`

Expected: PASS.

**Step 5: Refactor while green** — if a shared tiny drop-and-warn helper reads better than two inline loops, extract it — but keep the distinct WARN messages (kill vs handoff are different user stories in the logs).

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — the kill suite (:15256-15331, :7735-7817, the handoff tests around :13291) crosses these sections.

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): freshopencode kill and handoff drop queued sends with a WARN per entry"
```

---

### Task 4: Drain-time fence re-validation (typed, request-correlated stale refusal)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`drain_pending_sends`, the Task 2 loop)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new test beside the Task 2 drain tests)

**Interfaces:**
- Consumes: `wire_fence` (lib.rs:338-347), `self.fresh_agent.ownership` (`Option<Arc<RuntimeOwnershipRegistry>>` — the same field `arm_reclaimless_op_guard` receives at :3628), `registry.observe(provider, session_id) -> OwnershipSnapshot { epoch, generation, … }` (freshell-ownership/src/lib.rs:3988), `send_error` (:826-842), and the test fixtures `seed_live_fresh_owner` (:11421-11452) + `fenced_observed` (:11413-11419).
- Produces: the drain's coordinator consult step.

**Step 1: Write the failing behavioral test**

```rust
#[tokio::test]
async fn a_stale_queued_fence_refuses_typed_at_drain_and_the_queue_continues() {
    // Same gated rig, plus a coordinator registry seeded Live{FreshAgent}
    // on the durable key — the SAME seeding the parked-compact tests use
    // (seed_live_fresh_owner :11421-11452; the compact itself MUST be
    // fenced with fenced_observed :11413-11419 — an unfenced compact
    // against a Live{FreshAgent} key is the typed FENCE_REQUIRED refusal
    // and the drive never spawns).
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (mut st, http, mut rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q6", Some("prov/model")).await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    st.set_ownership(Arc::clone(&registry));
    seed_live_fresh_owner(&registry, "ses_q6"); // Live{FreshAgent} at generation G
    let (epoch, generation) = fenced_observed(&registry, "ses_q6"); // the current pair

    // The compact, FENCED with the current pair (the :13306-13308 shape).
    let mut compact = compact_msg("ses_q6");
    (compact.observed_epoch, compact.observed_generation) = (epoch, generation);
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact)).await.expect("compact registers (fenced)");
    await_summarize_posted(&http).await;

    // A STALE-observed send (generation behind the Live record) and a
    // CURRENT-observed send both queue during the compact.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg_fenced("ses_q6", "stale one",
            epoch, generation.map(|g| g.saturating_sub(1))))).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg_fenced("ses_q6", "current one", epoch, generation))).await;

    summarize_gate.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // (1) The stale entry is refused REQUEST-CORRELATED: a top-level
    // `error` frame carrying its requestId.
    let frames = frames_until(&mut rx, |f| f["type"] == "error"
        && f["requestId"] == "req-stale one").await;
    assert!(frames.iter().any(|f|
        f["message"].to_string().to_lowercase().contains("stale")),
        "the stale queued send refuses with the stale-fence message");
    // (2) It never POSTs.
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("stale one")));
    // (3) The queue CONTINUES: the current entry drains and POSTs.
    await_prompt_posted(&http, "current one").await;
}
```

(`send_msg_fenced` takes `Option<u64>` pairs — :6868-6886; `fenced_observed` returns the pair already in that shape. If the first grant's generation is 1, `saturating_sub(1)` yields 0 — a provably stale observation; adjust to any value that differs from the current pair if the helper's contract differs.)

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`

Expected: FAIL — without the consult, the stale entry POSTs like a current one (no `error` frame with its requestId).

**Step 3: Add the minimal production implementation**

In `drain_pending_sends`, between the `wire_fence` match and the `pop_front()`/`send_locked` call, insert the consult (replacing the Task 2 placeholder comment):

```rust
            // The queue's whole-window protection: the pair was observed at
            // submit; ownership may have moved during the compact. A stale
            // pair refuses typed + request-correlated (the client's
            // owned-failure cleanup correlates by requestId). Mirrors the op
            // guard's epoch pre-check (lib.rs:408-422) plus the generation
            // the materialization claim's StaleGeneration arm validates
            // (:1691-1699). Unwired registry → proceed (the Unwired
            // tolerance every reclaim-less lane applies). An UNFENCED
            // entry also proceeds — matching the tolerance today's direct
            // materialized sends apply (parse-only at the old :1507).
            if let (Some(fence), Some(registry)) =
                (send_fence.as_ref(), self.fresh_agent.ownership.as_ref())
            {
                let snap = registry.observe(PROVIDER, &real_id);
                if fence.epoch != snap.epoch || fence.generation != snap.generation {
                    session.pending_sends.pop_front();
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        session_id = %lookup_id, request_id = ?msg.request_id,
                        observed_epoch = fence.epoch, observed_generation = fence.generation,
                        current_epoch = snap.epoch, current_generation = snap.generation,
                        "fresh_agent_send_drain_refused: stale observed fence");
                    self.send_error(
                        &msg.request_id,
                        "SESSION_RESERVED",
                        "The observed ownership fence is stale; refresh and retry",
                    );
                    continue;
                }
            }
```

**Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`

Expected: PASS.

**Step 5: Refactor while green** — confirm the `send_locked` call passes the SAME `send_fence` the consult validated (no second parse). The Task 2 fence-parse section and this consult are now one coherent re-validation block.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — including the whole fence suite (:7818-8082).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): typed request-correlated stale-fence refusal for freshopencode queued-send drains"
```

---

### Task 5: E2E — parked-summarize fixture knob + opencode-lane queue spec + AGENTS.md note

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (summarize arm :1482-1515; env parsing beside the existing `FAKE_OPENCODE_*` vars)
- Test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (opencode lane, `bootOpencodeLane(page, extraEnv)` :2088-2130; new test inside `test.describe('fresh-agent control surfaces — opencode lane (rust)')` :2167+)
- Modify: `AGENTS.md` (the freshopencode sentence in the orchestration/status section)

**Interfaces:**
- Consumes: `bootOpencodeLane(page, extraEnv)` (:2088-2130 — `…extraEnv` flows into the Rust server's env, which the spawned `opencode serve` child inherits with no allowlist), the page-side WS injector `window.__FRESHELL_TEST_HARNESS__.sendWsMessage` via `page.evaluate` (src/lib/test-harness.ts:128-134; spec-side precedent for evaluate-arg passing: :365), `readOpencodeAudit` (SYNCHRONOUS :2132-2134), `waitForLogEntry(path, pred, what)` (3rd argument required, :391-405), `sendComposerText` (:491-496), `waitForPaneStatus`, `fs.mkdtemp` for the gate dir (the :552/:1304/:2100 precedent).
- Produces: fixture env knob `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH`.

**Step 1: Write the failing e2e test** (red on the current server binary — the injected mid-compact send is refused, so the queued prompt never arrives):

```ts
test('a send during a parked compaction is queued and delivered after the compact settles', async ({ page }) => {
  // The gate dir BEFORE boot (the mkdtemp precedent :552/:1304/:2100).
  const gateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
  const gatePath = path.join(gateDir, 'release-summarize.flag')
  const lane = await bootOpencodeLane(page, {
    FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH: gatePath,
  })
  const tabId = lane.tabId

  // Materialize + idle (the existing helper returns the durable ses_* id).
  const sessionId = await sendOpencodeTurn(page, lane, tabId, 'first turn before compact', 1, lane.auditLogPath)

  // /compact through the composer: the summarize POST parks on the gate
  // file, so the compact drive is deterministically in flight (the audit
  // `summarize` entry lands at REQUEST RECEIPT — the knob parks only the
  // response).
  await sendComposerText(page, '/compact')
  await expect
    .poll(() => readOpencodeAudit(lane.auditLogPath).some(e => e.event === 'summarize'))
    .toBe(true)

  // A raw WS send — the server-side queue seam, deterministic while the
  // compact is parked (the browser's own composer would busy-gate it).
  // Page-side injection with the frame as the evaluate argument (:365 precedent).
  const frame = {
    type: 'freshAgent.send',
    requestId: 'e2e-queued-during-compact',
    sessionId,
    sessionType: 'freshopencode',
    provider: 'opencode',
    text: 'sent while compacting',
  }
  await page.evaluate((f) => window.__FRESHELL_TEST_HARNESS__?.sendWsMessage(f), frame)

  // Still parked: the queued message has NOT been prompted (and no
  // refusal fired — the send was accepted, not refused).
  await expect
    .poll(() => readOpencodeAudit(lane.auditLogPath).some(
      e => e.event === 'prompt_async' && e.prompt === 'sent while compacting'))
    .toBe(false)

  // Release the compact: it settles, the drain drives the queued send.
  await fs.promises.writeFile(gatePath, 'release')
  await waitForLogEntry(lane.auditLogPath,
    e => e.event === 'prompt_async' && e.prompt === 'sent while compacting',
    'the queued send drains after the compact settles')
  // ORDER: the compact happened BEFORE the queued prompt.
  const all = readOpencodeAudit(lane.auditLogPath)
  const summarizeIx = all.findIndex(e => e.event === 'summarize')
  const queuedIx = all.findIndex(e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')
  expect(queuedIx).toBeGreaterThan(summarizeIx)

  await waitForPaneStatus(lane.harness, tabId, 'idle')
})
```

(Adapt helper names/signatures to the spec's exact forms — `sendOpencodeTurn`'s argument shape at :2137-2165 is authoritative; the assertions above are the contract.)

**Step 2: Run it and verify the intended failure**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "queued and delivered after the compact settles"`

Expected: FAIL — first because the fixture knob doesn't exist (the compact never parks), and — with the knob made real (Step 3a) — the true red: the current server REFUSES the injected send (no `prompt_async` for the queued text ever appears; the poll times out).

**Step 3: Add the minimal production implementation**

(a) **Fixture knob** — `fake-opencode.cjs`: parse `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH` from env at startup (beside the existing `FAKE_OPENCODE_*` vars). In the `summarize` arm (:1482-1515): `appendAudit({event:'summarize', …})` and the busy SSE fire at REQUEST RECEIPT exactly as today; ONLY the `sendJson(res, 200, true)` + the idle emit defer behind a one-shot 50ms `setInterval` file-existence check (consume/rm the file when it appears), mirroring the `tuiParityChildEventGatePath` pattern (:723-762) with its `--pure` guard and `.unref?.()`. Without the receipt-vs-response split, the test's own in-flight poll deadlocks (the load-bearing finder's finding).

(b) **Lane plumbing** — `bootOpencodeLane(page, extraEnv)` already spreads `extraEnv` into the Rust server env; no other plumbing (the serve child inherits its parent's env with no allowlist).

(c) **AGENTS.md** — append to the freshopencode sentence in the orchestration/status section: "A freshAgent.send arriving while a native /compact drive is in flight — or while older queued sends are still pending — is queued server-side (FIFO, immediate send.accepted) and auto-driven when the compact settles; kill drops the queue, and the drain re-validates the observed fence and refuses stale entries request-correlated."

**Step 4: Run the focused test**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "queued and delivered after the compact settles"`

Expected: PASS locally.

**Step 5: Refactor while green** — none expected; keep the spec inside the lane's conventions (per-spec helper ownership).

**Step 6: Run impacted-test verification + the cloud backend**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts` (client queue untouched — must stay green), then the cloud lane (scoped cloud runs take POSITIONAL spec paths; never add the spec to CLOUD_SKIP_SPECS):

Run: `FRESHELL_E2E_BACKEND=cloud npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS on the cloud backend (the constraint's PR-readiness rule).

**Step 7: Commit the task**

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/fresh-agent-control-rust.spec.ts AGENTS.md
git commit -m "test(e2e): freshopencode send-during-compaction queue coverage — parked-summarize fixture knob + opencode lane spec"
```

---

## Verification summary

1. Focused per task: `cargo test -p freshell-freshagent --lib <filter> --locked`.
2. Whole-crate after every task: `cargo test -p freshell-freshagent --locked`.
3. Client regression (Task 5): the FreshAgentView outgoing-message-queue vitest suite stays green, untouched.
4. E2E on the configured cloud backend (Task 5), never via CLOUD_SKIP_SPECS; scoped cloud runs take positional spec paths.
5. The repo's pre-push gate (cargo fmt, clippy, targeted cargo test) runs on push; the branch's final full-suite gate runs via the coordinator (`FRESHELL_TEST_SUMMARY=… npm test`) from the worktree — pass the GCLOUD_* identity env explicitly (GCLOUD_IDENT, GCLOUD_ROBOT_HOME, GCLOUD_ROBOT_ACCOUNT): ambient tool shells do not source ~/.bashrc and the cloud lanes fail closed on expired ambient gcloud.
6. No client (src/) changes; the compact-during-turn refusal (:3595) and the other `is_finished()` readers (:4596, :5213/:5483) are untouched.
7. Design evidence and API pins live in `.worktrees/.the-usual-logs/send-during-compact-queue/reports/` (load-bearing-finder.md, load-bearing-strategist.md, and the five planning reports).
