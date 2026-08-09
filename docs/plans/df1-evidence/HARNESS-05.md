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
- `test/e2e-browser/helpers/raw-clients.test.ts` — 39 unit/integration
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

## Green runs (final SHA)

Unit (helper config), repo-owned direct-vitest path — VERIFIED WORKING at
final SHA (result **40/40 passed**):
```
FRESHELL_TEST_SUMMARY="HARNESS-05 scoped e2e-helper vitest" npm run test:vitest -- run --config test/e2e-browser/vitest.config.ts raw-clients
```
(The e2e-helper vitest config is deliberately outside `npm test`; this
coordinated passthrough runs exactly it. Development-loop runs used raw
`npx vitest run --config test/e2e-browser/vitest.config.ts raw-clients`;
round-4 review replaced the recorded command with the repo-owned path.)

Playwright (pw lease held for each run):
- `--project=legacy-chromium specs/harness-05-raw-clients.spec.ts`:
  **10 passed (17.3s)** then **10 passed (18.4s)** — 2 consecutive green.
- `--project=rust-chromium specs/harness-05-raw-clients.spec.ts`:
  **10 passed (37.6s)** then **10 passed (17.9s)** — 2 consecutive green.

Scoped typecheck — EXECUTABLE gate (the repo-owned typecheck configs
deliberately exclude `test/`; this item ships
`test/e2e-browser/tsconfig.raw-clients-check.json`, extending the root
config, so the gate is runnable as written):

```
npx tsc -p test/e2e-browser/tsconfig.raw-clients-check.json > /tmp/h05-tsc.log 2>&1; \
  if grep -qE "^(test/e2e-browser/)?(helpers/raw-clients|helpers/echo-ws-fixture|specs/harness-05-raw-clients)" /tmp/h05-tsc.log; then \
    echo "HARNESS-05 TYPECHECK GATE: FAIL"; exit 1; \
  else echo "HARNESS-05 TYPECHECK GATE: PASS"; fi
```

