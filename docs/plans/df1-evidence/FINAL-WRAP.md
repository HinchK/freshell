# DF1 Final Wrap — Fitness Record (wave 1 + wrap batch)

Integration span: `4c2297667` (fork) .. `5dece6822` (tip). Branch `df1/integration`, worktree `.worktrees/df1-gate`.
22 items shipped: 18 strategic-wave items (A + B003 + B004 batches) + 4 wrap-batch items (JAN-88, RESTORE-01, SESSION-13, CFG-01).

## Batch gates (all PASS before merge)
- Batch A (8 items) — `docs/plans/GO-A-HANDOFF.md` + per-item `docs/plans/df1-evidence/*-GO.md`
- B003 (8 items) — `docs/plans/df1-evidence/B003-HANDOFF.md`
- B004 wave-1 greens (CFG-04, BROWSER-01) — `docs/plans/df1-evidence/B004-HANDOFF.md`
- B005 wrap batch — `docs/plans/df1-evidence/B005-WRAP.md` + `B005-HANDOFF.md`

## Second verification (wrap phase)
- B004-trusted items re-verified: 4/4 PASS on pure rerun (CFG-04 incl. allowed multi-client carve-out).
- Wrap items verified by fresh verifiers: JAN-88, RESTORE-01, SESSION-13, CFG-01 — 4/4 PASS, exact claimed commands re-run at attested heads.

## Fresh-eyes wrap review (external, `--gpt`, `docs/plans/df1-evidence/WRAP-REVIEW.md`)
- 6 rounds, 14 majors fixed (r1: 6, r2: 3, r3: 3, r4: 2, r5–r6: 0 genuine majors). Verdict trail F/F/F/F/F/F — terminal-round F carries only re-rejected (immutable-history / by-design) findings.
- Highest-value catch (r3): `8b13d83a6` — loopback proxy forwarded `x-auth-token` + `freshell-auth` cookie verbatim to proxied apps (both servers); stripped with rust + legacy + browser01 pins.
- Other notable: dedupe-settle duplicate-PTY (r2 `c00630fec`, r3 `b7b3da712`), e2e-cloud portability/arg-corruption/stale-image class (r1/r3/r4).

## Final gates
- R1 @ `36b7e09b4` (df1-gate-final): typecheck PASS; cargo 115 suites / 2999 passed; harness pins 6/6; significance sweep clean (delta-introduced `.only`/`todo` none; net-new conditional skips OK). Stopped on deterministic reds → arbitrations below. NOTE: `npm run test:cloud`/cloud-vitest does not exist at this rev (doc drift); cloud coverage is `test:e2e:cloud` (see R2).
- R2 @ `aa9f4b7b3`: typecheck PASS; cargo sanity (settings_store 71/71, settings 76/76, session_directory 60/60, net09 1/1); npm test PASS (client 440 files/4917 tests, server 319/4926, electron 34/350, exit 0); 52/52 harness 03/04/05/06/14 (+h11 chromium); wrap-item specs all green (incl. a11y deny-gate, helpers 268/269 minus posture artifact); product matrix ×3 legs green across project-colors/layout-sync*/browser01-proxy/settings-persistence-split/session-malformed-data/leak-metrics; `test:e2e:cloud` orchestrated end-to-end (589p/5flaky/25f remote).
- Post-R2 fix: `5dece6822` layout-sync chromium leg (spec race vs client LWW sync stomps; forced-stomp TDD proof; full spec green ×3 projects at tip).

## Arbitrations (known reds, adjudicated)
1. **restore-contract-wall-rust codex cluster** (spec:820/2081/2225-class legs) — deterministically red at pre-campaign base `4c2297667` (2 runs, 12p/3f) AND at tip `aa9f4b7b3`: PRE-EXISTING. Owned by TERM-22's never-landed PW-RUST codex lifecycle cycles (note recorded on TERM-22). Knowingly excluded from wave-1 fitness.
2. **layout-sync-authoritative chromium leg** — was deterministic red at R2 tip; root-caused as test-side race vs client last-write-wins syncs; FIXED `5dece6822`, green ×3.
3. **helpers perf smoke ZodError (git.branch)** — detached-HEAD posture artifact; byte-identical at base; equally fails at base under same posture. Not campaign-attributable.
4. **Discovery hand-offs** (queued TODOs): `TODO-FLAKE-RULER` (RULER leg red-in-R1/green-in-R2), `TODO-CLOUD-RUST-POP` (cloud 2-worker rust-leg red population vs local green), plus prior `SIDEBAR-REGISTRY-CASE-C-BASE-RED`, `NET-FLAKY-01`, GO-wave carved-out discoveries.

## PR split
- **PR #1 (wave 1):** anchor `36b7e09b4` — 18 items + wrap-review r1–r5 fixes. Gated by R1 (same head) + R2 (strict superset head; wrap delta is additive and was itself separately gated).
- **PR #2 (wrap batch):** `36b7e09b4..5dece6822` — 4 item merges + B005 evidence + r6 doc + gate fix; gated by R2 + per-item B005 verification + review r6 (0 majors).

Deferred by design (later sessions): REV-01→REVIEW-01→DEFER-01 chain, GATE-01/HARNESS-10 defers, TERM-22 (with arbitration note), SESSION-09 (worker died mid-item; task-1 commit preserved on branch), CT-01, no-rust-leg tail.
