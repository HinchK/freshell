# JAN-87 — Re-annotate settings-persistence-split rust leg (seed vs defaultCwd split) — df1 evidence

**Branch:** `df1/fix-split87-annotation` (base `df1/integration` @ `b6aa86d79`, the CFG-04 merge) · **Date:** 2026-08-09 · **Scope:** test-spec + evidence only — NO product code (`src/`, `server/`, `rust/`, `crates/` untouched).

## Why

Gate batch B001 established: `test/e2e-browser/specs/settings-persistence-split.spec.ts` mixed TWO
rust gaps under one expected-fail umbrella. CFG-04 (merge `b6aa86d79`) fixed the
`legacyLocalSettingsSeed` gap and flipped the whole rust leg to expected-pass; its canary run then
caught the SECOND, still-open gap red: a server-shared `defaultCwd` PATCHed by one client never
reaches a second client through the rust server's WS/bootstrap resolved-settings path. That gap is
owned by **CFG-12** (checklist: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`,
CFG-12 item, PW-RUST acceptance — two isolated contexts, B keeps local appearance but receives the
cwd, survives restart). CFG-12 is queued, not yet started.

## What changed (single file: `test/e2e-browser/specs/settings-persistence-split.spec.ts`)

Playwright's `test.fail` granularity is per-`test(...)`, so the one combined test was split into two
tests at exactly the seed/defaultCwd boundary. Every original assertion survives exactly once:

1. **`browser-local settings stay local across isolated profiles and reloads`** — the seed/locality
   half (original lines 88–128: seed `theme:light` resolves; A overrides to dark in localStorage
   only; A reload keeps dark; fresh context B stays light) PLUS, moved to its semantically correct
   pre-PATCH position, the two seed-persistence config assertions from the original tail:
   `config.legacyLocalSettingsSeed` still `{theme:'light'}` and `config.settings.theme` undefined
   (the browser-local theme never lands in server-persisted settings). Expected-PASS on BOTH
   projects.
2. **`server-shared defaultCwd set by one profile replicates to another and persists to config.json`**
   — the server-shared half (original lines 130–159: PATCH `/api/settings {defaultCwd}` from A; B
   reload resolves it; `config.settings.defaultCwd` persisted on disk). Expected-PASS on
   `legacy-chromium`; on `rust-chromium` pinned with
   `test.fail(e2eServerKind === 'rust', 'CFG-12: ... (2026-08-09)')` naming CFG-12 as owner.
   Playwright hard-fails an unexpected PASS, so CFG-12 landing flips this to red as the
   delete-the-pin signal.

The describe-level comment was rewritten: it previously claimed (post-CFG-04) that "both projects
now expect this test to pass" — stale, since the defaultCwd half still fails on rust.

## Harness mechanics confirmed (not guessed)

Server kind is selected per Playwright PROJECT via the `e2eServerKind` worker-scoped fixture option
(`playwright.config.ts`: `legacy-chromium` → `'legacy'`, `rust-chromium` → `'rust'`; both match
`MATRIX_SPECS` which includes this spec). The spec's worker-scoped `testServer` fixture routes it
through `createE2eServerHandle` (`helpers/external-target.ts`) into `TestServer` (legacy Node) or
`RustServer` (owned rust binary, `helpers/rust-server.ts`, `target/release/freshell-server`, cargo
release build invoked by the fixture if missing).

## Observed per-leg outcomes (all runs under pw lease, `nice -n 19`, this worktree)

- **Pre-edit rust baseline** (spec as merged at `b6aa86d79`):
  - Run 1: fixture setup timeout — cold `cargo build --release` (2m16s) exceeded the 60s fixture
    timeout. Infrastructure artifact only; binary was then warm.
  - Run 2 (warm): seed/theme/locality assertions ALL green on rust (CFG-04's fix provably holds,
    including `patchResponse.ok === true` for the defaultCwd PATCH), then RED at line 155:
    `expect.poll(() => getResolvedSettings(pageB)?.defaultCwd).toBe(sharedDefaultCwd)` → received
    `undefined`. The subsequent `config.settings.defaultCwd` / seed tail assertions were never
    reached, so on-rust on-disk persistence of the PATCH is UNVERIFIED by this run — the visible gap
    is the WS/bootstrap replication side. Triage for CFG-12: start at the rust settings
    PATCH → broadcast/bootstrap path, not necessarily at the disk writer.
- **Post-edit validation:**
  - `--project=legacy-chromium`: **2 passed** (23.3s) — both split tests fully green on legacy.
  - `--project=rust-chromium`: suite green (exit 0): seed test passed; defaultCwd test failed as
    annotated ("expected to fail"), observed red at the same B-replication poll —
    `getResolvedSettings(pageB)?.defaultCwd` → `undefined` after PATCH + reload.
  - Confirmation run (rust leg, `--reporter=json`): `expected: 2, unexpected: 0`. Seed test
    `status: "expected"` (passed); defaultCwd test carries annotation
    `{type:"fail", "CFG-12: rust WS/bootstrap settings resolution drops a PATCHed server-shared defaultCwd (2026-08-09)"}`,
    `expectedStatus: "failed"`, actual `status: "failed"`, final `status: "expected"` — red at
    spec line 203 `expect.poll(() => getResolvedSettings(pageB)?.defaultCwd).toBe(sharedDefaultCwd)`:
    Expected `"/tmp/freshell-e2e-rust-8wxcmA/shared-default-cwd"`, Received `undefined`
    (10s predicate timeout). `patchResponse.ok === true` passed beforehand, so the PATCH itself is
    accepted; the red edge is strictly client-visible replication of the stored value.

## Ownership pointer

DefaultCwd gap → **CFG-12** (queued). When CFG-12 lands, the pinned rust leg produces an
unexpected-pass hard failure — delete the `test.fail(...)` line in the second test and its comment,
leaving both tests expected-pass on both projects. Seed regressions → CFG-04 evidence
(`docs/plans/df1-evidence/CFG-04.md`).
