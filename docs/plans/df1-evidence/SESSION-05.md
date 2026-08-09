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
