# HARNESS-14 — Add a controllable server clock

**Item (verbatim):** *Add a controllable server clock. Share one test clock across idle cleanup, rate windows, tab/device TTLs, retention, and timeout tests without wall-clock sleeps.*

**Checklist Playwright validation:** *Advance/freeze/reset the clock from one serial spec, assert fixture timers fire in deterministic order, and launch a normal build to prove the control surface is absent.*

**Dispatch constraint (wave-0, 6 sibling workers in `test/e2e-browser/`):** product-code deltas SMALL,
single-purpose, behind a test-mode env gate; never default-on behavior.

## Parity sources (what the clock must govern)

| Domain | Legacy (frozen `server/`) | Rust port |
|---|---|---|
| Idle cleanup (TERM-11) | `server/terminal-registry.ts` `startIdleMonitor` (30s `setInterval`) → `enforceIdleKills` reads `Date.now()` vs `term.lastActivityAt` (stamped from `Date.now()` at ~15 sites: create/output/input/attach/detach). | `freshell-terminal/src/registry.rs` private `now_ms()` (the SINGLE chokepoint for `last_meaningful_activity_at` + `enforce_idle_kills`); sweep = `freshell_ws::spawn_idle_monitor` (30s), spawned in `freshell-server/src/main.rs:353`. |
| Rate windows | `server/ws-handler.ts:~2437` terminal.create window: `state.terminalCreateTimestamps` filtered by `Date.now()` against `terminalCreateRateWindowMs` (10/10s). ALSO the third-party `express-rate-limit` global API bucket (`server/rate-limit.ts`) — **NOT clock-routable** (no injected time source in the vendored API); documented non-routed seam. | `freshell-ws/src/create_limit.rs::epoch_ms()` (single chokepoint feeding `CreateRateLimiter::try_acquire`). ALSO `freshell-server/src/rate_limit.rs`: already takes an injectable `Clock` trait; production constructs `RateLimiter::new_system` at `main.rs:1198`. |
| Tab/device TTLs (AUTO-15 line) | `server/tabs-registry/store.ts`: `this.now = options.now ?? (() => Date.now())` — the 7-day `DEFAULT_DEVICE_DISPLAY_TTL_DAYS` display cutoff (`:1298-1304`) already flows through that injectable `now`. | `freshell-ws/src/tabs.rs:549` private `now_ms()` feeding `diagnostic_counts`' `DEVICE_DISPLAY_TTL_DAYS` cutoff (`:432`) and push-time `capturedAt` stamps (`:137`,`:286`). |
| Retention | Same `store.ts` `now` provider: closed-tab retention (`DEFAULT_CLOSED_RETENTION_DAYS`, `:706`) + receipt times. | `freshell-ws/src/tabs_persist_retention.rs` evicts device dirs by newest `capturedAt` — stamps written via `tabs.rs`'s `now_ms()`, so routing that one function covers retention too. |
| Timeout tests | Consumers (hello timeout, handoff timeouts, settle windows) — the pattern recipe below covers them; not all routed in this item (SMALL delta rule). | Same. |

## Architecture

**One optional process-wide epoch-ms clock per server implementation, env-gated by
`FRESHELL_TEST_CLOCK=1`.** Gate OFF (default, every normal build/run): zero behavior change —
`now_ms()` returns `SystemTime::now()` / `Date.now()` directly and no control endpoints exist
(unmatched `/api/*` → 404 on both servers today: legacy catch-all `server/index.ts:857-860`;
Rust SPA fallback explicitly 404s unmatched `/api/*`, `main.rs:1146-1148` comment).

**Clock semantics (both implementations identical):**

- State = `{ offset_ms: i64, frozen_at: Option<i64> }` over two atomics (Rust) / one mutable
  module record (Node; the whole operation takes effect synchronously in one tick).
- Effective time: frozen → `frozen_at`; live → `real_now + offset_ms`.
- `advance(ms)` (ms ≥ 0, integer, ≤ 31 days): frozen → `frozen_at += ms`; live → `offset += ms`.
  Advance-only ⇒ **monotonic** (every consumer uses `saturating_sub`/`-`; a backward jump would
  wedge idle math, so no arbitrary `set` operation exists at all).
- `freeze()`: captures current effective time into `frozen_at` (idempotent).
- `resume()`: recomputes `offset_ms = frozen_at - real_now` then clears `frozen_at` — time
  **continues from the held value** (no catch-up jump, monotonicity preserved).
- `reset()`: `offset = 0`, unfrozen → pure wall clock.

**Control surface (identical paths + JSON on both servers), mounted only when the gate is on:**

```
GET  /api/test-clock                 → 200 { ok:true, enabled:true, mode:'live'|'frozen', nowMs, offsetMs }
POST /api/test-clock/advance {ms}    → 200 same state | 400 { error } on bad input
POST /api/test-clock/freeze          → 200 state
POST /api/test-clock/resume          → 200 state
POST /api/test-clock/reset           → 200 state
```

