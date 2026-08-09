# SESSION-05 — Implement project colors

**Item text (verbatim):** Implement project colors. Save, broadcast, and render the legacy color treatment on History project headers.
**Playwright validation (`PW-RUST`):** Choose a project color in one browser, assert the History project header updates in two contexts, reload/restart, and verify persistence plus unchanged unrelated project colors.

**Branch:** `df1/session-05-project-colors` (base `origin/df1/integration` = 4c2297667) · **Playwright posture:** `deferred`

## Parity-source findings (why even the legacy server needed +additive code)

On main, the feature was end-to-end DEAD, on both servers:

- **Save existed (legacy only):** `PUT /api/project-colors` (`server/project-colors-router.ts`) wrote `projectColors` to config and refreshed the indexer. The Rust server had no route, and preserved the config key pass-through only.
- **Broadcast was a no-op for color-only changes:** the legacy PUT's `codingCliIndexer.refresh()` republishes to `SessionsSyncService`, whose differ (`hasSessionDirectorySnapshotChange`, `server/session-directory/projection.ts`) is deliberately color-blind at the item level (pinned in `projection.test.ts`). After the read-model cutover, nothing else pushed colors — so no client re-fetched.
- **Render could never happen:** the session-directory page items carry no color and `SessionDirectoryPageSchema` had no color field; `groupDirectoryItemsAsProjects` (`src/lib/api.ts`) built groups with no `color`, so `project.color` was never populated and History headers always rendered the default `#6b7280` swatch. The render code itself (swatch + expanded "Color:" picker row + PUT gesture, `HistoryView.tsx`) was intact.

## What landed (all TDD red-green, mutation-proven where behavior was route-level)

**Channel (chosen design):** the session-directory PAGE gains an optional `projectColors: Record<string,string>` — the payload every client already re-fetches on `sessions.changed`. Wire-compatible in both directions (zod strips unknown keys; verified live against zod 4.3.6), so old server ↔ new client and new server ↔ old client both keep working.

- **Rust save:** `SettingsStore` gains `project_colors` (boot load, mtime freshness reload, adopt-from-disk + dirty-key persist overlay — the same side-by-side discipline as the override maps) and `set_project_color()` (persist failure surfaced). New `crates/freshell-server/src/project_colors.rs` mirrors `project-colors-router.ts`'s route and validation (zod issue shapes live-probed), and broadcasts `sessions.changed` on the shared `sessions_revision` sequence at the write site (the session sweep is structurally blind to config-only changes — same documented gap class as the GAP-1 override-write fix).
- **Rust read:** `crates/freshell-server/src/session_directory.rs` embeds `projectColors` on every page (omitted when empty).
- **Legacy broadcast fix (deliberate, documented):** `SessionsSyncService.flush` now ALSO compares the resolved per-project color map (`server/sessions-sync/service.ts`), so the legacy `refresh()`→`publish()` path broadcasts on a color-only change. `projection.ts`'s pinned color-blind contract is untouched.
- **Legacy read:** `server/session-directory/service.ts` embeds `projectColors` from the indexer-resolved project groups on every page (including pagination continuation pages).
- **Shared schema:** `shared/read-models.ts` `SessionDirectoryPageSchema.projectColors` (optional).
- **Client:** `groupDirectoryItemsAsProjects` and `searchResultsToProjects` overlay the page map (the two group-construction sites); `SearchResponse` threads it; `mergeProjects` in `sessionsThunks` is now **server-authoritative later-fetched-color-wins** (previously additive-only, which silently kept stale colors on cross-context recolor) via an explicit `preferColorsFrom` option — the reverse-argument deep-window silent-refresh merge passes `'existing'` so its fresh page wins too (regression pinned RED in `sessionsThunks.project-colors.test.ts`). No history-view render change needed.
- **Validation parity details:** falsy-body (`null/false/0/""`) validated as `{}` like `req.body || {}`; zod string limits measured in UTF-16 units like JS `length` (not bytes); non-string (junk hand-edited) color values are normalized away on both servers so the string-valued page record never fails client parse.

## Deliberate legacy-behavior changes (DoD disclosure)

1. `SessionsSyncService` now broadcasts on color-only snapshot changes (was: silently deduped). The one existing test that bundled a color flip into its "invisible fields" publish was updated to hold color constant; its purpose (tokenUsage/sourceFile invisibility) is unchanged.
2. New page field `projectColors` when colors exist (additive).
3. Same-path color overwrite was already legacy semantics (`{...cfg.projectColors, [path]: color}`); unchanged.

Not changes: color removal is never observable anywhere — legacy has no "clear color" UI and `setProjectColor` only sets. `mergeProjects` keeps a color when a later page omits one (a project dropping OUT of a page must not bleach it).

## Test evidence

