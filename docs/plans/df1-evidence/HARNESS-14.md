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

**REVIEW LOOP (round 1, 2026-08-09).** Dispatch preference was a fresh review subagent
(Task tool); this worker has no Task tool, and two attempts to spawn an independent fresh
reviewer via the in-app freshell MCP (`new-tab agent=opencode`) timed out at the MCP layer
with an empty tab list (live-server agent lane unresponsive). Documented fallback applied:
structured fresh-eyes self-review against the review-agent skill's bar
(`/home/dan/.claude/skills/.system/review-agent/SKILL.md`), performed over the full merge-base
diff `git diff 4edd8d10e..HEAD` (25 files, +2600/−49), six targeted hunts:

1. **Gate-off production identity** — Rust `clock::now_ms()` gate-off returns
   `system_now_ms()` unconditionally before any lock; legacy `testClockNowMs()` same shape;
   sweep cadence, limiter construction, and router behavior all branch only on
   `enabled()`/module-const env, which production never sets. Absence proven BEHAVIORALLY on
   both matrix legs (ungated fixture: all five verbs 404; `/api/health` 200). **No finding.**
2. **Backwards-time/monotonicity** — advance is non-negative and capped on both sides;
   freeze idempotent; resume continues from held (no catch-up); the only backwards step is
   `reset` by design (documented, and excluded from the monotonicity unit test with the
   reason recorded). Saturating adds in the Rust core. The detach path's
   `last_meaningful_activity_at.max(now_ms())` is freeze-safe. **No finding.**
3. **Cross-test pollution residual** — per-crate audit: `freshell-platform` (only clock.rs
   tests touch the override; in-file lock), `freshell-terminal`/`freshell-ws` (no override
   users remain in unit binaries — moved to integration binaries; the one observed collision
   is the incident above), `freshell-server` (router + gate-aware tests serialize via
   `test_clock_gate`; no other in-binary consumer of the routed clock exists — audited by
   grepping every `clock::` call site; two full 614-pass suite runs green). Legacy vitest:
   per-file isolation + afterEach state normalization (the suite runs `sequence.shuffle`).
   Probe spawns an own gated server per test; the ungated worker fixture drives absence.
   **No finding.**
4. **Legacy/Rust surface parity** — paths, success envelopes
   (`{ok,enabled,mode,nowMs,offsetMs}`), 400 `invalid_advance` envelope, 404 `Not found`,
   401 shape (`unauthorized()` is byte-shape-equal to legacy's reject per boot.rs), 31-day cap
   inclusive on both. One cosmetic dead-path divergence: legacy's freeze/advance POST handler
   would answer 200 `{ok:false,error:'disabled'}` vs Rust's 404 if the clock were somehow
   disabled between the router-level gate and the handler — unreachable in both runtimes
   (no await between; single-threaded tick / pre-check inside the handler). Recorded, not a
   finding.
5. **Probe flakiness** — create-on-live + quiesce (stable `lastLine` across 600ms) BEFORE
   freeze, threshold margins ≥1 virtual minute at every crossing, 15s poll budgets against a
   250ms gated sweep, serial describe, per-test owned servers, clock reset + server stop in
   `finally`. Empirical: 8/8 consecutive full-file legs green (4 per project).
   **No finding.**
6. **Wrongly-swapped `Date.now()` sites** — all 29 swap sites in `terminal-registry.ts` are
   time-semantic (stamps + elapsed math); the codex-rollout `watchId` uniqueness stamp kept
   `Date.now()` (verified in diff); `tabs-registry/store.ts` tmp-pathname `Date.now()` (row
   987) untouched; only the two `options.now` DEFAULT providers rerouted (explicit caller
   injection still wins). **No finding.**

**Outcome: zero qualifying findings.** Overall assessment: ship. Material known test gaps
(recorded under "Deliberately NOT done"): the Rust API token bucket's clock-draining and the
Rust create-rate window are proven at crate level only (no dedicated e2e assertion yet —
SAFE-02/TERM-11 future specs own those); closed-tab retention routing covered by the provider
swap + crate TTL proof but not by a dedicated e2e.
