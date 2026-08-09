# HARNESS-05 evidence — raw HTTP and WebSocket clients in the Playwright runner

**Item (verbatim):** "Add raw HTTP and WebSocket clients to the Playwright
runner. Tests need to send malformed frames, delay reads/hello, create slow
consumers, inspect frames/close codes, and call orchestration routes."

**Acceptance (verbatim):** "Exercise the helper against a deterministic
echo/error fixture: delayed receive truly stops socket draining,
sent/received bytes and close codes are recorded, abort works, and a second
normal socket stays usable. Rust protocol semantics are tested later."

**Worker:** df1-harness-05-raw-clients · **Base:** `origin/df1/integration`
4edd8d10e · **Plan:** `docs/plans/df1/HARNESS-05.md` (includes the
load-bearing audit ledger, all rows VERIFIED).

## What landed

- `test/e2e-browser/helpers/raw-clients.ts` — `RawWsClient`: manual
  RFC 6455 handshake + frame codec over a real `net.Socket`.
  - Malformed-frame knobs: `rsv1..3`, arbitrary opcode, `mask:false`
    (unmasked client frame), `omitMaskKey`, `declaredPayloadLength` lie.
  - Read control: `pauseReads()`/`resumeReads()` (genuine socket pause →
    real TCP backpressure), `autoRead:false`, explicit `hello()` for
    delayed-hello.
  - Inspection: `sentFrames`/`receivedFrames` ledgers (opcode, RSV bits,
    mask flag, payload bytes, exact wire bytes, timestamps), socket-truth
    `bytesSent`/`bytesReceived`, `peerClose {code, reason}`, terminal events
    (`waitForTerminalEvent` → peer-close / tcp-end / local-abort / error),
    `handshake` record (status/headers/raw head), `RawWsHandshakeError`.
  - `abort()` for abrupt teardown; graceful `closeGracefully(code, reason)`.
  - `rawHttpRequest(baseUrl, {method, path, headers, body})`: byte-accounted
    orchestration-route client (full header control incl. omission;
    `agent:false` so byte counters are per-request socket truth).
- `test/e2e-browser/helpers/echo-ws-fixture.ts` — `EchoWsFixture`:
  deterministic in-test WS server (ephemeral loopback). Echo verbatim;
  `close:<code>:<reason>`; `flood:<count>:<size>`; `drop`; per-connection
  ledger (open/close/code/reason/frames/errors); never sends unprompted
  frames; per-connection `error` handlers so intentionally-malformed clients
  never crash the process (load-bearing probe lesson).
- `test/e2e-browser/helpers/raw-clients.test.ts` — 28 unit/integration
  tests of helper + fixture (runs under `test/e2e-browser/vitest.config.ts`,
  the dedicated E2E-helper vitest config).
- `test/e2e-browser/specs/harness-05-raw-clients.spec.ts` — committed probe
  spec. Group A maps one-to-one onto the acceptance sentence (echo/ledger,
  delayed-receive-stops-draining + lossless resume, malformed close codes,
  close code/reason recorded, abort, second socket usable). Group B drives
  the same capabilities against the real worker-scoped server: B1 delayed
  hello (1200ms silent window → ready), B2 malformed-frame termination +
  second normal socket usable, B3 slow-consumer pause/resume around the
  documented JSON pong shape, B4 orchestration REST (health 200 unauth,
  POST /api/tabs browser-tab created, GET /api/tabs lists it, no-token POST
  rejected).
- `test/e2e-browser/playwright.config.ts` — ONE additive `MATRIX_SPECS`
  line (`/harness-05-raw-clients\.spec\.ts$/`), so the spec runs under BOTH
  `legacy-chromium` and `rust-chromium`.

No shared-file edits other than the one-line MATRIX registration.

## Green runs (all at final SHA, filled in below)

Unit (helper config): `npx vitest run --config test/e2e-browser/vitest.config.ts raw-clients`
→ 28/28 passed (multiple runs incl. final at HEAD).

Playwright (pw lease held for each run):
- `--project=legacy-chromium specs/harness-05-raw-clients.spec.ts`:
  **10 passed (17.3s)** then **10 passed (21.8s)** — 2 consecutive green.
- `--project=rust-chromium specs/harness-05-raw-clients.spec.ts`:
  **10 passed (21.9s)** then **10 passed (20.4s)** — 2 consecutive green.

Scoped typecheck (repo root config extended over only the new files +
deps): zero errors attributable to the new files (remaining errors are the
pre-existing dep-graph/lint-known quirks in `src/lib/*` and
`helpers/fixtures.ts`'s worker-scope tuple typing, reproduced identically
without this change).

## Per-leg recorded observations (HARNESS-05-LEG lines)

legacy-chromium: B1 `framesDuringDelay:0, ready:true`; B2
`terminal:peer-close closeCode:1002`; B3 `framesWhilePaused:0 pong ok`;
B4 `health:200 create:200 listContainsTab:true noToken:401`.

rust-chromium: B1 `framesDuringDelay:0, ready:true`; B2 **`terminal:tcp-end,
closeCode:null`** — the Rust server answers an RSV1-violating frame by
ending the TCP connection WITHOUT a close frame, while legacy sends close
1002. This is a REAL per-server behavioral difference, empirically surfaced
by the new raw client and recorded for the follow-up semantic items
(SAFE-01/05, TERM-19 territory); the harness-level leg asserts termination
(the capability) and records the difference rather than adjudicating
semantics. B3 `framesWhilePaused:0 pong ok`; B4 `health:200 create:200
listContainsTab:true noToken:401`, `tabId` is a UUID on rust vs the
legacy's random-id format (both fine at capability level).

## Notes / incidents

- One full-matrix `legacy-chromium` run during development (positional
  filter mishap: Playwright 1.52 positional filters must be
  testDir-relative paths, e.g. `specs/harness-05-raw-clients.spec.ts` — a
  bare file-name substring does NOT filter) showed a foreign failure in
  `truly-idle-alerting.spec.ts` (busy/idle class timeout under swarm load).
  My spec's 10 tests passed inside that run. The foreign flake is not
  attributable to this item (this item touches no production or shared
  client code paths).
- Load-bearing probes (pre-implementation, run-code tier): `ws`@8.18 server
  sends observable close 1002 on RSV1 violations and REQUIRES per-connection
  `error` handlers in fixtures; `net.Socket.pause()` verifiably freezes
  delivery (`bytesRead` stable) and `resume()` is lossless and ordered
  (120/120 frames). Ledger in the plan file.
