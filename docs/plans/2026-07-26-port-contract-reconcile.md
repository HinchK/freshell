# Port-Contract Freeze vs Rust T0 Inventory Reconciliation Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the frozen WS contract (`port/contract/*`), the TS freeze suite, and the
Rust T0 inventory tests all pin the SAME truth (the current `shared/ws-protocol.ts`
surface), make `npm run contract:generate` idempotent-clean, and wire the guard into CI
so it can never silently rot again.

**Architecture:** Decision **(a) UPDATE** (see Decision Record below). Regenerate the
three contract artifacts from the live TS source, grow the freeze test's hardcoded
Zod-overlap list 8→12, promote the four TS-backed "extension" types into the Rust
frozen arrays (29 client / 56 server / 85 combined), shrink `EXTENSION_*_MESSAGE_TYPES`
to the single honest Rust-only entry (`durability.degraded`), refresh stale doc counts,
and add a `port-contract` CI workflow (freeze suite + regen-idempotency diff check +
`cargo test -p freshell-protocol`).

**Tech Stack:** TypeScript (tsx generator, Vitest), Rust (cargo test), GitHub Actions.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/port-contract-reconcile`, branch
  `chore/port-contract-reconcile`, base `origin/main @ bf6242a1`. All commands run from
  the worktree root unless stated otherwise.
- **This lane changes what is PINNED, never what is SENT.** No edits to
  `shared/ws-protocol.ts`, `server/`, `src/`, or any `crates/freshell-ws` runtime code.
  The generator only READS `shared/ws-protocol.ts`.
- `wsProtocolVersion` stays **7** everywhere (all drift is additive; no wire change).
- Scope fence: do NOT touch sidebar/sessions code (Lane C1) or client reconcile folding /
  freshell-freshagent / `reconcile_freshagent.rs` (Lane C2). No kimi/gemini.
- The main checkout's `stash@{0}` is READ-ONLY context. Never `stash pop/apply/drop`.
- NEVER restart the user's self-hosted Freshell server; never use broad kill patterns.
- Every commit message ends with the footer:

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```
- Line numbers cited below are as of `bf6242a1`. If an edit's `old_string` doesn't match,
  re-locate with the provided grep command — never guess.
- Broad coordinated runs (`npm test`) set `FRESHELL_TEST_SUMMARY` and WAIT if the
  coordinator gate is held by another agent (2 sibling lanes run concurrently).
- If `node_modules/` is missing in the worktree, run `npm ci` first.
- PR policy: NOT approved. Push the branch, STOP before `gh pr create`.
- e2e tests are NOT required: no runtime behavior changes (artifacts, tests, docs, CI
  wiring only). `npm test` scope is unaffected except for a new `package.json` script.

---

## Decision Record (investigate + decide — required by the lane spec)

**Chosen: (a) UPDATE the freeze artifacts to the current true protocol surface.**

Evidence (full reports in `.worktrees/.the-usual-logs/port-contract-reconcile/reports/`):

- **The drift, measured** (by running the repo's own generator at `bf6242a1`):
  - `ws-message-inventory.json`: committed 28 c2s / 53 s2c → regen **29 / 56**.
    Missing: `amplifier.activity.list` (c2s); `amplifier.activity.list.response`,
    `amplifier.activity.updated`, `terminal.idle` (s2c).
  - `ws-protocol.schema.json`: 55 → **66** schemas (+ `AmplifierActivity*` ×4,
    `PaneReconcile*` ×2, `PaneVerdictSchema`, `ReadyCapabilitiesSchema`,
    `ReconcilePaneSchema`, `ReconcileSessionRefSchema`, `TerminalIdleSchema`).
  - `ws-server-messages.schema.json`: 52 → **56** (+ `pane.reconcile.result` and the
    three s2c types above).
  - Drift is **purely additive**. Contrary to the lane brief's hypothesis,
    `pane.reconcile.*` is in BOTH TS and the inventory (added by `eef9b344`) — there are
    ZERO inventory-only types. `eef9b344` did however update only 1 of 3 artifacts, so
    the committed set is internally inconsistent (inventory 53 vs outbound schema 52).
  - One Rust-only frame exists: `durability.degraded`
    (`crates/freshell-protocol/src/server_messages.rs:50-51`, emitted by
    `crates/freshell-ws/src/pane_ledger.rs:823`). It is in neither TS nor the inventory.
- **Freeze suite red on main (verified by execution):**
  `npx vitest run --config config/vitest/vitest.port.config.ts` →
  **8 failed | 30 passed (38)** (the 8 failures all in
  `test/unit/port/ws-contract-freeze.test.ts`; `normalize.test.ts` 25/25 green).
- **The freeze suite runs NOWHERE:** no npm script, excluded from the default vitest
  config (`config/vitest/vitest.config.ts:36`), unknown to the test coordinator
  (`scripts/testing/coordinator-command-matrix.ts:43-53`,
  `scripts/run-standard-tests.ts:13-15`), absent from all 4 CI workflows. `cargo test`
  is also not in CI (only `rust-clippy.yml`).
- **Why not (b) RETIRE:** `port/contract/*.json` has nine REAL reading consumers:
  the freeze test; the oracle harness (`port/oracle/harness/contract-validator.ts:92,94`)
  used by 4 oracle test files (`npm run test:oracle`); and three Rust test files that
  read the JSON from disk at test time (`crates/freshell-protocol/tests/inventory.rs:16`,
  `tests/version.rs:31,41,57`, `tests/roundtrip.rs:40,44`). Deleting the artifacts
  breaks `cargo test`; deleting only the TS freeze test would leave the Rust suite
  pinning a provably stale surface forever — two truths, the exact disease. The
  contract remains the live cross-language seam: the TS client + legacy Node server
  still speak this protocol and the Rust server pins it.
- **Why not (c) narrower fix:** anything short of a full regen leaves the guard red
  and/or unwired, i.e. keeps the debt.
- **What we DO delete** (campaign bias — nothing dormant): the Rust
  `EXTENSION_*_MESSAGE_TYPES` **drift-absorption buffer**. Since `0736afe3`, every time
  TS grew a frame the frozen artifact lacked, the type was parked in the extension list
  instead of the contract being reconciled. After this plan the extension list shrinks
  to the one genuinely Rust-only frame.
- **`durability.degraded` stays a Rust-only documented extension.** The inventory is
  generated from TS; adding a Zod schema to `shared/ws-protocol.ts` to carry it would
  change the TS protocol surface — out of this lane's fence ("changes what's PINNED,
  not what's SENT" — the TS union is a live client artifact). The promotion path is
  documented in the rewritten Rust doc comment (Task 3).

### RESIDUAL DECISION (loud — B2's "~20-line post-merge cleanup")

Found (timebox met). The literal phrase exists in no persisted artifact, but the item is
B2's deliberately-deferred **codex-candidate wire-surface deletion**, enumerated verbatim
in `.worktrees/.the-usual-logs/codex-rollout-locator/reports/codex-candidate.md:494-498`:
client sender `src/components/TerminalView.tsx:4199-4208` (~10 lines) +
`shared/ws-protocol.ts:320-326,:653` + Rust `client_messages.rs:27-28,:105,:227-232` +
contract entries. **We are NOT applying it**, on evidence: the legacy Node server is a
LIVE consumer (`server/ws-handler.ts:2951` → `server/terminal-registry.ts:3986`) and
still emits the trigger (`terminal.codex.durability.updated`,
`server/terminal-registry.ts:3047,3052`), so deleting the client sender is a behavior
change against the Node server — prohibited by this lane's own fence ("no behavior
changes to the live protocol"). B2's plan itself pinned the frame as wire-compat
(`docs/plans/2026-07-26-codex-rollout-locator.md:2199-2201`). Disposition: keep
`terminal.codex.candidate.persisted` fully pinned (it is in TS, so the regen keeps it);
record a follow-up requiring an explicit user decision tied to legacy-Node retirement.
Task 6 records this in the lane report notes.

### Stash@{0} disposition

`stash@{0}` on the main checkout is a pure `port/contract/*` regen from pre-waveA base
`c3b468b0`. It is **half-stale**: its `pane.reconcile.*` REMOVALS are wrong at
`bf6242a1` (those schemas entered TS later via `26102523`); its four ADDITIONS are
subsumed by our fresh regen. Task 6 verifies obsolescence with commands and records
"safe to drop" in the lane report. We never touch the stash itself.

### TDD shape of this plan

The **RED is real and already observed**: the freeze suite fails 8/13 on the unmodified
base. Task 1 pins that red under a repo-owned runner. Task 2 turns the TS side green.
Task 2's regen is itself the failing-test setup for Task 3 (the Rust inventory tests go
red against the regenerated inventory — observed as Task 3 Step 1, fixed in the same
task). Task 5 adds the anti-rot + regen-idempotency guard. **Note:** between the Task 2
and Task 3 commits, `cargo test -p freshell-protocol` is intentionally red — Tasks 2 and
3 must be executed back-to-back on this branch; neither is independently mergeable.

