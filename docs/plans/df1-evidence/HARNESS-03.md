# HARNESS-03 — Add deterministic provider fixtures — df1 evidence

**Branch:** `df1/harness-03-provider-fixtures` (base `origin/df1/integration` @ `4edd8d10e`) · **Date:** 2026-08-09 · **Playwright posture:** `self-verify` (harness variant — the deliverable IS harness capability)

IMPLEMENTED (2026-08-09, df1 worker `df1-harness-03-provider-fixtures`).

Checklist text: *"Provide fake Claude, Kilroy/Claude-SDK, Codex app-server, OpenCode server,
Amplifier, Gemini, and Kimi executables that record arguments/environment and emit controllable
session, activity, approval, question, completion, crash, and resume events"* with Playwright
validation *"A fixture-only contract spec invokes each executable/protocol directly, sends
scripted commands, and asserts its ledger/events without requiring Rust provider parity."*

## What landed

New item-scoped tree `test/e2e-browser/fixtures/providers/` (the ten existing flat fakes are
untouched; six sibling HARNESS workers run concurrently and share those):

- **`fixture-core.mjs`** — the shared engine every fake runs on:
  - *Launch ledger* (`FRESHELL_FAKE_LEDGER`, JSONL): one row per process launch with
    `{t, pid, provider, argv, cwd, env}` — the "record arguments" half. The `env` block is
    strictly allowlisted (`FRESHELL_FAKE_*` control keys + names explicitly listed in
    `FRESHELL_FAKE_ENV_RECORD`) so a fixture can never exfiltrate `ANTHROPIC_API_KEY`-class
    secrets into test artifacts (negative control tested).
  - *Event ledger* (`FRESHELL_FAKE_EVENTS`, JSONL): one normalized
    `{t, pid, provider, kind, data, trigger}` row per emitted event, regardless of wire
    encoding — the uniform assertion surface across all seven providers.
  - *Program engine* (`FRESHELL_FAKE_PROGRAM` inline / `FRESHELL_FAKE_PROGRAM_FILE` path): an
    ordered rule list `{ on, match?, once?, emit:[{kind, data?, delayMs?}] }` with trigger
    grammar `start | stdin:<regex> | msg:<type> | rpc:<method> | http:<METHOD> <path-regex>`
    and deep-subset `match` — the "controllable" half. `crash` records, then exits through an
    injected seam (code from `data.code`, default 1).
  - 24 unit tests (`test/e2e-browser/helpers/provider-fixture-core.test.ts`, sanctioned
    `npm run test:e2e:helpers` infra-test path).
- **Seven provider executables**, parity-sourced from the in-tree consumers:
  - `fake-claude.mjs`, `fake-gemini.mjs`, `fake-kimi.mjs` (PTY CLIs; `--session-id` /
    `--resume` argv shapes per `fake-claude-cli.mjs`; bare-BEL completion chunks per
    `fake-bel-cli.mjs`/`shared/turn-complete-signal.ts`) and `fake-amplifier.mjs`
    (`session resume --full-history <id>` id-last shape per `fake-amplifier-cli.mjs`) — all
    thin wrappers over `terminal-cli.mjs`.
  - `fake-claude-sdk-sidecar.mjs` — the Kilroy/Claude-SDK entry (ONE protocol family;
    `FRESHELL_FAKE_PROVIDER` selects the kilroy/freshclaude flavour). Newline-JSON bridge of
    `crates/freshell-claude-sidecar/index.mjs`: `created` FIRST, canonical-UUID `cliSessionId`,
    `sdk.assistant` content-ARRAY, numeric-`at` `sdk.turn.complete`, `sdk.permission.request` /
    `sdk.question.request` in the `server/sdk-bridge-types.ts` shapes with a
    0→≥1-pending `sdk.turn.waiting` edge, resume via `create.resumeSessionId` +
    `sdk.session.snapshot`, `interrupt`, `shutdown` (exit 0).
  - `fake-codex-app-server.mjs` — WS JSON-RPC `--listen ws://…`: initialize gating (exact
    real error message), `thread/start` writing a real rollout file whose first line is the
    `session_meta` record, `thread/resume` identity preservation, `turn/started`/
    `turn/completed{status:'completed'}` notifications. Approvals/questions render as
    `freshell.fixture/*` notifications because freshcodex advertises
    `approvals:false, questions:false` (codex.rs:3089) — no real bridge exists to mirror.
  - `fake-opencode-server.mjs` — HTTP REST + SSE `/event`: flat `{type, properties}` frames
    per `serve-events.ts`, `server.connected`, `session.status{busy|idle}`, `session.idle`,
    `permission.asked`/`question.asked`, `POST /session`, `GET /session/:id` = the
    durable-resume probe (200 vs 404 per `opencode_ws.rs`), crash drops the listener.
