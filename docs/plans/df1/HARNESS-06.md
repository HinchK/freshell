# HARNESS-06 — Deterministic proxy/file/SMB/editor/AI-Kilroy/update/HTTPS fixtures

**Item (verbatim):** *Add deterministic proxy, file, SMB, editor, AI/Kilroy, update, and HTTPS fixtures. Include HTTP, WebSocket, hot-reload, local/Windows-share trees, fake editor, summary AI, full Kilroy runtime, signed update feed, and trusted HTTPS.*

**Playwright validation text (checklist):** *A fixture smoke reaches every target directly, mounts/reads the disposable SMB share on Windows, records editor/Kilroy invocations, returns fixed AI output, downloads a harmless signed artifact, and verifies the test certificate.*

**Playwright posture (dispatch):** self-verify (harness variant) — ≥1 spec registered in `MATRIX_SPECS` exercising the headline fixtures, green ≥2 consecutive runs per project; server-kind-specific legs run on the rust project. Registration = one additive line (control README anti-conflict rule; gatekeepers union).

## Scope calls (recorded per dispatch)

1. **SMB on this Linux host:** the box cannot exercise literal Windows SMB shares
   (`net use`, a real `\\server\share` mount). Delivered: the disposable **share-tree
   fixture builder** (deterministic content + manifest + hashes, spaces/Unicode names,
   similarly-prefixed neighbor share for the FILE-02 prefix-confusion case) plus the
   **synthetic share-path mapping helpers** (`\\server\share\rel` UNC and
   `file://server/share/rel` URL forms, exactly-once decoding semantics) — everything the
   harness supports on Linux. The **native-share mount/read lane is host-limited
   (Windows)** and noted as such in the evidence file; the checklist's own validation
   text marks it "on Windows" (all `PW-TAURI-WIN` consumers: FILE-02 are host-limited
   campaign items).
2. **"Full Kilroy runtime"** = the **harness-level fake/runtime** the e2e suite needs
   (a standalone sidecar process speaking the exact newline-JSON protocol of
   `crates/freshell-claude-sidecar/index.mjs`, with a request ledger and controllable
   approval/question/completion/crash/resume events), **not** the production Kilroy.
   It is distinct from HARNESS-03's provider-executable fakes (different fixture
   filename, different API: full runtime driver vs. CLI-arg recorder).
3. **"Summary AI"** = a fake **Gemini `generateContent` HTTP endpoint** (the exact
   shape `@ai-sdk/google@3.0.43` — the pinned prod dependency — calls/validates).
   Verified: the SDK only redirects via `createGoogleGenerativeAI({ baseURL })`; the
   frozen legacy server constructs the default provider (`server/ai-router.ts:52`,
   `google(promptConfig.model)`), so no env var can point the legacy server at the
   fixture. The fixture is therefore validated **directly** (raw HTTP) **and** through
   the real SDK client (vitest), and stands ready for any server-side base-URL seam a
   later item adds.
4. **Editor fixture:** `POST /api/files/open` does not exist anywhere yet (FILE-04
   owns the implementation; grep-verified zero matches in `server/` and `crates/`).
   The fake editor is a standalone executable fixture recording exact argv/cwd/env to a
   JSONL ledger (POSIX `sh` + Windows `.cmd` wrappers generated into a temp dir), with
   controllable exit code / delay / crash so FILE-04's "simulate spawn failure" leg can
   drive it.

## Parity sources

- Frozen legacy `server/` on `origin/df1/integration` (`server/ai-prompts.ts`,
  `server/ai-router.ts` summary prompt + Gemini call; no file-open route exists).
- Rust port: `crates/freshell-claude-sidecar/index.mjs` (protocol doc comment, lines
  1-34: in/out message shapes), `crates/freshell-freshagent/src/claude.rs`
  (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE` env seams, `read_created` 45 s
  budget, kilroy = claude flavour), `crates/freshell-tauri/src/updater.rs` +
  `tauri.conf.json` (`plugins.updater`: endpoint `https://releases.freshell.app/latest.json`,
  manifest `{version, notes, pub_date, platforms{<triple>:{signature,url}}}`),
  `crates/freshell-server/src/updater.rs` (legacy GitHub `releases/latest` shape:
  `{tag_name, html_url}`).
