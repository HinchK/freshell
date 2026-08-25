# Fresh-agent Status Strip Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the approved fresh-agent pane redesign (approved flat-HTML preview v3; local file /tmp/opencode/fresh-agent-status-strip-preview.html) in the Freshell codebase:

1. New "session status strip" between the transcript and the composer in every fresh-agent pane (desktop and mobile):
   - Left: a model chip showing the effective active model's display name, with no indication of where the model choice is sourced from; clicking it opens the existing model selector dialog; its hover tooltip carries the raw model id + effort (e.g. "opus[1m] · effort high").
   - Right: a context meter showing the % of the model's context window currently used, live from session snapshots, with an exact-token tooltip ("96,000 / 200,000 tokens (47% full) — compacts at 100%"). Fill is muted below 70%, amber at 70–89%, red (fill and numeral) at ≥90%. When no data exists yet (no snapshot / provider never reports) the strip shows a muted "context —" with no meter — never a fake 0%.
   - The strip owns the bottom-chrome divider (the composer no longer draws its own border-top).
   - Collapse behavior: below 520px pane width the word "context" drops and the meter shrinks to 64px; below ~280px the meter hides and only the numeral remains, with the chip truncating on ellipsis.
   - Pane-header meta keeps directory + branch but no longer duplicates the context %.
2. Pane header: remove the session-type text label (e.g. "freshclaude"); the header opens with the repo icon (tooltip names the repo) and the coding-agent icon (tooltip names the agent/pane type). Desktop tabs keep their repo icons; the mobile tab strip gets no icons.
3. Turn-header timecodes: local time h:mm AM/PM with no seconds (never UTC); the timecode font follows the pane's selected style (sans in the default style, mono in the mono style) — not hard-coded monospace.
4. Legibility type scale for the new/changed UI: nothing below 13px on the phone, nothing below 12px in the desktop pane, hierarchy transcript body > pane/tab headers > strip/turn meta.

### Explicit constraints
- Work in the dedicated worktree .worktrees/fresh-agent-status-strip on branch the-usual/fresh-agent-status-strip; never commit to main; do not open a PR without explicit user approval.
- Red/green/refactor TDD for all production changes; failing-test-first evidence per task; unit and e2e coverage per repo norms.
- Match the approved preview for layout, wording, and behavior; when in doubt the preview wins.
- Do not restart the production self-hosted server (port 3001); no production deploys.
- Keep the repo's accessibility requirements (semantic buttons, aria-labels) and update docs/index.html for this significant UI change.

### Accepted tradeoffs and residuals
- Severity thresholds fixed at 70% (amber) / 90% (red) as approved.
- Unknown context state renders muted "context —" with no meter (deliberate, not a placeholder).
- Effort and raw model id are tooltip-only by design (chip shows only the effective model display name).

**Goal:** Every fresh-agent pane shows a slim status strip (effective model + context-window %) between its transcript and composer, pane headers carry repo + agent icons instead of the session-type label, and turn timecodes read "h:mm AM/PM" in local time.

**Architecture:** One new presentational component (`FreshAgentStatusStrip`) fed by the session-indexer tokenUsage (`compactPercent` — the same data that already powers the pane-header meta %). **Superseded during the Stage 5 review loop (see the addendum):** the read model never surfaced `tokenUsage` to the client at all, so the final architecture carries usage through the session-directory feed on both servers, with fresh pane usage maintained out-of-band via `includeKeys` — this plan's "no server or protocol changes" line no longer holds. The chip's click target is `FreshAgentModelDialog`, which today self-gates off for claude session types (freshclaude/kilroy), so the dialog gains a claude static+probed arm and `/model` un-gates for claude — the chip then opens the same selector on every provider. `FreshAgentView` wires model display (registry helpers + a find-by-id static-table lookup — never a default substitution) and context usage (new pure helper over the sessions/projects slice) and renders the strip between the transcript and composer. Meter coverage by provider: freshclaude / kilroy / freshcodex (indexer emits `compactPercent` + `compactThresholdTokens`); freshopencode always renders the approved muted `context —` (no opencode token usage exists upstream — deliberate, not a bug). `PaneHeader` un-gates its existing repo/agent icon JSX for fresh-agent panes and drops the identity text. The timecode formatter drops seconds; type floors land via container queries in `src/index.css`.

**Tech Stack:** React 18, Redux Toolkit, Tailwind + bespoke fresh-agent CSS (container queries on `.fresh-agent-pane`), Vitest + Testing Library, Playwright (cloud lane).

## Global Constraints

- Workspace: worktree `/home/dan/code/freshell/.worktrees/fresh-agent-status-strip`, branch `the-usual/fresh-agent-status-strip`, base `0910d8b05801636fe7480cfb0b8a8513cc0c7cdc` (green gate receipt: base-gate re-run 2026-08-24). Never commit to main; never push without instruction; no PR creation.
- The worktree has **no node_modules** — run `npm ci` in the worktree before any test command (Task 1, step 0).
- Test backends: `FRESHELL_E2E_BACKEND=cloud` routes e2e to Cloud Run. NOTE: `FRESHELL_VITEST_BACKEND=cloud` does NOT reroute `test:vitest` — focused vitest runs ALWAYS spawn locally (validator-verified). Focused unit/file runs from the worktree: `npm run test:vitest -- run <files…>` — NO `--config` flag; the coordinator auto-injects `config/vitest/vitest.config.ts` for client targets / `config/vitest/vitest.server.config.ts` for server ones. Never mix client+server files in one invocation (mixed silently runs only the client side). E2e cloud lane (multi-spec supported): `npm run test:e2e:cloud -- test/e2e-browser/specs/<a>.spec.ts test/e2e-browser/specs/<b>.spec.ts` (≤3 specs → default shards=1). The e2e a11y gate keeps a baseline at `test/e2e-browser/a11y-gate-baseline.json`; Task 4 must refresh it with `npm run test:e2e:a11y-gate -- --write-baseline` and commit the shrunken file (deny mode fails on stale-only signatures).
- Server uses NodeNext/ESM — relative imports include `.js` extensions (client `@/` alias imports do not).
- Commit identity is the repo default; never write `dan@danshapiro.com` into git config.
- Never restart the production server (port 3001). No production deploys.
- Repo a11y rules: semantic buttons, aria-labels on icon-only controls; the e2e a11y gate forbids CSS-class-only locators in specs (use role+name).
- The meter data source is the session-indexer `tokenUsage` (see Task 1); the fresh-agent snapshot `tokenUsage` never carries `compactPercent` today — reading it would be a silent "always unknown" bug. **Superseded:** the Stage 5 user directive DID add a server channel (do not treat "do not add server workarounds" as current — the addendum governs).

---

### Task 1: FreshAgentContextUsage helper + FreshAgentStatusStrip component (presentational) + unit tests