Auth: the same `x-auth-token`/cookie gate as every other `/api/*` route (legacy: registered
alongside the other routers in `server/index.ts`, inheriting the mounted auth middleware; Rust:
`crate::boot::{is_authed, unauthorized}` like `project_colors.rs`).

**Fast sweep under the gate (deliberate, recorded):** the idle sweep cadence is the ONLY wall
clock left in a consumer's path. With the gate ON the sweep interval shrinks to 250ms
(legacy `startIdleMonitor`; Rust at the `main.rs:353` call site), so an advanced clock is
observed within ~a second instead of up to 30s. Gate-off cadence unchanged (30s).

## File structure

**Rust:**

1. `crates/freshell-platform/src/clock.rs` (NEW) — the shared clock. `pub fn enabled()`,
   `pub fn now_ms() -> i64` (fast-path passthrough to `SystemTime` when disabled),
   `pub struct ClockSnapshot { mode, now_ms, offset_ms }`, `pub fn snapshot()`,
   `pub fn advance_ms(u64)`, `pub fn freeze()`, `pub fn resume()`, `pub fn reset()`.
   Gate read once via `OnceLock` from `FRESHELL_TEST_CLOCK`; `#[cfg(test)] pub(crate)
   fn set_enabled_override_for_tests(Option<bool>)` so in-crate tests can exercise the
   enabled path despite the once-only env read. Pure transition math separated into a
   testable struct; global fns are thin atomic wrappers. Exported from `lib.rs`.
   Rationale for placement: `freshell-platform` is already a dependency of
   `freshell-terminal`, `freshell-ws`, AND `freshell-server` — the only existing shared
   crate all three seams can see. `freshell-protocol` is the alternative but owns frozen
   wire types; a process-environment clock fits platform.
2. `crates/freshell-terminal/src/registry.rs` — `now_ms()` body (3 lines) delegates to
   `freshell_platform::clock::now_ms()` when enabled. Idle cleanup + every activity/created/exit
   stamp routed with ONE function edit.
3. `crates/freshell-ws/src/create_limit.rs` — `epoch_ms()` delegates likewise.
4. `crates/freshell-ws/src/tabs.rs` — `now_ms()` delegates likewise (device TTL + capturedAt).
5. `crates/freshell-server/src/rate_limit.rs` — add `pub struct GlobalTestClock` implementing
   `Clock` via `freshell_platform::clock::now_ms()`; `RateLimiter::new_system` gains a sibling
   constructor used by `main.rs` when the gate is on.
6. `crates/freshell-server/src/test_clock_router.rs` (NEW) — axum router for the five
   endpoints above, `is_authed`-gated, 400 on invalid advance input.
7. `crates/freshell-server/src/main.rs` — construct the rate limiter with `GlobalTestClock`
   when the gate is on; merge the test-clock router only when enabled; idle sweep interval
   `250ms` when enabled (30s otherwise).

**Legacy Node:**

8. `server/test-clock.ts` (NEW) — same state machine + `enabled()` (module-level
   `process.env.FRESHELL_TEST_CLOCK === '1'`) + `nowMs()` passthrough.
