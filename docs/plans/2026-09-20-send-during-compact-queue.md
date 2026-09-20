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

**Goal:** A freshAgent.send that arrives while the session's compact drive is in flight is parked in a per-session FIFO queue (with an immediate `freshAgent.send.accepted` and a WARN), and the compact drive's settle tail automatically re-drives exactly one queued send — FIFO, one at a time — on compact success and failure alike; kill/handoff drop the queue with a WARN per entry; drain-time refusals are request-correlated and fence-validated.

**Architecture:** The queue is a `VecDeque<FreshAgentSend>` field on `OpencodeSession`, guarded by the existing per-session mutex (no new locks, no lock-order changes). The queue point replaces the refusal arm at `handle_send` (opencode_ws.rs:1479-1493) — before any side effect except a request-correlated fence parse and the accepted broadcast. The drain is a single `drain_pending_sends` method triggered from three places: the compact drive's settle tail (inside the spawned task, after `settle_turn_outcome` — runs on success AND failure), the send drive's settle tail (advances the FIFO one-at-a-time), and `handle_interrupt` after the aborted compact settles (the aborted task's own tail never runs). `handle_send`'s post-gate body is extracted into `send_locked` so the drain re-enters the exact send path with `already_accepted = true` (the accepted frame never double-fires). `handle_kill` phase 3 and `opencode_kill_for_handoff` clear the queue under their existing session-lock sections with one WARN per dropped entry. The client needs no changes (audited: FreshAgentView's echo/accepted/re-poll machinery fully tolerates immediate-accept + later-drive).

**Tech Stack:** Rust (tokio, tracing), crates/freshell-freshagent + freshell-protocol; Playwright e2e (test/e2e-browser) with the fake-opencode fixture; no client-side changes.

## Global Constraints

- All line numbers refer to commit 855dae72a (`crates/freshell-freshagent/src/opencode_ws.rs`, 18,084 lines). Adapt harmless drift when the intent is clear.
- Lock discipline (pinned by tests at :9199/:9287): the sessions-map guard is NEVER held across a per-session lock acquisition; session→map is the one permitted pair. Every new code path below takes the session mutex exactly like the existing handlers.
- Every refusal for a `freshAgent.send` request must use `send_error(&request_id, code, message)` (opencode_ws.rs:826-842 — the top-level `error` frame the client correlates by requestId at FreshAgentView.tsx:2356-2414), never `emit_fresh_agent_error` (:686-696 — session-scoped nested broadcast). SCOPE: this binds the send-during-compact path's refusals (the queue arm's fence parse, every drain-time refusal, the killed/close_pending gate). The PRE-EXISTING first-send materialization arms (nested SESSION_RESERVED / LEDGER_WRITE_FAILED broadcasts at :1670-:1883) are out of scope: they have their own intentional client recovery (the SESSION_RESERVED redrive at FreshAgentView.tsx:2315-2326, markSessionLost for INVALID_SESSION_ID) and belong to a different feature lane.
- The compact-during-turn refusal (:3595-3605) is NOT touched. The client (src/) is NOT touched.
- Structured WARNs use `tracing::warn!(target: "freshell_freshagent::opencode", …)` (precedents :1512-1517, :3917-3923).
- Tests: `cargo test -p freshell-freshagent --lib <filter> --locked` (narrowed selectors are uncoordinated); test harness = `compact_state_gated` (:12948), `insert_compact_session` (:12990), `await_summarize_posted` (:15172), `drain_frames`/`frames_until`/`is_event` (:13001-13049), `CaptureLayer` (:6734-6806), `send_msg`/`send_msg_fenced` (:6861-6888).
- The new e2e test must NOT be added to `CLOUD_SKIP_SPECS` (test/e2e-browser/playwright.cloud.config.ts:30-76) and must pass on the cloud backend.

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
        json!({}),
        SummarizeOutcome::OkAnswered,
        Some(summarize_gate.clone()),
        None,
    )
    .await;
    insert_compact_session(&st, "ses_q1", Some("prov/model"));
    // The compact drive: parked summarize = deterministic in-flight window.
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q1")),
    )
    .await
    .expect("handle_compact returns after registering the detached drive");
    await_summarize_posted(&http).await;

    // The WARN capture (the DIAG-01 CaptureLayer facility, precedent :6808).
    let (warns, _guard) = capture_tracing_warns();

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
    // ownership invariant, kept).
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

    // (5) The structured WARN named the queueing.
    assert!(
        warns
            .lock()
            .unwrap()
            .iter()
            .any(|m| m.contains("fresh_agent_send_queued_behind_compact")),
        "queueing is observable in the structured log"
    );

    // (6) The kill tail of the replaced test stays: a kill mid-compact
    // aborts the compact with no fabricated freshAgent.turn.complete and
    // lands freshAgent.killed (kill also drops the queue — Task 3 adds the
    // dropped-entry WARN).
    // … keep the replaced test's kill assertions here verbatim (kill frame,
    // no turn.complete) …
}
```

`capture_tracing_warns()` is a small helper beside `CaptureLayer` (:6734-6806): a `tracing_subscriber` Layer capturing `WARN` events with their message field into a `Arc<Mutex<Vec<String>>>`, installed with `tracing::subscriber::set_default` for the test's thread (the exact facility the `send_with_unsupported_settings…` test at :6808 uses).

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::send_during_an_in_flight_compact_is_queued --locked`

