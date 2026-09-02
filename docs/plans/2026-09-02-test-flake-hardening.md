# Test Flake Hardening Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
"Fix 2-3" — items 2 and 3 of the host-pressure-pane run's final-recap disclosures:

- **(2) Rust deadline-under-load test flakes.** Three tests time out only under heavy machine load and are green in isolation: `crates/freshell-ws/tests/auto_resume_e2e.rs` (2 tests, 10s frame budget + 5s polls), `crates/freshell-ws/tests/restore_spawn_gate.rs` (12 tests sharing file-local 5s per-frame helpers, 5s gate acquisitions, 1–2s bounded polls), and the `pane_ledger` lock test (`crates/freshell-ws/src/pane_ledger_tests.rs::new_locked_degrades_to_disabled_when_another_holder_exists`, proven `EWOULDBLOCK`-after-`drop(holder)` flock-release race; NOT a wall-clock deadline).
- **(3) Ambient proxy environment poisons local test runs.** When `HTTP_PROXY`/`HTTPS_PROXY` (either case) are set in the shell, every spawned Node child prints one `(node:NNN) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...` line to stderr, breaking the suite's strict-empty-stderr assertions (`test/e2e/update-flow.test.ts` ×3, `test/unit/lib/visible-first-audit-gate.test.ts` ×2). Fix the SYSTEM so no agent has to remember to strip env vars before a local test run.

### Explicit constraints
- The-usual workflow on a dedicated worktree (`the-usual/test-flake-hardening`).
- Do NOT create or open a PR until the user explicitly approves PR creation (repo rule). Prepare the branch, run all gates, land only on approval.
- Do NOT absorb, rewrite, or conflict with the in-flight `darkforge/qzka` branch (HEAD `a3505bd51`): its production pane-ledger fix chain (`9a3d74e09` etc.) stays owned by that lane. This plan touches `src/pane_ledger_tests.rs` ONLY — never `src/pane_ledger.rs`.
- Honor the merged C1 decision (commit `884fc8721`): no silent retry-masking in the pane_ledger lock test; evidence probes stay intact.

### Accepted tradeoffs and residuals
- Wider wait budgets mean a genuinely-missing WS frame fails ~30s later instead of 5–10s — the repo's accepted deflake idiom (merged precedent `f2c505e9f`: "a genuinely missing frame still fails, 20s later").
- pane_ledger's production-side "comes up loudly DISABLED" hardening remains owned by `darkforge/qzka`; this plan hardens only the flaky TEST.
- `FRESHELL_BIND_HOST` is folded into the same sanitize as the proxies (identical failure class; it already burned `vite-config.test.ts` once, whose comment says so). Safely striped at config load: the only vitest-lane test that cares manages it in-test, and e2e helpers pin it explicitly.
- Real-provider contract tests (`test/integration/real/`, opt-in) get an escape hatch from proxy-stripping because their spawned CLIs may need proxy internet egress.

**Goal:** Local full-suite test runs pass with ambient proxy vars and `FRESHELL_BIND_HOST` present, and the three flaky Rust suites tolerate heavy machine load without any weakened assertion.

**Architecture:** (1) A shared side-effect prelude imported first in all 9 vitest config files strips known shell-env poisons from `process.env` before worker pools spawn (mirroring the existing inline NODE_ENV config-top precedent), with a pure exported function unit-tested directly and a child-process behavioral test proving the UNDICI warning disappears iff the prelude loads. (2) The ws test suites adopt the repo's merged deflake idiom: one named 30s frame budget replacing scattered 5–10s timeouts, bounded polls extended to the same budget, assertions byte-identical, evidence-citing DEFLAKE comments. (3) The pane_ledger lock test converts its third construction into a bounded, fail-loud wait that retries ONLY on `EWOULDBLOCK`, keeps both evidence probes, and still fails loudly on any other errno or expiry.

**Tech Stack:** Vitest 3.2.4 configs (ESM/TS), Node 22, `tsx` child spawns; Rust workspace (`freshell-ws` crate, tokio, tokio-tungstenite, libc flock).

## Global Constraints

