# Collapsed Thought Strip Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fresh-agent transcript collapsed activity line: a single collapsed line reading "thought - N tools used" (N = number of tool uses in the run), no matter how many thinking rows exist and even when thinking rows are interleaved with tool uses. Interleaved thinking rows are absorbed into that single line instead of rendering as separate collapsed "Thinking" rows.

### Explicit constraints
- Execute via the-usual workflow.
- Repo rules: dedicated worktree branch from origin/main; red/green/refactor TDD; unit + e2e coverage; no direct pushes to main; stop before PR creation without explicit user approval.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** In fresh-agent transcripts, a tool-bearing activity line that is collapsed renders exactly one row — the existing `thought · N tools used` summary — with every thinking row (however many, wherever interleaved) hidden behind the strip's expand toggle instead of stacked below it as separate "Thinking" disclosures.

**Architecture:** One production rule changes in `FreshAgentActivityStrip`'s collapsed branch (`src/components/fresh-agent/FreshAgentTranscript.tsx`): hoisted `FreshAgentThinkingRow` disclosures render while collapsed only when the line has zero tool rows (`tools.length === 0`). `settledSummary` already carries the `thought` segment for any thinking content, so the summary line alone represents the collapsed state of tool-bearing lines. Thinking-only lines keep today's hoisted disclosures; the expanded state is unchanged (rows render inline in item order); the `pushThinking` consecutive-merge, liveness/reel rules, caption anchoring, and per-row expansion persistence (`thinkingExpandedById`) are all untouched. This supersedes the 2026-09-12 expand-toggles plan's D1 "thinking rows are never hidden behind the strip's tool disclosure" clause for tool-bearing lines only (that plan file is a historical record and is not edited).

**Tech Stack:** React 18 + TypeScript, Testing Library (jsdom) unit tests under Vitest default config, Playwright e2e (mock REST snapshot + `__FRESHELL_TEST_HARNESS__`, no real CLI), Tailwind utility classes.

## Global Constraints