Expected: FAIL — the current code refuses (`freshAgent.error{INTERNAL_ERROR}` arrives, no `send.accepted`, `pending_sends` does not exist so the test does not compile → make the struct/ctor additions from Step 3 first, then the failure is the assertion failure in (1)/(2): `handle_send` queues nothing and refuses).

**Step 3: Add the minimal production implementation**

(a) Field on `OpencodeSession` (after `turn_task`, ~:333):

```rust
    /// send-during-compact queue: a `freshAgent.send` arriving while the
    /// session's `turn_task` is an in-flight COMPACT is parked here (FIFO,
    /// under this same session mutex) instead of being refused — the retired
    /// Node adapter chained both onto `state.sendQueue` (adapter.ts:825-829),
    /// and the D2-F1 refusal this replaces dropped the user's typed message
    /// (the composer stays interactive, so the busy-status race makes the
    /// seam reachable by design). The entry is the complete wire message:
    /// the drain (compact settle tail / send settle tail / handle_interrupt)
    /// re-enters the send path with it. `freshAgent.kill` and the handoff
    /// prior-stop drop the queue (WARN per entry); the drain re-checks the
    /// killed/close_pending gates before every re-drive.
    pending_sends: std::collections::VecDeque<FreshAgentSend>,
```

and in `OpencodeSession::new` (~:427): `pending_sends: std::collections::VecDeque::new(),`. Add `use std::collections::VecDeque;` to the module imports if not present (then use `VecDeque::new()`).

(b) Move the fence-parse block (verbatim, :1507-1521) to BEFORE the compact gate, still inside the lock: a half-sent fence is refused immediately, request-correlated — garbage must never enter the queue. The parsed `send_fence` then feeds the queue arm's fall-through and is passed to the post-gate body (see the interface note below: until Task 2 extracts `send_locked`, keep the parsed `send_fence` variable in scope for the existing claim path at :1642).

(c) Replace the refusal arm (:1479-1493) with the queue arm:

```rust
        // send-during-compact queue: a send arriving while a COMPACT is in
        // flight is QUEUED (FIFO) instead of refused — the refusal dropped
        // the user's typed message. Queue-time side effects are ONLY the
        // client contract's immediate `freshAgent.send.accepted` (the exact
        // shape the normal path broadcasts, request_id preserved,
        // submitted_turn_id: None) and the structured WARN: every other
        // side effect (flag resets, redo destroy, normalization, busy
        // broadcast, materialization, settings refresh, run_turn spawn,
        // turn_task registration) happens at DRAIN time with
        // `already_accepted = true` so the frame never double-fires. The
        // push and the compact's `turn_task` registration (:3935) share this
        // session mutex, so the in-flight observation is exact.
        if session
            .turn_task
            .as_ref()
            .is_some_and(|t| t.kind == TurnTaskKind::Compact && !t.is_finished())
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

The compact/send/fence/kill neighbors: `cargo test -p freshell-freshagent --lib opencode_ws::tests:: --locked` (the whole inline module — the fence-move and arm replacement touch the send path every test crosses). The untouched opposite-direction refusal must stay green: `opencode_ws::tests::compact_while_a_turn_is_in_flight_is_refused_and_never_posts`.

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (all 120+ tests; the replaced refusal test is the only intentional deletion).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): queue freshopencode sends during an in-flight compact (FIFO field + immediate accept + WARN)"
```

---

