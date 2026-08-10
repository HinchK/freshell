# GATE-01 evidence — unchanged legacy browser suite × {Node legacy, Rust}

Item: **GATE-01 — Run the unchanged legacy browser suite against both Node and
Rust. No Rust-only skips for a user-visible feature are allowed.**
Plan/run protocol: `docs/plans/df1/GATE-01.md`. Worker branch:
`df1/gate-01-unchanged-suite-both` off `origin/df1/integration` @ `3dbba43c2`.

## Suite definition (precise)

The effective test selection of the `chromium` project in
`test/e2e-browser/playwright.config.ts` at the base ref: all
`test/e2e-browser/specs/*.spec.ts` **minus** the 31 `RUST_ONLY_SPECS` (each
excluded file carries a config comment documenting why it hard-fails under
the legacy Node server by design) = **69 spec files**, 280×2 = **560 tests**
(verified via `npx playwright test --config
test/e2e-browser/playwright.gate01.config.ts --list`: 280 per project).

Run vehicle: `test/e2e-browser/playwright.gate01.config.ts` (projects
`gate01-legacy` / `gate01-rust`; ONLY the `e2eServerKind` worker option
differs; snapshots pinned to the committed `-chromium-` baselines on both
legs). Spec files are UNCHANGED except additive conditional `test.fail`
pins listed in the Annotations section below.

Machine-readable artifact: `test/e2e-browser/gate01-baseline.json`
(per-spec × per-leg verdicts, counts, failure details, attributions; schema
documented in the collator header, `test/e2e-browser/helpers/gate01-collate.ts`).

## Headline finding F1 — RecoveryOfferPanel interference (rust leg, designed behavior, no owner)

**Signature:** on `gate01-rust` only, tests after the first on a worker-shared
server intermittently fail with either `.xterm` visibility timeouts
(`TerminalHelper.waitForTerminal`, 15 s) or Playwright click retries ending in
"`<div role="presentation" class="fixed inset-0 … bg-black/50 …">` intercepts
pointer events". `test-results/**/error-context.md` shows the open dialog:
**`Restore N pane(s) from server memory?`** with list items like
`Tab 1 (exit 0): shell — /tmp/freshell-e2e-rust-…` and even
`New Tab: picker` (a pane-picker pane).

**Mechanism (fully traced, citations in-repo):** `RecoveryOfferPanel`
(`src/components/RecoveryOfferPanel.tsx:67-106`) fetches
`GET /api/recovery/inventory` on every boot whose localStorage had NO
persisted layout (that is EVERY fresh Playwright page/context by
construction) and shows a modal when the inventory is recoverable. The rust
server's pane-identity ledger (durable across tests on the worker-scoped
server) still holds prior tests' pane rows — including picker panes and
teardown-killed terminals — so every subsequent fresh page gets the modal.
The legacy Node server has no such endpoint; the fetch fails and the panel
stays quiet (`.catch(() => {})`), so the legacy leg is unaffected.
`docs/plans/2026-07-26-recover-my-panes.md` D1/D2/D3 shows this is the
DESIGNED new-browser flow; the interruption of unchanged legacy specs is an
unintended interaction, owned by NO current checklist item.

**Evidence runs:** slice-0 attempt 2 (workers=2): rust legs of
editor-pane:120/:133 + screenshot-baselines:4/:16/:52 red with this
signature, legacy all-green 13/13. Isolated rust-only rerun
(`--workers=1`, editor-pane+screenshot-baselines): 5 red, same signature,
failures float between tests (editor-pane :83/:133/:193 this time) —
whack-a-mole → interference, not assertion-level parity gaps. Discrimination
run (screenshot-baselines + terminal-lifecycle, one worker each, rust-only):
terminal-lifecycle red on `:48` with the dialog offering a prior boot's
`New Tab: picker` pane. NOTE on scheduling: the config runs
`fullyParallel: true`, so one file's tests distribute across workers, each
worker booting its own worker-scoped server; any test that is not the first
to land on its worker's server can inherit that server's ledger/snapshot
records (auto-shell tabs and picker panes push tabs-snapshot generations
within seconds of each boot). Pollution is therefore per-worker-subset and
the victim set floats run to run — whack-a-mole, never a stable single
assertion.

