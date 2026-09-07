# Fresh-Agent Slash Menu Blank-Lines Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** The fresh-agent composer slash-command menu never shows a blank line between entries — provider catalog rows with empty descriptions render as compact single-line rows.

**Architecture:** The composer's slash menu renders every row as two stacked spans (command name + description). Provider-advertised session commands legitimately arrive with `description: ''` (Claude SDK catalog coercion in `server/sdk-bridge.ts:118-129`; Rust sidecar `crates/freshell-claude-sidecar/index.mjs:177-193`; opencode `null → ''` in `server/fresh-agent/adapters/opencode/commands-catalog.ts:35`; wire schema `shared/fresh-agent-contract.ts` FreshAgentSessionCommandSchema documents `description: z.string()` as possibly empty). The fix is presentation-only: render the subtitle span only when the description is non-blank. No server, contract, or catalog changes — the data stays verbatim, commands stay in the menu.

**Tech Stack:** React 18 + TypeScript client, Vitest + Testing Library, Playwright e2e, Tailwind tokens.

## Global Constraints

- Do not drop or filter commands whose description is empty — the row must remain visible and actionable (name line only).
- Preserve the existing two-line layout for rows that DO have descriptions, the `Pane actions` / `Agent session` group dividers, and all keyboard behavior (arrow nav, Enter dispatch vs insert, Tab completion).
- Preserve the mobile touch-target floor (`min-h-[2.75rem]` below the `sm` breakpoint).
- Work happens only in `/home/dan/code/freshell/.worktrees/popup-blank-lines` on branch `the-usual/popup-blank-lines`.

## Requirements

- **R1 — Outcome:** Slash-command menu rows with an empty or whitespace-only description render as a single line (command name only); no blank line is visible between entries.
- **R2 — Constraint:** Rows with real descriptions keep the two-line layout; menu grouping, row order, keyboard interactions, and touch targets are unchanged; empty-description rows are still rendered and usable.
- **R3 — Evidence:** Unit tests red-before/green-after, and a Playwright e2e pin against the real browser DOM red-before/green-after.

---

### Task 1: Gate the slash-menu subtitle on a non-blank description

**Requirements served:** R1, R2, R3

**Behavior:**
- In `src/components/fresh-agent/FreshAgentComposer.tsx`, the subtitle `<span className="text-xs text-muted-foreground">{...description}</span>` renders only when the row's description contains non-whitespace text.
- Applies to both row renderers: `renderActionMenuItem` (currently ~line 603-618, all statics have real descriptions today — gate is defensive and keeps one presentational rule) and `renderSessionMenuItem` (~line 620-638, where provider `''` descriptions occur).
- A shared module-scope predicate, e.g. `const hasMenuSubtitle = (text: string | undefined): boolean => (text ?? '').trim().length > 0`, used by both renderers.
- Description text is NOT trimmed when displayed — the gate checks blankness only; non-blank descriptions render verbatim.

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Test (unit): `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`
- Test (e2e): `test/e2e-browser/specs/fresh-agent.spec.ts` (extend `stubFreshclaudeThread` with an optional `commands` parameter, additive/backward-compatible)

**Interfaces:**
- Consumes: existing `FreshAgentSlashCommand` / `FreshAgentSessionMenuRow` types from `@shared/fresh-agent-slash-commands` (both have `description: string`); existing `stubFreshclaudeThread(page, sessionId, turns?)` e2e helper.
- Produces: `hasMenuSubtitle` predicate (module-private in FreshAgentComposer.tsx); `stubFreshclaudeThread(page, sessionId, turns?, commands?)` — when `commands` is provided it is included verbatim as the stubbed snapshot's `commands` field.

**Test cases:**
- Unit — session row with `description: ''` → row contains exactly one span (the name line); no blank subtitle element.
- Unit — session row with `description: '   '` (whitespace-only) → exactly one span.
- Unit — session row with a real description → two spans (name + subtitle), description text visible (existing behavior preserved).
- Unit — action rows still render their static subtitles (R2 regression guard).
- e2e — freshclaude pane whose stubbed snapshot catalog includes `{ name: 'goal', description: '' }` and `{ name: 'review', description: 'Review the current diff' }`: opening the slash menu (type `/` in the composer) shows both rows; the `/goal` row has exactly one `span` child and is shorter than the two-line `/review` row. Pre-fix this is red (the `/goal` row has a second, empty span).

- [ ] **Step 1: Write the failing behavioral test**

Add a new test inside `describe('grouped slash menu (provider session commands)')` in `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`, modelled on the existing block at line ~241: render `<FreshAgentComposer commands={{ action: COMMANDS, session: [goal-row-empty-description, status-row-whitespace-description, review-row-real-description] }} onCommand={vi.fn()} />`, `fireEvent.change(getInput(), { target: { value: '/' } })`, then in menu `Slash commands` assert `within(menu).getByRole('menuitem', { name: '/goal' }).querySelectorAll('span')` has length 1, same for the whitespace row, and the described `/review` row has exactly 2 spans and shows its description text.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`

Expected: FAIL because the empty-description row currently renders 2 spans (the second being the empty subtitle) — the gate does not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentComposer.tsx`: add module-scope `hasMenuSubtitle` predicate; wrap the description `<span>` in both `renderActionMenuItem` and `renderSessionMenuItem` with `{hasMenuSubtitle(command.description) ? (<span className="text-xs text-muted-foreground">{command.description}</span>) : null}`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`

Expected: PASS (whole file — new test plus all pre-existing composer behavior).

- [ ] **Step 5: Refactor while green**

Verify both renderers use the single shared predicate; no unrelated edits; confirm no conditional class on the row depends on the subtitle's presence (row layout is `flex-col justify-center` — single-line rows remain vertically centered and keep the mobile `min-h-[2.75rem]` floor).

- [ ] **Step 6: Run broader verification**

6a. Extend `stubFreshclaudeThread(page, sessionId, turns?, commands?)` in `test/e2e-browser/specs/fresh-agent.spec.ts` and add the e2e pin described in Test cases (assert span counts + relative row heights in the real browser).

Run: `bash scripts/e2e-cloud.sh run --local --project=chromium --grep='slash menu' test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (this grep also re-runs any pre-existing slash-menu e2e if its title matches; else only the new pin).

6b. Typecheck + build: `npm run build` (covers `typecheck:client`).

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentComposer.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "fix(fresh-agent): slash menu omits blank subtitle line for undescribed provider commands"
```

---

## Self-review record

- **Spec coverage:** R1/R3 proven by unit red/green (Step 1-4) and browser red/green (Step 6a); R2 guarded by the described-row + action-row test cases and the untouched grouping/keyboard code.
- **No silent deferrals:** none — no stubs or seams; the e2e runs against the production-built client.
- **File/interface consistency:** file paths, helper signature, and test locations verified against the base tree (composer renderers at ~603-638; grouped-menu describe block at ~241; `stubFreshclaudeThread` at fresh-agent.spec.ts:221).
- **Executable tests:** unit red predicated on the currently-unconditional span; e2e red predicated on the same DOM fact in a real browser.
- **Operational completeness:** no migrations/logging/docs surface; deploy is client-only (`scripts/launch-rust.sh --client-only`) after merge.
- **Cross-check (explorers):** reports/menu-surfaces-inventory.md ruled out every other popup surface (model dialog, global context menu, turn menu, action sheet, settings popover); reports/catalog-descriptions.md confirmed empty descriptions occur on both servers and the live Rust binary behaves identically at HEAD.