### Task 2: Drain the queue — compact settle tail, send settle tail, interrupt hook (FIFO, one at a time)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_send` body → `send_locked` extraction ~:1507-2024; `handle_compact` drive task tail ~:3751-3934; send drive task tail ~:1976-2019; `handle_interrupt` ~:3459-3475)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new tests beside the Task 1 test)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 1).
- Produces:

```rust
async fn send_locked(&self, session_arc: &Arc<TokioMutex<OpencodeSession>>,
    session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>,
    msg: FreshAgentSend, session_id: String,
    send_fence: Option<crate::ownership_lane::ObservedFence>,
    already_accepted: bool);
async fn drain_pending_sends(&self, lookup_id: &str);
```

**Step 1: Write the failing behavioral tests**

```rust
#[tokio::test]
async fn a_queued_send_drains_after_the_compact_settles_in_fifo_order() {
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        json!({}), SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q2", Some("prov/model"));
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q2"))).await.expect("compact registers");
    await_summarize_posted(&http).await;

    // TWO queued sends — FIFO order is the assertion target.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "first queued"))).await.expect("queues inline");
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "second queued"))).await.expect("queues inline");

    // Release: the compact POST answers, the drive settles, the drain runs.
    summarize_gate.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // (1) BOTH accepted frames arrived at queue time (immediate accept).
    let frames = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted").await;
    assert!(frames.iter().any(|f| f["requestId"] == "req-first queued"));
    assert!(frames.iter().any(|f| f["requestId"] == "req-second queued"));

    // (2) Both prompt POSTs landed — in queue order, after the summarize.
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

    // (3) The queue is empty and the LAST drive's settle broadcast idle.
    let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.session.snapshot", Some("idle"))).await;
    let session_arc = st.sessions.lock().await.get("ses_q2").cloned().unwrap();
    assert!(session_arc.lock().await.pending_sends.is_empty());
}
```

```rust
#[tokio::test]
async fn an_interrupted_compact_still_drains_the_queued_send() {
    // Same rig; park the compact, queue one send, then handle_interrupt.
    // The aborted compact's own settle tail NEVER runs (TurnTask doc
    // :199-201), so the drain must fire from handle_interrupt after
    // abort_and_settle — the queued prompt POST is the proof.
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, _rx) = compact_state_gated(
        json!({}), SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q3", Some("prov/model"));
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q3"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q3", "survives the interrupt"))).await;
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_interrupt(FreshAgentInterrupt { /* same shape the interrupt tests at :15333 use */ ..(interrupt_msg("ses_q3")) }))
        .await.expect("interrupt answers");
    // The queued send drained AFTER the interrupt's abort settled.
    assert!(http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("survives the interrupt")),
        "the interrupted compact still drains the queued send");
}
```
(Build `FreshAgentInterrupt` exactly the way the `interrupt_during_an_in_flight_compact…` test at :15333-15400 constructs it — reuse its builder/helper verbatim.)

```rust
#[tokio::test]
async fn a_queued_send_drains_after_a_failed_compact_too() {
    // Same rig with SummarizeOutcome::Answered500 + the gate: queue a send
    // while parked, release, and the compact FAILS (never-dispatched=false,
    // destroy stands). The settle tail still runs → the drain still fires.
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        json!({}), SummarizeOutcome::Answered500, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q4", Some("prov/model"));
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q4"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q4", "drains past the failure"))).await;
    summarize_gate.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    // The failure is LOUD (pre-existing), and the queued send STILL drains.
    let _ = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)
        && f["event"]["code"] == "OPENCODE_COMPACT_FAILED").await;
    assert!(http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("drains past the failure")),
        "compact failure does not strand the queue");
}
```

**Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains opencode_ws::tests::an_interrupted_compact_still --locked`

Expected: FAIL — the queued sends never POST (no drain exists); the interrupt test times out on `http.recorded()` never containing the prompt.

**Step 3: Add the minimal production implementation**

(a) **Extract `send_locked`** — move `handle_send`'s entire body from the (already-moved) fence parse through the `turn_task` registration (:1507-2024 as of the original numbering) into:

```rust
    /// The post-gate send body (flag resets → … → run_turn spawn →
    /// turn_task registration), extracted from `handle_send` so the
    /// send-during-compact drain re-enters the EXACT send path for a
    /// queued entry. CONTRACT: the caller HOLDS this session's mutex for
    /// the whole call (the same discipline the inline body had — the
    /// session→map lock pair stays the only permitted ordering).
    /// `already_accepted` suppresses the `freshAgent.send.accepted`
    /// broadcast when the queue arm already emitted it (never double-fire).
    async fn send_locked(
        &self,
        session_arc: &Arc<TokioMutex<OpencodeSession>>,
        session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>,
        msg: FreshAgentSend,
        session_id: String,
        send_fence: Option<crate::ownership_lane::ObservedFence>,
        already_accepted: bool,
    ) {
        // … the moved body, with exactly two edits:
        // (1) request_id/session_id derive from the params;
        // (2) the accepted broadcast (:1959-1968) becomes
        //     if !already_accepted { self.broadcast_send_accepted(
        //         &acked_session_id, &request_id, &route); }
        // The run_turn spawn gains the drain hook (b) below; registration
        // and return stay identical.
    }
```

`handle_send` becomes: map lookup → session lock → killed/close_pending gate → fence parse → queue arm (Task 1) → `self.send_locked(&session_arc, &mut session, msg, session_id, send_fence, false).await`.

(b) **The drain function:**

```rust
    /// Send-during-compact drain: drives at most ONE queued send (FIFO)
    /// when the session is quiescent; the driven send's own settle tail
    /// re-invokes this for the next entry (one at a time). Triggers:
    /// (a) the compact drive's settle tail — success AND failure;
    /// (b) the send drive's settle tail; (c) `handle_interrupt` after the
    /// aborted compact settles (the aborted task's tail never runs).
    /// Refused entries are discarded with a request-correlated
    /// `send_error` (the client's owned-failure cleanup correlates by
    /// requestId) and the drain continues with the next entry. Kill and
    /// the handoff stop DROP the queue instead — the killed/close_pending
    /// re-check here is the belt-and-braces gate for a drain racing those
    /// paths' lock sections.
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
            // An in-flight drive's settle tail is the drain's next trigger —
            // never register a second drive on top of a live one (the exact
            // turn_task-overwrite orphaning the old refusal documented).
            if session.turn_task.as_ref().is_some_and(|t| !t.is_finished()) {
                return;
            }
            let Some(msg) = session.pending_sends.front().cloned() else { return };
            // (Task 4 inserts the coordinator staleness consult here; the
            // half-sent fence parse is structural and lands now.)
            if let Err(err) =
                crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation)
            {
                session.pending_sends.pop_front();
                tracing::warn!(target: "freshell_freshagent::opencode",
                    session_id = %lookup_id, request_id = ?msg.request_id,
                    "fresh_agent_send_drain_refused: half-sent observed fence");
                self.send_error(&msg.request_id, err.code(), err.message());
                continue;
            }
            session.pending_sends.pop_front();
            let real_id = session
                .real_session_id
                .clone()
                .unwrap_or_else(|| msg.session_id.clone());
            let send_fence = crate::ownership_lane::wire_fence(
                msg.observed_epoch, msg.observed_generation)
                .ok()
                .flatten();
            self.send_locked(&session_arc, &mut session, msg, real_id, send_fence, true).await;
            return; // one entry driven; its settle tail continues the FIFO
        }
    }
```

(c) **Hook 1 — the compact drive's settle tail.** Before the `tokio::spawn` at :3775 add `let this = self.clone();` and move it into the task; inside the task, after the failure WARN/error-broadcast block (:3908-3933), before the closing `});`:

```rust
            // send-during-compact queue: the compact settled (success OR
            // failure) — drain one queued send; its own settle tail
            // continues the FIFO.
            this.drain_pending_sends(&compact_id).await;
```

(d) **Hook 2 — the send drive's settle tail.** In `send_locked`'s spawned task (:1976-2019): same `let this = self.clone();` before the spawn, and after `settle_turn_outcome(…)` (:2011-2018):

```rust
            // send-during-compact queue: FIFO one-at-a-time — after this
            // send settles, drive the next queued entry (no-op when the
            // queue is empty).
            this.drain_pending_sends(&real_id).await;
```

(e) **Hook 3 — `handle_interrupt`.** After the daemon-abort `match` (:3460-3474) in the materialized path, outside any held session lock (the lock scope ends at :3447):

```rust
        // send-during-compact queue: an interrupted compact never runs its
        // own settle tail (TurnTask doc :199-201), so THIS handler is the
        // drain trigger — after the abort settled and the daemon-side
        // abort resolved. Only kill drops the queue; interrupt does not.
        self.drain_pending_sends(&real_id).await;
