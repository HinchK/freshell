# HARNESS-03 Implementation Plan — Deterministic provider fixtures

> df1 wave-0 worker `df1-harness-03-provider-fixtures`. Base `origin/df1/integration` @ `4edd8d10e`.
> Checklist item (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, HARNESS-03):
> **Provide fake Claude, Kilroy/Claude-SDK, Codex app-server, OpenCode server, Amplifier, Gemini,
> and Kimi executables that record arguments/environment and emit controllable session, activity,
> approval, question, completion, crash, and resume events.**
> Playwright validation (checklist verbatim): *"A fixture-only contract spec invokes each
> executable/protocol directly, sends scripted commands, and asserts its ledger/events without
> requiring Rust provider parity."*

## Parity sources (what the fakes must faithfully mirror)

| Provider fake | Wire surface | In-tree authority for the shape |
|---|---|---|
| Claude (terminal CLI) | PTY CLI: argv flags, stdout markers, BEL | `test/e2e-browser/fixtures/fake-claude-cli.mjs`, `shared/turn-complete-signal.ts`, launch shapes in `extensions/claude-code/freshell.json` |
| Kilroy/Claude-SDK (sidecar) | newline-JSON stdio bridge | `test/e2e-browser/fixtures/fake-claude-sidecar.mjs` (documents `claude.rs:551` created-first rule, `at`-numeric turn.complete, content-array assistant, canonical-UUID cliSessionId); renames map `claude.rs:1284-1289` |
| Codex app-server | WS JSON-RPC `--listen ws://…` | `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (initialize-gating, thread/start, thread/resume, turn/start, turn/started, turn/completed, rollout `session_meta`) |
| OpenCode server | HTTP REST + SSE `/event` | `test/e2e-browser/fixtures/fake-opencode.cjs` (`serve --port/--hostname`, `session.status` busy/idle, `session.idle`, `server.connected`), parser contract `server/fresh-agent/adapters/opencode/serve-events.ts` (flat `{type, properties}` frames) |
| Amplifier (terminal CLI) | PTY CLI, `session resume --full-history <id>` | `test/e2e-browser/fixtures/fake-amplifier-cli.mjs` |
| Gemini (terminal CLI) | PTY CLI, bare launch | `extensions/gemini/freshell.json` (`GEMINI_CMD`, no resumeArgs) |
| Kimi (terminal CLI) | PTY CLI, bare launch | `extensions/kimi/freshell.json` (`KIMI_CMD`, no resumeArgs) |

## Design

New item-scoped tree `test/e2e-browser/fixtures/providers/` — no edits to the ten existing
flat fakes (six sibling workers may touch their callers; zero shared-fixture churn for us).

Every fixture is a **hermetic Node ESM script** (spawned as `node <fixture>`; never resolves
or spawns a real provider binary, never hits the network except its own loopback listener).
All seven share one engine:

**`fixture-core.mjs`** — ledger + scriptable event engine.
- Launch ledger: env `FRESHELL_FAKE_LEDGER` → JSONL `{ t, pid, provider, argv, cwd, env }`
  where `env` contains ONLY allowlisted keys: everything matching `^FRESHELL_FAKE_` plus the
  comma-separated names in `FRESHELL_FAKE_ENV_RECORD` (names, then values). Secrets can never
  leak because nothing is recorded unless explicitly requested.
- Event ledger: env `FRESHELL_FAKE_EVENTS` → JSONL `{ t, pid, provider, kind, data, trigger }`
  for every emitted event, regardless of wire encoding — this is what the contract spec
  asserts uniformly across all seven providers.
- Program (the "controllable" surface): JSON from `FRESHELL_FAKE_PROGRAM` (inline) or
  `FRESHELL_FAKE_PROGRAM_FILE` (path):
  ```jsonc
  {
    "sessionId": "fixed-uuid-otherwise-random",
    "rules": [
      { "on": "start", "emit": [ { "kind": "session", "data": {…} } ] },
      { "on": "stdin:^do work$", "match": { }, "once": false,
        "emit": [
          { "kind": "activity",  "data": { "state": "busy" } },
          { "kind": "approval",  "data": { "id": "ap-1", "tool": "Bash", "input": "rm -rf /tmp/x" } },
          { "kind": "question",  "data": { "id": "q-1", "text": "which file?" } },
          { "kind": "completion", "delayMs": 50, "data": { "subtype": "success" } }
        ] },
      { "on": "stdin:explode", "emit": [ { "kind": "crash", "data": { "code": 3 }, "delayMs": 10 } ] }
    ]
  }
  ```
  Trigger names: `start`, `stdin:<regex>`, `msg:<type>` (sidecar), `rpc:<method>` (codex),
  `http:<METHOD> <path-regex>` (opencode). `match` is a shallow-subset predicate on the
  trigger payload (stdin `{line}` / bridge message / rpc params / http body). Every matching
  rule fires unless `once` and previously fired.
- Event kinds (the acceptance enumeration): `session`, `activity`, `approval`, `question`,
  `completion`, `crash`, `resume`. `crash` renders to the ledger then exits with
  `data.code ?? 1` after `delayMs ?? 0`. `resume` is emitted at start when the adapter
  detects the provider's real resume argv shape.
- Helpers: `readStdinJsonLines(cb)`, `keepAlive()`, `mintSessionId()`, `nowIso()`.

**Per-provider executables (thin adapters, each ≤ ~120 LOC):**

| File | Provider label | Start behavior | Emission rendering |
|---|---|---|---|
| `fake-claude.mjs` | `claude` | detects `--session-id <id>` (→ session), `--resume <id>` (→ resume); prints `fake-claude> ` | activity→`working…`, approval→`Do you want to proceed? [y/n]`-style line (real Claude permission-prompt phrasing), question→line, completion→bare BEL `\x07` + `done` (turn-complete-signal semantics) |
| `fake-amplifier.mjs` | `amplifier` | detects `session resume --full-history <id>` (last-arg id) | same terminal rendering, `amplifier:`-prefixed markers |
| `fake-gemini.mjs` | `gemini` | bare launch | same terminal rendering |
| `fake-kimi.mjs` | `kimi` | bare launch | same terminal rendering |
| `fake-claude-sdk-sidecar.mjs` | `kilroy` (default) or `freshclaude` via `FRESHELL_FAKE_PROVIDER` | stdio protocol of `claude.rs`: in `{type:create/send/interrupt/shutdown}`; out `created` FIRST, then `sdk.session.init`, `sdk.status` | activity→`sdk.status running`, approval→`sdk.permission.request`, question→`sdk.question.request`, completion→`sdk.assistant` (content **array**) + `sdk.turn.complete` (numeric `at`, subtype) + `sdk.status idle`; resume (`create.resumeSessionId`)→ reuses id + `sdk.session.snapshot`; `shutdown`→exit 0 |
| `fake-codex-app-server.mjs` | `codex-app-server` | `--listen ws://host:port`; initialize-gated JSON-RPC | session→`thread/start` result + rollout `session_meta` file under `$CODEX_HOME/sessions/…`; activity→`turn/started`; completion→`turn/completed` `{turn:{status:'completed'}}`; approval/question→`freshell.fixture/approval|question` notifications (freshcodex advertises `approvals:false, questions:false`, codex.rs:3089 — no real bridge exists to mirror); resume→`thread/resume` |
| `fake-opencode-server.mjs` | `opencode-server` | `serve --port N [--hostname H]`; in-memory session store (no sqlite dependency) | SSE `/event` flat `{type, properties}` frames: `server.connected` on connect; activity→`session.status {status:{type:'busy'}}`; completion→`session.idle` + `session.status idle`; approval→`permission.asked`; question→`question.asked`; REST: `POST /session`, `GET /session/:id`, `POST /session/:id/message`, `GET /session/status`; crash→close listener + exit |