### Load-bearing validation findings (2026-07-26, pre-execution)

Six load-bearing assumptions were validated before execution (ledger:
`.worktrees/.the-usual-logs/port-contract-reconcile/load-bearing-ledger.md`; evidence in
`reports/validator-clone-suite.md` and `reports/validator-ci-actions.md`; sandbox left at
`/tmp/pcr-validate`). What executors can now rely on:

- **Generator is deterministic** (verified): two regens after a fresh `npm ci` in a clean
  clone are byte-identical (sha256-proven); source inspection found zero
  environment-dependent output sources (code-point sorts only, no locale/Date/paths/env;
  deps exact-pinned by the lockfile: typescript 5.9.3, tsx 4.21.0, zod 4.3.6). The
  committed `\u2014` escape is a one-time artifact of the original freeze. The CI
  regen-idempotency gate is sound **provided CI installs with `npm ci`** (it does).
- **Rust base is green; post-regen red is confined** (verified by execution): at base,
  `cargo test -p freshell-protocol --locked` passes all 34 tests (~40s cold build,
  sub-second warm); after the regen ONLY `tests/inventory.rs` fails (28→29, 53→56).
  `roundtrip.rs`, `version.rs`, `pane_reconcile.rs`, and `activity_extension.rs` all
  still pass against the regenerated bundles. Task 3 Step 1's expectations match
  observed reality. `--locked` is clean (no lockfile drift) and the dep tree is 100%
  pure Rust (no `-sys` crates) — safe for a clean ubuntu runner.
- **Regen diff is semantically additive but NOT line-level clean** (assumption falsified,
  plan adjusted): beyond count/title lines, the diff removes 12 more lines — 8 are a
  diff-anchoring artifact (an `activePane` block re-emitted verbatim after an anyOf
  insertion) and 4 are trailing-comma artifacts of enum APPENDS to pre-existing schemas
  (`SESSION_RESERVED` joins the error-code enum in both schema files; `amplifier` joins
  the CLI-provider enums in both schema files). No constraint is removed or tightened;
  `wsProtocolVersion` stays 7. Task 2 Step 2 enumerates the exact tolerance list.
- **Oracle suite is regen-neutral but NOT green at base** (assumption falsified, no new
  task needed): `npm run test:oracle` in a fresh clone fails 4 / passes 171 both BEFORE
  and AFTER the regen (identical failure set — the regenerated artifacts pin nothing the
  oracle checks differently). The 4 failures are pre-existing and out of this lane's
  scope: mutation-e2e ×2 (stale buildinfo path — `test/oracle/mutation-e2e.test.ts:45`
  clears `node_modules/.cache/...` but `tsconfig.server.json:12` moved buildinfo to
  `dist/` in `1de2258d`, making the rebuild a no-op) and rust-equivalence ×2
  (machine-sensitive: TS discovers an installed `amplifier` CLI into `enabledProviders`,
  Rust does not). Do NOT add `test:oracle` to the new CI workflow; the follow-up is
  recorded in Task 6 Step 5.
- **GitHub Actions policy verified** (read-only `gh api`): repo actions policy is
  `allowed_actions: "all"`; `rust-clippy.yml` already uses
  `dtolnay/rust-toolchain@master` (with a deliberate 1.96.0 toolchain pin — see its
  comment at lines 23-26) and `Swatinem/rust-cache@v2`, and its 8 most recent runs all
  concluded `success` on both `push` (main) and `pull_request` events. Note: the new
  workflow will NOT run on this lane's branch push (its triggers are `pull_request` +
  `push: branches: [main]`); its first execution happens when the user opens the PR.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | add `test:port` script (runner for the freeze suite) |