```

**Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains opencode_ws::tests::an_interrupted_compact_still --locked`

Expected: PASS.

**Step 5: Refactor while green** — the `send_locked` extraction must have moved code VERBATIM (only the two documented edits); re-verify no accidental logic drift against the pre-extraction diff. If `handle_send` and `drain_pending_sends` share gate prose, extract nothing further — the asymmetry is intentional (drain never queues).

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — every send-path test crosses the extraction; the compact suite (:15182-15507 neighbors) covers hooks 1 and 3; `compact_while_a_turn_is_in_flight_is_refused_and_never_posts` stays green (the drain's `turn_task` check returns without touching a live turn — the compact refusal arm is untouched).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): drain freshopencode queued sends from the compact/send settle tails and interrupt (FIFO one-at-a-time)"
```

---

### Task 3: Kill and handoff drop the queue (WARN per dropped entry)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_kill` phase 3 ~:3216-3239; `opencode_kill_for_handoff` lock section ~:2267-2277)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new test beside the kill-mid-compact test :15256)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 1); the kill paths' existing session-lock sections.

**Step 1: Write the failing behavioral test**

```rust
#[tokio::test]
async fn kill_with_a_queued_send_drops_it_with_a_warn_and_it_never_posts() {
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, _rx) = compact_state_gated(
        json!({}), SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q5", Some("prov/model"));
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q5"))).await.expect("compact registers");
    await_summarize_posted(&http).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q5", "must die with the pane"))).await;

    let (warns, _guard) = capture_tracing_warns();

    // The kill (same kill_msg shape the :15256 test uses).
    tokio::time::timeout(std::time::Duration::from_secs(10),
        st.handle_kill(kill_msg("ses_q5"))).await.expect("kill completes");

    // (1) The queued message is gone and never POSTs.
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("must die with the pane")),
        "kill drops the queue — the message must never reach the daemon");
    // (2) The drop is observable: one WARN naming the dropped request.
    assert!(warns.lock().unwrap().iter().any(|m|
        m.contains("fresh_agent_send_dropped_on_kill")
            && m.contains("req-must die with the pane")),
        "every dropped entry is WARNed");
}
```

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`

Expected: FAIL — no drop site exists yet; the queued entry survives the kill in the (map-removed) session Arc. The WARN assertion fails first.

**Step 3: Add the minimal production implementation**

(a) `handle_kill` phase 3, inside the same session-lock section that sets `killed` (:3225) — placed immediately AFTER the `killed.store(true)`:

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

(Use the phase-3 section's existing guard variable name — the report shows `s.` there; adapt verbatim. `session_id` adapts to whatever identifier names the killed session in that scope.)

(b) `opencode_kill_for_handoff`, inside its session-lock section (:2267-2277), same block with `"fresh_agent_send_dropped_on_handoff"` — the queue must NOT follow the session to the handoff target (the target rebuilds a fresh session object via `resume_durable_session`; silently carrying user-typed prompts across the transition would fire them on a pane that never typed them).

**Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`

Expected: PASS.

**Step 5: Refactor while green** — the two drop loops are two lines apart in intent; if a shared tiny helper reads better (`fn drain_dropped_sends_for_warn(guard) -> ()`), extract it — but keep the distinct WARN messages (kill vs handoff are different user stories in the logs).

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
- Consumes: `wire_fence` (lib.rs:338-347), `FreshOpencodeState.fresh_agent.ownership` (`Option<Arc<RuntimeOwnershipRegistry>>` — the same field `arm_reclaimless_op_guard` receives at :3628), `registry.observe(provider, session_id) -> OwnershipSnapshot { epoch, generation, state }` (freshell-ownership/src/lib.rs:3988), `send_error` (:826-842).
- Produces: the drain's consult step.

**Step 1: Write the failing behavioral test**

