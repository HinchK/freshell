# Fresh-Agent PTY Notification Display Role Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell's fresh-agent display consistently treats opencode PTY plugin notification messages (user-role turns whose text starts with `<pty_exited>`, `<pty_waited>`, or `<pty_wait_timeout>`) as agent text instead of user text — display-only: agent label and bubble styling, no minimap ticks or hover previews for them, no "You" labeling anywhere in the UI.

### Explicit constraints
- Display-only: never mutate the wire snapshot contract, the store's raw turns, or anything sent to/from opencode; snapshots remain "exactly what the model sees".
- One shared pure classifier in `shared/`, applied at the existing displayTurns choke point (where `coalesceSyntheticToolResultTurns` runs); no scattered per-consumer rewrites.
- Rollback stepper step counts keep the raw user-role rule (pinned to sum to the server's `rollback.undoneDepth`); `freshAgentSnapshotHasUserTurn` keeps reading raw store turns.
- Do not expand scope beyond this specific request; check in with the user if major changes or re-architecting appear necessary.
- TDD per repo rules (red/green/refactor, unit + e2e coverage); work in a dedicated worktree branch; no PR creation or merge without explicit user approval.

### Accepted tradeoffs and residuals
- Detection is content-based (leading plugin tags) because opencode does not mark injected prompts; the classifier needs updating if the plugin format changes or opencode adds an injection marker.
- PTY notification blocks will fold into adjacent assistant turns as continuations; the minimap rail shows only real human prompts.
- The opencode CLI/TUI outside Freshell still shows these as user messages — out of scope.

**Goal:** opencode-pty plugin notification turns (user-role wire messages whose leading text is a `<pty_exited>` / `<pty_waited>` / `<pty_wait_timeout>` block) render everywhere in the fresh-agent UI as agent text — agent label, agent bubble, markdown body, no minimap tick, no hover preview — while the wire snapshot, store turns, and rollback step counts keep seeing them as raw user-role turns.

**Architecture:** One pure helper `reclassifyPtyNotificationTurns` in `shared/fresh-agent-turns.ts` maps matching user-role turns to `{ ...turn, role: 'assistant' }` (identity-preserving for everything else). It is composed FIRST inside the existing `displayTurns` memo in `src/components/fresh-agent/FreshAgentTranscript.tsx:1104-1106`, ahead of `coalesceSyntheticToolResultTurns`. Every display consumer (turn label, bubble CSS via `data-turn-role`, markdown gate, header/continuation folding, the `[data-turn-role="user"]` minimap/glom sweep in `src/components/fresh-agent/shared/transcript-measurement.ts:33`, action-affordance gates in `FreshAgentTurnActions.tsx`) keys off the memo output and flips automatically. The rollback stepper reads the separate raw `rolledBackTurns` prop (never the memo), and `freshAgentSnapshotHasUserTurn` reads the raw snapshot — both stay raw by construction.

**Tech Stack:** TypeScript (NodeNext/ESM — relative imports in `shared/` carry `.js` extensions), React 18, Vitest + Testing Library, Playwright e2e.

## Global Constraints

- **Worktree discipline:** all work happens in `/home/dan/code/freshell/.worktrees/pty-notification-display-role` on branch `the-usual/pty-notification-display-role` (base_ref `34f425faeb565a993655a429d5f291681315d0a0`). Run every command from that worktree. No merge, no push, no PR without explicit user approval.
- **Production-file allowlist:** exactly two production files change — `shared/fresh-agent-turns.ts` (additive export) and `src/components/fresh-agent/FreshAgentTranscript.tsx` (one import + one memo line). No changes to `shared/fresh-agent-contract.ts` (schema), `src/lib/api.ts`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/store/`, any `crates/` Rust code, or `tools/`. A reviewer seeing any other production diff must reject it.
- **Baseline (user-authorized exception, recorded):** `origin/main` at base_ref (34f425fa) is red with 11 deterministic pre-existing Rust failures in `freshell-freshagent` (session handoff/ownership + claude settings families), recorded with receipts in the run's baseline ledger (`.worktrees/.the-usual-logs/pty-notification-display-role/reports/workspace-baseline.md`) and reproduced in isolation at base_ref. The repo rule — green base, or pause before worktree creation and notify the user — was satisfied: the run paused, presented the failing command (`scripts/base-gate.sh test`, rust phase exit 101) and the 11-failure summary, and on 2026-09-18 the user explicitly chose to proceed with the 11 failures ledger-recorded as pre-existing (the recorded decision lives in `run-state.md` under Important decisions). This is the recorded exception under which the "TDD per repo rules" constraint applies: red/green/refactor discipline governs every test this change owns, and the final gate's pass criterion is green-excluding-the-11 with receipts. This change touches no Rust code; the Rust phase is expected to show exactly those 11 failures at the final gate. No new failure may be treated as pre-existing unless it reproduces at base_ref.
- **base_ref immutability:** the branch is based at 34f425fa and NEVER rebases or re-targets during the run, even as `origin/main` advances past it (other agents merge PRs concurrently). The final delta review uses exactly base_ref...HEAD per the run contract.
- **Test commands:** focused Vitest via the repo-owned passthrough `npm run test:vitest -- run <files> --config config/vitest/vitest.config.ts` (run from the worktree). Typecheck with `npm run typecheck:client`. Lint with `npm run lint` (a11y plugin must stay clean). E2E via `npm run test:e2e:cloud -- --project=chromium <spec>` — `FRESHELL_E2E_BACKEND=cloud` is already set permanently in `~/.bashrc` (verified 2026-09-19 in a fresh login shell; `FRESHELL_VITEST_BACKEND=cloud` likewise), so the repo's ask-when-unset rule does not apply and NO user question is needed; cloud runs cost ~$0.03/run under the user's standing configuration, and the first cloud run at a new commit tag may pay a one-time image build (~13 min). Before filing the branch, the affected e2e specs must actually pass on the cloud backend (a spec in `CLOUD_SKIP_SPECS` or a filter matching no tests is not coverage).
- **A11y / e2e locator rules:** e2e specs may use only `getByRole` / `getByText` / `getByTestId` / `[data-*]` locator patterns; every interactive element asserted must be reachable that way.
- **Commit style:** focused conventional commits, one per task plus the plan commit.
- **Docs:** no `docs/index.html` update — this is a rendering provenance correction inside existing surfaces, not a new user-facing feature.

---

### Task 1: Shared pure classifier `reclassifyPtyNotificationTurns` + unit tests

**Files:**
- Modify: `shared/fresh-agent-turns.ts` (add exports after `freshAgentTurnText`, which ends at line 13)
- Test: `test/unit/shared/fresh-agent-turns.test.ts` (extend the existing `describe`)

**Interfaces:**
- Consumes: `FreshAgentTurn` type imported in `shared/fresh-agent-turns.ts:1` from `./fresh-agent-contract.js`; the existing `Extract<FreshAgentTurn['items'][number], { kind: 'text' }>` narrowing idiom (see `freshAgentTurnText`, lines 7-13).
- Produces: `export function reclassifyPtyNotificationTurns(turns: FreshAgentTurn[]): FreshAgentTurn[]` — user-role turns whose LEADING display text (first `kind: 'text'` item's `text`, else `summary`, trimmed) starts with `<pty_exited>`, `<pty_waited>`, or `<pty_wait_timeout>` are returned as new objects `{ ...turn, role: 'assistant' }`; every other turn keeps its identity, and the input array reference is returned unchanged when nothing matches (memo-stability).

- [ ] **Step 1: Write the failing behavioral test**

Add to the end of the existing `describe('fresh-agent display turn helpers', ...)` in `test/unit/shared/fresh-agent-turns.test.ts` (file imports at top already include the module via `../../../shared/fresh-agent-turns.js` — add `reclassifyPtyNotificationTurns` to that import list):

```ts
  describe('reclassifyPtyNotificationTurns', () => {
    const ptyTurn = (text: string, summary = text): FreshAgentTurn => ({
      id: 'pty-1',
      turnId: 'pty-1',
      role: 'user',
      summary,
      items: [{ id: 'pty-1-i0', kind: 'text', text }],
    })

    it('reclassifies <pty_exited>, <pty_waited>, and <pty_wait_timeout> user turns to assistant', () => {
      for (const tag of ['<pty_exited>', '<pty_waited>', '<pty_wait_timeout>']) {
        const turn = ptyTurn(`${tag}\nID: pty_x\nExit Code: 0`)
        const [mapped] = reclassifyPtyNotificationTurns([turn])
        expect(mapped?.role).toBe('assistant')
        expect(mapped?.id).toBe('pty-1')
        expect(mapped?.items).toEqual(turn.items)
      }
    })

    it('matches leading-tag text after trimming, and falls back to summary when no text item exists', () => {
      const [withWhitespace] = reclassifyPtyNotificationTurns([ptyTurn('  <pty_exited>\nLast Line: SYNC_EXIT=0')])
      expect(withWhitespace?.role).toBe('assistant')

      const summaryOnly: FreshAgentTurn = {
        id: 'pty-2',
        turnId: 'pty-2',
        role: 'user',
        summary: '<pty_exited>\nno items on this degraded snapshot',
        items: [],
      }
      const [fromSummary] = reclassifyPtyNotificationTurns([summaryOnly])
      expect(fromSummary?.role).toBe('assistant')
    })

    it('does not match when the tag appears mid-message (leading-anchored only)', () => {
      const turn = ptyTurn('Result of the run:\n<pty_exited>\nID: pty_x')
      const [mapped] = reclassifyPtyNotificationTurns([turn])
      expect(mapped?.role).toBe('user')
    })

    it('leaves non-matching user turns untouched and never touches non-user roles', () => {
      const plainUser: FreshAgentTurn = { id: 'u1', turnId: 'u1', role: 'user', summary: 'real prompt', items: [{ id: 'u1-i0', kind: 'text', text: 'real prompt' }] }
      const taggedAssistant: FreshAgentTurn = { id: 'a1', turnId: 'a1', role: 'assistant', summary: '<pty_exited>', items: [{ id: 'a1-i0', kind: 'text', text: '<pty_exited>' }] }
      // A user turn with NO text item (verified item shape from this file's
      // existing `freshAgentTurnText` test at :33) whose summary does not lead
      // with a tag: leading-text extraction falls to the summary, no match.
      const noTextItem: FreshAgentTurn = { id: 's1', turnId: 's1', role: 'user', summary: 'tool output', items: [{ id: 's1-i0', kind: 'thinking', text: 'internal' }] }

      const turns = [plainUser, taggedAssistant, noTextItem]
      const mapped = reclassifyPtyNotificationTurns(turns)

      expect(mapped).toBe(turns) // same array reference: nothing matched
      expect(mapped[0]).toBe(plainUser)
      expect(mapped[1]?.role).toBe('assistant')
      expect(mapped[2]).toBe(noTextItem)
    })

    it('returns a new array with new objects only for matches, preserving order and identity of the rest', () => {
      const plain: FreshAgentTurn = { id: 'u1', turnId: 'u1', role: 'user', summary: 'hi', items: [{ id: 'u1-i0', kind: 'text', text: 'hi' }] }
      const pty = ptyTurn('<pty_exited>\nID: pty_x')
      const turns = [plain, pty]
      const mapped = reclassifyPtyNotificationTurns(turns)

      expect(mapped).not.toBe(turns)
      expect(mapped).toHaveLength(2)
      expect(mapped[0]).toBe(plain)
      expect(mapped[1]).not.toBe(pty)
      expect({ ...mapped[1], role: 'user' }).toEqual(pty)
    })

    it('does not mutate its input (wire/store turns stay raw)', () => {
      const pty = ptyTurn('<pty_exited>\nID: pty_x')
      reclassifyPtyNotificationTurns([pty])
      expect(pty.role).toBe('user')
    })
  })
```

The test file's existing imports at the top already include `FreshAgentTurnSchema` from `../../../shared/fresh-agent-contract.js`; add a type import `FreshAgentTurn` from the same module if the file does not already have it.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the file fails at transform time with `shared/fresh-agent-turns.js does not provide an export named 'reclassifyPtyNotificationTurns'` (the export does not exist yet), so the whole file is red for the intended reason. The pre-existing assertions re-run green only after Step 3 adds the export.

- [ ] **Step 3: Add the minimal production implementation**

Append to `shared/fresh-agent-turns.ts`, directly after `freshAgentTurnText` (line 13), before `normalizeTurnRole`:

```ts
/**
 * Leading display text of a turn: the FIRST text item's text when one exists,
 * else the summary. The opencode-pty plugin injects its notification blocks as
 * the leading content of a user-role message, in both shapes.
 */
function leadingFreshAgentTurnText(turn: Pick<FreshAgentTurn, 'summary' | 'items'>): string {
  const firstText = turn.items.find(
    (item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text',
  )
  return (firstText?.text ?? turn.summary ?? '').trim()
}

const PTY_NOTIFICATION_TURN_PREFIXES = ['<pty_exited>', '<pty_waited>', '<pty_wait_timeout>'] as const

function isPtyNotificationTurn(turn: Pick<FreshAgentTurn, 'role' | 'summary' | 'items'>): boolean {
  if (turn.role !== 'user') return false
  const leading = leadingFreshAgentTurnText(turn)
  return PTY_NOTIFICATION_TURN_PREFIXES.some((prefix) => leading.startsWith(prefix))
}

/**
 * Display-only: opencode-pty plugin notification turns (machine-injected
 * user-role messages whose leading text is a `<pty_exited>` / `<pty_waited>` /
 * `<pty_wait_timeout>` block) present as agent text in the transcript. The
 * wire snapshot and store turns are never mutated — non-matching turns keep
 * their identity and the input array is returned unchanged when nothing
 * matches, so memoized consumers stay referentially stable.
 */
export function reclassifyPtyNotificationTurns(turns: FreshAgentTurn[]): FreshAgentTurn[] {
  let changed = false
  const mapped = turns.map((turn) => {
    if (!isPtyNotificationTurn(turn)) return turn
    changed = true
    return { ...turn, role: 'assistant' as const }
  })
  return changed ? mapped : turns
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all pre-existing tests plus the new describe).

- [ ] **Step 5: Refactor while green**

No refactor expected — the helper mirrors the file's existing idiom (`Extract<...>` narrowing from `freshAgentTurnText`, module-private helpers below the exported surface). If the implementation needed anything beyond the code above, tighten it back to this shape.

- [ ] **Step 6: Run impacted-test verification**

`shared/fresh-agent-turns.ts` is consumed by `src/components/fresh-agent/FreshAgentTranscript.tsx:28` (whose suite exercises the module's other exports) and its own test file. Run both together:

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (the memo is not yet composed with the classifier; transcript tests are unaffected by the mere existence of the export).

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-turns.ts test/unit/shared/fresh-agent-turns.test.ts
git commit -m "feat(fresh-agent): shared display-role classifier for opencode-pty notification turns"
```

---

### Task 2: Display wiring — transcript/minimap/e2e pins (red) + memo composition (green)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:28` (extend the existing import), `:1104-1106` (memo composition)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (new describe + one raw-rule guard test)
- Create: `test/e2e-browser/specs/fresh-agent-pty-notification-display.spec.ts`

**Interfaces:**
- Consumes: `reclassifyPtyNotificationTurns` from Task 1; `coalesceSyntheticToolResultTurns` (module-private, `FreshAgentTranscript.tsx:482-497`).
- Produces: no new interfaces. The memo becomes `coalesceSyntheticToolResultTurns(reclassifyPtyNotificationTurns(turns))` — classifier FIRST (PTY turns are text-bearing, so they are inert under the coalesce either way; classifier-first keeps the coalesce's input semantics unchanged for real tool-result turns).

- [ ] **Step 1: Write the failing behavioral tests (unit)**

Add a new top-level `describe` in `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (after the existing top-level `describe('FreshAgentTranscript', ...)` block, near the `rolled-back section` describe at :2862 — matching that describe's local `afterEach(() => cleanup())` convention). The file already imports `render`, `screen`, `within`, `fireEvent`, `cleanup`, `FreshAgentTranscript`, and the `FreshAgentTurn` type — no new imports needed:

```tsx
describe('PTY notification display role (opencode-pty plugin turns)', () => {
  afterEach(() => cleanup())

  const PTY_BLOCK = '<pty_exited>\nID: pty_d75e6fa9\nExit Code: 0\nTimed Out: no\nOutput Lines: 5\nLast Line: SYNC_EXIT=0\n</pty_exited>\n\nUse pty_read to check the full output.'

  it('renders a <pty_exited> user-role turn as agent text, never You', () => {
    const { container } = render(
      <FreshAgentTranscript
        turns={[
          { id: 'u1', turnId: 'u1', role: 'user', summary: 'please run the gate', items: [{ id: 'u1-i', kind: 'text', text: 'please run the gate' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'gate done', items: [{ id: 'a1-i', kind: 'text', text: 'gate done' }] },
        ]}
      />,
    )

    // The real human prompt is still user text: exactly one user article.
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(container.querySelectorAll('article[data-turn-role="user"]')).toHaveLength(1)

    // The PTY notification renders as agent text: assistant article, no You
    // header inside it, and an Assistant header (preceded by a user turn).
    // exact:false because the block renders as markdown paragraphs whose text
    // is 'Last Line: SYNC_EXIT=0', not the bare token.
    const ptyArticle = screen.getByText('SYNC_EXIT=0', { exact: false }).closest('article')
    expect(ptyArticle).not.toBeNull()
    expect(ptyArticle?.getAttribute('data-turn-role')).toBe('assistant')
    expect(within(ptyArticle as HTMLElement).queryByText('You')).not.toBeInTheDocument()
    expect(within(ptyArticle as HTMLElement).getByText('Assistant')).toBeInTheDocument()
  })

  it('renders <pty_exited> turn text through the markdown path, not as literal user text', () => {
    const text = '<pty_exited>\n**sync finished**\n</pty_exited>'
    const { container } = render(
      <FreshAgentTranscript
        turns={[{ id: 'pty1', turnId: 'pty1', role: 'user', summary: text, items: [{ id: 'pty1-i', kind: 'text', text }] }]}
      />,
    )

    // markdown={!isUser}: the reclassified turn's **…** renders as <strong>.
    expect(container.querySelector('article[data-turn-role="assistant"] strong')).not.toBeNull()
  })

  it('folds a <pty_exited> turn as a continuation of a preceding assistant turn', () => {
    const { container } = render(
      <FreshAgentTranscript
        agentLabel="Freshopencode"
        turns={[
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'first answer', items: [{ id: 'a1-i', kind: 'text', text: 'first answer' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
        ]}
      />,
    )

    // One speaker header for the whole assistant run; no You anywhere; both
    // articles carry the assistant role.
    expect(screen.getAllByText('Freshopencode')).toHaveLength(1)
    expect(screen.queryByText('You')).not.toBeInTheDocument()
    expect(container.querySelectorAll('article[data-turn-role="assistant"]')).toHaveLength(2)
  })

  it('gives a <pty_exited> turn the same toolbar affordances as any assistant turn (no Rewind button)', () => {
    // Agent-text parity pin: the hover toolbar's 'Rewind code to here' button
    // renders only for user-role turns. After reclassification the PTY turn
    // gets the identical (absent) toolbar affordance as any assistant turn.
    // The context menu / touch action sheet keep their disabled Undo/Rewind
    // entries for the reclassified turn — unchanged by design, exactly as for
    // every other assistant turn; that surface is out of scope.
    const onRewind = vi.fn()
    render(
      <FreshAgentTranscript
        canFork={false}
        onRewindToTurn={onRewind}
        turns={[
          { id: 'u1', turnId: 'u1', role: 'user', summary: 'run the gate', items: [{ id: 'u1-i', kind: 'text', text: 'run the gate' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'done', items: [{ id: 'a1-i', kind: 'text', text: 'done' }] },
        ]}
      />,
    )

    const rewindButtons = screen.getAllByRole('button', { name: 'Rewind code to here' })
    expect(rewindButtons).toHaveLength(1)
    fireEvent.click(rewindButtons[0])
    expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', role: 'user' }))
  })

  it('counts a rolled-back <pty_exited> marker row as a user step (raw rule: the classifier never feeds the stepper)', () => {
    // Constraint guard, not new behavior: rolledBackTurns is a raw prop that
    // never passes through the displayTurns memo. A <pty_exited> marker row
    // MUST still count toward the step label pinned to the server's
    // rollback.undoneDepth (see the rolled-back section tests at :2891).
    render(
      <FreshAgentTranscript
        turns={[{ id: 'u1', turnId: 'u1', role: 'user', summary: 'live prompt', items: [{ id: 'u1-i', kind: 'text', text: 'live prompt' }] }]}
        rolledBackTurns={[
          { id: 'u2', turnId: 'u2', role: 'user', summary: 'second prompt', items: [{ id: 'u2-i', kind: 'text', text: 'second prompt' }], rolledBack: true, restorable: true },
          { id: 'a2', turnId: 'a2', role: 'assistant', summary: 'second answer', items: [{ id: 'a2-i', kind: 'text', text: 'second answer' }], rolledBack: true, restorable: true },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }], rolledBack: true, restorable: true },
        ]}
      />,
    )

    // Two USER-role marker rows (real prompt + PTY notification) ⇒ (2), not (1):
    // routing marker rows through the classifier would break the sum-to-undoneDepth pin.
    expect(screen.getByText('Rolled back (2) — gone from the conversation; redo to restore.')).toBeInTheDocument()
  })
})
```

Expected RED/GREEN status per test when run BEFORE the production wiring:
- tests 1-4: RED (the memo does not reclassify: no assistant-role article, plain-text user rendering, no continuation fold, 2 rewind buttons).
- test 5 (raw-rule guard): GREEN already — it pins a constraint that must NOT change; it fails only if someone wrongly routes `rolledBackTurns` through the classifier.

- [ ] **Step 2: Run the unit tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`

Expected: the four display tests FAIL for the intended reason (PTY turn still renders as `data-turn-role="user"` / 'You' / literal text / 2 rewind buttons); the raw-rule guard test PASSES; all pre-existing tests in the file PASS.

- [ ] **Step 3: Write the failing e2e test**

Backend: `FRESHELL_E2E_BACKEND=cloud` is permanently set in `~/.bashrc` (verified 2026-09-19 in a fresh login shell) — no user question is needed; every e2e command in this task runs on the cloud backend.

Lane choice: the route-intercept lane (schema-valid snapshot fulfilled in the browser, no provider binary) is the right level for this change — the change is client-display-only and the Rust role mapping that a full-stack fake-serve lane would exercise (`opencode_role`, snapshot contract) is untouched and already pinned by the Rust tests. Route-intercept also keeps the spec cloud-legal.

Lane receipt first: run the donor spec once from the worktree BEFORE authoring the new spec:

`npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts`

Expected: PASS — this receipts that the route-intercept e2e lane works at base from this worktree (validator load-bearing evidence in `reports/load-bearing-strategist.md` §C1; the donor spec is cloud-legal — absent from `CLOUD_SKIP_SPECS` and `LOCAL_ONLY_SPECS`). A donor failure here is an environment/lane breakage, never attributable to this change — stop and escalate rather than proceeding to the new spec. Budget a possible one-time ~13-min cloud image build at the commit tag on the first run.

Create `test/e2e-browser/specs/fresh-agent-pty-notification-display.spec.ts` (adapted verbatim from `seedMinimapPane` at `test/e2e-browser/specs/transcript-minimap.spec.ts:49-99`, re-routed to an opencode pane — the only existing freshopencode route-intercept precedent, `freshopencode-model-picker.spec.ts:129`, seeds `turns: []`, so this is the first to seed a freshopencode pane with non-empty turns):

```ts
import { test, expect } from '../helpers/fixtures.js'

function tallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 60 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
  ).join('\n\n')
}

const PTY_EXITED_BLOCK = [
  '<pty_exited>',
  'ID: pty_d75e6fa9',
  'Description: Live backup sync run, script via stdin',
  'Exit Code: 0',
  'TimeoutSeconds: 3600',
  'Timed Out: no',
  'Output Lines: 5',
  'Last Line: SYNC_EXIT=0',
  '</pty_exited>',
  '',
  'Use pty_read to check the full output.',
].join('\n')

/** Convert the active terminal leaf into a freshopencode pane whose routed
 * thread snapshot carries the given turns. Same shape as transcript-minimap.spec.ts's
 * seedMinimapPane (which cites fresh-agent.spec.ts's installFreshclaudeStripPane):
 * network effects suppressed BEFORE the conversion so the pane never
 * WS-connects; the REST snapshot is the only fetch. No provider binary
 * involved, so the spec is cloud-legal. */
async function seedOpencodePane(page: any, sessionId: string, turns: unknown[]) {
  await page.route(`**/api/fresh-agent/threads/freshopencode/opencode/${sessionId}*`, async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: sessionId,
        sessionId,
        revision: 1,
        latestTurnId: (turns[turns.length - 1] as { id?: string } | undefined)?.id ?? null,
        status: 'idle',
        summary: '',
        // Capability values mirror the Rust opencode snapshot builder
        // (crates/freshell-freshagent/src/lib.rs, build_opencode_snapshot_json).
        capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
        settings: { model: 'default', permissionMode: 'default', plugins: [] },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        turns,
        extensions: {},
      }),
    })
  })
  await page.evaluate((currentSessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (!tabId || !paneId) return
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: `req-pty-notify-${currentSessionId}`,
          sessionId: currentSessionId,
          sessionRef: { provider: 'opencode', sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, sessionId)
}

test.describe('fresh-agent PTY notification display role', () => {
  test('renders opencode-pty exit notifications as agent text with no minimap tick', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000bb201'
    await seedOpencodePane(page, sessionId, [
      { id: 'turn-pty-u1', turnId: 'turn-pty-u1', role: 'user', summary: 'Run the backup sync now', items: [{ id: 'item-pty-u1', kind: 'text', text: 'Run the backup sync now' }] },
      { id: 'turn-pty-a1', turnId: 'turn-pty-a1', role: 'assistant', summary: 'Starting it in a background session', items: [{ id: 'item-pty-a1', kind: 'text', text: tallBody('Starting') }] },
      { id: 'turn-pty-n1', turnId: 'turn-pty-n1', role: 'user', summary: PTY_EXITED_BLOCK, items: [{ id: 'item-pty-n1', kind: 'text', text: PTY_EXITED_BLOCK }] },
      { id: 'turn-pty-a2', turnId: 'turn-pty-a2', role: 'assistant', summary: 'Sync finished cleanly', items: [{ id: 'item-pty-a2', kind: 'text', text: tallBody('Finished') }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    // The notification renders as AGENT text: assistant article, no 'You' inside it.
    const ptyArticle = freshPane.locator('article[data-turn-role="assistant"]', { hasText: 'SYNC_EXIT=0' })
    await expect(ptyArticle).toBeVisible()
    await expect(ptyArticle.getByText('You')).toHaveCount(0)
    // The real human prompt is still user text.
    await expect(freshPane.locator('article[data-turn-role="user"]', { hasText: 'Run the backup sync now' })).toBeVisible()
    // No user article carries the PTY block.
    await expect(freshPane.locator('article[data-turn-role="user"]', { hasText: 'SYNC_EXIT=0' })).toHaveCount(0)

    // Minimap: exactly one tick — the real human prompt — and its label is
    // that prompt, never the PTY block.
    await expect(freshPane.getByTestId('transcript-minimap-viewport')).toBeVisible()
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(1)
    await expect(freshPane.getByRole('button', { name: 'Jump to prompt: Run the backup sync now', exact: true })).toBeVisible()
  })
})
```

Execution contingency: the snapshot body is adapted from the claude-seeded helper; `settings`/`extensions` are schema-optional generic objects. If the pane fails to render (route JSON rejected by `FreshAgentSnapshotSchema`), compare the schema in `shared/fresh-agent-contract.ts` and adjust only the seeded snapshot's optional fields — never the production code.

- [ ] **Step 4: Run the e2e test and verify the intended failure**

Run: `npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/fresh-agent-pty-notification-display.spec.ts`

Expected: FAIL — `article[data-turn-role="assistant"]` with `SYNC_EXIT=0` never appears (the PTY turn renders as a user article today), and the minimap rail shows 2 `Jump to prompt:` ticks (both user-role turns).

RED attribution criteria (a wrong-reason failure must not be mistaken for the intended one):
- Intended RED: the fresh pane and transcript scroller become visible, and the failure is the assistant-article visibility timeout and/or the user-article count assertion, while the seeded turns visibly render (the `Run the backup sync now` user article is present, the PTY block text is inside a `data-turn-role="user"` article).
- Wrong-reason RED (seed/lane failure): the pane or scroller never becomes visible, or no seeded turn text renders anywhere → apply the snapshot-shape contingency above (adjust ONLY the seeded snapshot's optional fields; never production code) and re-run. If it still fails, stop and escalate — do not swap lanes and do not touch the classifier.

- [ ] **Step 5: Add the minimal production implementation**

Edit 1 — `src/components/fresh-agent/FreshAgentTranscript.tsx:28`, extend the existing import:

```ts
import { getFreshAgentDisplayTurnKey, reclassifyPtyNotificationTurns, turnSummaryIsAuthored } from '@shared/fresh-agent-turns'
```

Edit 2 — `src/components/fresh-agent/FreshAgentTranscript.tsx:1104-1106`, compose the classifier first inside the existing memo (replace only the inner call; keep the `useMemo`/deps shape untouched):

```ts
  const displayTurns = useMemo(() => (
    coalesceSyntheticToolResultTurns(reclassifyPtyNotificationTurns(turns))
  ), [turns])
```

- [ ] **Step 6: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/shared/fresh-agent-turns.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all five new tests plus every pre-existing test in both files).

Run the e2e again (same command as Step 4).

Expected: PASS — assistant article visible with the PTY text, zero user articles with it, exactly one minimap tick labeled `Jump to prompt: Run the backup sync now`.

- [ ] **Step 7: Refactor while green**

No refactor expected: the production change is one import + one memo composition at the single documented choke point. If any test required a second production edit, stop — that means the choke-point assumption broke and the plan (not the code) needs revisiting with the coordinator.

- [ ] **Step 8: Run impacted-test verification**

The change lands in `FreshAgentTranscript.tsx` (the memo), consumed by: its own suite, the minimap suite (rail renders from the memo's DOM output), the measurement suite (the `[data-turn-role="user"]` sweep), the turn-actions suite (role gates), and `FreshAgentView`'s suite (renders the transcript; its raw-snapshot fixtures seed no PTY turns, so it must stay green unchanged). The classifier's suite is also in the set.

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/unit/client/components/fresh-agent/transcript-measurement.test.ts test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts test/unit/client/components/fresh-agent/FreshAgentTurnActions.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS. Then `npm run typecheck:client` — PASS. Then `npm run lint` — clean (no new violations; the a11y plugin gates CI).

- [ ] **Step 9: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/e2e-browser/specs/fresh-agent-pty-notification-display.spec.ts
git commit -m "feat(fresh-agent): render opencode-pty notifications as agent text in the transcript display"
```

---

## Final verification (after Task 2)

1. Focused suites green (Task 2 Step 8).
2. E2E: donor-spec lane receipt (Task 2 Step 3) and the new spec both pass on the cloud backend (`FRESHELL_E2E_BACKEND=cloud`, set in `~/.bashrc`).
3. Full-suite gate per [usual-executing-plans] from the worktree HEAD, judged per phase (the composite `npm test` runner aborts at its first failing phase; rust is red at base with the ledgered 11, so the composite reaching rust-red is expected and is NOT itself a gate failure):
   - client phase: green.
   - source-runtime phase: green.
   - rust phase: red with EXACTLY the baseline ledger's 11 recorded pre-existing failures (receipts in `reports/workspace-baseline.md`); any other rust failure must be attributed to this change (impossible by construction — no Rust file changes — and must then be reproduced at base_ref and ledgered before being excluded).
   - electron + electron-runtime lanes: unreachable via the composite once rust fails — run both lane commands separately at HEAD: `npm run test:electron`, then the staging chain (`npm run build:rust && npm run build:client && npm run build:tools && npm run prepare:claude-sidecar && npm run prepare:electron-runtime`) followed by `npm run test:electron:runtime`. Base receipts proving both lanes green at the base-equivalent tree (42 files/372 tests and 1 file/2 tests respectively) are in `reports/load-bearing-validator-C2.md`. Expect the same green at HEAD; any HEAD failure is attributable to this change, anchored by those base receipts.
4. `git status` clean of stray files; worktree contains exactly: the plan commits + Task 1 commit + Task 2 commit.

## Out-of-scope notes (do not build)

- No Rust changes: `opencode_role` (lib.rs:3265) keeps mapping the wire verbatim; a `<pty_exited>` user message stays `role:"user"` in the snapshot — "exactly what the model sees" (lib.rs:4241-4246).
- No minimap-component, measurement, TurnActions, ItemCard, or View edits: those consumers key off `data-turn-role` / memo output automatically.
- No changes to `freshAgentSnapshotHasUserTurn` (auto-title boundary semantics stay raw), `localEchoLanded`, checkpoints, the rollback stepper, or the read-model/search lanes.
- The opencode CLI/TUI's own rendering is upstream opencode behavior — out of scope.