- Test execution via repo-owned entry points only: `npm test` / `npm run test:vitest -- ...` / `cargo test` — matching `AGENTS.md` test-coordination rules. Raw `npx vitest` is not a coordinated workflow.
- This shell exports `HTTPS_PROXY` and `FRESHELL_BIND_HOST`; that is deliberate for validating Task 1 (local runs must pass WITH them set). Still strip them for any BASELINE/base-gate reproduction receipts so attribution stays clean.
- `cargo fmt --check --all` must be clean before pushing (CI's clippy job includes a fmt gate).
- Structured-logging conventions and the repo's "fix the system over the symptom" philosophy apply; no `#[ignore]`, no retry-on-anything logic, no coverage reduction.
- `cargo test --workspace --locked` for Rust verification; strict clippy `cargo clippy --workspace --locked --all-targets -- -D warnings` for the final gate.
- pane_ledger tests file lives in the `freshell-ws` crate (`src/pane_ledger_tests.rs`, wired in via `pane_ledger.rs:1026-1027` `#[path] mod tests`), not freshell-server.
- Evidence explorers' reports (authoritative line references):
  - `/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/rust-flake-explore.md`
  - `/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/proxy-env-explore.md`

---

### Task 1: Strip ambient-env poisons in a shared vitest-config prelude

**Files:**
- Create: `config/vitest/sanitize-test-env.ts`
- Create: `test/unit/config/sanitize-test-env.test.ts`
- Create: `test/unit/config/fixtures/sanitize-env-child.ts`
- Modify: `config/vitest/vitest.config.ts` (line 1), `config/vitest/vitest.server.config.ts`, `config/vitest/vitest.electron.config.ts`, `config/vitest/vitest.port.config.ts`, `config/vitest/vitest.oracle.config.ts`, `config/vitest/vitest.oracle-t2.config.ts`, `config/vitest/vitest.codex-real-provider-smoke.config.ts`, `config/vitest/vitest.opencode-serve-real-provider-smoke.config.ts`, `test/e2e-browser/vitest.config.ts` — one import line each
- Modify: `AGENTS.md` (Test Coordination section) — one line noting the sanitization
- Test: `test/unit/config/sanitize-test-env.test.ts`

**Interfaces:**
- Consumes: nothing repo-internal (no dependencies; pure `process.env` manipulation)
- Produces: `AMBIENT_ENV_POISONS: readonly string[]` and `stripAmbientEnvPoisons(env?: Pick<NodeJS.ProcessEnv, ...>): string[]` — the latter optional only for the behavioral fixture; configs import the module for its side effect.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/config/sanitize-test-env.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import { createRequire } from 'node:module'
import { AMBIENT_ENV_POISONS, stripAmbientEnvPoisons } from '../../../config/vitest/sanitize-test-env'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const tsxCli = require.resolve('tsx/cli')
const fixture = path.resolve(process.cwd(), 'test/unit/config/fixtures/sanitize-env-child.ts')

// A poisoned env: proxies + FRESHELL_BIND_HOST, as this shell exports them.
const POISONED_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  FRESHELL_BIND_HOST: '0.0.0.0',
}

async function runFixture(mode: 'plain' | 'clean', env: NodeJS.ProcessEnv) {
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, fixture, mode], { env: { ...env }, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout) as { innerStderr: string; envReport: Record<string, string | undefined> }
}

describe('stripAmbientEnvPoisons (pure function)', () => {
  it('removes every poison key and returns the removed names', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, KEEP_ME: 'yes' }
    const removed = stripAmbientEnvPoisons(env)
    for (const key of AMBIENT_ENV_POISONS) expect(env[key]).toBeUndefined()
    expect(env.KEEP_ME).toBe('yes')
    expect(new Set(removed)).toEqual(new Set(Object.keys(POISONED_ENV)))
  })

  it('is a no-op (removes nothing) when the real-provider-contracts escape hatch is set', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, FRESHELL_RUN_REAL_PROVIDER_CONTRACTS: '1' }
    const removed = stripAmbientEnvPoisons(env)
    expect(removed).toEqual([])
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
  })
})