**Draft follow-up item (unscoped → propose for the checklist's restore lane
or CFG-08 adjacency):** *"RESTORE-XX — Make the recover-my-panes offer
inert against e2e fresh-context boots (or make the pane-identity ledger stop
recording picker panes / teardown-killed terminals as recoverable) so the
unchanged legacy browser suite can run dialog-free on rust; alternatively
bless a per-spec dismissal step."* Until an owner lands, affected rust legs
are attributed `gap-unscoped` with note `recovery-offer interference (F1)`
and individual tests are NOT pinned (the interference floats; a per-test
`test.fail` would pin the wrong test and mask real assertions).

## Results table (per spec × leg)

Authoritative machine-readable data: `test/e2e-browser/gate01-baseline.json`
(per-spec × per-leg verdicts, latest-run counters, full per-run history,
failure excerpts, attributions; re-runs REPLACE a leg's counters and append
to `runHistory`, so isolated reproofs never corrupt the suite-context
record).

Counts legend: `p`=passed `f`=failed `s`=skipped `e`=expected-fail (pinned
`test.fail` consumed as expected). Verdicts reflect the LATEST run for the
leg; F1-attributed legs failed in suite context with dialog-verified cause.

FINAL TALLY (69 specs × 2 legs = 138 legs, 560 tests enumerated):
- legacy: 53 pass / 15 fail / 1 skip-all — NO leg pending
- rust:   37 pass / 32 fail / 0 skip-all — NO leg pending
- Per-test totals: see baseline JSON (suite-context runs) + `runHistory`.