- **`test/e2e-browser/helpers/provider-fixture-launcher.ts`** — typed spawn/read/wait/stop
  helper. HOME is ALWAYS a per-launch isolated dir (fixture side effects hermetic by default);
  `scrub:true` additionally runs with `PATH=/nonexistent` and zero inherited env.
- **`test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts`** (19 tests) — the
  fixture-only contract spec: per provider it drives the real protocol surface with scripted
  commands and asserts (a) ledger argv/cwd/pid + allowlisted env probe, (b) exact scripted
  event sequence `session → activity → approval → question → completion` on the normalized
  ledger, (c) wire realism (BEL; `sdk.turn.complete` numeric `at`; `turn/completed`; SSE
  `session.idle`), (d) crash = scripted exit code with the crash event recorded first,
  (e) resume events from each provider's real resume argv shape. Hermeticity suite: the full
  contract re-passed under `PATH=/nonexistent` with ZERO child processes for every fixture
  (proves no real claude/codex/opencode binary can be consulted) + the no-secret-leakage
  negative control.
- Registered in `MATRIX_SPECS` (`playwright.config.ts`) — the ONLY shared-file edit, one
  additive regex line per the df1-control README convention.

## Green evidence (this branch)

- `npm run test:e2e:helpers -- provider-fixture-core` → 24/24 passed.
- `npx playwright test --config test/e2e-browser/playwright.config.ts specs/harness-03-provider-fixtures.spec.ts --project=chromium --project=legacy-chromium --project=rust-chromium`
  → **57 passed, twice consecutively** (19 tests × 3 projects, ~30s each; pw lease per run).
- Both matrix legs deliberately run identical assertions: the spec uses bare `@playwright/test`
  (no `testServer`, no `page`), so no server (legacy or Rust) boots — the fixture contract is
  server-kind-independent by construction, which is exactly the checklist's "without requiring
  Rust provider parity".

## Review loop

No Task/subagent tool exists in this worker environment, so the mandated fresh review subagent
was replaced by the dispatch's sanctioned fallback: structured fresh-eyes full-diff review with
the review-agent checklist (findings ordered, demonstrable-from-code, introduced-by-this-change).
Three rounds:

- **Round 1 (3 findings, fixed):** HTTP-driven ledger rows recorded the misleading trigger
  `argv` (now truthful per-call-site labels); opencode `POST /session` ignored the
  default-suppression convention (now skips the canned `session` when a rule covered it);
  dead `lines` var / unused `render` param removed.
- **Round 2 (1 finding, fixed):** dead `path` import in the spec.
- **Round 3 (1 realism note, fixed):** `sdk.turn.complete` documents its `subtype` field as a
  fixture EXTENSION (the real protocol is `{sessionId, at}` only).
- Gates re-run after every round; final full run green at the
  review-clean tip.

## Decisions / notes for later items (TERM-*/AGENT-*)

- Rule semantics: a matching rule OWNS the response shape; canned defaults fire only when no
  rule matched (except protocol bookkeeping — sdk.status running / turn/started /
  session.status busy — which is unconditional, mirroring the real bridges).
- The opencode fixture keeps sessions in memory (HTTP/SSE surface is its contract); the
  legacy `fake-opencode.cjs` remains the sqlite-DB realism fixture.
- Kilroy and freshclaude share one sidecar executable (they ARE one wire protocol); the label
  is selected with `FRESHELL_FAKE_PROVIDER`.
- Load-bearing audit ledger lives in `docs/plans/df1/HARNESS-03.md` (all assumptions verified
  by run or by in-tree read).