describe('sanitize-test-env prelude (behavioral, via spawned node children)', () => {
  it('WITHOUT the prelude, a node child under poisoned env does print the UNDICI warning (pins the external mechanism)', async () => {
    const { innerStderr } = await runFixture('plain', POISONED_ENV)
    expect(innerStderr).toContain('[UNDICI-EHPA]')
  })

  it('WITH the prelude loaded, the spawned node child has no poisoned vars and no stderr noise', async () => {
    const { innerStderr, envReport } = await runFixture('clean', POISONED_ENV)
    expect(innerStderr).toBe('')
    for (const key of AMBIENT_ENV_POISONS) expect(envReport[key]).toBeUndefined()
  })
})
```

Create the fixture `test/unit/config/fixtures/sanitize-env-child.ts`:

```ts
// Fixture for sanitize-test-env.test.ts. `argv[2]` = 'plain' | 'clean'.
// In 'clean' mode it applies the shared sanitize to its OWN env — exactly what
// importing config/vitest/sanitize-test-env.ts at config load does — then spawns
// an inner plain `node -e` child and reports the inner child's stderr verbatim.
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (mode === 'clean') {
  const { stripAmbientEnvPoisons } = await import('../../../../config/vitest/sanitize-test-env.js')
  stripAmbientEnvPoisons(process.env)
}

const inner = spawnSync(process.execPath, ['-e', "process.stdout.write('inner alive')\n"], { encoding: 'utf8' })
const envReport: Record<string, string | undefined> = {}
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'FRESHELL_BIND_HOST']) {
  envReport[key] = process.env[key]
}
process.stdout.write(JSON.stringify({ innerStderr: inner.stderr ?? '', envReport }))
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts`

Expected: FAIL because `config/vitest/sanitize-test-env` does not exist yet (module resolution error). Do NOT proceed if the failure is a syntax or fixture-layout accident — fix the test/fixture so the ONLY failure is the missing module.

- [ ] **Step 3: Add the minimal production implementation**

Create `config/vitest/sanitize-test-env.ts`:

```ts
// Shared ambient-env sanitizer, imported FIRST by every vitest config in this
// repo (side effect). Vitest hoists imports to the top of each config module
// and loads configs in the main process before worker pools spawn, so the
// deletion here reaches every test worker — and therefore every child process
// a test spawns (children inherit the worker's env). This mirrors the existing
// inline NODE_ENV-mutation precedent at the top of six of the configs.
//
// Why these vars:
//  - HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy: an ambient shell proxy makes
//    EVERY spawned Node child print
//      (node:NNN) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...
//    on stderr, which fails the suite's strict-empty-stderr assertions
//    (test/e2e/update-flow.test.ts, test/unit/lib/visible-first-audit-gate.test.ts).
//  - FRESHELL_BIND_HOST: same shell-env-leak class; an ambient 0.0.0.0 silently
//    flips test-spawned servers off loopback (this already burned
//    test/unit/vite-config.test.ts, which self-manages it in-test).
//
// Escape hatch: the opt-in real-provider contract tests
// (FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, test/integration/real/) spawn real
// CLI binaries that reach the internet; on a host whose only egress is a proxy,
// stripping would break them, so the strip is skipped when that flag is set.

export const AMBIENT_ENV_POISONS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'FRESHELL_BIND_HOST',
] as const

export function stripAmbientEnvPoisons(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS) return []
  const removed: string[] = []
  for (const key of AMBIENT_ENV_POISONS) {
    if (key in env) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed
}

stripAmbientEnvPoisons()
```

Then add, as the FIRST import line of each of the 9 configs (before the inline NODE_ENV blocks, mirroring their role):

- `config/vitest/vitest.config.ts` etc. → `import './sanitize-test-env'`
- `test/e2e-browser/vitest.config.ts` → `import '../../config/vitest/sanitize-test-env'`

(Add a one-line comment above the import in each: `// Strip ambient shell env (proxies, FRESHELL_BIND_HOST) before anything else — see sanitize-test-env.ts.`)

Add to `AGENTS.md` in the Test Coordination section, one line:

> Ambient proxy vars (`HTTP(S)_PROXY`, either case) and `FRESHELL_BIND_HOST` are stripped at vitest config load by `config/vitest/sanitize-test-env.ts`; local test runs do not need env pre-stripping.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts`

Expected: PASS (4 tests). Note: run this WITHOUT stripping ambient env — the poisoned env is supplied by the test itself via spawn env, so shell state is irrelevant.

- [ ] **Step 5: Refactor while green**

Confirm no duplication beyond the config import line; confirm the two real-provider smoke configs (which exist for the escape-hatch lane) also import the prelude (the escape hatch is env-driven, not config-exclusion). No other refactor expected.

- [ ] **Step 6: Run impacted-test verification**

The prelude alters `process.env` for EVERY vitest run. Impacted set = the two known strict-stderr files, plus the vite-config test that self-manages `FRESHELL_BIND_HOST`, plus the e2e-browser helper config's tests. Then prove the headline property: run the previously-RED base-gate suite file with ambient proxies deliberately SET (simulated here, since the current shell exports proxies already):

Run:
```
npm run test:vitest -- run test/unit/lib/visible-first-audit-gate.test.ts test/unit/vite-config.test.ts test/unit/config/sanitize-test-env.test.ts
npm run test:vitest -- run test/e2e/update-flow.test.ts
```

Expected: PASS with the shell's ambient proxies NOT stripped (assert `echo $HTTPS_PROXY` is non-empty first — if empty, export one before running).

- [ ] **Step 7: Commit the task**

```bash
git add config/vitest/ test/unit/config/ test/e2e-browser/vitest.config.ts AGENTS.md
git commit -m "test(env): sanitize ambient proxy + FRESHELL_BIND_HOST at vitest config load"
```

---

### Task 2: Load-tolerant deadlines for `auto_resume_e2e` and `restore_spawn_gate`

**Files:**
- Modify: `crates/freshell-ws/tests/common/mod.rs` (frame-read helpers at ~:936 handshake loop, `next_frame_of_type` ~:1100)
- Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs` (:163, :252 10s budgets; :193, :205 5s polls; 500ms negative window stays)
- Test: the suites themselves (no new behavioral tests — deflake certification instead, see Step 6)

**Interfaces:**
- Consumes: existing `wait_frame_matching`, `next_frame_of_type`, `connect_and_*` helpers; `SpawnGate`.
- Produces: `pub const FRAME_BUDGET: Duration = Duration::from_secs(30)` in `common/mod.rs`, used by both suites' frame/poll waits.

No production Rust code changes in this task.

- [ ] **Step 1: Enumerate every deadline site (RED-equivalent)**

This task has no new failing test to write (the flake only manifests under load); the repo's merged deflake idiom (`f2c505e9f`, `f451871d0`, `dcd7baad2`) explicitly uses "widen the budget, assertions unchanged, certify with evidence runs" instead of RED/GREEN for this class. Enumerate the complete site list first so nothing is missed:

Run:
```
rg -n "from_secs\(|from_millis\(" crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/restore_spawn_gate.rs
rg -n "from_secs\(5\)|from_millis\(5\)" crates/freshell-ws/tests/common/mod.rs
```

Expected: every hit mapped onto one of: (a) widened to `FRAME_BUDGET`, (b) kept by documented reason (the 500ms negative-window sleep — load-safe direction; the server-side `hello_timeout_ms: 5_000` — proven not to be a flake factor, noted in plan), or (c) poll intervals (5–25ms sleeps — kept).

- [ ] **Step 2: Add the shared budget constant**

In `crates/freshell-ws/tests/common/mod.rs` (near the top, before the helpers):

```rust
/// Frame-receive / poll budget for the WS e2e suites. DEFLAKE (the-usual
/// test-flake-hardening): `auto_resume_e2e` and `restore_spawn_gate` flaked at
/// 5–10s budgets only under heavy machine load (evidence: run-state receipts
/// of the 2026-09 host-pressure-pane run; f3wp prior art f2c505e9f). Assertions
/// are unchanged; only the wait budget grew — a genuinely missing frame still
/// fails, ~25s later.
pub const FRAME_BUDGET: Duration = Duration::from_secs(30);
```

Then route the 5s per-frame `tokio::time::timeout(Duration::from_secs(5), ws.next())` reads inside THIS file's helpers (the handshake loop in the connect helpers, `next_frame_of_type`, and any others found in Step 1) through `FRAME_BUDGET`.

