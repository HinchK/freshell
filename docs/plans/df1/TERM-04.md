# TERM-04 Implementation Plan — Deduplicate `terminal.create` by `createRequestId`

> df1 worker `df1-term-04-dedupe-create`. Base `origin/df1/integration` @ `3dbba43c2`.
> Checklist item (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, P0 terminal section):
> **TERM-04 — Deduplicate terminal creation requests. Make `createRequestId` idempotent across retry, reconnect, delayed responses, and two clients.**
> Playwright validation (checklist verbatim): *"Intercept/delay the first `terminal.created`, force reconnect, and issue the same create request from two pages; assert one PTY PID, one terminal ID, one pane owner, and one fixture launch record."*
> Reconciliation line (`docs/plans/2026-07-18-checklist-reconciliation.md`): *Class **P**. `reconnection.spec.ts` "pending terminal creates retry after reconnect" runs Node-only. Missing: two-client single-PID `PW-RUST` spec.*

## Finding up front (the implementation already exists; the proof is the deliverable)

The Rust port ALREADY lands the dedupe guard:

- `crates/freshell-ws/src/create_dedupe.rs` — server-wide `requestId -> {InFlight|Settled}` map
  with waiter registration + fail-loud waiter error, restore-flag guard, liveness-anchored
  lazy eviction, lock-discipline split-phase probes. 13 unit tests in-file cover every
  branch (same/cross connection, settled replay, dead evict, flag mismatch, waiter
  settle/fail, resettle race, lock re-entrancy).
- `crates/freshell-ws/src/terminal.rs:564-624` — `begin()` runs at the TOP of the
  `TerminalCreate` dispatch arm, before the rate limiter and before the restore-gate
  fork; `DuplicateSettled` re-sends the stored frame, `DuplicateInFlight` returns silent
  on the same sink (waiter path otherwise), every non-settled exit runs
  `clear_if_in_flight`. `settle()` fires from `handle_create`'s spawn success path
  (`terminal.rs:3075`). `create_gate.rs` clears the sentinel on every gated-exit edge.
- `crates/freshell-ws/tests/restore_spawn_gate.rs` — WS-integration coverage against a
  REAL axum server + REAL PTYs: `same_requestid_resend_returns_existing_terminal`
  (retry), `duplicate_while_queued_does_not_double_spawn` (in-flight same-conn),
  `rate_limited_retry_same_requestid_proceeds` (retry after failure),
  `resend_on_new_connection_returns_same_terminal` (reconnect + two clients),
  `resend_on_new_connection_never_swallowed_while_inflight` (delayed-response waiter
  never wedged).

