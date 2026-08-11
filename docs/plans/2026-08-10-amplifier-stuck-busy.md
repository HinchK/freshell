# Amplifier Stuck-Busy Fix (orchestrator:complete Turn Boundary) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make Freshell's amplifier terminal-pane busy tracking clear the busy (blue) state when an Amplifier CLI turn dies on a provider error, by treating the CLI's `orchestrator:complete` record as a turn-end boundary in both the Node and Rust events reducers (and admitting it through both tailer prefilters, without which the reducer change is dead code).

**Architecture:** Freshell tails Amplifier's per-session `events.jsonl`. A tailer (with a substring prefilter) feeds parsed records into a pure reducer (`(state, record) -> (state, effects)`), whose `turn.began`/`turn.completed` effects drive a terminal-keyed tracker that emits exactly-once `turn.complete` events via a monotonic ledger. The bug: on provider-error turns the CLI writes `provider:error` then `orchestrator:complete` and **never** `prompt:complete`, but the reducer only ends turns on `prompt:complete`/`session:end` — and the tailer prefilter drops `orchestrator:complete` lines before they are even parsed. The fix touches exactly two layers per language (prefilter + reducer); the tracker, ledger, WS wiring, and client are effect-keyed and need zero changes.

**Tech Stack:** TypeScript (NodeNext/ESM) + vitest (server config); Rust (`crates/freshell-activity`, `crates/freshell-ws`) + inline `#[cfg(test)]` tests; Playwright e2e (rust-chromium project).

## Global Constraints

- Red-Green-Refactor TDD for every change; never skip the tests, never skip the refactor (repo rule, non-negotiable).
- Keep the Node and Rust reducers semantically identical (the Rust files are declared ports of the Node "frozen parity reference").
- Work ONLY in the worktree `/home/dan/code/freshell/.worktrees/amplifier-stuck-busy` (branch `the-usual/amplifier-stuck-busy`). All git commands must use `git -C /home/dan/code/freshell/.worktrees/amplifier-stuck-busy` or run after `cd` into it — never rely on inherited cwd.
- Do NOT create a PR (`gh pr create` or equivalent) — pushing the branch is fine; PR creation requires explicit user approval.
- Do NOT restart the self-hosted Rust server on port 3001 (requires the literal word "APPROVED"; not needed for this task).
- Do NOT touch the unrelated worktree `.worktrees/multi-client-layout-store` (branch `fix/multi-client-layout-store`); other agents work in this repo concurrently.
- Focused Node test runs: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts <file>` (passthrough, does not take the broad coordinator gate). Broad runs (`npm test`, `npm run check`) go through the shared coordinator gate — if another agent holds it, WAIT, never kill the holder. Raw `npx vitest` is not a coordinated workflow.
- Rust: `cargo test -p freshell-activity` (and `-p freshell-ws` where stated) plus `cargo fmt` / `cargo clippy` clean.
- Server TypeScript uses NodeNext/ESM: relative imports in server code must carry `.js` extensions.
- Never fabricate a completion (existing system policy): the 120s deadman stays a force-read-only failsafe. `orchestrator:complete` is NOT fabrication — it is a real, unambiguous turn-end record written by the CLI itself; the code comments added by this plan must state that reasoning.
- Commit identity: use the repo's existing git config (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`); never set `dan@danshapiro.com` as a git identity.

---

## Evidence Base (already gathered — do not re-derive; cite in code comments)

Forensics across real `~/.amplifier/projects/*/sessions/*/events.jsonl` files (62 root sessions / 736 turns segmented; 400 root files + 300 sub-agent files scanned; 6 sessions traced line-by-line around every `provider:error`), hardened 2026-08-10 by a load-bearing validation pass: a full-corpus census (16,326 files / 55 GB streamed; 2,658 root sessions / 4,718 root turns; 13,616 sub-agent sessions / 14,264 turns) plus a read of the running CLI's actual source (installed uv tool `2026.08.05-5462f1e`, core 1.6.0; loop-streaming orchestrator module byte-identical to upstream commit `e5438b4c9`):

1. **Healthy turns:** `orchestrator:complete` (status `success`) is written on every healthy turn and **always precedes** `prompt:complete` — 724/724 turns containing both, zero exceptions. Canonical tail: `execution:end → orchestrator:complete → cleanup:render_* → prompt:complete`. Census reconfirmation: ordering holds across all 4,411 healthy OC→PC pairs; the gap is median 4.5 ms / p95 365 ms / p99 449 ms (>1 s in only 4 pairs, all OC→`cleanup:render` stalls where the earlier boundary shows idle *sooner* — i.e. more correctly), so moving every turn's boundary earlier is user-invisible.
2. **Provider-error turns:** `orchestrator:complete` (status `error`) is written **reliably** — 27/27 error turns, always the very next line after `provider:error`. `prompt:complete` is written in only 1/27 (and that one belongs to a recovered continuation). The verified stuck session (`021b7193-205c-457e-bfd2-4b2426a2c7aa`: 6 submits, 5 completes, 6 orchestrator:completes) ends at `orchestrator:complete` with nothing after. Census: **3.3% of ALL root turns end at `orchestrator:complete` with no `prompt:complete` ever** — the PC-only boundary's stuck-busy exposure is far larger than the 27 traced provider-error turns.
3. **`provider:error` is NOT needed as a boundary:** `orchestrator:complete` always follows it (27/27). Keep the change minimal — `provider:error` stays a no-op. Source-verified (item 7): `provider:error` is emitted only in `except → emit → raise` blocks whose surrounding handler always emits `orchestrator:complete`, and it is **non-terminal in two paths** (max-iterations swallow, goal-evaluator) — ending turns on it would be wrong, not just unnecessary.
4. **Sub-agent sessions write their OWN `events.jsonl`** in separate session dirs; every record there carries a non-null `data.parent_id`, and sub-agent files never contain `prompt:complete` (0/300; census: 0/14,264 sub-agent turns) — they end at `orchestrator:complete` → `session:end`. **Root session files never contain a non-null `data.parent_id` on any record** (400/400 files clean), and zero sub-agent `orchestrator:complete` records leak into root files (323 child sessions cross-correlated). Freshell attaches one tailer per root session file, so sub-agent completions cannot reach the root reducer today. Source-verified: `parent_id` is **session-scoped** — the kernel stamps `{session_id, parent_id}` defaults into every record at session construction and the log writer routes each record to `sessions/{session_id}/events.jsonl` by that stamp; root `delegate:*` records use a different key (`parent_session_id`), so their null `data.parent_id` does not contradict this. The `parent_id` guard in this plan is cheap defense-in-depth for the spec's stated concern (if Amplifier ever inlines child events, they must not end the root turn).
5. **Known accepted tradeoff (census-refined):** real stray mid-turn `orchestrator:complete` records (`parent_id` null; turn later recovers via a second OC then PC — a double-OC race with an in-flight llm:response/delegate completion) occur in **3/4,718 root turns (0.064%)**; the other 44/47 mid-turn OC flags are benign cancel teardowns (`OC(cancelled)` → `cancel:completed` → PC within ≤0.64 s). With this fix a stray yields one early completion (pane idle 4–254 s early in the observed cases, single chime, later `prompt:complete` swallowed at idle) instead of an eternally stuck-busy pane. No record-level field reliably distinguishes the stray — a full data-payload diff shows stray and terminal OC records identical in key sets and values, and even `status` fails (observed strays: success×2, error×1; a status gate would still admit the worst 254 s stray while forfeiting OC(success)-ending turns inside the 3.3% OC-no-PC population). Transitions keep keying on event TYPE only (existing E3 principle — no `status` gate). This tradeoff must be documented in the reducer comments.
6. **The tailer prefilter is a hard blocker:** both tailers admit only `session:` / `prompt:` / `execution:` / `orchestrator:steering` event-name prefixes before `JSON.parse`. `orchestrator:complete` lines are dropped unparsed today; a reducer-only fix is inert in production.
7. **Source-structural confirmation (2026-08-10 load-bearing validation):** `orchestrator:complete` is emitted from an always-path in the loop-streaming orchestrator's `_execute_one_turn` — it catches all `Exception`s and (literal comment: "Always emit orchestrator complete event") emits OC with status `error`/`cancelled`/`success`/`incomplete` before re-raising — while `prompt:complete` is written only by the app-cli after a successful `session.execute()`. OC-before-PC ordering is therefore **structural**, and PC is unreachable on error paths: the observed contract is not incidental to the corpus build.
8. **Scope + drift mitigation:** the kernel does NOT enforce OC emission, and the `loop-agent` orchestrator variant never emits it — the boundary set is ADDITIVE, so sessions on such orchestrators simply keep today's behavior (`prompt:complete`/`session:end` still end turns; no regression). The foundation bundle sources loop-streaming `@main`, so the orchestrator can drift without the CLI version changing: the spec text (Task 6) records the verified pins — CLI `2026.08.05-5462f1e`, core 1.6.0, schema `amplifier.log` 1.0.0, loop-streaming module commit `e5438b4c9` — so contract drift is diagnosable, never silent.
9. **Known residual stuck-busy paths (pre-existing, out of scope, unchanged by this fix):** a hard cancel (immediate `CancelledError`, a `BaseException`) emits NEITHER OC nor PC, and goal-mode error turns can leak the deferred OC (never flushed). No record-keyed boundary can see these; the 120 s deadman force-read and PTY-exit handling remain the failsafes. Documented (Task 6) so nobody reads this fix as eliminating stuck-busy entirely.

