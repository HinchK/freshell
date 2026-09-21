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
- The client's outgoing-queue unit coverage today exercises Codex and Claude panes, not OpenCode; this run does not touch the client, so that pre-existing unit gap stays (the Task 1 pane-level e2e covers the opencode composer queue path end-to-end instead).

**Goal:** A freshAgent.send that arrives while the session's compact drive is in flight — or while older queued sends are still pending — is parked in a per-session FIFO queue (with an immediate `freshAgent.send.accepted` and a WARN), and the drain machinery automatically re-drives exactly one queued send at a time; kill/handoff drop the queue with a WARN per entry; drain-time refusals are request-correlated and fence-validated.

**Architecture:** The queue is a `VecDeque<FreshAgentSend>` field on `OpencodeSession`, guarded by the existing per-session mutex (no new locks, no lock-order changes). The queue point replaces the refusal arm at `handle_send` (opencode_ws.rs:1479-1493): a send queues when a compact drive is in flight (the original refusal condition, including its settling tail — a settling compact still owns FIFO ordering) OR when older entries are still queued (a fresh send must never jump ahead of a pending one — the client fires one send the moment the compact's idle broadcast clears its flush gate). Queueing broadcasts `freshAgent.send.accepted` immediately (the client's echo/accepted machinery is audited to tolerate accepted-now-driven-later) and every push arms a drain. `handle_send`'s post-gate body is extracted into `send_locked` so the drain re-enters the exact send path with `already_accepted = true` (the accepted frame never double-fires). `TurnTask` gains `settling: Arc<AtomicBool>`, flipped at the END of each drive task's settle tail — AFTER the last broadcast, immediately before the tail's drain spawn: while a drive is emitting (its tail has not finished), the drain's in-flight gate `!t.is_finished() && !t.settling.load()` blocks, so the next queued send's `running` snapshot can never precede the previous drive's trailing `idle` (the round-2 review's ordering finding; flipping at the tail's start would let a pushed drain drive mid-tail). Every drain trigger — the compact drive's settle tail (success AND failure), the send drive's settle tail (advances the FIFO), `handle_interrupt` after the aborted compact settles, the queue arm's push, and EVERY `close_pending` decrement site in the kill enumeration (the positive trigger that heals a compact settling during a kill's awaited durable close) — goes through one sync helper, `drain_detached`, which spawns a dyn-erased future (`drain_boxed` returns `Pin<Box<dyn Future + Send>>`): on this repo's stable rustc 1.96 the OLD trait solver cannot prove `Send` through any cycle of opaque async-fn futures (verified by probe — see Global Constraints), so no generator ever stores another opaque drain/send future; the dyn boundary is the compile-correct shape, and no future ever awaits the drain (tails never block on the session mutex). When the drain observes `close_pending > 0` it returns without retry — the kill enumeration's own decrement sites positively re-trigger it when the gate releases (including the DURABLE_CLOSE_FAILED clean-failure arm where the session survives), so a slow clean-failing close can never strand an already-accepted queued message. `handle_kill` phase 3 and `opencode_kill_for_handoff` clear the queue under their existing session-lock sections with one WARN per dropped entry. Drain-time fence re-validation (Task 5) arms the lane's own op guard (`arm_reclaimless_op_guard`) for FENCED entries and releases it at the prompt POST's DISPATCH BOUNDARY through the compact drive's own select! discipline (a fresh per-drive dispatch witness via `run_turn`'s additive second witness parameter; the guard covers exactly the arm→dispatch check-then-act window, and post-dispatch the reviewed abort machinery owns the window exactly as for compacts), while UNFENCED entries keep the direct send path's parse-only tolerance (the queue re-enters the send path; it is not stricter than the path it re-enters). The existing `is_finished()` readers at :3595 (compact busy gate), :4596 (rollback BUSY_TURN), :5213/:5483 (attach labels) are untouched — the `settling` marker is consulted ONLY by the drain gate. The rejected alternatives: queue-arming on `!settling` (a fresh send would slip past the settling compact's FIFO window — the push-armed drain closes that sliver instead), awaiting the drain from tails (recursive `Send` cycles the old solver cannot prove, and tails must not block), an in-drain bounded retry on `close_pending` (any bound is a strand-waiting-to-happen; the decrement-site positive trigger is time-unbounded by construction).

**Tech Stack:** Rust (tokio, tracing), crates/freshell-freshagent + freshell-opencode + freshell-protocol; Playwright e2e (test/e2e-browser) with the fake-opencode fixture; no client-side changes.

## Global Constraints

