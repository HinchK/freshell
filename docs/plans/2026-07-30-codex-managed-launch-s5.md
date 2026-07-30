# Codex Managed-Launch Slice 5 (DEV-0006 S5.a–S5.e) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Land the revised Slice 5 of the DEV-0006 codex managed-launch spec — drain the parked
`RemoteProxyEvent` stream into the existing identity/activity tails, arbitrate locator-vs-proxy,
enforce `require_candidate_persistence`, complete the structural prerequisites, resolve
D-C-REVISIT, flip `FRESHELL_CODEX_MANAGED_LAUNCH` default ON, and close DEV-0006 + DEV-0008.

**Architecture:** A per-terminal drain task spawned inside `CodexTerminalLaunchManager::adopt`
forwards proxy events (tagged with terminal id + plan cwd) into a set-once process-wide sink
channel; a single router task in `freshell-ws` (which owns `WsState`) consumes the channel and
routes `Candidate` → `adopt_codex_identity`, turn events → a new third activity-tracker lane, and
everything else → minimal logging. The candidate-persistence gate is ported into the proxy hub
(hold `turn/start`/`thread/fork` until the router persists the candidate, 45 s capture timeout,
legacy parity). The flag flip is preceded by the D-C-REVISIT resolution (a sidecar planning
budget covering both doors + moving the REST spawn-gate acquire to after the codex plan).

**Tech Stack:** Rust (tokio, tokio-tungstenite), crates `freshell-codex`, `freshell-ws`,
`freshell-activity`, `freshell-freshagent`, `freshell-platform`, `freshell-server`; markdown
record ledgers under `port/oracle/`.

**Spec:** `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` (revised Slice 5,
lines 245–320; §6 fences; §8 reconciliation). The spec is authoritative.

**Workspace:** the worktree `/home/dan/code/freshell/.worktrees/codex-managed-launch-s5`
(branch `feat/codex-managed-launch-s5`, based on `main` @ `6d0e285b`). Work from committed
HEAD only — the main repo's working tree has unrelated uncommitted changes; never touch it.

**Workspace setup (verified 2026-07-30, load-bearing ledger A27):** before trusting the
`freshell-freshagent` suite, run `npm ci` in the worktree root — 12 of its tests resolve the
`tsx` MCP dependency via `node_modules/` and fail with
`Unable to resolve MCP dependency "tsx"` on a fresh worktree (environmental, not code).
Baseline otherwise: `cargo check --workspace --all-targets` clean; codex/activity/platform/
ws(--lib) suites green. Known flake: `pane_ledger::new_locked_degrades_to_disabled_when_another_holder_exists`
is load-flaky under WSL2 (flock EWOULDBLOCK) — rerun it isolated before blaming a change.

## Global Constraints

Every task's requirements implicitly include this section. All are copied from the spec.

- **Single-writer identity discipline** (spec S5.a, §7.6): codex identity has exactly ONE
  writer path — `codex_identity::adopt_codex_identity` / `rebind_codex_identity`. Do NOT
  build a second identity writer; do NOT upsert identity/registry/ledger/broadcast from any
  new code path directly.
- **The pane ledger IS the durability store** — do NOT port
  `server/coding-cli/codex-app-server/durability-store.ts` (spec S5.a; its Rust substrate was
  deleted in `35cf2864`).
- **Do NOT port `codexForkHandoff`** (`server/terminal-registry.ts:547-556, 2034-2400`) —
  fork candidates route through the landed rebind lane or are deliberately ignored (spec S5.a).
- **NO display-id wiring; NO resolver rework; NO new codex app-server client** (spec §6). The
  argv resolver is done (G-X1/G-X2/G-W2); feed it a URL, don't touch it.
- **NO touching `server/ shared/ src/`** (campaign additive-only purity rule) and **no behavior
  change to non-codex modes** (spec §6).
- **Sidecar-level re-plan-on-loss stays deferred** (spec §6 fence): `RepairTrigger` /
  lifecycle-loss handling is log-only; recovery belongs to the auto-resume orchestrator.
- **Do NOT reorder the pinned identity write tail** (`codex_identity.rs:182-185`):
  `identity.upsert` → `registry.set_meta` → awaited `ledger_resolve_identity` → broadcast
  `terminal.session.associated` THEN `terminal.meta.updated` → activity hub.
- **Meta enrichment (git branch/dirty, tokenUsage) is out of scope** (spec S5 out-of-scope
  list) — `TerminalMetaRecord` enrichment fields stay `None`.
- **WS raw-resume "alignment" is out of scope** (spec S5 out-of-scope list).
- Legacy-parity constants (from `server/coding-cli/codex-app-server/remote-proxy.ts`):
  candidate capture timeout **45_000 ms** (`:94`), request hold timeout **5_000 ms** (`:93`),
  max held gate frames **32**; gated client methods on initial capture: exactly
  **`turn/start` and `thread/fork`** (`remote-proxy.ts:422-425`).
- Before every commit, run for each touched Rust crate: `cargo fmt --all` and
  `cargo clippy -p <crate> --all-targets -- -D warnings` (for `freshell-codex` also
  `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings`,
  mirroring `.github/workflows/rust-clippy.yml:41-56`).
- Line numbers cited below are from `main` @ `6d0e285b` and WILL drift as tasks land —
  re-anchor by searching for the quoted code, not by line number.
- README.md is the only end-user markdown doc; everything this plan adds under `docs/plans/`
  and `port/oracle/` is working/record documentation.

## Recorded Decisions (the spec's DECIDE items — read before implementing)

These are the decisions the spec explicitly requires S5 to make and record. Tasks below
implement them; Task 13 records them in the ledgers.

- **D-SINK (S5.d.2, singleton→DI):** The manager stays a process-global singleton. Instead of
  converting the 12 `::global()` call sites to DI, `freshell-codex` gains a **set-once
  proxy-event sink channel** (the spawn-gate set-once-handle precedent the spec itself names).
  The drain task never needs `WsState`; all `WsState` access happens in the `freshell-ws`
  router on the far side of the channel. This honors "spawn ONE per-terminal drain task at
  `CodexTerminalLaunchManager::adopt` (covers all three adopt sites)" literally — REST-created
  panes included, even though `freshell-freshagent` cannot name `WsState`.
- **D-03 (S5.b, locator-vs-candidate precedence):** *For managed panes the proxy candidate is
  authoritative and the association locator never arms; for unmanaged panes the locator is the
  only writer (no proxy exists). On the same terminal, first bind wins: the router ignores a
  later proxy candidate carrying a different session id (identity moves only through the fork
  rebind lane).* Suppression happens at arm time (`maybe_arm`), never via `locator.disarm`
  (disarm would also kill the fork watch, `codex_locator.rs:263-267`).
- **D-FORK (S5.a fork candidates):** Proxy `Candidate` events with
  `source == CandidateSource::ThreadForkResponse` are **deliberately ignored** (logged at
  debug). The landed disk fork-watch lane (`locator.watch_fork` → `tick_forks` →
  `rebind_codex_identity`, D7/A13/A8 guards) owns fork rebinds; the router registers
  `watch_fork` for managed panes right after candidate adoption so managed fresh panes get
  the same fork coverage resume panes already have (`terminal.rs:2442-2446`).
- **D-REASON (S5.d.3, binding_reason):** `CodexLaunchPlan.binding_reason` is **explicitly
  dropped** at adoption. Rationale: the Rust adoption tail derives adopt-vs-rebind from
  context (its own reason vocabulary), no Rust protocol frame ever carried
  `sessionBindingReason`, and the only legacy consumer (`codex-activity-tracker.ts`) is
  superseded by the ported tracker which does not need it. The wire-string pin test
  (`launch_plan.rs:414-417`) stays. Recorded in code docs (Task 3) and the DEV-0006
  closure_progress (Task 13).
- **D-C-R (S5.e precondition, D-C-REVISIT):** Two-part resolution. (1) A **sidecar planning
  budget** inside `CodexTerminalLaunchManager::plan_create_with_retry` — a semaphore of 2
  concurrent codex plans with a bounded 30 s wait that fails fast — covering ALL doors (WS
  create, WS restore, WS auto-resume, REST). (2) The **REST door's spawn-gate acquire moves
  to after the codex plan** (inside `settle_gated_create`, immediately before the PTY fork),
  mirroring the WS auto-resume door's plan-before-acquire ordering with the same
  discard-on-rejection cleanup (`terminal.rs:2925-2929` precedent). Residual: WS
  restore-creates still plan under the caller-held permit (`create_gate.rs:74`), now bounded
  by the budget (at most 2 such long holds server-wide); accepted and recorded in the §D-C
  addendum (Task 13).
- **D-GATE-SOFT (S5.c timeout consequence):** On candidate-capture timeout/failure, legacy
  kills the terminal (`failCodexFreshIdentity` → `killAndWait`). The port answers held frames
  with JSON-RPC `-32000` errors, closes all proxy connections, and emits
  `RepairTrigger::CandidateCaptureTimeout` which the router **logs** (S5.a says repair
  handling is minimal; re-plan-on-loss is fenced off). The pane survives with honest identity
  absence and a visibly dead TUI remote. Recorded in Task 13.
- **D-CLOSED (S5.e records):** `port/oracle/DEVIATIONS.md`'s declared status vocabulary
  (`:25`) is extended with `closed`, because the spec instructs "DEV-0006 → `closed`" and no
  closed precedent exists in the ledger.

## File Structure (what gets created/modified where)

- `crates/freshell-codex/src/remote_proxy.rs` — identity gate (hold/release/fail/timeout),
  new `HubMsg` variants, options timeouts, `RemoteProxyRepairTrigger::CandidateCaptureTimeout`.
- `crates/freshell-codex/tests/candidate_gate.rs` — NEW: gate integration tests (pure-Rust
  fake upstream).
- `crates/freshell-codex/tests/remote_proxy_relay.rs` — gate release added to the two
  `thread/fork` rewrite tests (every relay test constructs the proxy with
  `require_candidate_persistence == true`, so the new gate holds their fork frames otherwise).
- `crates/freshell-codex/src/launch_lifecycle.rs` — persistence plumbing on sidecar+manager,
  drain task + set-once sink, sidecar planning budget, pub spawn helpers.
- `crates/freshell-codex/src/launch_plan.rs` — flag default flip, binding_reason decision doc.
- `crates/freshell-activity/src/codex.rs` — third (proxy) lane + generalized cross-lane dedupe.
- `crates/freshell-ws/src/activity.rs` — `HubEvent::CodexProxyTurn` + `note_codex_proxy_turn`.
- `crates/freshell-ws/src/codex_proxy_route.rs` — NEW: the router (candidate/turn/fork/repair
  routing, D-03 rule, persistence release).
- `crates/freshell-ws/src/codex_association.rs` — `should_arm_codex_locator` +
  managed-suppression parameter.
- `crates/freshell-ws/src/terminal.rs` — arm-site suppression, gate-test updates, comment
  updates.
- `crates/freshell-ws/src/lib.rs` — `pub mod codex_proxy_route;`.
- `crates/freshell-server/src/main.rs` — boot wiring (sink install + router spawn).
- `crates/freshell-freshagent/src/codex.rs` — spawn-helper unification (delete duplicated
  const/fns, use canonical spec + shared helpers).
- `crates/freshell-freshagent/src/terminal_tabs.rs` — REST acquire move, D-C marker update,
  gate-helper test updates.
- `crates/freshell-ws/tests/{codex_fork_rebind,codex_locator_activity,codex_session_ref_resume,codex_candidate_inert}.rs`
  — pin the flag OFF (`set_var(.., "0")`).
- `crates/freshell-ws/tests/codex_managed_launch_e2e.rs` — inverted legs + resume phase.
- `crates/freshell-platform/src/cli_launch_goldens.rs` — retire G-X0, promote G-X1/G-X2.
- `port/machine/specs/cli-argv-fidelity.md`, `port/machine/STATE.yaml`, `port/HANDOFF.md` —
  golden/record mirrors.
- `port/oracle/DEVIATIONS.md`, `port/oracle/EQUIVALENCE-REPORT.md`,
  `docs/plans/2026-07-27-rest-spawn-gate.md`,
  `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` — closures + decision records.

Task order is dependency order: 1→2→3 (gate, plumbing, drain) can be reviewed independently;
4→5→6 (activity lane, hub API, router) build on 3; 7 (locator suppression) needs 6's rule; 8
(spawn unification) is independent; 9 (D-C) must precede 10 (flip); 10–12 are the flip and its
test estate; 13 closes the records.

---

### Task 1: Candidate-persistence gate in the proxy hub (S5.c core)

**Files:**
- Modify: `crates/freshell-codex/src/remote_proxy.rs`
- Modify: `crates/freshell-codex/tests/remote_proxy_relay.rs` (release the gate in the two
  fork-rewrite tests — see Step 3i)
- Test: `crates/freshell-codex/tests/candidate_gate.rs` (new)

**Interfaces:**
- Consumes: existing `CodexRemoteProxy::start`, `Hub`, `HubMsg`, `handle_client_frame`
  (`remote_proxy.rs:723-782`), `send_json_rpc_error_to_client`, `scan_json_rpc_envelope`.
- Produces (later tasks rely on these exact names):
  - `impl CodexRemoteProxy { pub fn mark_candidate_persisted(&self); pub fn fail_candidate_capture(&self, message: &str); }`
  - `RemoteProxyRepairTrigger::CandidateCaptureTimeout` (new enum variant, fieldless)
  - `CodexRemoteProxyOptions { pub candidate_capture_timeout_ms: u64, pub identity_gate_hold_timeout_ms: u64, .. }`
    (defaults below; `CodexRemoteProxyOptions::new` keeps its current 2-arg signature and
    fills the defaults)
  - `pub const CANDIDATE_CAPTURE_TIMEOUT_MS: u64 = 45_000;`
  - `pub const IDENTITY_GATE_HOLD_TIMEOUT_MS: u64 = 5_000;`
  - `pub const MAX_HELD_IDENTITY_GATE_FRAMES: usize = 32;`

Legacy reference (parity target): `server/coding-cli/codex-app-server/remote-proxy.ts` —
gate holds client→upstream **requests** with method `turn/start` or `thread/fork` only
(`:422-425`); `DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS = 45_000` (`:94`, overridable `:139`);
`DEFAULT_REQUEST_HOLD_TIMEOUT_MS = 5_000` (`:93`, armed on the FIRST held frame); on
timeout/failure the held frames are answered with JSON-RPC `-32000` errors (never forwarded),
all connections closed, and a `repair_trigger{kind:'candidate_capture_timeout'}` is emitted.
`pauseCandidateCapture`/`resumeCandidateCapture` belong to the fork-handoff gate and are NOT
ported (codexForkHandoff is fenced off — record a one-line code comment saying so).

