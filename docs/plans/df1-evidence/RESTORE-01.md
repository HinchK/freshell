# RESTORE-01 evidence — recover-my-panes offer vs unchanged legacy suite (F1)

Item: **RESTORE-01 — Make the recover-my-panes offer non-interfering for e2e contexts / match legacy behavior.**
Plan: `docs/plans/df1/RESTORE-01.md`. Branch `df1/restore-01-panel-inert` off `origin/df1/integration` @ `5521f3aba`.

## Verdict: the rust panel is CORRECT product behavior; the fix belongs to the HARNESS

GATE-01's F1 mechanism, re-verified against the code in this worktree:

1. `RecoveryOfferPanel` (`src/components/RecoveryOfferPanel.tsx:79-107`) fetches
   `GET /api/recovery/inventory` on any boot whose localStorage had no persisted
   layout at module load (D1 gate) — every fresh Playwright context by construction.
2. The rust server's inventory builder (`crates/freshell-server/src/recovery_inventory.rs`)
   joins the newest retained tabs-snapshot generations of clients OTHER than the
   requester (`select_foreign_recent_generation_ids`, A15 staleness + A16
   boot-anchored concurrent-client filters) with bound pane-ledger rows.
3. On a worker-shared e2e server, prior tests' clients pushed auto-shell/picker
   snapshots within seconds; a later fresh context's boot is, to the server,
   indistinguishable from a real browser connecting after the old browser
   vanished — the EXACT scenario the feature exists for
   (`docs/plans/2026-07-26-recover-my-panes.md` D1: "empty-never and
   empty-cleared browsers … both are genuinely new-browser situations";
   D2's A16 filter deliberately protects only CONCURRENTLY-opened windows, and
   cannot — by design — suppress offers for clients that vanished before boot,
   because that vanishing IS the recovery scenario).
4. The legacy Node server has no recovery route at all: `grep -rn
   "recovery/inventory" server/` → 0 hits, so the panel's `.catch(() => {})`
   stays quiet on legacy legs. SESSION-05 already records this as a documented
   KNOWN DIVERGENCE.
5. The panel's behavior is pinned as correct by `recover-my-panes-rust.spec.ts`
   scenarios 1–3 (including the over-offer/live-note trade-off) and promise P23
   (`docs/pbh-20260807/map/promise-ledger.md:35`).
6. The "junk" rows GATE-01 observed (`New Tab: picker`, `Tab 1 (exit 0): shell`)
   arrive through the tabs-snapshot union — real layout records of the vanished
   client. D5 restores layout wholesale (shells recreated fresh via
   `restoreLayout`; picker panes restore as picker content). Filtering
   picker/shell/exited panes out of the offer would (a) not cover plain shell
   tabs — the bulk of F1 offers and of real restores — and (b) degrade the real
   user feature: a lost browser whose shells aren't restorable is the feature
   gutted. There is no honest product-side filter that silences the tests
   without breaking the product promise. **(a) ruled out with evidence.**
7. The remaining honest options were per-spec dances (SESSION-05's
   `bootFreshPage`, sanctioned but spec-local — exactly what this item says
   must not persist 22 times) or ONE harness affordance. Chosen: harness
   affordance — a shared watcher that answers the offer through the REAL UI
   path (observed wire response → panel render → click `recovery-decline` →
   `recordDismissal`/`clearPendingOffer` all execute), equivalent to an
   uninterested user clicking "Not now". No product masking, no weakened
   assertions: the rust leg now exercises MORE real product code (the decline
   path) than before.

## Load-bearing audit (post-plan; no Task tool in this environment → validators run firsthand, fallback recorded)

| ID | Assumption (falsifiable) | Decision controlled | Cost if wrong | Method | Status | Evidence |
|----|--------------------------|--------------------|---------------|--------|--------|----------|
| LB1 | F1 junk comes from DESIGNED snapshot-union join (not a ledger bug); no honest product filter silences tests | whole direction | critical | inspect code + design doc | VERIFIED | items 1–6 above; recovery_inventory.rs:25-64 (A15/A16), :136-216 (union records whole panes incl. picker kinds), :254-265 (ledgerOnly excludes live rows) |
| LB2 | Decline is client-local only (no server-side dismissal state) → auto-decline cannot contaminate later tests on the shared server | harness feasibility | high | inspect | VERIFIED | `src/lib/recovery/dismissal.ts`: DISMISSED_KEY/PENDING_KEY are `localStorage` only; panel `decline()` calls `recordDismissal`+`clearPendingOffer` (RecoveryOfferPanel.tsx:159-163) |
| LB3 | Legacy e2e server 404s `/api/recovery/inventory` → watcher inert on legacy | legacy-bit-identical claim | high | inspect | VERIFIED | 0 route hits in `server/`; SESSION-05 evidence documents observed 404 on the legacy leg |
| LB4 | Playwright 1.52 supports overriding built-in `context` fixture + custom test option via `test.use` at file scope | Task 2 wiring | medium | docs knowledge + first-leg execution (fallback: override `page` fixture instead) | VERIFIED-BY-RUN (recorded in verification section after first green leg) | — |
| LB5 | Decline click at boot doesn't perturb unrelated assertions (focus/WS/redux) | green-run trustworthiness | high | run: sample ×2 consecutive + biggest offender | VALIDATED in Task 4 runs (recorded below) | — |
| LB6 | Playwright global-setup builds dist/ from this fresh worktree | runnability | low | first leg run fails loud if not | VERIFIED during RED run | build output in RED run log |
| LB7 | `target/release/freshell-server` matches head 5521f3aba | FRESHELL_E2E_RUST_SERVER_BIN freshness | medium | cargo build exit 0 at that head | VERIFIED | release build completed green at 5521f3aba (cargo lease) |
| LB8 | All 22 F1-affected specs consume the shared `fixtures.js` test chain (else watcher never attaches there) | Task 3 adoption list | high | grep all 22 files | VERIFIED | 21/22 import fixtures directly with no local extend; `session-directory-matrix` `base.extend`s the SHARED base (fixtures.js:109 import :3) → inherits |
| LB9 | `respond.json()`/click errors can be swallowed without unhandled rejections failing tests | watcher safety | medium | unit tests (Task 1) + pw run | VERIFIED in Task 1/4 | — |