| spec | bucket | legacy | rust |
|---|---|---|---|
| agent-checkpoint-rewind.spec.ts | product | pass (1p/0f/0s/0e) | fail/gap→AGENT-14 (0p/0f/1s/0e) |
| agent-continuity-matrix.spec.ts | product | pass (2p/0f/0s/0e) | pass (2p/0f/0s/0e) |
| amplifier-restore-rust.spec.ts | product | fail/preexisting (0p/1f/0s/0e) | fail/gap→TERM-27 (0p/1f/0s/0e) |
| auth.spec.ts | product | pass (6p/0f/0s/0e) | pass (6p/0f/0s/0e) |
| browser-pane-screenshot.spec.ts | product | pass (2p/0f/0s/0e) | fail/F1-interference (1p/1f/0s/0e) |
| browser-pane.spec.ts | product | pass (5p/0f/0s/0e) | fail/F1-interference (2p/3f/0s/0e) |
| cfg03-backup-restore.spec.ts | product | pass (2p/0f/2s/0e) | pass (4p/0f/0s/0e) |
| cfg04-legacy-browser-seed.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| codex-terminal-bounce-rust.spec.ts | product | fail/design-guard (0p/1f/0s/0e) | fail/gap→TERM-22 (0p/1f/0s/0e) |
| diag03-rotation-redaction-rust.spec.ts | product | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| editor-pane.spec.ts | product | pass (6p/0f/0s/0e) | fail/F1-interference (4p/2f/0s/0e) |
| fresh-agent-centralization-smoke.spec.ts | product | fail/preexisting (2p/2f/0s/0e) | fail/gap→AGENT-10 (2p/2f/0s/0e) |
| fresh-agent-mobile.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| fresh-agent.spec.ts | product | pass (9p/0f/0s/0e) | fail/F1-interference (5p/4f/0s/0e) |
| freshopencode-db-history.spec.ts | product | fail/preexisting (1p/2f/0s/0e) | fail/preexisting (1p/2f/0s/0e) |
| freshopencode-first-send-reload-repro.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| freshopencode-model-picker.spec.ts | product | fail/preexisting (0p/1f/0s/0e) | fail/preexisting (0p/1f/0s/0e) |
| freshopencode-restart-recovery.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| harness-01-rust-server.spec.ts | harness | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| harness-02-matrix-bite.spec.ts | harness | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| harness-03-provider-fixtures.spec.ts | harness | pass (26p/0f/0s/0e) | pass (26p/0f/0s/0e) |
| harness-04-session-corpus.spec.ts | harness | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| harness-05-raw-clients.spec.ts | harness | pass (10p/0f/0s/0e) | pass (10p/0f/0s/0e) |
| harness-06-misc-fixtures.spec.ts | harness | pass (10p/0f/0s/0e) | pass (10p/0f/0s/0e) |
| harness-11-a11y-gate.spec.ts | harness | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| harness-14-server-clock.spec.ts | harness | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| mcp-bridge-rust.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| mcp-qa-smoke-rust.spec.ts | product | fail/preexisting (0p/1f/0s/0e) | fail/preexisting (0p/1f/0s/0e) |
| mobile-viewport.spec.ts | product | fail/preexisting (6p/1f/0s/0e) | fail/F1-interference (4p/3f/0s/0e) |
| multi-client.spec.ts | product | pass (6p/0f/0s/0e) | fail/F1-interference (4p/2f/0s/0e) |
| multirow-tabs.spec.ts | product | pass (6p/0f/0s/0e) | fail/F1-interference (4p/2f/0s/0e) |
| opencode-replay-write-progression.spec.ts | product | pass (1p/0f/0s/0e) | fail/F1-interference (0p/1f/0s/0e) |
| opencode-restart-recovery.spec.ts | product | fail/preexisting (0p/5f/0s/0e) | fail/preexisting (0p/5f/0s/0e) |
| opencode-terminal-restore-rust.spec.ts | product | fail/design-guard (0p/1f/0s/0e) | pass (1p/0f/0s/0e) |
| pane-activity-indicator.spec.ts | product | fail/preexisting (2p/1f/0s/0e) | fail/F1-interference (1p/2f/0s/0e) |
| pane-picker-layout.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| pane-picker.spec.ts | product | pass (2p/0f/0s/0e) | pass (2p/0f/0s/0e) |
| pane-system.spec.ts | product | pass (10p/0f/0s/0e) | fail/F1-interference (5p/5f/0s/0e) |
| project-colors-matrix.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| reconcile-handshake-rust.spec.ts | product | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| reconnection.spec.ts | product | pass (6p/0f/0s/0e) | fail/F1-interference (4p/2f/0s/0e) |
| remote-tab-linkage-rust.spec.ts | product | fail/design-guard (0p/1f/0s/0e) | pass (1p/0f/0s/0e) |
| rest-tab-persistence.spec.ts | product | fail/design-guard (0p/1f/0s/0e) | pass (1p/0f/0s/0e) |
| restore-double-restart.spec.ts | product | pass (2p/0f/0s/0e) | pass (2p/0f/0s/0e) |
| restore-matrix.spec.ts | product | pass (10p/0f/0s/0e) | pass (10p/0f/0s/0e) |
| restore-sync05.spec.ts | product | pass (2p/0f/0s/0e) | pass (2p/0f/0s/0e) |
| resume-button.spec.ts | product | pass (3p/0f/0s/0e) | pass (3p/0f/0s/0e) |
| safe01-auth-matrix.spec.ts | product | pass (12p/0f/0s/0e) | pass (12p/0f/0s/0e) |
| safe03-origin-matrix.spec.ts | product | pass (6p/0f/0s/0e) | pass (6p/0f/0s/0e) |
| screenshot-baselines.spec.ts | product | pass (6p/0f/0s/0e) | fail/F1-interference (3p/3f/0s/0e) |
| server-restart-recovery.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| session-directory-matrix.spec.ts | product | pass (7p/0f/0s/0e) | fail/F1-interference (6p/1f/0s/0e) |
| settings-live-reload.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| settings-persistence-split.spec.ts | product | pass (2p/0f/0s/0e) | pass (1p/0f/0s/1e) |
| settings.spec.ts | product | pass (8p/0f/0s/0e) | fail/F1-interference (4p/4f/0s/0e) |
| sidebar-click-resume.spec.ts | product | skip-all/preexisting (0p/0f/2s/0e) | fail/gap→TERM-22 (1p/1f/0s/0e) |
| sidebar-opencode-rail.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| sidebar.spec.ts | product | pass (8p/0f/0s/0e) | fail/F1-interference (5p/3f/0s/0e) |
| stress.spec.ts | product | pass (5p/0f/0s/0e) | fail/F1-interference (2p/3f/0s/0e) |
| tab-bar-resize.spec.ts | product | pass (5p/0f/0s/0e) | fail/F1-interference (4p/1f/0s/0e) |
| tab-management.spec.ts | product | pass (11p/0f/0s/0e) | fail/F1-interference (6p/5f/0s/0e) |
| tab-recency-sync.spec.ts | product | pass (1p/0f/0s/0e) | pass (1p/0f/0s/0e) |
| tabs-client-retire.spec.ts | product | fail/preexisting (0p/1f/0s/0e) | fail/F1-interference (0p/1f/0s/0e) |
| term13-scrollback-boundary.spec.ts | product | pass (2p/0f/0s/0e) | fail/F1-interference (2p/0f/0s/0e) |
| term28-path-shadow-rust.spec.ts | product | fail/design-guard (0p/2f/0s/0e) | pass (2p/0f/0s/0e) |
| terminal-background-freeze-catchup.spec.ts | product | pass (1p/0f/0s/0e) | fail/F1-interference (0p/1f/0s/0e) |
| terminal-lifecycle.spec.ts | product | pass (13p/0f/0s/0e) | fail/F1-interference (6p/7f/0s/0e) |
| truly-idle-alerting.spec.ts | product | fail/preexisting (0p/1f/0s/0e) | fail/preexisting (0p/1f/0s/0e) |
| ws-ping-pong-matrix.spec.ts | product | pass (2p/0f/0s/0e) | pass (2p/0f/0s/0e) |

