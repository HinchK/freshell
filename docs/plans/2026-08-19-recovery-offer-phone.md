# Fix scrollable RecoveryOfferPanel on small screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the-usual-executing-plans to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Before first dispatch, the dispatching agent seeds the progress ledger at
> `<worktree-git-dir>/usual-sdd/progress.md`, then announces exactly:
> `I'm using the-usual-executing-plans to implement this plan.`

**Goal:** Make the `RecoveryOfferPanel` (RESTORE-03 modal under
`src/App.tsx:961-973`) usable on phone-sized viewports — it currently crops the
decline button off-screen with `document.body.style.overflow='hidden'` making
the backdrop unscrollable. Mark the tests for R2 (scenario stability / no
regression to RESTORE-01..04 assertions) and R3 (every user interaction) in
their names or comments.

**Scope decision (user, 2026-08-20):** _"Let's just fix the popup and make no
other changes."_ The over-offer gate investigated in earlier revisions is OUT
of scope: no server changes, no gating. The incident's annoyance was the
unusable (screen-filling, unscrollable) dialog; once contained and scrollable,
"Not now" (decline) is one tap away on any device.

**Architecture:** One presentation-only change to the dialog (viewport cap +
internal scroll region + buttons outside the scroll region), pinned by a
structural unit test and validated at real browser level by a new e2e scenario
(390x844 viewport, 40 records, decline actionability). No API/protocol/WS
changes; the fetch stays unconditional.

**Verification gate (closes incident loop, validated in the load-bearing
stage):** the phone incident shape is reproduced in e2e with a viewport-limited
context and a 20-record inventory; "all controls reachable and clickable on a
390x844 viewport" is checkable by Playwright actionability; the verification
step asserts containment (dialog bounding box within the viewport) and
internal scrolling (`scrollHeight > clientHeight`), not pixel-perfect visual
equivalence.

**Tech Stack:** React 18 + Tailwind (dialog containment; `overflow-y-auto`,
`max-h-[80vh]` per DeadSessionPanel precedent), TS (testids unchanged), Rust
axum server (`GET /api/recovery/inventory` — no changes), Playwright e2e under
`test/e2e-browser/` (rust-chromium project, serial single worker,
`FRESHELL_E2E_BACKEND` unset ⇒ local runs only; never cloud without asking).

## Core deliverables

1. Bounded, internally-scrollable `RecoveryOfferPanel` dialog
   (Deliverable/Verification: the dialog never exceeds the viewport on
   phone-sized screens; the records list scrolls internally; all controls
   reachable and clickable on a 390x844 viewport).
2. Mobile-viewport e2e pinning that containment plus the phone user story
   (Deliverable/Verification: e2e scenario with 40 records asserting bounding
   box, internal scroll, and decline actionability on 390x844).
3. Guarded e2e sequencing (Deliverable/Verification: teardown-lag guards at
   every close→required-offer transition so scenarios never coerce on stale
   connected-state — the guard is generic `waitForRecoverable` polling, no new
   test seam).

## Context map

RESTORE-01 (offer query at boot) flows: the panel self-fetches via
`getRecoveryInventory` (`src/lib/api.ts`) → Rust `inventory_handler`
(`crates/freshell-server/src/recovery_inventory.rs:384-420`); the panel is
rendered by App at `App.tsx:1926`. RESTORE-03/04: panel + suggestion/apply
flow (App.tsx). Dismissal semantics (RESTORE-06): closing via Escape/backdrop
keeps the offer pending for a later boot rather than starting a timer. Full
evidence: `.worktrees/.the-usual-logs/recovery-offer-phone/reports/plan-rust-inventory.md`, `plan-client-panel.md`, `plan-test-coverage.md`.

Load-bearing evidence (validated this run, receipt at
`.worktrees/.the-usual-logs/recovery-offer-phone/load-bearing-receipt.md`):