Result: **PASS** — 0 errors attributed to the HARNESS-05 files; the 8 total
errors in the log are pre-existing dependency-file issues reproduced
identically without this change (`src/lib/client-logger.ts`/`perf-logger.ts`/
`settingsSlice.ts` lack-vite-types attribute errors and
`helpers/fixtures.ts`'s worker-scope tuple typing; all exist on the base).

## Review loop

**Round 1** — independent fresheyes review (GPT family, FRESHPID 2977522,
`git diff origin/df1/integration...HEAD` at 7af7e65a3): verdict FAILED,
6 majors. All confirmed real; all fixed with RED-first tests
(`raw-clients.test.ts` review-round-1 describes) and re-verified:

| # | Finding | Disposition |
|---|---------|-------------|
| R1 | `autoRead:false` parsed coalesced rest bytes before pausing (raw-clients.ts:238) | FIXED: constructor pauses first; rest bytes are deferred unparsed and drained by `resumeReads()`; regression test with a literally coalesced upgrade+frame write. |
| R2 | `nextJsonMessage` could return a stale (earlier-ledger) message (raw-clients.ts:529) | FIXED: only frames received after the call match; stale-pong regression test. |
| R3 | auto close-reply could transmit reserved code 1005 (raw-clients.ts:620) | FIXED: empty peer close frames get an EMPTY close reply (RFC 6455 §7.1.5); 1005 stays a record-only sentinel; regression test asserts the wire frame is empty and the fixture observes zero protocol errors. New fixture command `emptyclose`. |
| R4 | `rawHttpRequest` only settled on `res.end` (raw-clients.ts:788) — mid-body abort could hang to the outer timeout (demonstrated RED: 60s hang on graceful FIN) | FIXED: `aborted`/`error`/`close(!complete)` response handlers reject promptly + labeled; RST + FIN red-green tests. |
| R5 | B4 created a real browser tab and never deleted it (spec:225) — leaks into worker-scoped server state on retries | FIXED: try/finally `DELETE /api/tabs/:id` (both stacks expose it), delete verified + post-delete list assertion; `deleteStatus` added to the leg record (observed 200 both stacks). |
| R6 | evidence typecheck wording not an executable PASS gate | FIXED: committed item-scoped `tsconfig.raw-clients-check.json` + the verbatim gate command above; current result PASS. |

Post-fix re-verification: unit 34/34; legacy-chromium 10/10 ×2 runs;
rust-chromium 10/10 ×2 runs (all listed above at the post-fix SHA).

**Round 2** — independent fresheyes review (GPT family, FRESHPID 4005182,
diff at 85534f268): verdict FAILED, 2 majors + 2 minors. Dispositions:

| # | Finding | Disposition |
|---|---------|-------------|
| R6a | plan Task-6 step still cited the stale one-off tsc file-list command (predated the committed gate config) | FIXED: plan now has the verbatim executable gate (`tsconfig.raw-clients-check.json` + attribution grep). |
| R6b | plan Task-6 pw commands still used the bare positional filter that Playwright 1.52 does NOT filter on | FIXED: plan + this evidence use the working testDir-relative path form `specs/harness-05-raw-clients.spec.ts`, with the pitfall documented inline. |
| R7 | handshake `headers` doc claimed "wins over computed defaults" but implementation appended → duplicate `Host`/`Sec-WebSocket-Key` | FIXED: case-insensitive replace semantics in `connect()`; `Sec-WebSocket-Key` validation expectations documented; regression test asserts exactly-one overridden `Host` line + `Origin` presence (impl and test landed together this round — the RED degenerated; behavior is what's asserted). |
| R8 | `rawHttpRequest` contract overpromised "raw" HTTP (Node owns hop-by-hop framing) | FIXED: doc comment now scopes "raw" precisely — full application-header control, Node HTTP/1.1 framing (`Host` from URL when absent), malformed-HTTP byte streams explicitly out of scope (the raw WS client is the wire-level tool). |

Final verification at HEAD (post-round-2): unit **35/35**; typecheck gate
**PASS**; legacy-chromium **10 passed (18.3s)** + **10 passed (16.9s)**;
rust-chromium **10 passed (30.7s)** + **10 passed (18.1s)** — 2 consecutive
green per leg at the final SHA.

**Round 3** — independent fresheyes review (GPT family, FRESHPID 480597,
diff at d22e78a..): verdict FAILED, 3 majors + 1 minor + 1 nit.
Dispositions (all RED-first):

| # | Finding | Disposition |
|---|---------|-------------|
| R9 | caller-replaced `Sec-WebSocket-Key` was still validated against the discarded RANDOM key → honest servers spuriously rejected | FIXED: expected digest computed from the effective merged wire key; RFC 6455 §1.3 vector regression test (RED→green). |
| R9b | 101 path validated only `Sec-WebSocket-Accept`, not required `Upgrade`/`Connection` response headers | FIXED: RFC 6455 §4.2.2 header validation; rejection detail now included in `RawWsHandshakeError.message`; regression test (RED→green). |
| R10 | auto close-reply could still transmit reserved 1005 when the PEER's close frame itself carried 1005 | FIXED: auto-reply echoes only transmittable codes (RFC 6455 §7.4 / ws receiver set), else answers 1002 (ws/tungstenite reference behavior); deliberate malformed sends remain possible via explicit `sendClose`/`sendFrame`. Wire-level regression test parses the actual reply bytes (RED→green). `SentFrameRecord.closeCode` added so ledgers expose transmitted close codes. |
| R11 | `SentFrameRecord.masked` lied for `omitMaskKey` (recorded false while the MASK bit went on the wire) | FIXED: `masked`/`maskKeyPresent` are wire-truth (bit vs key bytes); regression test; the omit-key malformation's honest peer behavior (parser desync → stall, not 1002) documented in the test. |
| nit | evidence said "28 tests" (now 39) | FIXED above. |

Final verification at HEAD (post-round-3): unit **39/39**; typecheck gate
**PASS**; legacy-chromium **10 passed (16.1s)** + **10 passed (16.9s)**;
rust-chromium **10 passed (31.9s)** + **10 passed (17.4s)** — 2 consecutive
green per leg at the final SHA.

**Round 4** — independent fresheyes review (GPT family, FRESHPID 1235693,
diff at 168670b15): verdict FAILED, 3 majors. Dispositions:

| # | Finding | Disposition |
|---|---------|-------------|
| R12 | 101-header validation used substring checks — `Upgrade: notwebsocket` / `Connection: notupgrade` waved through | FIXED: RFC 7230 comma-token parsing with exact case-insensitive tokens; `notwebsocket`-rejection regression test (RED→green). |
| R13 | matrix spec would break SECURE external-target runs (`FRESHELL_E2E_TARGET_URL=https://…` → derived `wss://`), which the raw clients deliberately reject | FIXED with an explicit scope call, not silence: TLS needs a trusted test-certificate fixture — that is HARNESS-06's own deliverable ("Include … trusted HTTPS"). Group B now `test.skip`s with a recorded reason when the external target is secure; Group A (target-independent) always runs; the `wss:` guard error names the deferral. Verified still-10/10 on both normal legs after the change. |
| R14 | runbook/evidence used raw `npx vitest` — not a repo-coordinated workflow per AGENTS.md | FIXED: verified the repo-owned passthrough `FRESHELL_TEST_SUMMARY="HARNESS-05 scoped e2e-helper vitest" npm run test:vitest -- run --config test/e2e-browser/vitest.config.ts raw-clients` (40/40 at the verify SHA) and replaced every recorded command. |

Final verification at HEAD (post-round-4): unit **40/40** via the
repo-owned path; typecheck gate **PASS**;
legacy-chromium **10 passed (16.4s)** + **10 passed (15.8s)**;
rust-chromium **10 passed (28.0s)** + **10 passed (15.7s)** — 2 consecutive
green per leg at the final SHA.

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