9. `server/test-clock-router.ts` (NEW) — express Router for the five endpoints (400 via the
   repo's zod-style validation, same JSON envelope `{ error }`).
10. `server/index.ts` — `if (testClockEnabled()) app.use('/api', createTestClockRouter())`
    before the catch-all 404.
11. `server/terminal-registry.ts` — swap the lifecycle-relevant `Date.now()` sites to
    `testClockNowMs()` (idle math + activity stamps stay coherent: ALL must move together —
    mixing clocks would invert the idle sign). `startIdleMonitor` interval 250ms under gate.
12. `server/ws-handler.ts` — the `:2437` create-window `Date.now()` → `testClockNowMs()`.
13. `server/tabs-registry/store.ts` — default `now` providers (`:664`,`:671`) →
    `() => testClockNowMs()` (injectable `options.now` still wins when supplied).

**Harness:**

14. `test/e2e-browser/specs/harness-14-server-clock.spec.ts` (NEW) — the probe (below).
15. `test/e2e-browser/playwright.config.ts` — ONE additive `MATRIX_SPECS` line (unioned by
    gatekeepers per the control README convention).

## Probe spec design (`harness-14-server-clock.spec.ts`, serial, BOTH projects)

Boots its OWN gated server per leg (`e2eServerKind` project option picks
`RustServer` vs `TestServer` with `env: { FRESHELL_TEST_CLOCK: '1' }`), so the worker-scoped
default fixture stays ungated for the absence proof.

1. **State + freeze/advance/reset round-trip:** `GET /api/test-clock` → enabled/live;
   freeze → mode frozen and `nowMs` stops moving across two reads; advance +90s frozen →
   `nowMs` moved by exactly 90s; resume → live again and time continues from the held value
   (Δ between reads ≈ real elapsed, not +jump); reset → offset 0, live, `nowMs ≈ Date.now()`.
   Invalid advance (`ms:-1`, `ms:1e12`, `{}`) → 400. No-token → 401.
2. **Fixture timers fire in deterministic order (idle reaping, zero wall sleeps):**
   autoKillIdleMinutes stays at the default 15 (PATCH settings to be explicit); clock FROZEN;
   raw-WS client (donor pattern: `ws-ping-pong-matrix.spec.ts` `connectAndHello`, raw
   `terminal.create` like `term28-path-shadow-rust.spec.ts`) creates terminal A (never
   attached ⇒ reap-eligible orphan on BOTH servers: Rust stamps `released_by_client: true`
   at create (`registry.rs:1063`); legacy requires only `clients.size === 0`).
   Advance +5min; create B identically. Advance +11min (A age 16min, B age 11min).
   `expect.poll(GET /api/terminals, ≤15s)`: A gone AND B still present — one virtual instant,
   ~1s wall (250ms gated sweep). Advance +5min more (B age 16min): poll → B gone too.
   Ordering (A before B) IS the determinism assertion.
3. **Frozen means frozen:** create C while frozen; wait ~3s wall (≈12 gated sweeps) with no
   advance; C still present — real elapsed time alone can never reap.
4. **Control surface absent in a normal build:** the worker-scoped default `testServer`
   fixture (booted WITHOUT the env on BOTH projects) answers `GET /api/test-clock` → 404 and
   `POST /api/test-clock/advance` → 404.

## TDD task list

- [ ] T1 RED: `freshell-platform` clock unit tests (gate-off passthrough transitions are
      identity≈system; enabled-path transitions via override: advance/advance-while-frozen/
      freeze-idempotent/resume-continues/reset; snapshot shape; monotonicity) — watch fail,
      implement `clock.rs` to green, `cargo test -p freshell-platform clock`.
- [ ] T2: legacy `server/test-clock.ts` + `test/server/test-clock.test.ts` (same transition
      matrix, run via scoped vitest path on the server config).
- [ ] T3: rust `test_clock_router.rs` + `main.rs` wiring + `rate_limit` GlobalTestClock +
      seam delegations (terminal registry / create_limit / tabs). Crate tests: router
      401/400/200s; gate-off `now_ms` identity regression covered by existing suites.
      `cargo test -p freshell-server -p freshell-terminal -p freshell-ws` scoped.
- [ ] T4: legacy router + index.ts mount + seam swaps (`terminal-registry.ts`,
      `ws-handler.ts`, `tabs-registry/store.ts`). Existing server suites re-run scoped
      (terminal-registry idle-kill unit coverage must stay green with the passthrough).
- [ ] T5: probe spec + MATRIX_SPECS registration. RED-vs-ungated (404 assertions pass
      immediately against the default fixture — that's the absence half), then full green run
      on `legacy-chromium` and `rust-chromium`, TWICE consecutive each (flaky discipline),
      pw lease held.
- [ ] T6: evidence file `docs/plans/df1-evidence/HARNESS-14.md` + review loop.

## Load-bearing assumptions (validated BEFORE coding; see evidence file)

- A1: `freshell-platform` is a dependency of terminal+ws+server crates (CONFIRMED via each
  crate's Cargo.toml).
- A2: unmatched `/api/*` → 404 on BOTH servers today (CONFIRMED: legacy `index.ts:857-860`
  catch-all; rust fallback comment `main.rs:1146-1148` — verify behaviorally in probe).
- A3: a WS `terminal.create` that is never attached is reap-eligible at the CONFIGURED
  threshold on both servers (CONFIRMED by reading `registry.rs:1063` +
  `terminal-registry.ts:enforceIdleKills`; behaviorally proven by the probe).
- A4: `ws` package usable from specs for raw hello+create (CONFIRMED — donor specs
  `ws-ping-pong-matrix.spec.ts`, `term28-path-shadow-rust.spec.ts` import it).
- A5: `GET /api/terminals` lists live terminals on both servers (CONFIRMED: legacy
  `index.ts:803`, rust `terminals.rs`). Response shape check needed when writing the probe
  (array vs `{terminals:[]}`) — resolve by reading both list handlers first.
- A6: express-rate-limit's global legacy bucket cannot take an injected clock (CONFIRMED by
  reading `server/rate-limit.ts` — it only passes options through). Documented non-routed
  seam; SAFE-02 window tests keep existing strategies on legacy; the RUST API bucket IS
  routed (`GlobalTestClock`).
- A7: shrinking the idle sweep to 250ms under the gate cannot leak into production: the
  interval is chosen at boot from `enabled()` only; `FRESHELL_TEST_CLOCK` is never set by
  any launcher script/production path (grep-verifiable).