- **LB-1 (was proven, revised, re-proven):** the e2e offer flow works
  cross-context: a declarer context pushes `tabs.sync.push` (storage/broadcast
  seeds skipped under `serviceWorkers:'block'`), its server-persisted
  generations persist tolerance-free, and after TOTAL client disconnect a
  FRESH-context boot reliably shows the panel (~3s). Shutdown/flush staleness
  risk: NONE for persisted generations (broad-followers md1-3 falsified;
  `waitForRecoverable` probe-poll after populating-context close absorbs the
  layout-save linger horizon).
- **LB-2:** zero sites in `hoverboard`, `recheck`, or e2e-run-mode fixtures
  change the offer assertions — adding a scenario to the recover spec
  cannot coerce RESTORE-01..04 assertions (validators reviewed every source in
  `test/e2e-browser/`).
- **LB-3:** teardown is read-loop-driven; validators re-verified the plan-text
  claim that the probe-only inventory request carries no WS socket; the
  polling helper with `x-auth-token` (a stateless GET, so it does not affect
  rate limiting on other clients) is honest — no new auth-kind or
  rate-limit risk per `rate_limit.rs:99-149`.

## Files to Map

- Create: NONE (all edits are to existing files; helpers stay file-local in the
  spec).
- Modify: `src/components/RecoveryOfferPanel.tsx` — dialog container gets
  `max-h-[80vh] flex flex-col`; the "Live now elsewhere" `<ul>` becomes the
  sole scroll region with `overflow-y-auto flex-1 min-h-0`; header + paragraph
  + button row remain fixed neighbors with `shrink-0`; testids
  `recovery-offer-panel`, `recovery-decline`, `recovery-accept`,
  `recovery-live-note` unchanged.
- Modify: `test/unit/client/components/RecoveryOfferPanel.test.tsx` — one new
  structural test: the dialog (selected via `getByTestId('recovery-offer-panel')`)
  has the classes `max-h-[80vh]` and `flex flex-col`; the `<ul>` descendant of
  the dialog has `overflow-y-auto`, `flex-1`, and `min-h-0`; AND neither
  `recovery-decline` nor `recovery-accept` is a descendant of that `<ul>`
  (assert via `ul.contains(declineButton)` / `ul.contains(acceptButton)` ===
  false — the footer lives in the dialog's flex column but outside the scroll
  region).
