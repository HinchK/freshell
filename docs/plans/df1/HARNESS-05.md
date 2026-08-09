# HARNESS-05 — Raw HTTP and WebSocket clients for the Playwright runner

> **For df1 workers:** This plan is executed inline by the owning df1 worker
> (`df1-harness-05-raw-clients`) per the orchestrator dispatch pipeline:
> plan → load-bearing audit → TDD → verify (both matrix legs, ≥2 consecutive
> green runs each) → review loop (fallback: structured fresh-eyes self-review,
> recorded). Evidence lands in `docs/plans/df1-evidence/HARNESS-05.md`.

**Goal (checklist item, verbatim):** "Add raw HTTP and WebSocket clients to
the Playwright runner. Tests need to send malformed frames, delay
reads/hello, create slow consumers, inspect frames/close codes, and call
orchestration routes."

**Acceptance (checklist Playwright validation, verbatim):** "Exercise the
helper against a deterministic echo/error fixture: delayed receive truly
stops socket draining, sent/received bytes and close codes are recorded,
abort works, and a second normal socket stays usable. Rust protocol
semantics are tested later."

**df1 posture (dispatch):** harness self-verify — ≥1 committed probe spec
registered in `MATRIX_SPECS` exercises the raw clients green ≥2 consecutive
runs; malformed-frame/slow-consumer paths run against BOTH
`--project=legacy-chromium` and `--project=rust-chromium` because those legs
drive real-server code paths. Per-leg results recorded.

**Architecture:** One new item-scoped helper module
(`test/e2e-browser/helpers/raw-clients.ts`) providing `RawWsClient` — a
real-socket WebSocket client that performs the RFC 6455 handshake and frame
codec **manually** over `net.Socket` (so malformed wire bytes, read pauses,
and close codes are first-class) — and `rawHttpRequest`, a byte-accounted
HTTP client with full header/method/body control for orchestration routes.
One new deterministic in-test fixture server
(`test/e2e-browser/helpers/echo-ws-fixture.ts`, built on the already-vendored
`ws` package) implements an echo/close/flood/drop protocol. One new probe
spec (`test/e2e-browser/specs/harness-05-raw-clients.spec.ts`) validates the
helper against the fixture and then exercises capability-level legs (delayed
hello, malformed-frame termination, slow consumer, raw orchestration REST)
against the real worker-scoped server of whichever matrix project is
running. One additive line registers the spec in `MATRIX_SPECS`.

**Tech Stack:** Node 22 (`net`, `http`, `crypto`), `ws` ^8.18.0 (fixture
server only — the client under test deliberately does NOT use it),
Playwright 1.52, Vitest (helper unit tests under
`test/e2e-browser/vitest.config.ts`).

## Global constraints (from dispatch + repo rules)

- Server uses NodeNext/ESM: relative imports must include `.js` extensions.
- Shared edits minimal + additive; new files item-scoped (`harness-05-*` /
  `raw-clients*` / `echo-ws-fixture*`). The ONLY shared-file edit is ONE
  appended line + comment in `MATRIX_SPECS` in
  `test/e2e-browser/playwright.config.ts`.
- Ephemeral ports/homes only (`findFreePort`-style OS-assigned binds); never
  ports 3001/3002/17871/17872/17874; no foreign processes; no broad kills.
- pw lease for every Playwright run
  (`acquire.sh pw df1-harness-05-raw-clients --wait 3600`); cargo lease for
  cargo builds (the `rust-chromium` leg builds `freshell-server` release
  once). npm builds are safe in worktrees (`scripts/prebuild-guard.ts`
  exits 0 for linked worktrees).
- No push/PR/git-config/checklist edits.
- TDD: RED → GREEN → refactor, commit at each boundary.
- No `perMessageDeflate`: the raw client's handshake never offers
  `Sec-WebSocket-Extensions`, so every server (ws-based legacy,
  tungstenite-based Rust, fixture) speaks plain frames deterministically.