**Files:**
- Create: `src/lib/fresh-agent-context-usage.ts`
- Create: `src/components/fresh-agent/FreshAgentStatusStrip.tsx`
- Create: `test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx`
- Create: `test/unit/client/lib/fresh-agent-context-usage.test.ts`
- Modify: `src/index.css` (add `.fresh-agent-status-strip` block + severity + container queries)
- Modify: `src/components/panes/PaneContainer.tsx` (move `findIndexedSessionById` to the new lib and import it back — no behavior change)

**Interfaces:**
- Consumes: `ProjectGroup[]` / `CodingCliSession` from `@/store/types` (sessions slice shape), `FreshAgentPaneContent` from `@/store/paneTypes`, `FreshAgentSessionState` from `@/store/freshAgentTypes`.
- Produces:
  - `resolveFreshAgentContextUsage(content: FreshAgentPaneContent, session: FreshAgentSessionState | undefined, projects: ProjectGroup[]): { percent: number; contextTokens: number; thresholdTokens: number } | null` — durable session id chain: `getPreferredResumeSessionId(session) ?? content.resumeSessionId ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined)`. The sessionRef tail is fresh-eyes finding m1: sessionRef is the canonical durable identity, normalize flows strip `resumeSessionId`/`sessionId` while retaining `sessionRef` (panesSlice.ts:1890/1986/2044/2060, persistence keep-list behavior verified) — a restored pane can hold indexed data yet present sessionRef-only, and unknown must mean "genuinely unavailable". This does NOT diverge from PaneContainer's meta: the fresh-agent meta no longer carries % at all (Task 4 removes it), so no user-visible chain split exists. Then `findIndexedSessionById(projects, content.provider, sessionId)`; reads `indexed.tokenUsage.compactPercent` (+ `contextTokens` + `compactThresholdTokens` for the tooltip). The meter requires ALL THREE: a finite percent AND finite contextTokens AND finite compactThresholdTokens — a partial record returns null (round-3 minor: partial records never render a meter with a token-less tooltip; claude/codex indexers emit all four fields together, so this is cheap consistency — unknown means "not genuinely usable").
  - `findIndexedSessionById(projects, provider, sessionId)` (moved from PaneContainer, exported).
  - `<FreshAgentStatusStrip modelLabel tooltip contextUsage onOpenModelDialog modelLabelShort? />` — `contextUsage` is the helper result or `null`. `modelLabelShort` optional; when absent, the long label is used everywhere.

- [ ] **Step 0: Workspace setup** — `cd /home/dan/code/freshell/.worktrees/fresh-agent-status-strip && npm ci`. Expected: completes; `node_modules` present.

- [ ] **Step 1: Write the failing behavioral tests**

`test/unit/client/lib/fresh-agent-context-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveFreshAgentContextUsage } from '@/lib/fresh-agent-context-usage'
// fixture: projects: [{ repoRoot?, projectPath, sessions: [{ provider: 'claude', sessionId: 'abc', cwd, projectPath, tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, contextTokens: 96000, compactPercent: 47, compactThresholdTokens: 200000 } }] }]
// content fixtures: FreshAgentPaneContent minimal ({ kind: 'fresh-agent', provider: 'claude', sessionType: 'freshclaude', createRequestId: 'req', status: 'connected', sessionId: 'abc', ... } — cast via helper if the full type is heavy; mirror PaneContainer.test.tsx's makeSession/makeContent patterns)

describe('resolveFreshAgentContextUsage', () => {
  it('resolves percent + tokens from the indexed session via content.resumeSessionId', () => {
    const usage = resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, projects)
    expect(usage).toEqual({ percent: 47, contextTokens: 96000, thresholdTokens: 200000 })
  })
  it('returns null for a pane with only a live (non-durable) sessionId and no resume link', () => {
    expect(resolveFreshAgentContextUsage(content({ sessionId: 'abc' }), undefined, projects)).toBeNull()
  })
  it('resolves via the sessionRef tail when resumeSessionId was stripped (restored pane)', () => {
    const usage = resolveFreshAgentContextUsage(content({ sessionRef: { provider: 'claude', sessionId: 'abc' }, resumeSessionId: undefined }), undefined, projects)
    expect(usage?.percent).toBe(47)
  })
  it('ignores a sessionRef whose provider does not match the pane', () => {
    expect(resolveFreshAgentContextUsage(content({ sessionRef: { provider: 'codex', sessionId: 'abc' }, resumeSessionId: undefined }), undefined, projects)).toBeNull()
  })
  it('prefers getPreferredResumeSessionId(session) over content.resumeSessionId (canonical chain, matches PaneContainer)', () => {
    // session fixture: { historySessionId: 'abc', ... } so the preferred id is 'abc';
    // content has resumeSessionId: 'zzz' which is NOT indexed → still resolves 'abc'.
    const usage = resolveFreshAgentContextUsage(content({ resumeSessionId: 'zzz' }), sessionWithHistoryId('abc'), projects)
    expect(usage?.percent).toBe(47)
  })
  it('returns null when the id chain points at nothing indexed', () => {
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'nope' }), undefined, projects)).toBeNull()
  })
  it('returns null when the indexed session has no compactPercent', () => {
    const noPct = projectsWith((base) => ({ ...base.tokenUsage!, compactPercent: undefined }))
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, noPct)).toBeNull()
  })
  it('returns null on partial records (missing contextTokens or compactThresholdTokens) — the meter/tooltip pair never degrades to "x% full" without exact tokens', () => {
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, projectsWith((b) => ({ ...b.tokenUsage!, contextTokens: undefined })))).toBeNull()
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, projectsWith((b) => ({ ...b.tokenUsage!, compactThresholdTokens: undefined })))).toBeNull()
  })
  it('clamps percent into 0–100 and rounds', () => {
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, projectsWith((b) => ({ ...b.tokenUsage!, compactPercent: 100.7 })))?.percent).toBe(100)
    expect(resolveFreshAgentContextUsage(content({ resumeSessionId: 'abc' }), undefined, projectsWith((b) => ({ ...b.tokenUsage!, compactPercent: -3 })))?.percent).toBe(0)
  })
})
```

`test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx` (component-level; no store needed — pure props):