## Attribution log

**Rust-red legs (32):**

1. **Named-owner product gaps (4 legs, 3 pinned with conditional
   `test.fail`):**
   - `amplifier-restore-rust.spec.ts` rust → **TERM-27** (Amplifier hardened
     association): after restart, `amplifier resume <id>` reports the saved
     session "could not be found on disk — started a fresh session".
     Deterministic across slice-3 AND isolated rerun
     `reproof-s3-amplifier-rust`. Pinned in-spec.
   - `codex-terminal-bounce-rust.spec.ts` rust → **TERM-22** (Codex lifecycle
     hardening/expected-restart): post-restart re-resume leaves
     `content.terminalId` null (20 s poll). Deterministic (slice-5 +
     `reproof-s5-codexbounce`). Pinned in-spec.
   - `sidebar-click-resume.spec.ts` rust → **TERM-22** (same family):
     sidebar Codex click-resume never assigns `terminalId` (20 s poll).
     Deterministic (slice-7 + `reproof-s7-sideclick`; amplifier leg of the
     same file stayed GREEN on rust). Pinned in-spec.
   - `fresh-agent-centralization-smoke.spec.ts` rust → **AGENT-10**
     (model capabilities): `GET /api/fresh-agent/model-capabilities/
     freshclaude` → **404 on rust** (route exists on legacy,
     `server/index.ts:753`). Second same-file divergence: legacy layout-sync
     normalization yields `[]` fresh-agent panes on rust (candidate
     AUTO-12/AGENT-16 — owner adjudication needed). Deterministic
     (slice-7 + `reproof-s7-facent`). NOT pinned: pinning is per-test, and
     this file's two tests each need separate owner adjudication; the leg is
     recorded red with full detail instead (B001: a pin here would mask a
     second, differently-owned failure — exactly the masking trap the
     campaign already burned on).
