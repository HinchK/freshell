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
| Eviction on terminal exit (eager at exit + lazy on registry miss) | `forgetCreatedRequestIdsForTerminal` :594, lazy :929-931 | liveness-anchored: `begin()` probes `registry.is_pty_running` and replays only while Running; `settle()` prunes dead entries (no background task) |
| Session-key mismatch falls through to normal create handling | `createdRequestBindingMatchesExpectedSession` :912-916 | restore-flag mismatch falls through with a fresh InFlight sentinel (documented divergence; equivalent reachable behavior — a pane never changes create-identity fields under one requestId) |

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
- **fmt/clippy:** `cargo fmt -p freshell-ws -- --check` clean; `cargo clippy -p freshell-ws --tests -- -D warnings` clean at `ffca688a1`.
- **Spec typecheck:** `npx tsc -p test/e2e-browser/tsconfig.term04-check.json` — zero
  errors attributed to `specs/terminal-create-dedupe.spec.ts` (pre-existing dependency
  errors repro on base; per the tsconfig's own attribution rule).

## Playwright probe-run outcomes (deferred posture: one run per matrix leg)

(expanded in the File map; commands are the GREEN COMMANDS in the final report)

| Leg | Command suffix | Outcome | Notes |
|---|---|---|---|
| rust-chromium | `--project=rust-chromium specs/terminal-create-dedupe.spec.ts` | **green — 3/3 passed (1.3m)** | THE PW-RUST proof leg. First probe run had one spec-shaping flaw (RawWsClient R2 anti-stale rule violation in test B's interleaved hello/ready — a spec bug, not a server bug); fixed (`3ef9b7e4c`) and rerun green. |
| legacy-chromium | `--project=legacy-chromium specs/terminal-create-dedupe.spec.ts` | **green — 3/3 passed (43.6s)** | True parity control: the contract is legacy-native, and the legacy server passes the identical spec unmodified (global settled cache + sentinel semantics replay one terminalId across abort/reconnect/two-clients). |

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