```tsx
import { render, screen } from '@testing-library/react'
// ...
describe('FreshAgentStatusStrip', () => {
  it('renders the model chip with the display label and id+effort tooltip', () => {
    render(<FreshAgentStatusStrip modelLabel="Claude Opus 5 (1M context)" modelTooltip="opus[1m] · effort high" contextUsage={null} onOpenModelDialog={() => {}} />)
    const chip = screen.getByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' })
    expect(chip).toHaveAttribute('title', 'opus[1m] · effort high')
  })
  it('clicking the chip opens the model dialog', async () => { /* fireEvent.click → spy called */ })
  it('renders the context meter at 47% with exact-token tooltip', () => {
    render(<FreshAgentStatusStrip modelLabel="Claude Opus 5 (1M context)" modelTooltip="t" contextUsage={{ percent: 47, contextTokens: 96000, thresholdTokens: 200000 }} onOpenModelDialog={() => {}} />)
    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuenow', '47')
    expect(screen.getByTitle('96,000 / 200,000 tokens (47% full) — compacts at 100%')).toBeInTheDocument()
  })
  it('shows muted "context —" with no meter when usage is unknown (never a fake 0%)', () => {
    render(<FreshAgentStatusStrip modelLabel="Claude Opus 5 (1M context)" modelTooltip="t" contextUsage={null} onOpenModelDialog={() => {}} />)
    expect(screen.queryByRole('meter')).toBeNull()
    expect(screen.getByText('context —')).toBeInTheDocument()
  })
  it.each([
    [47, 'ok'], [69, 'ok'], [70, 'warn'], [89, 'warn'], [90, 'hot'], [91, 'hot'],
  ])('applies severity tier %s at %i% (boundaries pinned: 69/70, 89/90)', (percent, tier) => {
    const { container } = render(
      <FreshAgentStatusStrip modelLabel="Claude Opus 5 (1M context)" modelTooltip="t"
        contextUsage={{ percent, contextTokens: percent * 2000, thresholdTokens: 200000 }}
        onOpenModelDialog={() => {}} />,
    )
    expect(container.querySelector('.fresh-agent-status-strip')).toHaveAttribute('data-severity', tier)
  })
})
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-context-usage.test.ts test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx`

Expected: FAIL — module `@/lib/fresh-agent-context-usage` / `@/components/fresh-agent/FreshAgentStatusStrip` do not exist.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/fresh-agent-context-usage.ts`:

```ts
import type { CodingCliSession, ProjectGroup } from '@/store/types'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import type { CodingCliProviderName } from '@shared/...' // match existing imports in PaneContainer

export type FreshAgentContextUsage = { percent: number; contextTokens: number; thresholdTokens: number }

export function findIndexedSessionById(projects: ProjectGroup[], provider: CodingCliProviderName, sessionId: string): CodingCliSession | undefined {
  for (const project of projects) {
    const match = project.sessions.find((s) => s.provider === provider && s.sessionId === sessionId)
    if (match) return match
  }
  return undefined
}

/** Durable session id chain: preferred resume id → resumeSessionId → sessionRef tail
 * (sessionRef is the canonical durable identity; restored panes may present sessionRef-only). */
function durableSessionId(content: FreshAgentPaneContent, session: FreshAgentSessionState | undefined): string | undefined {
  return getPreferredResumeSessionId(session)
    ?? content.resumeSessionId
    ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined)
}

export function resolveFreshAgentContextUsage(content, session, projects): FreshAgentContextUsage | null {
  const sessionId = durableSessionId(content, session)
  if (!sessionId) return null
  const indexed = findIndexedSessionById(projects, content.provider, sessionId)
  const usage = indexed?.tokenUsage
  const raw = usage?.compactPercent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const percent = Math.max(0, Math.min(100, Math.round(raw)))
  const ct = usage.contextTokens
  const tt = (usage as { compactThresholdTokens?: number }).compactThresholdTokens
  if (typeof ct !== 'number' || !Number.isFinite(ct)) return null
  if (typeof tt !== 'number' || !Number.isFinite(tt)) return null
  return { percent, contextTokens: Math.round(ct), thresholdTokens: Math.round(tt) }
}
```

(Verify the exact `TokenSummary` field names against `shared/ws-protocol.ts` TokenSummarySchema — the tooltip needs threshold tokens; the existing `formatPaneRuntimeTooltip` already reads `compactThresholdTokens`.)

`src/components/fresh-agent/FreshAgentStatusStrip.tsx`:

```tsx
import { ChevronDown } from 'lucide-react'
import type { FreshAgentContextUsage } from '@/lib/fresh-agent-context-usage'

const tokenNumber = new Intl.NumberFormat('en-US')

export type FreshAgentStatusStripProps = {
  modelLabel: string
  /** Short label shown ≤520px pane width (e.g. "Claude Opus 5"); absent = long label everywhere. */
  modelLabelShort?: string
  modelTooltip: string
  contextUsage: FreshAgentContextUsage | null
  onOpenModelDialog: () => void
}

// Usage is always a complete record (the helper nulls partial records), so the
// tooltip is always the exact-token form from the approved preview.
function formatTooltip(u: FreshAgentContextUsage): string {
  return `${tokenNumber.format(u.contextTokens)} / ${tokenNumber.format(u.thresholdTokens)} tokens (${u.percent}% full) — compacts at 100%`
}

export function FreshAgentStatusStrip({ modelLabel, modelLabelShort, modelTooltip, contextUsage, onOpenModelDialog }: FreshAgentStatusStripProps) {
  const short = modelLabelShort ?? modelLabel
  const severity = contextUsage === null ? 'unknown'
    : contextUsage.percent >= 90 ? 'hot'
    : contextUsage.percent >= 70 ? 'warn'
    : 'ok'
  return (
    <div className="fresh-agent-status-strip" data-severity={severity}>
      <button
        type="button"
        className="fresh-agent-status-chip"
        title={modelTooltip}
        aria-label={`Model: ${modelLabel} — change model`}
        onClick={onOpenModelDialog}
      >
        <span className="fresh-agent-status-chip-label fresh-agent-status-chip-label-long">{modelLabel}</span>
        <span className="fresh-agent-status-chip-label fresh-agent-status-chip-label-short">{short}</span>
        <ChevronDown className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
      {contextUsage ? (
        <span
          className="fresh-agent-status-context"
          role="meter"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={contextUsage.percent}
          title={formatTooltip(contextUsage)}
        >
          <span className="fresh-agent-status-context-label">context</span>
          <span className="fresh-agent-status-meter" aria-hidden="true"><i style={{ width: `${contextUsage.percent}%` }} /></span>
          <span className="fresh-agent-status-pct">{contextUsage.percent}%</span>
        </span>
      ) : (
        <span className="fresh-agent-status-context fresh-agent-status-context-unknown" title="No token data reported yet">context —</span>
      )}
    </div>
  )
}