- Modify: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` — new serial
  scenario 4 plus a teardown-lag guard (`waitForRecoverable`) at every
  close→required-offer transition without restart (after scenario 1's
  ctxB.close(), scenario 2's ctxC.close(), scenario 3's ctxD.close(), and
  scenario 4's populating-context close; context-E's close is deliberately
  unguarded because scenario 4's populating boot branches on the boot
  inventory response payload, never on visibility timing — see scenario 4).
- Modify: NONE on the server. The untouched `data-testid` attrs keep the
  pinned contract (R2 pins).

## Architecture decisions

- **Presentation-only containment.** This is the idiomatic React/Tailwind fix
  (one-fallback before/after: the dialog is bespoke and has no Dialog-primitive
  in this codebase; mirroring DeadSessionPanel's `max-h-[80vh] flex flex-col` +
  `overflow-y-auto flex-1 min-h-0` list exactly is the measured, minimal,
  single-risk-axis change; the footer-with-buttons stays OUTSIDE the scroll
  region so controls never scroll away from a mobile user).
- **No new test seam, no new in-scope key.** The e2e guards poll the public
  API; no new in-scope helper id or auth knob is introduced; the spec keeps
  `serviceWorkers:'block'` and no other spec changes land (R2 gate evidence).
- **No new subsystem — the dialog's containment is the entire change.** No
  interceptor/state machine; the boot harness and fetch behavior stay
  byte-identical.

## Requirements Spec

- **R1 (formerly R3 — containment).** On a phone-sized viewport the dialog fits
  the viewport, its list scrolls internally, and every control (`Not now`,
  `Restore`, focus trap, Escape dismiss, backdrop-click dismiss) remains
  reachable and functional.
- **R2 (regression gate + no-seam).** `RESTORE-01..05` assertions + both
  recovery-offer-entangled specs (`recover-my-panes-rust`, `sidebar-registry-sync-rust` +
  `sidebar-remote-status-rings-rust`) keep passing against ONE fixed run-mode
  shape; no new in-scope keys/testids/WS/API seams. Test-hygiene guard as an
  e2e observer rule: scenario 1's existing final guard (nobody-connected ⇒ no
  offer) must be preserved/kept true at every later transition — otherwise the
  next scenario's required-offer assertion is compromised by teardown lag.
  Mechanically the plan adds an enforced probe-poll guard
  (`waitForRecoverable` helper polling
  `GET /api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0`
  until `recoverable === true` with
  `x-auth-token` via a STANDALONE `request.newContext({ baseURL:
  info.baseUrl, extraHTTPHeaders: { 'x-auth-token': info.token } })` — note
  `TestServerInfo` exposes `baseUrl` (lowercase), while Playwright's option
  key is `baseURL`; `request` is imported from `@playwright/test`. NOT
  `page.request` on a doomed page/context (handle is invalidated by `close()`),
  NOT a navigated page (that would create a tracked tabs.sync client and
  entangle the bootstrap fetch) — disposed after success) wherever a later
  step REQUIRES the offer to appear after a close — in this spec that is
  after scenario 1's context-B close (before scenario 2's offer-requiring
  boot), after scenario 2's context-C close (before scenario 3's context-D
  boot), after scenario 3's context-D close (before scenario 3's own
  context-E boot), and after scenario 4's populating-context close (before
  scenario 4's phone-viewport boot). Scenario 3's context-E close is
  deliberately NOT guarded: scenario 4's populating context uses a conditional
  decline (below) precisely so it is robust whether or not an offer is
  pending.
- **R3 (interactions completeness).** Every panel interaction (restore/decline
  buttons, focus trap, Escape dismiss, backdrop-click dismiss) keeps working on
  the phone viewport, preserving today's semantics (dismissal keeps the offer
  pending for a later boot). Satisfied by the e2e decline actionability plus
  the unchanged unit tests; no changed interaction semantics.

## Invariant risk table for pinning

| # | Requirement | Invariant | Pinning tests |
|---|-------------|-----------|---------------|
| R1 | R1 (containment) | Dialog `max-h` + internal scroll + reachable buttons | Component structural test + e2e scenario 4 (390x844 bounding box + `scrollHeight > clientHeight` + decline actionability) |
| R2a | R2 (restart-independence) | A probe/guard poll exists at every close→required-offer transition without restart | Recover spec scenario transitions 1→2, 2→3, within-3 (D→E), and populating→phone all guarded (context-E close deliberately unguarded — scenario 4's populating boot branches on the inventory response payload with a 30s render-latency-matching panel wait, so no visibility race); attacker text filed below |
| R2b | R2 (unmodified spec coherence) | `RESTORE-01..04` assertions unchanged & passing on `recover-my-panes-rust.spec.ts` and the sidebar pair | The four specs keep running in the same serial order with unchanged assertions |
| R3 | R3 (interactions) | Not now/Restore/Escape/backdrop/focus keep working on the phone viewport | e2e scenario 4 decline actionability + unchanged unit interaction suite (all existing tests + new structural test) |

## Design (execution checklist after this plan)

_No server changes land; the gate investigation in earlier plan revisions is
rescoped by user decision._

- Modify: `src/components/RecoveryOfferPanel.tsx` — dialog container
  (~`RecoveryOfferPanel.tsx:191`) gets `max-h-[80vh] flex flex-col`; the
  records `<ul>` (~:220) gains `overflow-y-auto flex-1 min-h-0` (DeadSessionPanel
  `:55`/`:62` idiom); header + paragraph + buttons keep `shrink-0` outside the
  scroll region; testids and interaction handlers stay untouched (R3 pins).

## Interfaces

### Client UI

The existing markup is preserved exactly; only the two annotated class tokens
are added (`+` marks the change):

```jsx
<div data-testid="recovery-offer-panel" role="dialog" aria-modal="true"
     aria-labelledby={HEADING_ID}
     className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-5
                + max-h-[80vh] flex flex-col">
  <h2 id={HEADING_ID} className="text-lg font-semibold">Restore {paneCount} ...</h2>
  {device && <p className="mt-1 text-xs text-muted-foreground">{device.deviceLabel}</p>}
  <ul className="mt-3 text-sm text-muted-foreground list-disc pl-5 space-y-1
                 + overflow-y-auto flex-1 min-h-0">
    {/* pane list items (per-tab panes, then ledger-only entries) */}
  </ul>
  {anyLive && <p data-testid="recovery-live-note" className="mt-3 text-xs text-muted-foreground">...</p>}
  <div className="mt-4 flex justify-end gap-2">
    <Button data-testid="recovery-decline" variant="ghost" size="sm">Not now</Button>
    <Button data-testid="recovery-accept" variant="default" size="sm" ref={acceptRef}>Restore</Button>
  </div>