What is genuinely missing (the item's remaining work):

1. **Wire-level integration legs use `restore:true` only.** Every dedupe assertion in
   `restore_spawn_gate.rs` rides the gated restore path. The non-restore path (inline
   `handle_create`, dedupe `begin` -> spawn -> `settle`/`clear_if_in_flight`) has only
   unit coverage; its end-to-end two-connection/one-PTY shape is unproven at the WS
   boundary. (The rate-limit retry test touches it tangentially.) TERM-04's acceptance
   is path-agnostic — close this with two focused integration tests, TDD.
2. **The `PW-RUST` spec (the reconciliation's named missing piece).** Author
   `terminal-create-dedupe.spec.ts`, register it, and run one probe per leg under the
   df1 deferred-Playwright posture.

## Parity source (legacy `server/` semantics — verbatim anchors)

| Semantics | Legacy anchor (`server/ws-handler.ts`) | Rust answer |
|---|---|---|
| Server-global settled cache `createdTerminalByRequestId` (cross-connection map) | decl :575, `rememberCreatedRequestId` :891-900, `resolveCreatedTerminalBinding` :921-936 | `CreateDedupe` `Entry::Settled`, settle at `terminal.rs:3075` |
| Per-connection `createdByRequestId` with `REPAIR_PENDING_SENTINEL` in-flight marker | `ClientState` :478; sentinel checks :2329/:2416; set :2495; clear :2704 | global `Entry::InFlight{origin,waiters}` sentinel (mechanism divergence: the sentinel carries the reply path so a cross-connection duplicate is never swallowed) |
| Create-lock serialization around the whole decision | `withTerminalCreateLock`/`terminalCreateLockKey` :1002-1033, call :2218 | the dedupe mutex makes begin atomic; restore creates additionally serialize on the spawn gate FIFO |
| Duplicate answered with the SAME `terminal.created` (`reused:true` lifecycle event) | `attachReusedTerminal` :2259-2319 (`reuseSource: 'request_id_cache'`) | `DedupeDecision::DuplicateSettled(created)` replays the exact stored frame (`terminal.rs:575-580`) |
| Sentinel cleanup on failure / RATE_LIMITED so the client retry ladder (same requestId) proceeds fresh | catch arm :2704-2706 | `clear_if_in_flight` at `terminal.rs:622` + all `create_gate.rs` exits; fail-loud `error{PTY_SPAWN_FAILED, requestId}` forwarded to waiters |
| Eager eviction at terminal exit + lazy eviction on registry miss | eager at exit (`onTerminalExitBound` call site :593 → `forgetCreatedRequestIdsForTerminal` :906-910); lazy on registry miss :929-931 | liveness-anchored prune: `begin()` probes `registry.is_pty_running` (helper at `registry.rs` `is_pty_running`) and replays only while running; `settle()` prunes dead settled entries |
| expectedSessionKey-mismatch falls through to the normal path | `createdRequestBindingMatchesExpectedSession` :914-919 | restore-flag-mismatch falls through (documented divergence in `Entry::Settled.restore`; reachable skew needs same requestId + same restore flag + DIFFERENT sessionRef, which no client path produces — a pane never changes its create payload identity fields, only its restore latch) |

Two connection-scoped behaviors worth restating: same-socket duplicates during the
in-flight window are silent in BOTH implementations (the original create's reply is the
duplicate's reply); cross-connection in-flight duplicates are legacy-silent (wedged-pane
risk) but rust-fail-loud via the waiter path — a deliberate, documented, strictly-better
divergence (see `create_dedupe.rs` header).

## File structure / tasks

- Create: `crates/freshell-ws/tests/create_dedupe.rs` — non-restore-path WS integration legs.
- Create: `test/e2e-browser/specs/terminal-create-dedupe.spec.ts` — the checklist PW spec (matrix attempt: rust is the proof leg; legacy is a true parity control since the contract is legacy-native).
- Modify: `test/e2e-browser/playwright.config.ts` — one-line `MATRIX_SPECS` registration (df1 anti-conflict convention).
- Create: `docs/plans/df1-evidence/TERM-04.md` — evidence file (not a checklist edit).

### Task 1: Non-restore dedupe integration legs (TDD)

**Files:**
- Create: `crates/freshell-ws/tests/create_dedupe.rs`

**Harness convention:** real axum server on `127.0.0.1:0` via the SHARED harness
`crates/freshell-ws/tests/common/mod.rs` (`mod common;`): `spawn_server_with_create_protect_probes(CreateProtectConfig::default())`
returns `(ws_url, registry, gate)` (default limits: 10 creates/10s per connection —
no test exceeds 3 sends, so the limiter cannot fire); `connect_and_capture_inventory(url)`
drains the 4 handshake frames (`config_fallback: None` ⇒ exactly 4);
`create_shell_terminal(&mut ws, request_id)` sends the plain frame
`{"type":"terminal.create","requestId":id,"mode":"shell","shell":"system"}` and returns the
terminalId (shell spawn works in this harness); `next_frame_of_type(&mut ws, "terminal.created")`
reads replies; PTY count asserted via `registry.kill_all()`.

- [ ] **Step 1 (RED first):** author the file with both tests, run:

```bash
cargo test -p freshell-ws --test create_dedupe
```

Expected RED mechanics: these are NEW coverage of EXISTING behavior, so they should
pass immediately; the TDD mutation gate is: temporarily neuter the dedupe (`begin()`
unconditionally `Proceed` in a scratch checkout — do NOT commit) and confirm BOTH tests
fail (`kill_all()==2`, second reply terminals differ). Record the mutation result in the
evidence file, then restore.

Test 1 — same-connection settled replay (retry leg, non-restore):

```rust
#[tokio::test(flavor = "multi_thread")]
async fn plain_resend_same_connection_replays_settled_terminal() {
    let (ws_url, registry, _gate) =
        spawn_server_with_create_protect_probes(CreateProtectConfig::default()).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&ws_url).await;
    let tid = create_shell_terminal(&mut ws, "d-plain").await;
    // liveness precondition: replay is owed only while the terminal runs.
    assert!(registry.is_pty_running(&tid));
    send_plain_create(&mut ws, "d-plain").await; // local helper: sends the plain frame above
    let second = next_frame_of_type(&mut ws, "terminal.created").await;
    assert_eq!(second["requestId"], "d-plain");
    assert_eq!(second["terminalId"], tid);
    assert_eq!(registry.kill_all(), 1, "exactly one PTY for one requestId");
}
```

Test 2 — cross-connection + lost-response replay (reconnect + two-client leg, non-restore):

```rust
#[tokio::test(flavor = "multi_thread")]
async fn plain_resend_on_new_connection_replays_settled_terminal() {
    let (ws_url, registry, _gate) =
        spawn_server_with_create_protect_probes(CreateProtectConfig::default()).await;
    let (mut c1, _i1) = connect_and_capture_inventory(&ws_url).await;
    let tid = create_shell_terminal(&mut c1, "d-xconn").await;
    drop(c1); // response landed but the pane is gone — the lost-response shape
    assert!(registry.is_pty_running(&tid));
    let (mut c2, _i2) = connect_and_capture_inventory(&ws_url).await;
    let tid2 = create_shell_terminal(&mut c2, "d-xconn").await;
    assert_eq!(tid2, tid,
        "a settled non-restore create must replay its terminal.created on a new connection");
    send_plain_create(&mut c2, "d-xconn").await;
    let third = next_frame_of_type(&mut c2, "terminal.created").await;
    assert_eq!(third["terminalId"], tid);
    assert_eq!(registry.kill_all(), 1, "exactly one PTY across reconnect + second client");
}
```

(The delivered file — including its `different_requestids_spawn_distinct_terminals`
over-dedupe guard — IS the authority; these blocks are kept structurally truthful to it.)

- [ ] **Step 2 (GREEN x2):** run the file twice (flake check), plus the pre-existing
  sibling suite once to prove no interference:

```bash
cargo test -p freshell-ws --test create_dedupe
cargo test -p freshell-ws --test create_dedupe
cargo test -p freshell-ws --test restore_spawn_gate
```

- [ ] **Step 3:** `cargo fmt --check` + `cargo clippy -p freshell-ws --tests -- -D warnings` clean. Commit.

### Task 2: Playwright spec `terminal-create-dedupe.spec.ts` (author + one probe run per leg)

**Files:**
- Create: `test/e2e-browser/specs/terminal-create-dedupe.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append `/terminal-create-dedupe\.spec\.ts$/` to `MATRIX_SPECS` with a TERM-04 comment)

**Design (one describe, three tests; each test boots its own server via
`createE2eServerHandle(process.env, { kind: e2eServerKind, construct })` like
`truly-idle-alerting.spec.ts`).** The fixture launcher everywhere is HARNESS-03's
`fake-claude.mjs`, pointed in via the established `CLAUDE_CMD` override and given a
per-test `FRESHELL_FAKE_LEDGER` path — "one fixture launch record" = `ledger.jsonl` has
exactly ONE row. A thin program keeps the CLI alive: default `fake-claude` behavior
already idles on stdin and prints `fake-claude> `; no `crash` rules.

`createTestServer` helper inside the spec (mirrors `truly-idle-alerting.spec.ts:75-110`):

```ts
const server = await createE2eServerHandle(process.env, {
  kind: e2eServerKind,
  construct: {
    env: {
      CLAUDE_CMD: fakeClaude,                      // node <fixtures/providers/fake-claude.mjs> wrapper, chmod 755
      FRESHELL_FAKE_LEDGER: path.join(root, 'ledger.jsonl'),
      FRESHELL_FAKE_PROGRAM: JSON.stringify({ rules: [] }),
    },
    setupHome: async (homeDir) => { /* seed .freshell/config.json with codingCli.enabledProviders:['claude'] */ },
  },
})
const info = await server.start()
```

(`CLAUDE_CMD` points at a generated executable shim `#!/bin/sh exec node <abs fake-claude.mjs>` —
the server spawn treats it as the binary; ledger/program env propagate through spawn.
This is the same fake-CLI shim convention as `truly-idle-alerting.spec.ts`'s
`installFakeClaudeCli`, pointed at the HARNESS-03 fixture instead of an inline script.)

Wire frame (matching `shared/ws-protocol.ts` `terminal.create` schema — extra fields omitted):

```json
{"type":"terminal.create","requestId":"K","mode":"claude","restore":true}
```

**Do NOT use the restore:true frame above on the raw legs.** Post-audit correction:
legacy rejects `restore:true` without a canonical `sessionRef` (`RESTORE_UNAVAILABLE`,
guards at ws-handler.ts:2186-2205 — "only when a live canonical owner isn't found" does
not rescue a first create). The delivered raw legs therefore use the PLAIN non-restore
frame `{"type":"terminal.create","requestId":"K","mode":"claude"}` — which also matches
what the frozen client actually sends first. Confirm in the probe run that no
`RESTORE_UNAVAILABLE`/rate-limit frame appears — an unexpected `error` frame
fails the reply await (timeouts are loud), and each test sends at most 3 creates against
the 10/10s limiter budget so the limiter cannot fire regardless.

**Test A — delayed/lost first `terminal.created`, force reconnect, resend: one PTY.**
1. `r1 = RawWsClient.connect(wsUrl)`; `r1.hello(token)`; await `ready`.
2. Send create K (plain frame above). **`r1.abort()` immediately** — the reply (already
   sent or still in flight) is lost; the browser that asked is gone. This is the
   "intercept/delay the first `terminal.created`" + "force reconnect" leg: the client's
   frozen redrive can only re-ask.
3. `r2 = RawWsClient.connect(wsUrl)`; hello; send the IDENTICAL frame (same K).
4. `created = await r2.nextJsonMessage('terminal.created', 5000)` — assert
   `created.requestId === K`, `created.terminalId` non-empty.
5. Assert ledger rows == 1 ("one fixture launch record", whose `pid` is the one PTY PID).
6. Cross-check "one terminal ID": attach a `WsCapture` observer first; its
   `terminals.changed`/`terminal` inventory surfaces (or `GET /api/terminals` via
   `rawHttpRequest`) must show exactly ONE running terminal row and it must equal
   `created.terminalId`. (Pick the inventory surface in-code after reading
   `terminals-rs` list output in the probe; primary assertion stays ledger==1.)

**Test B — the same create issued by two connections concurrently: one PTY, two answers.**
1. `c1`, `c2` raw clients connected + hello'ed.
2. Send the identical create K on both WITHOUT awaiting (back-to-back).
3. Both must receive `terminal.created` with byte-identical `terminalId` (covers both
   windows: in-flight waiter-forward and settled replay).
4. Ledger == 1 row; inventory == 1 running terminal.

**Test C — two real pages: pane owner + duplicate create from a second page.**
1. Page A: `page.goto(baseUrl/?token=…&e2e=1)`; harness ready; picker → "Claude CLI" →
   fill cwd (the per-test temp dir) → confirm. The app's xterm shows `fake-claude> `;
   read pane `createRequestId` K and bound `terminalId` T from
   `harness.getPaneLayout(tabId)`/state (helper patterns:
   `createrequestid-stabilization-rust.spec.ts` `collectTerminalCreateRequestIds`,
   `truly-idle-alerting.spec.ts` `findTerminalLeaf`).
2. `harness.forceDisconnect()`; `harness.waitForConnection()` — the forced
   browser-level reconnect. Pane must re-own the SAME terminal (no second launch):
   ledger still == 1; pane layout still shows T (reattach, not respawn).
3. Page B (`browser.newContext()` — a second real page per the checklist text): goto,
   harness ready; `pageB.evaluate((k) => window.__FRESHELL_TEST_HARNESS__!.sendWsMessage(k),
   { type:'terminal.create', requestId: K, mode:'claude' })` — the SAME create issued
   from a second page's real WS connection.
4. Assert: page A pane still owns T ("one pane owner"); ledger still == 1 ("one PTY
   PID" — the original row's pid remains the only launch); `/api/terminals` (rawHttp)
   shows exactly one running terminal with id T. Page B shows no error banner/new pane
   (its app ignores the unicast reply — no in-flight create of its own; the reply-path
   truth for second connections is proven at the wire in Tests A/B).
5. Cleanup: `harness.killAllTerminals`-style WS kill on page A; close contexts; `server.stop()`.

**Per-leg probe protocol (df1 deferred posture, NON-NEGOTIABLE):** acquire the pw lease
(`acquire.sh pw df1-term-04-dedupe-create --wait 3600`), run the spec ONCE per matrix leg:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium   specs/terminal-create-dedupe.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium specs/terminal-create-dedupe.spec.ts
```

Classify each leg in the evidence file (`green` / `red:<reason>` / `skipped:<why>`), fix
only blocking flaws, do NOT iterate to full pw green.

- [ ] **Step 1 (author RED-ish):** write the spec + MATRIX line; commit.
- [ ] **Step 2 (run-once probe):** pw lease; one run per leg; record outcomes.
- [ ] **Step 3 (fix blockers only):** mechanical/spec-shaping fixes allowed; behavior bugs
  found would REOPEN the item (expected: none — behavior already integration-green).
- [ ] **Step 4:** `npm run lint` on the spec + typecheck clean. Commit.

### Task 3: Evidence + close-out

- [ ] `docs/plans/df1-evidence/TERM-04.md`: parity table, what-landed list, test matrix
  (unit 13 / integration before+after / pw per-leg classification), deliberate-knowledge
  notes (rust waiter fail-loud > legacy silent wedge), mutation-gate result, suggested
  checklist annotation, residual risks.
- [ ] Final verification pass: both Task-1 carges twice, spec probe outcomes recorded,
  `git log --oneline` tidy. Update status `"state":"review","terminal":"COMPLETED"`.

## Load-bearing audit — VALIDATED 2026-08-09 (ledger; all checks cheap/local/run-or-inspect)

| # | Assumption (falsifiable) | Cost if false | Method | Status | Evidence |
|---|---|---|---|---|---|
| 1 | Dedupe `begin()` runs before the rate limiter and covers BOTH restore and non-restore frames on rust | high (plan premise) | inspect + Task-1 tests | **verified** | `terminal.rs:564-624` — `match state.create_dedupe.begin(...)` is the first statement of the `TerminalCreate` arm; `restore==Some(true)` forks to the gate only AFTER it; `clear_if_in_flight` at :622 |
| 2 | `fake-claude.mjs` idles without input and records a `FRESHELL_FAKE_LEDGER` row (pid/argv/env) — usable as the one-launch oracle through `CLAUDE_CMD` | high (spec design) | run + existing-matrix-green | **verified** | `FRESHELL_FAKE_LEDGER=/tmp/… node fake-claude.mjs --session-id …` under `timeout 3` → exit 124 (ALIVE at 3s, idles even on stdin EOF; under a PTY stdin never EOFs) and one ledger row `{pid,argv:--session-id …}`. CLAUDE_CMD seam green matrix-wide: `truly-idle-alerting.spec.ts` (MATRIX_SPECS) |
| 3 | `registry.kill_all()` is a sound one-PTY oracle for these tests | medium | inspect | **verified (scoped)** | `crates/freshell-terminal/src/registry.rs:1620-1628` returns the number of RECORDS the sweep removed (`kill_internal` true on removal, running-or-not — its doc says the sweep walks every tracked id including retained-exited). In these tests zero terminals exit, so records == live PTYs; with a dead shell the assertion would catch a different problem entirely. Same convention as every `restore_spawn_gate.rs` test |
| 4 | Plain frame (no restore/sessionRef, mode claude) spawns cleanly on BOTH servers (no restore-guard rejection) | medium (frame shape) | inspect + existing-green | **verified** | rust: `auto_resume_e2e.rs:86-97` `create_claude_terminal` sends exactly this frame. legacy: plain claude create → `shouldPreallocateFreshClaudeSession` path (`ws-handler.ts:2138-2160`); the picker legs of `truly-idle-alerting.spec.ts` drive it on both matrix projects |
| 5 | RawWsClient abort+reconnect absorbs which window (in-flight vs settled) the first create is in | low | reasoning + existing coverage | **verified** | `DuplicateSettled` replay and InFlight waiter-forward both terminate in "answered once, one PTY"; both shapes pinned green in `restore_spawn_gate.rs` (`resend_on_new_connection_*`) |
| 6 | Legacy Node implements the same wire contract and is a valid parity control | high (matrix legitimacy) | inspect | **verified** | anchors in the parity table above (settled cache :575/:891-936, sentinel :2329-:2704, create lock :2218); reconciliation row names only the rust leg missing |

No falsified assumptions.

Residual risks (recorded honestly — first one surfaced by review round 1):
1. **Legacy leg B is microtask-order sensitive.** On LEGACY, a plain claude create's lock
   key is `session:claude:<per-connection-fresh-uuid>` (`ws-handler.ts:1007-1010`, minted
   per ClientState via `reserveClaudeFreshSessionId` :2146), so two connections sharing a
   requestId do NOT serialize on `withTerminalCreateLock`, and legacy has no
   cross-connection in-flight sentinel — the settled cache only answers AFTER the first
   create's `registry.create` + `rememberCreatedRequestId` (:2653). Leg B passes on legacy
   because the first create resolves off the warm config cache before the second socket's
   message macrotask runs. Under extreme load (cold `configStore.cache`, or any NEW await
   added before `registry.create` on the legacy claude path) legacy leg B could
   double-spawn — a PRE-EXISTING legacy design gap relative to rust's strict superset
   (rust's waiter path makes B deterministic), NOT a behavior this branch introduces.
   If close-out ever sees that flake, the honest fix is a legacy cross-connection
   sentinel, out of this item's scope; the RUST legs (the item's actual proof) are immune.
2. The `error`-frame silence claim is structural, not explicitly asserted: any `error`
   frame on a create leg fails the reply await by timeout (loud), and budgets (≤3 sends vs
   10/10s) keep the limiter unreachable.

## Boundaries (df1 worker contract)

Scoped cargo (cargo lease) for Task 1; scoped `npm run lint`/`npx tsc` on the spec for
Task 2; pw lease for the single probe runs. NO broad `npm test/check/verify`, no gate
lease, no sandbox lanes (nothing destructive here), no pushes/PRs/checklist edits, no
ports 3001/3002/17871/17872/17874, no foreign processes, nice -n 19 on all honorable
runs, which the wrappers already do. df1ctl heartbeat ≤15 min while active.