- All line numbers refer to commit 855dae72a (`crates/freshell-freshagent/src/opencode_ws.rs`, 18,084 lines; `crates/freshell-opencode/src/serve.rs` ~2,000 lines). Adapt harmless drift when the intent is clear.
- **Async-type discipline (round-2 finding, probe-verified):** on this repo's stable rustc 1.96.0, NO generator may store another opaque drain/send future — the old trait solver fails the `Send` proof with E0283/E0733 cycles. Verified by probe (source preserved at `reports/recursion-probe.rs`, probe project `/tmp/opencode/recursion-probe`): the naive shapes — (a) a fn whose spawned block awaits itself, (b) the same with a call-site `Box::pin` cast, (c) drain→send_locked awaited, whose spawned drive block awaits drain — ALL fail to compile with `cannot satisfy impl Future<Output = ()>: Send`. The COMPILED shape: every cross-task drain edge goes through `fn drain_detached(this: &FreshOpencodeState, id: &str)` (sync) → `fn drain_boxed(this, id) -> Pin<Box<dyn Future<Output = ()> + Send>>` (a PLAIN fn returning a boxed dyn future) → `tokio::spawn(drain_boxed(...))`. `send_locked` awaits only external/leaf futures and dispatches its drive via `tokio::spawn` (the drive block calls the SYNC `drain_detached` in its tail). White-box tests may `await` `drain_pending_sends` directly (a test future is never spawned — no `Send` proof needed; the probe's `main` does exactly this). NO production future ever awaits `drain_pending_sends`.
- Lock discipline (pinned by tests at :9199/:9287): the sessions-map guard is NEVER held across a per-session lock acquisition; session→map is the one permitted pair. Every new code path below takes the session mutex exactly like the existing handlers.
- Every refusal for a `freshAgent.send` request must use `send_error(&request_id, code, message)` (opencode_ws.rs:826-842 — the top-level `error` frame the client correlates by requestId at FreshAgentView.tsx:2356-2414), never `emit_fresh_agent_error` (:686-696 — session-scoped nested broadcast). WIRE REALITY (verified :826-842): `send_error`'s top-level `code` field is ALWAYS `ErrorCode::InternalError`; the `code` argument lands in the message text (`format!("{code}: {message}")` — the established send-path idiom, e.g. :1462/:1518). The binding contract here is: the refusal arrives as a top-level `error` frame carrying the send's `requestId`, with the code string visible in the message. Tests assert requestId + message content — never a wire `error.code` like SESSION_RESERVED. SCOPE: this binds the send-during-compact path's refusals (the queue arm's fence parse, every drain-time refusal, the killed/close_pending gate). The PRE-EXISTING first-send materialization arms (nested SESSION_RESERVED / LEDGER_WRITE_FAILED broadcasts at :1670-:1883) are out of scope: they have their own intentional client recovery (the SESSION_RESERVED redrive at FreshAgentView.tsx:2315-2326, markSessionLost for INVALID_SESSION_ID) and belong to a different feature lane.
- The compact-during-turn refusal (:3595-3605) is NOT touched. The client (src/) is NOT touched.
- Structured WARNs use `tracing::warn!(target: "freshell_freshagent::opencode", …)` (precedents :1512-1517, :3917-3923). WARN-capture assertions use the crate's existing `info_capture::capture()` facility (:6786-6797 → `(Arc<Mutex<Vec<CapturedEvent{message, fields}>>>, DefaultGuard)`; user precedent :6807-6851) — the request id is a structured FIELD, never message text.
- Test-facility facts (pinned by the load-bearing finder + the round-2 review, reports under the logs dir): `insert_compact_session` is ASYNC (:12991-12998 — every call needs `.await`); `compact_state_gated(config_body: &str, …)` (:12935-12987 — pass e.g. `r#"{"model":null}"#`); `send_msg_fenced(…, Option<u64>, Option<u64>)` (:6868-6886); there is NO `kill_msg`/`interrupt_msg` helper — build `FreshAgentKill`/`FreshAgentInterrupt` inline exactly as :15293-15300/:15353-15358 do; `fenced_observed(&registry, id) -> (Option<u64>, Option<u64>)` (:11413-11419); `seed_live_fresh_owner` (:11421-11452); `CompactFakeHttp` records EVERY request at ARRIVAL (:12700-12702, `recorded()` :12753 / `summarize_requests()` :12757); `frames_until` (:13001-13049) collects frames up to the FIRST match of its predicate — one call pins ONE frame; waiting for two different frames means TWO sequential calls; total-order assertions over a run use ONE `drain_frames(&mut rx)` at the end (frames land in emission order). The `Answered500`/`MidflightTransport` arms answer IMMEDIATELY today (only `OkAnswered` consults the summarize gate at :12884) — Task 3 hoists the consult. The prompt arm answers immediately (:12892-12898) — Task 3 adds the one-shot prompt gate. The DURABLE_CLOSE_FAILED clean-failure kill arm (:3100-3199) decrements `close_pending` (:3186) with `killed` NEVER set — the session survives "exactly as if the kill never ran"; existing kill-path test fixtures around :8359-:8942 rig the clean-failure arms.
- Focused Rust command: `cargo test -p freshell-freshagent --lib <filter> --locked` and `cargo test -p freshell-opencode --lib <filter> --locked` — cargo accepts exactly ONE positional TESTNAME filter per invocation; multiple tests are SEQUENTIAL single-filter invocations (narrowed selectors are uncoordinated).
- The new e2e specs must NOT be added to `CLOUD_SKIP_SPECS` (test/e2e-browser/playwright.cloud.config.ts:30-76) and must pass on the cloud backend (scoped cloud runs take POSITIONAL spec paths — `npm run test:e2e:cloud -- test/e2e-browser/specs/<spec>.ts`).

---

### Task 1: E2E red + fixture knob — the parked-summarize gate, the protocol-seam spec (RED on the base server), and the pane-story spec (pin)

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (summarize arm :1482-1515; env parsing beside the existing `FAKE_OPENCODE_*` vars)
- Test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (two new tests inside `test.describe('fresh-agent control surfaces — opencode lane (rust)')` :2167+)

**Interfaces:**
- Consumes: `bootOpencodeLane(page, extraEnv)` (:2088-2130 — `…extraEnv` flows into the Rust server's env, which the spawned `opencode serve` child inherits with no allowlist), `sendOpencodeTurn(page, harness, tabId, text, expectedPromptCount, auditLogPath, {expectResponseText})` (:2137-2165 — REAL composer send + materialization + idle + audit + the pane-level response assertion `expect(paneRoot).toContainText('Fake OpenCode response: …')`), the pane root locator `page.locator('[data-context="fresh-agent"]').last()` (the lane's own convention, :2138/:2168), the composer `/compact` flow precedent (:2170-2174 — fill + Enter on `getByRole('textbox', { name: 'Chat message input' })`), `readOpencodeAudit` (SYNCHRONOUS :2132-2134), `waitForLogEntry(path, pred, what)` (3rd argument required, :391-405), `waitForPaneStatus` (:497-501), `fs.mkdtemp` for the gate dir (the :2100 precedent), the page-side WS injector `window.__FRESHELL_TEST_HARNESS__.sendWsMessage` via `page.evaluate` (src/lib/test-harness.ts:128-134; spec-side precedent for evaluate-arg passing: :365), and `getSentWsMessagesWithTimestamps()` (test-harness.ts:58/196 — records every client-sent frame including injected ones; the frame-left sync point).
- Produces: fixture env knob `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH`; the two specs.

**Step 1: Add the fixture knob** — `fake-opencode.cjs`: parse `FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH` from env at startup (beside the existing `FAKE_OPENCODE_*` vars). In the `summarize` arm (:1482-1515): `appendAudit({event:'summarize', …})` and the busy SSE fire at REQUEST RECEIPT exactly as today; ONLY the `sendJson(res, 200, true)` + the idle emit defer behind a one-shot 50ms `setInterval` file-existence check (consume/rm the file when it appears), mirroring the `tuiParityChildEventGatePath` pattern (:723-762) with its `--pure` guard and `.unref?.()`. Without the receipt-vs-response split, the test's own in-flight poll deadlocks (the load-bearing finder's finding).

**Step 2: Write the two specs.**

(a) **The protocol-seam spec** — the deterministic server-queue proof (raw WS frame while the compact is parked; RED on the base server):