Verified nuances (2026-07-30 load-bearing validation, ledger A28 — mirror all three): legacy
pushes the 33rd frame and THEN fails the gate (overflow = capture failure, not a silent
drop); a cumulative held-bytes cap (`heldBytes <= maxRawForwardBytes`) also fails the gate;
and `repair_trigger{kind:'candidate_capture_timeout'}` fires on ANY initial-capture failure
(overflow/refusal included), not only the 45 s timer.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-codex/tests/candidate_gate.rs`. First check the top of the existing
`crates/freshell-codex/tests/remote_proxy_relay.rs` for its `#![cfg(...)]` / feature gating
and imports, and copy that gating verbatim onto this new file (the proxy's socket transport
is exercised the same way there). The fake upstream is pure Rust (tokio-tungstenite is
already a dependency of this crate — the proxy dials upstream with it):

```rust
//! S5.c: candidate-persistence gate integration tests (DEV-0006).
//! Legacy parity target: remote-proxy.ts initial_capture gate (:422-425, :93-94).

use freshell_codex::remote_proxy::{
    CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent, RemoteProxyRepairTrigger,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// A minimal fake app-server: accepts one WS connection, records every text
/// frame it receives, and answers any frame carrying an `id` with a canned
/// success result so request/response flows complete.
async fn spawn_fake_upstream() -> (String, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (seen_tx, seen_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            let seen_tx = seen_tx.clone();
            tokio::spawn(async move {
                let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (mut write, mut read) = ws.split();
                while let Some(Ok(msg)) = read.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        let _ = seen_tx.send(text.to_string());
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(id) = v.get("id") {
                                let reply = serde_json::json!({
                                    "jsonrpc": "2.0", "id": id, "result": {}
                                });
                                let _ = write
                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                        reply.to_string().into(),
                                    ))
                                    .await;
                            }
                        }
                    }
                }
            });
        }
    });
    (url, seen_rx)
}

type ClientWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_client(proxy_ws_url: &str) -> ClientWs {
    let (ws, _) = tokio_tungstenite::connect_async(proxy_ws_url).await.unwrap();
    ws
}

fn text(v: serde_json::Value) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(v.to_string().into())
}

async fn recv_text_with_timeout<S>(read: &mut S, ms: u64) -> Option<String>
where
    S: StreamExt<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    tokio::time::timeout(std::time::Duration::from_millis(ms), read.next())
        .await
        .ok()
        .flatten()
        .and_then(|m| m.ok())
        .and_then(|m| match m {
            tokio_tungstenite::tungstenite::Message::Text(t) => Some(t.to_string()),
            _ => None,
        })
}

fn gate_options(upstream: &str, require: bool) -> CodexRemoteProxyOptions {
    let mut options = CodexRemoteProxyOptions::new(upstream, require);
    options.candidate_capture_timeout_ms = 60_000; // never fires in the happy tests
    options.identity_gate_hold_timeout_ms = 60_000;
    options
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_start_is_held_until_mark_candidate_persisted() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;

    // Non-gated method flows through immediately.
    ws
        .send(text(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"thread/start","params":{}})))
        .await
        .ok();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("thread/start must reach upstream")
        .unwrap();
    assert!(first.contains("thread/start"));

    // Gated method is HELD: it must NOT reach upstream…
    ws
        .send(text(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"turn/start","params":{}})))
        .await
        .ok();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(500), seen.recv())
            .await
            .is_err(),
        "turn/start must be held by the identity gate"
    );

    // …until the candidate is persisted.
    proxy.mark_candidate_persisted();
    let released = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("held turn/start must be released to upstream")
        .unwrap();
    assert!(released.contains("turn/start"));
    // And the upstream's response comes back to the client.
    let mut got_response = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("\"id\":2") {
                got_response = true;
                break;
            }
        }
    }
    assert!(got_response, "client must receive the response to the released turn/start");
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_proxy_does_not_gate() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(gate_options(&upstream, false))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    ws
        .send(text(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"turn/start","params":{}})))
        .await
        .ok();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("require_candidate_persistence=false must not hold turn/start")
        .unwrap();
    assert!(frame.contains("turn/start"));
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_timeout_rejects_held_frames_and_emits_repair_trigger() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let mut options = CodexRemoteProxyOptions::new(&upstream, true);
    options.candidate_capture_timeout_ms = 200; // fire fast
    options.identity_gate_hold_timeout_ms = 60_000;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;

    ws
        .send(text(serde_json::json!({"jsonrpc":"2.0","id":7,"method":"turn/start","params":{}})))
        .await
        .ok();

    // Held frame is answered with a JSON-RPC error (-32000), never forwarded.
    let mut got_error = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("-32000") && frame.contains("\"id\":7") {
                got_error = true;
                break;
            }
        }
    }
    assert!(got_error, "held turn/start must be answered with a -32000 error on capture timeout");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), seen.recv())
            .await
            .is_err(),
        "held frame must never be forwarded upstream after a capture timeout"
    );

    // The repair trigger surfaces on the event stream.
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(saw_trigger, "capture timeout must emit RepairTrigger::CandidateCaptureTimeout");
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn fail_candidate_capture_rejects_held_frames() {
    let (upstream, _seen) = spawn_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    ws
        .send(text(serde_json::json!({"jsonrpc":"2.0","id":9,"method":"thread/fork","params":{}})))
        .await
        .ok();
    proxy.fail_candidate_capture("identity guards refused the candidate");
    let mut got_error = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("-32000") && frame.contains("\"id\":9") {
                got_error = true;
                break;
            }
        }
    }
    assert!(got_error, "fail_candidate_capture must answer held frames with -32000");
    // Ledger A28: ANY initial-capture failure (identity-guard refusal included)
    // fires repair_trigger{kind:'candidate_capture_timeout'}, not proxy_error.
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(saw_trigger, "fail_candidate_capture must emit CandidateCaptureTimeout");
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hold_queue_overflow_fails_the_capture() {
    // Legacy parity (ledger A28): the 33rd gated frame is PUSHED and then the
    // gate FAILS (overflow = capture failure) — every held frame gets -32000,
    // nothing reaches upstream, and candidate_capture_timeout fires.
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    for i in 0..33 {
        ws
            .send(text(serde_json::json!({"jsonrpc":"2.0","id":i,"method":"turn/start","params":{}})))
            .await
            .ok();
    }
    let mut errors = 0;
    while let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
        if frame.contains("-32000") {
            errors += 1;
            if errors == 33 {
                break;
            }
        }
    }
    assert_eq!(errors, 33, "all 33 held frames (incl. the overflowing one) get -32000");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), seen.recv())
            .await
            .is_err(),
        "no gated frame may reach upstream after an overflow failure"
    );
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(saw_trigger, "overflow is a capture failure: it must emit CandidateCaptureTimeout");
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn held_bytes_cap_fails_the_capture() {
    // Legacy parity (ledger A28): the CUMULATIVE held bytes are capped by
    // max_raw_forward_bytes — two frames each under the per-frame raw-forward
    // check but together over the cap fail the gate as a capture failure.
    let (upstream, _seen) = spawn_fake_upstream().await;
    let mut options = gate_options(&upstream, true);
    options.max_raw_forward_bytes = 2_048;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    let blob = "x".repeat(1_200); // each frame ~1.3 KB < 2 KB; two frames > 2 KB
    for i in 0..2 {
        ws
            .send(text(serde_json::json!({"jsonrpc":"2.0","id":i,"method":"turn/start","params":{"blob":&blob}})))
            .await
            .ok();
    }
    let mut errors = 0;
    while let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
        if frame.contains("-32000") {
            errors += 1;
            if errors == 2 {
                break;
            }
        }
    }
    assert_eq!(errors, 2, "both held frames get -32000 when the byte cap trips");
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(saw_trigger, "the held-bytes cap must emit CandidateCaptureTimeout");
    proxy.close().await;
}
```