Terminal-CLI duplication is factored into `terminal-cli.mjs` (`runTerminalCli({provider,
prompt, resumeDetect overrides})`) so the four CLIs are ~15-line wrappers.

## Acceptance evidence (the Definition-of-done bar)

1. **`test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts`** (committed, registered
   in `MATRIX_SPECS` per the df1-control README convention — one additive regex line, the
   only shared-file edit). One `describe` per provider. Each test: spawn the executable
   directly (no Freshell server involved), drive scripted commands over its real protocol
   (stdin lines / newline-JSON / WS JSON-RPC / HTTP+SSE), and assert:
   - the launch ledger line has exact argv, cwd, pid, and the allowlisted env probe;
   - the event ledger contains the scripted kinds in scripted order with their data;
   - the wire output carries the protocol-shaped rendering (BEL for terminal completion,
     `sdk.turn.complete` numeric `at` for sidecar, `turn/completed` for codex,
     `session.idle` SSE for opencode);
   - crash: exit code = scripted code, crash event recorded before exit;
   - resume: the provider's resume argv shape yields a `resume` event + resumed marker.
2. **Hermeticity test:** every fixture spawned with `PATH=/nonexistent` and an isolated
   `HOME` tempdir still satisfies its full contract, and spawns zero child processes
   (proves no real `claude`/`codex`/`opencode` binary can be invoked).