2. **F1 RecoveryOfferPanel interference (26 legs, `gap-unscoped`, note
   "recovery-offer interference (F1)"):** browser-pane,
   browser-pane-screenshot, editor-pane, fresh-agent, mobile-viewport,
   multi-client, multirow-tabs, opencode-replay-write-progression,
   pane-activity-indicator, pane-system, reconnection, screenshot-baselines,
   session-directory-matrix, settings, sidebar, stress, tab-bar-resize,
   tab-management, tabs-client-retire (rust leg only; legacy leg
   preexisting), term13-scrollback-boundary, terminal-background-freeze-catchup,
   terminal-lifecycle. All verified by `Restore N pane(s) from server
   memory?` presence in the Playwright error-context (ratios recorded
   per-leg in baseline `attribution.note`) and/or the `.xterm `-never-
   visible-under-modal signature, always with a GREEN legacy leg in the same
   run. Root cause + draft follow-up item: see F1 above.
3. **Rust leg red only via same pre-existing both-leg redness (6, kind
   `preexisting`):** freshopencode-db-history, freshopencode-model-picker,
   mcp-qa-smoke-rust, opencode-restart-recovery (identical assertions as
   legacy; legacy reproofed deterministic), truly-idle-alerting (identical).

**Legacy-red legs (15) + 1 skip-all:**

- **Design-guard class (6, fail-by-design, registration errata):**
  term28-path-shadow-rust, amplifier-restore-rust,
  opencode-terminal-restore-rust, rest-tab-persistence,
  remote-tab-linkage-rust, codex-terminal-bounce-rust — each hard-asserts
  `e2eServerKind === 'rust'` (deliberate loud guard) and is ALSO in
  `rust-chromium`'s testMatch + the match-all chromium lane while missing
  from `RUST_ONLY_SPECS`. The legacy reading is therefore deterministically
  red; the fix belongs to config consolidation (add to RUST_ONLY_SPECS),
  deliberately not done here (union-hot shared config mid-campaign; the
  evidence record suffices for the gate). `sidebar-click-resume` legacy is
  `skip-all` by its own documented `test.fixme` + `test.skip`.
- **Pre-existing suite redness on legacy (9):** freshopencode-db-history,
  opencode-restart-recovery, fresh-agent-centralization-smoke,
  mobile-viewport, pane-activity-indicator, tabs-client-retire,
  truly-idle-alerting, freshopencode-model-picker, mcp-qa-smoke-rust — EVERY
  ONE reproofed deterministic in an isolated legacy rerun (run ids in
  baseline `runHistory`/`attribution.ref`). None are load flakes; all are
  spec-vs-current-code drift or frozen-branch divergences. Headline: **the
  unchanged legacy chromium lane is NOT green on df1/integration today**
  (15 files red of 69) — independent of the rust port.

## test.fail annotation changes (all in campaign convention style)

Exemplar style: conditional `test.fail(e2eServerKind === 'rust',
'<ID>: … (2026-08-09)')` + comment; the pin fails HARD on unexpected pass
(self-deleting signal when the owner lands).

1. `amplifier-restore-rust.spec.ts` — TERM-27 (post-restart resume loses
   on-disk session).
2. `codex-terminal-bounce-rust.spec.ts` — TERM-22 (re-resume terminalId null).
3. `sidebar-click-resume.spec.ts` — TERM-22 (click-resume terminalId null).

Pin mechanics VERIFIED post-hoc: run `postpin-verify` (gate01-rust, the 3
pinned files) consumed each pin as expected-fail (baseline `runHistory`
shows e=1 for `postpin-verify` on all three; the amplifier leg of
sidebar-click-resume genuinely passed p1 in the same run). Baseline leg
verdicts remain `fail` by design — the gate records the UNPINNED truth; the
pins exist so the `rust-chromium` lane keeps fail-before/pass-after
semantics for the owner items.