```rust
#[tokio::test]
async fn a_stale_queued_fence_refuses_typed_at_drain_and_the_queue_continues() {
    // Same gated rig, plus a coordinator registry seeded Live{FreshAgent}
    // on the durable key (the claim/commit/release seeding pattern of
    // a_stale_observed_fence_on_a_first_send_refuses_typed_and_never_materializes
    // :7887-8022 — claim_fresh_agent_ownership → commit_fresh_agent_ownership
    // → the granted generation is the observed pair).
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (st, http, mut rx) = compact_state_gated(
        json!({}), SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q6", Some("prov/model"));
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    st.set_ownership(Arc::clone(&registry));
    // Seed Live{FreshAgent} at generation G (mirror :7887's fixture):
    let freshell_ownership::BeginOutcome::Granted { generation } =
        crate::ownership_lane::claim_fresh_agent_ownership(
            &registry, PROVIDER, "ses_q6", "op-queue-seed", None, "test", 1_000)
        else { panic!("seed claim must grant") };
    assert!(matches!(
        crate::ownership_lane::commit_fresh_agent_ownership(
            &registry, PROVIDER, "ses_q6", "op-queue-seed", generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some("seed".to_string()),
                pid: None,
                ownership_id: Some("op-queue-seed".to_string()),
            }),
        freshell_ownership::CommitOutcome::Committed));
    let epoch = registry.observe(PROVIDER, "ses_q6").epoch;

    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact_msg("ses_q6"))).await.expect("compact registers");
    await_summarize_posted(&http).await;

    // A STALE-observed send (generation behind the Live record) and a
    // CURRENT-observed send both queue during the compact.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg_fenced("ses_q6", "stale one", epoch, generation - 1))).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg_fenced("ses_q6", "current one", epoch, generation))).await;

    summarize_gate.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // (1) The stale entry is refused REQUEST-CORRELATED: a top-level
    // `error` frame carrying its requestId and the stale message.
    let frames = frames_until(&mut rx, |f| f["type"] == "error"
        && f["requestId"] == "req-stale one").await;
    assert!(frames.iter().any(|f|
        f["message"].to_string().contains("stale")
            || f["message"].to_string().to_lowercase().contains("stale")),
        "the stale queued send refuses with the stale-fence message");
    // (2) It never POSTs.
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("stale one")));
    // (3) The queue CONTINUES: the current entry drains and POSTs.
    assert!(http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("current one")),
        "one stale entry does not strand the rest of the queue");
}
```

Note: `send_msg_fenced(session_id, text, epoch, generation)` (:6861-6888) mints `request_id = Some("req-{text}")`. If the helper's epoch parameter order differs, adapt — the intent is a `(epoch, generation - 1)` observed pair for the stale entry.

**Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`

Expected: FAIL — without the consult, the stale entry POSTs like a current one (no `error` frame with its requestId).

**Step 3: Add the minimal production implementation**

In `drain_pending_sends`, replace the parse-only section between the `front().cloned()` and the `pop_front()` with the full re-validation:

```rust
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
            session.pending_sends.pop_front();
            self.send_locked(&session_arc, &mut session, msg, real_id, send_fence, true).await;
            return;
```

**Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`

Expected: PASS.

**Step 5: Refactor while green** — confirm the `send_locked` call passes the SAME `send_fence` the consult validated (no second parse). Remove the Task 2 placeholder parse if now redundant (it is — this block replaces it wholesale).

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
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (summarize arm :1482-1515; env parsing beside the existing `FAKE_OPENCODE_*` vars, header ~:17-204)
- Test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (opencode lane, `bootOpencodeLane` :2088-2130; new test inside the `test.describe('fresh-agent control surfaces — opencode lane (rust)')` block :2167+)
- Modify: `AGENTS.md` (the freshopencode sentence in the Fresh-Agent Orchestration / status section)

**Interfaces:**
- Consumes: `bootOpencodeLane` (env plumbing), `harness.sendWsMessage` (src/lib/test-harness.ts:128-134 — the raw WS frame injector specs already use, e.g. test-harness.ts:539), `waitForLogEntry`, `sendComposerText`, `waitForPaneStatus`, the fake's audit log (`FAKE_OPENCODE_AUDIT_LOG`).
- Produces: fixture env knob `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH`.

**Step 1: Write the failing e2e test** (red on the current server binary — the injected mid-compact send is refused, so the queued prompt never arrives):