3. Runs **green ≥ 2 consecutive times** under `--project=legacy-chromium` AND
   `--project=rust-chromium` (plus default `chromium`, which picks up every spec automatically).
   Rationale for both legs: the fixtures are server-kind-independent (no `testServer`
   fixture is used), so both legs run the identical assertions — which is itself the proof
   the matrix isn't needed here, kept as a control only because the dispatch asks for both.
4. Helper unit tests: `test/e2e-browser/helpers/provider-fixture-core.test.ts` under the
   sanctioned `npm run test:e2e:helpers` path (program parsing, rule matching incl.
   `match`/`once`, ledger allowlist, resume detection table).
5. Evidence file `docs/plans/df1-evidence/HARNESS-03.md` in the checklist annotation style.

## Task breakdown (TDD)

- **Task 1 — core engine.** Red: `provider-fixture-core.test.ts` (program load/precedence,
  ledger allowlist+record, rule match incl. regex/subset/once, emission ordering + delayMs,
  crash exit semantics via a spawned probe). Green: `fixture-core.mjs`. Refactor.
- **Task 2 — terminal CLI family.** Red: spec section for claude/gemini/kimi/amplifier
  (spawn + stdin script + ledger/wire assertions, incl. amplifier resume shape). Green:
  `terminal-cli.mjs` + four executables.
- **Task 3 — Claude-SDK sidecar (kilroy).** Red: spec section (create→send→interrupt→
  shutdown script; approval/question program; crash program). Green: `fake-claude-sdk-sidecar.mjs`.
- **Task 4 — Codex app-server.** Red: spec section (WS handshake, initialize gating,
  thread/start+rollout, turn/start notifications, thread/resume, crash). Green:
  `fake-codex-app-server.mjs`.
- **Task 5 — OpenCode server.** Red: spec section (SSE connect, POST /session,
  POST …/message, permission/question SSE, GET /session/:id resume probe, crash).
  Green: `fake-opencode-server.mjs`.
- **Task 6 — launcher helper + hermeticity + registration.** `helpers/provider-fixture-launcher.ts`
  (typed spawn/read/waitEvent/stop), PATH/HOME hermeticity test, `MATRIX_SPECS` line.
- **Task 7 — verify + evidence.** Helper vitest run, contract spec ×2 per project leg,
  evidence file, final commit.

## Load-bearing audit ledger (validated in phase 2)

| # | Assumption | Method | Status |
|---|---|---|---|
| A1 | A Playwright spec that uses bare `@playwright/test` (no `testServer`, no `page`) boots no server and no browser; identical under legacy/rust projects | run (probe in execute phase) + fixtures.ts laziness inspection ✓(read) | pending-run |
| A2 | `import { WebSocketServer } from 'ws'` resolves from `test/e2e-browser/fixtures/providers/` when spawned as a plain node child | spawn probe w/ `PATH=/nonexistent` → `WS_OK 41009`, exit 0 | ✅ verified |
| A3 | `npm run build` (playwright/vitest global setup) works in this worktree and the build guard does not trip | run first spec | pending-first-run |
| A4 | pw lease script path/flags | `acquire.sh pw … --wait` granted (1/4) + released | ✅ verified |
| A5 | Sidecar protocol invariants (created-first, numeric `at`, content array, UUID) | read `fake-claude-sidecar.mjs` header | ✅ verified (phase 1) |
| A6 | SSE frame shape consumers expect: `data: {"type":…,"properties":…}\n\n` flat | read `serve-events.ts:61-72` | ✅ verified |
| A7 | Codex wire: initialize gating + thread/start result shape + rollout session_meta | read `fake-app-server.mjs` | ✅ verified |
| A8 | Amplifier resume argv shape `session resume --full-history <id>` (id = last) | read `fake-amplifier-cli.mjs:70-73` | ✅ verified |
| A9 | MATRIX_SPECS additive regex registration is the accepted convention | df1-control README | ✅ verified |
| A10 | No real provider binary needed for hermeticity: fixtures spawned via `process.execPath` with explicit script path | construction | by-construction |
