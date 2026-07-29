# Capture-Time Coverage Gate for deploy-tab-diff.sh Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make `scripts/deploy-tab-diff.sh capture` halt (distinct exit code 4) when the state it just captured has running terminals covered by no persisted snapshot pane — so the operator learns BEFORE the restart, not after the PTYs are already dead — with an explicit `--allow-uncovered` informed-consent override.

**Architecture:** The coverage jq that today lives only in the `verify` subcommand (lines 196–212) moves into a single shared bash function `uncovered_terminals()`. `verify` keeps its exact decision and output (defense in depth); `capture` gains a new gate that runs the same function against the artifact it just wrote — the artifact is ALWAYS written first (it's needed for diagnosis), the gate only decides the exit status and prints an operator-friendly, enriched terminal list. Tests are Vitest (node env, inside `npm test`) exercising the real script end-to-end with a fake `curl` on `PATH` — the repo's established idiom for testing this exact script.

**Tech Stack:** bash + curl + jq (the script); Vitest 3 under `config/vitest/vitest.server.config.ts` (the tests); `node:child_process` `execFile` to run the script.

## Global Constraints

Copied from the task spec and repo rules — every task's requirements implicitly include these:

- Work happens in the worktree `/home/dan/code/freshell/.worktrees/capture-coverage-gate` (branch `fix/capture-coverage-gate`, from `origin/main`). All commands below run from that directory.
- The script stays **bash only**, requiring only `curl` + `jq` (as today).
- Keep the script's existing conventions: `set -euo pipefail`; **explicit** curl/jq status checks (`if ! cmd; then echo ERROR >&2; ...; fi` — never rely on `set -e` through `if`/process substitution); **never `--argjson` for large docs** (temp file + `--slurpfile`); NUL-delimited device ids untouched.
- The script is **READ-ONLY against the server (GETs only)** — no new endpoints, no writes.
- Exit codes: `0` ok, `1` operational failure/divergence, `2` usage, `3` internal-only (incoherent capture, consumed by the retry wrapper) — all unchanged. **NEW: `4` = capture coverage gap** ("capture succeeded but restore will lose terminals"), distinct from `1` ("capture is unusable").
- `verify`'s coverage guard keeps its **exact decision and output format** (the pinning tests in Task 1 make this byte-precise).
- Tests are fully self-contained: fake `curl` on `PATH` + canned fixture files. **Never** contact the live server (ports 3001/3002) from tests. No real network at all (`--url http://unused.invalid`).
- Vitest conventions: import `describe/it/expect` explicitly from `'vitest'` (no globals); relative imports need `.js` suffixes (NodeNext/ESM) — this test file has none, it only imports `node:` builtins and `vitest`; tests must be order-independent (`sequence.shuffle: true`) and finish inside the 30 s `testTimeout`; temp dirs via `mkdtemp` with `finally` cleanup.
- Test file lives under `test/unit/server/` so the server Vitest config (node env) picks it up and it runs inside the coordinated `npm test`.
- Coordinated commands only for broad runs: `npm test` / `npm run check`; focused runs via `npm run test:vitest -- run <file> --config config/vitest/vitest.server.config.ts`. Set `FRESHELL_TEST_SUMMARY` for broad runs.
- Red-Green-Refactor TDD for every behavior change. Frequent, focused commits.
- Do NOT open a PR, do NOT merge, do NOT restart or deploy anything. Stop when the branch is complete and verified.
- README.md untouched; no new end-user markdown (this plan under `docs/plans/` is a working/agent doc).
- Column-0 `#` comments in the script leak into `--help` output (`grep '^#' "$0"`). New function documentation goes INSIDE function bodies (indented) so `--help` stays usage-focused; the usage header itself is updated deliberately in Task 4.
- The existing Playwright spec `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts` must not regress. Analysis: its offline verify test only exercises `verify` (unchanged behavior); its capture tests either succeed with full coverage (live happy path) or fail before the new gate (churn / mv-fault exit 1 before the artifact is published). No edits to it are needed. Running it requires the heavy `rust-chromium` Playwright project and is NOT required for this branch; the Vitest suite is the gate.

---

## File Structure

| File | Role |
|---|---|
| `scripts/deploy-tab-diff.sh` (modify) | The script. Gains: shared `uncovered_terminals()` function (coverage jq's single home), `report_uncovered()` (capture's enriched stderr report), `ALLOW_UNCOVERED` flag parsing, the capture-side coverage gate (exit 4), and an updated usage header + usage line. |
| `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (create) | All new automated coverage. Runs the real script via `execFile` with a fake `curl` prepended to `PATH` (the repo's established bash-script test idiom, borrowed from `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts`). Grown across Tasks 1, 3, 4. |
| `docs/plans/2026-07-29-capture-coverage-gate.md` (this file) | Working plan document. |

Line numbers below refer to the current `scripts/deploy-tab-diff.sh` at branch base (`4c04dc9c`, 296 lines).

---

### Task 1: Test harness + pinning tests for verify's coverage guard

**Files:**
- Create: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts`

**Interfaces:**
- Consumes: `scripts/deploy-tab-diff.sh` as-is (unmodified).
- Produces (relied on by Tasks 3 and 4, which append to this file): the helpers `runScript(args, env)`, `term(...)`, `pane(...)`, `openRecord(...)`, `captureDoc(...)`, `makeAbortCurl(tmp)` — exact signatures in the code below.

**Why these tests start GREEN:** they are characterization (pinning) tests that freeze `verify`'s guard decision and byte-exact output BEFORE Task 2 refactors the jq into a shared function. They are the TDD refactor safety net; the genuinely RED cycles come in Tasks 3 and 4. The assertions are byte-exact copies of the script's current output (line 209: the `FAIL:` header; line 210: the `  - <id>` lines), so any accidental format drift during the refactor fails them.

- [ ] **Step 1: Write the test file with harness + two verify pinning tests**

Create `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` with exactly:

```ts
// Pins + extends the coverage guard of scripts/deploy-tab-diff.sh.
//
// WHY THIS EXISTS (2026-07-29 incident): the coverage guard -- "which running
// terminals are covered by NO persisted snapshot pane" -- used to live ONLY in
// `verify`, i.e. AFTER the restart, when the uncovered PTYs are already dead.
// 9 of 28 running terminals were killed that way. This suite (a) pins verify's
// guard byte-exactly so the shared-function refactor cannot drift it, and
// (b) drives the new capture-time gate (exit 4, --allow-uncovered).
//
// Harness idiom (fake `curl` on PATH, exit 99 == network call happened) is
// borrowed from test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts -- the
// established way to test this script hermetically. Everything here is
// self-contained: no server, no real network, mkdtemp + finally cleanup.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
// Resolve from this file, not cwd: vitest workers do not guarantee repo-root cwd.
const SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../scripts/deploy-tab-diff.sh',
)

async function runScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(SCRIPT, args, {
      env: { ...process.env, ...env },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// --- capture-shaped fixture builders (shape mirrors the script's artifact:
// {capturedAt, url, devices:{id:{deviceId,records}}, terminals:[], bundles}) ---
const term = (
  terminalId: string,
  status: 'running' | 'exited',
  extra: Record<string, unknown> = {},
) => ({ terminalId, status, ...extra })

const pane = (paneId: string, liveTerminalId: string | null, mode = 'shell') => ({
  paneId,
  kind: 'terminal',
  payload: {
    mode,
    sessionRef: null,
    liveTerminal: liveTerminalId ? { terminalId: liveTerminalId } : null,
  },
})

const openRecord = (tabKey: string, panes: unknown[]) => ({
  status: 'open',
  tabKey,
  tabName: `Tab ${tabKey}`,
  panes,
})

const captureDoc = (terminals: unknown[], records: unknown[]) => ({
  capturedAt: 1000,
  url: 'http://unused.invalid',
  devices: { 'dev-1': { deviceId: 'dev-1', records } },
  terminals,
  bundles: { 'dev-1': { components: ['g-1'], capturedAt: 10 } },
})

// Fake curl that aborts (exit 99) on ANY invocation: proves the code path
// under test performs zero network I/O.
async function makeAbortCurl(tmp: string) {
  const binDir = path.join(tmp, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(
    path.join(binDir, 'curl'),
    '#!/usr/bin/env bash\necho "NETWORK CALL (curl) during offline verify" >&2\nexit 99\n',
    { mode: 0o755 },
  )
  return binDir
}

describe('deploy-tab-diff verify coverage guard (pinned: decision + output must not change)', () => {
  it('FAILs (exit 1) listing every uncovered running terminal as bare "  - id" lines', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      // term-covered: running + covered by a pane. term-orphan: running,
      // covered by NOTHING. term-done: exited -> must NOT be flagged.
      const doc = captureDoc(
        [
          term('term-covered', 'running'),
          term('term-orphan', 'running'),
          term('term-done', 'exited'),
        ],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(1)
      expect(r.code).not.toBe(99) // offline mode made zero network calls
      expect(r.out).not.toContain('NETWORK CALL')
      // Byte-exact header (script line "FAIL: ${n} running terminal(s)..."):
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // verify's list is bare ids by contract -- NOT the enriched capture format.
      expect(r.out).toMatch(/^ {2}- term-orphan$/m)
      expect(r.out).not.toMatch(/^ {2}- term-covered$/m)
      expect(r.out).not.toContain('term-done')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('passes the guard and reports OK (exit 0) when every running terminal is covered', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      const doc = captureDoc(
        [term('term-covered', 'running')],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      // --after = same file: identity diff is trivially clean, so this exits 0
      // only if the coverage guard passed.
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('OK: every previously-live pane came back with the same session identity.')
      expect(r.out).not.toContain('FAIL')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the tests — expect PASS (they pin current behavior)**

Run:
```bash
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: `2 passed`. If either fails, the fixture shape is wrong — fix the fixture (compare against the artifact shape in `scripts/deploy-tab-diff.sh` lines 107–114), do NOT touch the script in this task.

- [ ] **Step 3: Typecheck the new test file**

Run: `npm run typecheck`
Expected: clean exit (no new errors).

- [ ] **Step 4: Commit**

```bash
git add test/unit/server/deploy-tab-diff-coverage-gate.test.ts
git commit -m "test(deploy-tab-diff): pin verify coverage guard before refactor"
```

---

### Task 2: Extract the coverage jq into shared `uncovered_terminals()`

**Files:**
- Modify: `scripts/deploy-tab-diff.sh` (insert function after line 132; replace verify guard at lines 196–212)
- Test: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (no edits — Task 1's pinning tests are the net)

**Interfaces:**
- Consumes: nothing new.
- Produces: bash function `uncovered_terminals FILE` — prints the terminalId of every `.status=="running"` entry of `.terminals[]` in the capture-shaped JSON `FILE` that is covered by no `.payload.liveTerminal.terminalId` of any pane of any `status=="open"` record across `.devices`; one id per line on stdout; empty output means full coverage; returns jq's exit status. Task 3's capture gate calls this exact function.

This is a pure refactor: the jq program moves verbatim from the verify arm into the function. Behavior is protected by Task 1's byte-exact pinning tests.

- [ ] **Step 1: Insert the shared function**

In `scripts/deploy-tab-diff.sh`, immediately after the closing `}` of `fetch_state_coherent` (line 132) and before `case "$CMD" in` (line 134), insert:

```bash
uncovered_terminals() {
  # THE coverage check, shared by capture (pre-restart gate) and verify
  # (post-restart defense in depth) -- single home so the two call sites can
  # never diverge. Emits the COMPLETE set of running terminals in the
  # capture-shaped JSON file $1 that are covered by NO persisted open-tab
  # snapshot pane, one terminalId per line (empty output == full coverage).
  # Returns jq's status; callers must check it explicitly (:2544 convention).
  # NOTE (docs indented on purpose): column-0 comments leak into --help.
  # `. as $t | ($covered | index($t))` binds the id BEFORE indexing -- piping
  # into `$covered` would rebind `.` to the array and search it for ITSELF
  # (the :2563 scoping bug); do not "simplify" it.
  jq -r '
    ([.terminals[] | select(.status=="running") | .terminalId]) as $live
    | ([.devices | to_entries[] | .value.records // [] | .[]
         | select(.status=="open") | .panes // [] | .[]
         | .payload.liveTerminal.terminalId | select(. != null)]) as $covered
    | [ $live[] | select(. as $t | ($covered | index($t)) == null) ] | .[]' "$1"
}
```

- [ ] **Step 2: Replace verify's inline guard with a call to the function**

In the `verify` arm, replace lines 196–212 (the comment block starting `# Coverage guard (:2559): compute the COMPLETE set...` through the closing `fi` of `if [[ -n "$uncovered" ]]`) with:

```bash
    # Coverage guard (:2559): the coverage jq lives in the shared
    # uncovered_terminals helper above. Kept in verify as DEFENSE IN DEPTH:
    # a before-file produced by an older script version or by an operator-
    # overridden capture must still be flagged here, before the identity
    # diff. Decision and output format are unchanged (pinned by
    # test/unit/server/deploy-tab-diff-coverage-gate.test.ts).
    if ! uncovered=$(uncovered_terminals "$BEFORE"); then
      echo "ERROR: computing coverage guard failed" >&2; cleanup; exit 1; fi
    if [[ -n "$uncovered" ]]; then
      n=$(printf '%s\n' "$uncovered" | grep -c .)
      echo "FAIL: ${n} running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):" >&2
      printf '%s\n' "$uncovered" | sed 's/^/  - /' >&2
      cleanup; exit 1
    fi
```

(The only behavior delta is on a malformed `$BEFORE`: previously a raw jq failure aborted via `set -e` with jq's status and no `cleanup`; now it prints an ERROR, cleans up, and exits 1 — an alignment with the script's explicit-status-check convention. The guard's decision and output on valid input are byte-identical.)

- [ ] **Step 3: Syntax-check the script**

Run: `bash -n scripts/deploy-tab-diff.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Run the pinning tests — must stay GREEN**

Run:
```bash
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: `2 passed`. Any failure means the refactor drifted the guard — fix the script until byte-identical, never the tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-tab-diff.sh
git commit -m "refactor(deploy-tab-diff): extract shared uncovered_terminals coverage function"
```

---

### Task 3: Capture-time coverage gate (exit 4) + `--allow-uncovered` override

**Files:**
- Modify: `scripts/deploy-tab-diff.sh` (flag init line 14; parser lines 15–25; new `report_uncovered()` after `uncovered_terminals()`; gate block at end of the capture arm, after line 178)
- Test: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (append capture tests)

**Interfaces:**
- Consumes: `uncovered_terminals FILE` from Task 2; test helpers `runScript`/`term`/`pane`/`openRecord` from Task 1.
- Produces:
  - bash function `report_uncovered STATE_FILE SEVERITY UNCOVERED_IDS` — prints to stderr a `${SEVERITY}: ${n} running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):` header followed by one `  - <terminalId> (mode=<m>, cwd=<c>, title=<t>)` line per id (enriched from `STATE_FILE`'s `.terminals[]`; missing fields print `?`; on any enrichment failure falls back to bare `  - <id>` lines). `SEVERITY` is the literal word `FAIL` or `WARNING`. `UNCOVERED_IDS` is the newline-separated output of `uncovered_terminals`.
  - global `ALLOW_UNCOVERED` (bash `true`/`false` string, default `false`), set by the `--allow-uncovered` flag (no argument).
  - Exit code `4` from `capture` when uncovered terminals exist and `--allow-uncovered` was not passed. Task 4 documents both.
  - Test helper `makeRoutedCurl(tmp, fixtures)` and fixture constants `INDEX`, `DEVICE(records)` (code below) — Task 4 does not need them, but they live in this file.

- [ ] **Step 1: Write the failing tests (RED)**

Append to `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (after the existing `describe` block):

```ts
// --- capture-side fixtures: a URL-routed fake curl serving canned responses.
// Route on the URL (curl's last argv), not call order: capture fetches the
// index twice (coherence re-check) and identical content keeps it coherent.
async function makeRoutedCurl(
  tmp: string,
  fixtures: { index: unknown; device: unknown; terminals: unknown },
) {
  const binDir = path.join(tmp, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const indexFile = path.join(tmp, 'fixture-index.json')
  const deviceFile = path.join(tmp, 'fixture-device.json')
  const terminalsFile = path.join(tmp, 'fixture-terminals.json')
  await fs.writeFile(indexFile, JSON.stringify(fixtures.index))
  await fs.writeFile(deviceFile, JSON.stringify(fixtures.device))
  await fs.writeFile(terminalsFile, JSON.stringify(fixtures.terminals))
  await fs.writeFile(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */api/tabs-sync/snapshots/dev-1) cat "$FAKE_DEVICE" ;;
  */api/tabs-sync/snapshots) cat "$FAKE_INDEX" ;;
  */api/terminals) cat "$FAKE_TERMINALS" ;;
  *) echo "unexpected URL: $url" >&2; exit 91 ;;
esac
`,
    { mode: 0o755 },
  )
  return {
    binDir,
    env: { FAKE_INDEX: indexFile, FAKE_DEVICE: deviceFile, FAKE_TERMINALS: terminalsFile },
  }
}