- `timers`: no wall-clock sleeps in helpers except caller-requested delay
  windows (`collectFramesDuring`) and poll intervals in `waitFor*`.

## Load-bearing audit ledger

| ID | Assumption (falsifiable claim) | Decision controlled | Cost if late-falsified | Method | Status | Evidence |
|----|-------------------------------|---------------------|------------------------|--------|--------|----------|
| LB-1 | `ws`@8.18 server replies to a client protocol violation (e.g. RSV1 set) with an observable close frame code 1002, deterministically | malformed-frame assertion strategy (fixture legs) | medium | run code | **VERIFIED** | `/tmp/df1-lb-probe.mjs` run: client received close frame `code=1002 reason=""`. Fixture must attach per-connection `ws.on('error')` or the error event crashes the process (observed in probe v1). |
| LB-2 | `net.Socket.pause()` truly stops userland delivery (bytes sit unread) and `resume()` is lossless | slow-consumer machinery design | high | run code | **VERIFIED** | probe: paused 1200ms → 0 frames, `bytesRead` stable across window; resumed → 120/120 frames, exact sequence order. |
| LB-3 | Legacy Node server AND Rust server both terminate a raw connection after an RSV1-violating frame (close 1002 and/or TCP end) | B2 leg assertion shape | medium | inspect code + probe at spec run | **VERIFIED (design), run at spec time** | Legacy `ws` receiver enforces RFC (same lib as LB-1); Rust `freshell-ws` uses tokio-tungstenite which RFC-fails protocol errors with `CloseCode::Protocol` (1002). Spec asserts termination (peer-close or TCP-end) and records the observed close code per leg, asserting 1002 when a close frame was observed. Per-leg values recorded in evidence. |
| LB-4 | Both servers answer an application `{type:"ping"}` with `{type:"pong", timestamp}` | B3 slow-consumer trigger determinism | low | inspect code + existing matrix spec | **VERIFIED** | `ws-ping-pong-matrix.spec.ts` (in MATRIX_SPECS, both legs green) proves byte-parity pong on legacy (`server/ws-handler.ts:1832-1835`) and rust. |
| LB-5 | Both servers enforce a default ~5s hello timeout (4002), so a 1.2s delayed hello stays connected | B1 delay sizing | low | inspect code | **VERIFIED** | legacy `server/ws-handler.ts:239` `HELLO_TIMEOUT_MS \|\| 5_000`; rust `crates/freshell-server/src/main.rs` `resolve_hello_timeout_ms()` `unwrap_or(5_000)`. Probe delay = 1200ms << 5s on both. |
| LB-6 | `POST /api/tabs {name, browser}` works on both servers with `x-auth-token` auth and returns `{status:'ok', data:{tabId, ...}}`; `GET /api/tabs` lists it; missing token is rejected (401/403) | B4 orchestration-route leg | medium | inspect code (+ spec run) | **VERIFIED (code), run at spec time** | legacy `server/agent-api/router.ts` (`router.post('/tabs')`, browser-kind = no PTY; `ok()` shape in `server/agent-api/response.ts`; GET at :879-882); rust `crates/freshell-freshagent/src/terminal_tabs.rs:186-189` ("browser truthy -> browser pane", "cheap content kinds"). Auth header `x-auth-token` both sides (`server/auth.ts:43`; rust tests use `"x-auth-token"`). |
| LB-7 | A Playwright spec that never requests the `page` fixture launches no browser | probe speed/determinism | low | inspect framework behavior | **VERIFIED (framework semantics)** | worker-scoped `testServer` boots regardless; `page` is lazy per test. |
| LB-8 | Fresh `node_modules` + repo build suffice to run both legs (pw chromium not needed since no page; cargo present) | verify commands | medium | run code (this session) | **VERIFIED** | `npm ci` done at setup; `cargo` + `node v22` on PATH; rust release build deferred to cargo-leased verify run. |
| LB-9 | The e2e helper vitest config's globalSetup (`npm run build`) is safe in this worktree | unit-test command choice | low | inspect code | **VERIFIED** | `scripts/prebuild-guard.ts:126` exits 0 when `isLinkedWorktreeCheckout()`. |