```ts
test('a raw send during a parked compaction is queued and delivered after the compact settles', async ({ page }) => {
  // The gate dir BEFORE boot (the mkdtemp precedent :2100).
  const gateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
  const gatePath = path.join(gateDir, 'release-summarize.flag')
  const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH: gatePath })
  const tabId = lane.tabId
  try {
    // Materialize + idle (the existing helper returns the durable ses_* id).
    const sessionId = await sendOpencodeTurn(page, lane.harness, tabId, 'first turn before compact', 1, lane.auditLogPath)

    // /compact through the composer (the :2170-2174 precedent): the
    // summarize POST parks on the gate file, so the compact drive is
    // deterministically in flight (the audit `summarize` entry lands at
    // REQUEST RECEIPT — the knob parks only the response).
    const paneRoot = page.locator('[data-context="fresh-agent"]').last()
    await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
    await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')
    await expect
      .poll(() => readOpencodeAudit(lane.auditLogPath).some(e => e.event === 'summarize'))
      .toBe(true)

    // A raw WS send — the server-side queue seam, deterministic while the
    // compact is parked (the browser's own composer would busy-gate it).
    // The frame is deliberately UNFENCED (no observed pair): the drain's
    // unfenced tolerance is the direct path's own tolerance, and this e2e
    // pins exactly that end-to-end.
    const frame = {
      type: 'freshAgent.send',
      requestId: 'e2e-queued-during-compact',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      text: 'sent while compacting',
    }
    await page.evaluate((f) => window.__FRESHELL_TEST_HARNESS__?.sendWsMessage(f), frame)
    // SYNC 1: the frame provably left the page (the harness records every
    // client-sent frame, injected ones included).
    await expect
      .poll(() => (window_getSent(page) as any[]).some(
        (m) => (m as any).requestId === 'e2e-queued-during-compact'))
      .toBe(true)

    // SYNC 2 + the NEGATIVE HOLD: the compact is provably still parked (no
    // audit entry after the summarize receipt — the knob gates the
    // response, and nothing else emits until it lands). Dwell a bounded
    // 1.5s inside that provably-parked window, then assert the queued
    // prompt NEVER posted. (A single immediate poll would be vacuous —
    // absence after a positive sync plus a bounded dwell while the gate is
    // verifiably held is the honest negative form.)
    await page.waitForTimeout(1_500)
    const auditWhileParked = readOpencodeAudit(lane.auditLogPath)
    expect(auditWhileParked.filter(e => e.event !== 'summarize').length).toBe(1) // only the first turn's prompt
    expect(auditWhileParked.some(
      e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')).toBe(false)

    // Release: the compact settles, the drain drives the queued send.
    await fs.promises.writeFile(gatePath, 'release')
    await waitForLogEntry(lane.auditLogPath,
      e => e.event === 'prompt_async' && e.prompt === 'sent while compacting',
      'the queued send drains after the compact settles')
    // ORDER: the compact's summarize POST happened BEFORE the queued prompt.
    const all = readOpencodeAudit(lane.auditLogPath)
    const summarizeIx = all.findIndex(e => e.event === 'summarize')
    const queuedIx = all.findIndex(e => e.event === 'prompt_async' && e.prompt === 'sent while compacting')
    expect(queuedIx).toBeGreaterThan(summarizeIx)

    await waitForPaneStatus(lane.harness, tabId, 'idle')
  } finally {
    await lane.server.stop().catch(() => {})
    await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
  }
})
```