export default FreshAgentStatusStrip
```

`src/index.css` — append after the composer block (~line 1290), before the panel-mobile container block; honor the existing conventions:

```css
/* ---------- fresh-agent session status strip ---------- */
.fresh-agent-status-strip {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  height: 26px; padding: 0 8px;
  border-top: 1px solid hsl(var(--border) / 0.6);
  font-family: var(--fresh-agent-meta-font-family);
  font-size: 12px; color: var(--fresh-agent-muted-text);
}
.fresh-agent-status-chip {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0;
  background: transparent; border: 0; padding: 3px 6px; border-radius: 4px;
  font: inherit; font-weight: 500; color: inherit; cursor: pointer; white-space: nowrap; line-height: 1.3;
}
.fresh-agent-status-chip:hover { background: var(--fresh-agent-subtle-surface); }
.fresh-agent-status-chip-label { overflow: hidden; text-overflow: ellipsis; }
.fresh-agent-status-chip-label-short { display: none; }
.fresh-agent-status-context { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.fresh-agent-status-meter { width: 96px; height: 4px; border-radius: 999px; background: var(--muted); overflow: hidden; display: block; }
.fresh-agent-status-meter > i { display: block; height: 100%; border-radius: 999px; background: var(--fresh-agent-muted-text); }
.fresh-agent-status-pct { font-variant-numeric: tabular-nums; }
.fresh-agent-status-strip[data-severity="warn"] .fresh-agent-status-meter > i { background: hsl(var(--warning)); }
.fresh-agent-status-strip[data-severity="warn"] .fresh-agent-status-pct { color: hsl(var(--warning)); }
.fresh-agent-status-strip[data-severity="hot"] .fresh-agent-status-meter > i { background: hsl(var(--destructive)); }
.fresh-agent-status-strip[data-severity="hot"] .fresh-agent-status-pct { color: hsl(var(--destructive)); }
.fresh-agent-status-context-unknown { color: var(--fresh-agent-muted-text); }

@container (max-width: 520px) {
  .fresh-agent-status-strip { height: 32px; font-size: 13px; }
  .fresh-agent-status-chip { padding: 8px; }
  .fresh-agent-status-chip-label-long { display: none; }
  .fresh-agent-status-chip-label-short { display: inline; }
  .fresh-agent-status-context-label { display: none; }
  .fresh-agent-status-meter { width: 64px; height: 5px; }
}
@container (max-width: 280px) {
  .fresh-agent-status-meter { display: none; }
}
```

(Refactor pass only: serif/mono overrides for the strip's border color live in Task 3 with the divider move.)

`src/components/panes/PaneContainer.tsx`: delete local `findIndexedSessionById` (lines 130–142) and import the moved function from `@/lib/fresh-agent-context-usage`.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-context-usage.test.ts test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx`

Expected: PASS (PaneContainer suite proves the function move is behavior-preserving).

- [ ] **Step 5: Refactor while green**

Tidy imports; confirm the shared helper is the single home for the session-id precedence chain (PaneContainer keeps its own call sites — dedupe only where it's a pure swap).

- [ ] **Step 6: Run impacted-test verification**

Impacted: anything importing PaneContainer's pane-meta path → the whole `test/unit/client/components/panes/` dir.

Run: `npm run test:vitest -- run test/unit/client/components/panes`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/fresh-agent-context-usage.ts src/components/fresh-agent/FreshAgentStatusStrip.tsx test/unit/client/lib/fresh-agent-context-usage.test.ts test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx src/index.css src/components/panes/PaneContainer.tsx
git commit -m "feat(fresh-agent): add session status strip component (model chip + context meter)"
```

---

### Task 2: FreshAgentModelDialog gains claude/kilroy support (chip + /model work on every provider)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentModelDialog.tsx`
- Modify: `src/lib/fresh-agent-model-capabilities.ts`
- Modify: `shared/fresh-agent-slash-commands.ts` (un-gate `/model` for freshclaude/kilroy, ~lines 47–52)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx`
- Modify: `test/unit/shared/fresh-agent-slash-commands.test.ts` (currently asserts claude/kilroy do NOT list /model — flip to assert /model present for all four session types)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (chip click → dialog content visible — lands with Task 3's wiring; assert via this task's dialog behavior plus Task 3's strip render)

**Interfaces:**
- Consumes: `FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshclaude` (static rows exist: `opus[1m]` = "Claude Opus 5 (1M context)"), `getFreshAgentModelCapabilities` (the server endpoint + 5-min server cache already serve claude — the settings popover already probes it), the popover's `modelEffortLevels` stamping idiom in `FreshAgentSettingsButton`.
- Produces: `<FreshAgentModelDialog>` renders (and commits) for all four session types.

Why this task exists (load-bearing L1, validator-confirmed): the dialog gates itself off for freshclaude/kilroy (`mruProviderForSession` only maps opencode/codex; `if (!open || !mruProvider) return null`); the strip chip's click would otherwise be a silent no-op on claude panes. Minimal extension per validator recommendation (a):
1. Extend the dialog's probe effect to claude session types (same call the settings popover makes; 5-min server cache keeps it cheap).
2. Add a claude arm to `getFreshAgentStaticModelCapabilities` (fresh-agent-model-capabilities.ts) that returns the freshclaude static rows, and merge the probed catalog static-wins (the popover already merges aliases for claude — mirror that behavior rather than inventing).
3. Make MRU (most-recently-used) highlighting conditional where it needs a runtime-provider mapping; the self-gate becomes `if (!open) return null`.
4. Dialog commit path must stamp `modelEffortLevels` the same way the settings popover commit does, so effort normalization matches between surfaces.
5. `/model` becomes listed for claude session types (shared/fresh-agent-slash-commands.ts gate removal) — the View's existing `command.action === 'model'` handler now opens a dialog that renders.

- [ ] **Step 1: Write the failing behavioral tests** — FreshAgentModelDialog.test.tsx: (a) open dialog on a freshclaude pane renders model rows (contains "Claude Opus 5 (1M context)"); today renders null → FAIL. (b) commit on claude stores selection and stamps `modelEffortLevels` equal to the settings-popover semantics (fixture: probed catalog containing model-level effort levels). (c) test/unit/shared/fresh-agent-slash-commands.test.ts: flip the existing assertion so `/model` is listed for freshclaude/kilroy too (the /model production change gets its red evidence here).
- [ ] **Step 2:** Run `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx test/unit/shared/fresh-agent-slash-commands.test.ts` → FAIL (dialog renders null for claude; shared test still expects claude to lack /model).
- [ ] **Step 3:** Implement 1–5 above.
- [ ] **Step 4:** Run `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/shared/fresh-agent-slash-commands.test.ts` → PASS (popover regressions netted).
- [ ] **Step 5: Refactor while green** — shared merge logic between popover and dialog belongs in one place; extract only if both callers literally share it, otherwise note the parallel and move on.
- [ ] **Step 6:** Impacted = model-dialog + settings-button + slash-command surfaces: `npm run test:vitest -- run test/unit/client/components/fresh-agent` → PASS.
- [ ] **Step 7:**

```bash
git add src/components/fresh-agent/FreshAgentModelDialog.tsx src/lib/fresh-agent-model-capabilities.ts shared/fresh-agent-slash-commands.ts test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx test/unit/shared/fresh-agent-slash-commands.test.ts
git commit -m "feat(fresh-agent): model dialog serves claude/kilroy (chip + /model work everywhere)"
```

---

### Task 3: Wire the strip into FreshAgentView + move the bottom divider from composer to strip

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx` (root form class list: drop `border-t border-border/60`)
- Modify: `src/index.css` (serif `.fresh-agent-style-serif .fresh-agent-status-strip` + mono `.fresh-agent-style-mono .fresh-agent-status-strip` border/padding overrides migrate from the composer overrides; serif `.fresh-agent-style-serif .fresh-agent-composer` and mono `.fresh-agent-style-mono .fresh-agent-composer` lose their border-top declarations)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (seed indexed sessions into the store; assert strip renders model label + meter with %, unknown state otherwise; assert chip click opens the dialog)

**Interfaces:**
- Consumes: `resolveFreshAgentContextUsage` + `FreshAgentStatusStrip` (Task 1); `FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE` from `@shared/fresh-agent-models` (find-by-id label resolution per L8 — never `resolveFreshAgentModelOption`, which substitutes the default); `resolveEffectiveFreshAgentModel` / `getEffectiveFreshAgentEffort` (already imported in the View).
- Produces: none new; the View renders `<FreshAgentStatusStrip ... />` between transcript and composer.

Key wiring rules:
- Active-model precedence (fresh-eyes finding — the chip must reflect the LIVE session, not only staged config): `stripModelId = agentSession?.model ?? resolveEffectiveFreshAgentModel(paneContent, providerDefaults)`. `agentSession` is already selected by the View; `FreshAgentSessionState.model` carries the runtime-reported model. No live catalog probe (deliberate cost control): label resolution maps an id through the static table by exact match only — `stripModelLabel = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[paneContent.sessionType]?.find((o) => o.value === stripModelId)?.label ?? stripModelId ?? descriptor?.label ?? 'Fresh Agent'` (load-bearing L8 — never substitute the default option's label; freshopencode with a catalog-only id shows its raw id — the accepted residual).
- Short label for ≤520px (fresh-eyes finding — approved preview switches wording): `stripModelLabelShort = stripModelLabel.replace(/\s*\([^)]*\)\s*$/, '') || stripModelLabel` (drops a trailing "(1M context)"-style parenthetical when the long label came from the static table; raw ids have no parenthetical and pass through).
- Freshopencode display-name upgrade (fresh-eyes M2 — the freshopencode static table is EMPTY since #676 "live catalog only", so without this the chip would permanently show raw ids, contradicting "chip shows the display name; raw ids tooltip-only". The shared ~/.config/opencode catalog carries `displayName`): when `paneContent.sessionType === 'freshopencode'` AND `stripModelId` is set AND no static option matches, the probe effect runs `getFreshAgentModelCapabilities('freshopencode', { cwd: paneContent.initialCwd })` — a small `useEffect` with deps `[paneContent.sessionType, paneContent.initialCwd, stripModelId]` (fresh-eyes round 3: re-probes when the active model changes — the "once per mount" reading would leave a stale label after a mid-pane model change); cancellation guard identical to FreshAgentView's snapshot effects (cancelled flag). Server side has 5-min TTL cache + in-flight dedupe; this is the same endpoint the settings popover calls. UI shows the raw id immediately — never blank, never "Loading" — and upgrades label/short-label to the catalog `displayName` when it resolves.
  - JUDGED dispatch on the round-3 Major (raw-id exposure), recorded for the delta review: when the catalog request fails, or when a running probe has not yet resolved, no display name exists anywhere in the system for that model — the only states that satisfy "always shows the active model" are (a) show the raw id, or (b) hide the model entirely. The approved design's own "unknown = fallback rendering" principle applies: the raw id IS the active model's most faithful label in that state (a hidden chip is strictly less informative and contradicts "shows the active model"). So the residual stands deliberately: catalog-down ⇒ raw id on chip + tooltip. The once-stale-after-model-change violation (same Major) is fixed unconditionally via the effect dep on `stripModelId`.
  - Known data-availability limitation (round-3 Major, recorded honestly): `resolveFreshAgentContextUsage` reads `state.sessions.projects`, which is the sidebar's active session window (search/pagination replaces it, and the indexer enriches only the most recent sessions — so a pane whose sidebar row falls out of the window shows "context —" despite the session having indexed usage). This is construction-equivalent to how the current pane-header meta % already behaves (same lookup), the approved unknown-state covers the rendering, and the correct long-term repair is a server-side per-session usage endpoint (requires Rust + Node parity — out of scope for this change; carried as a recap follow-up).
- `stripModelTooltip = \`${stripModelId ?? 'model not set'} · effort ${getEffectiveFreshAgentEffort(paneContent, providerDefaults) ?? 'Default'}\``. Compute these OUTSIDE the giant render `useMemo` (dep discipline), and add the computed values (plus `contextUsage`) to the memo's dep array. The opencode probe effect is a separate small effect + useState; label/short-label/tooltip are derived from the probe state so the memo deps only gain the probe's displayName state.
- `contextUsage = resolveFreshAgentContextUsage(paneContent, agentSession, projects)` where `projects` comes from `useAppSelector((s) => s.sessions.projects)` (mirror the EMPTY_PROJECTS pattern in PaneContainer) — outside the memo; memo deps gain `contextUsage`.
- The strip renders unconditionally in every fresh-agent pane (even unknown state). Chip click: `setModelDialogOpen(true)` — with Task 2 landed, the dialog now renders for all providers.
- Test harness note (load-bearing L6): FreshAgentView.test.tsx's `createStore` (lines 60–105) registers no `sessions` reducer — register `sessionsReducer` and seed indexed sessions via `applySessionsPatch` with `projects[].sessions[].tokenUsage` where `sessionId === paneContent.resumeSessionId` (provider matches), mirroring PaneContainer.test.tsx (:317 registration, :355–360 preload, :2303–2345 tokenUsage seed).
- Composer `className` becomes `fresh-agent-composer relative p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:pb-3` (border-t dropped).
- CSS: serif block gets `.fresh-agent-style-serif .fresh-agent-status-strip { border-top-color: var(--fresh-agent-border); padding: 0 1.4rem; }` matching the composer's old border color; remove `border-top-color` from serif composer override (keep background/padding); mono block moves `border-top: 1px solid var(--fresh-agent-border)` from `.fresh-agent-style-mono .fresh-agent-composer` onto `.fresh-agent-style-mono .fresh-agent-status-strip` (with `padding: 0 1rem`).

- [ ] **Step 1: Write the failing behavioral tests** — extend `FreshAgentView.test.tsx` with: (a) strip renders with chip label "Claude Opus 5 (1M context)" for a freshclaude pane with no model override; (a2) a pane whose effective model id matches NO static option shows the raw id, never the default option's label; (a3) a session carrying `model: '<live-id>'` overrides the staged pane config on the chip (fresh-eyes finding: live session wins); (b) seeded indexed session (per harness note) → meter present with aria-valuenow 47; (c) no indexed session → `screen.getByText('context —')`, no meter; (d) chip click → model dialog opens AND shows claude rows (depends on Task 2).
- [ ] **Step 2:** Run the assertions; FAIL because the render path has no strip. Include: (a4) freshopencode pane with a catalog-only model — hoisted `getFreshAgentModelCapabilities` spy (pattern from FreshAgentSettingsButton.test.tsx:34–80) resolves `{ ok: true, models: [{ id: 'opencode-go/glm-5.2', displayName: 'GLM 5.2' }] }` → chip pre-probe shows the raw id, post-probe shows "GLM 5.2"; catalog failure keeps the raw id.
- [ ] **Step 3:** Implement the wiring + composer border removal + CSS migration as specified above.
- [ ] **Step 4:** `npm run test:vitest -- run test/unit/client/components/fresh-agent` → PASS (whole fresh-agent component dir: catches composer-theme suites).
- [ ] **Step 5: Refactor while green** — keep computed strip props grouped above the memo; no other reshaping.
- [ ] **Step 6:** Impacted set = `test/unit/client/components/fresh-agent/` + `test/unit/client/components/panes/` + `test/unit/client/components/tabs/`? No — tabs untouched. Run the two dirs; Expected: PASS.
- [ ] **Step 7:**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentComposer.tsx src/index.css test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(fresh-agent): wire status strip into pane; strip owns bottom divider"
```

---

### Task 4: Pane header — repo + agent icons, identity label removed, meta % dropped for fresh-agent panes

**Files:**
- Modify: `src/components/panes/PaneHeader.tsx`
- Modify: `src/components/panes/PaneContainer.tsx` (`resolveFreshAgentRuntimeMeta`: stop passing `tokenUsage` in BOTH the indexed and session.snapshot branches for fresh-agent panes)
 - Modify: `src/index.css` (delete `.pane-header-fresh-agent-identity` block lines 31–36; in the 180px container block lines 65–68 remove the identity selector AND set `.pane-header-fresh-agent-detail` to `font-size: 13px` — fresh-eyes floor math: 0.68rem ≈ 10.9px violates every floor; 12px (0.75rem) there still violates the 13px phone floor at phone-split widths and would sit equal to the strip, inverting the required header-above-metadata hierarchy; keep the title-gap rules)
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx` (identity suite rewrite; icon presence tests)
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx` (fresh-agent %-meta assertions → no %)
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts` (selector fixes listed in Step 6 — production-visible change; fold into this task so e2e stays green with it)
- Modify: `test/e2e-browser/specs/restore-matrix.spec.ts` (busy-blue locator retarget)

**Interfaces:**
- Consumes: `RepoIcon` (`src/components/icons/RepoIcon.tsx`), `PaneIcon` (`src/components/icons/PaneIcon.tsx`), existing `repoIconInfo`/`busy` props already computed in PaneHeader.
- Produces: none (internal). Terminal/non-fresh-agent panes byte-identical; the codex/claude header parity test (PaneHeader.test.tsx:479–508) stays untouched and MUST pass.

Agent label source: `resolveFreshAgentType(content.sessionType)?.label ?? content.sessionType` (new import from `@/lib/fresh-agent-registry` in PaneHeader).

Repo-icon availability (fresh-eyes verified finding M3): today the only population of `repoIcons.byCwd` is TabBar's probe effect (TabBar.tsx:266–279), and TabBar is NOT mounted on initial mobile-landscape terminal view (`{(!isLandscapeTerminalView || landscapeTabBarRevealed) && (<TabBar … />)}`, App.tsx:1713–1715); the probe also skips entirely when `repoIconsOnTabs` is false. Therefore PaneHeader owns its icon data: add a small effect in PaneHeader — `useEffect(() => { if (repoCwd && !repoIconsByCwd[repoCwd]) void dispatch(fetchRepoIconMeta(repoCwd)) }, [repoCwd, repoIconsByCwd, dispatch])` (imports mirror TabBar's usage; fetchRepoIconMeta from the repoIcons slice). The pane-header repo icon IGNORES the `repoIconsOnTabs` setting (that setting governs tabs; the header icon is part of this design regardless) and shows the RepoIcon letter-avatar fallback when the probe errors or no repo meta exists; when `repoCwd` is undefined (pane has no cwd) no repo icon renders. Terminal-pane tab icons and the TabBar probe remain untouched.

Header layout (fresh-agent): `[repo icon][agent icon][title?][meta?][actions…]`. Icon tooltips match the approved preview exactly: repo icon wrapper `title={\`Repo: ${repoName}\`}` when a repo is known (never the generic "Repository"; no icon at all when no repoCwd) and agent icon wrapper `title={\`${agentLabel} (${content.sessionType} pane)\`}` e.g. "Claude (freshclaude pane)" (fresh-eyes: tooltip wording is part of the approved design). Wrap each icon in `<span title={...}>` (PaneIcon/RepoIcon ship no own tooltips). Remove the `pane-header-fresh-agent-identity` span and its `title={`${content.sessionType} session`}`. Busy-blue: the agent icon takes over the `busy && status === 'running' ? 'text-blue-500' : 'text-muted-foreground'` treatment the identity span had. Removal of `!isFreshAgentPane &&` gates on repo icon + PaneIcon JSX (adapting className sizes: `h-3.5 w-3.5` desktop, with the repo icon wrapper for fresh-agent).

- [ ] **Step 1: Write the failing tests** — PaneHeader.test.tsx: fresh-agent pane shows repo icon + agent icon (query by the wrapper spans' title attributes) and NO `freshclaude`/`freshcodex` text anywhere in the header; busy/running fresh-agent pane's agent icon carries text-blue-500; with `repoIcons.byCwd` empty and `repoIconsOnTabs` FALSE the header still dispatches `fetchRepoIconMeta` for its repoCwd and still renders the RepoIcon fallback (fresh-eyes M3). PaneContainer.test.tsx: fresh-agent meta label = "freshell (main)" (no "· 47%"-style suffix) even with compactPercent present; terminal-mode pane meta still shows the % (parity guard).
- [ ] **Step 2:** Run both; FAIL (identity text still rendered; % still in meta).
- [ ] **Step 3:** Implement PaneHeader/PaneContainer/index.css changes above.
- [ ] **Step 4:** `npm run test:vitest -- run test/unit/client/components/panes` → PASS.
- [ ] **Step 5: Refactor** — the now-dead freshAgentTitleMatchesMeta/isFreshAgentDefaultTitle heuristics only existed to keep title and identity/meta from duplicating; re-read PaneHeader's fresh-agent branch after the identity removal and delete any heuristic that no longer has a consumer (keep behavior identical for the title/meta display: title shows custom titles, meta shows dir+branch — never both-empty).
- [ ] **Step 6: e2e locator repair (failing-test-first evidence is the existing specs failing against the new header)** — `fresh-agent.spec.ts`: replace `getByText('freshcodex', { exact: true })` style lookups (lines ~197, ~963) and the `openFreshAgentSettings` helper (~46–50) that finds panes via lowercased sessionType text — retarget to the pane header's agent-icon wrapper title (e.g. `page.getByTitle('Codex (freshcodex pane)')`) or the pane container's `data-session-type` attribute. `restore-matrix.spec.ts` (~1263–1273): the busy-blue assertion targets `.pane-header-fresh-agent-identity`; retarget to the agent icon wrapper. Confirm both specs are NOT in CLOUD_SKIP_SPECS (test/e2e-browser/playwright.cloud.config.ts) — fresh-agent.spec.ts is not skipped per the exploration report; verify restore-matrix.spec.ts similarly. Run: `npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/restore-matrix.spec.ts` → PASS.
- [ ] **Step 6b: a11y-gate baseline refresh (load-bearing L11)** — the removed `.pane-header-fresh-agent-identity` locator is baselined (`locator:css-class:2bbd6ce4`) and deny mode fails on stale-only signatures. Run `npm run test:e2e:a11y-gate -- --write-baseline` and include the shrunken `test/e2e-browser/a11y-gate-baseline.json` in the commit.
- [ ] **Step 7:**

```bash
git add src/components/panes/PaneHeader.tsx src/components/panes/PaneContainer.tsx src/index.css test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/restore-matrix.spec.ts test/e2e-browser/a11y-gate-baseline.json
git commit -m "feat(fresh-agent): pane header shows repo + agent icons, drops session-type label and meta %"
```

---

### Task 5: Turn-header timecodes — local h:mm AM/PM, no seconds; legibility floor for turn-header type

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`formatTurnTimecode`, lines 41–46; turn-header class)
- Modify: `src/index.css` (turn-header font-size floors; serif 0.58rem and mono 0.62rem overrides; a ≤520px container-query bump to 13px)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (timecode expectation, ~line 298–316)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (timecode expectation, ~line 484)

**Interfaces:** Consumes/Produces: none (internal format change).

- [ ] **Step 1: Write the failing tests** — for a fixed timestamp (e.g. `2026-08-23T17:41:18Z`), assert the rendered timecode equals `new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })` AND matches `/^\d{1,2}:\d{2}\s?(AM|PM)$/i` (no seconds, meridiem; `hour12: true` pins the meridiem in 24-hour-default locales — fresh-eyes M4). Update the two existing assertions (they currently compute `toLocaleTimeString()` bare — they must fail first against the seconds-producing code).
- [ ] **Step 2:** Run; FAIL (seconds still shown).
- [ ] **Step 3:** `formatTurnTimecode` → `return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })`. NO raw-passthrough fallback (round-3 minor): an invalid/malformed timestamp now returns `null` (no timecode rendered) — a raw provider timestamp could expose seconds or a UTC `Z`, contradicting the absolute no-seconds/never-UTC rule. Add a test: `formatTurnTimecode('not-a-date')` → the transcript renders no `<time>` for that turn. Do NOT add a font-family — the time element inherits `--fresh-agent-meta-font-family` via `.fresh-agent-turn-header` (already style-following; no mono hard-coding). Type floor (load-bearing L7 — validator-verified cascade): change the JSX class `text-[11px]` → `text-xs` (FreshAgentTranscript.tsx:543); serif override `font-size: 0.58rem` → `0.75rem` (index.css:361, keep its `letter-spacing: 0.12em`), mono override `0.62rem` → `0.75rem` (:882, keep `text-transform: none`). The `@container (max-width: 520px)` block must appear AFTER the serif/mono turn-header rules in file order — placement is load-bearing: unresolved ties resolve by source order (serif/mono rules are 0-2-0; the container block's compound selectors match, and later-in-file wins), while against the Tailwind utility (`text-xs`) resolution is by cascade layer (custom rules are unlayered → win). No `!important`, no `span:first-child` rules (validator: no size lives on header spans — finder's L7 span rule was a false alarm on question-option/sidebar selectors). Snippet:

```css
@container (max-width: 520px) {
  .fresh-agent-turn-header,
  .fresh-agent-style-serif .fresh-agent-turn-header,
  .fresh-agent-style-mono .fresh-agent-turn-header { font-size: 13px; }
}
```

(Caveat recorded: 0.75rem = 12px at the default root; at 125% UI scale it renders 15px — still ≥ floor.)

- [ ] **Step 4:** `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` → PASS.
- [ ] **Step 5: Refactor** — none expected; the style-override notes are deliberate.
- [ ] **Step 6:** Impacted = the whole fresh-agent client dir (timecodes render in view tests): `npm run test:vitest -- run test/unit/client/components/fresh-agent` → PASS.
- [ ] **Step 7:**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx src/index.css test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(fresh-agent): timecodes as local h:mm AM/PM; turn-header legibility floor"
```

---
### Task 6: E2e coverage — strip presence, chip, unknown state, mobile collapse

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts`
- Modify: `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`

**Interfaces:** existing spec helpers (`openFreshAgentSettings` repaired in Task 4, `data-context="fresh-agent"` pane roots, route-seeded snapshots where the pattern exists).

- [ ] **Step 1: Write the failing e2e assertions** — the browser test harness exposes Redux `dispatch` and `sessionsSlice` exposes `setProjects` (fresh-eyes M5 verified in-repo: test/e2e-browser/helpers/test-harness.ts), so e2e CAN seed indexed token usage; the implementer confirms the exact dispatch path against the harness when writing (if `setProjects` is not the real action name, use the slice's actual projects-setter — the unit harness pattern in PaneContainer.test.tsx is the shape reference).
  - `fresh-agent.spec.ts` (desktop):
    1. "shows the session status strip (unknown state)": freshclaude pane, no seeded session → chip visible, `page.getByText('context —')` visible (full-string match — an exact 'context' lookup never matches the combined unknown row), no `role="meter"`.
    2. "shows a seeded context meter": seed the indexed session (dispatch setProjects with the pane's resumeSessionId + tokenUsage { compactPercent: 47, contextTokens: 96000, compactThresholdTokens: 200000 }) → `getByRole('meter', { name: 'Context window used' })` visible, `aria-valuenow` 47, exact-token tooltip title attribute contains '96,000 / 200,000 tokens (47% full)'.
    3. Chip click → the model dialog opens (now meaningful for claude after Task 2).
    4. "narrow pane ≤280px hides the meter track, keeps the numeral" — reuse the existing narrow-pane setup in fresh-agent.spec.ts (the ~320px/50%-split suite that already produces a sub-280px fresh-agent pane; fresh-eyes M3): seed indexed usage at 62% and assert the `role="meter"` cluster is still visible AND the numeral text "62%" is visible AND the cluster's boundingBox is narrower than the 64px-meter mobile form factor (the track itself is display:none via the container query — the cluster keeps role/value so assistive tech retains the reading). If the existing narrow-pane setup turns out to produce a pane ≥280px, shrink the split sizes or viewport in that test only; verify actual pane width at runtime and record it in the test run log.
  - `fresh-agent-mobile.spec.ts` (390px viewport ⇒ pane <520px): with a seeded 47% session: chip shows the SHORT label ("Claude Opus 5" — the ≤520px hidden-long/shown-short spans), the standalone `context` label is NOT rendered (query `getByText('context', { exact: true })` → count 0 — the combined 'context —' unknown string is excluded by seeding). Meter-collapse proof WITHOUT a fixed-pixel assertion (round-3 M4: the role-bearing cluster contains the track + gap + numeral, so boundingBox of the cluster is ≈100px, not 64): measure the meter cluster's boundingBox width in BOTH fresh-agent.spec.ts (desktop) and mobile and assert mobileClusterWidth < desktopClusterWidth × 0.75 — proves the ≤520px collapse removed the label and shrank the track, and cannot pass against the uncollapsed layout. The composer buttons sit in the 4-up grid (existing assertion style).
  - Typography coverage (round-3 M3 — string-only unit tests cannot protect the computed-style requirements; add to fresh-agent.spec.ts): locate the user-turn header by role/text (`getByText('You')`), then `evaluate((el) => getComputedStyle(el))` per style and floor:
    1. default style, wide pane: turn-header fontSize ≥ 12px; mobile spec: ≥ 13px;
    2. hierarchy: transcript copy fontSize > pane-header title fontSize > turn-header fontSize ≥ strip fontSize ≥ 12px (desktop) — compute all four in one evaluate round-trip;
    3. font follows style: in the default style the turn-header fontFamily contains no mono; switch the pane to the mono style via the existing settings mechanism (or a harness-set paneContent.style) and assert the computed fontFamily now contains a mono face (e.g. matches /Mono|mono/ and differs from the default). h:mm AM/PM + no seconds is already unit-asserted; do not re-assert the string here.
- [ ] **Step 2 (red evidence):** Author the specs, temporarily comment out the `<FreshAgentStatusStrip … />` render in FreshAgentView.tsx (working tree only, never committed), run the two specs and confirm the new assertions FAIL, then restore the render.
- [ ] **Step 3:** (no production change beyond the locator repairs from Task 4 if not already landed).
- [ ] **Step 4:** `npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts` → PASS on the cloud lane (both specs are excluded from CLOUD_SKIP_SPECS — verify in test/e2e-browser/playwright.cloud.config.ts before running).
- [ ] **Step 5: Refactor** — share any repeated assertions in one spec-local helper only if duplication appears.
- [ ] **Step 6:** Impacted e2e = the three fresh-agent specs touched overall: run `npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/restore-matrix.spec.ts` → PASS.
- [ ] **Step 7:**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts
git commit -m "test(fresh-agent): e2e coverage for status strip (desktop + mobile collapse)"
```

---

### Task 7: docs/index.html mock update + lint/typecheck + full verification

**Files:**
- Modify: `docs/index.html`

**Interfaces:** none.

- [ ] **Step 1** — Update the mock's fresh-agent panel (`panel-start` ~lines 831–856): header gains repo + agent icon glyphs where the session-type label was (the mock's current header text per the region), add a status strip before the composer mirroring the approved preview (model chip + meter at ~47%, "context" word + tooltip semantics as title), timecodes (if rendered there) → "h:mm AM/PM". CSS region ~430–466: move the composer's border-top onto the new strip class and add the strip rules (scaled to the mock's own token names — the mock has its own local class names; do not import app CSS).
- [ ] **Step 2:** Open the file headless (e.g. render check) or eyeball the diff; verify no markup errors.
- [ ] **Step 3:** `npm run lint` and `npm run typecheck` (client + server) → clean.
- [ ] **Step 4:** Full coordinated suite from the worktree: `FRESHELL_TEST_SUMMARY="the-usual/fresh-agent-status-strip final gate" npm test` → PASS (the one known flake from the baseline ledger — ws-terminal-idle 1ms race — if it fires, replay that single file and record the receipt).
- [ ] **Step 5:**

```bash
git add docs/index.html
git commit -m "docs: refresh index.html mock for fresh-agent status strip"
```

---

## Risk/rollback notes

- Rollback = revert the branch commits in reverse order.
- **Superseded:** "All changes are client-side plus test/docs" and "No protocol, server, or Rust changes" were true at writing but not at landing — the final delta spans Node + Rust servers, the shared wire schema, and the client (see the addendum).
- pre-existing flake ledger: `test/server/ws-terminal-idle.test.ts` grace-window 1ms race (baseline evidence in run logs); never "fix" as part of this run — only replay and record if it fires.

## Addendum (Stage 5 review loop, 2026-08-24 evening)

User directives resolving the meter/chip review tension:

1. **Model chip never renders a raw model id.** The chip exists only once a model display name resolves (static table → pick-time `modelLabel` stamp → catalog probe). Raw ids stay tooltip-only. Legacy/restored/REST/MCP panes show no chip until a label resolves (the gear popover and `/model` remain reachable). A pane with NO model at all gets no chip (the pane-type label is not a model display name).
2. **Context meter stays live regardless of the sidebar window.** The session-directory data feed now carries `tokenUsage` on every item (it was dropped by the read model), and every sidebar window/search fetch passes `includeKeys` = the set of fresh-agent panes' durable `provider:sessionId` keys. The server returns matching sessions out-of-band as `contextUsageExtras` — never merged into `items`, so sidebar rendering is untouched. `tokenUsage` is included in the session-directory change-detection projection, so usage ticks alone broadcast `sessions.changed`, triggering the refetch that moves the meter. Implemented with parity in BOTH servers (Node `server/session-directory/*`; Rust `crates/freshell-server/src/session_directory.rs` + `freshell-sessions` parse/index). The client reads ONE map (`sessions.contextUsageByKey`): thunk-side stamping records usage ONLY from each response's fresh rows (+ server extras) — merged/retained window rows are never re-marked fresh; the map is bounded to the current `includeKeys` set (pane-closed entries are pruned on each commit); upserts are ordered by the response's session-directory `revision` so a slow stale response can never regress a newer entry; entries are NEVER expired client-side (refreshes are event-driven, so an idle session's last reading is still the server's newest value — blanking it after a minute only hid accurate data).
   - Parity deviation recorded: Rust synthesized live-terminal-only rows report no tokenUsage (Rust `TerminalIdentity` carries none); fresh-agent sessions are indexed from transcripts, so their usage flows via the persisted path.
   - `includeKeys` is capped at the 200-pane ceiling on both servers and client (a workspace past that would otherwise make every sidebar fetch unparseable). Rust's over-cap 400 issue is zod-flavored but not byte-matched to zod's wording (client self-enforces ≤200).