New assumptions surfaced during execution will be appended here before
completion; falsified ones change the plan inline.

---

### Task 1: EchoWsFixture — deterministic echo/error WS fixture

**Files:**
- Create: `test/e2e-browser/helpers/echo-ws-fixture.ts`
- Test: `test/e2e-browser/helpers/raw-clients.test.ts` (shared test file for
  the whole item; fixture-first section)

**Interfaces:**
- Consumes: `ws` (vendored), node `net`/`events`.
- Produces:
  ```ts
  export interface EchoConnectionLedgerEntry {
    id: number
    openedAt: number
    closedAt: number | null
    closeCode: number | null
    closeReason: string | null
    framesReceived: number
    errors: string[]   // per-connection ws 'error' messages (e.g. protocol violations)
  }
  export class EchoWsFixture {
    static async start(): Promise<EchoWsFixture>   // binds 127.0.0.1:0
    get wsUrl(): string                            // ws://127.0.0.1:<port>/
    get port(): number
    get connections(): readonly EchoConnectionLedgerEntry[]
    async stop(): Promise<void>                    // terminate all conns + close server (idempotent)
  }
  ```
  Protocol (deterministic, zero unprompted frames):
  - any TEXT/BINARY frame not matching a command → echo verbatim (same opcode/payload)
  - text `close:<code>:<reason>` → server initiates close with that code/reason
  - text `flood:<count>:<size>` → server sends `<count>` TEXT frames, payload
    `flood:<i>:<pad-to-size>`
  - text `drop` → server destroys the underlying TCP connection (no close frame)
  Every connection gets `ws.on('error', ...)` (LB-1 lesson) recorded into
  `errors`.

- [ ] **Step 1: failing test** — `raw-clients.test.ts` section
  "EchoWsFixture": start fixture; connect with vendored `ws` client; echo
  text/binary roundtrip; `close:4000:fixture-bye` yields client close
  (4000, 'fixture-bye'); `drop` yields client-side socket end without close
  frame; ledger entry has closeCode/framesReceived; stop() idempotent.
- [ ] **Step 2: run RED** —
  `npx vitest run --config test/e2e-browser/vitest.config.ts raw-clients`
  → fails (module not found).
- [ ] **Step 3: implement** `echo-ws-fixture.ts`.
- [ ] **Step 4: run GREEN** (same command).
- [ ] **Step 5: commit** `test(harness-05): echo/error ws fixture`.

### Task 2: RawWsClient frame codec + handshake (pure, no server needed beyond fixture)

**Files:**
- Create: `test/e2e-browser/helpers/raw-clients.ts`
- Test: `test/e2e-browser/helpers/raw-clients.test.ts` (append sections)

