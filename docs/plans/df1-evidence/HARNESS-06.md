# HARNESS-06 — Deterministic proxy/file/SMB/editor/AI-Kilroy/update/HTTPS fixtures — df1 evidence

**Branch:** `df1/harness-06-misc-fixtures` (base `origin/df1/integration` @ `4edd8d10e`) · **Date:** 2026-08-09 · **Playwright posture:** self-verify (harness variant) — MATRIX_SPECS-registered smoke, server-kind-agnostic, run on all three projects.

IMPLEMENTED: all seven deterministic fixture families the later
BROWSER-*/FILE-*/SESSION-04/UPDATE-*/TAURI-14/KILROY-* lanes consume, each as NEW
item-scoped files (zero edits to shared harness code — one additive
`MATRIX_SPECS` regex line is the only pre-existing-file touch, per control README):

- `test/e2e-browser/helpers/harness-06/target-server.ts` (+ tests) — one owned Node
  process, ephemeral loopback port (or caller-pinned port with EADDRINUSE retry).
  HTTP: `GET /page` marker page (`data-fixture="harness-06"`, csp/xfo/title knobs);
  `ALL /echo` recording `{method,path,raw query,headers,bodyBase64}` and echoing it
  back; `GET /stream` ordered chunked lines; `GET /__admin/ledger`. WS `/ws-echo`:
  subprotocol allowlist negotiation, verbatim text/binary echo, open/frame/close
  ledger (query + cookies verbatim). Hot-reload: `/hot` page + `/hot/stream` SSE +
  `bumpBuild()`/`POST /__admin/bump` → self-reload DOM flip; `sseClientCount()` gates
  "EventSource connected" deterministically. `closeWebSockets(code,reason)` for
  mid-stream disconnect lanes. Optional `tls` keypair turns every surface https/wss.
- `test/e2e-browser/helpers/harness-06/file-trees.ts` (+ tests) — deterministic local
  file tree (valid PNG bytes, Unicode filename, 0x00..0xFF binary, 5 MiB LCG
  `large.bin`, nested/hidden/empty dirs) and the sibling `share`/`share-evil`
  prefix-confusion pair, all with `{sha256,size}` manifests. Pure UNC/file-URL
  mapping helpers (`\\server\share\rel`, `file://server/share/rel` percent-encoded,
  exactly-once decode) with split/round-trip parsers.