| `port/contract/ws-message-inventory.json` | Regenerate | T0 surface (generator output only — never hand-edit) |
| `port/contract/ws-protocol.schema.json` | Regenerate | inbound Zod bundle (generator output only) |
| `port/contract/ws-server-messages.schema.json` | Regenerate | outbound shapes (generator output only) |
| `test/unit/port/ws-contract-freeze.test.ts` | Modify | grow `ZOD_BACKED_SERVER_MESSAGES` 8→12 |
| `crates/freshell-protocol/src/client_messages.rs` | Modify | promote `amplifier.activity.list`; empty extension array |
| `crates/freshell-protocol/src/server_messages.rs` | Modify | promote 3 types; shrink extension array to 1 |
| `crates/freshell-protocol/src/lib.rs` | Modify | fix stale count doc comment |
| `crates/freshell-protocol/tests/inventory.rs` | Modify | counts 28/53/81 → 29/56/85 |
| `crates/freshell-protocol/tests/activity_extension.rs` | Modify | update pinned extension arrays + stale header |
| `port/contract/README.md` | Modify | current counts + how the guard runs now |
| `port/contract/nondeterministic-fields.md` | Modify | rows for the 4 newly pinned messages |
| `port/machine/architecture-spec.md` | Modify | "all 52" → current |
| `port/machine/STATE.yaml` | Modify | append reconciliation DONE line (don't rewrite history) |
| `.github/workflows/port-contract.yml` | Create | CI guard: freeze suite + regen idempotency + cargo test |

Authoritative post-reconciliation surface (== `shared/ws-protocol.ts` at `bf6242a1`,
enumerated via the repo's own generator):

- **client→server (29):** `amplifier.activity.list`, `claude.activity.list`,
  `client.diagnostic`, `codex.activity.list`, `codingcli.create`, `codingcli.input`,
  `codingcli.kill`, `freshAgent.approval.respond`, `freshAgent.attach`,
  `freshAgent.compact`, `freshAgent.create`, `freshAgent.fork`, `freshAgent.interrupt`,
  `freshAgent.kill`, `freshAgent.question.respond`, `freshAgent.send`, `hello`,
  `opencode.activity.list`, `pane.reconcile.request`, `ping`, `terminal.attach`,
  `terminal.codex.candidate.persisted`, `terminal.create`, `terminal.detach`,
  `terminal.input`, `terminal.kill`, `terminal.resize`, `ui.layout.sync`,
  `ui.screenshot.result`
- **server→client (56):** the committed 53 plus `amplifier.activity.list.response`,
  `amplifier.activity.updated`, `terminal.idle` (sorted; `terminal.idle` sits between
  `terminal.exit` and `terminal.input.blocked`).

---

### Task 1: Pin the RED and add the `test:port` runner

**Files:**
- Modify: `package.json` (scripts block, near `"contract:generate"` at `package.json:78`)

**Interfaces:**
- Produces: `npm run test:port` — runs
  `vitest run --config config/vitest/vitest.port.config.ts`. Tasks 2, 4, 5, 6 all
  invoke it; the CI workflow (Task 5) depends on this exact script name.

- [ ] **Step 1: Confirm the worktree is clean and on the right base**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/port-contract-reconcile
git status --porcelain && git merge-base HEAD origin/main
```
Expected: no output from status; the merge-base hash starts with `bf6242a1`
(Merge pull request #537). Note: `HEAD` itself is NOT `bf6242a1` — the branch
carries `docs(plan)` commits for this plan document on top of that base. That
is expected and is not lane contamination; only commits touching files other
than `docs/plans/` would indicate a contaminated lane.
If `node_modules` is missing: `npm ci` (may take a few minutes).

- [ ] **Step 2: Observe the pre-existing RED (the failing test this lane fixes)**

Run:
```bash
npx vitest run --config config/vitest/vitest.port.config.ts
```
Expected: `Test Files  1 failed | 1 passed (2)` and `Tests  8 failed | 30 passed (38)`.
The 8 failures are all in `test/unit/port/ws-contract-freeze.test.ts`:
both deep-equals tests, both canonical-form tests for the bundle and inventory, both
server-messages tests, "full outbound coverage", and the Zod/TS cross-check.
If the numbers differ, STOP and re-investigate before proceeding (another lane may have
touched `shared/ws-protocol.ts` — see "Lane C2 coordination" note in Task 6).

- [ ] **Step 3: Add the `test:port` script**

In `package.json`, find the line (grep: `grep -n 'contract:generate' package.json`):

```json
    "contract:generate": "tsx port/contract/generate-ws-contract.ts",
```

and add directly below it (same indentation, keep alphabetical-ish grouping with the
other `test:*` scripts if the file groups them — placement next to `contract:generate`
is acceptable; what matters is the exact script value):

```json
    "test:port": "vitest run --config config/vitest/vitest.port.config.ts",
```

Note: this mirrors the shape of the existing `test:electron` script (check with
`grep -n 'test:electron' package.json` and match its exact invocation style — if it
uses a wrapper other than bare `vitest run --config ...`, mirror that wrapper).
The port suite spawns no server and needs no coordinator gate (pure in-process
import-and-compare; see `config/vitest/vitest.port.config.ts:15-20` header comment).

- [ ] **Step 4: Run the suite via the new script — same RED**

Run: `npm run test:port`
Expected: `Tests  8 failed | 30 passed (38)` — identical to Step 2. The script works;
the red is pre-existing drift, not something this commit introduces.

- [ ] **Step 5: Sanity-check `npm test` scope is unaffected**

Run: `node -e "const p=require('./package.json'); console.log(p.scripts['test:port'])"`
Expected: `vitest run --config config/vitest/vitest.port.config.ts`

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore(port): add test:port runner for the contract freeze suite

The freeze suite (config/vitest/vitest.port.config.ts) was previously
runnable only via a README-documented raw vitest invocation - no npm
script, no coordinator entry, no CI. It is currently RED on main
(8 failed / 30 passed): port/contract/* is stale vs shared/ws-protocol.ts
(missing amplifier.activity.*, terminal.idle; outbound schema missing
pane.reconcile.result). Subsequent commits reconcile the artifacts.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Regenerate the contract artifacts and reconcile the freeze test (TS side GREEN)

**Files:**
- Regenerate: `port/contract/ws-message-inventory.json`,
  `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`
- Modify: `test/unit/port/ws-contract-freeze.test.ts:21-30`

**Interfaces:**
- Consumes: `npm run test:port` (Task 1).
- Produces: regenerated artifacts with `clientToServer.count == 29`,
  `serverToClient.count == 56`, `wsProtocolVersion == 7`. Task 3's Rust arrays and
  counts (29/56/85) MUST match these exact values. Task 6 verifies the stash against
  the regenerated `ws-message-inventory.json`.

> **WARNING:** after this task's commit, `cargo test -p freshell-protocol` is RED by
> design (that is Task 3's failing test). Execute Task 3 immediately after; do not
> stop the branch between them.

- [ ] **Step 1: Regenerate**

Run: `npm run contract:generate`
Expected: exits 0. The exact console format is the generator's own (multi-line
summary with dialect, file paths, and a `converters:` detail line — see
`port/contract/generate-ws-contract.ts:666-692`); do NOT gate on formatting.
Gate ONLY on these values, all of which MUST appear in the output:

- `WS_PROTOCOL_VERSION: 7`
- Schemas frozen: **66** (all zod-native, i.e. `zod-native=66`)
- Client→Server types: **29**
- Server→Client types: **56**
- Server shapes frozen: **56/56**
- Zod cross-check: **12** overlapping, **0** required-field mismatch(es)

(The values — not the formatting — were validated 2026-07-26 by running the
generator after a fresh `npm ci` in a clean clone; see
`.worktrees/.the-usual-logs/port-contract-reconcile/reports/validator-clone-suite.md`.
If any of these NUMBERS differ, another lane has moved `shared/ws-protocol.ts` —
STOP and re-investigate.)

- [ ] **Step 2: Verify the diff is purely additive and version is unchanged**

Run:
```bash
git diff --stat -- port/contract
# No message type may disappear from the inventory:
git diff -U0 -- port/contract/ws-message-inventory.json | grep '^-' \
  | grep -v -E '^---|"count"|"title"'
# The residual fence: candidate frame must still be pinned:
grep -c '"terminal.codex.candidate.persisted"' port/contract/ws-message-inventory.json
# pane.reconcile.* must still be present (the stash's stale removals must NOT recur):
grep -c 'pane.reconcile' port/contract/ws-message-inventory.json
# Version unchanged:
grep '"wsProtocolVersion"' port/contract/ws-message-inventory.json
```
Expected (validated 2026-07-26 by executing this exact regen in a clean clone —
full classification in
`.worktrees/.the-usual-logs/port-contract-reconcile/reports/validator-clone-suite.md`):

- `--stat`: only the three JSON files changed, `925 insertions(+), 17 deletions(-)`
  (approximately — the shape matters, not the exact insertion count).
- The inventory removed-lines grep prints **nothing** (its only removed lines are the
  two `count` bumps and the `title` em-dash `\u2014` → literal `—` serialization flip,
  which the grep filters).
- candidate grep prints `1`; pane.reconcile grep prints `2`; version line shows `7`.

**Known benign removed lines in the two SCHEMA files** (do NOT stop on these; all are
semantically additive — verified by line-level diff analysis):
- `"schemaCount": 55,` / `"messageCount": 52,` — count bumps to 66 / 56.
- An 8-line `"activePane": {...}` block in `ws-protocol.schema.json` — a
  **diff-anchoring artifact**: the new `amplifier.activity.list` variant is inserted
  into an anyOf array before it, and the identical block reappears verbatim on the `+`
  side (check with `-U6` context if in doubt).
- Trailing-comma artifact lines from **enum appends to pre-existing schemas**:
  `"PROTOCOL_MISMATCH"` gains a following `"SESSION_RESERVED"` in the error-code enum
  (both schema files), and the CLI-provider enums gain `"amplifier"` (both schema
  files). These are additive enum growth, not constraint changes.

STOP only if: a message **type** line is removed from the inventory, an enum LOSES a
value, a schema body changes beyond the enum appends above, or `wsProtocolVersion`
changes — that would be drift beyond the documented evidence; re-investigate before
committing.

- [ ] **Step 3: Run the freeze suite — expect exactly ONE remaining failure**

Run: `npm run test:port`
Expected: 37 passed, 1 failed — only
`TS-derived and Zod-derived schemas agree on required field names for overlapping messages`,
failing because the hardcoded overlap list expects 8 but the real overlap is now 12.
This is the RED for Step 4.

- [ ] **Step 4: Grow `ZOD_BACKED_SERVER_MESSAGES` 8 → 12**

In `test/unit/port/ws-contract-freeze.test.ts` (grep:
`grep -n 'ZOD_BACKED_SERVER_MESSAGES' test/unit/port/ws-contract-freeze.test.ts`),
replace the existing list:

```ts
const ZOD_BACKED_SERVER_MESSAGES = [
  'claude.activity.list.response',
  'claude.activity.updated',
  'codex.activity.list.response',
  'codex.activity.updated',
  'opencode.activity.list.response',
  'opencode.activity.updated',
  'terminal.meta.updated',
  'terminal.turn.complete',
].sort()
```

with:

```ts
const ZOD_BACKED_SERVER_MESSAGES = [
  'amplifier.activity.list.response',
  'amplifier.activity.updated',
  'claude.activity.list.response',
  'claude.activity.updated',
  'codex.activity.list.response',
  'codex.activity.updated',
  'opencode.activity.list.response',
  'opencode.activity.updated',
  'pane.reconcile.result',
  'terminal.idle',
  'terminal.meta.updated',
  'terminal.turn.complete',
].sort()
```

(Keep any surrounding comment; if the comment cites "8", update it to "12".)

- [ ] **Step 5: Freeze suite fully GREEN**

Run: `npm run test:port`
Expected: `Tests  38 passed (38)`. If the cross-check test now reports actual
required-field MISMATCHES (not a count problem), STOP — that is genuine field-level
TS↔Zod divergence that must be reported, not papered over.

- [ ] **Step 6: Prove regen idempotency (the lane's explicit requirement)**

Run:
```bash
npm run contract:generate && git diff --exit-code -- port/contract && echo IDEMPOTENT
```
Expected: prints `IDEMPOTENT` (exit 0 — a second regen produces zero diff).

- [ ] **Step 7: Commit**

```bash
git add port/contract/ws-message-inventory.json \
        port/contract/ws-protocol.schema.json \
        port/contract/ws-server-messages.schema.json \
        test/unit/port/ws-contract-freeze.test.ts
git commit -m "fix(port): regenerate contract artifacts to the true protocol surface (29/56, v7)

npm run contract:generate on bf6242a1. Purely additive: picks up the
amplifier activity family (PR #498 era, 5398c8ad), terminal.idle
(317e2ea1), and closes eef9b344's partial regen (outbound schema was
missing pane.reconcile.result; inbound bundle was missing
AmplifierActivity*/TerminalIdle/PaneReconcile*/ReadyCapabilities
schemas). Freeze suite green (38/38); ZOD_BACKED_SERVER_MESSAGES grown
8->12. Second regen produces no diff (idempotent).

NOTE: cargo test -p freshell-protocol is intentionally red at this
commit (inventory counts 28/53/81 vs regenerated 29/56); the next
commit reconciles the Rust side. Not independently mergeable.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Reconcile the Rust T0 surface (cargo GREEN)

**Files:**
- Modify: `crates/freshell-protocol/src/client_messages.rs` (~`:84`, `:115-118`)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (~`:147`, `:203-220`)
- Modify: `crates/freshell-protocol/src/lib.rs:39-40`
- Modify: `crates/freshell-protocol/tests/inventory.rs` (`:29-44`, `:46-61`, `:63-74`)
- Modify: `crates/freshell-protocol/tests/activity_extension.rs` (`:1-9` header,
  `:121-147` disjointness test)

**Interfaces:**
- Consumes: regenerated `port/contract/ws-message-inventory.json` (Task 2) — the Rust
  tests read it from disk via `CARGO_MANIFEST_DIR/../../port/contract/...`.
- Produces: `CLIENT_MESSAGE_TYPES: [&str; 29]`, `SERVER_MESSAGE_TYPES: [&str; 56]`,
  `EXTENSION_CLIENT_MESSAGE_TYPES: [&str; 0]`,
  `EXTENSION_SERVER_MESSAGE_TYPES: [&str; 1] = ["durability.degraded"]`. Tasks 4-6 and
  the CI workflow rely on `cargo test -p freshell-protocol` being green from here on.

- [ ] **Step 1: Observe the RED created by Task 2's regen**

Run: `cargo test -p freshell-protocol --locked 2>&1 | tail -30`
Expected: exactly 2 FAILURES, both in `tests/inventory.rs` —
`client_types_match_inventory_exactly` (count 28 vs 29 and/or missing
`amplifier.activity.list`) and `server_types_match_inventory_exactly` (53 vs 56).
`combined_surface_is_81` still PASSES here: it never reads the JSON inventory — it
asserts `all_message_types().len() == 81` purely from the crate constants, which are
still 28+53=81 until this task's own edits change (and rename) it in Step 4.
All other test files (`activity_extension`, `version`, `pane_reconcile`, `roundtrip`)
still pass — `version.rs` only compares the `wsProtocolVersion` scalar (still 7).
If `roundtrip.rs` or `version.rs` fail, STOP and report — that would be field-level or
version drift outside this plan's evidence base.

- [ ] **Step 2: Promote `amplifier.activity.list` into the client frozen array**

In `crates/freshell-protocol/src/client_messages.rs`
(grep: `grep -n 'CLIENT_MESSAGE_TYPES' crates/freshell-protocol/src/client_messages.rs`):

1. Change the array declaration `pub const CLIENT_MESSAGE_TYPES: [&str; 28] = [` to
   `pub const CLIENT_MESSAGE_TYPES: [&str; 29] = [` and insert
   `"amplifier.activity.list",` as an element in sorted position (before
   `"claude.activity.list"`). The inventory tests compare as sets, so position is
   cosmetic — but keep the array sorted. The array's final content must be exactly the
   29-type client list in this plan's File Structure section.
2. Replace the extension constant and its doc comment (currently `:115-118`):

```rust
/// Extension client→server discriminants declared beyond the generated
/// inventory. Empty since the 2026-07-26 contract reconciliation folded
/// `amplifier.activity.list` into the frozen surface (it has been a
/// first-class `shared/ws-protocol.ts` union member since PR #498).
pub const EXTENSION_CLIENT_MESSAGE_TYPES: [&str; 0] = [];
```

- [ ] **Step 3: Promote the three server types and shrink the server extension array**

In `crates/freshell-protocol/src/server_messages.rs`
(grep: `grep -n 'SERVER_MESSAGE_TYPES' crates/freshell-protocol/src/server_messages.rs`):

1. Change `pub const SERVER_MESSAGE_TYPES: [&str; 53] = [` to
   `pub const SERVER_MESSAGE_TYPES: [&str; 56] = [` and insert, in sorted positions:
   - `"amplifier.activity.list.response",` and `"amplifier.activity.updated",`
     (before `"claude.activity.list.response"`)
   - `"terminal.idle",` (between `"terminal.exit"` and `"terminal.input.blocked"`)

   Final content must be exactly the committed inventory's 56 `serverToClient.types`.
2. Replace the extension constant and its doc comment (currently `:203-220`):

```rust
/// Extension server→client discriminants declared BEYOND the generated
/// inventory (`port/contract/ws-message-inventory.json`). Since the
/// 2026-07-26 reconciliation the only entry is `durability.degraded` — a
/// Rust-server-only frame (P1.8 pane-identity ledger, emitted by
/// `crates/freshell-ws/src/pane_ledger.rs`) with no TypeScript
/// counterpart: the inventory is generated from `shared/ws-protocol.ts`,
/// so it cannot carry it. NOT the same family as the frozen
/// `terminal.codex.durability.updated` (codex-sidecar durability); the
/// name collision is nearest-neighbor only. If the client ever grows a
/// consumer, add the Zod schema to `shared/ws-protocol.ts`, run
/// `npm run contract:generate`, and promote this into
/// [`SERVER_MESSAGE_TYPES`]. Shape pinned by `tests/activity_extension.rs`.
pub const EXTENSION_SERVER_MESSAGE_TYPES: [&str; 1] = ["durability.degraded"];
```

- [ ] **Step 4: Update the inventory tests' hardcoded counts**

In `crates/freshell-protocol/tests/inventory.rs`:
- `28` → `29` in `client_types_match_inventory_exactly` (the
  `inv["clientToServer"]["count"]` assertion and any hardcoded-length assertion),
- `53` → `56` in `server_types_match_inventory_exactly`,
- `81` → `85` in the combined test, and rename it for honesty:

```rust
#[test]
fn combined_surface_is_85() {
```

(also update its internal `assert_eq!(all_message_types().len(), 85, ...)` and any
message-string mentions of 81).

- [ ] **Step 5: Update the extension pins in `activity_extension.rs`**

In `crates/freshell-protocol/tests/activity_extension.rs`:

1. Header comment (`:4`): replace the stale `(27+52)` phrasing with `(29+56)` and note
   the arrays are generated-current as of the 2026-07-26 reconciliation.
2. In `extension_surface_is_disjoint_from_the_frozen_inventory` (`:121-147`), replace
   the two pinned-array assertions:

```rust
    assert!(
        EXTENSION_CLIENT_MESSAGE_TYPES.is_empty(),
        "no client extension types remain after the 2026-07-26 reconciliation"
    );
    assert_eq!(EXTENSION_SERVER_MESSAGE_TYPES, ["durability.degraded"]);
```

3. Leave the four shape tests (`amplifier_activity_list_parses...`,
   `amplifier_activity_list_response_serializes...`,
   `amplifier_activity_updated_serializes...`,
   `terminal_idle_serializes_the_pinned_contract`) untouched — they pin wire shapes,
   which are unchanged. If the compiler flags an unused import after the edits, remove
   exactly that import.

- [ ] **Step 6: Fix the stale crate doc comment**

In `crates/freshell-protocol/src/lib.rs:39-40`, change

```rust
/// Every type discriminant the protocol speaks, both directions, sorted.
/// (27 client→server + 52 server→client = 79.)
```

to

```rust
/// Every type discriminant the protocol speaks, both directions, sorted.
/// (29 client→server + 56 server→client = 85.)
```

- [ ] **Step 7: GREEN — full crate test + clippy**

Run:
```bash
cargo test -p freshell-protocol --locked
cargo clippy -p freshell-protocol --all-targets -- -D warnings
```
Expected: all tests pass (inventory 3/3 incl. `combined_surface_is_85`,
activity_extension 5/5, version 5/5, pane_reconcile 10/10, roundtrip 11/11);
clippy clean.

- [ ] **Step 8: Confirm the TS side is still green (both suites now pin the SAME truth)**

Run: `npm run test:port`
Expected: `Tests  38 passed (38)`.

- [ ] **Step 9: Commit**

```bash
git add crates/freshell-protocol
git commit -m "fix(protocol): fold the drift-absorption extension buffer into the frozen T0 surface (29/56/85)

Promote amplifier.activity.list / amplifier.activity.list.response /
amplifier.activity.updated / terminal.idle from EXTENSION_*_MESSAGE_TYPES
into CLIENT/SERVER_MESSAGE_TYPES, matching the regenerated
port/contract/ws-message-inventory.json. The extension carve-out
(0736afe3) existed only to keep tests/inventory.rs green against a stale
artifact; that artifact is now current, so the buffer shrinks to the one
genuinely Rust-only frame (durability.degraded, documented promotion
path). Inventory tests pin 29/56/85; TS freeze suite and Rust T0 tests
now assert the SAME surface.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Documentation truth refresh

**Files:**
- Modify: `port/contract/README.md` (`:14` "all 52", `:59` "the 8 server→client
  messages", `:81` run instructions, plus any other stale counts found by Step 1)
- Modify: `port/contract/nondeterministic-fields.md`
- Modify: `port/machine/architecture-spec.md:287` ("all 52")
- Modify: `port/machine/STATE.yaml` (append; don't rewrite history lines `:159-161`)

**Interfaces:**
- Consumes: final counts from Tasks 2-3 (29 c2s / 56 s2c / 85 combined / 66 schemas /
  12 Zod-backed overlap; extension = `durability.degraded` only).
- Produces: docs a future agent can trust; no code contracts.

- [ ] **Step 1: Enumerate every stale count in the four files**

Run:
```bash
grep -n -E '\b(27|28|52|53|55|79|81)\b|the 8 server|all 52' \
  port/contract/README.md port/machine/architecture-spec.md | head -40
grep -n 'terminal.idle\|amplifier' port/contract/nondeterministic-fields.md
```
Expected: hits at README `:14`, `:59` and architecture-spec `:287` at minimum; the
second grep likely prints nothing (the file predates these messages).

- [ ] **Step 2: Update `port/contract/README.md`**

- Replace stale counts: "all 52" → "all 56"; "the 8 server→client messages" → "the 12
  server→client messages"; any "55 schemas" → "66 schemas"; "28 + 53" → "29 + 56".
- In the "how to run" section (around `:81`), replace the raw
  `npx vitest run --config config/vitest/vitest.port.config.ts` instruction with:

```markdown
Run the drift guard with `npm run test:port`. CI runs it on every PR via
`.github/workflows/port-contract.yml`, which also regenerates the contract
(`npm run contract:generate`) and fails on any resulting diff, and runs
`cargo test -p freshell-protocol` so the Rust T0 surface moves in lockstep.
When you change `shared/ws-protocol.ts`: run `npm run contract:generate`,
update `crates/freshell-protocol` (arrays + inventory-test counts), and
commit the regenerated `port/contract/*.json` in the same PR.
```

- [ ] **Step 3: Update `port/machine/architecture-spec.md:287`**

Change the `ws-server-messages.schema.json` bullet's "(server→client, all 52)" to
"(server→client, all 56)". Do not otherwise rewrite the ADR.

- [ ] **Step 4: Append a DONE line to `port/machine/STATE.yaml`**

Directly after the existing contract DONE lines (`:159-161`, grep:
`grep -n 'drift-guard' port/machine/STATE.yaml`), append a sibling list entry matching
the file's existing indentation/format:

```yaml
  - "DONE 2026-07-26: reconciled contract freeze to the live surface — regen 29 c2s / 56 s2c / 66 schemas (v7 unchanged); Rust EXTENSION_* buffer folded into the frozen arrays (85 combined; durability.degraded is the only extension); freeze suite wired as npm run test:port + port-contract CI (regen idempotency enforced)"
```

(The earlier "55 schemas / 52 / 8 overlapping" lines describe the as-frozen historical
state — leave them.)

- [ ] **Step 5: Add nondeterministic-field rows for the newly pinned messages**

Open `port/contract/nondeterministic-fields.md` and mirror the existing row format:

- `terminal.idle`: field `at` (epoch-ms timestamp; schema
  `shared/ws-protocol.ts:209-215` — `{terminalId, at, reason: 'grace'|'queue-empty'}`).
- `amplifier.activity.list.response` / `amplifier.activity.updated`: the amplifier
  family serializes the same legacy shape as the `claude.activity.*` family (pinned by
  `crates/freshell-protocol/tests/activity_extension.rs`
  `amplifier_activity_list_response_serializes_the_legacy_shape`). Locate the existing
  `claude.activity.list.response` / `claude.activity.updated` rows in this file and add
  identical rows for the amplifier discriminants, listing the same nondeterministic
  fields. If (and only if) the claude rows do not exist either, derive the field list
  from the regenerated `ws-server-messages.schema.json` entries for these two
  discriminants: every id/timestamp-valued field (`*Id`, `*At`, `at`) gets a row.
- `pane.reconcile.result` is already covered if a row exists (check first:
  `grep -n 'pane.reconcile' port/contract/nondeterministic-fields.md`); if absent, add
  rows for its `terminalId`/timestamp-bearing verdict fields per the same procedure.

- [ ] **Step 6: Verify nothing regressed**

Run:
```bash
npm run test:port
cargo test -p freshell-protocol --locked --test version
```
Expected: 38 passed; version tests 5/5 (docs edits can't break them — this is a cheap
guard that nobody touched JSON by hand).

- [ ] **Step 7: Commit**

```bash
git add port/contract/README.md port/contract/nondeterministic-fields.md \
        port/machine/architecture-spec.md port/machine/STATE.yaml
git commit -m "docs(port): refresh contract docs to the reconciled surface (29/56/66, 12 zod-backed)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: CI guard — `port-contract.yml` (the anti-rot wiring)

**Files:**
- Create: `.github/workflows/port-contract.yml`

**Interfaces:**
- Consumes: `npm run test:port` (Task 1), `npm run contract:generate` idempotency
  (Task 2), green `cargo test -p freshell-protocol` (Task 3).
- Produces: a required-check candidate named `port-contract` that fails any PR that
  changes `shared/ws-protocol.ts` (or the toolchain) without regenerating the contract
  and reconciling both suites.

- [ ] **Step 1: Read the existing workflows to mirror conventions**

Run:
```bash
cat .github/workflows/rust-clippy.yml .github/workflows/typecheck-client.yml
```
Note the checkout/setup-node/rust-toolchain/cache action versions, node version, and
trigger style they use. The YAML in Step 2 is the semantic content; align action
versions and the node version with what these two workflows actually use (e.g. if they
pin `actions/checkout@v4` and node 22, keep that; if they differ, follow them).

- [ ] **Step 2: Write the failing-first check — create the workflow**

Create `.github/workflows/port-contract.yml`:

```yaml
name: port-contract

on:
  push:
    branches: [main]
  pull_request:

# The WS contract must never drift silently again (it did: PR #498 era
# amplifier.activity.*, 317e2ea1 terminal.idle, eef9b344 partial regen).
# No path filter on purpose: generator output also depends on the
# typescript/zod toolchain, so lockfile bumps must run this too.
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Contract freeze suite (TS drift guard)
        run: npm run test:port

      - name: Regen idempotency (contract:generate must produce no diff)
        run: |
          npm run contract:generate
          git diff --exit-code -- port/contract

      - name: Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: Swatinem/rust-cache@v2

      - name: Rust T0 surface (freshell-protocol)
        run: cargo test -p freshell-protocol --locked
```

(Validated 2026-07-26: `rust-clippy.yml` uses `dtolnay/rust-toolchain@master` with a
**deliberate toolchain pin — `1.96.0`** (see its comment at lines 23-26) plus
`Swatinem/rust-cache@v2`, and its recent runs all succeed on push + PR; the repo's
Actions policy is `allowed_actions: "all"`. Mirror the pin: replace the
`dtolnay/rust-toolchain@stable` step above with the exact toolchain action + pinned
version rust-clippy.yml uses — mirroring the working precedent beats novelty. If Step 1
shows the file has changed since, follow what it does now.)

- [ ] **Step 3: Validate the YAML parses**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/port-contract.yml')); print('YAML OK')"
```
Expected: `YAML OK`. (If PyYAML is unavailable:
`node -e "const {load}=require('js-yaml');load(require('fs').readFileSync('.github/workflows/port-contract.yml','utf8'));console.log('YAML OK')"`.)

- [ ] **Step 4: Execute the workflow's commands locally, verbatim (CI can't run here)**

Run, from the worktree root:
```bash
npm run test:port \
  && npm run contract:generate && git diff --exit-code -- port/contract \
  && cargo test -p freshell-protocol --locked \
  && echo WORKFLOW-COMMANDS-GREEN
```
Expected: `WORKFLOW-COMMANDS-GREEN`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/port-contract.yml
git commit -m "ci: add port-contract workflow - freeze suite, regen idempotency, Rust T0 tests

The freeze suite previously ran nowhere (no npm script, excluded from the
default vitest config, unknown to the coordinator, absent from CI) and sat
red on main unnoticed; cargo test was likewise not in CI. This workflow
pins both sides of the contract seam on every PR, plus a
contract:generate + git diff --exit-code idempotency gate, following the
rust-clippy.yml precedent for cheap targeted CI.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Note for the final report: making `port-contract` a *required* branch-protection check
is a GitHub settings change the user must make; flag it, don't attempt it. Two verified
timing facts to include: the workflow will NOT run on this lane's branch push (its
triggers are `pull_request` + `push: branches: [main]`), so its first execution happens
when the user opens the PR; and GitHub only offers a check as "required" after it has
run at least once — so the branch-protection step follows the first PR run.

---

### Task 6: Final verification, stash obsolescence, lane bookkeeping, push

**Files:**
- Modify: `docs/plans/2026-07-26-port-contract-reconcile.md` (append the
  "Reconciliation outcomes" section — this file)

**Interfaces:**
- Consumes: everything above; the main checkout's `stash@{0}` (READ-ONLY).
- Produces: pushed branch `chore/port-contract-reconcile`; evidence block for the lane
  report. NO PR (not approved).

- [ ] **Step 1: Lane C2 coordination check (they may add a protocol frame/field)**

Run:
```bash
git fetch origin main --quiet
git diff --stat HEAD...origin/main -- shared/ws-protocol.ts
```
Expected: empty (lanes run in parallel from the same base; integration preflight
reconciles). If NON-empty — C2's protocol addition landed on main — do NOT rebase on
your own; note it loudly in the final report: the preflight must re-run
`npm run contract:generate` + bump the Rust counts, and the new CI workflow will hold
that gate automatically.

- [ ] **Step 2: Full coordinated suite (broad run — respect the gate; siblings may hold it)**

Run (WAIT if the coordinator gate is held — check `npm run test:status` first):
```bash
env -u FRESHELL_BIND_HOST FRESHELL_TEST_SUMMARY="C3 port-contract-reconcile: final verification" npm test
```
Expected: green (exit 0). Our diff touches nothing in the default/server configs except
a `package.json` script addition, so any failure here is either pre-existing on main or
coordinator contention — investigate before proceeding, do not hand-wave.

- [ ] **Step 3: Workspace-level Rust gates (CI-required clippy)**

Run:
```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-protocol --locked
```
Expected: both clean/green. (Full-workspace `cargo test` is not required by this lane's
diff — no `freshell-ws` code changed — and clippy is the CI-required gate.)

- [ ] **Step 4: Verify `stash@{0}` is fully obsoleted (READ-ONLY; from the MAIN checkout)**

Run:
```bash
git -C /home/dan/code/freshell stash list | head -2
# Every message type the stash ADDED must now be in our regenerated inventory:
for t in amplifier.activity.list amplifier.activity.list.response \
         amplifier.activity.updated terminal.idle; do
  grep -q "\"$t\"" port/contract/ws-message-inventory.json && echo "PINNED: $t"
done
# The stash's REMOVALS (pane.reconcile.*) must NOT have happened in ours:
grep -c 'pane.reconcile' port/contract/ws-message-inventory.json
```
Expected: 4× `PINNED: ...`; final grep prints `2`. This proves the stash's additions
are subsumed and its removals were stale → **stash@{0} is safe to drop**. Do NOT drop
it — record the verdict.

- [ ] **Step 5: Append the outcomes section to this plan document**

Append to `docs/plans/2026-07-26-port-contract-reconcile.md`:

```markdown
---

## Reconciliation outcomes (filled at execution time)

- **Decision taken:** (a) UPDATE — artifacts regenerated to 29 c2s / 56 s2c /
  66 schemas at wsProtocolVersion 7; Rust frozen surface 29/56/85 with
  EXTENSION_* reduced to ["durability.degraded"] (server) / [] (client).
- **Proof:** `npm run test:port` 38/38; `cargo test -p freshell-protocol` green;
  `npm run contract:generate` followed by `git diff --exit-code -- port/contract`
  clean (idempotent); coordinated `npm test` green; clippy -D warnings clean.
  <replace this line with the actual observed outputs/counts from Steps 2-4>
- **Anti-rot:** `npm run test:port` + `.github/workflows/port-contract.yml`
  (freeze suite + regen idempotency + cargo test -p freshell-protocol on every PR).
  FOLLOW-UP for user: mark the `port-contract` check required in branch protection.
- **stash@{0} on the main checkout:** verified fully obsoleted (its 4 additions are
  now pinned; its pane.reconcile removals were stale against bf6242a1). SAFE TO
  DROP — left in place for the user to drop.
- **B2 residual ("~20-line cleanup"):** located (codex-candidate wire-surface
  deletion, `.the-usual-logs/codex-rollout-locator/reports/codex-candidate.md:494-498`)
  but NOT applied: the legacy Node server is a live consumer
  (`server/ws-handler.ts:2951` -> `server/terminal-registry.ts:3986`) and still emits
  the trigger, so deleting the client sender changes behavior against the Node
  server — prohibited by this lane's no-behavior-change fence. FOLLOW-UP for user:
  decide alongside legacy-Node retirement. `terminal.codex.candidate.persisted`
  remains fully pinned.
- **Oracle suite (pre-execution validation finding):** `npm run test:oracle` is
  regen-NEUTRAL (identical failure set before/after regen) but NOT green at base in a
  fresh clone: 4 pre-existing failures — mutation-e2e ×2 (stale buildinfo path:
  `test/oracle/mutation-e2e.test.ts:45` clears `node_modules/.cache/...` but
  `tsconfig.server.json:12` moved buildinfo to `dist/` in `1de2258d`) and
  rust-equivalence ×2 (machine-sensitive discovery of an installed `amplifier` CLI).
  Out of this lane's scope. FOLLOW-UP for user: one-line mutation-e2e path fix as a
  separate change; do not gate anything on a fully-green oracle until then.
```

Replace the `<replace this line ...>` placeholder with the real observed evidence
before committing.

- [ ] **Step 6: Commit and push the branch — STOP before any PR**

```bash
git add docs/plans/2026-07-26-port-contract-reconcile.md
git commit -m "docs(plan): record reconciliation outcomes, stash verdict, residual disposition

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
git push -u origin chore/port-contract-reconcile
```
Expected: push succeeds. Do NOT run `gh pr create` (PR creation is not approved).
The final lane report must state: branch name, decision (a) with rationale, and the
proof lines from Step 5.

---

## Self-Review

**1. Spec coverage.**
- Investigate + decide (a/b/c) with evidence → Decision Record (evidence from three
  executed/verified exploration reports; bias applied: one source of truth, the
  dormant extension buffer deleted, red-suite-nobody-runs made impossible).
- Chosen suites GREEN on branch → Tasks 2 (TS 38/38), 3 (cargo), 6 (full re-proof).
- `contract:generate` idempotent-clean → Task 2 Step 6 + permanent CI gate (Task 5).
- Surviving suite "runs somewhere it can't rot" → Task 1 (`test:port` script) +
  Task 5 (CI workflow, clippy-workflow precedent, cheap). Coordinator-matrix wiring
  deliberately NOT attempted (non-trivial: `UpstreamPhase` union +
  `run-standard-tests.ts` hardcode) — documented as covered-by-CI instead, which the
  spec explicitly allows ("wire into npm test or CI if cheap").
- Extension messages handled consistently → both suites pin the same 29/56;
  `durability.degraded` is the single documented Rust-only extension with a promotion
  path (Task 3), justified loudly in the Decision Record.
- Residual B2 cleanup (15-min timebox) → found, verified against `bf6242a1`,
  deliberately NOT applied with loud justification (live Node consumer = behavior
  change, violating the lane's own fence); recorded for user decision (Task 6 Step 5).
  This is a justified scope decision mandated by the spec's stronger constraint, not a
  silent deferral.
- Stash@{0} obsolescence → verified with commands (Task 6 Step 4), "safe to drop"
  recorded, never touched.
- TDD: red captured (8/13, executed), each task proves green; regen-idempotency check
  added (test-form already existed in the freeze suite's byte-equality tests; the CI
  diff gate now enforces it on the real CLI path).
- Repo rules: worktree ✓, coordinated broad run with summary + gate wait (Task 6),
  cargo clippy -D warnings (Task 6), no server restarts, no broad kills, PR stop ✓.
- C2 coordination note → Task 6 Step 1.

**1b. No silent deferrals of required behavior.** No stubs/mocks anywhere — every green
is a real suite against real artifacts. The two non-applied items (B2 wire deletion,
required-check branch protection) are explicitly surfaced user decisions, not silent
deferrals, and both are outside this lane's authority (behavior change / GitHub
settings).

**2. Placeholder scan.** One intentional fill-in marker exists (Task 6 Step 5's
"<replace this line...>") and the step explicitly requires replacing it with real
observed evidence before committing — it is an evidence slot, not a plan gap. All
code steps show complete code; doc steps give exact replacement text or a concrete
locate-and-mirror procedure with the authoritative field source named.

**2b. Load-bearing validation pass (2026-07-26).** Six assumptions validated
pre-execution (see the "Load-bearing validation findings" section): generator
determinism, Rust base-green + confined post-regen red, CI actions policy \u2014 verified
by execution/inspection; the "line-level additive diff" and "oracle green at base"
assumptions were falsified and Task 2 Step 2 / Task 6 Step 5 updated accordingly (real
tolerance list enumerated; oracle finding recorded as a user follow-up, no new task
needed since the oracle is regen-neutral). Task 5 now mirrors rust-clippy.yml's
deliberate 1.96.0 toolchain pin.

**3. Type consistency.** `test:port` script name is identical in Tasks 1, 2, 4, 5, 6
and the workflow. Counts are consistent throughout: 29/56/85 (inventory+Rust),
66 schemas, 12 Zod-backed, version 7. Rust constant names
(`CLIENT_MESSAGE_TYPES`, `SERVER_MESSAGE_TYPES`, `EXTENSION_CLIENT_MESSAGE_TYPES`,
`EXTENSION_SERVER_MESSAGE_TYPES`) and test names
(`combined_surface_is_85` rename) are used consistently between Tasks 3 and 6.

---

## Reconciliation outcomes (filled at execution time)

- **Decision taken:** (a) UPDATE — artifacts regenerated to 29 c2s / 56 s2c /
  66 schemas at wsProtocolVersion 7; Rust frozen surface 29/56/85 with
  EXTENSION_* reduced to ["durability.degraded"] (server) / [] (client).
- **Proof:** `npm run test:port` 38/38; `cargo test -p freshell-protocol` green;
  `npm run contract:generate` followed by `git diff --exit-code -- port/contract`
  clean (idempotent); coordinated `npm test` green; clippy -D warnings clean.
  Observed at execution: coordinated `npm test` exit 0 (coordinator: full-suite
  success; default:test/unit=success, server:test/server=success); `cargo clippy
  --workspace --all-targets -- -D warnings` finished clean (exit 0); `cargo test
  -p freshell-protocol --locked` all green (freeze suite 11 passed, version suite
  5 passed incl. matches_message_inventory / matches_inbound_schema_bundle /
  matches_outbound_schema_bundle, 0 failed); stash check printed 4x `PINNED:`
  (amplifier.activity.list, amplifier.activity.list.response,
  amplifier.activity.updated, terminal.idle) and `grep -c 'pane.reconcile'
  port/contract/ws-message-inventory.json` = 2.
- **Anti-rot:** `npm run test:port` + `.github/workflows/port-contract.yml`
  (freeze suite + regen idempotency + cargo test -p freshell-protocol on every PR).
  FOLLOW-UP for user: mark the `port-contract` check required in branch protection.
- **stash@{0} on the main checkout:** verified fully obsoleted (its 4 additions are
  now pinned; its pane.reconcile removals were stale against bf6242a1). SAFE TO
  DROP — left in place for the user to drop.
- **B2 residual ("~20-line cleanup"):** located (codex-candidate wire-surface
  deletion, `.the-usual-logs/codex-rollout-locator/reports/codex-candidate.md:494-498`)
  but NOT applied: the legacy Node server is a live consumer
  (`server/ws-handler.ts:2951` -> `server/terminal-registry.ts:3986`) and still emits
  the trigger, so deleting the client sender changes behavior against the Node
  server — prohibited by this lane's no-behavior-change fence. FOLLOW-UP for user:
  decide alongside legacy-Node retirement. `terminal.codex.candidate.persisted`
  remains fully pinned.
- **Oracle suite (pre-execution validation finding):** `npm run test:oracle` is
  regen-NEUTRAL (identical failure set before/after regen) but NOT green at base in a
  fresh clone: 4 pre-existing failures — mutation-e2e ×2 (stale buildinfo path:
  `test/oracle/mutation-e2e.test.ts:45` clears `node_modules/.cache/...` but
  `tsconfig.server.json:12` moved buildinfo to `dist/` in `1de2258d`) and
  rust-equivalence ×2 (machine-sensitive discovery of an installed `amplifier` CLI).
  Out of this lane's scope. FOLLOW-UP for user: one-line mutation-e2e path fix as a
  separate change; do not gate anything on a fully-green oracle until then.