**Interfaces (full public surface — later tasks do not extend it):**
```ts
export const WS_OPCODE = {
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xa,
} as const

export interface RawFrameOptions {
  fin?: boolean                      // default true
  rsv1?: boolean; rsv2?: boolean; rsv3?: boolean
  opcode: number
  payload?: Buffer | string          // default empty
  mask?: boolean                     // default true (RFC client MUST mask); false = malformed
  maskKey?: Buffer                   // explicit 4-byte key (default: random)
  omitMaskKey?: boolean              // MALFORMED: set MASK bit, write no key bytes
  declaredPayloadLength?: number     // MALFORMED knob: lie in the header (default truthful)
}

export interface SentFrameRecord {
  fin: boolean; rsv1: boolean; rsv2: boolean; rsv3: boolean
  opcode: number; payloadBytes: number; wireBytes: number; masked: boolean; at: number
}

export interface ReceivedFrameRecord {
  fin: boolean; rsv1: boolean; rsv2: boolean; rsv3: boolean
  opcode: number; payload: Buffer; payloadBytes: number; wireBytes: number; at: number
}

export interface HandshakeRecord {
  status: number; statusMessage: string
  headers: Record<string, string>
  rawHead: string
}

export class RawWsHandshakeError extends Error {
  readonly status: number
  readonly headers: Record<string, string>
  readonly bodyPrefix: string
}

export interface RawWsClientOptions {
  headers?: Record<string, string>   // extra handshake headers (Origin, ...)
  validateAccept?: boolean           // default true
  autoRead?: boolean                 // default true; false => start paused
  autoReplyPing?: boolean            // default true
  autoReplyClose?: boolean           // default true
  handshakeTimeoutMs?: number        // default 10_000
}

export class RawWsClient {
  static connect(wsUrl: string, options?: RawWsClientOptions): Promise<RawWsClient>
  readonly handshake: HandshakeRecord
  readonly bytesSent: number
  readonly bytesReceived: number
  readonly sentFrames: readonly SentFrameRecord[]
  readonly receivedFrames: readonly ReceivedFrameRecord[]
  readonly peerClose: { code: number; reason: string; at: number } | null
  readonly peerEnded: boolean
  readonly destroyed: boolean
  readonly reading: boolean

  pauseReads(): void
  resumeReads(): void
  sendFrame(options: RawFrameOptions): SentFrameRecord
  sendText(text: string): SentFrameRecord
  sendJson(value: unknown): SentFrameRecord
  sendBinary(payload: Buffer): SentFrameRecord
  sendPing(payload?: Buffer | string): SentFrameRecord
  sendPong(payload?: Buffer | string): SentFrameRecord
  sendClose(code?: number, reason?: string): SentFrameRecord   // default 1000/''
  hello(token: string, protocolVersion?: number): SentFrameRecord
  waitForFrame(pred: (f: ReceivedFrameRecord) => boolean, timeoutMs: number, label?: string): Promise<ReceivedFrameRecord>
  nextJsonMessage<T = any>(type: string, timeoutMs: number): Promise<T>
  collectFramesDuring(durationMs: number): Promise<ReceivedFrameRecord[]>
  waitForTerminalEvent(timeoutMs: number): Promise<'peer-close' | 'tcp-end' | 'local-abort' | 'error'>
  abort(): void                      // socket.destroy()
  dispose(): Promise<void>           // idempotent
  static text(frame: ReceivedFrameRecord): string
  static json<T = any>(frame: ReceivedFrameRecord): T
}

export interface RawHttpRequestOptions {
  method?: string                    // default GET
  path?: string                      // default /
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number                 // default 10_000
}
export interface RawHttpResponse {
  status: number; statusMessage: string; httpVersion: string
  headers: Record<string, string | string | string[] | undefined>  // folded
  rawHeaders: string[]
  body: Buffer
  json(): unknown
  bytesSent: number                  // socket-truth deltas
  bytesReceived: number
  durationMs: number
}
export function rawHttpRequest(baseUrl: string, options?: RawHttpRequestOptions): Promise<RawHttpResponse>
```

- [ ] **Step 1: failing tests** — codec: `ws`-style masking roundtrip against
  the fixture (echo verifies byte-exact payload); RSV/opcode bits visible in
  sent-ledger record; 64-bit length encoding for >64KiB payload echo;
  handshake record exposes 101 + `sec-websocket-accept`.
- [ ] **Step 2: run RED** → module missing.
- [ ] **Step 3: implement** `raw-clients.ts` (codec + handshake + ledgers;
  `rawHttpRequest` stubbed to throw — Task 4 turns it green).
- [ ] **Step 4: run GREEN**.
- [ ] **Step 5: commit** `test(harness-05): raw ws client codec+handshake`.

### Task 3: RawWsClient behaviors (pause, malformed, close codes, abort)

**Files:** Modify `test/e2e-browser/helpers/raw-clients.ts`;
Test: `test/e2e-browser/helpers/raw-clients.test.ts` (append).