- Installed dependency contracts: `@ai-sdk/google@3.0.43`
  (`POST {baseURL}/models/{m}:generateContent` JSON; `:streamGenerateContent?alt=sse`
  SSE; response Zod schema `candidates[0].content.parts[].text`, header
  `x-goog-api-key`), `ws@8.18`, `node:crypto` Ed25519 (+ JWK raw-key export).
- Tauri v2 updater wire format (docs): manifest `signature` = **base64 of the entire
  `.sig` file text**; `pubkey` config = **base64 of the `.pub` file text**; both are
  minisign layouts (`"Ed"||keynum8||sig64` / `"Ed"||keynum8||pub32`).

## Load-bearing audit ledger

| # | Assumption | Method | Verdict |
|---|------------|--------|---------|
| L1 | A spec registered in `MATRIX_SPECS` that uses only `@playwright/test` base boots NO Freshell server (fixtures are lazy per-use) | inspect `helpers/fixtures.ts` (worker-scoped `testServer` instantiated only when requested) | ✅ verified |
| L2 | Gemini fake shape matches what the prod dependency validates | inspect installed `@ai-sdk/google@3.0.43` dist (URL paths, request headers, response/chunk Zod schemas) | ✅ verified |
| L3 | Legacy server CANNOT be redirected to the fake via env (baseURL is options-only) | inspect SDK `createGoogleGenerativeAI` (default constant, no env read) + `server/ai-prompts.ts` | ✅ verified → drive fixture directly |
| L4 | Tauri `latest.json` shape | inspect `crates/freshell-tauri/src/updater.rs` (`LatestManifest`, `PlatformEntry`) + `tauri.conf.json` | ✅ verified |
| L5 | `.sig`/`.pub` minisign text-base64 wrapping (manifest `signature` + conf `pubkey`) | tauri v2 updater docs (documented decodes: `dW50cnVzdGVk…` → "untrusted comment: …"); cross-checked by an **independent in-fixture verifier** (full minisign check incl. trusted-comment global signature) | ✅ verified-by-construction; native `tauri signer` consumption = host-limited UPDATE lanes (noted in evidence) |
| L6 | Sidecar protocol (msg/event shapes, `created`-first, 45 s budget, turn.complete only on `result subtype==='success'`, waiting edge) | inspect sidecar doc comment + `fake-claude-sidecar.mjs` + `claude.rs` | ✅ verified |
| L7 | Keynum only needs self-consistency between my `.pub`/`.sig` (no BLAKE2b-64 in node:crypto) | rust-minisign/tauri verify compares embedded keynums pub↔sig; signer emits one consistent keynum | ✅ verified (design choice: random-per-keypair keynum) |
| L8 | TLS: committed long-expiry test CA + leaf (no runtime openssl dependency) | openssl 3.0.13 on host for ONE-TIME generation; assets committed under `fixtures/tls/` with DO-NOT-TRUST naming | ✅ viable; decision recorded |
| L9 | Helper unit tests runner | `npm run test:e2e:helpers` = vitest config include `helpers/**/*.test.ts` | ✅ verified |
| L10 | No `ws` upgrade conflicts: single http server + `WebSocketServer({noServer})` path-filtered | standard `ws@8.18` pattern; dependency present | ✅ verified |
| L11 | Sibling-conflict surface | my diff touches only NEW item-scoped files + ONE additive `MATRIX_SPECS` line | ✅ by construction |

Residual risk (documented, accepted): L5's native `tauri signer`/real
`tauri-plugin-updater` end-to-end consumption happens only in host-limited
UPDATE-01/02 (`PW-TAURI-WIN*`) lanes; my fixture's independent verifier reproduces the
full minisign verification (main signature over artifact + global signature over
`sig‖trusted-comment`, keynum match), so wire-format regressions are caught here.

## Architecture — all new, item-scoped files