(with `window_getSent(page)` a tiny local helper — `await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getSentWsMessagesWithTimestamps?.() ?? [])`; adapt names to the spec's conventions. The assertions above are the contract.)

(b) **The pane-story spec** — the explicitly requested typed-message pane behavior, through the REAL composer (pins the user story; passes on the base server — the client queue is today's behavior — and must STAY green):

```ts
test('a composer-typed message during a parked compaction is held, flushed on idle, and renders as a turn', async ({ page }) => {
  const gateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
  const gatePath = path.join(gateDir, 'release-summarize.flag')
  const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH: gatePath })
  const tabId = lane.tabId
  try {
    const sessionId = await sendOpencodeTurn(page, lane.harness, tabId, 'first turn before compact', 1, lane.auditLogPath)
    const paneRoot = page.locator('[data-context="fresh-agent"]').last()
    await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
    await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')
    await expect
      .poll(() => readOpencodeAudit(lane.auditLogPath).some(e => e.event === 'summarize'))
      .toBe(true)

    // THE USER STORY: type while the compact is parked. The composer stays
    // interactive; the client's own queue holds the message (busy).
    await sendComposerText(page, 'typed while compacting')
    // Held client-side: no prompt audit while parked.
    await page.waitForTimeout(1_500)
    expect(readOpencodeAudit(lane.auditLogPath).some(
      e => e.event === 'prompt_async' && e.prompt === 'typed while compacting')).toBe(false)

    // Release: the compact settles → idle → the client flushes → the
    // message POSTs → the pane renders the turn AND the assistant reply
    // (the sendOpencodeTurn response-text convention).
    await fs.promises.writeFile(gatePath, 'release')
    await waitForLogEntry(lane.auditLogPath,
      e => e.event === 'prompt_async' && e.prompt === 'typed while compacting',
      'the held message flushes after the compact settles')
    await expect(paneRoot).toContainText('Fake OpenCode response: typed while compacting', { timeout: 30_000 })
    await waitForPaneStatus(lane.harness, tabId, 'idle')
  } finally {
    await lane.server.stop().catch(() => {})
    await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
  }
})
```

**Step 3: Run both specs and verify the intended results** (the worktree is still at the base server for this task — Tasks 2-5 land the Rust changes):

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "raw send during a parked compaction"`

Expected: **FAIL** — the RED for the whole run: the base server REFUSES the injected mid-compact send (the D2-F1 uncorrelated refusal), so the queued prompt NEVER appears and the post-release `waitForLogEntry` times out. This red is real BECAUSE the knob parks the compact first (without the knob the compact would settle before the send and the test would pass through the direct path — the round-2 review's vacuity finding).

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "composer-typed message during a parked compaction"`

Expected: **PASS** — the pane story (the client queue + direct path) is today's behavior; this spec pins it so the server-side queue can never regress the typed-message UX.

**Step 4: Commit the task**

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/fresh-agent-control-rust.spec.ts
git commit -m "test(e2e): freshopencode send-during-compaction specs (red on base) + parked-summarize fixture knob"
```

---

### Task 2: Queue the send at the compact-in-flight seam (field + immediate accept + WARN)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (struct `OpencodeSession` ~:317-397; ctor ~:414-438; `handle_send` gate ~:1479-1493; fence parse currently at :1507-1521)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (replace `send_during_an_in_flight_compact_is_refused_and_leaves_the_compact_owned` at :15401-15507)

**Interfaces:**
- Consumes: `FreshAgentSend` (freshell-protocol, client_messages.rs:809-830; already `Clone`), `FreshAgentSendAccepted` (server_messages.rs:832-841), `wire_fence` (lib.rs:338-347), `send_error` (:826-842).
- Produces: `OpencodeSession.pending_sends: VecDeque<FreshAgentSend>` (used by Tasks 3-5).

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
    // lands freshAgent.killed (kill also drops the queue — Task 4 adds the
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
    /// the push-armed drain / the kill-enumeration decrement sites)
    /// re-enters the send path with it. `freshAgent.kill` and the handoff
    /// prior-stop drop the queue (WARN per entry); the drain re-checks the
    /// killed/close_pending gates before every re-drive.
    pending_sends: std::collections::VecDeque<FreshAgentSend>,
```

and in `OpencodeSession::new` (~:427): `pending_sends: std::collections::VecDeque::new(),` (add `use std::collections::VecDeque;` to the module imports if absent).

(b) Move the fence-parse block (verbatim, :1507-1521) to BEFORE the compact gate, still inside the lock: a half-sent fence is refused immediately, request-correlated — garbage must never enter the queue. The parsed `send_fence` then feeds the queue arm's fall-through and (until Task 3 extracts `send_locked`) stays in scope for the existing materialization claim at :1642.

(c) Replace the refusal arm (:1479-1493) with the queue arm:

```rust
        // send-during-compact queue: a send arriving while a COMPACT is in
        // flight — including the compact's settling tail (the tail is
        // still the compact's FIFO turn; Task 3's settling-flag gate
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
            // Task 3 appends the push-armed detached drain here
            // (`Self::drain_detached`) — the self-healing sliver closer.
            // In THIS task the parked entry simply waits for the drain
            // machinery the next task adds.
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

### Task 3: Drain the queue — settling marker, spawned hooks, push-armed drain, positive kill-enumeration trigger (FIFO, one at a time)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`TurnTask` :202-210; `handle_send` body → `send_locked` extraction ~:1507-2024; `handle_compact` drive task ~:3751-3934; send drive task ~:1976-2019; `handle_interrupt` ~:3459-3475; the Task 2 queue arm; `CompactFakeHttp` prompt arm :12892-12898 + summarize arm :12863-12890 + gate fields :12708-12747)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new tests beside the Task 2 test; mechanical updates to the three planted-TurnTask literals :7758/:15201/:16818)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 2).
- Produces:
  - `TurnTask { kind, handle, compact_settled_rx, settling: Arc<AtomicBool> }` — the emission-complete marker each drive task flips at the END of its settle tail (see Step 3b for the ordering-critical placement);
  - `async fn send_locked(&self, session_arc: &Arc<TokioMutex<OpencodeSession>>, session: &mut tokio::sync::MutexGuard<'_, OpencodeSession>, msg: FreshAgentSend, session_id: String, send_fence: Option<crate::ownership_lane::ObservedFence>, already_accepted: bool)` (Task 5 later adds the `op_guard` parameter);
  - `async fn drain_pending_sends(&self, lookup_id: &str)`;
  - `fn drain_boxed(this: &Self, id: String) -> Pin<Box<dyn Future<Output = ()> + Send>>` — the dyn-erased boundary (a PLAIN fn, never an async fn);
  - `fn drain_detached(this: &Self, id: &str)` — the ONE spawn helper every trigger site calls;
  - test-only: `await_prompt_posted(&http, text)` bounded async waiter on the compact fake's recordings;
  - test-fixture: `CompactFakeHttp::arm_prompt_gate(&self) -> Arc<tokio::sync::Notify>` (one-shot prompt park) and the hoisted summarize gate consult (Step 1 companion edits).

**Step 1: Write the failing behavioral tests** (+ the two test-facility companion edits they need)

The FIFO test below doubles as the self-deadlock/ordering red: without the END-of-tail `settling` flip, the compact tail's drain trips over its own still-registered task and the queued prompts NEVER post; with a START-of-tail flip, the next send's `running` would precede the compact's trailing `idle` — the end-of-test frame-order assertions pin which one is correct.

Fixture companion edit A (the failure arm must park — the round-2-verified fact that `Answered500`/`MidflightTransport` answer immediately, only `OkAnswered` consults the gate at :12884): in `CompactFakeHttp`'s `handle`, HOIST the summarize gate consult (`let gate = self.summarize_gate.clone();` + its `gate.notified().await`, :12884) to immediately AFTER the recorded-request + running-order-pin assert and BEFORE the `MidflightTransport` branch (:12863) — so `OkAnswered`, `Answered500`, and `MidflightTransport` all park identically. The `Undelivered` arm (the pre-record refusal, ~:12813) stays ungated. The ORDER-PIN assert (the busy `running` snapshot precedes the POST) stays exactly where it is.

Fixture companion edit B (the one-at-a-time witness): `CompactFakeHttp` gains a gate field + mutator mirroring `RollbackFakeHttp`'s `arm_revert_gate`/`arm_summarize_gate` (:16517-16528):

```rust
        /// send-during-compact queue (Task 3): when set, the FIRST
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

    // (6) THE EMISSION-ORDER CONTRACT (the round-2 review's ordering
    // finding): over the WHOLE run's frame stream, each drive's trailing
    // idle precedes the next drive's running — the compact settles (idle)
    // before send #1 starts (running), and send #1 settles before send #2
    // starts. One drain_frames at the end gives the total emission
    // order; positional assertions on the running/idle snapshot lists.
    let all_frames = drain_frames(&mut rx);
    let running_ix: Vec<usize> = all_frames.iter().enumerate()
        .filter(|(_, f)| is_event(f, "freshAgent.session.snapshot", Some("running")))
        .map(|(i, _)| i).collect();
    let idle_ix: Vec<usize> = all_frames.iter().enumerate()
        .filter(|(_, f)| is_event(f, "freshAgent.session.snapshot", Some("idle")))
        .map(|(i, _)| i).collect();
    // This rig emits exactly 3 runnings (compact, send 1, send 2) and 3
    // idles — assert the counts, then the cross-drive ordering.
    assert_eq!(running_ix.len(), 3, "compact + two sends each ran once");
    assert_eq!(idle_ix.len(), 3, "each drive settled once");
    assert!(idle_ix[0] < running_ix[1],
        "the compact's trailing idle precedes the first queued send's running");
    assert!(idle_ix[1] < running_ix[2],
        "the first send's trailing idle precedes the second queued send's running");
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
        "a settling registration is past its emissions — the drain proceeds");
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

Expected: FAIL — `TurnTask` has no `settling` field (compiles only after the struct change); with the struct change alone, the FIFO test fails on the drain gates (nothing drains), the settling test fails at assertion (a), and the interrupt/failure tests time out on `await_prompt_posted` (add the helper + fixture edits first; the intended red is the assertions, not a missing helper).

**Step 3: Add the minimal production implementation**

(a) **`TurnTask` gains the emission-complete marker** (:202-210):

```rust
struct TurnTask {
    kind: TurnTaskKind,
    handle: tokio::task::JoinHandle<()>,
    /// … (existing compact_settled_rx doc unchanged) …
    compact_settled_rx: Option<tokio::sync::oneshot::Receiver<()>>,
    /// Emission-complete marker (send-during-compact queue): the drive
    /// task flips this at the END of its settle tail — AFTER the last
    /// broadcast (the trailing `idle` snapshot), immediately before the
    /// tail's drain spawn. tokio's `JoinHandle::is_finished()` stays
    /// false until the task's future RETURNS, and the tail's broadcasts
    /// must ALL precede the next queued send's `running` (the round-2
    /// review's ordering finding: a START-of-tail flip would let a
    /// pushed drain drive mid-tail and broadcast `running` before this
    /// drive's trailing `idle` — the pane would flash idle while a send
    /// is active). The drain's in-flight gate is
    /// `!t.is_finished() && !t.settling.load(SeqCst)`: a settling
    /// registration has finished EMITTING (its drain is next, or
    /// kill/interrupt own the queue), while a LIVE unsettled drive
    /// still blocks — the no-stacking/no-misordering rule. Consulted
    /// ONLY by the drain gate: :3595 (compact busy), :4596 (rollback
    /// BUSY_TURN), :5213/:5483 (attach labels) keep reading
    /// `is_finished()` alone.
    settling: Arc<std::sync::atomic::AtomicBool>,
}
```

(b) **Spawn-site plumbing** — at the send spawn (in the extracted `send_locked`) and the compact spawn (:3775): create `let settling = Arc::new(std::sync::atomic::AtomicBool::new(false));`, clone it into the task (`let settling_task = Arc::clone(&settling);`), store the Arc in the `TurnTask` literal (:2020/:3935). In each drive task, the LAST statements of the settle tail flip it, then spawn the drain:

- send task — after `settle_turn_outcome(…)` (:2011-2018) and any trailing statement the tail has:
  `settling_task.store(true, Ordering::SeqCst);` then the drain spawn (e).
- compact task — after the failure WARN/error-broadcast block (:3908-3933), as the tail's final statements before the closing `});`:
  `settling_task.store(true, Ordering::SeqCst);` then the drain spawn (e).

(If the compiler flags a path that can skip the flip — an early `?`/`return` in the tail — restructure so the flip+spawn are the tail's single exit, or duplicate them at that exit; a drive task that returns without flipping would block its own queued sends until `is_finished()` turns true — recoverable but sloppy, and the tests would catch it.)

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
    /// double-fire). Task 5 adds the `op_guard` parameter (the armed
    /// attach guard moved into the drive and released at the prompt's
    /// dispatch boundary); this task's signature stays as written.
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

`handle_send` becomes: map lookup → session lock → killed/close_pending gate → fence parse → queue arm (Task 2; Task 3 appends the push-armed drain, (f)) → `self.send_locked(&session_arc, &mut session, msg, session_id, send_fence, false).await`.

(d) **The drain function + the dyn-erased spawn boundary (the probe-verified compile-correct shape):**

```rust
    /// Send-during-compact drain: drives at most ONE queued send (FIFO)
    /// when the session is quiescent; the driven send's own settle tail
    /// re-triggers for the next entry (one at a time). Triggers (EVERY
    /// one spawned via [`Self::drain_detached`] — never awaited):
    /// (a) the compact drive's settle tail — success AND failure;
    /// (b) the send drive's settle tail; (c) `handle_interrupt` after the
    /// aborted compact settles (the aborted task's tail never runs);
    /// (d) the queue arm's push (the self-healing sliver closer: a push
    /// landing behind a settling/finished registration with no upcoming
    /// tail gets drained immediately; a no-op when a live drive exists);
    /// (e) EVERY `close_pending` decrement site in the kill enumeration
    /// (Task 4) — the positive trigger that heals a compact settling
    /// during a kill's awaited durable close, including the
    /// DURABLE_CLOSE_FAILED clean-failure arm.
    ///
    /// GATES, in order: `killed` → return (kill dropped the queue under
    /// its own lock). `close_pending > 0` → return WITHOUT retry — the
    /// decrement sites re-trigger positively when the gate releases, so
    /// no bound can strand an accepted message. A live drive
    /// (`!is_finished() && !settling`) → return (that drive's settle
    /// tail is the next trigger).
    ///
    /// Refused entries are discarded with a request-correlated
    /// `send_error` (the client's owned-failure cleanup correlates by
    /// requestId) and the drain continues with the next entry. Kill and
    /// the handoff stop DROP the queue instead — the gates above are
    /// the belt-and-braces re-check for a drain racing those paths'
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
            // (Task 5 inserts the guard-based fence re-validation here.)
            session.pending_sends.pop_front();
            self.send_locked(&session_arc, &mut session, msg, real_id, send_fence, true).await;
            return; // one entry driven; its settle tail continues the FIFO
        }
    }

    /// The dyn-erased drain boundary (round-2 review finding, probe
    /// reports/recursion-probe.rs on rustc 1.96.0): a PLAIN fn returning
    /// a boxed future. The old trait solver cannot prove `Send`
    /// through any cycle of opaque async-fn futures (E0283/E0733) — no
    /// generator may store another opaque drain/send future. This
    /// boundary erases the drain's concrete future type at the spawn
    /// edge, so every spawn site is immune by construction.
    fn drain_boxed(this: &Self, id: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move { this.drain_pending_sends(&id).await })
    }

    /// The ONE drain spawn helper every trigger site calls (compact
    /// settle tail, send settle tail, handle_interrupt, the queue arm's
    /// push, the kill-enumeration decrement sites). Detached: tails
    /// never block on the session mutex, and the spawned task parks on
    /// the mutex if it races a lock holder — always safe.
    fn drain_detached(this: &Self, id: &str) {
        let this = this.clone();
        let id = id.to_string();
        tokio::spawn(Self::drain_boxed(&this, id));
    }
