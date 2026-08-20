# Rust Claude Sidecar SDK 0.3 Upgrade + Model Statics Port Implementation Plan

> **For agentic workers:** REQUIRED: Use the usual-subagents (subagent-driven-development / executing-plans) and the-usual TDD (test-driven-development) subskills to implement this plan task-by-task and subtask-by-subtask. Steps use checkbox (`- [ ]`) syntax for tracking.

## User Request

### Requested result
Fix kata fpxj by upgrading the Rust fresh-agent sidecar (crates/freshell-claude-sidecar) vendored Claude Agent SDK from ^0.2.40 to the 0.3 track, and in that same upgrade port the fresh-agent model statics change (value opus[1m], label "Claude Opus 5 (1M context)", thinking efforts [low, medium, high, xhigh, max], mirroring the Node side landed in PR #664) including the Rust mirror test at crates/freshell-freshagent/src/model_capabilities.rs:369.

### Explicit constraints
- The statics sync is accomplished BY upgrading the sidecar's vendored SDK track (user explicitly chose the upgrade path), not as a standalone statics-only edit.
- Work in this run's dedicated worktree only; no merges, no PR without explicit user approval.
- The live production Rust server on port 3001 must not be restarted or redeployed (user approval "APPROVED" required); build and scratch-port launches elsewhere are fine.

### Accepted tradeoffs and residuals
- None stated.

## Goal

Deliver worktree branch `the-usual/rust-sidecar-sdk-0-3` (base `c1875f799dac9d58fa9c88c1bf54862644898252`) with two behavior commits: (1) vendored `@anthropic-ai/claude-agent-sdk` in `crates/freshell-claude-sidecar` moved from `^0.2.40` (locked 0.2.71) to `^0.3.195` (floats to newest 0.3.x; 0.3.235 today, mirroring root `package.json:93` post-#664) with a regenerated, closure-audited `package-lock.json`; (2) the Rust claude statics row at `crates/freshell-freshagent/src/model_capabilities.rs:368-372` ported to `("opus[1m]", "Claude Opus 5 (1M context)", &["low", "medium", "high", "xhigh", "max"])` with its mirror test at `crates/freshell-freshagent/src/model_capabilities_tests.rs:326-330` updated red-first. Proof burden: the verification gauntlet in Task 3 is green end-to-end, including the decisive real-SDK oracle T2 turn. Ready for user-approved PR creation (PR creation itself is OUT of this run).

Why the two must land together (the interlock the constraint encodes): the post-#664 client now defaults freshclaude/kilroy panes to `opus[1m]`, an alias that only exists in the 0.3 alias domain; conversely a stale `claude-opus-4-6` advertisement would (a) not resolve under 0.3's catalog and (b) silently substitute to `claude-sonnet-5` per CLI 2.1.235 (#664 Task-5 receipt), because the sidecar forwards pane model values verbatim. Statics and vendored SDK track move in one upgrade.

## Architecture

`crates/freshell-claude-sidecar/` is a 4-file, no-build, ESM Node package (`index.mjs` 356-line stdio JSON protocol server; `permission-channel.mjs` 185-line canUseTool park/respond port; `package.json`; `package-lock.json`), EXCLUDED from the cargo workspace (root `Cargo.toml` `exclude`), with `node_modules` gitignored and never committed. The Rust server resolves it as a filesystem path at spawn time: `sidecar_entry_path()` (`crates/freshell-freshagent/src/claude.rs:1977-1990`) = `FRESHELL_CLAUDE_SIDECAR` env override, else `<CARGO_MANIFEST_DIR>/../freshell-claude-sidecar/index.mjs` baked at compile time; Node's ESM resolver then resolves the bare `@anthropic-ai/claude-agent-sdk` import (`index.mjs:68`, overridable via `FRESHELL_CLAUDE_SDK_QUERY_MODULE` test seam) from the sidecar's OWN on-disk `node_modules`. Nothing in build/launch tooling npm-installs it (`scripts/launch-rust.sh` has no install step) — install is out-of-band.

Protocol surface (verified, unchanged by the bump): 6 stdin commands (`create`, `send`, `interrupt`, `permission.respond`, `question.respond`, `shutdown`); 16 `sdk.*` stdout frames; exactly one SDK symbol used — `query()` — with options `cwd, resume, model, permissionMode, effort, pathToClaudeCodeExecutable, includePartialMessages, abortController, env, settingSources: ['user','project','local'], stderr, canUseTool`. The 0.2.71 → 0.3.235 type-level compatibility verdict (read from both SDK trees): every field `index.mjs` and `permission-channel.mjs` read is intact; `EffortLevel` adds `'xhigh'` (required by the new statics); `CanUseTool` ctx/return widenings are additive and benign (sidecar reads only still-present fields, always resolves a `PermissionResult`); the grown `SDKMessage` union (~38 members) is absorbed by the `default:` ignore arm. **`index.mjs` and `permission-channel.mjs` need NO code change** — the upgrade is package.json + lockfile only.

The Rust consumer (`crates/freshell-freshagent/src/claude.rs`) parses sidecar stdout as untyped `serde_json::Value` through a fixed 16-entry rename table; nothing in the workspace validates or rewrites claude model/effort values (free `Option<String>` end to end). Capabilities are served by `static_models()` (`model_capabilities.rs:346-387`) as a hard-coded table — the documented deviation: Rust does NOT probe SDK `supportedModels()` — over axum routes `GET/POST /api/fresh-agent/model-capabilities/{freshclaude,kilroy}[/refresh]`; the mirror test `non_opencode_session_types_serve_static_catalogs` (`model_capabilities_tests.rs:266-339`) pins the served JSON for codex, kilroy, and freshclaude.

## Tech Stack

Existing only: Rust workspace (toolchain 1.96.0, edition 2021, `cargo test/clippy/fmt` per `.github/workflows/rust-clippy.yml`); Node 24 engine + npm ≥7 (peer auto-install) for the sidecar package; Vitest server config (`config/vitest/vitest.server.config.ts`) for the sidecar suite; Vitest oracle config (`config/vitest/vitest.oracle.config.ts`) for the T2 real-turn gate; `scripts/launch-rust.sh` for the scratch-port smoke. Expected lockfile resolution (VAL-2-executed shape on the Node side, simpler here): `@anthropic-ai/claude-agent-sdk@0.3.x` (≥0.3.195), 8 `@anthropic-ai/claude-agent-sdk-<platform>` optional platform binaries IN, peer `@anthropic-ai/sdk@0.117.x` (range `>=0.93.0`) + transitives (`json-schema-to-ts`, `ts-algebra`, `standardwebhooks`, `@stablelib/base64`, `fast-sha256`) IN, peer `@modelcontextprotocol/sdk@1.30.x` (range `^1.29.0`, NOT declared in the sidecar package.json — auto-installed) IN, `zod` single `^4` copy retained, 9 `@img/sharp-*`/libvips 0.2-era optional packages OUT. No new dev dependencies anywhere.

## Global Constraints

1. **Worktree only.** All work in `/home/dan/code/freshell/.worktrees/rust-sidecar-sdk-0-3`, branch `the-usual/rust-sidecar-sdk-0-3`, base `c1875f799dac9d58fa9c88c1bf54862644898252`. No merges to any other branch. No PR creation — stop before `gh pr create` or any equivalent; PR requires explicit user approval, which this run does not have.
2. **Never touch :3001.** The live production Rust server on port 3001 (main checkout) must not be restarted, stopped, redeployed, or rebuilt-over. Scratch ports only: `3499` for the launch smoke; the oracle T2 harness boots its own ephemeral-port server with sentinel-owned pid reaping. No "APPROVED" has been given, and none is requested here.
3. **Commit the pin + lock, never the vendored tree.** Commit ONLY `crates/freshell-claude-sidecar/package.json` and `crates/freshell-claude-sidecar/package-lock.json` from the sidecar. `node_modules` is gitignored; verify with `git check-ignore crates/freshell-claude-sidecar/node_modules` (must print the path) and ensure it never appears in any commit.
4. **Install ordering.** The sidecar `node_modules` install (`npm install` inside the crate dir, Task 1; clean-reproduced via `npm ci` in Task 3) MUST precede every real-SDK-dependent gate (Task 3.10 oracle T2). The fake/stub-SDK gates (sidecar vitest suite via the `FRESHELL_CLAUDE_SDK_QUERY_MODULE` env seam, `claude_sidecar_interrupt_dispatch` with its staged stub SDK, freshell-ws scripted-fake-sidecar suites) do not need it and stay version-agnostic.
5. **Lock-closure safeguard.** After `npm install`, `git diff crates/freshell-claude-sidecar/package-lock.json` churn must be confined to the expected closure listed in Tech Stack. ANY out-of-closure churn → STOP and report, do not commit.
6. **Accepted residual — silent model drift, documented not migrated.** Persisted/restored/REST-created panes carrying `claude-opus-4-6` get no re-clamp anywhere (verbatim passthrough in both stacks) and will silently run as `claude-sonnet-5` under the bumped SDK/CLI 2.1.235. This is the same posture merged in Node PR #664; this kata mirrors it and adds NO migration.
7. **Explicit scope exclusions (not silent deferrals).** No code changes to `index.mjs` / `permission-channel.mjs` (verified 0.3-safe); no `supportedModels()` probe added (the Rust statics deviation stays documented in the module doc and DEVIATION comment, both of which remain accurate); no client/Node-stack changes (PR #664 already landed them — root `package.json`, `shared/fresh-agent-models.ts`, client registry/selector machinery, e2e radio updates are all on base); advisory-only historical port-spec strings citing `^0.2.40` (`port/machine/specs/coding-cli.md:520`, `port/machine/architecture-spec.md:121-122`) stay untouched (cosmetic); `docs/index.html` has no model-selector content → no mock update triggered; post-merge deploy mechanics (main-checkout sidecar `npm ci` + approved :3001 restart) are out of scope for this run and will need user direction/approval later.
8. **Test discipline.** Repo wrappers only: focused vitest via `npm run test:vitest -- run <paths> --config <cfg>` (explicit `--config` required for server/oracle paths); broad close-out via the coordinated `FRESHELL_TEST_SUMMARY=... npm test` — check `npm run test:status` first and WAIT on a foreign coordinator holder, never kill it. No raw `npx vitest`. If `FRESHELL_VITEST_BACKEND` / `FRESHELL_E2E_BACKEND` is unset, do not force a cloud backend from this plan; ask the user first per repo policy (local is the safe default).
9. **TDD red/green is genuine.** Task 1's RED is the executable version-track assertion failing on pin `^0.2.40` / locked `0.2.71`. Task 2's RED is the mirror test updated to the new expectations FIRST and observed failing against the old statics row before the implementation edit. Paste RED and GREEN outputs into the run ledger.
10. **Kata bookkeeping is out of plan scope.** Closing tracking kata fpxj after successful delivery belongs to the user/orchestrator, not to any task below.

## File Responsibility Map

| File | Change |
|---|---|
| `crates/freshell-claude-sidecar/package.json` | L12: `"@anthropic-ai/claude-agent-sdk": "^0.2.40"` → `"^0.3.195"` |
| `crates/freshell-claude-sidecar/package-lock.json` | Regenerated by `npm install` in the crate dir; churn confined per Constraint 5 |
| `crates/freshell-freshagent/src/model_capabilities.rs` | L368-372 claude statics row → `("opus[1m]", "Claude Opus 5 (1M context)", &["low", "medium", "high", "xhigh", "max"])` |
| `crates/freshell-freshagent/src/model_capabilities_tests.rs` | L326-330 mirror assertions → `"opus[1m]"` / `"Claude Opus 5 (1M context)"` / `["low", "medium", "high", "xhigh", "max"]` |

Explicitly NOT changed (verified): `index.mjs`, `permission-channel.mjs`, `crates/freshell-freshagent/src/claude.rs`, protocol crates, all fake sidecars and e2e fixtures, Node test fixtures using `claude-opus-4-6` as opaque passthrough data, `crates/freshell-sessions/src/parse/claude.rs` (historical transcript context-window table), the advisory doc strings in Constraint 7.

## Tasks

### Task 1: Sidecar dependency bump `^0.2.40` → `^0.3.195` + lockfile regeneration

**Files:** `crates/freshell-claude-sidecar/package.json`, `crates/freshell-claude-sidecar/package-lock.json`

**Interfaces:** npm dependency interface only — `@anthropic-ai/claude-agent-sdk` version constraint and the lockfile v3 closure membership (expected set per Tech Stack). No source interface changes: no exports, signatures, or wire shapes move; `index.mjs` keeps importing the same single `query` symbol.

- [ ] **RED — version-track assertion (executable, fails pre-change).** From the worktree root run:
  ```bash
  cd crates/freshell-claude-sidecar && node -e "const fs=require('fs');const pj=JSON.parse(fs.readFileSync('package.json'));const lk=JSON.parse(fs.readFileSync('package-lock.json'));const pin=pj.dependencies['@anthropic-ai/claude-agent-sdk'];const ver=lk.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version;if(!pin.startsWith('^0.3')||!ver.startsWith('0.3.')){console.error('sidecar SDK not on 0.3 track: pin='+pin+' locked='+ver);process.exit(1)}console.log('sidecar SDK on 0.3 track: pin='+pin+' locked='+ver)"
  ```
  Expected failure: exit 1 with `sidecar SDK not on 0.3 track: pin=^0.2.40 locked=0.2.71` — the vendored sidecar is still pinned to the 0.2 track and locked at 0.2.71. Paste into the run ledger.
- [ ] **Minimal implementation.** Edit `package.json` L12 to `"@anthropic-ai/claude-agent-sdk": "^0.3.195"`, then regenerate the lockfile and materialize node_modules in one step:
  ```bash
  cd crates/freshell-claude-sidecar && npm install
  ```
- [ ] **GREEN — assertion flips to pass.** Re-run the RED command: exit 0, prints `pin=^0.3.195 locked=0.3.x` (0.3.235 expected today; any `0.3.x` ≥ 0.3.195 satisfies the pin). Node_modules probe from the worktree root:
  ```bash
  node -p "JSON.parse(require('fs').readFileSync('crates/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version"
  ```
  prints the same `0.3.x`.
- [ ] **Lock-closure audit (Constraint 5).** `git -C /home/dan/code/freshell/.worktrees/rust-sidecar-sdk-0-3 status --short -- crates/freshell-claude-sidecar` shows exactly two modified files (`package.json`, `package-lock.json`) and no untracked commit-eligible additions (node_modules ignored). Inspect `git diff crates/freshell-claude-sidecar/package-lock.json` and confirm the highlights: 8 `@anthropic-ai/claude-agent-sdk-<platform>` optional platform binaries IN; the 9 `@img/sharp-*`/libvips optional packages OUT; `@anthropic-ai/sdk@0.117.x` + transitives (`json-schema-to-ts`, `ts-algebra`, `standardwebhooks`, `@stablelib/base64`, `fast-sha256`) IN; `@modelcontextprotocol/sdk@1.30.x` IN as an auto-installed peer; `zod` still a single `^4` copy. Receipt: `cd crates/freshell-claude-sidecar && npm ls` exits 0 with that closure and zero `extraneous`/`invalid` lines. Any deviation → STOP and report.
- [ ] **Refactor pass (mechanical-change variant).** Nothing to refactor — no source was edited; record in the ledger that the compatibility table verdict (every sidecar-read field intact in 0.3.195/0.3.235; `xhigh` added to `EffortLevel`; benign `CanUseTool` widenings; `default:`-arm union tolerance) was re-confirmed, which is why `index.mjs`/`permission-channel.mjs` correctly receive no edits.
- [ ] **Impacted-set verification.** `git status --short` across the worktree shows ONLY the two sidecar files (the bump's blast radius); root `package.json`/root lockfile untouched (already at `^0.3.195` via #664).
- [ ] **Focused commit:**
  ```bash
  git add crates/freshell-claude-sidecar/package.json crates/freshell-claude-sidecar/package-lock.json && git check-ignore crates/freshell-claude-sidecar/node_modules && git commit -m "chore(claude-sidecar): upgrade vendored @anthropic-ai/claude-agent-sdk to the 0.3 track"
  ```
  (`git check-ignore` must print the node_modules path before committing — Constraint 3.)

### Task 2: Port the claude model statics + Rust mirror test (TDD)

**Files:** `crates/freshell-freshagent/src/model_capabilities_tests.rs` (RED first), `crates/freshell-freshagent/src/model_capabilities.rs` (implementation)

**Interfaces:** `GET /api/fresh-agent/model-capabilities/freshclaude` and `.../kilroy` (plus `/refresh` POSTs) change served content only — `models[0]` becomes `{"id": "opus[1m]", "displayName": "Claude Opus 5 (1M context)", "provider": "claude", "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"], "supportsAdaptiveThinking": true}`. Wire keys, envelope (`ok/sessionType/runtimeProvider/status:'fresh'/fetchedAt`), and the `ModelCapability` struct are unchanged; no schema or serde change. Mirror source of truth (already on base): `shared/fresh-agent-models.ts:22-29,50-57`.

Complete patches:

`model_capabilities.rs` L368-372 (only the tuple values change):
```rust
        SessionType::FreshClaude | SessionType::Kilroy => &[(
            "opus[1m]",
            "Claude Opus 5 (1M context)",
            &["low", "medium", "high", "xhigh", "max"],
        )],
```

`model_capabilities_tests.rs` L324-333 (`models` array inside the kilroy/freshclaude loop):
```rust
                "models": [
                    {
                        "id": "opus[1m]",
                        "displayName": "Claude Opus 5 (1M context)",
                        "provider": "claude",
                        "supportsEffort": true,
                        "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                        "supportsAdaptiveThinking": true,
                    },
                ],
```

- [ ] **RED — mirror test updated FIRST, observed failing.** Apply ONLY the test patch above, then run:
  ```bash
  cargo test -p freshell-freshagent --lib model_capabilities
  ```
  Expected failure: `model_capabilities_tests::tests::non_opencode_session_types_serve_static_catalogs` panics with `assertion 'left == right' failed` on the first (Kilroy) loop iteration — the served body (left) still contains `"id": "claude-opus-4-6"`, `"displayName": "Claude Opus 4.6"`, `"supportedEffortLevels": ["low", "medium", "high"]` while the expectation (right) is the new `opus[1m]` row. Paste into the run ledger.
- [ ] **Minimal implementation.** Apply the `model_capabilities.rs` patch above. `supports_effort` / `supports_adaptive_thinking` stay `true` via the existing non-empty-levels derivation (`:382,:384`) — no other line moves.
- [ ] **GREEN.** Re-run `cargo test -p freshell-freshagent --lib model_capabilities` → all pass (mirror test plus the route-level tests; the codex-only `gpt-5.5` assertions are unaffected).
- [ ] **Refactor pass.** Re-read the DEVIATION comment (`model_capabilities.rs:366-367`) and module doc (`:15-22`): both remain accurate (the Rust port still serves the shared static table; no probe was added) — leave them. Confirm the complete-inventory property: `rg -n "opus" crates/ --glob '*.rs'` shows the only changed claude pins are these two files (`claude.rs` `opus-x` fixtures and the `freshell-sessions` transcript table stay by design). Rustfmt conformance of the edited tuple (`cargo fmt -p freshell-freshagent -- --check`).
- [ ] **Impacted-set verification.**
  ```bash
  cargo test -p freshell-freshagent
  ```
  Full crate green — in-crate `claude.rs` suite (normalize table, session.init envelope + model passthrough, turn-complete monotonicity, pending folds, create-request passthrough, death-no-false-completion) and `tests/` binaries. Requires `node` on PATH (the interrupt-dispatch test spawns the real sidecar with a staged stub SDK).
- [ ] **Focused commit:**
  ```bash
  git add crates/freshell-freshagent/src/model_capabilities.rs crates/freshell-freshagent/src/model_capabilities_tests.rs && git commit -m "feat(freshagent): serve opus[1m] claude statics with the xhigh-capable effort set"
  ```

### Task 3: Full verification gauntlet + close-out (gates only; no new code)

**Files:** none modified. **Interfaces:** none changed. Ordering is load-bearing: 3.1 (install) precedes every real-SDK-dependent step (Constraint 4).

- [ ] **3.1 Clean-reproduce the vendored tree from the committed lock:**
  ```bash
  cd crates/freshell-claude-sidecar && npm ci
  ```
  Exit 0 (proves the committed `package-lock.json` is internally consistent and installable from scratch); re-run the Task-1 GREEN node_modules version probe → `0.3.x`.
- [ ] **3.2 Sidecar vitest regression net (fake-SDK env seam; does not load the vendored SDK):**
  ```bash
  npm run test:vitest -- run test/unit/server/claude-sidecar/ --config config/vitest/vitest.server.config.ts
  ```
  All pass — permission-channel cases 1-10 including the production-wiring case 10 through the real `index.mjs` with `FRESHELL_CLAUDE_SDK_QUERY_MODULE=<fixtures/fake-query-module.mjs>`.
- [ ] **3.3 Rust fmt:** `cargo fmt --all --check` → exit 0.
- [ ] **3.4 Clippy, CI parity (toolchain 1.96.0), all exit 0:**
  ```bash
  cargo clippy --workspace --all-targets -- -D warnings
  cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
  cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
  ```
- [ ] **3.5 Workspace + CI-parity cargo tests:**
  ```bash
  cargo test --workspace
  cargo test -p freshell-protocol --locked
  cargo test -p freshell-terminal --locked
  ```
  All green. (If the host lacks the GTK/WebKit system libs `freshell-tauri` needs to compile, run instead `cargo test -p freshell-freshagent -p freshell-ws -p freshell-codex -p freshell-opencode -p freshell-server -p freshell-protocol` and record the tauri exclusion reason in the ledger — this mirrors the known environment caveat, not a coverage reduction for this change.)
- [ ] **3.6 Interrupt-dispatch gate (real sidecar source, staged stub SDK):**
  ```bash
  cargo test -p freshell-freshagent --test claude_sidecar_interrupt_dispatch
  ```
  Green (SDK-version-agnostic by construction; requires `node` on PATH).
- [ ] **3.7 freshell-ws scripted-fake-sidecar suites:**
  ```bash
  cargo test -p freshell-ws --test freshagent_claude_kill_interrupt --test claude_session_rebind
  ```
  Green.
- [ ] **3.8 Release build (worktree target):** `cargo build --release -p freshell-server` → exit 0.
- [ ] **3.9 Scratch-port launch smoke (:3001 NEVER touched).** Ensure `dist/client` exists (`npm run build:client` first if missing); provide `AUTH_TOKEN` (env var, or copy the main checkout's `.env` into the worktree root — `.env` is gitignored); then:
  ```bash
  scripts/launch-rust.sh --skip-build --port 3499
  curl -fsS http://127.0.0.1:3499/api/health
  ```
  Expect "freshell-server is ready! (pid N, port 3499)" and a 200 health response. Confirm provenance in `~/.freshell/logs/rust-server-3499.log`: the `listening ... [commit <sha>] [dirty ...]` line names THIS worktree's HEAD. Then stop: `scripts/launch-rust.sh --stop --port 3499`.
- [ ] **3.10 DECISIVE — oracle T2 real-SDK turn.** Prerequisites met: 3.1 (node_modules at 0.3.x), 3.8 (release binary), real `claude` CLI on PATH with credentials. Run:
  ```bash
  FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/unit/port/oracle/t2-claude-equivalence-rust.test.ts --config config/vitest/vitest.oracle.config.ts
  ```
  Expect PASS: one real `freshclaude` Haiku turn driven through a scratch-port Rust server → real sidecar → real vendored 0.3.x SDK → real CLI under an isolated `CLAUDE_HOME`; 9 fatal invariants hold; structural deep-equal against `port/oracle/baselines/t2/claude-haiku.json`; `liveModelCalls <= 2`. The harness (`port/oracle/harness/external-server.ts`) boots its own ephemeral port and reaps only sentinel-owned pids — :3001 untouched (and expressly pinned not-3001 by the test). **A skip is not a pass:** if the test self-skips (gate env, missing binary/creds), record the skip reason verbatim and surface it to the orchestrator as an UNRESOLVED COVERAGE GAP.
- [ ] **3.11 Advisory CLI-health smoke (optional, not required for green).**
  ```bash
  FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/coding-cli-session-contract.test.ts --config config/vitest/vitest.server.config.ts
  ```
  SDK-agnostic smoke that the PATH `claude` CLI itself is healthy. Known pre-existing external-CLI drifts reproduce at this base (VAL-3: claude cross-cwd `--resume` exit-0 change; two opencode 60s JSON timeouts) — if seen, attribute as pre-existing, do NOT fix here.
- [ ] **3.12 Coordinator close-out.** `npm run test:status` (inspect holder + recent results; WAIT on any foreign holder), then:
  ```bash
  FRESHELL_TEST_SUMMARY="rust-sidecar-sdk-0-3 close-out (sidecar SDK 0.3 + claude statics)" npm test
  ```
  Coordinated full suite green. (No e2e surface is affected — every freshclaude e2e spec injects a scripted fake sidecar under `FRESHELL_CLAUDE_SIDECAR` and never loads the vendored SDK; the client-side selector/e2e updates already landed in #664.)
- [ ] **3.13 Handoff.** `git status` clean; `git log --oneline -3` shows the plan commit plus the two implementation commits; report done-ness with the ledger's RED/GREEN receipts. NO PR, NO merge, NO kata closure (Constraints 1, 10) — await explicit user approval for PR creation.

## Rollback

Revert the two implementation commits (pin/lock bump; statics + mirror test). No state was migrated and no live surface was touched; the previous vendored tree is restorable at any time via `cd crates/freshell-claude-sidecar && npm ci` from the pre-change lockfile in git history. This committed plan plus the run ledger is the durable rollback record.