</div>
```

(The wrapper portal/overlay, focus-trap `onKeyDown` on the dialog, scroll-lock
effect, every existing class token, and both buttons' labels (`Not now` /
`Restore`) stay byte-identical. The overlay already centers the dialog;
`max-h-[80vh]` caps it at 80% of the viewport; the `<ul>` becomes the sole
internal scroll region; the button row remains a sibling below the list, so
both buttons are always within the dialog's bounded box.)

### Server WS handlers + routes

**Unchanged.** `GET /api/recovery/inventory` response shape stays as-is;
`tabs.sync.push` handler untouched; no rate-limit/auth changes.

## E2E story tests (canonical user stories + request-explicit coverage)

Sole canonical story stems straight from the incident: open Freshell on a
phone with a large recorded layout ⇒ you can DISMISS the modal without
scrolling tricks. Auth is owned by helpers; this plan's tests focus on the
phone-boot story. Story test naming: `scenario 4: small-viewport boots offer
the full dialog and the decline control is tappable`. **One serial e2e spec
(`recover-my-panes-rust`) contains the new scenario; scenarios 1–3 are
untouched and their close→required-offer transitions get the common
`waitForRecoverable` guard.** The suite:

- **Scenario 4 (R1 + R3 pins):** `test.setTimeout(240_000)` — the repo
  Playwright default is 60s and every existing scenario raises it to 120s or
  240s; this scenario's own budget (decline ≤30s + 40-tab creation + ≤30s
  persistence poll + ≤30s guard + phone-boot assertions) can exceed 60s.
  A populating context boots. Offer rendering is asynchronous — the existing
  recovery helper documents observed delays exceeding 10s and therefore waits
  30s for the panel — so a fixed short visibility timeout races a delayed
  modal. Instead the populating page attaches a response listener for the boot
  `GET /api/recovery/inventory` request BEFORE navigation
  (`page.waitForResponse(r => r.url().includes('/api/recovery/inventory'))`),
  then branches on the parsed payload: if `recoverable === true` (canonical
  full serial run — scenarios 1–3 left persisted records), wait up to 30s for
  `recovery-offer-panel` and click `recovery-decline` (the modal would
  otherwise intercept the header clicks needed next; the full-latency wait
  closes the race); if `recoverable === false` (isolated `-g "scenario 4"`
  runs against a fresh server/home), skip declining and proceed — the
  mutation-red lane relies on this determinism, and it is also why
  context-E's close needs no guard: the branch is driven by the response
  payload, never by visibility timing. Then it creates 40 shell tabs using
  the UI control `getByRole('button', { name: 'New shell tab' })` (idiom donor:
  `automation-layout-rust.spec.ts:143`; tab-count progress observable via
  `harness.getTabCount()`), then waits for persistence with a records-count
  fs-poll (newest generation for that context's client has ≥ 40 records —
  read the JSON gen files like `waitForSnapshotContaining` does).
  (Execution-discovered, reviewer-verified deviation: the original 20 records
  is non-discriminating at 390x844 — ~21 records render ≈500px of list content
  while the capped dialog leaves a ≈525px list budget, so
  `scrollHeight === clientHeight` in BOTH the un-fixed and fixed states and
  the assertion cannot distinguish them. 40 records (~950px) reproduces the
  overflow cleanly: mutation run failed containment with dialog top at
  y = −141, exactly (844−1126)/2.) Close the
  context, run the `waitForRecoverable` guard, then boot a fresh context with
  `browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })`:
  panel visible; dialog bounding box fits within 390x844; the `<ul>` has
  `scrollHeight > clientHeight` (internal scrolling exists — with a footer
  outside it, the buttons' bounding boxes lie inside the viewport); clicking
  `recovery-decline` succeeds (Playwright actionability = real reachability,
  this is the user-level phone proof).

### Attacker texts filed by Completion Critic (load-bearing, DO NOT SKIP ANY)

- Probe-poll guarantee for the four close→required-offer transitions
  (after ctxB.close(), ctxC.close(), ctxD.close(), and scenario 4's
  populating-context close): 30s budget (poll 500ms) per transition —
  totals ≤2min worst case; validated: 10x+ headroom versus the lived behavior
  (a few ms after teardown-completing closes). New-server (`info.token`)
  provisioning reuses `startRustServer` token; kept in `recover-offer.ts`
  helpers.

## Tasks (executed strictly in order by the-usual-subagent-driven-development)

### Task 1: Client — made the RecoveryOfferPanel scrollable and reachable

**Requirements served:** R1, R3

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/client/components/RecoveryOfferPanel.test.tsx` (the file
already mocks the recovery-inventory API):