```

(e) **Hooks — every one goes through `drain_detached` (never an await).**

**Compact drive settle tail.** Inside the task, after the settling flip (b), as the final statements before the closing `});`:

```rust
            // send-during-compact queue: the compact settled (success OR
            // failure) and its emissions are complete — drain one queued
            // send; its own settle tail continues the FIFO. Spawned via
            // the dyn-erased boundary — never awaited (the recursive
            // future-type cycle + tail-blocking rules).
            Self::drain_detached(&this, &compact_id);
```

(Adapt `this`/`compact_id` to the task block's actual captured identifiers — the block owns a state clone; clone what the borrow checker asks for. The tail must be restructured so the flip+spawn are the single exit if it has early returns.)

**Send drive settle tail.** In `send_locked`'s spawned task, after the settling flip (b), after `settle_turn_outcome(…)` (:2011-2018):

```rust
            // send-during-compact queue: FIFO one-at-a-time — after this
            // send settles, drive the next queued entry (no-op when the
            // queue is empty). Spawned via the dyn-erased boundary —
            // never awaited.
            Self::drain_detached(&this, &real_id);
```

**`handle_interrupt`.** After the daemon-abort `match` (:3460-3474) in the materialized path, outside any held session lock (the lock scope ends at :3447):

```rust
        // send-during-compact queue: an interrupted compact never runs its
        // own settle tail (TurnTask doc :199-201), so THIS handler is the
        // drain trigger — after the abort settled and the daemon-side
        // abort resolved. Only kill drops the queue; interrupt does not.
        Self::drain_detached(self, &real_id);
```

(f) **The push-armed drain** — in the Task 2 queue arm, after the WARN, before `return`:

```rust
            // Self-healing sliver closer: arm a drain for this push. A
            // no-op when a live drive exists (the gate returns and that
            // drive's tail drains later); acts immediately when the
            // registration is settling/finished/absent with no upcoming
            // tail (the post-drain window where nothing else would
            // trigger). Spawned via the dyn-erased boundary — the
            // spawned drain parks on the session mutex; detached, so
            // the arm never blocks and no future type recurses.
            Self::drain_detached(self, &real_id);
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