```
test/e2e-browser/helpers/harness-06/
  target-server.ts   # HTTP + WS echo + hot-reload fixture (one owned process)
  file-trees.ts      # local file tree + synthetic SMB share trees + UNC/URL mapping
  fake-editor.ts     # wrapper generator + ledger reader for fixtures/fake-editor.mjs
  fake-ai.ts         # fake Gemini generateContent/streamGenerateContent server
  kilroy-runtime.ts  # stdio driver for fixtures/fake-kilroy-runtime.mjs + ledger
  update-feed.ts     # ed25519 keypair, minisign sign/verify, latest.json feed server
  https.ts           # TLS asset loader + https target boot + trust verification
  *.test.ts          # vitest unit tests per module
test/e2e-browser/fixtures/
  fake-editor.mjs            # the fake editor executable payload
  fake-kilroy-runtime.mjs    # the fake kilroy sidecar process
  tls/                       # committed test CA + leaf certs (DO NOT TRUST) + regen notes
test/e2e-browser/specs/harness-06-misc-fixtures.spec.ts   # the fixture smoke
test/e2e-browser/playwright.config.ts                     # +1 MATRIX_SPECS line
```

### Fixture contracts (Interfaces blocks for later tasks' consumers)

**target-server.ts** — one Node process, ephemeral port (`127.0.0.1:0`), optional TLS.
- `startTargetServer(opts?: { port?: number; tls?: TlsKeyPair }): Promise<TargetServer>`
- `TargetServer`: `{ port, baseUrl, wsUrl, stop(), ledger(): readonly TargetLedgerEntry[], clearLedger(), bumpBuild(): number, build(): number, sseClientCount(): number, closeWebSockets(code?: number, reason?: string) }` (`sseClientCount` added in task 7 — deterministic "EventSource connected" gate before bumping in browser legs.)
- HTTP surfaces:
  - `GET /page` — marker page: `<div id="fixture-marker" data-fixture="harness-06">`; query `csp=<policy>`, `xfo=deny|sameorigin`, `title=<t>`. (The build index lives on `/hot`'s `#build-marker`.)
  - `ALL /echo` — records `{method,path,query,headers,bodyBase64}`; responds the same as JSON (exact upstream inputs).
  - `GET /stream?chunks=N&delayMs=D` — N sequential `chunk-i/N` lines, `Transfer-Encoding: chunked`.
  - `GET /hot` — page with `#build-marker` + EventSource(`/hot/stream`) that reloads on a bump event; `POST /__admin/bump` increments the build deterministically.
  - `GET /ws-page?subprotocol=<p>` — page whose JS opens `/ws-echo` and appends each received frame as a DOM node under `#ws-log` (binary as base64), echo replies verbatim.
  - `GET /__admin/ledger` — JSON dump (in-page assertion seam).
- WS `/ws-echo`: accepts negotiated subprotocol from a whitelist, records open (query, cookie, subprotocol) + every frame (`kind:'ws-message'`, direction in, payload base64, isBinary); echoes verbatim. `closeWebSockets(code,reason)` force-closes server-side (deterministic mid-stream disconnect).
- Ledger is in-process + queryable; entries carry a monotonically increasing `seq`.

**file-trees.ts**
- `createLocalFileTree(root?): FileTree` — deterministic tree: `index.html`, `image.png` (fixed valid bytes), `ünïcodé fíle.txt`, `binary.bin` (0x00..0xFF ×8 pattern), `large.bin` (5 MiB deterministic LCG pattern), `nested/deep/note.md`, `.hidden/inside.txt`, empty dir. `FileTree = { root, manifest: Record<rel,{sha256,size,mode?}>, cleanup() }`.
- `createShareTrees(root?): ShareTrees` — two sibling roots `share/` and `share evíl/` (prefix-confusion pair), contents with `spaces dir/report final.txt`, `ünïçødé dir/grüße.txt`, manifests; `ShareTrees = { shares, uncPathFor(server, share, rel), fileUrlFor(server, share, rel), fileUrlFromUnc(unc), cleanup() }` — pure string mappers (posix-safe to unit-test): UNC = `"\\"+server+"\"+share+"\"+rel.join("\\")`; file URL = `file://server/share/` + percent-encoded rel path segments; decoding is exactly-once.

**fake-editor** — `fixtures/fake-editor.mjs` appends `{pid,t,argv,cwd,env:{FAKE_EDITOR_*}}` JSONL to `FAKE_EDITOR_LOG`, then: `--fixture-crash` → `process.abort()`; `FAKE_EDITOR_SLEEP_MS` delay; exit `FAKE_EDITOR_EXIT_CODE` (default 0). Helper:
- `createFakeEditor(dir?): Promise<FakeEditor>` — writes `fake-editor` (sh, mode 755) + `fake-editor.cmd` into a temp dir; `FakeEditor = { editorPath, cmdPath, logPath, readInvocations(): Promise<EditorInvocation[]>, cleanup() }`.

**fake-ai.ts** — `startFakeGemini(opts?): Promise<FakeGemini>`:
- `POST /v1beta/models/:model:generateContent` → fixed text (default `fixture AI output: stable summary`), per-model/prompt-substring response table, error modes (`429`, `500`, `promptFeedback.blockReason`), request ledger `{seq,model,action,apiKeyPresent,promptText,at}`.
- `POST ...:streamGenerateContent?alt=sse` → deterministic 2-chunk SSE + terminal usage chunk.
- `FakeGemini = { port, baseUrl, stop(), setResponse(s), clearResponses(), ledger(), clearLedger() }`.

**kilroy-runtime** — `fixtures/fake-kilroy-runtime.mjs` speaks the documented protocol with kilroy flavour (model default `claude-opus-4-6`, `featureFlag` semantics left to the server). Env knobs: `FAKE_KILROY_LOG` (JSONL req ledger — "records Kilroy invocations"), `FAKE_KILROY_HOLD_TURN`, `FAKE_KILROY_FAIL_RESULT` (result subtype error, NO turn.complete), `FAKE_KILROY_APPROVAL` (send → `sdk.turn.waiting{at}` → assistant+result+complete after `FAKE_KILROY_APPROVAL_DELAY_MS`), `FAKE_KILROY_CRASH_ON_SEND` (exit 3 mid-turn), `FAKE_KILROY_CLI_SESSION_ID`. Resume (`resumeSessionId`) keeps the cliSessionId + emits `sdk.session.snapshot`. Helper:
- `spawnFakeKilroy(env?): Promise<KilroyRuntime>` — `{ proc, send(msg), nextEvent(type, pred?, timeoutMs), events(), ledger(), kill() }`.

**update-feed.ts**
- `generateUpdateKeypair(): UpdateKeypair` — ed25519 via node:crypto (+JWK raw export); `{ keypair, keynum(8B), pubFileText, tauriPubkeyConfig(base64(pubFileText)) }`.
- `minisignSign(kp, data, {fileName?, comment?}): string` (sig file text: untrusted line + `b64("Ed"‖keynum‖sig64)` + `trusted comment: timestamp:<unix>\tfile:<name>` line + `b64(globalsig64‖keynum)`; globalsig = sign(sk, sig‖trustedCommentText)).
- `minisignVerify(tauriPubkeyConfig, sigFileText, data): boolean` — independent verifier (parse .pub text → raw pub32+keynum; parse .sig → keynum match + Ed25519 verify artifact + verify trusted-comment global signature).
- `startUpdateFeed(opts): Promise<UpdateFeed>` — `GET /latest.json` (Tauri manifest; `platforms` from opts, `signature`=base64(sig(text))), `GET /artifacts/:name` (raw bytes, octet-stream, content-length), `GET /github/releases/latest` (`{tag_name:"v"+version, html_url}` — Rust `/api/version` updateCheck shape leg). Knobs: `signWith: otherKeypair`, `tamperArtifact: true`, older/equal/wrong-platform versions. `UpdateFeed = { port, baseUrl, manifestUrl, artifactName, artifactBytes, keypair, stop() }`.

**https.ts + fixtures/tls/`** — committed assets (generated once, `REGENERATE.md` documents the openssl commands): `ca.key/cert.pem` (CN "Freshell E2E Test CA (DO NOT TRUST)", 100 y), `localhost.key/cert.pem` (CA-signed; SAN DNS:localhost, IP:127.0.0.1, IP:::1), `untrusted.key/cert.pem` (self-signed, unrelated).
- `loadTestTlsAssets(): TlsAssets` — `{ caCert, server:{key,cert}, untrusted:{key,cert}, serverSpkiSha256B64 }`.
- `startHttpsTarget(kind:'trusted'|'untrusted', opts?)` — target-server handler over `https`.
- `fetchWithCa(url, ca?): Promise<{status, body}>` — Node-level trust probe.

## TDD task breakdown (commit each boundary)

1. **Task 1 — plan + audit commit** (this file).
2. **Task 2 — `target-server`** (HTTP+WS+hot-reload): RED vitest (marker page, csp/xfo headers, echo byte-exact, stream chunk ordering, ws echo text+binary+subprotocol+cookie ledger, bump→SSE→reload signal, restart same port), implement, green, commit.
3. **Task 3 — `file-trees`**: RED (manifest sha256/size of every file, unicode names, neighbor-prefix isolation, UNC/file-URL encode/decode round trips), implement, green, commit.
4. **Task 4 — `fake-editor` + `fake-ai`**: RED editor (argv variants `+12:5 file`, `--goto file:12:5`, spaces/Unicode path; exit-code knob; ledger), RED ai (fixed output, error mode, stream chunks, ledger, and the real-SDK `createGoogleGenerativeAI({baseURL})` + `generateText` round trip), implement, green, commit.
5. **Task 5 — `kilroy-runtime`**: RED (create handshake order created→init→idle; send turn sequence running→assistant→result(success)→turn.complete→idle; approval knob inserts waiting before completion; fail knob → result error & NO turn.complete; crash knob → exit 3, no complete; resume keeps cliSessionId + snapshot; ledger lines), implement, green, commit.
6. **Task 6 — `update-feed` + `https`**: RED (manifest shape vs `LatestManifest` decoder expectations; artifact download bytes; sign→verify round trip incl. trusted-comment global; tamper→false; wrong key→false; github-shape leg; TLS trusted/no-CA/untrusted matrix + SPKI hash), implement, generate+commit TLS assets, green, commit.
7. **Task 7 — Playwright smoke + registration**: spec drives every family directly (+ page-rendered marker through the real browser incl. ws-page DOM and hot-reload DOM flip; stop→goto-fails→start-same-port→reload-succeeds); register one line in `MATRIX_SPECS`; pw-lease runs `--project=legacy-chromium` + `--project=rust-chromium` (+ default `chromium`) ≥2 consecutive green each; commit.
8. **Task 8 — evidence + wrap**: `docs/plans/df1-evidence/HARNESS-06.md` (per-family proof, scope calls, host-limited note, green command log); review loop ≤5 rounds; commit.

## Non-goals

- No server-side integration seams (that is BROWSER-*/FILE-*/SESSION-04/UPDATE-* work).
- No real SMB server/mount anywhere; no Windows-only implementation files.
- No changes to existing fake provider fixtures (HARNESS-03's domain) or shared helpers
  (`fixtures.ts`, `test-server.ts`, …).
- No edits to the checklist.

## Acceptance evidence (definition of done)

- Every fixture family reached directly by the smoke spec; editor + kilroy invocations
  recorded to ledgers and asserted exact; fake AI returns the fixed output (raw HTTP +
  real-SDK leg); update feed downloads a harmless signed artifact and verifies it (plus
  negative tamper/wrong-key legs); test certificate verified (trusted-with-CA green,
  untrusted/no-CA red, CN/SAN asserted).
- Smoke green ≥2 consecutive runs on `legacy-chromium` and `rust-chromium` (pw lease),
  per dispatch self-verify posture.
- Helper vitest green scoped to `helpers/harness-06/**/*.test.ts`.
- Scope calls + host-limited native SMB lane recorded in the evidence file.