If `futures_util` is not already a (dev-)dependency of `freshell-codex`, add
`futures-util = "0.3"` to `[dev-dependencies]` in `crates/freshell-codex/Cargo.toml`
(check `remote_proxy_relay.rs`'s imports first — reuse whatever split/sink helper it uses).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-codex --features real-transport --test candidate_gate`
(verified 2026-07-30, ledger A26: tokio-tungstenite/futures-util are OPTIONAL dependencies of
`freshell-codex` behind the default-off `real-transport` feature — there is no
`[dev-dependencies]` section — so without the flag this file compiles to zero tests. Copy
`remote_proxy_relay.rs`'s `#![cfg(...)]` gating verbatim, per Step 1).
Expected: compile errors — `mark_candidate_persisted`, `fail_candidate_capture`,
`candidate_capture_timeout_ms`, and `CandidateCaptureTimeout` do not exist.

- [ ] **Step 3: Implement the gate**

In `crates/freshell-codex/src/remote_proxy.rs`:

3a. Constants (near the existing byte-limit consts):

```rust
/// `DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS` (`remote-proxy.ts:94`).
pub const CANDIDATE_CAPTURE_TIMEOUT_MS: u64 = 45_000;
/// `DEFAULT_REQUEST_HOLD_TIMEOUT_MS` (`remote-proxy.ts:93`) — armed on the FIRST held frame.
pub const IDENTITY_GATE_HOLD_TIMEOUT_MS: u64 = 5_000;
/// Legacy cap on held gate frames (`remote-proxy.ts` initial_capture hold queue).
pub const MAX_HELD_IDENTITY_GATE_FRAMES: usize = 32;
```

3b. Options: add two pub fields to `CodexRemoteProxyOptions` and default them in `new`:

```rust
    pub candidate_capture_timeout_ms: u64,
    pub identity_gate_hold_timeout_ms: u64,
```

```rust
    pub fn new(upstream_ws_url: impl Into<String>, require_candidate_persistence: bool) -> Self {
        Self {
            upstream_ws_url: upstream_ws_url.into(),
            max_raw_forward_bytes: MAX_RAW_FORWARD_BYTES,
            require_candidate_persistence,
            candidate_capture_timeout_ms: CANDIDATE_CAPTURE_TIMEOUT_MS,
            identity_gate_hold_timeout_ms: IDENTITY_GATE_HOLD_TIMEOUT_MS,
        }
    }
```

3c. New `RemoteProxyRepairTrigger` variant (the doc at `:160-162` notes it was deferred):

```rust
    /// `repair_trigger{kind:'candidate_capture_timeout'}` — the S5.c identity gate
    /// timed out waiting for the durability consumer to persist the candidate.
    CandidateCaptureTimeout,
```

Fix every `match` on this enum that `cargo check -p freshell-codex` now reports.

3d. New `HubMsg` variants:

```rust
    MarkCandidatePersisted,
    FailCandidateCapture { message: String },
    CandidateCaptureTimedOut,
    IdentityGateHoldTimedOut,
```

3e. Gate state on `Hub`:

```rust
struct HeldGateFrame {
    conn_id: u64,
    data: Vec<u8>,
    binary: bool,
}

/// The ported `initial_capture` identity gate (`remote-proxy.ts:67-96,422-425`).
/// The fork_handoff gate variant is NOT ported (codexForkHandoff is fenced off,
/// spec S5 out-of-scope list) — this gate has exactly one reason.
enum IdentityGate {
    /// require_candidate_persistence=false, or the candidate was persisted.
    Open,
    /// Fresh managed launch awaiting candidate persistence. `held_bytes` is
    /// the cumulative size of the held frames (legacy `heldBytes`, ledger A28).
    Holding { held: Vec<HeldGateFrame>, held_bytes: usize, hold_timer_armed: bool },
    /// Capture failed or timed out: gated methods are rejected outright.
    Failed,
}
```

Add to `Hub`: `identity_gate: IdentityGate`, plus `hub_tx: mpsc::UnboundedSender<HubMsg>` and
`hold_timeout_ms: u64` (for arming the hold timer). Thread them through `run_hub`'s signature
from `start()`:

```rust
        let hub_task = tokio::spawn(run_hub(
            hub_rx,
            events_tx,
            options.max_raw_forward_bytes,
            options.require_candidate_persistence,
            options.identity_gate_hold_timeout_ms,
            hub_tx.clone(),
        ));
```

`run_hub` initializes `identity_gate` to
`Holding { held: Vec::new(), held_bytes: 0, hold_timer_armed: false }`
when `require_candidate_persistence`, else `Open`. In `start()`, after spawning the hub, arm
the capture timer:

```rust
        if options.require_candidate_persistence {
            let timer_tx = hub_tx.clone();
            let timeout_ms = options.candidate_capture_timeout_ms;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                let _ = timer_tx.send(HubMsg::CandidateCaptureTimedOut);
            });
        }
```

3f. The hold, inserted in `handle_client_frame` at the exact seam (between
`let id = envelope.id.clone();` and the `thread/fork` dispatch — `remote_proxy.rs:766`):

```rust
        // S5.c identity gate (`remote-proxy.ts:422-425`): on a fresh managed
        // launch, hold turn/start + thread/fork until the durability consumer
        // persists the candidate. Everything else flows so the pane boots.
        if matches!(method.as_deref(), Some("turn/start") | Some("thread/fork")) {
            let mut frame_held = false;
            let mut capture_failure: Option<&'static str> = None;
            match &mut self.identity_gate {
                IdentityGate::Holding { held, held_bytes, hold_timer_armed } => {
                    if !*hold_timer_armed {
                        *hold_timer_armed = true;
                        let timer_tx = self.hub_tx.clone();
                        let timeout_ms = self.hold_timeout_ms;
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                            let _ = timer_tx.send(HubMsg::IdentityGateHoldTimedOut);
                        });
                    }
                    // Legacy parity (ledger A28): push FIRST, then evaluate the
                    // caps — queue overflow and the cumulative held-bytes cap
                    // are capture FAILURES (legacy pushes the 33rd frame and
                    // THEN fails the gate), never silent per-frame refusals.
                    *held_bytes = held_bytes.saturating_add(data.len());
                    held.push(HeldGateFrame { conn_id, data, binary });
                    frame_held = true;
                    if held.len() > MAX_HELD_IDENTITY_GATE_FRAMES {
                        capture_failure =
                            Some("Codex remote proxy identity gate hold queue overflowed.");
                    } else if *held_bytes > self.max_raw_forward_bytes {
                        capture_failure = Some(
                            "Codex remote proxy identity gate held bytes exceeded the raw-forward cap.",
                        );
                    }
                }
                IdentityGate::Failed => {
                    self.send_json_rpc_error_to_client(
                        conn_id,
                        id.as_ref(),
                        "Codex candidate capture failed; identity-gated request rejected.",
                    );
                    return;
                }
                IdentityGate::Open => {}
            }
            if frame_held {
                if let Some(message) = capture_failure {
                    // A28: ANY initial-capture failure (overflow/refusal
                    // included) fires candidate_capture_timeout.
                    self.fail_identity_gate(
                        message,
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
                return;
            }
        }
```

(The `frame_held`/`capture_failure` locals keep the `fail_identity_gate(&mut self, ...)` call
OUTSIDE the `match &mut self.identity_gate` borrow.)

3g. Hub methods + `run_hub` arms:

```rust
    fn release_identity_gate(&mut self) {
        let gate = std::mem::replace(&mut self.identity_gate, IdentityGate::Open);
        if let IdentityGate::Holding { held, .. } = gate {
            // Replay in order through the normal path (thread/fork frames get
            // their exclude-turns rewrite; turn/start forwards).
            for frame in held {
                self.handle_client_frame(frame.conn_id, frame.data, frame.binary);
            }
        }
    }

    /// `failIdentityGate(..., closeAllConnections: true)` (`remote-proxy.ts:948-980`):
    /// answer every held frame with a -32000 error, mark the gate failed, and
    /// close every socket pair.
    fn fail_identity_gate(&mut self, message: &str, trigger: Option<RemoteProxyRepairTrigger>) {
        let gate = std::mem::replace(&mut self.identity_gate, IdentityGate::Failed);
        if let IdentityGate::Holding { held, .. } = gate {
            for frame in held {
                let id = scan_json_rpc_envelope(&frame.data).ok().and_then(|e| e.id);
                self.send_json_rpc_error_to_client(frame.conn_id, id.as_ref(), message);
            }
        }
        if let Some(trigger) = trigger {
            self.emit(RemoteProxyEvent::RepairTrigger(trigger));
        }
        let conn_ids: Vec<u64> = self.connections.keys().copied().collect();
        for conn_id in conn_ids {
            self.close_connection(conn_id);
        }
    }
```

`run_hub` arms:

```rust
            HubMsg::MarkCandidatePersisted => {
                hub.release_identity_gate();
            }
            HubMsg::FailCandidateCapture { message } => {
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    let msg = format!("Codex candidate capture failed: {message}");
                    // A28: any initial-capture failure (identity-guard refusal
                    // included) fires candidate_capture_timeout, not proxy_error.
                    hub.fail_identity_gate(
                        &msg,
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
            }
            HubMsg::CandidateCaptureTimedOut => {
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    hub.fail_identity_gate(
                        "Codex candidate capture timed out before the candidate was persisted.",
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
            }
            HubMsg::IdentityGateHoldTimedOut => {
                if let IdentityGate::Holding { held, .. } = &hub.identity_gate {
                    if !held.is_empty() {
                        hub.fail_identity_gate(
                            "Codex identity gate held a request past the hold timeout.",
                            Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                        );
                    }
                }
            }
```

In the `HubMsg::Shutdown` arm, BEFORE draining connections, reject any still-held frames
(this is the "close() must drain the gate" note at `remote_proxy.rs:270-271`):

```rust
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    hub.fail_identity_gate(
                        "Codex remote proxy closed while identity-gated requests were held.",
                        None,
                    );
                }
```

3h. Handle methods on `CodexRemoteProxy`:

```rust
    /// S5.c release: the durability consumer persisted the candidate
    /// (`markCandidatePersisted`, `remote-proxy.ts:206-256`). Fire-and-forget.
    pub fn mark_candidate_persisted(&self) {
        let _ = self.hub_tx.send(HubMsg::MarkCandidatePersisted);
    }

    /// S5.c failure: the candidate was refused (identity guards) — reject held
    /// frames and close (`failCandidateCapture`).
    pub fn fail_candidate_capture(&self, message: &str) {
        let _ = self.hub_tx.send(HubMsg::FailCandidateCapture { message: message.to_string() });
    }
```

Also update the now-stale module doc at `remote_proxy.rs:16-26` ("deliberately OUT OF SCOPE
for this slice") to say the initial_capture gate IS now ported (S5.c), fork_handoff gate
remains unported (fence).

3i. Update the EXISTING relay suite, `crates/freshell-codex/tests/remote_proxy_relay.rs`:
every test there constructs the proxy with
`CodexRemoteProxyOptions::new(&upstream.ws_url, true)`, so after 3e the gate initializes to
Holding in ALL of them. Only the two `thread/fork` rewrite tests actually send a gated
method (re-anchor by searching the file for `thread/fork`; approx `:351/:364` and
`:390/:398` as of this writing) — without a release, their fork frames are held, the
upstream-receive waits time out, and the 5s hold timer fails the gate. In each of those two
tests, call `proxy.mark_candidate_persisted()` right after the proxy/client connection is
established and BEFORE the fork frame is sent, with a one-line comment:
`// S5.c: release the identity gate up front — this test exercises fork rewrite, not the gate.`
(Ordering is safe either way: a frame that lands before the release is held, then flushed
upstream on release — the rewrite assertion still observes it.) This doubles as coverage
that a released gate forwards gated methods. The remaining relay tests send only non-gated
traffic (the gate holds `turn/start` / `thread/fork` requests exclusively) and need no
change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-codex --features real-transport --test candidate_gate` (same
feature flag as Step 2), then the relay suite:
`cargo test -p freshell-codex --features real-transport --test remote_proxy_relay`, then the
whole default-feature crate: `cargo test -p freshell-codex`.
Expected: all PASS. The relay suite passes ONLY because of Step 3i's gate releases — its
proxies are all built with `require_candidate_persistence == true`; the gate is inert only
when that flag is `false`. If the two fork-rewrite tests hang/fail here, Step 3i was missed.

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
git add crates/freshell-codex
git commit -m "feat(codex): port the candidate-persistence identity gate into the remote proxy (DEV-0006 S5.c)"
```

---

### Task 2: Persistence plumbing through sidecar and manager

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs`
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs` (extend)

**Interfaces:**
- Consumes: Task 1's `CodexRemoteProxy::{mark_candidate_persisted, fail_candidate_capture}`;
  existing `SidecarInner.proxy`, `CodexTerminalLaunchManager.adopted`.
- Produces:
  - `impl CodexLaunchSidecar { pub async fn mark_candidate_persisted(&self); pub async fn fail_candidate_capture(&self, message: &str); }`
  - `impl CodexTerminalLaunchManager { pub async fn mark_candidate_persisted(&self, terminal_id: &str); pub async fn fail_candidate_capture(&self, terminal_id: &str, message: &str); }`
  - Both manager methods are no-ops for unknown terminal ids (idempotent, never panic) —
    Task 6's router relies on that.

- [ ] **Step 1: Write the failing test**

Append to `crates/freshell-codex/tests/launch_lifecycle.rs` (reuse that file's existing fake
runtime/test-planner helpers — it already builds managers with `CodexTerminalLaunchManager::new`
and asserts `require_candidate_persistence` at `:157` and `:180`):

```rust
#[tokio::test]
async fn mark_candidate_persisted_is_a_noop_for_unknown_terminals() {
    let manager = test_manager(); // the file's existing constructor helper
    // Must not panic, hang, or error for a terminal that was never adopted.
    manager.mark_candidate_persisted("no-such-terminal").await;
    manager
        .fail_candidate_capture("no-such-terminal", "test refusal")
        .await;
}
```

If the file's manager constructor helper has a different name, use that name — the assertion
body is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle mark_candidate_persisted_is_a_noop_for_unknown_terminals`
(the `--features real-transport` flag is REQUIRED: both the `launch_lifecycle` module
(`lib.rs:50-51`) and `tests/launch_lifecycle.rs` (`:13`) are cfg-gated behind that default-off
feature — ledger A26; without it the test binary compiles empty and exits 0, proving nothing.)
Expected: FAIL to compile — methods do not exist.

- [ ] **Step 3: Implement**

In `crates/freshell-codex/src/launch_lifecycle.rs`, on `impl CodexLaunchSidecar` (mirror the
`require_candidate_persistence()` accessor at `:145-152`):

```rust
    /// S5.c: forward the persistence release to the live proxy's identity gate.
    /// No-op once the proxy is torn down.
    pub async fn mark_candidate_persisted(&self) {
        if let Some(proxy) = self.inner.lock().await.proxy.as_ref() {
            proxy.mark_candidate_persisted();
        }
    }

    /// S5.c: forward a capture failure (candidate refused by identity guards).
    pub async fn fail_candidate_capture(&self, message: &str) {
        if let Some(proxy) = self.inner.lock().await.proxy.as_ref() {
            proxy.fail_candidate_capture(message);
        }
    }
```

On `impl CodexTerminalLaunchManager`:

```rust
    /// S5.c: release the candidate-persistence gate for an adopted terminal's
    /// proxy. Called by the freshell-ws proxy-event router after
    /// `adopt_codex_identity` returned true (the ledger write is awaited inside
    /// that tail — fsync-before-announce IS the "persisted" signal). Idempotent;
    /// unknown terminals are a silent no-op (legacy has five release sites, most
    /// of them dedupe paths — this single seam is called on every candidate
    /// re-observation too).
    pub async fn mark_candidate_persisted(&self, terminal_id: &str) {
        let sidecar = {
            self.adopted
                .lock()
                .unwrap()
                .get(terminal_id)
                .map(|entry| entry.sidecar.clone())
        };
        if let Some(sidecar) = sidecar {
            sidecar.mark_candidate_persisted().await;
        }
    }

    /// S5.c: fail the gate for an adopted terminal (candidate refused).
    pub async fn fail_candidate_capture(&self, terminal_id: &str, message: &str) {
        let sidecar = {
            self.adopted
                .lock()
                .unwrap()
                .get(terminal_id)
                .map(|entry| entry.sidecar.clone())
        };
        if let Some(sidecar) = sidecar {
            sidecar.fail_candidate_capture(message).await;
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle`
(same feature flag as Step 2 — without it the binary is empty and the pass is vacuous.)
Expected: PASS.

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
git add crates/freshell-codex
git commit -m "feat(codex): plumb candidate-persistence release through sidecar and launch manager (S5.c)"
```

---

### Task 3: Drain task + set-once event sink at adopt (S5.a transport; records D-SINK + D-REASON)

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs`
- Modify: `crates/freshell-codex/src/launch_plan.rs` (binding_reason doc only)
- Test: in-module `#[cfg(test)]` tests in `launch_lifecycle.rs`

**Interfaces:**
- Consumes: `CodexTerminalLaunch { plan, sidecar, events, .. }`, `RemoteProxyEvent`,
  `CodexLaunchPlan.runtime_cwd: Option<String>` (`launch_plan.rs:197`).
- Produces (Task 6 and boot wiring rely on these exact names):
  - `pub struct TerminalProxyEvent { pub terminal_id: String, pub cwd: Option<String>, pub event: RemoteProxyEvent }`
  - `pub fn set_codex_proxy_event_sink(tx: mpsc::UnboundedSender<TerminalProxyEvent>)`
  - Behavior: after `adopt`, every event the proxy emits arrives on the sink tagged with the
    adopting terminal id and the plan's `runtime_cwd`. With no sink installed, events are
    drained and dropped (pre-S5 behavior). The drain task ends when the proxy's senders drop
    (sidecar shutdown) and is aborted by the teardown worker as a belt.

- [ ] **Step 1: Write the failing tests**

In `crates/freshell-codex/src/launch_lifecycle.rs`, inside its `#[cfg(test)] mod tests` (or a
new one if none exists in-module):

```rust
    #[tokio::test]
    async fn drain_forwards_tagged_events_to_the_sink() {
        let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
        let (sink_tx, mut sink_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = spawn_proxy_event_drain(
            "term-1".to_string(),
            Some("/tmp/work".to_string()),
            proxy_rx,
            Some(sink_tx),
        );
        proxy_tx
            .send(crate::remote_proxy::RemoteProxyEvent::RepairTrigger(
                crate::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
            ))
            .unwrap();
        let tagged = tokio::time::timeout(std::time::Duration::from_secs(2), sink_rx.recv())
            .await
            .expect("drain must forward within 2s")
            .expect("sink open");
        assert_eq!(tagged.terminal_id, "term-1");
        assert_eq!(tagged.cwd.as_deref(), Some("/tmp/work"));
        assert!(matches!(
            tagged.event,
            crate::remote_proxy::RemoteProxyEvent::RepairTrigger(_)
        ));
        drop(proxy_tx); // senders gone -> drain exits
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("drain task must end when the proxy senders drop")
            .unwrap();
    }

    #[tokio::test]
    async fn drain_without_a_sink_discards_and_survives() {
        let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = spawn_proxy_event_drain("term-2".to_string(), None, proxy_rx, None);
        proxy_tx
            .send(crate::remote_proxy::RemoteProxyEvent::RepairTrigger(
                crate::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
            ))
            .unwrap();
        drop(proxy_tx);
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("no-sink drain must still terminate")
            .unwrap();
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-codex --features real-transport drain_forwards_tagged_events`
(the `--features real-transport` flag is REQUIRED: the `launch_lifecycle` module — and these
in-module tests with it — is cfg-gated behind that default-off feature at `lib.rs:50-51`,
ledger A26; without the flag nothing here compiles and the command passes vacuously.)
Expected: FAIL to compile — `spawn_proxy_event_drain` / `TerminalProxyEvent` do not exist.

- [ ] **Step 3: Implement**

In `launch_lifecycle.rs`:

```rust
/// S5.a: one proxy event, tagged with its adopting terminal.
#[derive(Debug)]
pub struct TerminalProxyEvent {
    pub terminal_id: String,
    /// The plan's create cwd (`CodexLaunchPlan.runtime_cwd`) — the identity
    /// adoption tail's cwd hint.
    pub cwd: Option<String>,
    pub event: RemoteProxyEvent,
}

/// S5.d.2 DECISION (recorded): the manager stays a process-global singleton.
/// Instead of DI'ing the 12 `::global()` call sites, freshell-ws installs this
/// set-once sink at boot (the spawn-gate set-once-handle precedent) and runs
/// the WsState-aware router on its far side. The drain task itself never
/// needs WsState, so no singleton→DI conversion is required.
static PROXY_EVENT_SINK: Mutex<Option<mpsc::UnboundedSender<TerminalProxyEvent>>> =
    Mutex::new(None);

/// Install the process-wide proxy-event sink. Called exactly once at server
/// boot (before any codex terminal can be adopted); later calls replace the
/// sink (test affordance).
pub fn set_codex_proxy_event_sink(tx: mpsc::UnboundedSender<TerminalProxyEvent>) {
    *PROXY_EVENT_SINK.lock().unwrap() = Some(tx);
}

fn codex_proxy_event_sink() -> Option<mpsc::UnboundedSender<TerminalProxyEvent>> {
    PROXY_EVENT_SINK.lock().unwrap().clone()
}

/// S5.a: the ONE per-terminal drain task, spawned at adopt (covers all three
/// adopt sites: WS create, WS auto-resume respawn, REST /api/tabs). Ends when
/// the proxy's event senders drop (sidecar shutdown) or the sink closes.
fn spawn_proxy_event_drain(
    terminal_id: String,
    cwd: Option<String>,
    mut events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    sink: Option<mpsc::UnboundedSender<TerminalProxyEvent>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let Some(sink) = sink.as_ref() else {
                // No consumer installed (tests / bare servers): drop, matching
                // the pre-S5 parked-receiver behavior.
                continue;
            };
            if sink
                .send(TerminalProxyEvent {
                    terminal_id: terminal_id.clone(),
                    cwd: cwd.clone(),
                    event,
                })
                .is_err()
            {
                break;
            }
        }
    })
}
```

Replace `AdoptedTerminalLaunch` (`:372-376`):

```rust
struct AdoptedTerminalLaunch {
    sidecar: Arc<CodexLaunchSidecar>,
    /// S5.a: the per-terminal proxy-event drain. Ends on its own when the
    /// proxy's senders drop; aborted by the teardown worker as a belt.
    drain: tokio::task::JoinHandle<()>,
}
```

Rewrite `adopt` (`:423-438`):

```rust
    pub async fn adopt(
        &self,
        terminal_id: &str,
        launch: CodexTerminalLaunch,
        generation: u64,
    ) -> Result<(), String> {
        launch.sidecar.adopt(terminal_id, generation).await?;
        // S5.d.3 DECISION (recorded): `launch.plan.binding_reason` is
        // deliberately DROPPED here — the identity tail derives adopt-vs-rebind
        // from context, and no Rust wire frame carries sessionBindingReason.
        // See CodexLaunchPlan::binding_reason's doc.
        let drain = spawn_proxy_event_drain(
            terminal_id.to_string(),
            launch.plan.runtime_cwd.clone(),
            launch.events,
            codex_proxy_event_sink(),
        );
        self.adopted.lock().unwrap().insert(
            terminal_id.to_string(),
            AdoptedTerminalLaunch {
                sidecar: launch.sidecar,
                drain,
            },
        );
        Ok(())
    }
```

In the teardown worker body (`ensure_teardown_worker`, `:476-486`) and in `shutdown`
(`:465-474`), after each `entry.sidecar.shutdown().await`, add `entry.drain.abort();`.

In `crates/freshell-codex/src/launch_plan.rs`, extend the `binding_reason` field doc
(`:187-188`) with the decision:

```rust
    /// `getCodexSessionBindingReason('codex', resume)` (`ws-handler.ts:2496-2498`).
    /// S5.d.3 DECISION (2026-07-30, recorded — spec S5.d.3): computed for plan
    /// parity and the wire-string pin test, then deliberately DROPPED at
    /// `CodexTerminalLaunchManager::adopt`. The Rust registry has no
    /// sessionBindingReason consumer; the adoption tail (`codex_identity.rs`)
    /// has its own adopt/rebind vocabulary. Do not wire without a new decision.
    pub binding_reason: CodexSessionBindingReason,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-codex --features real-transport` (compiles and runs the drain
tests plus the pre-existing feature-gated suites), then `cargo test -p freshell-codex` for
the default-feature estate.
Expected: PASS (including the pre-existing launch_lifecycle integration tests — `adopt`'s
observable contract is unchanged).

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
git add crates/freshell-codex
git commit -m "feat(codex): drain the parked proxy event stream at adopt into a set-once sink (S5.a, S5.d.2, S5.d.3)"
```

---

### Task 4: Third (proxy) lane in the activity tracker with cross-lane dedupe (S5.a activity)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs`
- Test: in-module tests in the same file (alongside the pinned counterexamples at `:1091`,
  `:1132` — both MUST stay green)

**Interfaces:**
- Consumes: `TerminalActivity` (`:102-135`), `record_completion_if_idle` (`:716-733`),
  `swallow_next_bel` arm/consume/clear sites (`:346,:354`, `:486`, `:421`),
  `TurnCompletionLedger::record_turn_completion`.
- Produces (Task 5 relies on these exact signatures — same return type as the existing
  `note_input`/`note_output`/`reconcile_rollout` methods; use whatever effect-vector type
  those return, referred to here as `Vec<CodexEffect>`):
  - `pub fn note_proxy_turn_started(&mut self, terminal_id: &str, at: i64) -> Vec<CodexEffect>`
  - `pub fn note_proxy_turn_completed(&mut self, terminal_id: &str, at: i64) -> Vec<CodexEffect>`

Design (the "extend the dedupe" the spec demands, minimal blast radius): the proxy is a third
clock domain. Two new one-shot directed swallow flags generalize CE1:

- `swallow_next_proxy_complete: bool` — armed by **reconcile-initiated** clears (next to the
  existing `swallow_next_bel = true` at `:346` and `:354`) AND by **BEL-initiated** clears
  (it is a new flag, so the two pinned counterexample tests are untouched); consumed one-shot
  at the top of `note_proxy_turn_completed`; DISARMED by `note_proxy_turn_started` (a new
  proxy turn is beginning — a stale swallow must not eat its completion).
- `swallow_next_reconcile_clear: bool` — armed by **proxy-initiated** clears; consumed
  one-shot in `reconcile_rollout`'s `is_new_clear` branch (skip that one transition).
- Proxy-initiated clears also arm the existing `swallow_next_bel` (the PTY echo of the same
  physical turn).
- `note_input`'s fresh-pending branch (`:418-422`) clears ALL three flags.
- BEL-initiated clears keep today's BEL/reconcile behavior exactly (the two pinned
  counterexample tests stay untouched) but DO arm the new `swallow_next_proxy_complete` —
  validated finding (2026-07-30, ledger A11): the proxy stream has NO emission dedupe and its
  `TurnCompleted` carries no timestamps (`remote_proxy.rs:1146-1161`), so a proxy echo landing
  after a BEL clear with a queued follow-up submit would otherwise prematurely complete the
  new turn. Proxy completions arriving while `phase == Idle` are naturally ignored
  (`record_completion_if_idle` requires a transition).
- Proxy event payloads carry `threadId`/`turnId` but no timestamps; server receipt time is
  the key. Recorded option (not built now): if double-counting is ever observed in practice,
  upgrade the one-shot flags to `turn_id`-keyed dedupe.
- New per-terminal field `last_proxy_started_at: Option<i64>` (server-clock receipt time)
  is the proxy lane's turn key for Busy/Unknown clears; Pending clears reuse
  `pending_submit_at` (both are server-clock — same key space, no cross-domain compare).

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` in `crates/freshell-activity/src/codex.rs`, following the
file's existing test style (construct `CodexActivityTracker`, call methods with explicit `at`
timestamps, inspect returned effects — mirror how the neighboring tests at `:1091`/`:1132`
assert on `TrackerEffect::TurnComplete`):

```rust
    #[test]
    fn proxy_turn_started_promotes_idle_to_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        let effects = tracker.note_proxy_turn_started("t", 2_000);
        assert!(effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::Changed { .. })));
        // No completion on a start.
        assert!(!effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_turn_completes_exactly_once_per_turn() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_proxy_turn_started("t", 2_000);
        let first = tracker.note_proxy_turn_completed("t", 3_000);
        assert_eq!(
            first
                .iter()
                .filter(|e| matches!(e, TrackerEffect::TurnComplete { .. }))
                .count(),
            1
        );
        // Same physical turn reported again (proxy echo / duplicate) -> no double.
        let again = tracker.note_proxy_turn_completed("t", 3_001);
        assert!(!again
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_clear_swallows_the_late_pty_bel_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        // A pending PTY turn…
        tracker.note_input("t", "\r", 2_000);
        // …cleared by the PROXY lane (the authoritative turn end)…
        let cleared = tracker.note_proxy_turn_completed("t", 3_000);
        assert!(cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        // Late BEL echo of the SAME physical turn: swallowed, no second completion.
        let echo = tracker.note_output("t", "\u{7}", 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn reconcile_clear_swallows_the_late_proxy_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // Rollout reconcile ends the turn first…
        let events = CodexTaskEvents {
            latest_task_completed_at: Some(2_500),
            ..Default::default()
        };
        let cleared = tracker.reconcile_rollout("t", &events, 3_000);
        assert!(cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        // …then the proxy echo of the same physical turn is swallowed one-shot.
        let echo = tracker.note_proxy_turn_completed("t", 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn fresh_submit_disarms_all_swallow_flags() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        tracker.note_proxy_turn_completed("t", 3_000); // arms bel + reconcile swallows
        tracker.note_input("t", "\r", 4_000); // fresh pending turn: disarm
        // A REAL turn end for the NEW turn must complete, not be swallowed.
        let done = tracker.note_proxy_turn_completed("t", 5_000);
        assert!(done
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_start_disarms_a_stale_proxy_swallow() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // Reconcile ends turn 1 and arms swallow_next_proxy_complete…
        let events = CodexTaskEvents {
            latest_task_completed_at: Some(2_500),
            ..Default::default()
        };
        tracker.reconcile_rollout("t", &events, 3_000);
        // …but turn 2 STARTS on the proxy lane before any proxy echo of turn 1
        // arrived: the stale swallow must be disarmed, not eat turn 2's end.
        tracker.note_proxy_turn_started("t", 4_000);
        let done = tracker.note_proxy_turn_completed("t", 5_000);
        assert!(done
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn bel_clear_swallows_the_late_proxy_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // A follow-up submit is QUEUED behind the pending turn (`:425-427`)…
        tracker.note_input("t", "\r", 2_500);
        // …then the PTY BEL ends turn 1 (BEL-initiated clear): one completion,
        // and the queued submit re-arms phase = Pending for turn 2.
        let cleared = tracker.note_output("t", "\u{7}", 3_000);
        assert!(cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        // The proxy echo of the SAME physical turn lands next. Without the
        // BEL-clear arming it hits phase == Pending and PREMATURELY completes
        // queued turn 2 (ledger A11) — it must be swallowed instead.
        let echo = tracker.note_proxy_turn_completed("t", 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }
```

Adapt the effect-type name (`TrackerEffect` vs a crate alias) to what the neighboring tests
in this file actually use — copy their call shapes exactly (`note_input`/`note_output` take
`data: &str`, verified at `:385`/`:436`; the snippets above already use `&str` literals).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-activity proxy_turn`
Expected: FAIL to compile — the two methods and fields do not exist.

- [ ] **Step 3: Implement**

In `crates/freshell-activity/src/codex.rs`:

3a. New `TerminalActivity` fields (next to `swallow_next_bel`, with matching doc comments;
initialize `false`/`None` wherever `TerminalActivity` is constructed):

```rust
    /// S5.a third lane (proxy): one-shot — another lane already ended this
    /// physical turn; swallow its late proxy echo. Armed by BOTH
    /// reconcile-initiated AND BEL-initiated clears (ledger A11).
    swallow_next_proxy_complete: bool,
    /// S5.a third lane: one-shot — a proxy-initiated clear already ended this
    /// physical turn; swallow the rollout reconcile echo of the same turn.
    swallow_next_reconcile_clear: bool,
    /// S5.a third lane: server-clock receipt time of the newest proxy
    /// TurnStarted — the proxy lane's turn key for Busy/Unknown clears.
    last_proxy_started_at: Option<i64>,
```

3b. FIRST, extract the shared effect-assembly tail: `note_output` and `reconcile_rollout`
both end by converting `(previous record, completions)` into the returned effect vector
(a `Changed` upsert when the record changed + one `TurnComplete` per completion). Extract
that tail into ONE private method on `CodexActivityTracker`:

```rust
    /// Shared effect-assembly tail (extracted, S5.a): convert a transition's
    /// (previous record, completions) into the emitted effect vector.
    fn effects_after_transition(
        &mut self,
        terminal_id: &str,
        previous: /* the record type note_output's `to_record()` returns */,
        completions: Vec<(Option<String>, i64, i64)>,
    ) -> Vec<CodexEffect> {
        // MOVE the existing tail statements of note_output here verbatim and
        // have note_output / reconcile_rollout call this instead (pure
        // extraction — zero behavior change, existing tests are the net).
    }
```

THEN add the two new lane methods:

```rust
    /// S5.a: proxy lane TurnStarted (third clock domain — server-clock `at`).
    /// Promotes Idle/Unknown/Pending to Busy, edge-triggered; never completes.
    pub fn note_proxy_turn_started(&mut self, terminal_id: &str, at: i64) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let previous = state.to_record();
        // Design invariant (see above): a NEW proxy turn is beginning — a
        // stale directed swallow must not eat THIS turn's completion.
        state.swallow_next_proxy_complete = false;
        state.last_proxy_started_at = Some(at);
        state.last_observed_at = at;
        if matches!(
            state.phase,
            CodexPhase::Idle | CodexPhase::Unknown | CodexPhase::Pending
        ) {
            state.phase = CodexPhase::Busy;
            state.updated_at = at;
        }
        self.effects_after_transition(terminal_id, previous, Vec::new())
    }

    /// S5.a: proxy lane TurnCompleted. Real turn ends transition to Idle and
    /// record exactly one completion; echoes of turns another lane already
    /// ended are swallowed one-shot (CE1 generalized).
    pub fn note_proxy_turn_completed(&mut self, terminal_id: &str, at: i64) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.swallow_next_proxy_complete {
            state.swallow_next_proxy_complete = false;
            return Vec::new();
        }
        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();
        match state.phase {
            CodexPhase::Pending => {
                transition_pending_after_turn_clear(state, at, &mut self.ledger, &mut completions);
                state.swallow_next_bel = true;
                state.swallow_next_reconcile_clear = true;
            }
            CodexPhase::Busy | CodexPhase::Unknown => {
                let turn_key = state.last_proxy_started_at.or(state.pending_submit_at);
                state.phase = CodexPhase::Idle;
                state.updated_at = at;
                record_completion_if_idle(state, turn_key.or(Some(at)), at, &mut self.ledger, &mut completions);
                state.swallow_next_bel = true;
                state.swallow_next_reconcile_clear = true;
            }
            CodexPhase::Idle => {}
        }
        self.effects_after_transition_with_completions(terminal_id, previous, completions)
    }
```

The two `effects_after_transition*` calls above stand for **this file's existing
effect-assembly tail** — open `note_output` (`:436+`) and `reconcile_rollout` (`:279+`),
find how they convert `(previous record, completions)` into the returned effect vector
(`Changed` upsert + one `TurnComplete` per completion), and reuse that exact code path
(extract a shared private helper if one doesn't already exist rather than duplicating it).
Likewise `transition_pending_after_turn_clear` is the existing helper at `:662` — call it,
don't reimplement it.

3c. Cross-lane arming/consumption:

- In `reconcile_rollout`'s `is_new_clear` branch (`:330-356`): first consume the new flag —
  at the top of the `if is_new_clear {` block insert:

```rust
            if is_new_clear && state.swallow_next_reconcile_clear {
                // S5.a: a proxy-initiated clear already ended this physical
                // turn; eat its rollout echo one-shot (CE1, third lane).
                state.swallow_next_reconcile_clear = false;
            } else if is_new_clear {
```

  (i.e., wrap the existing transition body in the `else if` arm), and inside BOTH existing
  transition arms, next to each `state.swallow_next_bel = true;` (`:346`, `:354`) add
  `state.swallow_next_proxy_complete = true;`.

- BEL-initiated clears (design bullet above, ledger A11): `note_output`'s single BEL-clear
  site is the `consume_turn_complete_signal(...)` call (`:490-492` — the
  `if !consume_turn_complete_signal(...) { break; }` inside the BEL loop; swallowed BEL
  echoes `continue` at `:486-489` before reaching it, idle BELs return `false` and `break`).
  Immediately AFTER that `if` — i.e., only when the call returned `true` and a real
  BEL-initiated transition ran — add:

```rust
            // S5.a (A11): a BEL clear ended this physical turn — swallow its
            // late proxy echo (it could otherwise prematurely complete a
            // queued follow-up submit that is now Pending).
            state.swallow_next_proxy_complete = true;
```

  Do NOT arm inside `transition_pending_after_turn_clear`/`transition_after_turn_clear`
  themselves: `reconcile_rollout` also calls those (`:337`, `:341`), and its arming is the
  explicit `:346`/`:354` additions above.

- In `note_input`'s fresh-pending branch (`:418-422`), extend the disarm:

```rust
            state.swallow_next_bel = false;
            state.swallow_next_proxy_complete = false;
            state.swallow_next_reconcile_clear = false;
```

3d. Update the module doc's lane inventory (`:19-34`) to name the third (proxy) lane and the
generalized directed swallows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-activity`
Expected: ALL PASS — including the pinned counterexamples
`reconcile_clear_with_queued_submit_swallows_the_late_bel_echo` and
`dup_bel_chunk_after_stale_busy_submit_completes_exactly_once`. If either regresses, the
extension changed two-lane behavior — fix the extension, not the pins.

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-activity --all-targets -- -D warnings
git add crates/freshell-activity
git commit -m "feat(activity): third (proxy) codex turn lane with generalized cross-lane dedupe (S5.a)"
```

---

### Task 5: ActivityHub proxy-turn API

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs`
- Test: in-module tests in `activity.rs` (follow the file's existing hub-test style)

**Interfaces:**
- Consumes: Task 4's `note_proxy_turn_started/completed`; existing `HubEvent` enum
  (`:104-136`), `handle_event` (`:461-495`), `codex_frames` (`:1131-1177`), `now_ms()`.
- Produces (Task 6 relies on this):
  - `impl ActivityHub { pub fn note_codex_proxy_turn(&self, terminal_id: &str, completed: bool) }`
  — channel-deferred like `bind_codex_session`; emits `codex.activity.updated` /
  `terminal.turn.complete` frames on the hub task.

- [ ] **Step 1: Write the failing test**

Write the test by duplicating the nearest existing codex hub test in this file (the one
exercising the `CodexBind` handler is the closest shape — it constructs the hub, seeds a
tracked codex terminal, and collects emitted frames). Concretely:

1. Locate that test; copy its hub construction, terminal seeding, and frame-collection code
   verbatim into a new test named
   `proxy_turn_events_reach_the_codex_tracker_and_emit_turn_complete`.
2. Replace its exercise section with exactly:

```rust
        hub.note_codex_proxy_turn("t", false); // started
        hub.note_codex_proxy_turn("t", true); // completed
        hub.note_codex_proxy_turn("t", true); // duplicate echo — must not double
```

   (using the seeded terminal id in place of `"t"`).
3. Assert on the collected frames: exactly ONE `terminal.turn.complete` frame for that
   terminal, and at least one `codex.activity.updated` upsert showing the busy→idle
   transition — using the same frame-matching helpers the copied test uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws proxy_turn_events_reach`
Expected: FAIL to compile — `note_codex_proxy_turn` does not exist.

- [ ] **Step 3: Implement**

In `activity.rs`:

```rust
    /// S5.a: proxy (managed-launch) turn lane — channel-deferred like
    /// `bind_codex_session` so all frame emission stays on the hub task.
    pub fn note_codex_proxy_turn(&self, terminal_id: &str, completed: bool) {
        let _ = self.tx.send(HubEvent::CodexProxyTurn {
            terminal_id: terminal_id.to_string(),
            completed,
        });
    }
```

New `HubEvent` variant:

```rust
    /// S5.a: a proxy TurnStarted/TurnCompleted for a managed codex terminal.
    CodexProxyTurn { terminal_id: String, completed: bool },
```

`handle_event` arm (mirror the `CodexBind` arm's shape at `:473-484` — call the tracker,
convert effects with the same `codex_frames` path the other codex arms use):

```rust
            HubEvent::CodexProxyTurn { terminal_id, completed } => {
                let at = now_ms();
                let effects = if completed {
                    inner.codex.note_proxy_turn_completed(&terminal_id, at)
                } else {
                    inner.codex.note_proxy_turn_started(&terminal_id, at)
                };
                // emit via the same effects->frames tail the CodexBind /
                // registry codex arms use in this function.
            }
        ```

(Replace the trailing comment with the file's actual effects-emission call — the same one the
`CodexBind` handler ends with.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --lib` (in-crate unit tests)
Expected: PASS.

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws
git commit -m "feat(ws): activity-hub lane for codex proxy turn events (S5.a)"
```

---

### Task 6: The proxy-event router in freshell-ws + boot wiring (S5.a routing, D-03/D-FORK, persist release)

**Files:**
- Create: `crates/freshell-ws/src/codex_proxy_route.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod codex_proxy_route;`)
- Modify: `crates/freshell-server/src/main.rs` (boot wiring)
- Test: in-module tests in `codex_proxy_route.rs` (WsState test-construction pattern from
  `codex_association.rs:254`'s test)

**Interfaces:**
- Consumes: Task 3's `TerminalProxyEvent`/`set_codex_proxy_event_sink`; Task 2's manager
  `mark_candidate_persisted`/`fail_candidate_capture`; Task 5's `note_codex_proxy_turn`;
  existing `adopt_codex_identity` (`codex_identity.rs:60`), `CodexAdoption` (`:39-44`),
  `state.identity.get` (`identity.rs:111`), `state.codex_locator` + `watch_fork`
  (`codex_locator.rs:470-486`), `CandidateSource` (`remote_proxy_side_effects.rs:72`).
- Produces:
  - `pub fn spawn_codex_proxy_router(state: WsState, rx: mpsc::UnboundedReceiver<TerminalProxyEvent>) -> tokio::task::JoinHandle<()>`

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-ws/src/codex_proxy_route.rs` with the module skeleton and tests
FIRST (tests drive the routing contract), and IN THIS SAME STEP add
`pub mod codex_proxy_route;` to `crates/freshell-ws/src/lib.rs` (next to
`codex_association`'s declaration). The declaration must land with the tests: an
undeclared `src/*.rs` file is not part of the crate graph, so without it Step 2's
`cargo test -p freshell-ws codex_proxy_route` would compile the unchanged crate, run 0
tests, and exit 0 — a vacuous pass instead of the required RED (same trap class as
ledger A26). With the module declared, the tests reference the not-yet-written router
functions and the compile fails for the right reason. For WsState construction, copy the test-state
builder used by the in-module test in `codex_association.rs` (its test at `:254` constructs a
`WsState` directly — reuse the same construction, including a subscribable `broadcast_tx`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::launch_lifecycle::TerminalProxyEvent;
    use freshell_codex::remote_proxy::RemoteProxyEvent;
    use freshell_codex::remote_proxy_side_effects::{
        CandidateSource, CandidateThread, RemoteProxyCandidate,
    };

    fn candidate(source: CandidateSource, id: &str, ephemeral: bool) -> RemoteProxyEvent {
        RemoteProxyEvent::Candidate(RemoteProxyCandidate {
            source,
            thread: CandidateThread {
                id: id.to_string(),
                path: None,
                ephemeral,
            },
        })
    }

    fn tagged(terminal_id: &str, event: RemoteProxyEvent) -> TerminalProxyEvent {
        TerminalProxyEvent {
            terminal_id: terminal_id.to_string(),
            cwd: Some("/tmp/x".to_string()),
            event,
        }
    }

    #[tokio::test]
    async fn candidate_adopts_identity_through_the_single_writer_tail() {
        let state = test_state(); // copied from codex_association.rs's test
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged("term-a", candidate(CandidateSource::ThreadStartResponse, "sess-1", false)),
        )
        .await;
        assert_eq!(
            state.identity.get("term-a").and_then(|i| i.session_id),
            Some("sess-1".to_string())
        );
        // Pinned order: associated FIRST, then meta.updated.
        let first = frames.recv().await.unwrap();
        assert!(first.contains("terminal.session.associated"), "{first}");
        let second = frames.recv().await.unwrap();
        assert!(second.contains("terminal.meta.updated"), "{second}");
    }

    #[tokio::test]
    async fn fork_source_candidates_are_deliberately_ignored() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged("term-b", candidate(CandidateSource::ThreadForkResponse, "sess-2", false)),
        )
        .await;
        assert!(state.identity.get("term-b").and_then(|i| i.session_id).is_none());
    }

    #[tokio::test]
    async fn ephemeral_candidates_are_skipped() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged("term-c", candidate(CandidateSource::ThreadStartResponse, "sess-3", true)),
        )
        .await;
        assert!(state.identity.get("term-c").and_then(|i| i.session_id).is_none());
    }

    #[tokio::test]
    async fn first_bind_wins_on_the_same_terminal_d03() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged("term-d", candidate(CandidateSource::ThreadStartResponse, "sess-first", false)),
        )
        .await;
        route_proxy_event(
            &state,
            tagged("term-d", candidate(CandidateSource::ThreadStartResponse, "sess-second", false)),
        )
        .await;
        assert_eq!(
            state.identity.get("term-d").and_then(|i| i.session_id),
            Some("sess-first".to_string()),
            "D-03: a later different-id proxy candidate must not re-adopt"
        );
    }

    #[tokio::test]
    async fn lifecycle_and_repair_events_only_log() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged(
                "term-e",
                RemoteProxyEvent::RepairTrigger(
                    freshell_codex::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
                ),
            ),
        )
        .await;
        // Minimal handling: no identity write, no panic.
        assert!(state.identity.get("term-e").is_none());
    }
}
```

If `test_state()` in `codex_association.rs` isn't reusable directly (private), copy its body
into this module's tests verbatim. If the ledger inside `apply_codex_identity` needs a temp
dir in tests, mirror how the `codex_association.rs` test satisfies it.

Also add a filter test mirroring `ephemeral_candidates_are_skipped`: a candidate with an
empty thread id, and one with a relative rollout path, must not adopt (extend the local
`candidate(..)` test helper to take the path; the happy-path candidates above must use an
absolute path so they still bind).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws codex_proxy_route`
Expected: FAIL to compile — module/functions missing.

- [ ] **Step 3: Implement the router**

```rust
//! S5.a (DEV-0006): the proxy-event router — the ONLY consumer of the managed
//! launch's `RemoteProxyEvent` stream. Routes into the EXISTING tails; builds
//! no new identity writer (single-writer discipline, campaign §2.3.2).
//!
//! D-03 RULE (recorded; spec §8.3): for managed panes the proxy candidate is
//! authoritative and the association locator never arms (see
//! `codex_association::should_arm_codex_locator`); on the SAME terminal, first
//! bind wins — a later proxy candidate with a different id is ignored here
//! (identity moves only through the fork rebind lane).
//!
//! The first-bind check below is router-task check-then-act (accepted
//! residual, load-bearing ledger A22): safe because this task is the ONLY
//! proxy-candidate writer (single mpsc consumer), create-time session-ref
//! binds complete before any candidate can arrive, and the locator is
//! suppressed for managed panes (Task 7).
//!
//! D-FORK RULE (recorded; spec S5.a "route … or ignore"): proxy fork
//! candidates (`CandidateSource::ThreadForkResponse`) are deliberately
//! IGNORED — the landed disk fork-watch lane (`watch_fork` → `tick_forks` →
//! `rebind_codex_identity`, D7/A13/A8 guards) owns fork rebinds. The router
//! registers `watch_fork` after each adoption so managed fresh panes get the
//! same coverage resume panes get at create (`terminal.rs:2442-2446`).

use std::path::Path;

use freshell_codex::launch_lifecycle::{CodexTerminalLaunchManager, TerminalProxyEvent};
use freshell_codex::remote_proxy::RemoteProxyEvent;
use freshell_codex::remote_proxy_side_effects::CandidateSource;
use tokio::sync::mpsc;

use crate::codex_identity::CodexAdoption;
use crate::WsState;

/// Boot entry: consume the set-once sink channel installed into
/// `freshell-codex` (see `set_codex_proxy_event_sink`) for the whole server.
pub fn spawn_codex_proxy_router(
    state: WsState,
    mut rx: mpsc::UnboundedReceiver<TerminalProxyEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(tagged) = rx.recv().await {
            route_proxy_event(&state, tagged).await;
        }
    })
}

async fn route_proxy_event(state: &WsState, tagged: TerminalProxyEvent) {
    let TerminalProxyEvent { terminal_id, cwd, event } = tagged;
    match event {
        RemoteProxyEvent::Candidate(candidate) => {
            route_candidate(state, &terminal_id, cwd.as_deref(), candidate).await;
        }
        RemoteProxyEvent::TurnStarted(_) => {
            if let Some(hub) = &state.activity {
                hub.note_codex_proxy_turn(&terminal_id, false);
            }
        }
        RemoteProxyEvent::TurnCompleted(_) => {
            if let Some(hub) = &state.activity {
                hub.note_codex_proxy_turn(&terminal_id, true);
            }
        }
        RemoteProxyEvent::ThreadStarted(_) | RemoteProxyEvent::ThreadLifecycle(_) => {
            tracing::debug!(terminal_id = %terminal_id, "codex_proxy_lifecycle_event");
        }
        RemoteProxyEvent::ThreadLifecycleLoss(loss) => {
            // S5.a: minimal by fence — re-plan-on-loss stays deferred; the
            // auto-resume orchestrator owns recovery.
            tracing::warn!(terminal_id = %terminal_id, ?loss, "codex_proxy_lifecycle_loss");
        }
        RemoteProxyEvent::RepairTrigger(trigger) => {
            // S5.a + D-GATE-SOFT: log only (includes CandidateCaptureTimeout).
            tracing::warn!(terminal_id = %terminal_id, ?trigger, "codex_proxy_repair_trigger");
        }
    }
}

async fn route_candidate(
    state: &WsState,
    terminal_id: &str,
    cwd: Option<&str>,
    candidate: freshell_codex::remote_proxy_side_effects::RemoteProxyCandidate,
) {
    if candidate.source == CandidateSource::ThreadForkResponse {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_fork_candidate_ignored: disk fork-watch lane owns rebinds (D-FORK)");
        return;
    }
    if candidate.thread.ephemeral {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_candidate_skipped: ephemeral thread");
        return;
    }
    // Legacy bind-predicate parity (terminal-registry.ts:2144/2175 — verified,
    // ledger A25): bind only candidates with a non-empty thread id AND an
    // absolute rollout path (the reconcile activity lane also requires the
    // path — ledger A9).
    if candidate.thread.id.is_empty()
        || !candidate
            .thread
            .path
            .as_deref()
            .map(Path::new)
            .is_some_and(Path::is_absolute)
    {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_candidate_skipped: empty thread id or missing/relative rollout path");
        return;
    }
    // D-03: first bind wins on this terminal.
    if let Some(existing) = state.identity.get(terminal_id) {
        if let (Some("codex"), Some(existing_id)) =
            (existing.provider.as_deref(), existing.session_id.as_deref())
        {
            if existing_id != candidate.thread.id {
                tracing::debug!(terminal_id = %terminal_id, existing = %existing_id,
                    incoming = %candidate.thread.id,
                    "codex_proxy_candidate_ignored: terminal already bound (D-03 first-bind-wins)");
                return;
            }
        }
    }
    let adopted = crate::codex_identity::adopt_codex_identity(
        state,
        CodexAdoption {
            terminal_id,
            thread_id: &candidate.thread.id,
            rollout_path: candidate.thread.path.as_deref().map(Path::new),
            cwd,
        },
    )
    .await;
    if adopted {
        // S5.c release: the awaited ledger write inside the tail IS the
        // "persisted" signal (fsync-before-announce). Idempotent on re-adopt.
        // Verified (ledger A7): atomic_write_durable fsyncs file + parent dir.
        // Documented durability.degraded policy: a disabled/degraded ledger
        // still returns adopted=true — accepted, matches existing identity
        // durability semantics.
        CodexTerminalLaunchManager::global()
            .mark_candidate_persisted(terminal_id)
            .await;
        // D-FORK: give managed panes the disk fork watch resume panes get.
        if let Some(locator) = &state.codex_locator {
            locator.watch_fork(terminal_id, &candidate.thread.id);
        }
    } else {
        CodexTerminalLaunchManager::global()
            .fail_candidate_capture(terminal_id, "codex candidate refused by identity guards")
            .await;
    }
}
```

The `pub mod codex_proxy_route;` declaration in `crates/freshell-ws/src/lib.rs` already
landed in Step 1 (it must accompany the tests so Step 2's RED is real). Note
`CodexAdoption` is `pub(crate)` — the router lives in the same crate, so no visibility
change is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws codex_proxy_route`
Expected: PASS.

- [ ] **Step 5: Boot wiring**

In `crates/freshell-server/src/main.rs`, near the existing `spawn_codex_locator_sweep`
wiring (search for `spawn_codex_locator_sweep`) but — verified placement constraint
(2026-07-30, ledger A3) — NOT inside the `if codex_locator.is_some()` conditional that call
sits in: the sink + router must be installed UNCONDITIONALLY (a managed pane's gate release
depends on the router even when the locator is absent). Place it just after that `if` block,
using the same `WsState` variable; it must execute before the HTTP listener bind/serve
(currently much later in `main`). Note: `spawn_auto_resume_hub` runs earlier in boot, which
is safe — no crash events exist pre-serve, so no adopt can precede this line — but do not
move the install any later:

```rust
    // DEV-0006 S5.a: proxy-event sink + router (the ONE consumer of managed
    // codex launches' RemoteProxyEvent streams).
    let (codex_proxy_events_tx, codex_proxy_events_rx) = tokio::sync::mpsc::unbounded_channel();
    freshell_codex::launch_lifecycle::set_codex_proxy_event_sink(codex_proxy_events_tx);
    freshell_ws::codex_proxy_route::spawn_codex_proxy_router(state.clone(), codex_proxy_events_rx);
```

(Adapt the state variable name to that scope's actual binding.)

Run: `cargo check -p freshell-server`
Expected: clean.

- [ ] **Step 6: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-ws crates/freshell-server
git commit -m "feat(ws): route codex proxy events into the existing identity/activity tails (S5.a, D-03, D-FORK)"
```

---

### Task 7: Suppress the rollout locator for managed panes (S5.b)

**Files:**
- Modify: `crates/freshell-ws/src/codex_association.rs`
- Modify: `crates/freshell-ws/src/terminal.rs` (arm sites `:2405-2450` and the respawn twin
  `:3001-3018`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (the REST door's own arm helper —
  see Step 3's REST item; added 2026-07-30 after validation falsified the two-site claim,
  ledger A10)
- Test: in-module tests in `codex_association.rs`

**Interfaces:**
- Consumes: existing `maybe_arm` (`codex_association.rs:33-47`), `codex_remote_ws_url`
  local in `handle_create` (`terminal.rs:2030-2031`) and its respawn twin (`:2747-2748`).
- Produces:
  - `pub(crate) fn should_arm_codex_locator(mode: &str, managed_codex: bool) -> bool`
  - `maybe_arm` gains a trailing `managed_codex: bool` parameter and refuses when true.

- [ ] **Step 1: Write the failing test**

In `codex_association.rs`'s test module:

```rust
    #[test]
    fn managed_panes_never_arm_the_locator_d03() {
        assert!(should_arm_codex_locator("codex", false));
        assert!(!should_arm_codex_locator("codex", true)); // D-03: proxy candidate is authoritative
        assert!(!should_arm_codex_locator("shell", false));
        assert!(!should_arm_codex_locator("claude", false));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws managed_panes_never_arm_the_locator_d03`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

In `codex_association.rs`:

```rust
/// S5.b / D-03 (recorded rule): managed panes bind identity from the proxy
/// Candidate stream; the disk locator must not race it for the first bind.
/// Suppression happens HERE at arm time — never via `locator.disarm`, which
/// would also kill the fork watch (`codex_locator.rs:263-267`).
pub(crate) fn should_arm_codex_locator(mode: &str, managed_codex: bool) -> bool {
    mode == "codex" && !managed_codex
}
```

Change `maybe_arm`'s signature and gate:

```rust
pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
    managed_codex: bool,
) {
    if !should_arm_codex_locator(mode, managed_codex) {
        return;
    }
    let Some(locator) = &state.codex_locator else {
        return;
    };
    locator.arm(terminal_id, mode, true, resume_session_id, cwd);
}
```

Update BOTH call sites in `terminal.rs` (create arm block `:2405-2450`, respawn twin
`:3001-3018`) to pass `codex_remote_ws_url.is_some()` (each scope already has that local —
`:2030-2031` / `:2747-2748`; capture it into the `spawn_blocking` closure as a `bool` before
the move). Leave the `watch_fork` registration for resume panes in those blocks untouched
(managed fresh panes get their watch from the router — Task 6).

Fix any other `maybe_arm` caller `cargo check -p freshell-ws` reports (pass `false` anywhere
a managed launch is impossible).

ALSO suppress the REST door (2026-07-30 validation FALSIFIED the "two arm sites" claim,
ledger A10): `crates/freshell-freshagent/src/terminal_tabs.rs` has a third arm path —
`arm_locators_for_fresh_pane` (~`:477`, called from the REST create door ~`:1622`; re-anchor
by searching the function name) arms the shared `CodexLocator` directly, and REST panes are
managed-capable. Thread a `managed_codex: bool` parameter into `arm_locators_for_fresh_pane`
(derive it in the caller's scope from the managed codex launch being present — use whatever
local that scope actually has, e.g. the codex launch `Option`/remote URL produced by the plan
block ~`:1300-1331`), and when it is `true` skip the CODEX locator arm only (leave opencode
arming untouched), with a one-line D-03 comment mirroring `should_arm_codex_locator`'s rule.
Managed REST panes get their fork watch from the router (Task 6), same as WS panes. Update
any freshagent test that pins the arming behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --lib && cargo check -p freshell-ws --all-targets && cargo test -p freshell-freshagent && cargo check -p freshell-freshagent --all-targets`
Expected: PASS / clean (see the Workspace setup note — the freshagent suite needs
`node_modules/` for its 12 tsx-dependent tests).

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-ws crates/freshell-freshagent
git commit -m "feat(ws): suppress the rollout locator for managed codex panes, incl. the REST door (S5.b, D-03)"
```

---

### Task 8: Spawn-helper unification (S5.d.1)

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (make helpers pub)
- Modify: `crates/freshell-freshagent/src/codex.rs` (delete duplicates, use canonical pieces)
- Test: existing suites (`cargo test -p freshell-codex -p freshell-freshagent`)

**Interfaces:**
- Consumes: `SpawnedCodexAppServerRuntime::ensure_ready` (`launch_lifecycle.rs:584-658`, the
  canonical spawn using `codex_sidecar_spawn_spec`), the freshagent duplicates:
  `CODEX_MANAGED_CONFIG_ARGS` (`codex.rs:79`, copy of `launch_plan.rs:33`),
  `SIDECAR_START_BUDGET` (`codex.rs:81`, copy of `launch_lifecycle.rs:64`),
  `allocate_loopback_port` (`codex.rs:3550-3553`), `drain_reader` (`codex.rs:3556-3566`).
- Produces:
  - `launch_lifecycle`: `pub const SIDECAR_START_BUDGET`, `pub fn allocate_loopback_port()`,
    `pub fn drain_child_io(...)` (same bodies, now shared).
  - `FreshCodexState::spawn_sidecar` builds its command from
    `freshell_codex::launch_plan::codex_sidecar_spawn_spec` + the shared helpers; its
    JSON-RPC `initialize` handshake and fresh-child-per-call semantics are PRESERVED (that
    behavioral delta is deliberate — `launch_lifecycle.rs:497-503`).

This is a behavior-preserving refactor; the existing test suites are the net.

- [ ] **Step 1: Make the canonical helpers pub**

In `launch_lifecycle.rs`, change `SIDECAR_START_BUDGET` (`:64`), `allocate_loopback_port`
(`:560-569`), and `drain_child_io` (`:571-582`) to `pub`, each with a one-line doc noting
they are the shared sidecar-spawn mechanics (S5.d.1 unification).

Run: `cargo check -p freshell-codex` — Expected: clean.

- [ ] **Step 2: Refactor the freshagent copy**

In `crates/freshell-freshagent/src/codex.rs`:
1. Delete the private `CODEX_MANAGED_CONFIG_ARGS` (`:79`) and use
   `freshell_codex::launch_plan::CODEX_MANAGED_REMOTE_CONFIG_ARGS` (the `launch_plan.rs:33`
   original — verified 2026-07-30, ledger A26: the canonical const's name differs from the
   freshagent copy's; the VALUES are identical `["-c","features.apps=false"]`. Re-export it
   `pub` from `launch_plan` if it is not already).
2. Delete the private `SIDECAR_START_BUDGET` (`:81`) and use
   `freshell_codex::launch_lifecycle::SIDECAR_START_BUDGET`.
3. Delete `allocate_loopback_port` (`:3550-3553`) and `drain_reader` (`:3556-3566`); use the
   now-pub `freshell_codex::launch_lifecycle::{allocate_loopback_port, drain_child_io}`
   (adapt call sites to `drain_child_io`'s signature).
4. In `spawn_sidecar` (`:1959-2056`), replace the hand-assembled argv/env with the spec from
   `freshell_codex::launch_plan::codex_sidecar_spawn_spec(...)` exactly the way
   `SpawnedCodexAppServerRuntime::ensure_ready` consumes it (`launch_lifecycle.rs:584-658`
   is the reference usage — mirror its spec→Command construction). KEEP the `initialize`
   handshake (`:2039-2052`) and the fresh-child-per-call behavior.

- [ ] **Step 3: Run the nets**

Run: `cargo test -p freshell-codex && cargo test -p freshell-freshagent`
Expected: PASS. Validated caveat (2026-07-30, ledger A23): NO freshagent test pins the
sidecar argv bytes — the pins live in freshell-codex's `launch_plan` tests and the platform
goldens — so the suites alone are NOT a sufficient net for this refactor. Do an explicit
pre/post parity check yourself: before refactoring, note the exact argv/env `spawn_sidecar`
assembles (`codex.rs:1986-1995`); after, confirm `codex_sidecar_spawn_spec` + shared helpers
yield the same bytes. The two paths were verified semantically equivalent (same config args,
same 45 s budget) but the helpers are NOT byte-identical — `drain_reader` (generic
`AsyncRead`) vs `drain_child_io(&mut Child)` differ in signature and error strings; keep the
canonical freshell-codex behavior. PRESERVE the `CODEX_CMD` test-override affordance
(`codex.rs:1976`) — freshagent tests rely on it.

- [ ] **Step 4: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-codex crates/freshell-freshagent
git commit -m "refactor(codex): unify duplicated sidecar spawn helpers (S5.d.1)"
```

---

### Task 9: Resolve D-C-REVISIT — sidecar planning budget + REST acquire move (S5.e precondition)

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (budget)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (acquire move + marker update)
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs` (budget), existing
  freshell-freshagent gate tests (update)

**Interfaces:**
- Consumes: manager `plan_create_with_retry` (`launch_lifecycle.rs:408-419`), REST acquire
  block (`terminal_tabs.rs:1065-1094`), `GatedSettleInputs` (`:1139-1165`),
  `settle_gated_create` (`:1174+`), codex plan block (`:1300-1331`), the WS auto-resume
  rejection-arm precedent (`terminal.rs:2916-2934`).
- Produces:
  - `CodexTerminalLaunchManager` gains `plan_budget: Arc<tokio::sync::Semaphore>` (2 permits)
    and `plan_budget_wait: Duration` (30 s); a test constructor
    `pub fn with_plan_budget(runtime_factory: CodexRuntimeFactory, concurrency: usize, wait: Duration) -> Self`.
  - `plan_create_with_retry` acquires a budget permit (bounded wait) before planning; on
    exhaustion returns `CodexLaunchError::Failed("codex sidecar planning budget exhausted; too many concurrent codex launches")`.
  - REST: the spawn-gate permit is acquired INSIDE `settle_gated_create`, after the mode
    branch assigns `spec`/`child_env`, immediately before the PTY fork; the
    `GatedSettleInputs.permit` field is removed.

- [ ] **Step 1: Write the failing budget test**

Append to `crates/freshell-codex/tests/launch_lifecycle.rs` (reuse its fake-runtime helper;
if the fake runtime completes instantly, give the test one whose `ensure_ready` waits on a
`tokio::sync::Notify` so two plans stay in flight — model the blocking runtime on the file's
existing fake-runtime struct, adding the Notify):

```rust
#[tokio::test]
async fn third_concurrent_plan_fails_fast_on_the_sidecar_budget() {
    let (blocking_runtime_factory, release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            blocking_runtime_factory,
            2,
            std::time::Duration::from_millis(200),
        ),
    );
    let input = freshell_codex::launch_plan::CodexLaunchPlanInput::default();
    let m1 = manager.clone();
    let a = tokio::spawn(async move { m1.plan_create_with_retry(&test_input(), 1).await });
    let m2 = manager.clone();
    let b = tokio::spawn(async move { m2.plan_create_with_retry(&test_input(), 1).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await; // both hold the budget
    let third = manager.plan_create_with_retry(&input, 1).await;
    let err = third.expect_err("third concurrent plan must fail fast on the budget");
    assert!(err.to_string().contains("planning budget exhausted"), "{err}");
    release.notify_waiters();
    let _ = a.await;
    let _ = b.await;
}
```

(`test_input()` = the file's existing plan-input helper; if `CodexLaunchPlanInput` borrows,
construct it inline inside each spawned task as shown for `input`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle third_concurrent_plan_fails_fast`
(the `--features real-transport` flag is REQUIRED — `tests/launch_lifecycle.rs` is cfg-gated
behind that default-off feature (`:13`, ledger A26); without it the binary is empty and
exits 0.)
Expected: FAIL to compile — `with_plan_budget` does not exist.

- [ ] **Step 3: Implement the budget**

In `launch_lifecycle.rs`:

```rust
/// D-C-REVISIT — RESOLVED (2026-07-30, spec S5.e precondition): sidecar
/// planning budget covering BOTH doors. Bounds concurrent codex plans
/// server-wide so a burst can never stack ~226s plan holds; waiters fail fast
/// instead of queueing behind them.
pub const CODEX_SIDECAR_PLAN_CONCURRENCY: usize = 2;
pub const CODEX_SIDECAR_PLAN_WAIT: Duration = Duration::from_secs(30);
```

Manager struct gains:

```rust
    plan_budget: Arc<tokio::sync::Semaphore>,
    plan_budget_wait: Duration,
```

`new` fills the defaults; add:

```rust
    /// Test/DI constructor with an explicit sidecar planning budget.
    pub fn with_plan_budget(
        runtime_factory: CodexRuntimeFactory,
        concurrency: usize,
        wait: Duration,
    ) -> Self {
        let mut manager = Self::new(runtime_factory);
        manager.plan_budget = Arc::new(tokio::sync::Semaphore::new(concurrency));
        manager.plan_budget_wait = wait;
        manager
    }
```

Wrap the manager's `plan_create_with_retry` body:

```rust
    pub async fn plan_create_with_retry(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        self.ensure_teardown_worker();
        let _budget = match tokio::time::timeout(
            self.plan_budget_wait,
            self.plan_budget.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            _ => {
                return Err(CodexLaunchError::Failed(
                    "codex sidecar planning budget exhausted; too many concurrent codex launches"
                        .to_string(),
                ))
            }
        };
        self.planner
            .plan_create_with_retry(input, attempts, CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS)
            .await
    }
```

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle` (same
feature flag as Step 2) — Expected: PASS.

- [ ] **Step 4: Move the REST spawn-gate acquire (plan no longer under the permit)**

In `crates/freshell-freshagent/src/terminal_tabs.rs`:

1. DELETE the acquire block in `spawn_terminal_pane` (`:1056-1094`, the
   `let spawn_permit = match state.spawn_gate() { … }` block including its comment) and the
   `permit: spawn_permit,` line at the `GatedSettleInputs` construction (`:1109`).
2. Remove `permit: Option<tokio::sync::OwnedSemaphorePermit>` from `GatedSettleInputs`
   (`:1143`) and the `let _spawn_permit = inputs.permit.take();` head (`:1179`); replace the
   head with a slot declared FIRST so it still drops LAST:

```rust
    // D-C-R (2026-07-30): the spawn-gate permit is now acquired BELOW, after
    // the (possibly ~long) codex managed plan, so codex planning never holds a
    // server-wide spawn permit. Declared first so it drops last (RAII scope:
    // acquire → PTY fork → every settle step → drop).
    let mut _spawn_permit: Option<tokio::sync::OwnedSemaphorePermit> = None;
```

3. Insert the acquire AFTER the mode branch completes (both `spec` and `child_env` assigned;
   i.e., after the `:1300-1331` codex plan block's enclosing branch closes) and immediately
   BEFORE the PTY fork (`spawn_blocking`). Mirror the WS auto-resume rejection arm
   (`terminal.rs:2916-2934`) for cleanup:

```rust
    // Server-wide spawn gate — acquired AFTER the codex managed plan (D-C-R,
    // 2026-07-30): mirrors the WS auto-resume door (plan → acquire → discard
    // on rejection). Decision record: docs/plans/2026-07-27-rest-spawn-gate.md
    // §D-C addendum. `None` (unwired) = ungated.
    if let Some(rest_gate) = state.spawn_gate() {
        match rest_gate.gate.acquire_uncancellable(rest_gate.timeout).await {
            Ok(permit) => _spawn_permit = Some(permit),
            Err(err) => {
                if let Some(launch) = codex_launch.take() {
                    freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                        .discard(launch)
                        .await;
                }
                // Reuse the SAME cleanup statements the existing PTY-spawn-
                // failure arm below runs (MCP config cleanup + amplifier-stub
                // GC) — copy them here verbatim.
                return Err(spawn_gate_error_response(err, rest_gate.timeout));
            }
        }
    }
```

   (Find the existing PTY-spawn-failure arm in `settle_gated_create` — the one the
   `create_gate.rs:87-93` comment calls "its own failed-spawn arm cleans them up" — and copy
   its MCP-cleanup and stub-GC statements into the rejection arm above. Do NOT copy that
   arm's `AlreadyExists`→409 branch — it is PTY-failure-specific; gate rejection keeps
   `spawn_gate_error_response` (verified 2026-07-30, ledger A15).)
4. The old acquire-site's stub-GC arm (`:1085-1088`) moves with it (covered by step 3's
   cleanup copy). Delete any now-unused imports.
5. Update the D-C-REVISIT marker comment (`:1283-1289`) to:

```rust
        // D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH) — RESOLVED 2026-07-30
        // (DEV-0006 S5.e precondition): this plan no longer runs under the
        // held spawn permit (acquire moved below the plan, WS-auto-resume
        // mirror), and concurrent plans are bounded by the manager's sidecar
        // planning budget (CODEX_SIDECAR_PLAN_CONCURRENCY=2, fail-fast).
        // Decision record: docs/plans/2026-07-27-rest-spawn-gate.md §D-C addendum.
```

- [ ] **Step 5: Run the nets and update ordering-pinned tests**

Run: `cargo test -p freshell-freshagent`
Expected: tests that pinned acquire-before-plan ordering or `GatedSettleInputs.permit` fail
to compile or assert — update them to the new ordering (the observable contract they should
now pin: gate rejection still returns the same `spawn_gate_error_response`, and a rejected
codex create discards its launch). All other tests must pass unchanged.

Two deliberate behavioral deltas to pin in the updated tests (2026-07-30 validation,
accepted): (a) a client abort during the permit wait no longer abandons the create — the
acquire now runs on the detached settle task; (b) codex plan-budget exhaustion surfaces as
the plan-failure error shape (`codex_launch_error_response`), not the gate's 503 — assert
the new shapes deliberately rather than restoring the old ones.

Also run: `cargo test -p freshell-ws --lib` (no WS behavior change expected).

- [ ] **Step 6: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-codex crates/freshell-freshagent
git commit -m "feat(codex): resolve D-C-REVISIT — sidecar planning budget + REST permit no longer held across planning (S5.e precondition)"
```

---

### Task 10: Flip `FRESHELL_CODEX_MANAGED_LAUNCH` default ON + pin the fake-codex suites OFF (S5.e)

**Files:**
- Modify: `crates/freshell-codex/src/launch_plan.rs` (`:59-66` + its tests)
- Modify: `crates/freshell-ws/src/terminal.rs` (gate test `:4694-4713`, gate doc `:1036-1041`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (gate twin `:524-532` + its tests)
- Modify: `crates/freshell-ws/tests/codex_fork_rebind.rs` (`:351,:501,:588,:702`)
- Modify: `crates/freshell-ws/tests/codex_locator_activity.rs` (`:151`)
- Modify: `crates/freshell-ws/tests/codex_session_ref_resume.rs` (`:282`)
- Modify: `crates/freshell-ws/tests/codex_candidate_inert.rs` (`:136`)

ALL of the above land in ONE commit — post-flip, `remove_var` means ON, and these suites run
`sh`-script fake codexes that would take the managed path and fail creates.

**Interfaces:**
- Produces: `codex_managed_launch_enabled(value) == (value != Some("0"))` — the opt-out token
  is exactly `"0"`. Every later task and test uses `set_var(FRESHELL_CODEX_MANAGED_LAUNCH, "0")`
  to pin the plain-CLI path.

- [ ] **Step 1: Update the predicate tests first (failing)**

In `launch_plan.rs`'s test module, find the tests covering `codex_managed_launch_enabled`
and rewrite them to the new contract:

```rust
    #[test]
    fn managed_launch_defaults_on_and_only_zero_disables() {
        assert!(codex_managed_launch_enabled(None)); // S5.e: default ON
        assert!(codex_managed_launch_enabled(Some("1")));
        assert!(codex_managed_launch_enabled(Some("")));
        assert!(codex_managed_launch_enabled(Some("true")));
        assert!(!codex_managed_launch_enabled(Some("0"))); // the only opt-out
    }
```

In `terminal.rs:4694-4713`, invert the gate test rows:

```rust
    /// DEV-0006 S5.e: managed codex launch defaults ON; only the exact string
    /// "0" opts out. Mode scoping is unchanged: non-codex modes never plan.
    #[test]
    fn codex_managed_launch_gate_is_mode_and_flag_scoped() {
        assert!(codex_create_uses_managed_launch("codex", Some("1")));
        assert!(codex_create_uses_managed_launch("codex", None));
        assert!(codex_create_uses_managed_launch("codex", Some("")));
        assert!(!codex_create_uses_managed_launch("codex", Some("0")));
        assert!(!codex_create_uses_managed_launch("shell", Some("1")));
        assert!(!codex_create_uses_managed_launch("claude", None));
        assert!(!codex_create_uses_managed_launch("opencode", None));
    }
```

Apply the same inversion to the duplicated gate helper's test battery in
`terminal_tabs.rs` (helper at `:531`; find its tests by searching
`codex_create_uses_managed_launch` in that file).

Run: `cargo test -p freshell-codex --lib managed_launch_defaults_on` — Expected: FAIL
(predicate still `== Some("1")`).

- [ ] **Step 2: Flip the predicate**

`launch_plan.rs:59-66` becomes:

```rust
/// The env var that opts a server process OUT of DEV-0006's managed codex
/// terminal launches. S5.e (2026-07-30): the default flipped ON — S5's
/// consumers (proxy-event drain → identity/activity tails, candidate-
/// persistence gate) are live, closing DEV-0006/DEV-0008. D-C-REVISIT: RESOLVED
/// before this flip (sidecar planning budget + REST acquire move;
/// docs/plans/2026-07-27-rest-spawn-gate.md §D-C addendum).
pub const FRESHELL_CODEX_MANAGED_LAUNCH_ENV: &str = "FRESHELL_CODEX_MANAGED_LAUNCH";

/// Whether the managed-launch flag value enables the wiring. S5.e default ON:
/// only the exact string "0" disables; unset/anything else plans managed codex
/// launches (goldens G-X1/G-X2 pin the live-path argv).
pub fn codex_managed_launch_enabled(value: Option<&str>) -> bool {
    value != Some("0")
}
```

Update the gate doc comment at `terminal.rs:1036-1039` and the twin's doc at
`terminal_tabs.rs:524-532` to the same "default ON, `"0"` opts out" wording (drop the
"G-X0 stays the live shape" sentences).

- [ ] **Step 3: Pin the four fake-codex suites OFF**

Replace each `std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");` with:

```rust
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
```

at exactly: `codex_fork_rebind.rs:351,501,588,702`; `codex_locator_activity.rs:151`;
`codex_session_ref_resume.rs:282`; `codex_candidate_inert.rs:136`.

- [ ] **Step 4: Run the nets**

```bash
cargo test -p freshell-codex
cargo test -p freshell-ws --lib
cargo test -p freshell-freshagent
cargo test -p freshell-ws --test codex_fork_rebind --test codex_locator_activity --test codex_session_ref_resume --test codex_candidate_inert
cargo test -p freshell-ws   # full crate sweep for stragglers
```
Expected: ALL PASS. If any OTHER suite spawns codex terminals and fails post-flip (the spec
names only these four, but the sweep is the net), pin it OFF the same way — same comment,
same `set_var(.., "0")` — and list it in the commit message.

- [ ] **Step 5: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-codex --all-targets -- -D warnings
cargo clippy -p freshell-ws --all-targets -- -D warnings
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-codex crates/freshell-ws crates/freshell-freshagent
git commit -m "feat(codex)!: default FRESHELL_CODEX_MANAGED_LAUNCH ON; pin plain-CLI test suites OFF (DEV-0006 S5.e)"
```

---

### Task 11: Invert the e2e legs + add the managed resume leg (S5.e)

**Files:**
- Modify: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs`

**Interfaces:**
- Consumes: the file's existing helpers (`write_codex_dispatcher`, `spawn_server`,
  `connect_and_handshake`, `create_codex_terminal`, `wait_for_captured_argv`) and the fake
  app-server fixture `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`.
- Produces: one `#[ignore]` test
  `codex_terminal_create_argv_default_managed_and_flag_zero_optout` with three phases:
  default(unset)=managed, `"0"`=plain opt-out, managed resume (the S5.e "resume golden" at
  the integration level — G-X2 already pins the resolver level).

- [ ] **Step 1: Rewrite the test**

1. Rename the test fn to `codex_terminal_create_argv_default_managed_and_flag_zero_optout`
   and rewrite the module doc bullets (`:1-21`): default (unset) = managed `--remote`
   4-tuple + live relay; `"0"` = plain-CLI opt-out (the retired G-X0 shape, now the opt-out
   shape); phase 3 = managed resume argv.
2. Phase 1 (default): keep `std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH")` from
   setup, and move the CURRENT phase-2 body here (capture path `…-argv-default-…`, the
   `--remote` first-token assertions at today's `:298-313`, and the initialize relay
   assertions `:325-351`), reworded "default (unset) must plan the managed launch".
3. Phase 2 (opt-out): `std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0")`, then the
   CURRENT phase-1 body (no `--remote`; `argv[0..2] == ["-c","tui.notification_method=bel"]`),
   reworded "explicit \"0\" must keep the plain-CLI shape". Kill the pane between phases as
   today (`registry.kill`).
4. Phase 3 (managed resume): `std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH")` again,
   fresh capture path, then add a resume-create helper next to `create_codex_terminal`
   (copy its body, adding a `resumeSessionId` field to the create payload exactly as
   `codex_session_ref_resume.rs`'s create message builds it — copy that shape):

```rust
    let created = create_codex_terminal_resume(
        &mut ws,
        "req-resume",
        tmp_cwd.to_str().unwrap(),
        "thread-e2e-resume",
    )
    .await;
    let resume_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let resume_argv = wait_for_captured_argv(&resume_capture);
    assert_eq!(resume_argv[0], "--remote", "managed resume argv: {resume_argv:?}");
    assert_eq!(&resume_argv[2..4], &["-c".to_string(), "features.apps=false".to_string()]);
    // The resume pair rides LAST (G-X2's resolver shape, now pinned live).
    let position = resume_pair_position(&resume_argv, "thread-e2e-resume")
        .expect("managed resume argv must contain `resume thread-e2e-resume`");
    assert_eq!(position + 2, resume_argv.len(), "resume pair must be last: {resume_argv:?}");
    registry.kill(&resume_terminal_id);
```

   Copy `resume_pair_position` verbatim from `codex_session_ref_resume.rs:272-275` into this
   file.
5. Cleanup block: unchanged env removals.

- [ ] **Step 2: Run it (host-gated, needs node + repo node_modules)**

Run: `cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1`
Expected: PASS (three phases). If the host lacks node, state that in the commit message and
run at least `cargo check -p freshell-ws --all-targets`.

- [ ] **Step 3: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/tests/codex_managed_launch_e2e.rs
git commit -m "test(ws): invert managed-launch e2e legs for the ON default; add managed resume leg (S5.e)"
```

---

### Task 12: Retire G-X0, promote G-X1/G-X2 (S5.e goldens)

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs`
- Modify: `port/machine/specs/cli-argv-fidelity.md` (`:645-660` region)
- Modify: `port/machine/STATE.yaml` (`:42-43` G-X0 mention)
- Modify: `crates/freshell-ws/src/terminal.rs` (stale comment sites `:1095-1101`, `:2004-2010`)

**Interfaces:**
- Consumes: `g_x0_codex_shipped_deviation_shape_dev_0006` (`cli_launch_goldens.rs:731-758`),
  G-X1 (`:260-286`), G-X2 (`:288-306`).
- Produces: G-X0 deleted; G-X1 additionally pins `launch.env.is_empty()` (the one assertion
  G-X0 carried that G-X1 lacked); G-X1/G-X2 doc comments name them THE live-path pins.

- [ ] **Step 1: Delete G-X0 and fold its env assertion into G-X1**

Delete the whole `g_x0_codex_shipped_deviation_shape_dev_0006` test (`:731-758`, including
its doc comment). In `g_x1_codex_live_fresh`, append after the args assertion:

```rust
    assert!(launch.env.is_empty()); // folded from retired G-X0 (S5.e)
```

Update G-X1's doc comment to:

```rust
/// G-X1 — codex, linux, live path, fresh. THE live-path pin since the S5.e
/// flag flip (DEV-0006 closed): managed launches feed `codex_remote_ws_url`,
/// so this is the shape every default codex create resolves to. (G-X0, the
/// shipped-deviation no-remote shape, was retired at the flip.)
```

and G-X2's first line to `/// G-X2 — codex, linux, live path, resume: G-X1 args + resume
pair last. Live-path pin since the S5.e flip.`

- [ ] **Step 2: Update the mirrors and stale comments**

- `port/machine/specs/cli-argv-fidelity.md` `:645-660`: add under the G-X1 heading:
  `(S5.e 2026-07-30: G-X1/G-X2 are THE live-path pins; G-X0 — the shipped-deviation
  no-remote shape — is retired. Its env-empty assertion folded into G-X1.)`
- `port/machine/STATE.yaml` `:42-43`: rewrite the G-X0 lines to record the retirement
  (keep YAML structure — edit the value text only).
- `terminal.rs:1095-1101` and `:2004-2010`: reword "Flag OFF keeps … golden G-X0 stays the
  live-path shape" comments to "Flag `"0"` opts out to the plain-CLI shape (the retired
  G-X0 shape; G-X1/G-X2 pin the live path since the S5.e flip)".

- [ ] **Step 3: Run the nets**

Run: `cargo test -p freshell-platform && cargo check -p freshell-ws --all-targets`
Expected: PASS / clean; `cargo test -p freshell-platform 2>&1 | grep g_x0` shows nothing.

- [ ] **Step 4: fmt/clippy + commit**

```bash
cargo fmt --all
cargo clippy -p freshell-platform --all-targets -- -D warnings
git add crates/freshell-platform crates/freshell-ws port/machine
git commit -m "test(platform): retire golden G-X0; promote G-X1/G-X2 as the live-path pins (S5.e)"
```

---

### Task 13: Close DEV-0006 + DEV-0008; record all decisions (S5.e closure)

**Files:**
- Modify: `port/oracle/DEVIATIONS.md` (schema line `:25`; DEV-0006 `:517-527`;
  DEV-0008 `:588-653`)
- Modify: `port/oracle/EQUIVALENCE-REPORT.md` (§0.2.3 `:107-125`; §0.2.4 item 9 `:146-148`)
- Modify: `docs/plans/2026-07-27-rest-spawn-gate.md` (§D-C addendum after `:115`)
- Modify: `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` (RECONCILED banner
  `:11-20` — one-line landing note)
- Modify: `port/HANDOFF.md` (the DEV-0008 remaining-work mention, ~`:763`)

Match each record's existing bullet style exactly (DEV-0006/0008 use plain `- field:` style,
no blank line after the heading). Get the closing commit sha with
`git rev-parse --short HEAD` (the Task 12 commit) and substitute it for `<sha>` below.

- [ ] **Step 1: Extend the status vocabulary**

`DEVIATIONS.md:25` becomes:

```
- **status**: proposed | accepted | rejected | closed
```

(Add, right below it, the line:
`  ("closed" added 2026-07-30 with DEV-0006/DEV-0008 — the first records to complete their adjudicated closure conditions.)`)

- [ ] **Step 2: Close DEV-0006**

Append after the existing `closure_progress` line (`:526`), before `status`:

```
- closure_progress (2026-07-30, DEV-0006 S5, commit <sha>): S5 landed the consumers and flipped the default ON. The parked RemoteProxyEvent stream now drains through one per-terminal task at CodexTerminalLaunchManager::adopt into the EXISTING single-writer tails: Candidate → codex_identity::adopt_codex_identity (sessionRef + ledger + associated/meta.updated in the pinned order), TurnStarted/TurnCompleted → the freshell-activity codex tracker via a third proxy lane with generalized cross-lane dedupe, fork candidates deliberately ignored in favor of the landed disk fork-watch rebind lane (D-FORK), repair/lifecycle-loss log-only (§6 fence). require_candidate_persistence is ENFORCED in the proxy (initial_capture gate: turn/start + thread/fork held until persist, 45s capture timeout, 5s hold timeout, -32000 rejects — legacy remote-proxy.ts parity; timeout consequence softened from legacy's terminal kill to reject+close+log, D-GATE-SOFT). The rollout locator is suppressed at arm time for managed panes with the D-03 rule recorded (first bind wins; proxy candidate authoritative). Structural prerequisites: spawn helpers unified on codex_sidecar_spawn_spec; singleton kept with a set-once proxy-event sink instead of DI (D-SINK); binding_reason explicitly dropped at adoption (D-REASON). D-C-REVISIT resolved BEFORE the flip: sidecar planning budget (2 concurrent, fail-fast) covering both doors + the REST spawn-gate acquire moved below the plan (2026-07-27-rest-spawn-gate.md §D-C addendum). FRESHELL_CODEX_MANAGED_LAUNCH now defaults ON (only exact "0" disables); G-X0 retired, G-X1/G-X2 promoted to the live-path pins, e2e OFF-control leg inverted + managed resume leg added; the four plain-CLI fake-codex suites pin the flag "0".
- status: closed (2026-07-30, commit <sha> — S5 + flag-default flip landed together per the S4 council fence)
```

Replace the old `- status:` line (`:527`) with the new one (do not keep two status lines).

- [ ] **Step 3: Close DEV-0008**

Append after `adjudicated_by` (`:648-651`), before `status`:

```
- closure_progress (2026-07-30, DEV-0006 S5, commit <sha>): CORRECTION + closure. The record's "rust emits NO terminal.meta.updated frames" text (:603-604, restated in the client_behavior_verification scenarios and the user_facing_disclosure) has been stale since 2026-07-16/07-26: the rust server emits terminal.meta.updated at create time (terminal.rs, b9e0c1a3) and at association/rebind time (codex_identity.rs / opencode_association.rs / codex_association.rs), in the pinned associated-then-meta order. The remaining gap is ONLY the git/tokenUsage enrichment (terminal-metadata-service.ts's git probes, retire-TTL, commit-if-changed dedupe), which the adjudicated closure condition (:642-647) does not require. With DEV-0006 S5 landing the coding-CLI session-association subsystem's proxy-fed consumer wiring and the flag flip, the closure condition ("port … terminal.meta.updated WHEN the coding-CLI controllers/session-association subsystem is ported") is met. Updated disclosure: sidebar badges carry provider/session identity from the association push; git branch/dirty and token usage stay absent (enrichment unported, separately adjudicable).
- status: closed (2026-07-30, commit <sha> — closed with DEV-0006 per :642-647; git/tokenUsage enrichment remains out of scope)
```

Replace the old `- status:` line (`:652-653`).

- [ ] **Step 4: Update the EQUIVALENCE-REPORT disclosures**

In §0.2.3 (`:107-125`): replace the DEV-0006 disclosure entry ("codex panes in the Rust
build run standalone, without freshell's managed app-server integration.") with:

```
- DEV-0006 (closed 2026-07-30 — see its closure_progress): codex panes in the Rust build now launch MANAGED by default (app-server sidecar + remote proxy + durability binding), matching the original. Opt-out: FRESHELL_CODEX_MANAGED_LAUNCH=0.
```

Replace the DEV-0008 disclosure entry with:

```
- DEV-0008 (closed 2026-07-30 — see its closure_progress): sidebar terminal metadata badges receive provider/session identity via the terminal.meta.updated push at create and association time; git branch/dirty state and token usage enrichment are not populated (enrichment subsystem unported — those two badge fields stay absent, never stale). Titles and the session directory refresh via REST as before.
```

Keep the section's heading contract honest: since these entries no longer quote the records'
original `user_facing_disclosure` fields verbatim, change the §0.2.3 heading's parenthetical
from "(council-mandated, verbatim from `port/oracle/DEVIATIONS.md`)" to "(council-mandated;
closed records carry their closure_progress-corrected wording — see each record)".

In §0.2.4 item 9 (`:146-148`): update its (now stale at the flip) text to state that codex
managed launch is default-ON and DEV-0006/0008 are closed. Leave §7.1 untouched (it is an
"Adjudicated (3)" snapshot that never listed DEV-0004+; extending it is out of scope — note
nothing there).

In `port/HANDOFF.md` (~`:763`): find the "terminal-metadata push subsystem (DEV-0008)" /
DEV-0006 remaining-work mentions (`grep -n "DEV-0008\|DEV-0006" port/HANDOFF.md`) and mark
each `(closed 2026-07-30 — DEV-0006 S5; see port/oracle/DEVIATIONS.md)`.

- [ ] **Step 5: Append the §D-C addendum**

In `docs/plans/2026-07-27-rest-spawn-gate.md`, after the tripwire line (`:115`), append:

```markdown
> **§D-C ADDENDUM — D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH) RESOLVED (2026-07-30, DEV-0006 S5.e).**
> The flag default flipped ON with two mitigations, replacing the accepted flag-ON exposure:
> (1) a **sidecar planning budget** inside `CodexTerminalLaunchManager::plan_create_with_retry`
> (2 concurrent plans server-wide, 30 s bounded wait, fail-fast) covering both doors;
> (2) the **REST door's acquire moved below the codex plan** (into `settle_gated_create`,
> immediately before the PTY fork), mirroring the WS auto-resume door's plan→acquire→discard
> ordering — a REST codex create no longer holds a spawn permit during planning. Trade-off
> knowingly taken: gate rejection now requires cleanup (codex plan discard + MCP config +
> amplifier-stub GC — the same statements as the PTY-spawn-failure arm), reversing this
> section's "rejection needs NO cleanup" property for the post-plan acquire point.
> RESIDUAL (accepted): WS restore-creates still plan under the caller-held permit
> (`create_gate.rs`); the budget bounds that to ≤2 long holds server-wide. Revisit if a
> restore-fleet incident implicates it. The in-code D-C-REVISIT markers now point here.
```

Also update the flag-const doc's D-C-REVISIT paragraph in
`crates/freshell-codex/src/launch_plan.rs` (done in Task 10 — verify it references the
addendum) and confirm `grep -rn "D-C-REVISIT" crates/` markers all say RESOLVED.

- [ ] **Step 6: Annotate the spec banner**

In `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md`, inside the RECONCILED
banner blockquote (`:11-20`), append one line:

```markdown
> **2026-07-30 (later):** Revised Slice 5 LANDED (docs/plans/2026-07-30-codex-managed-launch-s5.md):
> flag default ON, G-X0 retired, DEV-0006 + DEV-0008 closed. The status lines above are historical.
```

- [ ] **Step 7: Verify + commit**

```bash
grep -n "status: closed" port/oracle/DEVIATIONS.md          # expect 2 hits (DEV-0006, DEV-0008)
grep -rn "D-C-REVISIT" crates/ | grep -v RESOLVED            # expect no hits
git add port/oracle port/HANDOFF.md docs/plans/2026-07-27-rest-spawn-gate.md docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md
git commit -m "docs(oracle): close DEV-0006 + DEV-0008; record S5 decisions and the D-C resolution (S5.e)"
```

---

## Final verification (after Task 13)

- [ ] Full workspace nets:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo test -p freshell-codex
cargo test -p freshell-codex --features real-transport   # candidate_gate + relay suites live behind this feature
cargo test -p freshell-activity
cargo test -p freshell-platform
cargo test -p freshell-ws
cargo test -p freshell-freshagent
cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1   # host-gated: needs node
```

Expected: all green. The e2e run is the end-user story proof: a default codex
`terminal.create` launches managed (`--remote` 4-tuple + live proxy relay), `"0"` opts out,
and a managed resume carries the resume pair last.

## Coverage map (spec → task)

| Spec item | Task(s) |
|---|---|
| S5.a drain task at adopt, all three sites | 3 (drain+sink), 6 (router) |
| S5.a Candidate → adopt_codex_identity tail | 6 |
| S5.a TurnStarted/Completed → tracker, third-lane dedupe | 4, 5, 6 |
| S5.a fork candidates → rebind lane or ignore (decision) | 6 (D-FORK: ignore + watch_fork) |
| S5.a repair/lifecycle-loss minimal logging | 6 |
| S5.b locator suppression + D-03 precedence rule | 7 (arm suppression), 6 (first-bind-wins) |
| S5.c require_candidate_persistence gate + capture timeout | 1 (gate), 2 (plumbing), 6 (release/fail) |
| S5.d.1 spawn-helper unification | 8 |
| S5.d.2 singleton→DI decision | 3 (D-SINK, recorded) |
| S5.d.3 binding_reason decision | 3 (D-REASON, recorded), 13 |
| S5.e D-C-REVISIT precondition | 9, 13 (§D-C addendum) |
| S5.e flag default ON | 10 |
| S5.e retire G-X0 / promote G-X1/G-X2 / resume golden | 12, 11 (resume e2e leg) |
| S5.e invert e2e OFF-control leg | 11 |
| S5.e fix the four fake-codex suites | 10 |
| S5.e close DEV-0006 + DEV-0008 + EQUIVALENCE-REPORT | 13 |
| §6 fences / out-of-scope list | Global Constraints (all tasks) |