**Step 5: Refactor while green** — the `send_locked` extraction must have moved code VERBATIM (only the three documented edits); re-verify no accidental logic drift against the pre-extraction diff. Do not otherwise restructure tests.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — every send-path test crosses the extraction; the compact suite covers hooks (e)/(interrupt); `compact_while_a_turn_is_in_flight_is_refused_and_never_posts` stays green (the drain never registers on a live task — the settling gate guarantees it, and the :3595 gate is untouched); the two fixture edits (the hoisted summarize consult, the prompt gate) keep the existing compact/kill/interrupt suite green — the consult hoist only adds a park to arms that previously answered (tests that do not arm the gate see no change).

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): drain freshopencode queued sends — end-of-tail settling marker, dyn-erased detached hooks, push-armed drain (FIFO)"
```

---

### Task 4: Kill and handoff drop the queue; the kill enumeration's decrement sites positively re-trigger the drain

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_kill` phase 3 ~:3216-3239 + ALL `close_pending` decrement sites — :2796, :2841, :2958, :2985, :3009, :3032, :3186; `opencode_kill_for_handoff` lock section ~:2267-2277)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (new tests beside the kill-mid-compact test :15256)

**Interfaces:**
- Consumes: `OpencodeSession.pending_sends` (Task 2), `Self::drain_detached` (Task 3), the kill paths' existing session-lock sections, the `info_capture` facility.

**Step 1: Write the failing behavioral tests**

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
    // and the decrement sites' self-gating spawns never drive).
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

#[tokio::test]
async fn a_queued_send_survives_a_clean_failed_kill_and_drains_after_the_close_gate_releases() {
    // THE STRANDING HEAL (the round-2 review's finding): the kill's
    // DURABLE_CLOSE_FAILED arm (:3100-3199) decrements `close_pending`
    // (:3186) with `killed` NEVER set — "the session is resumable
    // exactly as if the kill never ran". A compact settling inside that
    // awaited-close window parks its settle-tail drain behind
    // `close_pending > 0`; the drain returns. The decrement site's
    // positive trigger must heal it — the queued send drains with NO
    // new input, no matter how long the close took.
    // RIG: adapt the existing clean-failure kill fixture (the kill-path
    // tests around :8359-:8942 rig the DURABLE_CLOSE_FAILED /
    // clean-failure abort arms — reuse exactly that fixture's
    // construction for making the durable close fail), plus: a parked
    // compact, a queued send, and the release landing while the kill's
    // enumeration holds `close_pending > 0`.
    // 1. Park the compact (the standard gated rig), queue one send.
    // 2. Trigger the kill whose durable close FAILS cleanly (the
    //    existing fixture's mechanism).
    // 3. Release the summarize gate DURING the kill's awaited close
    //    window (the settle-tail drain spawns, sees close_pending > 0,
    //    returns).
    // 4. The kill completes with FreshAgentKilled{success:false,
    //    code:DURABLE_CLOSE_FAILED} (the pre-existing broadcast) and
    //    `killed` stays false, `close_pending` returns to 0.
    // ASSERT: the queued prompt POSTs (bounded await_prompt_posted) —
    //    the decrement site's drain_detached fired — with no further
    //    input from the test.
}
```

(The second test's rig adapts the existing clean-failure fixture — name the concrete fixture during implementation by reading the kill-path tests around :8359-:8942; the ASSERTIONS above are the contract: refusal broadcast + prompt drains + queue empty. If the existing fixture cannot be combined with the compact-parked rig without new fake machinery, add the minimal fake-side knob to script the durable-close failure — the fixture precedent for scripting kill-path failures is in those tests.)

**Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_survives_a_clean_failed_kill --locked`

Expected: FAIL — no drop site exists yet (first test); the decrement sites have no trigger, so the queued send strands (second test: `await_prompt_posted` times out).

**Step 3: Add the minimal production implementation**

(a) `handle_kill` phase 3, inside the same session-lock section that sets `killed` (:3225), immediately AFTER the `killed.store(true)`:

```rust
            // send-during-compact queue: a killed pane drops its queued
            // sends (WARN per entry — a message must never silently
            // disappear). Under the SAME phase-3 lock so the drop is
            // atomic with `killed`: a queueing send parked on this lock
            // serializes either before (its entry is dropped here) or
            // after (it observes killed at the :1455 gate and refuses
            // typed). The drain's killed gate (and the decrement sites'
            // self-gating spawns) are the backstops for a drain
            // mid-drive racing this lock.
            while let Some(msg) = s.pending_sends.pop_front() {
                tracing::warn!(target: "freshell_freshagent::opencode",
                    session_id = %session_id, request_id = ?msg.request_id,
                    "fresh_agent_send_dropped_on_kill");
            }
```

