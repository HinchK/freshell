# HARNESS-14 — Add a controllable server clock — df1 evidence

**Branch:** `df1/harness-14-server-clock` (base `origin/df1/integration` @ `4edd8d10e`) · **Date:** 2026-08-09 · **Playwright posture:** `self-verify` (ran both matrix legs, ≥2 consecutive green each — got 4 each)

IMPLEMENTED (2026-08-09, df1 worker `df1-harness-14-server-clock`): one optional, env-gated
(`FRESHELL_TEST_CLOCK=1`), process-wide **epoch-ms test clock** now exists in BOTH server
implementations with byte-identical control semantics, routed through the idle-cleanup,
rate-window, and tab/device-TTL/retention seams, driven from a serial Playwright probe spec
registered in `MATRIX_SPECS` (runs on `legacy-chromium` AND `rust-chromium`), with the
normal-build absence of the control surface proven on both.

## What landed

**Design (full analysis: `docs/plans/df1/HARNESS-14.md`).** State `{ offset_ms, frozen_at }`;
effective time = `frozen_at` when frozen, else `real_now + offset`. Advance-only (monotonic —
every consumer computes `now - stamp` deltas and a backward jump would wedge idle/TTL math; no
`set` verb exists at all). `advance` while frozen **steps the held value** (deterministic
fixture ordering); `resume` continues live FROM the held value (no catch-up jump); `reset` =
pure wall clock. Gate OFF = every normal build/run: `now_ms()`/`testClockNowMs()` is an
identity passthrough and every control verb is inert (Rust: `Err(Disabled)`; legacy:
`{ ok:false, error:'disabled' }`).

- **Rust clock core** — `crates/freshell-platform/src/clock.rs` (the one crate terminal+ws+server
  all depend on). `Mutex`-guarded pure core (`ClockCore` is separately unit-testable),
  `OnceLock` env read, `#[doc(hidden)] pub fn set_enabled_override_for_tests`.
- **Legacy clock core** — `server/test-clock.ts`, behavioral mirror (same verbs, mode strings,
  31-day advance cap, inert gate-off snapshots).
- **Control surface (identical on both)**: `GET /api/test-clock`,
  `POST /api/test-clock/{advance,freeze,resume,reset}` →
  `{ ok, enabled, mode:'live'|'frozen', nowMs, offsetMs }`; 400
  `{ ok:false, error:'invalid_advance', message }` on bad advance input (missing/negative/
  fractional/string/over-cap). Auth = the same `x-auth-token`/cookie gate as every other
  `/api/*` (401 pre-gate). **Two-layer absence**: routes exist only because handlers+mount
  BOTH enforce the gate — an off-gate deployment answers the catch-all's indistinguishable
  404 `{"error":"Not found"}` (Rust handlers re-check `clock::enabled()`; legacy
  `server/test-clock-router.ts` re-checks `testClockEnabled()` under a `main.rs` merge /
  `index.ts` mount).
- **Seam routing (small, single-purpose diffs)**:
  - Rust idle cleanup: `freshell-terminal/src/registry.rs::now_ms()` → the clock (covers
    activity stamps, created/exit `at`s, `enforce_idle_kills` threshold math in one function).
  - Rust create-rate window: `freshell-ws/src/create_limit.rs::epoch_ms()` → the clock.
  - Rust tab/device TTL + retention stamps: `freshell-ws/src/tabs.rs::now_ms()` → the clock
    (7-day device-display cutoff + push-time `capturedAt`).
  - Rust API token bucket (SAFE-02): `RateLimiter::new_gate_aware` + `GlobalTestClock`
    (`crates/freshell-server/src/rate_limit.rs`), used by `main.rs` only when gated.
  - Legacy idle cleanup: all **29** lifecycle `Date.now()` sites in
    `server/terminal-registry.ts` → `testClockNowMs()` (stamps and reap math stay mutually
    coherent); the codex-rollout `watchId` uniqueness stamp deliberately keeps `Date.now()`.
  - Legacy create-rate window: `server/ws-handler.ts` `terminalCreateTimestamps` read → clock.
  - Legacy tab/device TTL + closed-tab retention: `server/tabs-registry/store.ts` default
    `now` providers → clock (explicit `options.now` still wins when supplied).
  - **Gated fast sweep**: under the gate the idle sweep ticks at 250ms on both servers so an
    advanced clock is observed in ~1s (production 30s cadence untouched).
- **Known non-routed seam (documented, A6)**: legacy's third-party `express-rate-limit`
  global API bucket (`server/rate-limit.ts`) takes no injected clock; SAFE-02 legacy window
  tests keep existing strategies. The Rust API bucket IS routed.

## PROVEN

- **Unit (Rust)**: `cargo test -p freshell-platform clock` → 12/12; router +
  gate-aware suite in `freshell-server` (614 total binary passes, 0 failures);
  full `freshell-terminal` (176 lib) and `freshell-ws` (432 lib) suites green.