Pre-existing pin honored (not added by this gate):
`settings-persistence-split.spec.ts` CFG-12 — recorded green-with-pin on
rust (e1), legacy clean.

## Skipped-test report (gate bar: "empty or explicitly approved")

Machine-enumerated from all slice JSON reports — **5 skipped test-legs
across 560 tests × …**, every one carrying an in-spec annotation:

1. `agent-checkpoint-rewind.spec.ts` [gate01-rust] — `test.skip`
   KNOWN DIVERGENCE (rust-only skip of the Rewind UI gesture; user-visible
   feature). **NOT approvable by this worker** — recorded as gap candidate
   AGENT-14 in the baseline; requires orchestrator/user approval or
   AGENT-14 closure.
2. `cfg03-backup-restore.spec.ts` [gate01-legacy] ×2 — documented
   RUST-ONLY hardening legs (legacy has no forensic-preservation behavior).
3. `sidebar-click-resume.spec.ts` [gate01-legacy] ×2 — Amplifier leg
   KNOWN DIVERGENCE (frozen legacy has no amplifier provider) + Codex leg
   documented `test.fixme` (frozen server settles create to error).

No rust-only skip exists for a user-visible feature EXCEPT
`agent-checkpoint-rewind` (flagged above). No unannotated skip exists
anywhere in the gate run.

## Slice appendix (committed run plan)

- slice-0 (validation): harness-02-matrix-bite, screenshot-baselines, editor-pane
- slice-1: harness-03-provider-fixtures, reconnection, freshopencode-db-history, agent-checkpoint-rewind, term28-path-shadow-rust, server-restart-recovery
- slice-2: terminal-lifecycle, multirow-tabs, settings-persistence-split, harness-04-session-corpus, agent-continuity-matrix, ws-ping-pong-matrix, settings-live-reload
- slice-3: restore-matrix, auth, browser-pane, harness-11-a11y-gate, browser-pane-screenshot, amplifier-restore-rust, harness-01-rust-server, sidebar-opencode-rail
- slice-4: safe01-auth-matrix, cfg03-backup-restore, opencode-restart-recovery, harness-14-server-clock, opencode-terminal-restore-rust, cfg04-legacy-browser-seed, mcp-bridge-rust, tab-recency-sync
- slice-5: harness-05-raw-clients, mobile-viewport, stress, pane-activity-indicator, pane-picker, codex-terminal-bounce-rust, mcp-qa-smoke-rust, tabs-client-retire
- slice-6: harness-06-misc-fixtures, multi-client, tab-bar-resize, reconcile-handshake-rust, restore-double-restart, fresh-agent-mobile, opencode-replay-write-progression, truly-idle-alerting
- slice-7: tab-management, session-directory-matrix, fresh-agent-centralization-smoke, sidebar-click-resume, restore-sync05, freshopencode-first-send-reload-repro, pane-picker-layout
- slice-8: pane-system, sidebar, rest-tab-persistence, diag03-rotation-redaction-rust, terminal-background-freeze-catchup, freshopencode-model-picker, project-colors-matrix
- slice-9: fresh-agent, settings, safe03-origin-matrix, resume-button, term13-scrollback-boundary, freshopencode-restart-recovery, remote-tab-linkage-rust

## Verification commands (re-runnable)

```bash
# Suite selection integrity (list must show 280 per project / 560 total):
npx playwright test --config test/e2e-browser/playwright.gate01.config.ts --list | tail -1
# Collator unit tests:
npm run test:e2e:helpers -- gate01-collate
# Baseline tally (exit 1 while any leg is pending):
npx tsx test/e2e-browser/helpers/gate01-collate.ts tally
# Spot-check slice 0 (requires FRESHELL_E2E_RUST_SERVER_BIN):
FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server \
  test/e2e-browser/gate01-run-slice.sh spotcheck-0 harness-02-matrix-bite.spec.ts
```