Exactly-once needs **no new machinery**: the reducer's `phase !== busy` guard already swallows any second turn-end record of any type, the tracker re-guards on phase, and the ledger's `completionSeq` is monotonic per terminal.

---

## File Structure (all paths relative to the worktree root)

| File | Change |
|---|---|
| `server/coding-cli/amplifier-events-reducer.ts` | Add `orchestrator:complete` turn-end case (with sub-agent `parent_id` guard); update module doc + default-arm comment; refactor: collapse the byte-identical `prompt:complete`/`session:end` cases into one fallthrough (matching the Rust port). |
| `server/coding-cli/amplifier-events-tailer.ts` | Broaden `EVENT_PREFIXES`: `'orchestrator:steering'` → `'orchestrator:'`. |
| `server/coding-cli/amplifier-activity-tracker.ts` | Comments only: 4 stale enumerations of the turn-end set. |
| `test/unit/server/coding-cli/amplifier-events-reducer.test.ts` | New `describe` block (6 tests); rewrite 1 fixture test whose per-index assertion moves. |
| `test/unit/server/coding-cli/amplifier-events-tailer.test.ts` | Update prefilter test expectations (5→6 parses, 11→10 skips). |
| `test/unit/server/coding-cli/amplifier-activity-integration.test.ts` | New end-to-end (tailer→reducer→tracker) provider-error-turn test. |
| `crates/freshell-activity/src/amplifier/reducer.rs` | New match arm + module doc + catch-all comment + 7 new inline tests + noise-loop addition. |
| `crates/freshell-activity/src/amplifier/tailer.rs` | Broaden `EVENT_PREFIXES` (keep arity 4: `"orchestrator:steering"` → `"orchestrator:"`); 1 new inline test. |
| `crates/freshell-activity/src/amplifier/tracker.rs` | Doc comment only (module doc boundary enumeration). |
| `crates/freshell-activity/src/amplifier/mod.rs` | Doc comment only. |
| `crates/freshell-ws/src/activity.rs` | 1 new inline integration test (inotify-driven error-path turn). |
| `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs` | Env-gated error-turn mode (`FAKE_AMPLIFIER_ERROR_TURN=1`). |
| `test/e2e-browser/specs/terminal-activity-rust.spec.ts` | New e2e test: provider-error turn clears blue via `orchestrator:complete`. |
| `docs/plans/ACTIVITY_TRACKING_SPEC.md` | Living spec: update the boundary-set paragraph. |
| `docs/plans/2026-07-08-amplifier-session-durability-plan.md` | Dated amendments to the normative §6 passages + §2 finding row. |

Line numbers cited below are exact as of branch head `669219563`; if edits shift them, match on the quoted text, not the number.

---

### Task 1: Node reducer — `orchestrator:complete` ends a busy turn

**Files:**
- Modify: `server/coding-cli/amplifier-events-reducer.ts` (module doc lines 1–22; switch lines 133–178)
- Test: `test/unit/server/coding-cli/amplifier-events-reducer.test.ts`

**Interfaces:**
- Consumes: existing exports `createAmplifierReducerState`, `reduceAmplifierEvent`, types `AmplifierParsedRecord` (whose `data` is typed `{ parent_id?: string | null; ... } | null`), `AmplifierReducerEffect`. Test helpers already in the test file: `record(overrides)` (defaults `data: { parent_id: null }`), `loadFixture(name)`, `reduceAll(records)`, `kinds(effects)`.
- Produces: `reduceAmplifierEvent` now returns `{ state: { ...phase:'idle' }, effects: [{ kind: 'turn.completed', at: record.ts }] }` for a busy-phase `orchestrator:complete` whose `data.parent_id` is not a non-empty string; no signature or effect-vocabulary changes. Task 2's integration test and Task 3's Rust port rely on exactly this behavior.

- [ ] **Step 1: Write the failing tests (RED)**

In `test/unit/server/coding-cli/amplifier-events-reducer.test.ts`, add this new `describe` block inside the top-level `describe('amplifier events reducer', ...)`, immediately after the `describe('fixture: continue-attach-orphan-end (E7)', ...)` block closes:

```ts
  describe('orchestrator:complete boundary (2026-08-10 stuck-busy fix)', () => {
    it('orchestrator:complete ends a busy turn (provider-error path: prompt:complete never arrives)', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const result = reduceAmplifierEvent(busy, record({ event: 'orchestrator:complete' }))
      expect(result.state.phase).toBe('idle')
      expect(kinds(result.effects)).toEqual(['turn.completed'])
    })

    it('orchestrator:complete followed by a late prompt:complete completes exactly once', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const first = reduceAmplifierEvent(busy, record({
        event: 'orchestrator:complete',
        ts: '2026-08-11T00:20:05.808632463+00:00',
      }))
      expect(first.state.phase).toBe('idle')
      expect(first.effects).toEqual([{ kind: 'turn.completed', at: '2026-08-11T00:20:05.808632463+00:00' }])
      const second = reduceAmplifierEvent(first.state, record({ event: 'prompt:complete' }))
      expect(second.state.phase).toBe('idle')
      expect(second.effects).toEqual([])
    })

    it('prompt:complete followed by orchestrator:complete completes exactly once', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const first = reduceAmplifierEvent(busy, record({ event: 'prompt:complete' }))
      expect(kinds(first.effects)).toEqual(['turn.completed'])
      const second = reduceAmplifierEvent(first.state, record({ event: 'orchestrator:complete' }))
      expect(second.state.phase).toBe('idle')
      expect(second.effects).toEqual([])
    })

    it('orchestrator:complete at idle is a no-op (no emission)', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'orchestrator:complete' }))
      expect(result.state.phase).toBe('idle')
      expect(result.effects).toEqual([])
    })

    it('orchestrator:complete with a non-null parent_id (sub-agent record) never ends the root turn', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const result = reduceAmplifierEvent(busy, record({
        event: 'orchestrator:complete',
        data: { parent_id: '0000000000000000-59ae93e4abde4aca_the-usual-step-runner' },
      }))
      expect(result.state.phase).toBe('busy')
      expect(result.effects).toEqual([])
    })

    it('other orchestrator:* records while busy never end the turn', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const result = reduceAmplifierEvent(busy, record({ event: 'orchestrator:steering_injected' }))
      expect(result.state.phase).toBe('busy')
      expect(result.effects).toEqual([])
    })
  })
```

