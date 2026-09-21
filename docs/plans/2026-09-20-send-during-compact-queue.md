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

**Architecture:** The queue is a `VecDeque<FreshAgentSend>` field on `OpencodeSession`, guarded by the existing per-session mutex (no new locks, no lock-order changes). The queue point replaces the refusal arm at `handle_send` (opencode_ws.rs:1479-1493): a send queues when a compact drive is in flight (the original refusal condition, including its settling tail — a settling compact still owns FIFO ordering) OR when older entries are still queued (a fresh send must never jump ahead of a pending one — the client fires one send the moment the compact's idle broadcast clears its flush gate). Queueing broadcasts `freshAgent.send.accepted` immediately (the client's echo/accepted machinery is audited to tolerate accepted-now-driven-later) and every push arms a drain. `handle_send`'s post-gate body is extracted into `send_locked` so the drain re-enters the exact send path with `already_accepted = true` (the accepted frame never double-fires). Because the drain's three triggers run inside the very tasks that `turn_task` still names — and tokio's `JoinHandle::is_finished()` stays false until the future returns — `TurnTask` gains a `settling: Arc<AtomicBool>` that each drive task flips at the START of its settle tail; the drain's in-flight gate is `!t.is_finished() && !t.settling.load()`, so a task's own tail passes its own registration while a genuinely live OTHER drive still blocks (the no-stacking/orphaning rule). The three drain triggers — the compact drive's settle tail (after `settle_turn_outcome` — runs on success AND failure), the send drive's settle tail (advances the FIFO), and `handle_interrupt` after the aborted compact settles (the aborted task's own tail never runs) — NEVER await the drain: every trigger site SPAWNS it detached (`tokio::spawn`). Awaiting `drain_pending_sends` from a drive tail would make the drain's future type contain `send_locked`'s, whose spawned drive block's future contains the awaited drain — a recursive `Send` type the compiler rejects (the plan review's round-1 finding; detached spawns break the cycle by construction and keep every tail non-blocking). If the drain observes `close_pending > 0` (a kill enumeration in progress whose refusal/clean-failure paths decrement the counter without setting `killed`), it does not act immediately: a compact settling in exactly that window would strand the queue with no future trigger, so the drain re-arms a bounded delayed retry (3 × 500ms, then a WARN) — `killed` means the queue was already dropped under the kill's lock and the drain simply returns. `handle_kill` phase 3 and `opencode_kill_for_handoff` clear the queue under their existing session-lock sections with one WARN per dropped entry. Drain-time fence re-validation (Task 4) arms the lane's own op guard (`arm_reclaimless_op_guard`) for FENCED entries — atomically validating the captured pair and holding the attach guard through the re-drive's dispatch — while UNFENCED entries keep the direct send path's parse-only tolerance (the queue re-enters the send path; it is not stricter than the path it re-enters). The existing `is_finished()` readers at :3595 (compact busy gate), :4596 (rollback BUSY_TURN), :5213/:5483 (attach labels) are untouched — the `settling` marker is consulted ONLY by the drain gate. The rejected alternative was queue-arming on `!settling` (a fresh send would slip past the settling compact's FIFO window); the push-armed drain closes the post-drain sliver instead.

**Tech Stack:** Rust (tokio, tracing), crates/freshell-freshagent + freshell-protocol; Playwright e2e (test/e2e-browser) with the fake-opencode fixture; no client-side changes.

## Global Constraints

- All line numbers refer to commit 855dae72a (`crates/freshell-freshagent/src/opencode_ws.rs`, 18,084 lines). Adapt harmless drift when the intent is clear.
- Lock discipline (pinned by tests at :9199/:9287): the sessions-map guard is NEVER held across a per-session lock acquisition; session→map is the one permitted pair. Every new code path below takes the session mutex exactly like the existing handlers.
- Every refusal for a `freshAgent.send` request must use `send_error(&request_id, code, message)` (opencode_ws.rs:826-842 — the top-level `error` frame the client correlates by requestId at FreshAgentView.tsx:2356-2414), never `emit_fresh_agent_error` (:686-696 — session-scoped nested broadcast). WIRE REALITY (verified :826-842): `send_error`'s top-level `code` field is ALWAYS `ErrorCode::InternalError`; the `code` argument lands in the message text (`format!("{code}: {message}")` — the established send-path idiom, e.g. :1462/:1518). The binding contract here is: the refusal arrives as a top-level `error` frame carrying the send's `requestId`, with the code string visible in the message. Tests assert requestId + message content — never a wire `error.code` like SESSION_RESERVED. SCOPE: this binds the send-during-compact path's refusals (the queue arm's fence parse, every drain-time refusal, the killed/close_pending gate). The PRE-EXISTING first-send materialization arms (nested SESSION_RESERVED / LEDGER_WRITE_FAILED broadcasts at :1670-:1883) are out of scope: they have their own intentional client recovery (the SESSION_RESERVED redrive at FreshAgentView.tsx:2315-2326, markSessionLost for INVALID_SESSION_ID) and belong to a different feature lane.
- NO production future ever awaits `drain_pending_sends` — every trigger site (compact settle tail, send settle tail, `handle_interrupt`, the queue arm's push) SPAWNS it detached. This is load-bearing for compilation (an awaited drain inside a drive task creates a recursive future type the compiler rejects) and for tail latency (tails never block on the session mutex). White-box TESTS may call it directly with `.await` (a test future is acyclic — the drain's type embeds `send_locked`'s, whose spawned drive block captures only `Send` primitives).
- The compact-during-turn refusal (:3595-3605) is NOT touched. The client (src/) is NOT touched.
- Structured WARNs use `tracing::warn!(target: "freshell_freshagent::opencode", …)` (precedents :1512-1517, :3917-3923). WARN-capture assertions use the crate's existing `info_capture::capture()` facility (:6786-6797 → `(Arc<Mutex<Vec<CapturedEvent{message, fields}>>>, DefaultGuard)`; user precedent :6807-6851) — the request id is a structured FIELD, never message text.
- Test-facility facts (pinned by the load-bearing finder, report `load-bearing-finder.md`): `insert_compact_session` is ASYNC (:12991-12998 — every call needs `.await`); `compact_state_gated(config_body: &str, …)` (:12935-12987 — pass e.g. `r#"{"model":null}"#`); `send_msg_fenced(…, Option<u64>, Option<u64>)` (:6868-6886); there is NO `kill_msg`/`interrupt_msg` helper — build `FreshAgentKill`/`FreshAgentInterrupt` inline exactly as :15293-15300/:15353-15358 do; `fenced_observed(&registry, id) -> (Option<u64>, Option<u64>)` (:11413-11419); `seed_live_fresh_owner` (:11421-11452); `CompactFakeHttp` records EVERY request at ARRIVAL (:12700-12702, `recorded()` :12753 / `summarize_requests()` :12757) — Task 2 adds the bounded prompt waiter and two gate edits on this fake; `frames_until` (:13001-13049) collects frames up to the FIRST match of its predicate — one call pins ONE frame; waiting for two different frames means TWO sequential calls.
- Focused Rust command: `cargo test -p freshell-freshagent --lib <filter> --locked` — cargo accepts exactly ONE positional TESTNAME filter; multiple tests are SEQUENTIAL single-filter invocations (narrowed selectors are uncoordinated).
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
    // frames_until stops at the FIRST predicate match — one call pins the
    // single expected acceptance.
    let frames = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted"
        && f["requestId"] == "req-queued text").await;
    assert!(
        !frames.is_empty(),
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
            // (`tokio::spawn` of `this.drain_pending_sends`) — the
            // self-healing sliver closer. In THIS task the parked entry
            // simply waits for the drain machinery the next task adds.
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

### Task 2: Drain the queue — settling flag, spawned settle-tail/interrupt hooks, push-armed drain (FIFO, one at a time)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`TurnTask` :202-210; `handle_send` body → `send_locked` extraction ~:1507-2024; `handle_compact` drive task ~:3751-3934; send drive task ~:1976-2019; `handle_interrupt` ~:3459-3475; the Task 1 queue arm; `CompactFakeHttp` prompt arm :12892-12898 + summarize arm :12863-12890 + gate fields :12708-12747)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new tests beside the Task 1 test; mechanical updates to the three planted-TurnTask literals :7758/:15201/:16818)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 1).
- Produces:
  - `TurnTask { kind, handle, compact_settled_rx, settling: Arc<AtomicBool> }` — the settle-tail marker each drive task flips before its tail (tokio's `JoinHandle::is_finished()` stays false until the future returns, so a task's own registration would otherwise trip the drain gate — the load-bearing finder's Critical finding, reports/load-bearing-finder.md + load-bearing-strategist.md);
  - `async fn send_locked(&self, session_arc: &Arc<TokioMutex<OpencodeSession>>, session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>, msg: FreshAgentSend, session_id: String, send_fence: Option<crate::ownership_lane::ObservedFence>, already_accepted: bool)` (Task 4 later adds the `op_guard` parameter);
  - `async fn drain_pending_sends(&self, lookup_id: &str)` (public entry: delegates to `drain_pending_sends_attempt(lookup_id, 0)`) and `async fn drain_pending_sends_attempt(&self, lookup_id: &str, attempt: u32)` (the close_pending re-arm core);
  - test-only: `await_prompt_posted(&http, text)` bounded async waiter on the compact fake's recordings;
  - test-fixture: `CompactFakeHttp::arm_prompt_gate(&self) -> Arc<tokio::sync::Notify>` (one-shot prompt park) and the hoisted summarize gate consult (Step 1 companion edits).

**Step 1: Write the failing behavioral tests** (+ the two test-facility companion edits they need)

The FIFO test below doubles as the self-deadlock red: without the `settling` flag, the compact tail's drain trips over its own still-registered task and the queued prompts NEVER post — the test fails for exactly that reason.

Fixture companion edit A (the failure arm must park — the plan review's round-1 finding that `Answered500`/`MidflightTransport` answer immediately, only `OkAnswered` consults the gate at :12884): in `CompactFakeHttp`'s `handle`, HOIST the summarize gate consult (`let gate = self.summarize_gate.clone();` + its `gate.notified().await`, :12884) to immediately AFTER the recorded-request + running-order-pin assert and BEFORE the `MidflightTransport` branch (:12863) — so `OkAnswered`, `Answered500`, and `MidflightTransport` all park identically. The `Undelivered` arm (the pre-record refusal, ~:12813) stays ungated. The ORDER-PIN assert (the busy `running` snapshot precedes the POST) stays exactly where it is.

Fixture companion edit B (the one-at-a-time witness): `CompactFakeHttp` gains a gate field + mutator mirroring `RollbackFakeHttp`'s `arm_revert_gate`/`arm_summarize_gate` (:16517-16528):

```rust
        /// send-during-compact queue (Task 2): when set, the FIRST
        /// `prompt_async` POST parks on `notified()` — a deterministic
        /// "a queued send is in flight" window for the FIFO one-at-a-time
        /// proof. ONE-SHOT by construction: the arm `take()`s the gate in
        /// its synchronous part, so only the first prompt after arming
        /// parks; every later prompt answers immediately. Recording
        /// happens at request arrival for EVERY request (:12700-12702),
        /// so `await_prompt_posted` sees the parked POST — the same
        /// record-then-park split the summarize arm uses.
        prompt_gate: StdMutex<Option<Arc<tokio::sync::Notify>>>,
```

with the mutator:

```rust
        fn arm_prompt_gate(&self) -> Arc<tokio::sync::Notify> {
            let gate = Arc::new(tokio::sync::Notify::new());
            *self.prompt_gate.lock().expect("prompt gate mutex") = Some(gate.clone());
            gate
        }
```

and in the prompt arm (:12892-12898), after the busy-budget insert, before the return:

```rust
                let prompt_gate = self.prompt_gate.lock().expect("prompt gate mutex").take();
                return Box::pin(async move {
                    if let Some(gate) = prompt_gate {
                        gate.notified().await;
                    }
                    Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
                });
```

(`StdMutex` is the module's std-mutex alias — the existing fields use it; no await ever holds it: the `take()` is synchronous.)

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

    // Arm the one-shot prompt park BEFORE the drain can fire.
    let prompt_gate = http.arm_prompt_gate();

    // TWO queued sends — FIFO order is the assertion target.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "first queued"))).await.expect("queues inline");
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q2", "second queued"))).await.expect("queues inline");

    // Both accepted at queue time. frames_until stops at the FIRST
    // predicate match — wait for EACH requestId with its own call.
    let _ = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted"
        && f["requestId"] == "req-first queued").await;
    let _ = frames_until(&mut rx, |f| f["type"] == "freshAgent.send.accepted"
        && f["requestId"] == "req-second queued").await;

    // Release: the compact POST answers, the drive settles, the drain runs.
    summarize_gate.notify_waiters();

    // (1) The FIRST drained send parks on the one-shot prompt gate.
    await_prompt_posted(&http, "first queued").await;

    // (2) ONE-AT-A-TIME (the design constraint, now PROVEN): while the
    // first queued send is in flight (parked), the second has NOT
    // started — the drain drives exactly one entry per settle tail.
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("second queued")),
        "one-at-a-time: the second queued send has not POSTed while the first is in flight");

    // (3) Release the first send's prompt; its settle tail drives the
    // second (bounded async waits: the POSTs happen inside spawned
    // tasks — never assert them against a fixed sleep).
    prompt_gate.notify_waiters();
    await_prompt_posted(&http, "second queued").await;

    // (4) Order on the recorded log: compact BEFORE first, first BEFORE
    // second (FIFO).
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

    // (5) The queue drains completely and the pane settles idle.
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
    // (b) settling registration → the drain pops and drives (the drive
    // itself POSTs to the fake — this rig has no coordinator wired, so
    // the unfenced entry proceeds exactly like the direct path).
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
    // Same rig with SummarizeOutcome::Answered500 + the gate (fixture
    // companion edit A makes the 500 arm park like OkAnswered — without
    // it, the compact settles before the send arrives and the queue is
    // never exercised). Queue a send while parked, release, the compact
    // FAILS — the settle tail still runs → the drain still fires.
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

Sequential single-filter invocations (cargo accepts ONE positional TESTNAME per invocation):

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_settling_registration --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_interrupted_compact_still --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains_after_a_failed --locked`

Expected: FAIL — `TurnTask` has no `settling` field (compiles only after the struct change); with the struct change alone, the FIFO test fails because the drain gate trips over the calling task's own registration (the self-deadlock), the settling test fails at assertion (a), and the interrupt/failure tests time out on `await_prompt_posted` (add the helper + fixture edits first; the intended red is the assertions, not a missing helper).

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
    /// double-fire). Task 4 adds the `op_guard` parameter (the armed
    /// attach guard moved into the drive and dropped at its first
    /// statement); this task's signature stays as written.
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
        //     spawned drain hook (e) below. Registration and return stay
        //     identical.
    }
```

`handle_send` becomes: map lookup → session lock → killed/close_pending gate → fence parse → queue arm (Task 1; Task 2 appends the push-armed drain, (f)) → `self.send_locked(&session_arc, &mut session, msg, session_id, send_fence, false).await`.

(d) **The drain functions** (the re-arm core is the round-1 review's stranding fix):

```rust
    /// Send-during-compact drain (public entry): see
    /// [`Self::drain_pending_sends_attempt`].
    async fn drain_pending_sends(&self, lookup_id: &str) {
        self.drain_pending_sends_attempt(lookup_id, 0).await;
    }

    /// Send-during-compact drain: drives at most ONE queued send (FIFO)
    /// when the session is quiescent; the driven send's own settle tail
    /// re-invokes this for the next entry (one at a time). Triggers
    /// (a) the compact drive's settle tail — success AND failure;
    /// (b) the send drive's settle tail; (c) `handle_interrupt` after the
    /// aborted compact settles (the aborted task's tail never runs);
    /// (d) the queue arm's push-armed spawn (the self-healing sliver
    /// closer: a push landing behind a settling/finished registration
    /// with no upcoming tail gets drained immediately; a no-op when a
    /// live drive exists). EVERY trigger SPAWNS this detached — no
    /// future awaits it (an awaited drain inside a drive tail is a
    /// recursive future type the compiler rejects, and tails must never
    /// block on the session mutex).
    ///
    /// GATES, in order:
    /// - `killed` → return (kill dropped the queue under its own lock;
    ///   there is nothing to drain and never a retry).
    /// - `close_pending > 0` → a kill enumeration is in flight whose
    ///   refusal/clean-failure paths decrement the counter WITHOUT
    ///   setting `killed` (:2794-2806, :2956-2970, :3100-3199). A
    ///   compact settling in exactly that window would strand the queue
    ///   (this drain returns, no tail will ever fire) — so RE-ARM a
    ///   bounded delayed retry: up to 3 attempts, 500ms apart, then a
    ///   WARN and an honest return (the next push-armed drain still
    ///   heals it if one ever comes).
    /// - a live drive (`!is_finished() && !settling`) → return (that
    ///   drive's settle tail is the next trigger).
    ///
    /// Refused entries are discarded with a request-correlated
    /// `send_error` (the client's owned-failure cleanup correlates by
    /// requestId) and the drain continues with the next entry. Kill and
    /// the handoff stop DROP the queue instead — the gates above are
    /// the belt-and-braces re-check for a drain racing those paths'
    /// lock sections.
    async fn drain_pending_sends_attempt(&self, lookup_id: &str, attempt: u32) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(lookup_id).cloned()
        };
        let Some(session_arc) = session_arc else { return };
        let mut session = session_arc.lock().await;
        loop {
            if session.killed.load(Ordering::SeqCst) {
                return;
            }
            if session.close_pending > 0 {
                if attempt < 3 {
                    let this = self.clone();
                    let id = lookup_id.to_string();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        this.drain_pending_sends_attempt(&id, attempt + 1).await;
                    });
                } else {
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        session_id = %lookup_id,
                        queued_depth = session.pending_sends.len(),
                        "fresh_agent_send_drain_deferred_close_pending");
                }
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
            // (Task 4 inserts the guard-based fence re-validation here.)
            session.pending_sends.pop_front();
            self.send_locked(&session_arc, &mut session, msg, real_id, send_fence, true).await;
            return; // one entry driven; its settle tail continues the FIFO
        }
    }
```

(e) **Hooks — every one a detached spawn (the compilation-critical rule).**

**Compact drive settle tail.** Before the `tokio::spawn` at :3775 the task already owns its `this` clone (add one if not); inside the task, after the failure WARN/error-broadcast block (:3908-3933), before the closing `});`:

```rust
            // send-during-compact queue: the compact settled (success OR
            // failure) — drain one queued send; its own settle tail
            // continues the FIFO. SPAWNED, never awaited (the recursive
            // future type + tail-blocking rules).
            let drain_this = this.clone();
            let drain_id = compact_id.clone();
            tokio::spawn(async move {
                drain_this.drain_pending_sends(&drain_id).await;
            });
```

(Adapt `compact_id`/`this` to the task block's actual captured identifiers — the drive block already names the session id; clone what the borrow checker asks for.)

**Send drive settle tail.** In `send_locked`'s spawned task, after `settle_turn_outcome(…)` (:2011-2018):

```rust
            // send-during-compact queue: FIFO one-at-a-time — after this
            // send settles, drive the next queued entry (no-op when the
            // queue is empty). SPAWNED, never awaited.
            let drain_this = this.clone();
            let drain_id = real_id.clone();
            tokio::spawn(async move {
                drain_this.drain_pending_sends(&drain_id).await;
            });
```

**`handle_interrupt`.** After the daemon-abort `match` (:3460-3474) in the materialized path, outside any held session lock (the lock scope ends at :3447):

```rust
        // send-during-compact queue: an interrupted compact never runs its
        // own settle tail (TurnTask doc :199-201), so THIS handler is the
        // drain trigger — after the abort settled and the daemon-side
        // abort resolved. Only kill drops the queue; interrupt does not.
        // SPAWNED, never awaited.
        let drain_this = self.clone();
        let drain_id = real_id.clone();
        tokio::spawn(async move {
            drain_this.drain_pending_sends(&drain_id).await;
        });
```

(f) **The push-armed drain** — in the Task 1 queue arm, after the WARN, before `return`:

```rust
            // Self-healing sliver closer: arm a drain for this push. A
            // no-op when a live drive exists (the gate returns and that
            // drive's tail drains later); acts immediately when the
            // registration is settling/finished/absent with no upcoming
            // tail (the post-drain window where nothing else would
            // trigger). SPAWNED, never awaited: the spawned drain parks
            // on the session mutex — detached, so the arm never blocks
            // and no future type recurses.
            let this = self.clone();
            let drain_id = real_id.clone();
            tokio::spawn(async move { this.drain_pending_sends(&drain_id).await; });
```

(g) **Test helper** — add the bounded async prompt waiter beside `await_summarize_posted` (:15172-15181), same shape (tokio timeout + short async sleep), polling `http.recorded()` for a `prompt_async` whose body contains the text; panic with a clear message on the 5s budget. (Recording at arrival is guaranteed — `CompactFakeHttp` records every request :12700-12702.)

**Step 4: Run the focused tests**

Sequential single-filter invocations:

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_settling_registration --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_send_arriving_behind --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_interrupted_compact_still --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_drains_after_a_failed --locked`

Expected: PASS.

**Step 5: Refactor while green** — the `send_locked` extraction must have moved code VERBATIM (only the three documented edits); re-verify no accidental logic drift against the pre-extraction diff. If a shared tiny spawn-the-drain helper (`fn spawn_drain(&self, id: &str)`) reads better than four near-identical spawn blocks, extract it — one shape, four call sites. Do not otherwise restructure tests.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — every send-path test crosses the extraction; the compact suite covers hooks (e)/(interrupt); `compact_while_a_turn_is_in_flight_is_refused_and_never_posts` stays green (the drain never registers on a live task — the settling gate guarantees it, and the :3595 gate is untouched); the two fixture edits (the hoisted summarize consult, the prompt gate) keep the existing compact/kill/interrupt suite green — the consult hoist only adds a park to arms that previously answered (tests that do not arm the gate see no change).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): drain freshopencode queued sends — settling marker, spawned settle-tail/interrupt hooks, push-armed drain (FIFO)"
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
    // queue was dropped under the phase-3 lock; the drain's killed gate
    // and the close_pending re-arm's killed re-check both return without
    // driving).
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
            // typed). The drain's killed gate (and the re-arm's killed
            // re-check) are the backstops for a drain mid-drive racing
            // this lock.
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

### Task 4: Drain-time fence re-validation (guard-armed, typed, request-correlated stale refusal)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`drain_pending_sends_attempt`, the Task 2 loop; `send_locked` — adds the `op_guard` parameter; the send drive task — drops the guard at its first statement)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (two new tests beside the Task 2 drain tests)

**Interfaces:**
- Consumes: `crate::ownership_lane::arm_reclaimless_op_guard` (lib.rs:392 — the lane's own op guard: `(&Option<Arc<RuntimeOwnershipRegistry>>, provider, session_id, operation_id, observed: Option<ObservedFence>, initiator) -> LaneOpGuard`), `crate::ownership_lane::LaneOpGuard::{Armed(freshell_ownership::AttachGuard), Unwired, Refused{message}}` (lib.rs:348-368 — the fork's call shape at :4090-4115 is the in-file precedent: `operation_id` names the guard on the coordinator's arm/blocked events, initiator strings look like `"freshopencode/fork"`), `send_error` (:826-842 — see the Global Constraints wire-reality note), and the test fixtures `seed_live_fresh_owner` (:11421-11452) + `fenced_observed` (:11413-11419).
- Produces: the drain's guard-armed consult; `send_locked(…, op_guard: Option<freshell_ownership::AttachGuard>, …)`.

**Semantics (the load-bearing design decision, settled in plan review round 1):**

- FENCED entries arm the lane's op guard with the CAPTURED pair — the atomic validation + held-attach-guard shape the repo's own ownership-lane docs sanction (lib.rs:346-361: a bare unlocked observe-then-act is exactly the TOCTOU the guard exists to close; the round-1 finding on the v2 plan's manual `registry.observe` comparison). `Refused{message}` (stale pair, non-Live owner, lifecycle-blocked) → WARN + pop + request-correlated `send_error(&msg.request_id, "SESSION_RESERVED", &message)` + continue with the next entry. `Armed(guard)` → the guard is held through the pop + `send_locked`'s dispatch and dropped at the DRIVE TASK'S FIRST STATEMENT — the boundary where the entry stops being "queued" and becomes "a turn like any direct turn" (mid-turn kill/handoff keep their current semantics; the coordinator serialization covers exactly the queued-entry decision window, not the turn's whole life). `Unwired` → proceed (the tolerance every reclaim-less lane applies when no coordinator is wired).
- UNFENCED entries (no observed pair on the wire message) keep the DIRECT SEND PATH's parse-only tolerance — they proceed without arming the guard. The op guard's no-laundering discipline (an unfenced `None` against a Live key is the typed FENCE_REQUIRED refusal, lib.rs:434-475) binds the history-RESTRUCTURING lanes (compact/rollback/fork); the SEND lane has never consulted the coordinator for unfenced sends — `handle_send`'s direct path is fence-parse-only, and the queue re-enters that path. The queue must not be stricter than the path it re-enters: an unfenced send firing post-compact is exactly what the direct path does with the same frame the moment the pane is idle. (A future policy decision may tighten unfenced sends — at the DIRECT path too, not just the drain — but that is a different run.)

**Step 1: Write the failing behavioral tests**

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

    // (1) The stale entry is refused REQUEST-CORRELATED: a top-level
    // `error` frame carrying its requestId. The wire `error.code` is
    // always INTERNAL_ERROR (the send_error idiom, :826-842); the code
    // string rides in the MESSAGE — assert the requestId and the
    // guard's stale wording in the message, never a wire code.
    let frames = frames_until(&mut rx, |f| f["type"] == "error"
        && f["requestId"] == "req-stale one").await;
    assert!(frames.iter().any(|f|
        f["message"].to_string().to_lowercase().contains("stale")),
        "the stale queued send refuses with the guard's stale-fence message");
    // (2) It never POSTs.
    assert!(!http.recorded().iter().any(|r| r.url.contains("prompt_async")
        && r.body.to_string().contains("stale one")));
    // (3) The queue CONTINUES: the current entry drains and POSTs.
    await_prompt_posted(&http, "current one").await;
    let session_arc = st.sessions.lock().await.get("ses_q6").cloned().unwrap();
    assert!(session_arc.lock().await.pending_sends.is_empty(),
        "the refused entry was discarded; the current entry drained");
}

#[tokio::test]
async fn an_unfenced_queued_send_drains_like_a_direct_send_against_a_wired_owner() {
    // The tolerance pin (the settled semantics): an unfenced send
    // queued behind a fenced compact on a WIRED Live key proceeds at
    // drain exactly like the direct path — the queue is not stricter
    // than the path it re-enters.
    let summarize_gate = Arc::new(tokio::sync::Notify::new());
    let (mut st, http, _rx) = compact_state_gated(
        r#"{"model":null}"#, SummarizeOutcome::OkAnswered, Some(summarize_gate.clone()), None).await;
    insert_compact_session(&st, "ses_q7", Some("prov/model")).await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    st.set_ownership(Arc::clone(&registry));
    seed_live_fresh_owner(&registry, "ses_q7");
    let (epoch, generation) = fenced_observed(&registry, "ses_q7");
    let mut compact = compact_msg("ses_q7");
    (compact.observed_epoch, compact.observed_generation) = (epoch, generation);
    tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_compact(compact)).await.expect("compact registers (fenced)");
    await_summarize_posted(&http).await;
    // UNFENCED (send_msg sends no observed pair).
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2),
        st.handle_send(send_msg("ses_q7", "unfenced but queued"))).await;
    summarize_gate.notify_waiters();
    await_prompt_posted(&http, "unfenced but queued").await;
    let session_arc = st.sessions.lock().await.get("ses_q7").cloned().unwrap();
    assert!(session_arc.lock().await.pending_sends.is_empty());
}
```

(`send_msg_fenced` takes `Option<u64>` pairs — :6868-6886; `fenced_observed` returns the pair already in that shape. If the first grant's generation is 1, `saturating_sub(1)` yields 0 — a provably stale observation; adjust to any value that differs from the current pair if the helper's contract differs. The stale-message assertion may need adapting to the guard's actual `STALE_OP_GUARD_MESSAGE` wording — the REQUIRED assertions are the top-level error frame + the requestId + never-POSTs.)

**Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_unfenced_queued_send_drains_like --locked`

Expected: FAIL — the stale entry POSTs like a current one (no `error` frame with its requestId); the unfenced tolerance test passes trivially pre-consult and pins the semantics against regressions.

**Step 3: Add the minimal production implementation**

(a) In `drain_pending_sends_attempt`, replace the Task 2 placeholder comment with the guard consult:

```rust
            // Drain-time fence re-validation (the user constraint): the
            // entry's captured pair is validated ATOMICALLY via the
            // lane's op guard — never a bare unlocked observe-then-act
            // (the exact TOCTOU the guard's docs exist to close, and the
            // round-1 review's finding against this plan's earlier
            // manual comparison). FENCED entries only: an unfenced
            // entry keeps the direct send path's parse-only tolerance
            // (the queue re-enters the send path; it is not stricter
            // than the path it re-enters — the no-laundering discipline
            // binds the history-restructuring lanes, not the append-a-
            // turn send lane).
            let op_guard = match send_fence {
                None => None, // unfenced: direct-path tolerance
                Some(fence) => {
                    let op_id = format!("send-drain-{}", uuid::Uuid::new_v4());
                    match crate::ownership_lane::arm_reclaimless_op_guard(
                        &self.fresh_agent.ownership,
                        PROVIDER,
                        &real_id,
                        &op_id,
                        Some(fence),
                        "freshopencode/send-drain",
                    ) {
                        crate::ownership_lane::LaneOpGuard::Armed(guard) => Some(guard),
                        crate::ownership_lane::LaneOpGuard::Unwired => None,
                        crate::ownership_lane::LaneOpGuard::Refused { message } => {
                            session.pending_sends.pop_front();
                            tracing::warn!(target: "freshell_freshagent::opencode",
                                session_id = %lookup_id, request_id = ?msg.request_id,
                                observed_epoch = fence.epoch,
                                observed_generation = fence.generation,
                                "fresh_agent_send_drain_refused: ownership guard refused");
                            self.send_error(
                                &msg.request_id,
                                "SESSION_RESERVED",
                                &message,
                            );
                            continue;
                        }
                    }
                }
            };
```

(b) `send_locked` gains the parameter (before `already_accepted`): `op_guard: Option<freshell_ownership::AttachGuard>`; the direct `handle_send` call site passes `None`; the drain passes the armed guard. In `send_locked`'s spawned drive task, the FIRST statement drops it:

```rust
                // The drain's armed attach guard is released at the
                // dispatch boundary: the entry is no longer "queued" —
                // it is a turn like any direct one, and mid-turn
                // kill/handoff keep their current semantics. (None for
                // direct sends and unfenced drains — a no-op.)
                drop(op_guard);
```

(The guard must move INTO the `async move` drive block — capture it there explicitly; the borrow checker will insist, which is the correctness discipline.)

**Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_unfenced_queued_send_drains_like --locked`

Expected: PASS.

**Step 5: Refactor while green** — confirm the `send_locked` call passes the SAME `send_fence` the guard validated (no second parse) and the armed guard genuinely reaches the drive block (a `debug_assert!(op_guard_is_none_or_dropped)` style comment is fine; no runtime machinery). The Task 2 fence-parse and this consult are now one coherent re-validation block.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — including the whole fence suite (:7818-8082) and the guard's own interlock tests (the drain's operation ids are new and unique per drive, so no interference).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): guard-armed request-correlated stale-fence refusal for freshopencode queued-send drains"
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
  // The frame is deliberately UNFENCED (no observed pair): the drain's
  // unfenced tolerance is the direct path's own tolerance, and this e2e
  // pins exactly that end-to-end. Page-side injection with the frame as
  // the evaluate argument (:365 precedent).
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

(c) **AGENTS.md** — append to the freshopencode sentence in the orchestration/status section: "A freshAgent.send arriving while a native /compact drive is in flight — or while older queued sends are still pending — is queued server-side (FIFO, immediate send.accepted) and auto-driven when the compact settles; kill drops the queue, and the drain re-validates a captured observed fence through the lane op guard (stale pairs refuse typed, request-correlated)."

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

1. Focused per task: `cargo test -p freshell-freshagent --lib <filter> --locked` — ONE positional filter per invocation; multiple tests run as SEQUENTIAL single-filter invocations.
2. Whole-crate after every task: `cargo test -p freshell-freshagent --locked`.
3. Client regression (Task 5): the FreshAgentView outgoing-message-queue vitest suite stays green, untouched.
4. E2E on the configured cloud backend (Task 5), never via CLOUD_SKIP_SPECS; scoped cloud runs take positional spec paths.
5. The repo's pre-push gate (cargo fmt, clippy, targeted cargo test) runs on push; the branch's final full-suite gate runs via the coordinator (`FRESHELL_TEST_SUMMARY=… npm test`) from the worktree — pass the GCLOUD_* identity env explicitly (GCLOUD_IDENT, GCLOUD_ROBOT_HOME, GCLOUD_ROBOT_ACCOUNT): ambient tool shells do not source ~/.bashrc and the cloud lanes fail closed on expired ambient gcloud.
6. No client (src/) changes; the compact-during-turn refusal (:3595) and the other `is_finished()` readers (:4596, :5213/:5483) are untouched.
7. Design evidence and API pins live in `.worktrees/.the-usual-logs/send-during-compact-queue/reports/` (load-bearing-finder.md, load-bearing-strategist.md, and the five planning reports); the round-1 plan-review report (fresheyes-plan/usual-fresheyes-20260921T023038Z-2052070.md) is the provenance of this plan's v3 corrections.