- Renders panel with N records ⇒ the `recovery-offer-panel` dialog has Tailwind
  classes `max-h-[80vh]` and `flex flex-col`; a `<ul>` descendant of the
  dialog (select via `dialog.querySelector('ul')` — no new testids) has
  `overflow-y-auto`, `min-h-0`, `flex-1`; AND the two buttons are NOT
  descendants of that `<ul>`
  (`ul.contains(getByTestId('recovery-decline')) === false`, same for
  `recovery-accept` — the buttons stay in the dialog's flex column but outside
  the scroll region).
  Test name/comment must reference **R1 (dialog containment)**.
- Existing tests in the file keep passing (scroll-lock, focus trap, backdrop,
  Escape, accept/decline flows — do not cite a count; counts drift).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx`

Expected: FAIL — the new structural test fails against the current
`RecoveryOfferPanel` (no `max-h-[80vh]`, no `overflow-y-auto` on the `<ul>`,
buttons remain reachable — they sit in the dialog but outside the scroll
region — exactly the same user-level red the phone hit).

- [ ] **Step 3: Add the minimal production implementation**

`src/components/RecoveryOfferPanel.tsx`:
- Add `max-h-[80vh] flex flex-col` to the dialog container (the
  `p-5 shadow-xl` div).
- Make the records `<ul>` the scroll region by adding `overflow-y-auto
  flex-1 min-h-0`.
- Leave header/paragraph/buttons in the non-scrolling flex column (no
  `shrink-0` required-with-flex—DeadSessionPanel has none on its footer).
- Do not alter the body scroll-lock blocks (`RecoveryOfferPanel.tsx:111-126`).

(no worker notes on shared scroll behavior — `main` and `index.css` stay
untouched.)

- [ ] **Step 4: Re-run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx`
Expected: PASS (existing tests + the new structural test).

- [ ] **Step 5: Refactor while green**

Keep class lists grouped by section; a small comment on the `<ul>` noting it
is the only scroll region (the R1 intent).

- [ ] **Step 6: Run broader verification**

1. `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx` — PASS
2. `npm run test:vitest -- run test/unit/client` — PASS (coordinated wrapper,
   default vitest config)

- [ ] **Step 7: Commit the task**