Then REWRITE the existing fixture test at lines 78–96 (its per-index assertion becomes false once the boundary moves earlier: in `normal-turn.jsonl`, `orchestrator:complete` is line 12 and `prompt:complete` is line 15). Replace this entire test:

```ts
    it('turn.completed fires on prompt:complete, not session:end (session:end at idle is ignored)', () => {
      const records = loadFixture('normal-turn.jsonl')
      const completeIndex = records.findIndex((r) => r.event === 'prompt:complete')
      const endIndex = records.findIndex((r) => r.event === 'session:end')
      expect(completeIndex).toBeGreaterThan(0)
      expect(endIndex).toBeGreaterThan(completeIndex)

      let state = createAmplifierReducerState()
      for (const [index, rec] of records.entries()) {
        const result = reduceAmplifierEvent(state, rec)
        state = result.state
        if (index === completeIndex) {
          expect(kinds(result.effects)).toEqual(['turn.completed'])
        }
        if (index === endIndex) {
          expect(result.effects).toEqual([])
        }
      }
    })
```

with:

```ts
    it('turn.completed fires on orchestrator:complete; the later prompt:complete and session:end at idle are ignored', () => {
      const records = loadFixture('normal-turn.jsonl')
      const orchestratorIndex = records.findIndex((r) => r.event === 'orchestrator:complete')
      const completeIndex = records.findIndex((r) => r.event === 'prompt:complete')
      const endIndex = records.findIndex((r) => r.event === 'session:end')
      expect(orchestratorIndex).toBeGreaterThan(0)
      expect(completeIndex).toBeGreaterThan(orchestratorIndex)
      expect(endIndex).toBeGreaterThan(completeIndex)

      let state = createAmplifierReducerState()
      for (const [index, rec] of records.entries()) {
        const result = reduceAmplifierEvent(state, rec)
        state = result.state
        if (index === orchestratorIndex) {
          expect(kinds(result.effects)).toEqual(['turn.completed'])
        }
        if (index === completeIndex) {
          expect(result.effects).toEqual([])
        }
        if (index === endIndex) {
          expect(result.effects).toEqual([])
        }
      }
    })
```

Do NOT touch the other fixture tests: they assert aggregate `kinds(effects)` sequences (`['session.identified','turn.began','turn.completed']`), which are position-independent and stay true — they become the exactly-once regression net for the healthy-turn ordering (fixtures all contain `orchestrator:complete` BEFORE `prompt:complete`).