No state-changing validator actions were needed. No new assumptions surfaced beyond LB5's empirical drag (folded into Task 4's ×2-consecutive requirement).

## Verification (filled in as execution proceeds)

### RED (pristine harness, head e1d2a966d)

```
FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server GATE01_PROJECTS=gate01-rust \
  GATE01_WORKERS=2 DF1_HOLDER=df1-restore-01-panel-inert \
  test/e2e-browser/gate01-run-slice.sh restore01-red editor-pane.spec.ts settings.spec.ts terminal-lifecycle.spec.ts
```

Result: **14 failed, 13 passed (rust only)** in 8.2m — the SAME head is green on
legacy per GATE-01's baseline for these files (legacy legs 13/13, 8/8, 6/6
green at gate). F1 signature verbatim in error contexts:
`dialog "Restore 2 panes from server memory?"` /
`dialog "Restore 1 pane from server memory?"` in
`test-results/editor-pane-*/error-context.md` (×2) and
`test-results/settings-*/error-context.md`, and click retries
"waiting for element to be visible, enabled and stable" ×58-59 (overlay
interception) in the settings failures. This reproduces GATE-01 F1 on this
branch, pristine. LB6 verified in the same run (global-setup dist build from
fresh worktree).

### Helper unit tests (Task 1)

- RED: `npm run test:e2e:helpers -- recovery-offer` → module-missing fail, then
  12/13 pass + 1 fail (body-read-failure case needed a triage log line; the
  watcher had silently swallowed).
- GREEN: 13/13 (`npm run test:e2e:helpers -- recovery-offer`), commit
  `dda7e8e8c`.

### Task 2/3 implementation record (commit 33fd5b650)

- `helpers/fixtures.ts`: `recoveryOfferHandling` test option (default
  `'auto-decline'`) + override of the built-in `context` fixture; watcher is
  installed only when `e2eServerKind === 'rust'`. Legacy legs install nothing.
- Type-level fix forced by the change: `testServer`'s type declaration moved
  to the worker-scope generic group (pre-existing TS2322 "worker-scope tuple"
  noise at fixtures.ts — proven base-reproducible via `git stash` + same tsc
  gate). The degraded cascade had hidden custom options from `test.use`.
- `multi-client.spec.ts`: all 7 `browser.newContext()` sites route through a
  local `newClientContext()` that adopts the shared installer.
- `tabs-client-retire.spec.ts`: installer adopted inside `newDevicePage`.
- `project-colors-matrix.spec.ts`: SESSION-05's per-spec dance DELETED
  (strict-equivalent protection is now global); manual `contextB` adopts the
  installer; `harnessA` ride via the default-page context override.
- `restore-contract-wall-rust.spec.ts`: `test.use({ recoveryOfferHandling: 'manual' })`
  — uses the DEFAULT page fixture AND asserts the panel at boot.
- `sidebar-registry-sync-rust.spec.ts`: NO opt-out needed — discovered during
  implementation to import `test` from `@playwright/test` RAW (not the shared
  fixtures chain), so the context override never attaches there; its decline
  idiom + case-d remain untouched. Comment added in-file.
- `recover-my-panes-rust.spec.ts`: untouched (consumes only `{ browser }`;
  watcher can never attach).

Typecheck: `tsconfig.restore01-check.json` (house per-item gate pattern) —
zero errors attributable to RESTORE-01 files; two base-reproducible TS2459s
(`TestServerInfo` import in the two rust-only specs) remain by convention.
Sibling gates (term04/browser01/raw-clients) re-run clean.

### GREEN verification

**Run `restore01-green-rust-1`** (fix live; editor-pane, settings,
tab-management, multi-client, terminal-lifecycle, project-colors-matrix;
rust-only, 2 workers): **43 passed / 2 failed** (from the RED run's 13p/14f on
a subset). The watcher fired exactly as designed — dozens of
`[recovery-auto-decline] recovery offer made; harness clicking "Not now"`
lines, plus its intended-benign "non-fatal decline failure: Target page…
closed" lines when a test closed its context mid-decline (swallowed, per the
no-fail-the-test contract).