- [ ] **Step 3: Widen `auto_resume_e2e.rs`**

Replace:
- :163 and :252 `Duration::from_secs(10)` → `common::FRAME_BUDGET` (the one 10s Instant budget shared by the recovering+replaced waits);
- :193 and :205 `Duration::from_secs(5)` poll deadlines → `common::FRAME_BUDGET` (same 25ms interval; deadline-from-budget);
- keep the 500ms negative-window sleep and `hello_timeout_ms: 5_000` unchanged, each with a brief DEFLAKE comment noting the decision and citing the evidence receipts.

- [ ] **Step 4: Widen `restore_spawn_gate.rs`**

In its file-local helpers (`connect_and_hello`'s handshake loop, `next_json_of_type`, `next_close_frame`, `next_json_of_type_failing_on_output` — per explorer inventory at :201, :220, :241, :260): `Duration::from_secs(5)` → `common::FRAME_BUDGET`. The two test-side `gate.acquire(Duration::from_secs(5), ...)` (~:402, ~:438) → `common::FRAME_BUDGET`. The nine 1–2s bounded counter polls (`for _ in 0..400 { ...; sleep(5ms) }` shape, e.g. the observed-queued poll) → deadline polls bounded by `common::FRAME_BUDGET` keeping the 5–10ms intervals, with the final assert after the loop unchanged. Every changed site gets the same one-line DEFLAKE pointer as the constant.

Import: `use super::common::FRAME_BUDGET;` is wrong for an integration test (a `tests/*.rs` binary) — use `use common::FRAME_BUDGET;` (these files already do `mod common;` / `use common::...`). Adjust per existing imports in the file.

- [ ] **Step 5: Refactor while green**

If `restore_spawn_gate.rs`'s file-local helpers now duplicate `common/mod.rs` helpers byte-for-byte after the widening (`next_json_of_type` ≈ `common::next_frame_of_type`), do NOT unify them in this task (out of scope, extra diff; leave for a later cleanup). Note this in the task report instead.

- [ ] **Step 6: Certification (deflake convention)**

Run, in order:
1. Focused green: `cargo test -p freshell-ws --locked --test auto_resume_e2e --test restore_spawn_gate` — Expected: all 14 tests PASS.
2. Repeated certification (the f3wp convention): `for i in $(seq 1 10); do cargo test -p freshell-ws --locked --test auto_resume_e2e --test restore_spawn_gate 2>&1 | tail -3; done` and log the 10/10 outcome to `/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/task2-certify.log`.

Expected: 10/10 iterations green.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/tests/common/mod.rs crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/restore_spawn_gate.rs
git commit -m "test(freshell-ws): widen ws-e2e frame/poll budgets to a shared 30s (load-deflake)"
```

---

### Task 3: Bounded fail-loud EWOULDBLOCK wait in the pane_ledger lock test

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs` (`new_locked_degrades_to_disabled_when_another_holder_exists`, :146-209 — ONLY its third-construction segment)
- Test: the existing test itself; certification loop in Step 4

**Interfaces:**
- Consumes: `PaneLedger::new_locked`, `PaneLedger::acquire_store_lock` (private, same-module test access), the two existing evidence probes (kept byte-identical).
- Produces: a module-private test helper `wait_for_third_locked_ledger(root: &Path, budget: Duration) -> PaneLedger` inside `src/pane_ledger_tests.rs`.

No production code changes. No new asserts added to production paths.

- [ ] **Step 1: Document intent (comment-only prelude)**

In the same DEFLAKE comment block above the test, append one paragraph:

```
// DEFLAKE-2 (the-usual test-flake-hardening): the proven flake signature is
// errno=11 EWOULDBLOCK at the THIRD acquire: the dropped holder's flock can
// remain kernel-held for a tick. The third construction is therefore replaced
// by a bounded wait that retries ONLY on EWOULDBLOCK — any other errno (or
// budget expiry) panics with the same evidence, and the loser-construction
// single-writer property above stays one-shot and untouched, preserving the
// C1 no-retry-masking decision for everything the retry does not cover.
```

- [ ] **Step 2: Implement the bounded wait (RED/GREEN not applicable — see plan intro to Task 2; this is the same flake class)**

Add to `src/pane_ledger_tests.rs`:

```rust
/// Bounded, fail-loud wait for the kernel to release the dropped holder's
/// flock: retries ONLY on EWOULDBLOCK; panics with errno+kind on anything
/// else; panics with the last errno evidence on budget expiry. Preserves the
/// C1 decision: this is not retry-masking a second writer (that property is
/// asserted separately on the loser construction above) — it waits ONLY on
/// the proven vapor-lock mechanism.
#[cfg(unix)]
fn wait_for_third_locked_ledger(root: &std::path::Path, budget: std::time::Duration) -> PaneLedger {
    let deadline = std::time::Instant::now() + budget;
    loop {
        match PaneLedger::acquire_store_lock(root) {
            Ok(lock) => {
                drop(lock); // release before constructing the real ledger
                return PaneLedger::new_locked(Some(root.to_path_buf()));
            }
            Err(err) => {
                let errno = err.raw_os_error();
                match errno {
                    Some(code) if code == libc::EWOULDBLOCK => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "flock still EWOULDBLOCK (errno={code}) after {budget:?} — the proven flake \
                             mechanism persisted past the bounded wait (fossils family: pane-ledger-test-lock-*)"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                    _ => panic!(
                        "acquire_store_lock failed after holder drop: errno={errno:?} kind={:?} \
                         (ENOSPC/EMFILE/EACCES => resource pressure, H1)",
                        err.kind()
                    ),
                }
            }
        }
    }
}
```

Then replace the segment from `let next = PaneLedger::new_locked(...)` in the test with:

```rust
let next = wait_for_third_locked_ledger(&root, std::time::Duration::from_secs(10));
assert!(
    next.ever_bound("claude", "s1"),
    "third new_locked came up blind … (existing assertion text unchanged)"
);
```

Evidence probes 1 and 2 and their panics stay byte-identical. The one-shot probe-2 acquire remains (it is the diagnostic one-shot; the bounded wait follows it).

- [ ] **Step 3: Focused verification**

Run:
```
cargo test -p freshell-ws --locked pane_ledger
cargo fmt --check
```

Expected: the lock test + all pane_ledger tests PASS; fmt clean for the touched files.

- [ ] **Step 4: Certification**

Run: `for i in $(seq 1 20); do cargo test -p freshell-ws --locked pane_ledger 2>&1 | tail -2; done | tee /home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/task3-certify.log | rg -c "test result: ok"`

Expected: 20 lines (one per iteration), i.e. 20/20 green.

- [ ] **Step 5: Run impacted-test verification**

This is a test-only change inside one file of the freshell-ws lib binary: run the whole freshell-ws lib test module plus the touchpoint suites.

Run: `cargo test -p freshell-ws --locked`

Expected: ALL PASS.

- [ ] **Step 6: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "test(freshell-ws): bounded fail-loud EWOULDBLOCK wait for the pane_ledger lock-test third construction"
```

---

### Final Integration Gate (run at the end, at final HEAD)

In the worktree, with ambient proxy env NOT stripped (that is the Task 1 property under test — assert `$HTTPS_PROXY` non-empty first):

1. `npm run typecheck` — exit 0.
2. `npm run lint` — 0 errors (pre-existing warnings unchanged: 12).
3. Coordinated full suite `FRESHELL_TEST_SUMMARY=the-usual-test-flake-hardening-final npm test` **with proxies ambient** — green. (This replaces the old "-u" ceremony; the baseline ledger's ambient-proxy failure receipt is the regression baseline.)
4. `cargo test --workspace --locked` — green.
5. `cargo clippy --workspace --locked --all-targets -- -D warnings` — green; `cargo fmt --check --all` — clean.
6. Contract regen: `cd crates/freshell-protocol && cargo run --locked --bin contract-regen && git diff --exit-code src/port-contract.rs` (evidence: `[contract] wrote ... 2970 lines ... 211 types + 45 normalized paths`).
7. `npm run build` — exit 0.
8. E2e: not required (test-infrastructure-only change; no user-facing behavior; e2e helpers manage their own env), recorded as a deliberate skip.