```ts
test('a send during a parked compaction is queued and delivered after the compact settles', async ({ page }) => {
  const gatePath = path.join(tmpDirForLane(), 'release-summarize.flag')
  // Boot with the new knob (plumb FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH
  // through bootOpencodeLane's env exactly like FAKE_OPENCODE_TUI_PARITY).
  const lane = await bootOpencodeLane({ holdSummarizeGatePath: gatePath })
  const tabId = lane.tabId

  // Materialize + idle (the existing helper returns the durable ses_* id).
  const sessionId = await sendOpencodeTurn(page, lane, tabId, 'first turn before compact', 1, lane.auditLogPath)

  // /compact through the composer: the summarize POST parks on the gate
  // file, so the compact drive is deterministically in flight.
  await sendComposerText(page, '/compact')
  await expect
    .poll(() => readOpencodeAudit(lane.auditLogPath).then(entries =>
      entries.some(e => e.event === 'summarize')))
    .toBe(true)

  // A raw WS send — the server-side queue seam, deterministic while the
  // compact is parked (the browser's own composer would busy-gate it).
  await lane.harness.sendWsMessage({
    type: 'freshAgent.send',
    requestId: 'e2e-queued-during-compact',
    sessionId,
    sessionType: 'freshopencode',
    provider: 'opencode',
    text: 'sent while compacting',
  })

  // Still parked: the queued message has NOT been prompted (and no
  // refusal banner fired — the send was accepted, not refused).
  await expect
    .poll(() => readOpencodeAudit(lane.auditLogPath).then(entries =>
      entries.some(e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')))
    .toBe(false)

  // Release the compact: it settles, the drain drives the queued send.
  await fs.promises.writeFile(gatePath, 'release')
  const entries = await waitForLogEntry(lane.auditLogPath,
    e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')
  // ORDER: the compact happened BEFORE the queued prompt.
  const all = await readOpencodeAudit(lane.auditLogPath)
  const summarizeIx = all.findIndex(e => e.event === 'summarize')
  const queuedIx = all.findIndex(e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')
  expect(queuedIx).toBeGreaterThan(summarizeIx)

  await waitForPaneStatus(lane.harness, tabId, 'idle')
})
```

(Adapt helper signatures — `sendOpencodeTurn`'s audit-log argument shape and `readOpencodeAudit`'s exact name — to the spec's existing helpers at :2128-2165; the assertions above are the contract.)

**Step 2: Run it and verify the intended failure**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "queued and delivered after the compact settles"`

Expected: FAIL — the fixture knob doesn't exist yet (summarize never parks → the poll timing is undefined), and the current server would REFUSE the injected send (no queued prompt ever). First make the knob real (Step 3a), then observe the refusal-shaped failure (the `prompt_async` entry never appears) — that is the true red.

**Step 3: Add the minimal production implementation**

(a) **Fixture knob** — `fake-opencode.cjs`, beside the `tuiParityChildEventGatePath` one-shot pattern (:723-761): parse `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH` from env at startup; in the `summarize` arm (:1482-1515), when set, defer the arm's body behind a 50ms `setInterval` file-existence check that consumes (rm) the file one-shot, then proceeds with the existing body verbatim (audit → busy → 200 → idle-after-25ms). `.unref?.()` the interval, and never register it under `--pure` (the same guard the child-event gate uses).

(b) **Lane plumbing** — `bootOpencodeLane` gains the env var passthrough (mirror how `FAKE_OPENCODE_AUDIT_LOG` flows).

(c) **AGENTS.md** — append to the freshopencode sentence in the orchestration/status section: "A freshAgent.send arriving while a native /compact drive is in flight is queued server-side (FIFO, immediate send.accepted) and auto-driven when the compact settles — kill drops the queue; the drain re-validates the observed fence and refuses stale entries request-correlated."

**Step 4: Run the focused test**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "queued and delivered after the compact settles"`

Expected: PASS locally.

**Step 5: Refactor while green** — none expected; keep the spec inside the lane's conventions (per-spec helper ownership).

**Step 6: Run impacted-test verification + the cloud backend**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts` (client queue untouched — must stay green), then the cloud e2e lane for this spec (the configured backend; do NOT add the spec to CLOUD_SKIP_SPECS):

Run: `FRESHELL_E2E_BACKEND=cloud npm run test:e2e:cloud -- --specs fresh-agent-control-rust.spec.ts` (or the repo's documented scoped cloud invocation; if scoped cloud runs aren't supported, run the full cloud lane and confirm this spec's results in the report).

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
4. E2E on the configured cloud backend (Task 5), never via CLOUD_SKIP_SPECS.
5. The repo's pre-push gate (cargo fmt, clippy, targeted cargo test) runs on push; the branch's final full-suite gate runs via the coordinator (`FRESHELL_TEST_SUMMARY=… npm test`) from the worktree — with the GCLOUD_* identity env passed explicitly.
6. No client (src/) changes; the compact-during-turn refusal (:3595) is untouched.