- **Summary text format is unchanged.** The collapsed line keeps the existing `settledSummary` output: `thought · N tool used` (singular) / `thought · N tools used` (plural), middle-dot separator, optional ` · N files changed` suffix, thinking-only fallback `thought`. The User Request's "thought - 4 tools used" names the line visible in the user's screenshot — which is this existing format (the hyphen is a plain-text transcription of the middle dot). Do NOT change the separator, wording, or count semantics (N counts tool rows only, never thinking rows).
- **Thinking-only lines (zero tool rows) keep today's behavior**: hoisted `Thinking` disclosures render under the `thought` summary while collapsed, including live rows mid-stream. The User Request specifies the tool-bearing run; do not extend the hiding rule to thinking-only lines.
- **The expanded state is unchanged**: thinking rows, tool rows, and captions render inline in item order inside `fresh-agent-activity-details`.
- **A11y contracts are preserved**: `div[role="region"][aria-label="Activity strip"]`, `button[aria-label="Toggle activity details"]`, `button[aria-label="Thinking"][aria-expanded]`, `span[role="status"]` reel, `aria-label="running"`/`"error"`, `pre[data-tool-input]`/`pre[data-tool-output]`, `.fresh-agent-thinking-body`, and all `data-testid` hooks stay exactly as they are. No new interactive elements without accessible names.
- **Scope rule**: preserve pre-existing code and behavior unless satisfying the User Request requires changing them. The 2026-09-12 plan doc (`docs/plans/2026-09-12-freshagent-expand-toggles.md`) is historical — never edit it; this plan supersedes its D1 clause for tool-bearing lines.
- **Test coordination**: focused vitest runs via the repo-owned path `npm run test:vitest -- run <path> --config config/vitest/vitest.config.ts` need no coordinator; broad/full-suite runs go through the coordinator (`npm test`) or `scripts/base-gate.sh`. E2e: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts [--grep "..."]` (local backend; `FRESHELL_E2E_BACKEND` is unset → local default). Every e2e spec changed here must pass on the configured backend before any PR.
- **Process safety**: never restart the self-hosted server; never run broad kill patterns. All work stays inside the worktree `/home/dan/code/freshell/.worktrees/collapsed-thought-strip` on branch `the-usual/collapsed-thought-strip` (base_ref `e46020b4d21d30ba54032c30b56111b8c93b7c76`).
- **Style**: no comments added to code unless they explain a non-obvious contract (this repo comments liberally in the fresh-agent components — match that local style where the existing comment block at the change site must be rewritten because its contract changes).

---

### Task 1: Hide hoisted thinking rows on collapsed tool-bearing lines (production + unit tests)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:663-669` (collapsed-branch hoist in `FreshAgentActivityStrip`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (rework 8 tests + add 1 new test)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:780-838` (rework 1 test)

**Interfaces:**
- Consumes: `ActivityRow` union (`FreshAgentTranscript.tsx:80-83`), `activityTools(rows)` (`:176-180`), `thinkingRows` filter + `renderThinkingRow` (`:596-608`), all unchanged.
- Produces: the collapsed-render rule `{tools.length === 0 ? thinkingRows.map(renderThinkingRow) : null}` — Tasks 2 and 3 depend on this behavior only; no signature changes.

- [ ] **Step 1: Write the failing behavioral test**

First ensure dependencies: run `npm ci --no-audit --no-fund` in the worktree (fresh worktree, no node_modules).

Add this test to `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`, immediately after the `folds thinking into the activity strip with tools` test (it currently ends around line 248):

```tsx
  it('collapses an interleaved thinking-and-tool line to the single summary', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thought and ran',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'first stretch of reasoning' },
              { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'npm test' } },
              { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              { id: 'think-2', kind: 'thinking', text: 'second stretch of reasoning' },
              { id: 'tool-2', kind: 'tool_use', toolUseId: 'call-2', name: 'Read', input: { file_path: 'src/a.ts' } },
              { id: 'result-2', kind: 'tool_result', toolUseId: 'call-2', content: 'ok', isError: false },
            ],
          },
        ]}
      />,
    )

    const strip = screen.getByRole('region', { name: 'Activity strip' })
    expect(strip).toHaveTextContent('thought · 2 tools used')
    // The collapsed tool-bearing line is the summary ALONE: both thinking
    // stretches are absorbed into the 'thought' segment — no hoisted
    // disclosures, no visible thinking text.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('first stretch of reasoning')).not.toBeInTheDocument()
    expect(screen.queryByText('second stretch of reasoning')).not.toBeInTheDocument()
    // Expanding the strip reveals BOTH thinking rows (kept separate by the
    // intervening tool rows) plus the two tool rows, in item order.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getAllByRole('button', { name: 'Thinking' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read tool call' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts -t "collapses an interleaved thinking-and-tool line"`

Expected: FAIL because `queryByRole('button', { name: 'Thinking' })` finds the two hoisted disclosures the current code renders below the summary — the missing behavior is the collapsed-state hiding rule, not a setup error.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, replace the comment block and hoist in the collapsed branch (currently `:663-669`):

```tsx
          {/* Hoisted thinking rows: on a thinking-only line, every thinking
            * row — including LIVE rows mid-stream — renders its own
            * expandable disclosure under the summary. On a line that used
            * tools, the collapsed view is the single summary line alone:
            * the 'thought' segment carries the thinking, and the rows are
            * reachable by expanding the strip's tool disclosure (where
            * they render in item order). */}
          {tools.length === 0 ? thinkingRows.map(renderThinkingRow) : null}
```