- [ ] **Step 1: failing tests** —
  - pause: `pauseReads()` before `flood:120:1843`; `collectFramesDuring(900)`
    returns `[]` and `bytesReceived` stable; `resumeReads()` → 120 frames,
    payload sequence `flood:0..119` exact (LB-2 semantics).
  - malformed: fresh conn, `sendFrame({ rsv1: true, opcode: TEXT, payload:'x' })`
    → `waitForTerminalEvent` = `'peer-close'`, `peerClose.code === 1002` (LB-1);
    fresh conn, `mask: false` → same 1002 outcome recorded, no throw.
  - close-code recording: `close:4000:fixture-bye` → `peerClose =
    { code: 4000, reason: 'fixture-bye' }`; `closeGracefully` → fixture ledger
    shows client-initiated 1000.
  - abort: `abort()` → `destroyed === true`, no further frames recorded even
    while fixture floods; fixture ledger entry closes.
  - second socket: sabotage conn A (rsv1), then conn B echo roundtrips fine.
- [ ] **Step 2: run RED** (behavior methods missing/at wrong semantics).
- [ ] **Step 3: implement** pause/resume, peer-close/terminal tracking,
  abort, collect/wait helpers.
- [ ] **Step 4: run GREEN**.
- [ ] **Step 5: commit** `test(harness-05): pause/malformed/close/abort behaviors`.

### Task 4: rawHttpRequest — byte-accounted orchestration HTTP client

**Files:** Modify `test/e2e-browser/helpers/raw-clients.ts`;
Test: `test/e2e-browser/helpers/raw-clients.test.ts` (append).

- [ ] **Step 1: failing tests** — against a stub `http.createServer`
  (ephemeral): custom method/headers/body echoed by stub; assert status,
  raw+folded headers, body Buffer, `json()`, `bytesSent`/`bytesReceived`
  >0 socket-delta truth, `durationMs`; header control (arbitrary `Origin`,
  deliberately missing auth header passed through untouched).