- Rust crate (`cargo test -p freshell-server`): 577 passed (incl. 7 new settings_store + 6 new route + 2 new session-directory tests) + all integration binaries. Mutation-run RED proofs: disabling route broadcast fails 2 tests; bypassing validation fails 2; skipping the page attach fails 1; dropping the junk filter fails 1. Review rounds: 3 (fresh-eyes, review-agent checklist, fallback mode — no subagent-spawn tool in session). Round 1 found+fixed F2 (deep-merge stale color, P1), F5 (falsy-body parity, P3), C1 (junk-value filter, P2); round 2 found+fixed UTF-16 length parity (P3); round 3: no findings.
- Vitest (server): `test/unit/server/sessions-sync/`+`session-directory/` → 253 green (incl. 1 new sync test, 3 new page tests); `test/integration/server/api-edge-cases.test.ts` → 87 green (legacy route contract).
- Vitest (client): api.test.ts + api.project-colors (new, 4) → 43; sessionsThunks + sessionsThunks.project-colors (new, 3) + sessionsSlice + sidebarSelectors → 136; HistoryView a11y/mobile/color (new, 4) → 8.
- Typecheck (`npm run typecheck`) clean; `npm run lint` 0 errors (touched files warning-clean; 11 pre-existing src warnings unrelated).
- Playwright spec **authored but UNRUN** (deferred posture): `spec-authored-unrun: test/e2e-browser/specs/project-colors-matrix.spec.ts` — registered in `MATRIX_SPECS` (both server kinds; legacy as true parity control). It performs the real History color gesture in context A, asserts the broadcast-driven update in context B (no local action there), checks persisted config bytes, reload + full restart on the same isolated home, and the unrelated project's unchanged swatch.

## Suggested checklist annotation (for the consolidation pass)

> PARTIAL (2026-08-09, df1 `session-05-project-colors` branch): save+broadcast+render implemented on BOTH servers (Rust: new PUT + config store + page embed + write-site `sessions.changed`; legacy: sync-service color-sensitivity fix + page embed; client: page-map overlay + incoming-wins merge). Crate tests x2 green; focused vitest green; matrix spec `project-colors-matrix.spec.ts` authored+registered. MISSING: executed PW-RUST run of that spec (close-out).

## Residual notes for close-out

- The spec is unrun until the close-out campaign (deferred per item posture). It seeds 2 single-file Claude projects; if the Rust sweep cadence matters it polls with Playwright's built-in retrying matchers (20s on the cross-context leg).
- `applySessionsPatch`/`setProjects` legacy reducer paths already honored `color`; untouched.

## Verifier round 1 → fix

The independent verifier re-ran the claimed client batch and found it RED: all 151 tests passed, but the run exited 1 with one unhandled rejection — `No "isApiUnauthorizedError" export is defined on the "@/lib/api" mock` thrown at `sessionsThunks.ts:738` (the `fetchSessionWindow` rejection-taming `.then`) and attributed to `HistoryView.color.test.tsx`. Determination: a mock-completeness defect, not behavior masking — `src/lib/api.ts:112` genuinely exports `isApiUnauthorizedError` (401 type guard) and the production consumption is correct; the three HistoryView component test files (`color`, plus the latent `a11y`/`mobile`) shallow-mocked `@/lib/api` as only `{api:{…}}`, so the color test's pick-a-color gesture (`setProjectColor` → `refresh()` → `fetchSessionWindow`) rejected and the rejection handler then touched the missing export inside a fire-and-forget dispatch chain. Fix commit `9191c030a` ("fix(df1-verifier-1)"): all three HistoryView mocks now spread the real module (pure helpers stay live) while keeping the `api` object fully stubbed and adding benign stubs for `fetchSidebarSessionsSnapshot`/`searchSessions`, matching the `...actual` convention of the `sessionsThunks` test files; the exact verifier red command went green twice consecutively (151/151, exit 0, no Errors) and `npm run typecheck` stayed clean. No `src/`, `rust/`, or `server/` files were touched by this fix, so the previously verified cargo legs carry forward.

## Gate B001 → fix2 (2026-08-09, self-verify posture)