(Replacing the old comment `Hoisted thinking rows: thinking is NEVER hidden behind the strip's tool disclosure...` and the old hoist `{thinkingRows.map(renderThinkingRow)}`. `tools` is already computed at `:584` via `activityTools(displayRows)`.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts -t "collapses an interleaved thinking-and-tool line"`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor: the change is one render expression plus its contract comment. Verify no dead state results — `renderThinkingRow`/`thinkingExpandedById` are still used by the expanded branch and by thinking-only lines.

- [ ] **Step 6: Run impacted-test verification — rework the tests that pinned the old hoisting**

Eight tests in this file pinned hoisted `Thinking` buttons on tool-bearing lines while collapsed; they now fail and must be reworked to pin the new behavior (all use the `mixedTurn` fixture `[thinking, tool_use Bash]` except the first). Rework each to the code below (same file, same describe block order):

1. `folds thinking into the activity strip with tools` — replace everything from the first assert (`expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent(...)`) through the end of the test with:

```tsx
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('thought · 1 tool used')
    // Collapsed tool-bearing line: the summary is the strip's ONLY row —
    // the thinking is absorbed into the 'thought' segment, with no hoisted
    // disclosure.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    // Expanding the strip reveals the thinking row AND the tool row.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
```

2. `renders thinking rows regardless of the expandThinking setting and of strip expansion` — rename to `gates thinking rows behind the strip toggle on tool-bearing lines` and replace the body with:

```tsx
      const first = render(<FreshAgentTranscript turns={[mixedTurn]} />)
      // Compact mount (expandTools unset): the single summary line only.
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expanding the strip reveals the thinking row; the body stays gated
      // behind its own click.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const thinking = screen.getByRole('button', { name: 'Thinking' })
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
      fireEvent.click(thinking)
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      // Collapse the strip: the thinking row hides behind the single
      // summary line again.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      first.unmount()

      // Same line with expandThinking on: the setting governs the row's
      // starting body state inside the expanded strip, never its presence.
      render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
```

3. `starts thinking rows expanded when expandThinking is true` — replace the body with:

```tsx
      const { container } = render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      // Compact mount: the thinking row is not rendered at all.
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expanding the strip: the thinking body is ALREADY open — the
      // setting set the row's start state at its mount.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(container.querySelector('.fresh-agent-thinking-body')).toBeTruthy()
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
```

4. `starts thinking rows collapsed by default` — replace the body with:

```tsx
      const { container } = render(<FreshAgentTranscript turns={[mixedTurn]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const thinking = screen.getByRole('button', { name: 'Thinking' })
      expect(thinking).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelector('.fresh-agent-thinking-body')).toBeNull()
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
```

5. `a user-expanded thinking row stays expanded across the tool-disclosure toggle` — replace the body with:

```tsx
      render(<FreshAgentTranscript turns={[mixedTurn]} />)
      // Defaults off: expand the strip, then open the thinking body by hand.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      // Collapse the strip: the row hides behind the single summary line.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Re-expand: the row's user-opened body is STILL open (the per-row
      // override survives the strip toggle in the never-unmounted strip).
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
```

6. `a user-collapsed thinking row stays collapsed across the tool-disclosure toggle with expandThinking on` — replace the body with:

```tsx
      render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      // "Expand thinking" on: expanding the strip shows the body ALREADY
      // open (the setting set the row's start state); the user collapses it.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
      // Toggle the strip (collapsed and back): the body stays hidden — the
      // setting never re-asserts itself mid-session.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
```

7. `mounts the strip collapsed by default (expandTools unset)` — replace the trailing comment and its three asserts (from `// Tool rows and captions render only when the strip is expanded; thinking rows are present even while collapsed.` through `expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()`) with:

```tsx
      // Tool rows, captions, and — on this tool-bearing line — thinking
      // rows render only when the strip is expanded.
      expect(screen.queryByRole('button', { name: 'Bash tool call' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
```

8. `the expanded state swaps the summary for detail behind the persistent toggle` — replace the body with:

```tsx
      render(<FreshAgentTranscript turns={[mixedTurn]} />)
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      // Collapsed: the settled summary is the strip's one line, and it is
      // the ONLY row (no hoisted thinking disclosure on a tool-bearing
      // line).
      expect(strip).toHaveTextContent('thought · 1 tool used')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expand: the toggle row persists and the summary text is REPLACED by
      // the detail rows — including the thinking row.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
      expect(strip).not.toHaveTextContent('1 tool used')
      expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
      // Collapse: the summary returns and the thinking row hides again.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(strip).toHaveTextContent('thought · 1 tool used')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
```

Also rework `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:780-838` — rename `mounts thinking rows and a collapsed strip by default` to `mounts a collapsed strip by default and gates thinking rows behind the strip toggle` and replace everything from the `// Thinking rows always render:` comment through the end of the test with:

```tsx
    // Compact defaults: a tool-bearing line collapses to the single summary
    // line — no hoisted Thinking trigger while the strip is collapsed.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('default-visible thinking')).not.toBeInTheDocument()
    // Expanding the strip reveals the thinking row and the tool row; the
    // block itself starts collapsed (expandTools governs the strip's
    // starting state, not the per-block in-pane toggles) and opens on its
    // own click.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    expect(screen.queryByText('default-visible thinking')).not.toBeInTheDocument()
    const toolButton = screen.getByRole('button', { name: 'Bash tool call' })
    expect(toolButton).toBeInTheDocument()
    fireEvent.click(toolButton)
    expect(screen.getByText('npm run display-check')).toBeInTheDocument()
```

(Keep the existing `waitFor` summary assert and the toggle assert above this section unchanged.)

The impact set also includes every other fresh-agent component test (ItemCard, SharedWidgets, StatusStrip, Mobile, View subfiles) and the boundary KEEPs: thinking-only lines (`renders a live thinking row disclosure while streaming with the strip collapsed`, `renders a thinking-only turn as an activity strip (never dropped)`, `does not show a second running indicator...`, `expansion is per-mount state, never re-synced from props`, `keeps liveness pinned to the last non-caption row...`) must still pass UNCHANGED — they pin the thinking-only boundary of this change. Run the whole fresh-agent unit directory:

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS (every test file in the directory, including all 99 tests in the transcript file). If a test not listed above fails, examine whether it pinned hoisted rows on a tool-bearing line while collapsed (rework it per the same pattern) or whether the production change over-hid thinking-only lines (fix the production change — the boundary is `tools.length === 0`).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(fresh-agent): collapse tool-bearing lines to the single thought summary"
```

---

### Task 2: E2E coverage — gate Thinking disclosures behind the strip toggle (fresh-agent.spec.ts)

**Files:**
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts` (rework 4 tests + 1 step inside the style test, add 1 new test in `expansion defaults and settings`)

**Interfaces:**
- Consumes: Task 1's production behavior; existing helpers `seedCollapsePane` (spec `:72-115`), the `mixedThinkingToolTurns` fixture (`:1713-1723`), and the mock-harness flow (no real CLI).
- Produces: e2e pins of the new collapsed contract. No production changes.

- [ ] **Step 1: Write the failing e2e test first, then rework the stale pins**

Add this test inside `test.describe('expansion defaults and settings')` right after `mixedThinkingToolTurns`:

```ts
  test('collapses an interleaved thinking-and-tool line to the single summary', async ({ freshellPage: _freshellPage, page, terminal }) => {
    const interleavedTurns = [
      { id: 'turn-user', turnId: 'turn-user', role: 'user', summary: 'run the checks',
        items: [{ id: 'item-user', kind: 'text', text: 'run the checks' }] },
      {
        id: 'turn-mixed', turnId: 'turn-mixed', role: 'assistant', summary: 'thought and read',
        items: [
          { id: 'think-1', kind: 'thinking', text: 'first stretch of reasoning' },
          { id: 'tool-1', kind: 'tool_use', toolUseId: 'c-1', name: 'Read', input: { file_path: 'src/a.ts' } },
          { id: 'result-1', kind: 'tool_result', toolUseId: 'c-1', content: 'ok', isError: false },
          { id: 'think-2', kind: 'thinking', text: 'second stretch of reasoning' },
          { id: 'tool-2', kind: 'tool_use', toolUseId: 'c-2', name: 'Read', input: { file_path: 'src/b.ts' } },
          { id: 'result-2', kind: 'tool_result', toolUseId: 'c-2', content: 'ok', isError: false },
        ],
      },
    ]
    await seedCollapsePane(page, terminal, 'interleaved-thought-thread', interleavedTurns)
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strip = pane.getByRole('region', { name: 'Activity strip' }).first()
    // The interleaved line collapses to ONE row: the summary alone, with
    // both thinking stretches absorbed into the 'thought' segment.
    await expect(strip.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await expect(strip).toContainText('thought · 2 tools used')
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
    // Expanding the strip reveals BOTH thinking rows (kept separate by the
    // intervening tools) alongside the two tool rows.
    await strip.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(2)
    await expect(strip.getByRole('button', { name: 'Read tool call' })).toHaveCount(2)
  })
```

- [ ] **Step 2: Run the new test — verify it pins the landed behavior**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "collapses an interleaved thinking-and-tool line"`

Expected: PASS — the production behavior landed in Task 1 makes this green; this step adds the e2e-layer pin. To see the intended red, optionally run it once against the pre-change code (`git stash` is forbidden — instead `git worktree add` a scratch at `base_ref` or temporarily revert the Task 1 commit): before Task 1 the run fails at `toHaveCount(0)` because two hoisted `Thinking` disclosures stack below the summary. Contingency: if Playwright reports a missing browser, run `npx playwright install chromium` once before retrying.

- [ ] **Step 3: Rework the four stale e2e pins (no production changes)**

1. `mounts the activity strip compact by default and never hides the Thinking disclosure` → rename to `mounts the activity strip compact by default and gates the Thinking disclosure behind the strip toggle`; replace everything after the `const strip = pane.getByRole('region', { name: 'Activity strip' }).first()` line with:

```ts
    await expect(strip.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await expect(strip).toContainText('thought · 1 tool used')
    // Collapsed tool-bearing line: the summary is the strip's ONLY row —
    // no hoisted Thinking disclosure.
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
    await expect(strip.getByText('weighing which files to read first')).toHaveCount(0)
    // Expanding the strip reveals the thinking row and the tool row.
    await strip.getByRole('button', { name: 'Toggle activity details' }).click()
    const thinking = strip.getByRole('button', { name: 'Thinking' })
    await expect(thinking).toBeVisible()
    await expect(strip.getByRole('button', { name: 'Read tool call' })).toHaveCount(1)
    // Click Thinking → the body opens inside the expanded strip.
    await thinking.click()
    await expect(strip.locator('.fresh-agent-thinking-body', { hasText: 'weighing which files to read first' })).toBeVisible()
    // The tool block mounts as its own collapsed disclosure under the
    // compact default — expand it and assert its raw input via the pre,
    // strict-mode-safe (the expanded tool block renders the path as both
    // preview span and pre body).
    await strip.getByRole('button', { name: 'Read tool call' }).click()
    await expect(pane.locator('pre[data-tool-input]').filter({ hasText: 'src/a.ts' })).toBeVisible()
    // Collapse again: the summary returns and the Thinking trigger hides
    // with it; re-expanding shows the user-opened body STILL open (the
    // per-row override survives the strip toggle in the never-unmounted
    // strip).
    await strip.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(strip).toContainText('thought · 1 tool used')
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
    await strip.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(strip.locator('.fresh-agent-thinking-body', { hasText: 'weighing which files to read first' })).toBeVisible()
```

2. `the Expand tools setting starts strips expanded on return from settings`: replace the first `// Thinking never disappears in any state.` + `await expect(strip.getByRole('button', { name: 'Thinking' })).toBeVisible()` with:

```ts
    // Collapsed tool-bearing line: no hoisted Thinking disclosure.
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
```

Keep the expanded-state assert (`stripAfter` Thinking visible). Replace the final block's last line (`await expect(stripOff.getByRole('button', { name: 'Thinking' })).toBeVisible()`) with `await expect(stripOff.getByRole('button', { name: 'Thinking' })).toHaveCount(0)` and update its trailing comment ("the Thinking trigger never disappears") to "// the Thinking disclosure stays gated behind the compact strip".

3. `the Expand thinking setting starts thinking rows expanded with the strip still compact` → rename to `the Expand thinking setting starts thinking rows expanded inside an expanded strip`; rework the body: replace the `// Compact mount: the Thinking disclosure renders collapsed.` comment and its three asserts (`const thinking` declaration, `toBeVisible`, `aria-expanded` check, and the body-count check) with:

```ts
    // Compact mount: the tool-bearing line collapses to the single summary —
    // the Thinking disclosure is gated behind the strip toggle.
    await expect(strip.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await expect(strip.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
    await expect(strip.getByText('weighing which files to read first')).toHaveCount(0)
```

After the settings flip and remount (`stripAfter`), replace the thinking asserts with:

```ts
    await expect(stripAfter.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await expect(stripAfter.getByRole('button', { name: 'Thinking' })).toHaveCount(0)
    // Expanding the strip: the thinking row starts with its body ALREADY
    // open (the setting set the row's start state) — no Thinking click.
    await stripAfter.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(stripAfter.locator('.fresh-agent-thinking-body', { hasText: 'weighing which files to read first' })).toBeVisible()
```

After flipping the setting back off and remounting (`stripOff`), replace the final thinking asserts with:

```ts
    await expect(stripOff.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await stripOff.getByRole('button', { name: 'Toggle activity details' }).click()
    const thinkingOff = stripOff.getByRole('button', { name: 'Thinking' })
    await expect(thinkingOff).toHaveAttribute('aria-expanded', 'false')
    await expect(stripOff.getByText('weighing which files to read first')).toHaveCount(0)
```

4. `authored prose never folds`: replace the entire block from the `// Hoisted thinking rows: stripTwo's reasoning disclosure is visible` comment through the final `await expect(pane.getByTestId('fresh-agent-activity-caption')).toHaveCount(0)` with:

```ts
    // stripTwo's reasoning row is gated behind the strip toggle on its
    // tool-bearing line — expand the strip first, then press Thinking and
    // assert the prose.
    const stripTwo = pane.getByRole('region', { name: 'Activity strip' }).nth(1)
    await stripTwo.getByRole('button', { name: 'Toggle activity details' }).click()
    const thinking = stripTwo.getByRole('button', { name: 'Thinking' })
    await expect(thinking).toBeVisible()
    await thinking.click()
    await expect(stripTwo.getByText('Pausing to plan the next step').first()).toBeVisible()
    await expect(pane.getByTestId('fresh-agent-activity-caption')).toHaveCount(0)
```

Also update that test's opening doc comment (spec `:2007-2012`): replace `The prose lives in the always-rendered reasoning row (hoisted — its disclosure is visible while the strip stays compact);` with `The prose lives in the reasoning row inside the strip's expansion;` — the old sentence describes the superseded hoisting contract.

5. Style test (`style setting persists per Fresh Agent pane type and applies serif rendering`), the freshcodex compact block around `:1031-1040`: re-order so the strip expands before the Thinking press:

```ts
    // Compact default: the strip mounts COLLAPSED; on this tool-bearing
    // line the thinking row is gated behind the strip toggle — expand the
    // strip first, then press Thinking for the reasoning-body probe below.
    await expect(freshcodexRoot.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    await expect(freshcodexRoot.getByText('private style reasoning starts collapsed')).toHaveCount(0)
    await freshcodexRoot.getByRole('button', { name: 'Toggle activity details' }).press('Enter')
    await expect(freshcodexRoot.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
    await freshcodexRoot.getByRole('button', { name: 'Thinking' }).press('Enter')
    await expect(freshcodexRoot.getByText('private style reasoning starts collapsed')).toBeVisible()
```

(Keep the keyboard-Enter activation — the glom-chip overlay rationale in the existing comment still applies.)

- [ ] **Step 4: Run the reworked tests**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "expansion defaults and settings"`

Expected: PASS (this describe runs 5 tests: 3 reworked + 1 new interleaved + 1 unchanged `temporary in-pane expansion never writes settings and reverts on remount` test).

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "authored prose never folds"`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor — test-only edits matching existing helper/locator idioms.

- [ ] **Step 6: Run impacted-test verification**

The changed render path affects every e2e spec that mounts a fresh-agent transcript. The full fresh-agent spec is the impacted set (it is cloud-eligible — not in `CLOUD_SKIP_SPECS`; the configured backend is local):

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (whole spec, all tests). `thinking text renders lighter than the final answer across sans, serif, and mono styles` must pass UNCHANGED (its `ensureThinkingExpanded` already expands the strip before clicking Thinking).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "test(e2e): gate Thinking disclosures behind the strip toggle on tool-bearing lines"
```

---

### Task 3: Settings copy + docs mock reflect gated thinking rows

**Files:**
- Modify: `src/components/settings/CodingAgentsSettings.tsx:160` (Expand thinking `description`)
- Modify: `docs/index.html:1061` (mirror of the same description in the static mock)

**Interfaces:**
- Consumes: Task 1's behavior (thinking rows on tool-bearing lines are visible only when the strip is expanded).
- Produces: user-facing copy that no longer claims thinking rows are "always present". No test pins exist for this copy (verified by grep: only the two files above contain it).

- [ ] **Step 1: Write the failing behavioral test**

No automated test asserts this copy (it is prose inside a `SettingsRow` description prop; per repo rules, tests must run real behavior — a string-echo test would not qualify). The verifiable contract is the copy itself matching Task 1's behavior; the fresh-agent settings flow is already covered end-to-end by the `expansion defaults and settings` e2e describe from Task 2. Proceed directly to the copy change, then run the adjacent settings tests to prove no regression.

- [ ] **Step 2: (verification of the gap, not a test run)**

Run: `grep -rn "always present in fresh-agent" src/ test/ docs/index.html`

Expected: exactly 3 matches — `CodingAgentsSettings.tsx:160` (thinking copy), `CodingAgentsSettings.tsx:172` (Expand tools copy — NOT changed by this task), `docs/index.html:1061`. After Step 3, only the two Expand-tools copies remain with "always present".

- [ ] **Step 3: Update the copy**

In `src/components/settings/CodingAgentsSettings.tsx:160`, replace:

```
description="Thinking rows are always present in fresh-agent panes; this sets whether they start expanded. Expanding or collapsing in a pane is temporary and never saved."
```

with:

```
description="Thinking rows render under thinking-only lines and inside expanded activity lines; this sets whether they start expanded. Expanding or collapsing in a pane is temporary and never saved."
```

In `docs/index.html:1061`, replace the mock's `settings-label-desc` text for the Expand thinking row with the same new sentence.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (settings rows render; no copy-string pins).

Run: `npm run lint`

Expected: PASS (a11y lint is a CI requirement; the change is text-only).

- [ ] **Step 5: Refactor while green**

None needed — two string replacements.

- [ ] **Step 6: Run impacted-test verification**

The copy lives in the Coding Agents settings surface, mirrored in docs mock. Impacted set: the settings unit tests and the e2e settings spec:

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS.

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/settings.spec.ts --grep "Expand thinking"`

Expected: PASS (persistence-only asserts; unaffected by copy).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/settings/CodingAgentsSettings.tsx docs/index.html
git commit -m "fix(settings): refresh Expand thinking copy for gated thinking rows"
```

---

## Verification summary (whole-plan)

- **User-visible outcome:** a fresh-agent transcript line that used tools shows, while collapsed, exactly one row — `thought · N tools used` — no matter how many thinking rows it contains or how they interleave with tool uses. Proven end-to-end by the new interleaved e2e test and the reworked compact-default e2e test.
- **Boundary:** thinking-only lines keep hoisted Thinking disclosures (pinned unchanged by existing unit tests `renders a live thinking row disclosure while streaming with the strip collapsed`, `renders a thinking-only turn as an activity strip (never dropped)`, `expansion is per-mount state, never re-synced from props`, and the thinking-only tail cases).
- **Regression safety:** the full fresh-agent unit directory and the full fresh-agent e2e spec run green in Tasks 1-2; the final full-suite gate (coordinated `npm test`) runs once after the last task/review fix per the-usual Stage 4.