- **RED proofs (hand-spliced mutants, named tests failed as predicted)**: frozen-advance
  leak (`freeze_holds_time_constant_and_advance_steps_the_held_value`), resume catch-up jump
  (`resume_continues_from_the_held_value_without_a_jump`), non-idempotent refreeze
  (`freeze_is_idempotent`), unrouted registry seam (`…_follows_the_shared_test_clock…`),
  unrouted tabs seam, unrouted legacy `enforceIdleKills` (2 tests), unrouted legacy
  create-window, missing router enabled-check, missing advance validation.
- **Crate-level routing proofs** in integration binaries (own process — see INCIDENT below):
  `freshell-terminal/tests/test_clock_routing.rs` (frozen-no-aging + 16/11/16 deterministic
  order), `freshell-ws/tests/test_clock_routing.rs` (8-virtual-day TTL expiry; frozen window
  never draining then freed by one virtual step).
- **Legacy routing proofs**: `test/unit/server/terminal-registry.test-clock.test.ts`
  (frozen ⇒ real 50ms never ages; two-fixture deterministic order),
  `test/server/ws-protocol.test.ts` added case (frozen 10-per-10s window: 10 accept + 1
  RATE_LIMITED, real 50ms no drain, one virtual step frees), `test/server/test-clock*.test.ts`.
  Caught a real suite-ordering bug during development: the server vitest config runs
  `sequence.shuffle: true` — module state must be normalized per-test (afterEach resets clock
  + override).
- **Playwright (the acceptance, verbatim)**: `test/e2e-browser/specs/harness-14-server-clock.spec.ts`
  serial, registered in `MATRIX_SPECS`:
  1. advance/freeze/resume/reset round-trip over HTTP + exact-step assertions + 400s + 401;
  2. **fixture timers fire in deterministic order, zero wall sleeps**: live-create A →
     quiesce → freeze → +5m create B (stamps land exactly on the frozen instant) → +11m ⇒
     sweep reaps A only (idle 16m ≥ 15m; B 11m) → 3s of real sweeps under FROZEN clock never
     age B → +2m create C → +3m reaps B only (16m; C 3m) → +13m reaps C. 34 virtual minutes
     in ~10 real seconds per leg;
  3. **normal-build absence**: the ungated worker fixture answers all five verbs 404 on both
     projects (+ `/api/health` 200 sanity).
  - **Consecutive green runs**: legacy-chromium 3/3 ×4 consecutive (23.3s, 25.0s, 26.2s,
    25.5s); rust-chromium 3/3 ×4 consecutive (26.5s, 26.4s, 24.1s, 26.6s).
- **Quality gates**: `cargo clippy --all-targets -- -D warnings` clean on
  freshell-platform/-terminal/-ws/-server; `cargo fmt --check` clean; `npx tsc -p
  tsconfig.server.json` clean; scoped eslint 0 errors; scoped legacy vitest at final SHA:
  431/431 (test-clock, router, registry test-clock, ws-protocol, terminal-registry).

## Incidents worth recording

- **Spawn output is real activity, even at virtual times.** First probe RED: the shell's
  initial prompt line landed AFTER the first `advance`, re-stamping `lastActivityAt` at the
  advanced frozen instant (fresh output at a virtual instant genuinely IS activity — the
  server was right). Probe protocol changed: create on the live clock, wait for shell
  quiescence (`lastLine` stable across 600ms), THEN freeze and step. This is now documented
  in the spec for downstream consumers (TERM-11/SAFE-02/AUTO-15 specs).
- **Process-global clocks and cargo's in-process test parallelism don't mix.** An in-module
  tabs TTL routing proof (frozen+advanced under the override) collided with the pre-existing
  parallel TTL test and turned it red. All override-using proofs moved to per-crate
  **integration test binaries** (separate processes). `freshell-server`'s router/gate-aware
  tests stay in-module, guarded by an audit: no other consumer of the global clock exists
  inside that binary, and every override-user serializes via
  `crates/freshell-server/src/test_clock_gate.rs`.
- **axum `Option<Json<T>>` rejects a JSON-typed EMPTY body with plain-text 400 before the
  handler** — control-surface routers must not conflate that with their own 400 envelope;
  the probe sends no content-type on body-less POSTs.

## Deliberately NOT done (scope)

- Only the seams named by the item (idle cleanup, rate windows, tab/device TTLs, retention)
  are routed; "timeout tests" (hello timeout, handoff timeouts, settle windows) are future
  consumers and follow the same recipe (`testClockNowMs()`/`clock::now_ms()` swap + probe
  convention), documented in `docs/plans/df1/HARNESS-14.md`'s parity table.
- No client-side clock control (the client runs on wall clock; server-authoritative timers
  are the ones specs could not sleep through).
- `docs/index.html` untouched (no user-facing change).

## Review

Structured fresh-eyes review loop — see "REVIEW LOOP" below (this file, appended).