```bash
git add src/components/RecoveryOfferPanel.tsx test/unit/client/components/RecoveryOfferPanel.test.tsx
git commit -m "fix(ui): bound recovery offer dialog to viewport with internal scroll"
```

### Task 2: Pin a phone-sized viewport e2e to containment, add the boot-sequence guards

**Requirements served:** R1, R2, R3

- [ ] **Step 1: Write the failing behavioral test**

Write scenario 4 as specified, plus the file-local `waitForRecoverable` probe
helper and the records-count poll. This task runs AFTER Task 1 (production
behavior already landed), so the red evidence is produced by mutation, below —
not by running against absent behavior.

- [ ] **Step 2: Run the test and verify the intended failure (mutation red)**

Run scenario 4 against mutated production to prove it detects the missing
behavior (restore immediately after; the mutation is never committed).
Scenario 4's response-payload-driven populating boot means a filtered
`-g "scenario 4"` run
against the fresh isolated server/home stays on-path (no stale offer blocks
the population UI), so the failure lands exactly on the containment
assertions:
1. Containment off: temporarily remove `max-h-[80vh] flex flex-col` from the
   dialog and `overflow-y-auto flex-1 min-h-0` from the `<ul>` in
   RecoveryOfferPanel.tsx, then run
   `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g "scenario 4"`
   Expected: FAIL — inside scenario 4, the containment/scroll assertions fail
   (bounding-box overflow / `scrollHeight > clientHeight` false), NOT at the
   boot/decline phase.
   Restore the classes.
The failure must be for the missing behavior only (assertion mismatches on
bounding boxes / scroll metrics — never harness errors).

- [ ] **Step 3: Add the minimal production implementation**

None — production changes landed in Task 1. This step is limited to
restoring/confirming the un-mutated tree (`git status` clean of production
changes).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts`
Expected: PASS — all four scenarios (budget: up to 600s for the cold release
build, scenarios ~2-4 min each).

- [ ] **Step 5: Refactor while green**

Keep helpers file-local; match the file's existing comment/donor-citation
conventions.

- [ ] **Step 6: Run broader verification**

Run BOTH of these (the rings spec is not matched by `rust-chromium`'s
`testMatch` — it is registered only under the `chromium` project, whose
`e2eServerKind` fixture defaults to `legacy`; explicit CLI file filters are
applied AFTER project `testMatch` selection, so it must be invoked via its
configured project):
1. `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` — PASS
2. `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts` — PASS
(the other specs with recovery-offer entanglement).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/recover-my-panes-rust.spec.ts
git commit -m "test(e2e): pin recovery-offer phone-viewport containment and add boot-sequence guards"
```

**Task-order discipline:** Task 1 before Task 2 (e2e lands on the shipped
containment); class literals as specified.

### Task 3: Final verification of the whole delta

**Requirements served:** every row in the Invariant Risk table