- `test/e2e-browser/helpers/harness-06/fake-editor.ts` + `fixtures/fake-editor.mjs`
  (+ tests) — generated POSIX `sh` + Windows `.cmd` wrappers around a payload that
  appends `{pid,t,argv,cwd}` JSONL to `FAKE_EDITOR_LOG` ("records editor
  invocations"); knobs `FAKE_EDITOR_EXIT_CODE` / `FAKE_EDITOR_SLEEP_MS` /
  `--fixture-crash` (FILE-04 spawn-failure legs).
- `test/e2e-browser/helpers/harness-06/fake-ai.ts` (+ tests) — fake Gemini
  `generateContent` / `streamGenerateContent?alt=sse` HTTP endpoint in the exact
  shape the pinned prod dependency `@ai-sdk/google@3.0.43` calls and Zod-validates
  (`x-goog-api-key` header, `candidates[0].content.parts[].text` response, SSE chunk
  + terminal usage chunk). Fixed default output, per-request override and error
  modes (500 / 429 / prompt-block), request ledger. Verified both raw-HTTP and
  through the real SDK (`createGoogleGenerativeAI({ baseURL })` + `generateText`).
- `test/e2e-browser/helpers/harness-06/kilroy-runtime.ts` +
  `fixtures/fake-kilroy-runtime.mjs` (+ tests) — standalone fake Kilroy sidecar
  speaking the real `crates/freshell-claude-sidecar/index.mjs` newline-JSON
  protocol (created-first handshake → `sdk.session.init` → `sdk.status idle`;
  send turn: `running` → `sdk.assistant` → `sdk.result success` →
  `sdk.turn.complete{at}` (monotonic) → `idle`; resume keeps `cliSessionId` and
  emits `sdk.session.snapshot`). JSONL request ledger. Knobs: approval
  (`sdk.turn.waiting` edge then complete), fail-result (error, NO turn.complete),
  crash-on-send (exit 3 mid-turn), hold-turn.
- `test/e2e-browser/helpers/harness-06/update-feed.ts` (+ tests) — runtime ed25519
  keypairs (no committed private material), minisign-EXACT `.pub`/`.sig` text
  layout (`"Ed"‖keynum8‖pub32` / `"Ed"‖keynum8‖sig64` + trusted comment + global
  signature), with an INDEPENDENT in-fixture verifier (pub/sig parse, keynum match,
  artifact signature, trusted-comment global signature). Feed server:
  `GET /latest.json` (Tauri updater manifest shape; `signature` = base64 of the
  whole `.sig` text), `GET /artifacts/<name>` (raw bytes, content-length),
  `GET /github/releases/latest` (`{tag_name, html_url}` — the Rust
  `/api/version` updateCheck leg). Knobs: version/targets, sign-with-wrong-key,
  tamper-artifact.
- `test/e2e-browser/helpers/harness-06/https.ts` + `fixtures/tls/` (+ tests) —
  committed 100-year test CA (`Freshell E2E Test CA (DO NOT TRUST)`), CA-signed
  `localhost` leaf (SAN DNS:localhost + IP:127.0.0.1 + IP:::1, serverAuth EKU), and
  an UNRELATED self-signed leaf; `REGENERATE.md` documents the one-time openssl
  commands (no runtime openssl dependency). Boot helper serves the target-server
  handler over TLS; `fetchWithCa(url, ca?)` pins the fixture CA (absence → system
  default store → rejection) and captures the peer leaf. SPKI sha256 base64 export
  for Chromium's `--ignore-certificate-errors-spn-list` form.

## Scope calls (recorded per dispatch)

1. **SMB on this Linux host:** literal Windows shares (`net use`, a real
   `\\server\share` mount) cannot be exercised here. Delivered: deterministic
   share-tree builders + manifests + the synthetic UNC/file-URL mapping helpers —
   everything the harness supports on Linux. The **native-share mount/read lane is
   host-limited (Windows)**; the checklist's own validation text marks the mount leg
   "on Windows" (all `PW-TAURI-WIN*` consumers are host-limited campaign items).
2. **"Full Kilroy runtime"** = the harness-level fake sidecar (protocol + ledger +
   approval/fail/crash/resume knobs), not the production Kilroy. Distinct from
   HARNESS-03's provider-executable fakes (different filename/API).
3. **"Summary AI"** = fake Gemini HTTP endpoint matching the pinned
   `@ai-sdk/google@3.0.43` wire shape. The frozen legacy server constructs the
   DEFAULT provider (`server/ai-router.ts:52`) with no env/baseURL seam (load-bearing
   audit L3), so the fixture is validated directly (raw HTTP) and through the real
   SDK client; it stands ready for any later server-side base-URL seam.
4. **Editor fixture** is standalone (no `POST /api/files/open` exists anywhere yet —
   FILE-04's to build; grep-verified zero matches in `server/` + `crates/`).
5. **Signature wire conventions** follow tauri v2 updater exactly (manifest
   `signature` = base64 of the entire `.sig` TEXT; conf `pubkey` = base64 of the
   `.pub` TEXT; both minisign layouts). Native `tauri signer` / real
   `tauri-plugin-updater` consumption is host-limited to the UPDATE-* (`PW-TAURI-WIN*`)
   lanes; the in-fixture independent verifier reproduces full minisign verification,
   so wire-format regressions are caught here.

## Playwright self-verify (posture: harness variant)

Spec: `test/e2e-browser/specs/harness-06-misc-fixtures.spec.ts`, registered in
`MATRIX_SPECS` (one additive regex line; gatekeepers union). It requests ONLY
Playwright base fixtures — the shared harness's worker-lazy `testServer` never
boots (load-bearing audit L1) — so it runs identically under `chromium`,
`legacy-chromium`, and `rust-chromium` and boots NO Freshell server.

Per-leg observed outcomes (each named `test(...)` is one acceptance leg; each
leg below ran green on all three projects in BOTH consecutive verification
runs):

- `target server: real-browser marker page + echo ledger records exact upstream
  inputs` — **green**: `#fixture-marker` visible with `data-fixture="harness-06"`;
  page-context POST `/echo?b=2&a=1&b=3` round-trips the raw query and
  `echo-body-ünïcodé` body byte-exact; ledger carries the custom header; ordered
  `/stream` chunks.
- `target server: hot-reload bump flips the rendered build marker` — **green**:
  `build 1` → `sseClientCount()==1` gate → `bumpBuild()` → DOM flips to `build 2`
  with no manual reload.
- `target server: ws echo round-trips text+binary in the real browser` — **green**:
  `/ws-page?subprotocol=freshell.test` opens (`open:freshell.test`), text
  `hello-e2e ünï` and binary `00 01 FE FF` echo into the DOM; server ledger shows
  the negotiated subprotocol, the verbatim cookie, and both frames (isBinary flag +
  base64 payloads).
- `target server: stop -> page load FAILS -> restart on SAME port -> reload
  succeeds` — **green** (see review-fix note below on the chrome-error race).
- `file trees: manifests hash-match on disk; UNC/file-URL mappings round-trip` —
  **green**: every manifest entry's sha256/size equals the bytes on disk for the
  local tree and BOTH shares; `share`/`share-evil` prefix pair is sibling-rooted
  with differing manifests; UNC + file-URL split round-trips with spaces/Unicode.
- `fake editor: invocation ledger records exact argv/cwd, knobs control exit` —
  **green**: `+12:5 <unicode path with spaces>` invocation recorded verbatim with
  cwd/pid; `FAKE_EDITOR_EXIT_CODE=42` rejects and still records.
- `fake Gemini: fixed output via the raw generateContent shape + request ledger` —
  **green**: `POST {geminiBaseUrl}/models/gemini-2.5-flash:generateContent` with
  `x-goog-api-key` returns `fixture AI output: stable summary` at the exact
  `candidates[0].content.parts[0].text` path; ledger records model/api-key/prompt.
- `fake Kilroy runtime: create handshake + full success turn + request ledger` —
  **green**: created-first handshake, durable-UUID `cliSessionId`, full
  running→assistant→result(success)→turn.complete→idle turn; ledger = [create, send].
- `update feed: manifest + harmless signed artifact downloads and verifies; tamper
  rejects` — **green**: Tauri manifest shape, artifact bytes content-length-exact,
  independent minisign verification TRUE; tampered-artifact feed verifies FALSE.
- `https: committed test certificate verified (trusted-with-CA green,
  no-CA/untrusted red)` — **green**: pinned-CA GET returns 200 + marker; no-CA
  rejects; unrelated self-signed rejects even with the CA pinned; SPKI pin format
  asserted.

## Green command log

All run from `/home/dan/code/freshell/.worktrees/df1-harness-06-misc-fixtures` at
the final SHA; pw runs held the shared pw lease
(`acquire.sh pw df1-harness-06-misc-fixtures`).

1. Helper unit tests (all seven families), scoped coordinated vitest:
   `npm run test:vitest -- run --config test/e2e-browser/vitest.config.ts helpers/harness-06`
   → **exit 0, 7 files / 54 tests green** (target-server 12, file-trees 7,
   fake-editor 6, fake-ai 7, kilroy-runtime 8, update-feed 9, https 5).
   Also green on the final head after the `sseClientCount` accessor landed (same
   command, exit 0, 54/54).
2. Playwright smoke, all three projects, consecutive green #1:
   `npx playwright test --config test/e2e-browser/playwright.config.ts harness-06-misc-fixtures.spec.ts --project=chromium --project=legacy-chromium --project=rust-chromium --reporter=line`
   → **exit 0, 30 passed (17.1s)**.
3. Same command, consecutive green #2 → **exit 0, 30 passed (16.2s)**.

Run history (honest tail): the FIRST pw run of the spec failed 3/30 (the
restart leg on every project; chrome-error race — see review-fix ledger), then
the two runs above passed back-to-back after the fix. The FIRST helper run of
the task-6 drafts failed 1/14 (Node-22 null-prototype `getPeerCertificate()`
hang — same ledger), then green twice.


## Review-fix ledger

Review loop (contract ≤5 rounds): the Task tool is unavailable in this resume
environment, so the prescribed fallback was used — a structured fresh-eyes
self-review of the complete branch diff (`git merge-base HEAD origin/df1/integration`
= `4edd8d10e` → final head; all six commits + uncommitted spec/config/evidence)
under the review-agent skill (defect-first, P0-P3). Findings were the two real
defects below (both observed RED during execution, then fixed); no further
qualifying findings. Recorded in the item's `decisions` log as well.

- **https helper unit test (draft defect found on resume):** Node 22's
  `getPeerCertificate().subject` is a `[Object: null prototype]` map, so
  `String(subject)` throws `TypeError: Cannot convert object to primitive value`
  INSIDE the `secureConnect` listener — the promise never settled and the test
  timed out at 60 s (observed RED: exit 1, `https.test.ts 4 passed / 1 failed`,
  plus 1 unhandled TypeError). Fixed by defensive CN extraction; re-run green.
- **pw restart leg:** the expected-failure `page.goto` (server down) makes Chromium
  navigate asynchronously to `chrome-error://chromewebdata/` AFTER the goto rejects;
  that late navigation raced and interrupted the post-restart goto
  (`Navigation ... is interrupted by another navigation to chrome-error://...`,
  3/30 failed on all three projects). Fix: `waitForURL(/chrome-error/)` settle gate
  between the legs. Mutation-proven: the failure mode was OBSERVED in run 1, then
  eliminated by the fix.

## Host-limited lanes (explicit, unchanged from plan)

- Native Windows SMB mount/read (`net use`, real `\\server\share` traversal) —
  Windows-only; Linux scope delivered above.
- Native `tauri signer` + real `tauri-plugin-updater` and native Chromium trust-store
  mutation — UPDATE-01/02 / TAURI-14 (`PW-TAURI-WIN*`) lanes. Here the wire formats
  (minisign texts, SPKI pin, cert chain) are fixture-verified.
