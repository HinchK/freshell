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

See pipeline below. runHistory in `test/e2e-browser/gate01-baseline.json` carries the pw tallies.