- [ ] Run, in the worktree on the FINAL committed HEAD, and record receipts
  (command, commit, exit code, counts) in the execution ledger:
  1. `npm run check` (typecheck + coordinated full vitest suite) — PASS
  2. `npm run lint` (a11y gate on changed client file) — PASS
  3. `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts` — PASS (4 scenarios)
  4. `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` — receipt: recovery-entangled case-d PASS; cases a/b/c are blocked by a PRE-EXISTING codex managed-launch breakage (default flipped ON by `6a8733a3a`, 2026-07-30; the spec's `fake-codex-terminal.mjs` has no `app-server` support; confirmed pre-existing and disjoint from this delta by two independent reviews; recorded in out-of-scope-findings.md) — run it, record the exact outcome, and do NOT attempt to fix it here
  5. `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts` — PASS (registered only under the `chromium` project lane)
  6. `docs/index.html` assessment (AGENTS.md gate) — answer: not needed;
     the dialog is transparent to the mock's shape; no new copy is added.
- [ ] FreshEyes delta review (read-only, full delta): round-of-3 via
  `.worktrees/.the-usual-logs/recovery-offer-phone/workflow/scripts/fresheyes/run-review.sh`
  with `--executor-family other`, clean worktree (commit HEAD recorded),
  `--log-dir` under `recovery-offer-phone/reports/`, scope text describing the
  FULL DELTA (diff base→worktree HEAD, plan file path, original-request.md
  path, plus tier=B diminished-authority note), run from the MAIN REPO cwd.
  PASSED ⇒ skip the recap skill; on Major counting as firewall ⇒ do NOT treat
  it as an out-of-scope finding (those capture ideas/follow-ups; real bugs
  fix in place per protocol).

## Unrelated-but-needs-confirmation

- `docs/index.html` (AGENTS.md docs gate — "update `docs/index.html` when
  adding new user-facing features or significant UI changes"): Task 3 records
  an explicit assessment. This change is a presentation-correction of an
  existing modal without user-visible new features; the mock does not show the
  recovery offer panel at all, and the docs list spec-compliant client features
  unchanged — nothing user-facing is added. No new docs-page tests.

## Testing approach (repo-consistent)

- Unit/component level (Vitest + Testing Library): the
  `RecoveryOfferPanel.test.tsx` structural case uses Testing Library idioms
  (render with mocked inventory fetch, assert via `getByTestId()` attributes
  and `className`, check `ParentElement` containment); not a new test seam,
  not structural copy added by free text.
- E2E (Playwright, `rust-chromium` serial profile): scenario 4 in
  `recover-my-panes-rust.spec.ts` runs via `npm run test:e2e:local` against a
  fresh server provisioned by `startRustServer`.
- No supplementary cloud tests (per `FRESHELL_E2E_BACKEND` unset ⇒ local only).
- Full flaky history exists in `.worktrees/.the-usual-logs/recovery-offer-phone/reports/plan-test-coverage.md`
  (`task-1xdS9sGNDbWBoXB3IJszyTy` — the close-lag site flakes ONLY if the test
  author's added probe step doesn't include the guard; attacker texts above
  carry the transition guard).

(batch evidence of some taps / pin/site-side facts omitted for brevity: the
boot harness site is `App.tsx:874-895`; RESTORE-05's mock keeps current
returns; any dead-time drift at open time is out-of-scope for the plan.)

## Self-review evidence (mandatory before plan ends)

1. **Spec coverage:** each Requirements Spec row maps to ≥1 test task —
   verified: R1→Task 1 + scenario 4; R2→scenario guards + Task 3 rows 3-4;
   R3→Task 1 focus-trap/Escape/backdrop tests + scenario 4.
2. **Placeholder scan:** none — verified by rereading the finished plan end to
   end; the reviewers upstack are expected to repeat this on the dispatch
   lane.
3. **Type/consistency:** every token in Interfaces matches the surrounding
   repo state (class names, `data-testid` strings, ws kind strings, route
   paths); cross-checked versus `src/lib/api.ts`, `src/store/tabRegistrySync.ts`,
   `crates/freshell-ws/src/tabs.rs` snapshots. Also confirmed RESTORE-06's
   dismissal semantics (pending offer re-surfaces on a later boot) remain
   untouched.
4. **Cycle check:** tasks and steps topologically ordered.
5. **Assumption audit:** no standard-library euphemisms; precise React idioms
   (`getByTestId`, `BoundingBox`, `scrollHeight`); no duck-typed "framework"
   abstractions appear.
6. **Anchor specificity:** all file/line anchors present for sites; every
   donor idiom cited is shown above with its outcome; task graph lists every
   file each task touches.
7. **Scope check:** the plan matches this SLICE only — the over-offer gate,
   `bind` contexts, and HTTP-vs-WS unification are out-of-scope (recorded in
   `.worktrees/.the-usual-logs/recovery-offer-phone/out-of-scope-findings.md`);
   no invented bonus refactor.
8. **Ambiguity fatal-scan:** a second implementer executing tomorrow would
   produce the same shapes (class lists are spelled out, selectors quoted,
   identifiers spelled, no "shapes" murk) and reach green.