(Adapt `s`/`session_id` to the phase-3 section's actual guard and identifier names verbatim.)

(b) `opencode_kill_for_handoff`, inside its session-lock section (:2267-2277), same block with `"fresh_agent_send_dropped_on_handoff"` — the queue must NOT follow the session to the handoff target (the target rebuilds a fresh session object via `resume_durable_session`; silently carrying user-typed prompts across the transition would fire them on a pane that never typed them).

(c) **The positive trigger — EVERY `close_pending` decrement site.** Search the file for `close_pending` writes (:2796, :2841, :2958, :2985, :3009, :3032, :3186 — audit for any the search misses). At each decrement, immediately after it, spawn the self-gating drain:

```rust
            // send-during-compact queue: the enumeration gate released
            // for THIS session — positively re-trigger the drain. A
            // compact that settled while the kill's awaited close held
            // `close_pending > 0` parked its settle-tail drain; this is
            // the only time-unbounded heal (any in-drain retry bound
            // would strand an accepted message when the close outlives
            // it — the round-2 review's finding). `drain_detached` is
            // self-gating: killed (the kill dropped the queue) or a
            // live drive or an empty queue are all no-ops.
            Self::drain_detached(self, &<the site's session id>);
```

(Adapt the identifier to each site's in-scope session id — the sites hold a `session_arc`/`s` guard; the spawn happens under the lock and is non-blocking. `drain_detached` resolves via the sessions map, so pass the map-lookup id the site already names.)

**Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::kill_with_a_queued_send_drops_it --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_queued_send_survives_a_clean_failed_kill --locked`

Expected: PASS.

**Step 5: Refactor while green** — if a shared tiny drop-and-warn helper reads better than two inline loops, extract it — but keep the distinct WARN messages (kill vs handoff are different user stories in the logs). The seven decrement-site triggers are one identical statement each — do not wrap them further.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS — the kill suite (:15256-15331, :7735-7817, the handoff tests around :13291, the clean-failure tests around :8359-:8942) crosses these sections.

**Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): freshopencode kill/handoff drop queued sends (WARN per entry); kill-enumeration decrement sites re-trigger the drain"
```

---

### Task 5: Drain-time fence re-validation — guard-armed, released at the prompt's dispatch boundary (typed, request-correlated stale refusal)

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs` (`run_turn` :1491-1503 — gains the additive second witness param; `prompt_async` :1079-1086 — gains the same additive param, mirroring `compact`'s two-witness collection :1208-1217)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`drain_pending_sends`, the Task 3 loop; `send_locked` — adds the `op_guard` parameter + the fresh per-drive dispatch witness + the select! release; the send drive task)
- Test: `crates/freshell-opencode/src/serve.rs` (the mirror of the :1982 witness test); `crates/freshell-freshagent/src/opencode_ws.rs` (two new tests beside the Task 3 drain tests)

**Interfaces:**
- Consumes: `crate::ownership_lane::arm_reclaimless_op_guard` (lib.rs:392 — `(&Option<Arc<RuntimeOwnershipRegistry>>, provider, session_id, operation_id, observed: Option<ObservedFence>, initiator) -> LaneOpGuard`), `crate::ownership_lane::LaneOpGuard::{Armed(freshell_ownership::AttachGuard), Unwired, Refused{message}}` (lib.rs:348-368 — the fork's call shape at :4090-4115 is the in-file precedent), `send_error` (:826-842 — see the Global Constraints wire-reality note), the test fixtures `seed_live_fresh_owner` (:11421-11452) + `fenced_observed` (:11413-11419), `json_request_maybe_witnessed` (serve.rs — the witness-firing request leg), and the compact drive's guard-release precedent (opencode_ws.rs:3783-3807 — the select! racing the fresh dispatch witness, `drop(op_guard.take())`).
- Produces: the drain's guard-armed consult; `run_turn(…, accepted_witness, dispatched_witness)` and `prompt_async(…, dispatched_witness)` additive params; `send_locked(…, op_guard: Option<freshell_ownership::AttachGuard>, …)`.

**Semantics (the load-bearing design decisions, settled in review rounds 1-2):**

- FENCED entries arm the lane's op guard with the CAPTURED pair — the atomic validation + held-attach-guard shape the repo's own ownership-lane docs sanction (lib.rs:346-361: a bare unlocked observe-then-act is exactly the TOCTOU the guard exists to close). `Refused{message}` (stale pair, non-Live owner, lifecycle-blocked) → WARN + pop + request-correlated `send_error(&msg.request_id, "SESSION_RESERVED", &message)` + continue with the next entry. `Armed(guard)` → the guard moves into `send_locked` → into the spawned drive block and is released **at the prompt POST's DISPATCH BOUNDARY** — the compact drive's own reviewed discipline (:3783-3807): a `tokio::select!` races the drive future against a 5ms poll on a FRESH per-drive dispatch witness; whichever resolves first drops the guard exactly once. The guard covers exactly the arm→dispatch check-then-act window; POST-dispatch, the reviewed R2-5 abort machinery owns the window exactly as for compacts (a handoff landing mid-prompt aborts the daemon-side work before the reap — the quiesce contract `opencode_handoff_during_compaction_aborts_the_daemon_side_summarize` pins). The witness MUST be a FRESH per-drive `Arc<AtomicBool>` (created OUTSIDE the drive block, moved in — the compact's :3763 discipline), NOT the session's `daemon_turn_accepted` flag: that flag is session-lifetime and can be stale-armed by an earlier ambiguous failure, which would release the guard pre-dispatch. `Unwired` → proceed (the tolerance every reclaim-less lane applies when no coordinator is wired).
- UNFENCED entries (no observed pair on the wire message) keep the DIRECT SEND PATH's parse-only tolerance — they proceed without arming the guard. The op guard's no-laundering discipline (an unfenced `None` against a Live key is the typed FENCE_REQUIRED refusal, lib.rs:434-475) binds the history-RESTRUCTURING lanes (compact/rollback/fork); the SEND lane has never consulted the coordinator for unfenced sends — `handle_send`'s direct path is fence-parse-only, and the queue re-enters that path. The queue must not be stricter than the path it re-enters: an unfenced send firing post-compact is exactly what the direct path does with the same frame the moment the pane is idle. (A future policy decision may tighten unfenced sends — at the DIRECT path too, not just the drain — but that is a different run.)

**Step 1: Write the failing behavioral tests**

(a) `crates/freshell-opencode/src/serve.rs` — the witness-param mirror of the :1982 test (`run_turn_arms_the_accepted_witness_at_the_dispatch_boundary`): a fresh `Arc<AtomicBool>` passed as `run_turn`'s NEW trailing `dispatched_witness` param flips when the prompt POST's request leg runs — and NOT before (the test's existing shape pins the boundary: assert false before the POST is issued, true after; mirror :1982's rig exactly, adding the second flag). RED: the param doesn't exist (compile error is the red; write the test against the NEW signature).

(b) `crates/freshell-freshagent/src/opencode_ws.rs`:

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

Run: `cargo test -p freshell-opencode --lib serve::tests::run_turn_arms_the_dispatched_witness --locked` (name per the crate's test-module convention; the compile error is the red until the param exists, then the boundary assertion is the red until prompt_async threads it)
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_unfenced_queued_send_drains_like --locked`

Expected: FAIL — the stale entry POSTs like a current one (no `error` frame with its requestId); the unfenced tolerance test passes trivially pre-consult and pins the semantics against regressions.

**Step 3: Add the minimal production implementation**

(a) **serve.rs — the additive witness param.** `prompt_async` (:1079-1086) gains a trailing `dispatched_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>` and collects BOTH witnesses into the vec passed to `json_request_maybe_witnessed` — the exact shape `compact` uses (:1208-1217: both flip INSIDE the request leg at the true send point). `run_turn` (:1491-1503) gains the same trailing param and threads it through. `#[allow(clippy::too_many_arguments)]` on `run_turn` if it trips (the compact precedent, :1195). The existing call sites (`run_turn`'s single freshagent caller, any serve.rs test callers) pass `None` for the new param — behavior-identical.

(b) **The freshagent drain's guard consult** — in `drain_pending_sends`, replace the Task 3 placeholder comment with:

```rust
            // Drain-time fence re-validation (the user constraint): the
            // entry's captured pair is validated ATOMICALLY via the
            // lane's op guard — never a bare unlocked observe-then-act
            // (the exact TOCTOU the guard's docs exist to close). FENCED
            // entries only: an unfenced entry keeps the direct send
            // path's parse-only tolerance (the queue re-enters the send
            // path; it is not stricter than the path it re-enters — the
            // no-laundering discipline binds the history-restructuring
            // lanes, not the append-a-turn send lane).
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

(c) **`send_locked` gains the guard + the select! release at the dispatch boundary.** New parameter (before `already_accepted`): `op_guard: Option<freshell_ownership::AttachGuard>`; the direct `handle_send` call site passes `None`; the drain passes the armed guard. In the spawned drive task (mirroring the compact's :3763-3807 discipline — constructed OUTSIDE the async block and moved in, so a never-started future still drops the guard with its captures):

```rust
            // The FRESH per-drive dispatch witness (NOT the session's
            // daemon_turn_accepted flag — that one is session-lifetime
            // and can be stale-armed by an earlier ambiguous failure,
            // which would release the guard pre-dispatch). Constructed
            // outside the block, moved in — the compact's :3763 shape.
            let prompt_dispatched = std::sync::Arc::new(
                std::sync::atomic::AtomicBool::new(false));
            let dispatch_witness = prompt_dispatched.clone();
            let mut op_guard = op_guard; // Option<AttachGuard>, owned here
            let mut turn_fut = Box::pin(manager.run_turn(
                &real_id, &text, model.as_deref(), effort.as_deref(),
                DEFAULT_TURN_TIMEOUT, route.clone(),
                Some(daemon_turn_accepted.clone()),
                Some(dispatch_witness),
            ));
            // The compact's own guard-release discipline (:3796-3807):
            // race the fresh dispatch witness against the drive. The
            // guard releases at the DISPATCH boundary — the prompt POST's
            // request leg — the mutation's point of no return; it must
            // NOT live through the turn's await-idle tail (a handoff
            // would block on a read-only poll), and it must NOT release
            // before dispatch (the arm→dispatch check-then-act window is
            // exactly what the guard exists to close). Whichever
            // resolves first drops the guard exactly once.
            let mut released_at_dispatch = Box::pin(async {
                loop {
                    if prompt_dispatched.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            });
            let turn_result = tokio::select! {
                _ = &mut released_at_dispatch => {
                    drop(op_guard.take());
                    turn_fut.as_mut().await
                }
                result = turn_fut.as_mut() => result,
            };
            drop(released_at_dispatch);
            drop(op_guard.take()); // never-dispatched paths (errors, aborts)
            let result = turn_result;
```

(The existing `match &result` / `settle_turn_outcome` / settling flip / `Self::drain_detached` tail then continues unchanged. For the direct path (`op_guard == None`) the select runs with a None guard — `drop(op_guard.take())` is a no-op and the shape stays single-path; the 5ms witness poll ends the moment the prompt dispatches. Adapt `text`/`model`/`effort`/`route` to the drive block's actual captured identifiers.)

**Step 4: Run the focused tests**

Run: `cargo test -p freshell-opencode --lib serve::tests::run_turn_arms_the_dispatched_witness --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::a_stale_queued_fence_refuses_typed --locked`
Run: `cargo test -p freshell-freshagent --lib opencode_ws::tests::an_unfenced_queued_send_drains_like --locked`

Expected: PASS.

**Step 5: Refactor while green** — confirm the `send_locked` call passes the SAME `send_fence` the guard validated (no second parse) and the armed guard genuinely reaches the drive block (the borrow checker enforces the move — that IS the correctness discipline). The Task 3 fence-parse and this consult are now one coherent re-validation block.

**Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`
Run: `cargo test -p freshell-opencode --locked`

Expected: PASS — including the whole fence suite (:7818-8082), the compact guard tests (the drain's operation ids are new and unique per drive, so no interference), and serve.rs's witness tests.

**Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(fresh-agent): guard-armed request-correlated stale-fence refusal for freshopencode queued-send drains (dispatch-boundary release via the fresh witness)"
```

---

### Task 6: E2E green + AGENTS.md note + the cloud lane

**Files:**
- Modify: `AGENTS.md` (the freshopencode sentence in the orchestration/status section)
- Test: the two Task 1 specs (no new spec files — this task turns the RED green and lands the coverage on the cloud backend)

**Step 1: Run the Task 1 protocol-seam spec — it must now be GREEN**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "raw send during a parked compaction"`

Expected: PASS — the server queues the injected mid-compact send (immediate acceptance), the negative hold holds (no prompt while parked), and the post-release drain POSTs the prompt after the summarize.

**Step 2: Run the pane-story spec — must stay GREEN**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "composer-typed message during a parked compaction"`

Expected: PASS (the client queue + the direct path; the server changes must not regress it).

**Step 3: AGENTS.md** — append to the freshopencode sentence in the orchestration/status section: "A freshAgent.send arriving while a native /compact drive is in flight — or while older queued sends are still pending — is queued server-side (FIFO, immediate send.accepted) and auto-driven when the compact settles; kill drops the queue, and the drain re-validates a captured observed fence through the lane op guard (stale pairs refuse typed, request-correlated), releasing the guard at the prompt's dispatch boundary."

**Step 4: Client regression (untouched by this run)**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

**Step 5: The cloud lane** (scoped cloud runs take POSITIONAL spec paths; never add the specs to CLOUD_SKIP_SPECS):

Run: `FRESHELL_E2E_BACKEND=cloud npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS on the cloud backend (the constraint's PR-readiness rule — the whole spec file, both new tests included).

**Step 6: Commit the task**

```bash
git add AGENTS.md
git commit -m "docs: freshopencode send-during-compact queue behavior (AGENTS.md)"
```

---

## Verification summary

1. Focused per task: `cargo test -p freshell-freshagent --lib <filter> --locked` / `cargo test -p freshell-opencode --lib <filter> --locked` — ONE positional filter per invocation; multiple tests run as SEQUENTIAL single-filter invocations.
2. Whole-crate after every task: `cargo test -p freshell-freshagent --locked` (+ `cargo test -p freshell-opencode --locked` after Task 5).
3. E2E: the Task 1 protocol-seam spec is the run's RED (verified on the base server with the knob in place); Task 6 turns both Task 1 specs green locally, then the cloud lane.
4. Client regression (Task 6): the FreshAgentView outgoing-message-queue vitest suite stays green, untouched.
5. The repo's pre-push gate (cargo fmt, clippy, targeted cargo test) runs on push; the branch's final full-suite gate runs via the coordinator (`FRESHELL_TEST_SUMMARY=… npm test`) from the worktree — pass the GCLOUD_* identity env explicitly (GCLOUD_IDENT, GCLOUD_ROBOT_HOME, GCLOUD_ROBOT_ACCOUNT): ambient tool shells do not source ~/.bashrc and the cloud lanes fail closed on expired ambient gcloud.
6. No client (src/) changes; the compact-during-turn refusal (:3595) and the other `is_finished()` readers (:4596, :5213/:5483) are untouched.
7. Design evidence and API pins live in `.worktrees/.the-usual-logs/send-during-compact-queue/reports/` (load-bearing-finder.md, load-bearing-strategist.md, the five planning reports, recursion-probe.rs); the round-1 plan-review report (fresheyes-plan/usual-fresheyes-20260921T023038Z-2052070.md) is the provenance of the v3 corrections and the round-2 report (fresheyes-plan/usual-fresheyes-20260921T191335Z-3352756.md) of these v4 corrections (all six findings verified against the code before this rewrite: the recursion by compiled probe, the guard contract by the compact's own :3783-3807 discipline, the stranding by the :3186 DURABLE_CLOSE_FAILED arm, the ordering by the broadcast flow, the e2e vacuity by the poll semantics, the pane coverage by the sendOpencodeTurn precedent :2137-2165).
