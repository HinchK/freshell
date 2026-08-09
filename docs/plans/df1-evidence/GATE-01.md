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

## Results table (per spec × leg)

Updated per slice; the baseline JSON is authoritative, this table summarizes.

| slice | specs | legacy verdict | rust verdict | notes |
|---|---|---|---|---|
| 0 | harness-02-matrix-bite, screenshot-baselines, editor-pane | | | validation slice |

(Filled in as slices complete; final table enumerates all 69 specs with
leg verdicts pass/fail/skip-all/flaky-reproven + attribution.)

## Attribution log

(rust-red and legacy-red legs, each classified per the plan's protocol:
gap→owner item / gap-unscoped / flake→reproof / known-flake→ref /
preexisting→ref. None yet.)

## test.fail annotation changes

(None yet. Convention when required:
`test.fail(e2eServerKind === 'rust', '<OWNER-ID>: <one-liner> (2026-08-09)')`
with a comment block naming the owning checklist item — style exemplar:
`settings-persistence-split.spec.ts:161-166`.)

## Skipped-test report (gate requirement: "machine-readable skipped-test
report required to be empty or explicitly approved")

Extracted from the baseline JSON after the last slice:

```
npx tsx test/e2e-browser/helpers/gate01-collate.ts tally
# plus per-leg skipped counts in gate01-baseline.json
```

(Pending — every skip must trace to a spec-file KNOWN-DIVERGENCE comment or
an explicit approval.)

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
