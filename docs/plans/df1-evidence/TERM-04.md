# TERM-04 — Deduplicate terminal creation requests

**Item text (verbatim):** Deduplicate terminal creation requests. Make `createRequestId` idempotent across retry, reconnect, delayed responses, and two clients.
**Playwright validation (`PW-RUST`):** Intercept/delay the first `terminal.created`, force reconnect, and issue the same create request from two pages; assert one PTY PID, one terminal ID, one pane owner, and one fixture launch record.

**Branch:** `df1/term-04-dedupe-create` (base `origin/df1/integration` = 3dbba43c2) · **Playwright posture:** `deferred` (probe-run-once-per-leg rule honored — see leg outcomes)

## Headline finding

**The Rust dedupe implementation already existed and is complete** (see "Pre-existing
coverage"). The item's genuine gaps were (1) no wire-level proof on the non-restore
create path, and (2) no `PW-RUST` spec — the exact piece the 2026-07-18 reconciliation
named missing. Both are landed by this branch. While TDDing (1) I also rate-limited a
real heisen-variant (shell exiting inside the settle→resend window legitimately evicts
the entry — contract-correct, legacy delete-at-exit parity); the new tests assert the
liveness precondition explicitly so a dead-shell flake can never masquerade as a dedupe
violation.

## Parity table (legacy authority → rust answer)

| Legacy semantics | Anchor (`server/ws-handler.ts`) | Rust answer |
|---|---|---|
| Server-global settled cache, replay while terminal runs | `createdTerminalByRequestId` :575, `remember/resolve` :891-936 | `CreateDedupe` `Entry::Settled` (`crates/freshell-ws/src/create_dedupe.rs`), settle wired at `terminal.rs:3075` |
| In-flight duplicate on same socket: silent (the in-flight reply IS the duplicate's reply) | `REPAIR_PENDING_SENTINEL` checks :2329/:2416, set :2495, clear :2704 | `Entry::InFlight` + `DuplicateInFlight` (dispatch `terminal.rs:581-588`) |
| In-flight duplicate on NEW socket: silent in legacy (a late-reply wedge risk); | same anchors | **Strictly better:** cross-connection sink registered as waiter; `settle()` forwards the stored frame; non-settled exit forwards fail-loud `error{PTY_SPAWN_FAILED, requestId}` — never silence |
| Sentinel dropped on failure/RATE_LIMITED so the client retry ladder (same requestId) proceeds fresh | catch arm :2704 | `clear_if_in_flight` at `terminal.rs:622` + every `create_gate.rs` exit |
| Eviction on terminal exit (eager at exit + lazy on registry miss) | `onTerminalExitBound` call :593 → `forgetCreatedRequestIdsForTerminal` :906-910; lazy on registry miss :929-931 | liveness-anchored: `begin()` probes `registry.is_pty_running` and replays only while Running; `settle()` prunes dead entries (no background task) |
| Session-key mismatch falls through to normal create handling | `createdRequestBindingMatchesExpectedSession` :914-919 | restore-flag mismatch falls through with a fresh InFlight sentinel (documented divergence; equivalent reachable behavior — a pane never changes create-identity fields under one requestId) |

## What this branch lands

1. **`crates/freshell-ws/tests/create_dedupe.rs`** (new) — non-restore wire-level legs
   against a real axum server + real PTYs:
   - `plain_resend_same_connection_replays_settled_terminal` (retry leg)
   - `plain_resend_on_new_connection_replays_settled_terminal` (reconnect + two-client +
     repeat-resend leg; explicit liveness precondition)
   - `different_requestids_spawn_distinct_terminals` (over-dedupe guard)
2. **`test/e2e-browser/specs/terminal-create-dedupe.spec.ts`** (new) + MATRIX
   registration — the checklist's PW validation, three tests (see File map below).
3. **`test/e2e-browser/tsconfig.term04-check.json`** (new) — item-scoped tsc gate
   (HARNESS-05 convention).

## Test evidence

- **Unit (pre-existing):** `cargo test -p freshell-ws create_dedupe` — 13 unit tests in
  `src/create_dedupe.rs` cover same/cross-connection paths, settled replay, dead-eviction,
  restore-flag mismatch (with sentinel), waiter settle/fail-loud, resettle race, and
  lock-discipline re-entrancy. Green at base; untouched by this branch.
- **WS integration restore-path (pre-existing):** `crates/freshell-ws/tests/restore_spawn_gate.rs`
  — `same_requestid_resend_returns_existing_terminal`,
  `duplicate_while_queued_does_not_double_spawn`,
  `rate_limited_retry_same_requestid_proceeds`,
  `resend_on_new_connection_returns_same_terminal`,
  `resend_on_new_connection_never_swallowed_while_inflight`. Green at base; untouched.
- **WS integration non-restore (NEW):** `cargo test -p freshell-ws --test create_dedupe`
  — 3/3 green, run twice consecutively (and again post-mutation-revert).
  **Mutation gate (RED proof):** forcing `CreateDedupe::begin()` to return `Proceed`
  unconditionally fails exactly the two resend tests (`plain_resend_same_connection…`,
  `plain_resend_on_new_connection…`); `different_requestids…` stays green. Mutation was
  worktree-local, reverted before commit (`git checkout`).
- **fmt/clippy:** `cargo fmt -p freshell-ws -- --check` clean and `cargo clippy -p freshell-ws --tests -- -D warnings` clean; first verified at `ffca688a1`, re-verified at `dfb5fe963` (the full-gate stamp).
- **Spec typecheck:** `npx tsc -p test/e2e-browser/tsconfig.term04-check.json` — zero
  errors attributed to `specs/terminal-create-dedupe.spec.ts` (pre-existing dependency
  errors repro on base; per the tsconfig's own attribution rule).

## Playwright probe-run outcomes (deferred posture: one run per matrix leg)

(expanded in the File map; commands are the GREEN COMMANDS in the final report)

| Leg | Command suffix | Outcome | Notes |
|---|---|---|---|
| rust-chromium | `--project=rust-chromium specs/terminal-create-dedupe.spec.ts` | **green — 3/3 (2.2m), exit 0 @ final HEAD** | THE PW-RUST proof leg. (Round-1-era intermediates: 3/3 at `3ef9b7e4c` after a spec-shaping fix for RawWsClient's R2 anti-stale rule; 3/3 at `e6fc55a3d` after the r1 fixes. Authoritative runs: dfb5fe963, then re-run at final HEAD after the r3 nit polish.) |
| legacy-chromium | `--project=legacy-chromium specs/terminal-create-dedupe.spec.ts` | **green — 3/3 (32.7s), exit 0 @ final HEAD** | True parity control: the contract is legacy-native, and the legacy server passes the identical spec unmodified (global settled cache + sentinel semantics replay one terminalId across abort/reconnect/two-clients). |

## File map for the spec

`terminal-create-dedupe.spec.ts` (3 tests, one server per test, fake-claude via the
matrix-proven `CLAUDE_CMD` seam + `FRESHELL_FAKE_LEDGER` launch ledger):

- **A — lost first `terminal.created` + forced reconnect:** raw client aborts before
  reading the reply; a new raw connection resends the byte-identical plain create frame;
  asserts one `terminal.created` answer, ledger==1 (one launch record/one PTY PID), and
  `/api/terminals` inventory == exactly `[created.terminalId]` (one terminal ID).
- **B — two clients concurrently:** two raw connections send the identical frame
  back-to-back; both must receive `terminal.created` for the SAME terminalId
  (in-flight-waiter or settled-replay — the checklist contract either way), ledger==1,
  inventory one running row.
- **C — two pages (pane owner):** page A picker-creates a claude pane (real minted
  `createRequestId`); forced browser WS disconnect/reconnect must re-attach the SAME
  terminal with ledger still ==1; a second real page then issues the same create through
  its own app WS via `sendWsMessage`; asserts one ledger row, one running terminal, page
  A's pane still the owner of that terminalId, page B's connection still `ready`.

## Deliberate-knowledge notes

- **Rust is strictly safer than legacy in one window:** a cross-connection duplicate
  landing during a long/in-flight create is silent in legacy (the reply goes to the
  origin socket) but is answered in rust (waiter-forwarded frame on settle, fail-loud
  error on non-settled exit). This is the documented "mechanism divergence, same wire
  outcome" of `create_dedupe.rs`, not a drift to fix.
- **Replay is liveness-anchored on both servers:** once the terminal exits, a re-sent
  requestId behaves like a fresh create (legacy prunes at exit; rust evicts on the
  liveness probe). Tests codify this as an explicit precondition.
- `restore:true` frames and plain frames dedupe through the IDENTICAL dispatch-arm
  guard on rust; the restore path's extra spawn-gate serialization does not change
  dedupe outcomes (pinned by both test files).

## Suggested checklist annotation (for the consolidation pass)

> PARTIAL → evidence-complete (2026-08-09, df1 `term-04-dedupe-create` branch): rust dedupe
> (`create_dedupe.rs` + dispatch arm) already implemented with 13 unit + 5 restore-path
> WS integration tests; THIS branch adds the non-restore WS integration legs
> (`crates/freshell-ws/tests/create_dedupe.rs`, mutation-gate proven) and the checklist's
> PW validation `terminal-create-dedupe.spec.ts` (registered in `MATRIX_SPECS`, both
> server kinds; probe-run outcomes: rust-chromium 3/3 GREEN, legacy-chromium 3/3 GREEN).
> Remaining: close-out campaign's full-matrix execution.

## Residual notes for close-out

- Test C drives the real pane picker (claude button + cwd combobox) — same gesture as
  `truly-idle-alerting.spec.ts`; cwd autocomplete timing is the only inherently
  timing-sensitive step and uses Playwright retrying matchers (10–20s).
- The `/api/terminals` inventory assertion tolerates exactly one running row per test
  server (per-test isolated server guarantees).
- **Legacy leg B microtask sensitivity (registered by review round 1):** on the legacy
  server, a plain claude create's create-lock key is a per-CONNECTION fresh claude uuid
  (`ws-handler.ts:1007-1010` + `reserveClaudeFreshSessionId` :2146), so two connections
  sharing one requestId never serialize on `withTerminalCreateLock`; legacy also has no
  cross-connection in-flight sentinel. Leg B's legacy pass rests on the first create
  completing (warm `configStore.cache`) before the second socket's frame is processed —
  solid in practice, but not a legacy guarantee. Rust's waiter path makes the same leg
  fully deterministic, which is why rust remains the proof leg. If close-out ever
  observes a legacy double-spawn flake in leg B, the fix is a legacy-side cross-connection
  sentinel (pre-existing gap, deliberately out of TERM-04 scope — legacy is the parity
  source here, and the checklist's target is the rust port).
- The same pre-settle window technically exists for legacy leg A (sentinels are
  per-connection), but that leg is load-proof in practice: `waitForLedgerRows` only
  returns after the child's Node boot (far slower than the server's spawn→
  `rememberCreatedRequestId` path), so the reconnect resend always lands on the settled
  cache. Registered for completeness; no action.

## Review round 1 → fixes (fresheyes independent review, claude provider, verdict FAILED→fixed)

Substantive findings, all reproduced and fixed:

- **[P1] Test C vacuity** — the "two pages" duplicate had zero delivery/answer proof
  (page B's app has three lawful silent-swallow paths for create frames, and asserts ran
  after a fixed 1 s sleep). Fixed: delivery asserted via the app's own outbound
  `recordSentWsMessages` observer (fires only on a real socket send,
  ws-client.ts:784-787 + App.tsx:229-231), and the server's answer is observed through
  Playwright's own WS tap on page B (`page.waitForEvent('websocket')` +
  `framereceived`), requiring a `terminal.created` with the SAME requestId and the SAME
  terminalId; the fixed sleep is gone (reply-ordered asserts).
- **[P2] Liveness precondition missing from test 1** (claimed for "tests", present in
  one) — added `is_pty_running` assert to the same-connection leg; header now truthful.
- **[P3] Phantom `error`-frame guard in plan/test-header** — never existed; docs now say
  precisely why the limiter can't participate (timeouts are loud; ≤3 sends vs 10/10s).
- **[P4] `kill_all()` overclaim in the audit ledger** — it counts removed records, not
  live PTYs; row rewritten with the scoped truth (zero exits in these tests).
- **[P6] Tautological pid assert** — now `childPidsOf(info.pid)` must contain the ledger
  pid (HARNESS-03's `/proc`-based child-of check) in legs A and B: the launch-record pid
  is proven to belong to the server under test.
- **[P5] Legacy leg-B microtask race** — registered above in Residual notes (documented
  legacy pre-existing gap; rust legs deterministic).
- **[P7-P11 nits]** — legacy anchors corrected (:593/:906-910/:914-919); MATRIX comment
  now names the server-global cache; stale "fake CLI banner" comment rewritten to match
  the Redux-layout poll; per-test `mkdtemp` trees now removed in afterEach; plan Task-1
  snippets updated to the real shared-harness helpers.

## Review round 2 → fixes (fresheyes independent review #2, claude provider, verdict FAILED→fixed)

- **[blocker — provenance]** "Evidence table recorded runs that predate the r1
  assertion changes without saying so." True of the STAMP, false of the RUNS (post-r1
  runs at `e6fc55a3d` had been green before this commit but unrecorded; the table still
  showed pre-r1 timings). Fixed by re-running the FULL gate at `dfb5fe963` (cargo
  create_dedupe 3/3 + restore_spawn_gate 12/12 + clippy -D warnings + fmt + tsc
  attribution 0; PW rust 3/3 exit 0; PW legacy 3/3 exit 0) and re-stamping the table
  with the run SHA. The command chain's `grep -c` zero-match footgun (exit 1) was the
  only infra wrinkle — cargo legs completed first; PW legs re-invoked separately.
- **[minor] Leg C reconnect proof was local-state-vacuous** (Redux keeps terminalId
  while disconnected). Fixed with a real marker round-trip: fake-claude program rule
  `stdin:^term04-ping$` → `marker term04-pong-marker`, typed into page A's xterm after
  the forced reconnect; attach truth is now "bytes round-trip through THE same PTY".
- **[minor] Leg C final ledger assert justified by a false ordering claim** (server
  replies to page B BEFORE a wrongful duplicate's child could write its ledger row):
  comment rewritten — the ordering guarantee comes from the reply poll's terminalId
  match, not from any timing window; the ledger/inventory/owner reads are confirming.
- **[minor] `childPidsOf` is `[]` off Linux** (vacuous-in-reverse): both pid asserts are
  now `process.platform === 'linux'`-guarded (the matrix host is Linux).
- **[minor] Legacy pre-settle window named for leg A too** — registered in Residual
  notes with the reason it's load-proof (ledger gating >> spawn→remember).
- **[nit] Drifted `create_dedupe.rs` header anchors** (pre-existing, the module under
  proof): updated to current `ws-handler.ts` lines (:575/:921-936/:478/:2495/:2218/
  :591-593/:906-910/:929-931; cleanup :2704; TerminalView reply match :4216/:4702).
- **[nit] Plan-anchor off-by-ones + the INVALID restore-frame mid-edit artifact** in
  `docs/plans/df1/TERM-04.md`: anchors corrected (:921-936, :2259-2319); the frame
  discussion now leads with the DO-NOT-USE note.

## Review round 3 (fresheyes independent review #3, claude provider): PASSED

"Round-2 fixes are correct in code, not just in the changelog" — every corrected anchor
line-exact, the leg-C marker round-trip verified end-to-end against the fixture rule
engine + PTY line discipline + TerminalHelper typing path, provenance confirmed
(`dfb5fe963` → final-HEAD delta is docs-only / pre-commit-identical), own re-run of the
tsc gate reproduced. Remaining minor/nit items, all closed in the final commit (no
further round needed per the reviewer's own stop rule):

- Leg-A comment now states the DETERMINISTIC settled-window truth (ledger row ⇒ child
  booted ⇒ create settled before the abort) and points at the in-flight window's real
  pins (`resend_on_new_connection_never_swallowed_while_inflight` + unit waiter tests).
- "One fixture launch record" is no longer `≥1`-shaped: both raw legs re-read the ledger
  AFTER the inventory poll (closes the wrongful-child-boot lag window); leg C's ledger
  truth rides on the answered-duplicate terminalId match (a Proceed answers a DIFFERENT
  id before any ledger read).
- Leg C: `waitForOutput` now pinned to `terminalId`; page-B pane tree asserted to contain
  NO leaf owning T (the negative half of "one pane owner"); single-socket WS-tap scope
  documented.
- `waiter_error` doc anchor updated (the last `TerminalView.tsx:3995-3999` → :4702);
  "a RATE_LIMITED" grammar; probe-record stamp consistency (clippy/fmt at dfb5fe963);
  MATRIX registration comment now notes the default chromium project also matches.