const INDEX = {
  devices: [
    {
      deviceId: 'dev-1',
      capturedAt: 20,
      generations: [
        { generation: 1, generationId: 'g-1', clientInstanceId: 'c-1', capturedAt: 10, snapshotRevision: 1 },
      ],
    },
  ],
}

const DEVICE = (records: unknown[]) => ({
  deviceId: 'dev-1',
  deviceLabel: 'Device',
  snapshotRevision: 1,
  capturedAt: 20,
  records,
})

describe('deploy-tab-diff capture coverage gate', () => {
  it('halts with exit 4 on uncovered running terminals, still writes the artifact, and lists them enriched with mode/cwd/title', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const terminals = [
        term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' }),
        term('term-orphan', 'running', { mode: 'claude', title: 'Orphan work', cwd: '/home/dan/proj' }),
      ]
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals,
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      // DISTINCT exit code: 4 = "capture succeeded but restore would lose
      // terminals" (1 = capture unusable, 2 = usage, 3 = internal-only).
      expect(r.code).toBe(4)
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // Enriched list: id + mode/cwd/title pulled from the artifact's own .terminals[].
      expect(r.out).toContain('  - term-orphan (mode=claude, cwd=/home/dan/proj, title=Orphan work)')
      expect(r.out).not.toMatch(/- term-covered/)
      // The artifact WAS written (needed for diagnosis) and messaging says so.
      expect(r.out).toMatch(/WAS written to/)
      expect(r.out).toContain('captured 1 device snapshot(s), 2 running terminal(s)')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(2)
      expect(Object.keys(artifact.devices)).toEqual(['dev-1'])
      // The override is advertised on the failure path.
      expect(r.out).toContain('--allow-uncovered')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('exits 0 with the normal summary when every running terminal is covered', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals: [term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' })],
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('captured 1 device snapshot(s), 1 running terminal(s)')
      expect(r.out).not.toContain('FAIL')
      expect(r.out).not.toContain('WARNING')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(1)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('--allow-uncovered downgrades the gap to a WARNING and exits 0', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const terminals = [
        term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' }),
        term('term-orphan', 'running', { mode: 'claude', title: 'Orphan work', cwd: '/home/dan/proj' }),
      ]
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals,
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out, '--allow-uncovered'],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain(
        'WARNING: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      expect(r.out).toContain('  - term-orphan (mode=claude, cwd=/home/dan/proj, title=Orphan work)')
      expect(r.out).not.toContain('FAIL')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(2)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail (RED)**

Run:
```bash
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: the two Task 1 tests pass; **"halts with exit 4..." FAILS** (`expected 4, received 0` — today's capture exits 0 despite the gap); **"--allow-uncovered..." FAILS** (`expected 0, received 2` — `unknown argument: --allow-uncovered`); "exits 0 when every running terminal is covered" passes (it pins the no-regression path). If the RED tests fail for any OTHER reason (e.g. fixture rejected by the artifact shape validation), fix the fixture first.

- [ ] **Step 3: Implement the flag, the report helper, and the gate**

Three edits to `scripts/deploy-tab-diff.sh`:

**(a)** Line 14 — add the flag default. Replace:
```bash
URL="" TOKEN="${FRESHELL_TOKEN:-}" OUT="" BEFORE="" AFTER_IN=""
```
with:
```bash
URL="" TOKEN="${FRESHELL_TOKEN:-}" OUT="" BEFORE="" AFTER_IN="" ALLOW_UNCOVERED=false
```

**(b)** In the argument `case` (lines 16–24), after the `--after) AFTER_IN="$2"; shift 2 ;;` line, add:
```bash
    --allow-uncovered) ALLOW_UNCOVERED=true; shift ;;
```

**(c)** Immediately after the closing `}` of `uncovered_terminals` (from Task 2), add:

```bash
report_uncovered() {
  # Uncovered-terminal report to stderr for the CAPTURE gate: a severity
  # header ($2: FAIL or WARNING) with the count, then one
  #   - <terminalId> (mode=..., cwd=..., title=...)
  # line per id in $3 (newline-separated), enriched from the capture file
  # $1's own .terminals[] -- the data is already in the artifact, no extra
  # fetch, and the script stays GET-only. Enrichment is best-effort: on any
  # failure fall back to bare ids rather than mask the coverage report.
  # Ids travel via temp file + --slurpfile, never --argjson (ARG_MAX).
  local state_file="$1" severity="$2" uncovered="$3"
  local n ids_tmp=""
  n=$(printf '%s\n' "$uncovered" | grep -c .)
  echo "${severity}: ${n} running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):" >&2
  if ids_tmp=$(mktemp) \
     && printf '%s\n' "$uncovered" | jq -Rn '[inputs | select(length > 0)]' > "$ids_tmp" \
     && jq -r --slurpfile ids "$ids_tmp" '
          (.terminals | map({key: .terminalId, value: .}) | from_entries) as $byId
          | $ids[0][] | . as $t | ($byId[$t] // {}) as $info
          | "  - \($t) (mode=\($info.mode // "?"), cwd=\($info.cwd // "?"), title=\($info.title // "?"))"' \
          "$state_file" >&2; then
    :
  else
    printf '%s\n' "$uncovered" | sed 's/^/  - /' >&2
  fi
  rm -f -- "$ids_tmp"
}
```

**(d)** In the `capture` arm, after the summary line (line 178, `echo "captured ${ndev} device snapshot(s), ${nrun} running terminal(s) -> $OUT"`) and before the arm's `;;`, add:

```bash
    # COVERAGE GATE (:2559, pre-restart edition): the same guard verify runs,
    # moved to BEFORE the restart. If any running terminal is covered by no
    # persisted open-tab pane, restoring from this capture would permanently
    # lose it (the PTY dies with the server) -- discovering that in verify,
    # AFTER the restart, is too late (2026-07-29 incident: 9 of 28 running
    # terminals uncovered and killed). The artifact is ALWAYS published first
    # (diagnosis needs it); the gate only decides messaging and exit status:
    # 4 = coverage gap (distinct from 1 = capture unusable), or a WARNING +
    # exit 0 under --allow-uncovered (the operator's informed-consent path).
    if ! uncovered=$(uncovered_terminals "$OUT"); then
      echo "ERROR: computing capture coverage gate failed" >&2; exit 1; fi
    if [[ -n "$uncovered" ]]; then
      if $ALLOW_UNCOVERED; then
        report_uncovered "$OUT" "WARNING" "$uncovered"
        echo "WARNING: proceeding despite the coverage gap (--allow-uncovered): a restart now will permanently kill the terminals listed above." >&2
      else
        report_uncovered "$OUT" "FAIL" "$uncovered"
        echo "FAIL: the capture artifact WAS written to ${OUT} (keep it for diagnosis), but a restart/restore from this state would permanently lose the terminals listed above." >&2
        echo "Fix tabs-sync coverage (open the affected tabs in a connected client) and re-capture, or re-run with --allow-uncovered to accept the loss." >&2
        exit 4
      fi
    fi
```

(Note the `if $ALLOW_UNCOVERED; then` guard form — same rationale as `cleanup()` at lines 191–194: a bare `$ALLOW_UNCOVERED && ...` returns 1 when false and `set -e` would kill the success path.)

- [ ] **Step 4: Syntax-check, then run tests to verify they pass (GREEN)**

Run:
```bash
bash -n scripts/deploy-tab-diff.sh
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: `bash -n` silent; Vitest `5 passed`.

- [ ] **Step 5: Refactor check**

Re-read the three edits: no duplicated coverage jq anywhere (only `uncovered_terminals` holds it); `report_uncovered` used by both gate branches; comments indented (nothing new leaks into `--help` — verify with `! scripts/deploy-tab-diff.sh capture --help | grep -q 'allow-uncovered'`, which must exit 0 at this point). No further refactor expected; if you changed anything, re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-tab-diff.sh test/unit/server/deploy-tab-diff-coverage-gate.test.ts
git commit -m "feat(deploy-tab-diff): capture-time coverage gate with --allow-uncovered override (exit 4)"
```

---

### Task 4: Document the gate in the usage header + usage line, final verification

**Files:**
- Modify: `scripts/deploy-tab-diff.sh` (header lines 1–10; usage line 294)
- Test: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (append help test)

**Interfaces:**
- Consumes: `runScript` from Task 1; `--help` behavior (line 22: prints every column-0 `#` comment).
- Produces: documented contract — nothing later depends on it programmatically.

- [ ] **Step 1: Write the failing test (RED)**

Append to `test/unit/server/deploy-tab-diff-coverage-gate.test.ts`:

```ts
describe('deploy-tab-diff --help', () => {
  it('documents the coverage gate: exit 4 and --allow-uncovered', async () => {
    // --help is parsed inside the flag loop, so it needs a leading subcommand.
    const r = await runScript(['capture', '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('--allow-uncovered')
    expect(r.out).toContain('4 capture coverage gap')
  })
})
```

- [ ] **Step 2: Run tests to verify it fails (RED)**

Run:
```bash
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: 5 pass, the new help test **FAILS** (`--allow-uncovered` not found in help output — all gate comments so far are indented and invisible to `grep '^#'`).

- [ ] **Step 3: Update the header and the usage line**

**(a)** Replace lines 1–10 of `scripts/deploy-tab-diff.sh`:

```bash
#!/usr/bin/env bash
# deploy-tab-diff.sh -- pre/post-restart tab identity ritual (continuity trio
# deliverable 3, docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/deploy-tab-diff.sh capture --url U --token T --out before.json [--allow-uncovered]
#   ... restart/deploy the server ...
#   scripts/deploy-tab-diff.sh verify  --url U --token T --before before.json
#
# capture GATES on coverage (docs/plans/2026-07-29-capture-coverage-gate.md):
# if any running terminal is covered by NO persisted open-tab snapshot pane,
# a restart would permanently kill it, so capture prints the uncovered list
# (with mode/cwd/title), still writes the artifact for diagnosis, and exits 4.
# Pass --allow-uncovered to accept the loss: same list as a WARNING, exit 0.
# verify re-runs the same guard on the before-file (defense in depth against
# artifacts from older script versions or --allow-uncovered captures).
#
# Exit codes: 0 ok; 1 operational failure or post-restart divergence;
# 2 usage; 4 capture coverage gap (artifact written, but restoring from it
# would lose running terminals).
#
# READ-ONLY against the server (GETs only). Exit non-zero on any divergence.
# NEVER point this at a server you do not operate. Requires curl + jq.
```

**(b)** Replace the usage line (line 294):
```bash
    echo "usage: deploy-tab-diff.sh {capture|verify} --url U --token T [--out F | --before F [--after F]]" >&2
```
with:
```bash
    echo "usage: deploy-tab-diff.sh {capture|verify} --url U --token T [--out F [--allow-uncovered] | --before F [--after F]]" >&2
```

- [ ] **Step 4: Syntax-check and run the file's tests (GREEN)**

Run:
```bash
bash -n scripts/deploy-tab-diff.sh
npm run test:vitest -- run test/unit/server/deploy-tab-diff-coverage-gate.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: `bash -n` silent; Vitest `6 passed`.

- [ ] **Step 5: Run the repo's coordinated verification**

Run (broad run — goes through the shared coordinator gate; wait if another agent holds it, never kill a foreign holder):
```bash
FRESHELL_TEST_SUMMARY="deploy-tab-diff capture coverage gate" npm run check
```
Expected: typecheck clean, coordinated suite green (`npm run check` = typecheck + full default- and server-config Vitest suites; the new file runs under the server config). If unrelated pre-existing failures appear, confirm they also fail on the base commit (`git stash` is NOT needed — check `npm run test:status` history or note the failure names) and report them rather than papering over.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-tab-diff.sh test/unit/server/deploy-tab-diff-coverage-gate.test.ts
git commit -m "docs(deploy-tab-diff): document coverage gate, exit 4, --allow-uncovered in header/usage"
```

Stop here: branch complete and verified. No PR, no merge, no deploy, no server restart.