- [ ] **Step 2: run RED** (`not implemented`).
- [ ] **Step 3: implement** `rawHttpRequest` (`http.request`, `agent: false`,
  socket `bytesRead`/`bytesWritten` deltas, timeout → Error('rawHttpRequest
  timed out after Nms')).
- [ ] **Step 4: run GREEN**.
- [ ] **Step 5: commit** `test(harness-05): raw http client`.

### Task 5: Probe spec + MATRIX registration

**Files:**
- Create: `test/e2e-browser/specs/harness-05-raw-clients.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append ONE entry to
  `MATRIX_SPECS`):
  ```ts
    // HARNESS-05 — raw HTTP/WS clients self-verify: deterministic echo/error
    // fixture legs + capability legs (delayed hello, malformed-frame
    // termination, slow-consumer pause, raw orchestration REST) against BOTH
    // server kinds. See docs/plans/df1/HARNESS-05.md.
    /harness-05-raw-clients\.spec\.ts$/,
  ```

**Spec structure** (`test.describe.serial`, no `page` fixture anywhere):

Group A (fixture-validation — the checklist acceptance legs):
1. echo roundtrip + frame/byte ledgers (text, binary, >64KiB).
2. delayed receive truly stops socket draining (flood while paused; then
   lossless resume).
3. malformed frames recorded (rsv1 → 1002 observed from fixture; unmasked →
   1002).
4. bytes + close codes recorded (close:4000 leg; `bytesSent/bytesReceived`
   monotonic).
5. abort works (no frames post-abort, fixture ledger closes).
6. second normal socket stays usable after sabotage.

Group B (real-server capability legs; both matrix projects, per-leg
recorded):
1. delayed hello: connect, 1200ms silence (assert no terminal event — both
   servers' 5s timeout never fires early, LB-5), `hello(token)`,
   `nextJsonMessage('ready', 5000)`.
2. malformed frame on an authenticated connection →
   `waitForTerminalEvent(5000)` in `{'peer-close','tcp-end'}`; if peer-close,
   assert code 1002 + record; then a SECOND fresh socket hello → ready stays
   usable.
3. slow consumer: hello → ready; `pauseReads()`; `sendJson({type:'ping'})`;
   `collectFramesDuring(800)` = `[]`; `resumeReads()`;
   `nextJsonMessage('pong', 5000)` has EXACTLY keys `{type,timestamp}` (LB-4).
4. orchestration REST via `rawHttpRequest`: `GET /api/health` (no auth) →
   200 + `ok:true`; `POST /api/tabs` (with `x-auth-token`, `{name,
   browser:'https://example.com'}`) → 200 + `status:'ok'` + `data.tabId`;
   `GET /api/tabs` → serialized body contains that tabId; `POST /api/tabs`
   WITHOUT token → 401 or 403 (record per-leg); byte counters >0.

- [ ] **Step 1: register + author spec** (RED: any leg against unbuilt
  behavior — e.g. import exists but Group B leg fails pre-implementation if
  a helper method is wrong; full RED of the file = helper-complete).
- [ ] **Step 2: run fixture-only legs** (no server legs yet, fastest loop).
- [ ] **Step 3: run `--project=legacy-chromium` (pw lease) green**.
- [ ] **Step 4: cargo-leased `cargo build --release -p freshell-server`**,
  then `--project=rust-chromium` (pw lease) green.
- [ ] **Step 5: commit** `test(harness-05): raw-clients probe spec + matrix registration`.

### Task 6: Refactor / polish / verify-matrix

- [ ] **Step 1:** refactor pass (DRY within helper, doc comments matching
  repo doc-comment culture).
- [ ] **Step 2:** scoped typecheck gate (executable, file-attributed; the
  config is committed at `test/e2e-browser/tsconfig.raw-clients-check.json`):
  ```
  npx tsc -p test/e2e-browser/tsconfig.raw-clients-check.json > /tmp/h05-tsc.log 2>&1; \
    if grep -qE "^(test/e2e-browser/)?(helpers/raw-clients|helpers/echo-ws-fixture|specs/harness-05-raw-clients)" /tmp/h05-tsc.log; then \
      echo "HARNESS-05 TYPECHECK GATE: FAIL"; exit 1; \
    else echo "HARNESS-05 TYPECHECK GATE: PASS"; fi
  ```
  (The repo-owned typecheck configs exclude `test/`; remaining errors in the
  log belong to pre-existing dependency files and must not be attributed to
  the three HARNESS-05 files.)
- [ ] **Step 3:** verify matrix — each leg ≥2 consecutive green. NOTE
  (learned the hard way, Playwright 1.52): positional filters must be
  testDir-relative PATHS (`specs/harness-05-raw-clients.spec.ts`) — a bare
  file-name substring does NOT filter and silently runs the whole matrix.
  - `npx vitest run --config test/e2e-browser/vitest.config.ts raw-clients`
  - `npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium "specs/harness-05-raw-clients.spec.ts"` ×2
  - `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium "specs/harness-05-raw-clients.spec.ts"` ×2
  (pw lease held across each run; flaky-prone → the runs ARE the x2.)
- [ ] **Step 4:** write `docs/plans/df1-evidence/HARNESS-05.md` (per-leg
  results, commands, SHAs); commit.
- [ ] **Step 5:** review loop (≤5 rounds); fix serious findings; df1ctl
  `state=review terminal=COMPLETED`.

## Self-review

- **Spec coverage:** item text — malformed frames (sendFrame knobs; A3/B2),
  delay reads/hello (pauseReads, explicit hello; A2/B1), slow consumers
  (A2/B3), inspect frames/close codes (ledgers, peerClose; A1/A4/B2), call
  orchestration routes (rawHttpRequest; B4). Acceptance — fixture legs A1-A6
  one-to-one with the acceptance sentence. Posture — Group B both legs +
  MATRIX line + ×2 runs.
- **Placeholder scan:** none (all test code is written at execution; each
  task names exact assertions).
- **Type consistency:** interface block in Task 2 is the single source;
  Tasks 3-5 reference only names defined there (`collectFramesDuring`,
  `waitForTerminalEvent`, `peerClose`, `nextJsonMessage`, `hello`).