**B001 outcome:** `project-colors-matrix.spec.ts` (authored unrun under the item's `deferred` posture) executed for the first time at the gate: `legacy-chromium` GREEN, `rust-chromium` RED with the 120 s test-timeout — merge rejected. fix2 owned the diagnosis and the close-out runs.

**Reproduction (worktree, pristine spec @ `3776ae558`):** legacy `1 passed (32.6s)`; rust `Test timeout of 120000ms exceeded` — verbatim red reproduced before any change.

**Root cause (evidence-first, classified spec defect — class (a), not a product defect):**

1. An instrumented mirror of the spec (verbose server, per-step timestamps, page console/pageerror capture, preserved isolated home) showed the stall precisely: on the rust leg, context B booted and reached WS `ready` at +2.3 s, then `openHistoryView(pageB)`'s FIRST action — the `button[title="Projects (Ctrl+B P)"]` click (no explicit timeout) — retried for the ENTIRE remaining budget (~178 s). Nothing after ever ran; the 120 s overall timeout fired with the click still pending.
2. A DOM dump of page B at the stall showed the nav button present and visible, but the boot covered by a modal: **"Restore 1 pane from server memory? ‹DANDESKTOP› New Tab: picker"** — the rust-only `RecoveryOfferPanel` (`src/components/RecoveryOfferPanel.tsx`), a `fixed inset-0` z-modal overlay that intercepts every pointer event. The offer's substance: context A's freshly-pushed picker tab, surfaced to fresh context B by the rust server's `GET /api/recovery/inventory` (B3/P1.9): A's tab-registry snapshot predates B's boot cutoff and survives the A15/A16 filters (the 15-min staleness window cannot age out a seconds-old live client). Legacy has NO recovery route — the client's fetch 404s and `RecoveryOfferPanel`'s `.catch` stays quiet — so the identical spec passes on legacy (the parity control), which is why the defect only detonated on rust.
3. Classification: the panel is pre-existing, spec-pinned rust behavior (`recover-my-panes-rust.spec.ts` scenario 3 deliberately pins the over-offer/live-note trade-off), orthogonal to project colors (A is mid-picker, nothing to do with the color channel), and this EXACT e2e failure mode is already documented in-repo at `sidebar-registry-sync-rust.spec.ts:110-131` ("That dialog is a fixed inset-0 ... overlay that intercepts EVERY sidebar click, so ... the test times out (observed on full-suite runs)") with the sanctioned `recovery-decline` idiom. Therefore: fix the spec, not the product.

**What changed (spec only — zero `src/`, `server/`, `crates/` edits):** `test/e2e-browser/specs/project-colors-matrix.spec.ts` gains `declineRecoveryOfferIfMade` + `bootFreshPage` (per this suite's per-spec-ownership copy convention), refining the sidebar-registry idiom for determinism: the `/api/recovery/inventory` response waiter is registered BEFORE the fresh-boot `goto` (the panel fetches once at mount, seconds before the harness/WS waits complete), and the branch is on the OBSERVED wire response, not the server kind — legacy answers 404 (fast skip, no blind panel poll), a rust `recoverable:true` response is followed by a strict panel-visibility assertion (catches the f3wp >10 s slow-render case) before a decisive `recovery-decline` click (`recordDismissal` by content-id + `clearPendingOffer`). Only FIRST boots need it: reloads carry a persisted layout (the D1 gate suppresses the panel), and the post-restart legs reconnect without navigating. Both fresh contexts boot through it.

**Per-leg results (fix2; each run also rebuilds dist + boots an owned server):**

| Run | legacy-chromium | rust-chromium |
|---|---|---|
| 1 | `1 passed (28.8s)` | `1 passed (22.2s)` |
| 2 | `1 passed (25.1s)` | `1 passed (25.3s)` |
| 3 (final head `b1da8ab50`) | `1 passed (34.2s)` | `1 passed (53.0s)` |

3× consecutive green on BOTH projects (≥2 required), the last pair on the exact committed spec. The rust leg now exercises the full SESSION-05 acceptance path end-to-end (real color gesture → cross-context broadcast-only update → config bytes → reload → full server restart on the same home → unrelated project unchanged), closing the item's `spec-authored-unrun` gap: PW-RUST is now EXECUTED, green.

**Cargo:** `cargo test -p freshell-server` — **FULL SUITE GREEN on the final head: 577 passed, 0 failed (+ integration binaries), 5.62 s**, once swarm load on this host subsided (load1 ≈26). Interim full runs during fix2 were repeatedly poisoned by UNRELATED load-driven flakes while the host was saturated (observed load1 13→76 from the parallel swarm): `net_bind::tests::{hundred_rapid_rebinds,serve_on_proves_bind_before_swapping,inflight_connection_survives_rebind}` (loopback probe ECONNRESET under accept-loop starvation), `network::tests::concurrent_configure_and_disable...` (seeded-facts vs re-resolved WSL2-facts lane race → 500/200 flip; the failing lane returns the WSL2 `confirmation-required` body when it passes — proven by a one-run diagnostic print, reverted), plus one-shot `resolve`/`updater`/`settings_store` timing flakes — every one passes in isolation (the network one 6/6 even at load1 ≥47; `hundred_rapid_rebinds` isolated at load1 64 in 17–23 s vs 5 s unloaded), none is in code this branch touches, and fix2 changed no rust at all (spec + this doc only). Typecheck (`npm run typecheck`) clean on the final tree. Client unit batch NOT re-run: fix2 changes no client code (spec file only), so the fix1-verified batch carries forward.