Failure triage of the 2 non-green tests:

1. `editor-pane.spec.ts:68` (loading-shell transient not observed; final
   editor pane fully rendered — NOT the dialog). Re-ran in disambiguation run
   `restore01-disambig-1`: **6/6 green** → rust-side transient flake, not F1,
   not watcher-caused. Monitored again in the consecutive green run 2.
2. `multi-client.spec.ts` "reconnecting second viewer keeps page 1 PTY size
   stable…": `terminal.attach` reconnect messages — expected ≤ 2, received
   **3** (spec :322, intent-filtered to reconnect-shaped attaches). The dialog
   interference is gone (the test now runs to its final assertions); the red
   is a NEW assertion level. Deterministic across green-rust-1 AND disambig-1.

**Probe (exonerates the watcher):** ran ONLY that test as the first/only test
on a fresh worker server (`--workers=1 -g`, gate01-rust, head 33fd5b650). On a
fresh server the inventory is provably empty at page1's boot and page2's D1
gate suppresses the fetch (shared localStorage), so the watcher is inert by
construction. Result: **STILL red, identical 3-vs-≤2**. Conclusion: a real
pre-existing rust↔legacy divergence in reconnect attach multiplicity (legacy
6/6 green at gate ≤2; rust emits 3 — consistent with an extra client-visible
reconcile generation/epoch fold on rust's reconnect path), previously MASKED
by F1 (at gate the dialog blocked the test from ever reaching this assertion;
its red was dialog-attributed). Follows GATE-01's own anti-masking doctrine
(B001 note: pinning here would hide a differently-owned failure) → recorded
as a new gap attribution on the leg, NOT pinned and NOT "fixed" by widening
the assertion. Candidate owner: the reconcile/reconnect lane.

**Baseline bookkeeping note (executed; head field bumped to 33fd5b650):**
multi-client rust keeps attribution `gap-unscoped` (verdict stays fail — the
leg IS still red, now for the unmasked reason; note rewritten via
`gate01-collate.ts attribute` to split F1-fixed from the residual). Legs that
re-ran fully green had their stale F1 `gap-unscoped` attribution REMOVED via a
JSON edit (the collator has no un-attribute CLI and a stale `gap-unscoped`
force-pins verdict=`fail`; removal restores the merge-produced mechanical
verdict `pass`): editor-pane, settings, tab-management, terminal-lifecycle
(2 consecutive green runs each) and sidebar, session-directory-matrix, stress
(1 run each, merged green with zero failures). project-colors-matrix rust was
never F1-attributed at the gate (it passed green all along — the SESSION-05
dance); untouched. Tally after: rust 44 pass / 25 fail (was 37/32);
legacy unchanged 53/15/1.

### Remaining verification legs

- **Legacy sample legs** (`restore01-green-legacy`: editor-pane, settings,
  tab-management, multi-client, terminal-lifecycle, project-colors-matrix;
  gate01-legacy): **45 passed / 0 failed** — legacy behavior bit-identical
  (watcher installs nowhere on legacy; the panel route is absent).
- **Panel-owning specs on the real rust-chromium project** (main config,
  FRESHELL_E2E_RUST_SERVER_BIN): `recover-my-panes-rust.spec.ts` **3/3 green**
  (accept / decline / D7-no-restart-live-note scenarios all still exercise
  and pin the panel itself — the feature the harness now auto-answers for
  everyone else). `sidebar-registry-sync-rust.spec.ts`: case-c failed with
  `expect(res.ok()).toBe(true)` on the REST codex tab-create at :282, and
  serial case-b/a/d did not run. Probe: case-c ALONE reproduces identically —
  and this spec imports `test` from `@playwright/test` raw (never the shared
  fixtures chain, no watcher) with a comments-only diff vs the base commit,
  so the red is **pre-existing, not RESTORE-01-caused** (host/rust REST
  codex-create; separate ownership — like the other non-F1 reds GATE-01
  logged). Not fixed here (out of scope, untouched code paths).
- **Harness bucket sanity** (`restore01-harness`: harness-02-matrix-bite +
  harness-03-provider-fixtures, BOTH legs): **54 passed / 0 failed** — the
  shared `fixtures.ts` change perturbs no harness self-check on either leg.
- **Full helper vitest suite** (`npm run test:e2e:helpers`): **20 files,
  269/269 passed** (includes the 13 new recovery-offer tests +
  gate01-collate's own suite).
- **Static gates:** `cargo fmt --all -- --check` clean; `git diff
  5521f3aba..HEAD -- crates/ server/ src/` EMPTY (zero product-code changes,
  so clippy carries trivially — recorded, not re-run); eslint over the 8
  touched files: 0 errors (spec files are outside the repo eslint config's
  configured scope — "file ignored" warnings only, same at base);
  `tsconfig.restore01-check.json` clean except the 2 base-reproducible TS2459s.