- [ ] **Step 2: Run the reducer test file to verify RED**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/amplifier-events-reducer.test.ts
```

Expected: FAIL — exactly 3 failing tests: `'orchestrator:complete ends a busy turn (provider-error path: prompt:complete never arrives)'`, `'orchestrator:complete followed by a late prompt:complete completes exactly once'`, and the rewritten `'turn.completed fires on orchestrator:complete; ...'` (each fails on phase `'busy'` ≠ `'idle'` or effects `[]` ≠ `['turn.completed']`). The other 3 new tests are regression pins and pass both before and after the change (that is expected — note it, don't "fix" it). All pre-existing tests still pass (31 passed, 3 failed, 34 total).

- [ ] **Step 3: Implement the new case (GREEN)**

In `server/coding-cli/amplifier-events-reducer.ts`, insert a new case between the `case 'session:end': { ... }` block (ends line 160) and `case 'session:config': {` (line 161):

```ts
    case 'orchestrator:complete': {
      // Turn-end boundary (2026-08-10 stuck-busy fix,
      // docs/plans/2026-08-10-amplifier-stuck-busy.md). On provider-error
      // turns the CLI writes `provider:error` then `orchestrator:complete`
      // and NEVER writes `prompt:complete` (verified against real session
      // logs: 27/27 error turns; the stuck session ended exactly there), so
      // without this case a pane stays busy forever. This is NOT a
      // fabricated completion (the deadman policy stands): it is a real,
      // unambiguous turn-end record written by the CLI itself.
      //
      // Exactly-once: on healthy turns `orchestrator:complete` precedes
      // `prompt:complete` (724/724 observed; structural in the CLI source —
      // the orchestrator always emits it before the app-cli can write
      // `prompt:complete`), so this record ends the turn and the later
      // `prompt:complete` lands at idle and is swallowed by the phase guard
      // below. Known accepted tradeoff: ~0.06% of observed turns (3/4,718,
      // full-corpus census) carry a stray mid-turn `orchestrator:complete`
      // that the turn recovers from — that now yields one early completion
      // instead of an eternally stuck-busy pane. No payload field (not even
      // `status`: observed strays were success×2 / error×1) distinguishes
      // the stray, so transitions still key on event TYPE only (E3): no
      // `status` gate.
      //
      // Sub-agent guard: delegated sub-agent sessions write their OWN
      // events.jsonl and root-file records always carry `data.parent_id`
      // null, so a non-null parent_id here can only be a sub-agent record —
      // it must never end the root session's turn (source-verified:
      // parent_id is session-scoped, stamped on every child-session record;
      // this guard is cheap defense-in-depth).
      if (typeof record.data?.parent_id === 'string' && record.data.parent_id.length > 0) {
        return { state: next, effects: [] }
      }
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
```

Also update the `default:` arm comment (lines 172–177) so it no longer claims all `orchestrator:*` events are inert. Replace:

```ts
    default:
      // Everything else (session:start, execution:*, provider:*, llm:*,
      // tool:*, content_block:*, orchestrator:*, cleanup:*, ...) never
      // changes phase. Post-complete background naming events are covered
      // here (E2): never a new turn.
      return { state: next, effects: [] }
```

with:

```ts
    default:
      // Everything else (session:start, execution:*, provider:*, llm:*,
      // tool:*, content_block:*, cleanup:*, and orchestrator:* other than
      // orchestrator:complete, ...) never changes phase. Post-complete
      // background naming events are covered here (E2): never a new turn.
      return { state: next, effects: [] }
```

- [ ] **Step 4: Run the reducer test file to verify GREEN**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/amplifier-events-reducer.test.ts
```

Expected: PASS — 34 passed (34).

- [ ] **Step 5: Refactor — collapse the duplicate turn-end cases and de-stale the module doc**

The `prompt:complete` and `session:end` cases (lines 143–160) have byte-identical bodies, and the new case repeats them. Collapse the first two into one fallthrough (this exactly mirrors the Rust port's existing `"prompt:complete" | "session:end"` arm; `orchestrator:complete` stays its own case because of the parent_id guard). Replace the two blocks:

```ts
    case 'prompt:complete': {
      // The single turn boundary (E2/E3). At idle it is just another
      // non-prompt:submit record: ignored.
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
    case 'session:end': {
      // Turn ended by quit/hangup (E7). Orphan/duplicate session:end at idle
      // is legal and ignored (E7 continue-attach, E3 out-of-order tail).
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
```

with:

```ts
    case 'prompt:complete':
    case 'session:end': {
      // Turn-end boundaries (E2/E3; session:end = turn ended by quit/hangup,
      // E7). At idle they are just more non-prompt:submit records: ignored
      // (orphan/duplicate session:end is legal — E7 continue-attach, E3
      // out-of-order tail).
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
```

In the module doc comment (lines 1–22), replace these two lines:

```ts
 * - `prompt:complete` is the single turn boundary (E2/E3).
 * - `session:end` while busy ends the turn (E7); while idle it is ignored,
 *   which also makes orphan/duplicate `session:end` records legal (E7/E3).
```

with:

```ts
 * - Turn-end boundary SET (2026-08-10 amendment): `prompt:complete` (E2/E3),
 *   `session:end` while busy (E7), and `orchestrator:complete` with a null
 *   `data.parent_id` (provider-error turns never write `prompt:complete`).
 *   The FIRST boundary record ends the turn; later ones land at idle and are
 *   ignored, which also makes orphan/duplicate turn-end records legal (E7/E3).
```

- [ ] **Step 6: Run the reducer test file again plus the tracker file (guard against collateral), and typecheck**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/amplifier-events-reducer.test.ts test/unit/server/coding-cli/amplifier-activity-tracker.test.ts
npm run typecheck:server
```

Expected: PASS — reducer 34/34, tracker 24/24 (tracker is effect-keyed, untouched); typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add server/coding-cli/amplifier-events-reducer.ts test/unit/server/coding-cli/amplifier-events-reducer.test.ts
git commit -m "fix(amplifier): treat orchestrator:complete as a turn-end boundary in the events reducer"
```

---

### Task 2: Node tailer prefilter + end-to-end integration proof

**Files:**
- Modify: `server/coding-cli/amplifier-events-tailer.ts:55-61` (`EVENT_PREFIXES`)
- Test: `test/unit/server/coding-cli/amplifier-events-tailer.test.ts:147-183`
- Test: `test/unit/server/coding-cli/amplifier-activity-integration.test.ts` (new test)

**Interfaces:**
- Consumes: Task 1's reducer behavior (busy + root `orchestrator:complete` → `turn.completed`). Integration test helpers already in the file: `setup()` (returns `{ registry, tracker, completions, fsStore, watchers, warn, integration }`), `line(event, atMs, extra)` (builds a schema-valid JSONL line with `"data": {"parent_id": null}`), `flush()`, `EVENTS_PATH`, `integration.attachTailer(terminalId, sessionId, path, 'start')`, `watchers[0].fire('change', EVENTS_PATH)`.
- Produces: tailer that parses any `orchestrator:*` event line (module-private `EVENT_PREFIXES`/`PREFILTER_NEEDLES`; nothing else imports them, so no export changes). Task 5's e2e path and production depend on this.

- [ ] **Step 1: Update the prefilter test expectations (RED)**

In `test/unit/server/coding-cli/amplifier-events-tailer.test.ts`, inside the test `'pre-filters noise lines without calling JSON.parse on them'` (lines 147–183), replace the expectation block (the fixture input lines 148–165 stay unchanged — the fixture already contains an `orchestrator:complete` line):

```ts
    // session:start, prompt:submit, orchestrator:steering_injected, execution:end, prompt:complete
    expect(okRecords(result)).toEqual([
      'session:start',
      'prompt:submit',
      'orchestrator:steering_injected',
      'execution:end',
      'prompt:complete',
    ])
    expect(parseSpy).toHaveBeenCalledTimes(5)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skippedLines).toBe(11)
```

with:

```ts
    // session:start, prompt:submit, orchestrator:complete,
    // orchestrator:steering_injected, execution:end, prompt:complete —
    // orchestrator:complete is a turn-end boundary since the 2026-08-10
    // stuck-busy fix, so the prefilter must admit the orchestrator: family.
    expect(okRecords(result)).toEqual([
      'session:start',
      'prompt:submit',
      'orchestrator:complete',
      'orchestrator:steering_injected',
      'execution:end',
      'prompt:complete',
    ])
    expect(parseSpy).toHaveBeenCalledTimes(6)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skippedLines).toBe(10)
```

- [ ] **Step 2: Add the end-to-end integration test (RED — this is the test that would have caught the bug)**

In `test/unit/server/coding-cli/amplifier-activity-integration.test.ts`, add after the test `'locator bind mid-turn: catch-up adopts busy, the live prompt:complete emits exactly one completion'` (lines 195–224), inside the same `describe`:

```ts
  it('provider-error turn: orchestrator:complete alone ends the turn exactly once (no prompt:complete ever arrives)', async () => {
    const { tracker, completions, fsStore, watchers, integration } = setup()
    fsStore.write(
      EVENTS_PATH,
      line('session:start', 1000)
      + line('session:config', 1010, ', "raw": {"working_dir": "/work"}'),
    )
    await integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start')
    await flush()

    // A live turn begins...
    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // ...and dies on a provider error. The real CLI writes provider:error
    // then orchestrator:complete and NOTHING after (verified against real
    // session logs; the provider:error line is prefilter noise and never
    // reaches the reducer — orchestrator:complete must end the turn).
    fsStore.append(
      EVENTS_PATH,
      line('provider:error', 5000)
      + line('orchestrator:complete', 5001),
    )
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 5001, completionSeq: 1 })

    // A late prompt:complete for the same turn (healthy-turn ordering) is a
    // no-op: still exactly one completion.
    fsStore.append(EVENTS_PATH, line('prompt:complete', 5002))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
  })
```

- [ ] **Step 3: Run both files to verify RED**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/amplifier-events-tailer.test.ts test/unit/server/coding-cli/amplifier-activity-integration.test.ts
```

Expected: FAIL — exactly 2 failing tests: the prefilter test (received list is missing `'orchestrator:complete'`) and the new integration test (phase stays `'busy'`, `completions` length 0 — the tailer never surfaces the record even though Task 1 fixed the reducer). All other tests in both files pass.

- [ ] **Step 4: Broaden the prefilter (GREEN)**

In `server/coding-cli/amplifier-events-tailer.ts`, replace lines 55–61:

```ts
/**
 * Lifecycle event-name prefixes the reducer cares about. Lines are checked
 * with plain substring scans (both `"event":"x` and `"event": "x` spellings —
 * the live CLI writes a space after the colon) so noise never reaches
 * JSON.parse.
 */
const EVENT_PREFIXES = ['session:', 'prompt:', 'execution:', 'orchestrator:steering'] as const
```

with:

```ts
/**
 * Lifecycle event-name prefixes the reducer cares about. Lines are checked
 * with plain substring scans (both `"event":"x` and `"event": "x` spellings —
 * the live CLI writes a space after the colon) so noise never reaches
 * JSON.parse. `orchestrator:` covers `orchestrator:complete` (a turn-end
 * boundary since the 2026-08-10 stuck-busy fix — without this the reducer
 * never sees the record) plus `orchestrator:steering_injected`; the extra
 * parse volume is ~2 lines per turn.
 */
const EVENT_PREFIXES = ['session:', 'prompt:', 'execution:', 'orchestrator:'] as const
```

(`PREFILTER_NEEDLES` is derived from this array — no other change needed.)

- [ ] **Step 5: Run to verify GREEN**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/amplifier-events-tailer.test.ts test/unit/server/coding-cli/amplifier-activity-integration.test.ts
npm run typecheck:server
```

Expected: PASS — all tests in both files (tailer file: previous count + 0 new, all green; integration file: previous count + 1 new, all green); typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add server/coding-cli/amplifier-events-tailer.ts test/unit/server/coding-cli/amplifier-events-tailer.test.ts test/unit/server/coding-cli/amplifier-activity-integration.test.ts
git commit -m "fix(amplifier): admit orchestrator:* events through the Node tailer prefilter"
```

---

### Task 3: Rust reducer parity (this is what production runs)

**Files:**
- Modify: `crates/freshell-activity/src/amplifier/reducer.rs` (module doc lines 1–15; match arm at lines 193–225; inline `mod tests` at 228–383)
- Modify: `crates/freshell-activity/src/amplifier/tracker.rs:1-12` (module doc comment only)
- Modify: `crates/freshell-activity/src/amplifier/mod.rs:10-13` (module doc comment only)

**Interfaces:**
- Consumes: existing `ParsedRecord` (field `parent_id: Option<String>`, already parsed from `data.parent_id` at `reducer.rs:73-77` with empty strings filtered to `None`), `LifecyclePhase::{Idle, Busy}`, `ReducerState`, `ReducerEffect::TurnCompleted { at }`, `create_reducer_state()`, `reduce_amplifier_event(&ReducerState, &ParsedRecord) -> (ReducerState, Vec<ReducerEffect>)`. Test helper `record(event: &str)` already in the test module.
- Produces: Rust reducer semantically identical to Task 1's Node reducer (same boundary set, same parent_id guard, same phase-guard exactly-once). `ReducerEffect` is already re-exported public API — no export changes. Task 4's ws test depends on this.

- [ ] **Step 1: Write the failing tests (RED)**

In `crates/freshell-activity/src/amplifier/reducer.rs`, inside `#[cfg(test)] mod tests`, add after the existing `session_end_ends_a_busy_turn_and_is_legal_at_idle` test:

```rust
    #[test]
    fn orchestrator_complete_ends_a_busy_turn_on_the_provider_error_path() {
        // The stuck-busy bug: provider:error then orchestrator:complete,
        // nothing after — prompt:complete never arrives.
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) = reduce_amplifier_event(&state, &record("provider:error"));
        assert_eq!(state.phase, LifecyclePhase::Busy);
        assert!(effects.is_empty());
        let (state, effects) = reduce_amplifier_event(&state, &record("orchestrator:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(matches!(effects[0], ReducerEffect::TurnCompleted { .. }));
    }

    #[test]
    fn orchestrator_complete_then_late_prompt_complete_completes_exactly_once() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) = reduce_amplifier_event(&state, &record("orchestrator:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(matches!(effects[0], ReducerEffect::TurnCompleted { .. }));
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(effects.is_empty());
    }

    #[test]
    fn prompt_complete_then_orchestrator_complete_completes_exactly_once() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:complete"));
        assert!(matches!(effects[0], ReducerEffect::TurnCompleted { .. }));
        let (state, effects) = reduce_amplifier_event(&state, &record("orchestrator:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(effects.is_empty());
    }

    #[test]
    fn orchestrator_complete_at_idle_is_a_no_op() {
        let state = create_reducer_state();
        let (state, effects) = reduce_amplifier_event(&state, &record("orchestrator:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(effects.is_empty());
    }

    #[test]
    fn subagent_orchestrator_complete_never_ends_the_root_turn() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let sub = ParsedRecord::from_json(&json!({
            "ts": "2026-07-23T10:00:00.000Z",
            "schema": { "name": "amplifier.log", "ver": "1.0.0" },
            "event": "orchestrator:complete",
            "session_id": "sess-1",
            "data": { "parent_id": "0000000000000000-59ae93e4abde4aca_sub-agent" }
        }))
        .unwrap();
        let (state, effects) = reduce_amplifier_event(&state, &sub);
        assert_eq!(state.phase, LifecyclePhase::Busy);
        assert!(effects.is_empty());
    }

    #[test]
    fn other_orchestrator_events_never_end_a_busy_turn() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) =
            reduce_amplifier_event(&state, &record("orchestrator:steering_injected"));
        assert_eq!(state.phase, LifecyclePhase::Busy);
        assert!(effects.is_empty());
    }
```

Also add `"orchestrator:steering_injected"` to the noise array in the existing test `session_resume_and_noise_events_never_change_phase`, changing:

```rust
        for event in ["session:resume", "session:start", "execution:start"] {
```

to:

```rust
        for event in [
            "session:resume",
            "session:start",
            "execution:start",
            "orchestrator:steering_injected",
        ] {
```

- [ ] **Step 2: Run to verify RED**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
cargo test -p freshell-activity amplifier::reducer
```

Expected: FAIL — exactly 2 failing tests: `orchestrator_complete_ends_a_busy_turn_on_the_provider_error_path` and `orchestrator_complete_then_late_prompt_complete_completes_exactly_once` (both panic on `assert_eq!(state.phase, LifecyclePhase::Idle)` — phase stays `Busy`). The other 4 new tests are pins and pass before and after. All pre-existing tests pass.

- [ ] **Step 3: Implement the match arm (GREEN)**

In `crates/freshell-activity/src/amplifier/reducer.rs`, insert a new arm between the `"prompt:complete" | "session:end" => { ... }` arm (ends line 210) and the `"session:config" => {` arm (line 211):

```rust
        "orchestrator:complete" => {
            // Turn-end boundary (2026-08-10 stuck-busy fix; parity with
            // server/coding-cli/amplifier-events-reducer.ts,
            // docs/plans/2026-08-10-amplifier-stuck-busy.md). On
            // provider-error turns the CLI writes `provider:error` then
            // `orchestrator:complete` and NEVER `prompt:complete` (27/27
            // observed error turns), so without this arm a pane stays busy
            // forever. This is a real CLI-written turn-end record, not a
            // fabricated completion (the deadman policy stands).
            //
            // Exactly-once: on healthy turns this record precedes
            // `prompt:complete` (724/724 observed; structural in the CLI
            // source); the later `prompt:complete` lands at idle and the
            // phase guard swallows it. Known accepted tradeoff: rare
            // (~0.06%, 3/4,718 census turns) stray mid-turn
            // `orchestrator:complete` records (status success or error — no
            // status gate can block them) now end the turn early — one
            // early completion beats an eternally stuck pane. Transitions
            // still key on event TYPE only (E3): no status gate.
            //
            // Sub-agent guard: sub-agent sessions write their own
            // events.jsonl and root-file records always carry
            // `data.parent_id` null — a non-null parent_id can only be a
            // sub-agent record and must never end the root turn.
            if record.parent_id.is_some() {
                return (next, Vec::new());
            }
            if next.phase != LifecyclePhase::Busy {
                return (next, Vec::new());
            }
            next.phase = LifecyclePhase::Idle;
            let at = record.ts.clone();
            (next, vec![ReducerEffect::TurnCompleted { at }])
        }
```

Update the catch-all comment (lines 221–223). Replace:

```rust
        // session:resume never implies busy; everything else (session:start,
        // execution:*, llm:*, tool:*, orchestrator:*, ...) never changes phase
        // — post-complete background naming events are covered here (E2).
```

with:

```rust
        // session:resume never implies busy; everything else (session:start,
        // execution:*, llm:*, tool:*, and orchestrator:* other than
        // orchestrator:complete, ...) never changes phase — post-complete
        // background naming events are covered here (E2).
```

Update the module doc (lines 1–15). Replace:

```rust
//! * `prompt:complete` is the single turn boundary (E2/E3).
//! * `session:end` while busy ends the turn (E7); while idle it is ignored.
```

with:

```rust
//! * Turn-end boundary SET (2026-08-10 amendment): `prompt:complete` (E2/E3),
//!   `session:end` while busy (E7), and `orchestrator:complete` with a null
//!   `data.parent_id` (provider-error turns never write `prompt:complete`).
//!   The FIRST boundary record ends the turn; later ones land at idle and
//!   are ignored.
```

- [ ] **Step 4: Run to verify GREEN**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
cargo test -p freshell-activity amplifier::reducer
```

Expected: PASS — all reducer tests green (15 tests: 9 pre-existing + 6 new).

- [ ] **Step 5: Refactor — de-stale the sibling module docs**

In `crates/freshell-activity/src/amplifier/tracker.rs` (module doc, lines 8–12), replace:

```rust
//!   via [`AmplifierActivityTracker::apply_lifecycle`]) confirms busy;
//!   `prompt:complete`/`session:end` (`TurnCompleted`) is the single turn
//!   boundary and emits exactly one turn.complete via the ledger.
```

with:

```rust
//!   via [`AmplifierActivityTracker::apply_lifecycle`]) confirms busy; a
//!   turn-end record — `prompt:complete` / `session:end` / root
//!   `orchestrator:complete` (`TurnCompleted`) — ends the turn and emits
//!   exactly one turn.complete via the ledger.
```

In `crates/freshell-activity/src/amplifier/mod.rs` (lines 10–13), replace:

```rust
//! * [`tracker`] — `server/coding-cli/amplifier-activity-tracker.ts` (the
//!   terminal-keyed state machine: PTY Enter is only PROVISIONALLY busy;
//!   `prompt:submit` confirms; `prompt:complete`/`session:end` is the single
//!   turn boundary).
```

with:

```rust
//! * [`tracker`] — `server/coding-cli/amplifier-activity-tracker.ts` (the
//!   terminal-keyed state machine: PTY Enter is only PROVISIONALLY busy;
//!   `prompt:submit` confirms; `prompt:complete` / `session:end` / root
//!   `orchestrator:complete` are the turn-end boundaries).
```

- [ ] **Step 6: Full crate test + fmt + clippy**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
cargo test -p freshell-activity
cargo fmt --all
cargo clippy -p freshell-activity --all-targets -- -D warnings
```

Expected: all tests pass; `cargo fmt` produces no diff you didn't write (re-run `git -C ... diff` to confirm only intended files changed); clippy clean.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add crates/freshell-activity/src/amplifier/reducer.rs crates/freshell-activity/src/amplifier/tracker.rs crates/freshell-activity/src/amplifier/mod.rs
git commit -m "fix(amplifier): port orchestrator:complete turn boundary to the Rust reducer"
```

---

### Task 4: Rust tailer prefilter + freshell-ws end-to-end lane test

**Files:**
- Modify: `crates/freshell-activity/src/amplifier/tailer.rs:35-44` (`EVENT_PREFIXES`) + inline `mod tests` (from line 326)
- Test: `crates/freshell-ws/src/activity.rs` inline `#[cfg(test)] mod tests` (new test near `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify`, lines 3034–3144)

**Interfaces:**
- Consumes: Task 3's reducer arm. Tailer test helpers already in `tailer.rs`: `line(event: &str)`, `AmplifierEventsTailer::new(&path)`, `AttachAt::Start`, `TailerReadOutcome::Ok { records, skipped_lines, .. }`, `tempfile::tempdir()`. ws test helpers already in `activity.rs` tests: `hub()`, `observer_send`, `ActivityEvent::{Created, Input}`, `hub.attach_amplifier_association`, `amplifier_line(event)`, `next_frame_matching`, `next_frame_of_type`, `now_ms()`, `std::io::Write` (already `use`d at the mod level).
- Produces: production (Rust, port 3001) tail-to-broadcast path that ends turns on `orchestrator:complete`. Note per repo rules: deploying this to the live 3001 server requires a restart, which requires the user's explicit "APPROVED" — out of scope for this plan; do not restart anything.

- [ ] **Step 1: Write the failing tailer test (RED)**

In `crates/freshell-activity/src/amplifier/tailer.rs`, inside `#[cfg(test)] mod tests`, add after the existing `prefilter_skips_noise_without_parsing` test (lines 438–472):

```rust
    #[test]
    fn prefilter_admits_orchestrator_complete() {
        // orchestrator:complete is a turn-end boundary (2026-08-10 stuck-busy
        // fix): if the prefilter drops it, the reducer arm is dead code.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(
            &path,
            [
                line("session:start"),
                line("prompt:submit"),
                line("orchestrator:complete"),
                line("prompt:complete"),
            ]
            .concat(),
        )
        .unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok {
                records,
                skipped_lines,
                ..
            } => {
                assert_eq!(
                    records.iter().map(|r| r.event.as_str()).collect::<Vec<_>>(),
                    vec![
                        "session:start",
                        "prompt:submit",
                        "orchestrator:complete",
                        "prompt:complete"
                    ]
                );
                assert_eq!(skipped_lines, 0);
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Write the failing freshell-ws lane test (RED)**

In `crates/freshell-ws/src/activity.rs`, inside the `#[cfg(test)] mod tests` module, add immediately after the `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify` test (ends line 3144):

```rust
    /// Provider-error turn (2026-08-10 stuck-busy fix): the CLI writes
    /// provider:error then orchestrator:complete and NEVER prompt:complete.
    /// The lane must still complete the turn — this is the only Rust test
    /// that exercises tailer prefilter + reducer + tracker together for the
    /// error path (a reducer-only fix is invisible here).
    #[tokio::test(flavor = "multi_thread")]
    async fn amplifier_events_lane_completes_error_turn_on_orchestrator_complete() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(
            &events_path,
            [
                amplifier_line("session:start"),
                amplifier_line("prompt:submit"),
            ]
            .concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("provisional busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        next_frame_matching(&mut rx, "amplifier.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "sess-1"
        })
        .await
        .expect("bind upsert");

        // The turn dies on a provider error: append exactly what the real
        // CLI writes (provider:error is prefilter noise; orchestrator:complete
        // must end the turn).
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .unwrap();
        f.write_all(
            [
                amplifier_line("provider:error"),
                amplifier_line("orchestrator:complete"),
            ]
            .concat()
            .as_bytes(),
        )
        .unwrap();
        f.flush().unwrap();
        drop(f);

        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 5_000)
            .await
            .expect("turn.complete driven by orchestrator:complete");
        assert_eq!(complete["provider"], "amplifier");
        assert_eq!(complete["sessionId"], "sess-1");
        assert_eq!(complete["completionSeq"], 1);
    }
```

- [ ] **Step 3: Run to verify RED**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
cargo test -p freshell-activity amplifier::tailer::tests::prefilter_admits_orchestrator_complete
cargo test -p freshell-ws --lib amplifier_events_lane_completes_error_turn_on_orchestrator_complete
```

Expected: FAIL — the tailer test panics on the records assertion (`orchestrator:complete` missing, `skipped_lines` 1 ≠ 0); the ws test panics after a ~5s timeout with `turn.complete driven by orchestrator:complete` (the prefilter drops the record so no frame ever arrives).

- [ ] **Step 4: Broaden the Rust prefilter (GREEN)**

In `crates/freshell-activity/src/amplifier/tailer.rs`, replace lines 35–37:

```rust
/// Lifecycle event-name prefixes the reducer cares about; lines are checked
/// with plain substring scans (both `"event":"x` and `"event": "x`).
const EVENT_PREFIXES: [&str; 4] = ["session:", "prompt:", "execution:", "orchestrator:steering"];
```

with:

```rust
/// Lifecycle event-name prefixes the reducer cares about; lines are checked
/// with plain substring scans (both `"event":"x` and `"event": "x`).
/// `orchestrator:` covers `orchestrator:complete` (a turn-end boundary since
/// the 2026-08-10 stuck-busy fix — without this the reducer never sees it)
/// plus `orchestrator:steering_injected` (~2 extra parses per turn).
const EVENT_PREFIXES: [&str; 4] = ["session:", "prompt:", "execution:", "orchestrator:"];
```

(The array keeps arity 4 so the `[&str; 4]` type annotation is unchanged; `matches_prefilter` is prefix-based and needs no edit.)

- [ ] **Step 5: Run to verify GREEN, then full crates + fmt + clippy**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
cargo test -p freshell-activity
cargo test -p freshell-ws --lib activity::tests::amplifier
cargo fmt --all
cargo clippy -p freshell-activity -p freshell-ws --all-targets -- -D warnings
```

Expected: all tests pass (including the two new ones and every pre-existing tailer/tracker/ws test); fmt produces no unintended diff; clippy clean.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add crates/freshell-activity/src/amplifier/tailer.rs crates/freshell-ws/src/activity.rs
git commit -m "fix(amplifier): admit orchestrator events through the Rust tailer prefilter"
```

---

### Task 5: e2e browser coverage (user-visible outcome: blue clears on a provider-error turn)

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs` (lines 71 and 144–150)
- Test: `test/e2e-browser/specs/terminal-activity-rust.spec.ts` (new test after the existing amplifier test at lines 389–472)

**Interfaces:**
- Consumes: Tasks 3–4 (the e2e rust server is built from the workspace crates). Spec helpers already in the file: `installFakeCli`, `createE2eServerHandle`, `WsCapture`, `bootAndConnect`, `openCliPaneAndGetTerminalId`, `tabBlueIcons`, `typePromptIntoLastPane`, `FAKE_AMPLIFIER_CLI`, `UUID_RE`. Fixture helpers: `record(event, extra)`, `TURN_MS`, `stampTurnCount`.
- Produces: an e2e regression net for the full user story. Note on TDD honesty: the RED phase for this behavior was executed at the unit and ws-integration layers (Tasks 1–4); this task adds end-to-end coverage of already-implemented behavior, so its test goes green on first run — that is expected and acceptable (this is new coverage, not a new behavior change).

- [ ] **Step 1: Add the error-turn mode to the fake CLI**

In `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs`, after line 71 (`const TURN_MS = ...`), add:

```js
// Error-turn mode (stuck-busy regression): end the turn the way the real CLI
// does on a provider error — provider:error then orchestrator:complete, and
// NEVER prompt:complete.
const ERROR_TURN = process.env.FAKE_AMPLIFIER_ERROR_TURN === '1'
```

Then replace the turn-completion `setTimeout` (lines 146–150):

```js
  setTimeout(() => {
    fs.appendFileSync(eventsPath, record('prompt:complete', { session_id: sessionId }))
    stampTurnCount()
    process.stdout.write('amplifier: turn complete\r\n')
  }, TURN_MS)
```

with:

```js
  setTimeout(() => {
    if (ERROR_TURN) {
      fs.appendFileSync(
        eventsPath,
        record('provider:error', { session_id: sessionId, data: { parent_id: null } })
        + record('orchestrator:complete', {
          session_id: sessionId,
          status: 'error',
          data: { parent_id: null },
        }),
      )
      process.stdout.write('amplifier: provider error\r\n')
    } else {
      fs.appendFileSync(eventsPath, record('prompt:complete', { session_id: sessionId }))
      stampTurnCount()
      process.stdout.write('amplifier: turn complete\r\n')
    }
  }, TURN_MS)
```

- [ ] **Step 2: Add the e2e spec test**

In `test/e2e-browser/specs/terminal-activity-rust.spec.ts`, add immediately after the existing test `'amplifier events lane: busy from prompt:submit, complete + idle from prompt:complete'` (ends line 472), inside the same `describe`:

```ts
  test('amplifier events lane: provider-error turn completes via orchestrator:complete (no prompt:complete)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-activity-amp-err-'))
    const fakeAmplifier = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: {
          AMPLIFIER_CMD: fakeAmplifier,
          FAKE_AMPLIFIER_TURN_MS: '15000',
          FAKE_AMPLIFIER_ERROR_TURN: '1',
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['amplifier'] } },
          }, null, 2))
        },
      },
    })
    const info = await server.start()
    const capture = new WsCapture(info.baseUrl, info.token)
    try {
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Amplifier/i, 'amplifier')
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('amplifier>')
      }, { timeout: 15_000 }).toBe(true)

      await typePromptIntoLastPane(page, 'hello amplifier')

      // Busy (blue) while the turn runs...
      await capture.waitFor(
        (f) => f.type === 'amplifier.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        10_000,
        'amplifier busy upsert',
      )
      await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })

      // ...then the turn DIES on a provider error: the fixture writes
      // provider:error + orchestrator:complete and never prompt:complete.
      // Before the stuck-busy fix this pane stayed blue forever.
      const complete = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        45_000,
        'amplifier terminal.turn.complete (orchestrator:complete boundary)',
      )
      expect(complete.provider).toBe('amplifier')
      expect(complete.completionSeq).toBe(1)
      expect(String(complete.sessionId ?? '')).toMatch(UUID_RE)

      await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })

      const idleEdge = await capture.waitFor(
        (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
        10_000,
        'amplifier terminal.idle',
      )
      expect(idleEdge.reason).toBe('grace')

      await page.waitForTimeout(1_000)
      expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(1)
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 3: Run the two amplifier e2e tests (existing healthy-turn test must still pass — proves the fixture change didn't regress the default mode)**

This spec runs only under the `rust-chromium` Playwright project. Run locally with an explicit backend override (deliberate choice: bounded two-test run; do NOT prompt for `FRESHELL_E2E_BACKEND`):

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
bash scripts/e2e-cloud.sh run --local --project=rust-chromium \
  --grep="amplifier events lane" test/e2e-browser/specs/terminal-activity-rust.spec.ts
```

Expected: 2 passed (the pre-existing healthy-turn test and the new provider-error test). This builds the Rust server from the worktree; it does NOT touch the live port-3001 server. If the run fails for environmental reasons (e.g. missing Playwright browsers), run `npx playwright install chromium` once and retry; do not weaken the test. (Feasibility verified 2026-08-10: `run --local` passes `--project`/`--grep`/spec verbatim to Playwright with no interactive prompts; chromium-1208 matching Playwright 1.58.2 is already installed; `--list` discovery finds the existing amplifier test under `rust-chromium` — the install step should be unnecessary. First run also builds the client/server bundles and `cargo build --release -p freshell-server`; that is expected.)

- [ ] **Step 4: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs test/e2e-browser/specs/terminal-activity-rust.spec.ts
git commit -m "test(e2e): amplifier provider-error turn clears busy via orchestrator:complete"
```

---

### Task 6: De-stale every doc that enumerates the turn-end set + final verification

**Files:**
- Modify: `server/coding-cli/amplifier-activity-tracker.ts` (comments only — 4 sites)
- Modify: `docs/plans/ACTIVITY_TRACKING_SPEC.md` (living spec, lines ~37–51)
- Modify: `docs/plans/2026-07-08-amplifier-session-durability-plan.md` (dated amendments)

**Interfaces:**
- Consumes: nothing — prose only; zero behavior changes (verified by re-running the focused suites at the end).
- Produces: documentation that matches the implemented reality, so future readers/agents aren't poisoned by "prompt:complete is the single turn boundary" claims.

- [ ] **Step 1: Update the four stale comment sites in `server/coding-cli/amplifier-activity-tracker.ts`**

Site A — deadman constant header (lines 7–12). Replace:

```ts
// Deadman: a busy terminal silent this long triggers the missed-signal failsafe
// (docs/plans/2026-07-08-amplifier-session-durability-plan.md §6): request a
// force-read of events.jsonl (WSL2 inotify backstop) and STAY busy — never
// fabricate a completion; `prompt:complete` / `session:end` records are the
// only turn ends.
```

with:

```ts
// Deadman: a busy terminal silent this long triggers the missed-signal failsafe
// (docs/plans/2026-07-08-amplifier-session-durability-plan.md §6): request a
// force-read of events.jsonl (WSL2 inotify backstop) and STAY busy — never
// fabricate a completion; `prompt:complete` / `session:end` / root
// `orchestrator:complete` records are the only turn ends.
```

Site B — class doc (lines 94–97). Replace:

```ts
 *   submit-grace reversion (one force-read retry, then a silent revert — no
 *   turn.complete). A `prompt:submit` record (reducer `turn.began` effect via
 *   applyLifecycle()) confirms busy; `prompt:complete` / `session:end`
 *   (`turn.completed`) is the single turn boundary and emits exactly one
 *   turn.complete via the TurnCompletionLedger.
```

with:

```ts
 *   submit-grace reversion (one force-read retry, then a silent revert — no
 *   turn.complete). A `prompt:submit` record (reducer `turn.began` effect via
 *   applyLifecycle()) confirms busy; a turn-end record — `prompt:complete` /
 *   `session:end` / root `orchestrator:complete` (`turn.completed`) — ends
 *   the turn and emits exactly one turn.complete via the
 *   TurnCompletionLedger.
```

Site C — `applyLifecycle` case comment (line 222). Replace:

```ts
        // The single turn boundary (E2/E3): exactly one turn.complete per turn.
```

with:

```ts
        // A turn-end record's effect (E2/E3): exactly one turn.complete per turn.
```

Site D — `noteOutput` comment (lines 260–261). Replace:

```ts
    // Output only refreshes liveness (feeds the deadman). It never ends a
    // turn — `prompt:complete` is the only turn boundary.
```

with:

```ts
    // Output only refreshes liveness (feeds the deadman). It never ends a
    // turn — only turn-end records (`prompt:complete` / `session:end` /
    // root `orchestrator:complete`) do.
```

- [ ] **Step 2: Update the living spec `docs/plans/ACTIVITY_TRACKING_SPEC.md`**

In the amplifier section (lines ~37–51), replace:

```
Amplifier writes a schema-versioned event log per session
(`~/.amplifier/projects/<slug>/sessions/<id>/events.jsonl`, schema
`amplifier.log` ver 1.x) carrying `prompt:submit` / `prompt:complete` /
`session:end` lifecycle records. The tracker
(`server/coding-cli/amplifier-activity-tracker.ts`) runs one state machine per
terminal:

- `prompt:submit` is the only input that (re)enters busy; `prompt:complete` is
  the single turn boundary (exactly one `turn.complete` via the
  `TurnCompletionLedger`); `session:end` also ends a busy turn. PTY Enter is
```

with:

```
Amplifier writes a schema-versioned event log per session
(`~/.amplifier/projects/<slug>/sessions/<id>/events.jsonl`, schema
`amplifier.log` ver 1.x) carrying `prompt:submit` / `prompt:complete` /
`orchestrator:complete` / `session:end` lifecycle records. The tracker
(`server/coding-cli/amplifier-activity-tracker.ts`) runs one state machine per
terminal:

- `prompt:submit` is the only input that (re)enters busy. The turn-end
  boundary set is `prompt:complete`, `session:end`, and root
  `orchestrator:complete` (null `data.parent_id`): the first boundary record
  ends the turn (exactly one `turn.complete` via the `TurnCompletionLedger`);
  later boundary records for the same turn land at idle and are ignored. On
  provider-error turns the CLI ends at `orchestrator:complete` and never
  writes `prompt:complete` (2026-08-10 stuck-busy fix,
  docs/plans/2026-08-10-amplifier-stuck-busy.md); on healthy turns
  `orchestrator:complete` precedes `prompt:complete`. These
  `orchestrator:complete` semantics are structural to the `loop-streaming`
  orchestrator (verified 2026-08-10 at CLI `2026.08.05-5462f1e` / core 1.6.0
  / schema `amplifier.log` 1.0.0 / loop-streaming module `e5438b4c9`, which
  the foundation bundle sources `@main` — re-verify on drift); orchestrators
  that never emit `orchestrator:complete` (e.g. `loop-agent`) simply fall
  back to the other boundaries. Known residual gaps (pre-existing): a hard
  cancel or a goal-mode error turn can end with NO boundary record at all —
  the deadman force-read and PTY-exit handling remain the failsafes. PTY
  Enter is
```

(the rest of the bullet — provisional busy, grace, deadman never fabricates, PTY exit — stays verbatim).

- [ ] **Step 3: Amend `docs/plans/2026-07-08-amplifier-session-durability-plan.md`**

Edit 3a — §6 "Single events-driven path (no lanes)" (lines ~123–128). Replace:

```
There is exactly one state machine. `prompt:submit` / `prompt:complete` /
`session:end` records from `events.jsonl` are the only turn boundaries. PTY
```

with:

```
There is exactly one state machine. `prompt:submit` / `prompt:complete` /
`session:end` / root `orchestrator:complete` records from `events.jsonl` are
the only turn boundaries (*amended 2026-08-10: provider-error turns end at
`orchestrator:complete` and never write `prompt:complete` — see
docs/plans/2026-08-10-amplifier-stuck-busy.md*). PTY
```

Edit 3b — §6 transition table: insert a new row immediately after the `| busy | `session:end` record | idle | ...` row:

```
| busy | root `orchestrator:complete` record (`data.parent_id` null) | idle | *Amended 2026-08-10:* emit exactly one `turn.complete` (via ledger). The CLI ends provider-error turns here and never writes `prompt:complete`; on healthy turns this record precedes `prompt:complete`, whose later arrival at idle is ignored. Non-null `parent_id` (sub-agent record) is ignored. |
```

Edit 3c — same table, deadman row: replace the phrase

```
If the read surfaces `prompt:complete`/`session:end` → process normally.
```

with:

```
If the read surfaces a turn-end record (`prompt:complete`/`session:end`/root `orchestrator:complete`) → process normally.
```

Edit 3d — §6 tailer contract line (~163): replace the needle enumeration

```
(`'"event":"session:'`, `'"event":"prompt:'`, `'"event":"execution:'`, `'"event":"orchestrator:steering'`)
```

with:

```
(`'"event":"session:'`, `'"event":"prompt:'`, `'"event":"execution:'`, `'"event":"orchestrator:'` — widened 2026-08-10 to admit `orchestrator:complete`)
```

Edit 3e — §2 Phase 0 findings table, the E2/E3 row (line ~31): append to the end of the row's last cell (after "**Only `prompt:submit` re-enters busy.**"):

```
 *Amended 2026-08-10: `orchestrator:complete` (root, null `parent_id`) is also a turn boundary — provider-error turns never write `prompt:complete`.*
```

Edit 3f — §1 intro (line ~17): in the sentence listing carried records, insert `` `orchestrator:complete`, `` immediately after `` `prompt:complete`, ``.

Leave the other dated historical plan docs listed in the repo (idle-gate-semantics, events-lane-resilience, tailer-backlog-cap, rust-parity checklist, restore spec) and `test/fixtures/coding-cli/amplifier/events/README.md` unchanged: they describe the state of the system at their date (or fixture provenance) and make no forward-looking normative claim; the two docs updated above are the ones the durability/activity machinery actively cites.

- [ ] **Step 4: Verify nothing behavioral changed + full focused sweep**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
npm run typecheck:server
npm run test:vitest -- run --config config/vitest/vitest.server.config.ts \
  test/unit/server/coding-cli/amplifier-events-reducer.test.ts \
  test/unit/server/coding-cli/amplifier-events-tailer.test.ts \
  test/unit/server/coding-cli/amplifier-activity-integration.test.ts \
  test/unit/server/coding-cli/amplifier-activity-tracker.test.ts \
  test/server/ws-amplifier-activity.test.ts
cargo test -p freshell-activity
cargo test -p freshell-ws --lib activity::tests::amplifier
cargo fmt --all
cargo clippy -p freshell-activity -p freshell-ws --all-targets -- -D warnings
```

Expected: everything passes; fmt/clippy clean. (`test/server/ws-amplifier-activity.test.ts` is included as a broadcast-layer canary — it drives the tracker via effects and synthetic `prompt:*` streams, so it must pass unchanged.)

- [ ] **Step 5: Broad coordinated gate (final check)**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
FRESHELL_TEST_SUMMARY="amplifier stuck-busy fix: orchestrator:complete turn boundary" npm test
```

This takes the shared coordinator gate — if `npm run test:status` shows another agent holding it, WAIT for it to free up; never kill the holder. Expected: full default + server suites pass.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-stuck-busy
git add server/coding-cli/amplifier-activity-tracker.ts docs/plans/ACTIVITY_TRACKING_SPEC.md docs/plans/2026-07-08-amplifier-session-durability-plan.md
git commit -m "docs(amplifier): turn-end boundary set now includes orchestrator:complete"
```

Optionally push the branch (allowed; PR creation is NOT — stop before any `gh pr create`):

```bash
git -C /home/dan/code/freshell/.worktrees/amplifier-stuck-busy push -u origin the-usual/amplifier-stuck-busy
```
