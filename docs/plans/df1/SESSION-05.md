# SESSION-05 — Implement project colors

> **For agentic workers:** df1 swarm worker document. TDD red-green-refactor per task; commit at every task boundary. Playwright posture for this item is `deferred` (spec authored but unrun).

## Goal

Save, broadcast, and render the legacy project-color treatment on History project headers — on the **Rust server** (parity target) — choosing a color in one browser immediately colors the project header swatch in every browser, survives reload/restart, and never disturbs unrelated projects' colors.

**Parity source:** frozen `server/` + `shared/` + `src/` at `origin/df1/integration` (= `origin/main` 4c2297667). The client is SHARED by both servers, so both the legacy Node server and the Rust server must grow the same additive data channel; the acceptance spec runs both legs of the existing matrix.

**Acceptance evidence (definition of done for `deferred` posture):**
1. Behavior implemented on Rust (save → broadcast → render path) with the legacy additive channel documented.
2. Focused tests green: new Rust crate tests (route, settings-store, session-directory page) + new/green vitest files for the touched Node/server + client units.
3. Playwright spec `test/e2e-browser/specs/project-colors-matrix.spec.ts` authored per the matrix convention and registered in `MATRIX_SPECS` (unrun — status note marked `spec-authored-unrun`).
4. Review loop (≤5 fresh rounds) reports no serious findings.
5. Evidence file `docs/plans/df1-evidence/SESSION-05.md` written in checklist annotation style.

## Current-state findings (verified by reading code at the base SHA)

1. **Save (legacy):** `PUT /api/project-colors` exists (`server/project-colors-router.ts`): zod `{projectPath: string.min(1).max(1024), color: string.min(1).max(64)}` → `configStore.setProjectColor` → `codingCliIndexer.refresh()` → `{ok:true}`. Config key: top-level `projectColors: Record<string,string>` in `~/.freshell/config.json`. **Rust: no route, no store methods** — `settings_store.rs::persist` only preserves the `projectColors` key pass-through (`settings_store.rs:513`).
2. **Broadcast (legacy):** `refresh()` → `commitProjects` → `SessionsSyncService.publish` → `hasSessionDirectorySnapshotChange` (`server/session-directory/projection.ts`) — **color-blind**: `comparableItemsEqual` compares no color field, so a color-only change emits NO broadcast today. (The color-sensitive `diffProjects` in `sessions-sync/diff.ts` only feeds `emitUpdate`, which feeds the same blind publish.)
3. **Render (client):** `HistoryView.tsx` renders `project.color ?? '#6b7280'` as the header swatch and offers the expanded "Color:" picker row which PUTs then refreshes. BUT the only acquisition channel — `api.ts groupDirectoryItemsAsProjects` — **builds groups with no `color` at all**, and `SessionDirectoryPageSchema` (`shared/read-models.ts:62`) has no color field. So `project.color` is never populated; the feature is fully severed data-wise on main, for BOTH servers.
4. **Client commits:** `normalizeProjects` (sessionsSlice) already preserves `color` when present in a payload; `mergeProjects` (sessionsThunks:172) adopts color only additively (`if (project.color && !current.color)`) — insufficient for cross-context color CHANGE propagation (must become incoming-wins).
5. **Client refresh trigger:** `App.tsx:1142` `sessions.changed` listener → `queueActiveSessionWindowRefresh()` re-fetches the active surface's window (History view activates surface `history`). So: PUT → broadcast `sessions.changed` → refetch → colored page payload → render.

## Design (chosen channel)

Add an **optional page-level `projectColors: Record<string,string>`** field to `SessionDirectoryPage` — the exact payload the client re-fetches after every `sessions.changed`. Backward compatible in both directions (verified by running zod 4.3.6: unknown keys are stripped silently, so old server → new client and new server → old client both keep working).

- **Shared schema** (`shared/read-models.ts`): `projectColors: z.record(z.string(), z.string()).optional()` added to `SessionDirectoryPageSchema`.
- **Legacy Node** (`server/session-directory/service.ts`): page gains `projectColors` (only when non-empty), collected from `input.projects[*].color` — those already carry config colors because `performRefresh` reads `configStore.getProjectColors()`. PLUS the deliberate bug fix: `hasSessionDirectorySnapshotChange` (`projection.ts`) additionally compares the sorted `(projectPath → color)` map, restoring broadcast reactivity for color-only changes (documented deliberate fix — required by the item's "broadcast" clause; additive, no behavioral regression: it can only cause a broadcast where a real visible change exists).
- **Rust** (`crates/freshell-server/src/`):
  - `settings_store.rs`: in-memory `project_colors` + dirty-set, loaded at boot, adopt-from-disk merged in `persist()` (same `overlay_dirty_keys` discipline as overrides — sibling writes survive), reader `project_colors()` (same `maybe_reload_overrides` mtime freshness, extended), writer `set_project_color(path, color) -> io::Result<()>`.
  - New `project_colors.rs` router: `PUT /api/project-colors` mirroring `project-colors-router.ts` — auth via `is_authed`; validation 400 body `{error:'Invalid request', details:[…]}` with issue shapes consistent with the existing port validators (`sessions.rs::validate_session_patch` style; shape-consistent, not claimed byte-exact — same stance as the rest of the port); on success persist → direct `sessions.changed` broadcast with bumped shared revision (exactly the `sessions::patch_session` pattern; the Rust sweep is structurally blind to config-only changes by design) → `{ok:true}`. Persist failure → 500 (legacy express-4 has no async error wrapper — a save failure is process-undefined there; surfacing 500 is a documented deliberate hardening, response shape mirrors other port routes).
  - `session_directory.rs`: page assembly attaches `projectColors` from `state.settings.project_colors()` when non-empty.
- **Client** (`src/`): `ReadModelSessionDirectoryPage` + `SearchResponse` gain optional `projectColors`; `groupDirectoryItemsAsProjects(items, projectColors?)` and `searchResultsToProjects(results, projectColors?)` overlay color onto groups; `mergeProjects` in `sessionsThunks` becomes LATER-FETCHED-color-wins via an explicit `preferColorsFrom` option (default 'incoming' for append/search pagination; the deep-window silent-refresh merge — which passes its fresh page as the `existing` arg — passes 'existing') so cross-context recolors always follow the freshest page. (Verified by grep: no `combineSessionPageResults`/`combineProjectGroups` exists; the real join points are `mergeProjects`, `searchResultsToProjects`, and slice `normalizeProjects`, which already honors `color`.) No rendering-code change needed — the legacy treatment (swatch + picker) already exists and consumes `project.color`.

`max(projectColors)` values: only projects present in the fetched page get colors overlaid; colors are never REMOVED by the UI (no clear action exists in legacy), matching legacy semantics.

## Global constraints

- Work only in `.worktrees/df1-session-05-project-colors`; commit locally with explicit pathspecs; no pushes/PRs.
- `nice -n 19` (+ `ionice -c3` where available) on every build/test; cargo lane lease for cargo builds/tests; NEVER Playwright (deferred; spec authored unrun; pw lease never requested).
- Focused tests only: `cargo test -p freshell-server …`, `npm run test:vitest -- run <specific files>`; never `npm test`/`npm run check` un-scoped.
- Never edit `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`; annotations go to `docs/plans/df1-evidence/SESSION-05.md`.
- Server route nets: NodeNext/ESM `.js` extensions in `server/` imports; axum/NodeNext conventions per existing port modules; legacy behavior changes are additive-only, each documented in the evidence file.
- A11y: HistoryView's existing swatch/picker markup already carries aria-labels (`Open color picker`, `Project color picker`) — no regression allowed.

## File structure

| File | Change |
|---|---|
| `crates/freshell-server/src/settings_store.rs` | project_colors load/merge/persist + reader + `set_project_color` |
| `crates/freshell-server/src/project_colors.rs` | NEW: PUT route + validation + broadcast + tests |
| `crates/freshell-server/src/main.rs` | merge new router |
| `crates/freshell-server/src/session_directory.rs` | attach `projectColors` to page; tests |
| `server/session-directory/projection.ts` | color-sensitive snapshot diff |
| `server/session-directory/service.ts` | page `projectColors` assembly |
| `shared/read-models.ts` | page schema optional field |
| `src/lib/api.ts` | types + `groupDirectoryItemsAsProjects` overlay |
| `src/store/sessionsThunks.ts` | `combineSessionPageResults` + `mergeProjects` incoming-wins; `searchResultsToProjects` overlay + `buildSearchPayload` threading |
| `test/unit/server/session-directory/projection.test.ts` | color-only diff test |
| `test/unit/server/sessions-sync/service.test.ts` | color-only publish → broadcast test |
| `test/unit/server/session-directory/service.test.ts` | page includes projectColors |
| `test/unit/client/lib/api.projectcolors.test.ts` (new) | client grouping overlay |
| `test/unit/client/store/sessions-thunks.combine.test.ts` (new) | combine/merge incoming-wins |
| `test/unit/client/components/HistoryView.color.test.tsx` (new) | render treatment (swatch + picker aria) |
| `test/e2e-browser/specs/project-colors-matrix.spec.ts` (new) | deferred acceptance spec |
| `test/e2e-browser/playwright.config.ts` | one-line MATRIX_SPECS registration |
| `docs/plans/df1-evidence/SESSION-05.md` | evidence annotation |

## Load-bearing audit ledger

| # | Assumption (falsifiable) | Method | Result |
|---|---|---|---|
| A1 | Legacy PUT contract: route, schema limits, 400 `{error:'Invalid request',details}` shape, `{ok:true}` success | inspect `server/project-colors-router.ts` + `test/integration/server/api-edge-cases.test.ts` | VERIFIED (missing/null/empty → 400 + defined details; route exists) |
| A2 | Client never receives colors today: page schema has no field; `groupDirectoryItemsAsProjects` never emits `color` | inspect `shared/read-models.ts:62`, `src/lib/api.ts:601`; run-code spot check | VERIFIED |
| A3 | Optional page field is wire-compatible both ways (zod strips unknown keys, no strict error) | run code: node + zod 4.3.6 | VERIFIED (`Page.parse({items:[],nextCursor:null,projectColors:{…}})` → ok, key stripped) |
| A4 | `sessions.changed` → client refetches active window incl. `history` surface | inspect `App.tsx:1142-1151`, `sessionsThunks.queueActiveSessionWindowRefresh`, `HistoryView.activateSessionSurface('history')` | VERIFIED |
| A5 | Legacy broadcast is color-blind TODAY (save works, no push on color-only change) | inspect `projection.ts comparableItemsEqual` (no color), `sessions-sync/service.ts:53` single differ | VERIFIED — hence the deliberate legacy fix |
| A6 | Indexer attaches color to groups on refresh (`buildProjectGroups` spreads `colors[path]`) and `performRefresh` re-reads colors after the PUT's awaited save | inspect `session-indexer.ts:1204, 1415-1416` | VERIFIED (PUT awaits `setProjectColor` before `refresh()`) |
| A7 | Rust sweep is structurally blind to config-only change → PUT must broadcast directly at the write site, sharing `sessions_revision` | inspect `main.rs:2033-2068` KNOWN GAPS + `sessions.rs` GAP-1 pattern | VERIFIED |
| A8 | Rust `SettingsStore.persist` preserves unknown top-level keys and seeds `projectColors:{}` only-if-absent; dirty-key overlay discipline exists | inspect `settings_store.rs:432-520` (`overlay_dirty_keys`, line-513 comment) | VERIFIED |
| A9 | Matrix spec registration = one regex line in `MATRIX_SPECS`; two-context scenes reuse `browser.newContext()`; restart legs use `handle.restart()` | inspect `test/e2e-browser/playwright.config.ts`, `multi-client.spec.ts`, `restore-matrix.spec.ts` usage | VERIFIED |
| A10 | `<input type=color>` programmatic set must use native-setter + `input` event (React onChange) in the spec gesture | inspect `HistoryView.tsx:296-310` (onChange PUTs and closes picker) | VERIFIED from code; spec uses native-setter technique |
| A11 | No other Rust crate consumes the page JSON (no serde-typed page struct to extend) | grep `nextCursor` across `crates/` | VERIFIED (`freshell-server/src/session_directory.rs` only; protocol crate untouched) |

## Tasks (each red → green → commit)

### Task 1: Rust SettingsStore `projectColors` support
- Write failing tests in `settings_store.rs` `#[cfg(test)]` (or its existing test module file): load sees seeded `projectColors`; `project_colors()` returns the map; `set_project_color('/a','#ff0000')` persists to disk and rounds-trip through a fresh `load`; unrelated keys (sessionOverrides, unknown top-level) survive; external disk write to a not-touched color key is adopted; dirty key wins over concurrent disk value.
- Implement: `load_project_colors`, fields + init, extend `maybe_reload_overrides`, extend `persist` (adopt-from-disk overlay; seed `{}` iff absent), `project_colors()`, `set_project_color()` returning `io::Result<()>`.
- Green: `cargo test -p freshell-server settings_store` (scoped names).

### Task 2: Rust `PUT /api/project-colors` route + broadcast
- Failing route tests in new `project_colors.rs`: unauth → 401; `{}`/missing/null/empty/`>1024`-path/`>64`-color → 400 with `{error:'Invalid request',details:[…]}`; happy → 200 `{ok:true}` + config on disk contains the color, an unrelated pre-existing color key is preserved; broadcast rx receives `sessions.changed` with monotonically increasing revision; second PUT different path keeps both.
- Implement router + `main.rs` merge. Green: `cargo test -p freshell-server project_colors`.

### Task 3: Rust session-directory page carries `projectColors`
- Failing test: seeded config colors + indexed session → response page JSON has `projectColors[path] === color`; empty map → key absent.
- Implement page attach in `session_directory.rs`. Green: `cargo test -p freshell-server session_directory`.

### Task 4: Legacy broadcast reactivity fix (documented deliberate fix)
- Failing: `projection.test.ts` — `hasSessionDirectorySnapshotChange` returns `true` on color-only project diff; `service.test.ts` (sessions-sync) — `publish` with color-only diff calls `broadcastSessionsChanged`.
- Implement color-map compare in `projection.ts`. Green vitest on both files.

### Task 5: Legacy page assembly + shared schema
- Failing: `service.test.ts` (session-directory) — `querySessionDirectory` page includes `projectColors` when a project has a color; absent otherwise.
- Implement service assembly + `shared/read-models.ts` schema field. Green vitest; also `typecheck` scoped check.

### Task 6: Client overlay + merge semantics
- Failing client tests: `api.projectcolors.test.ts` (group builder overlays colors from page map), `sessions-thunks.combine.test.ts` (`combineSessionPageResults`/`mergeProjects` incoming-color-wins).
- Implement api.ts/thunks threading incl. search path. Green vitest on touched files.

### Task 7: Render-treatment unit proof
- `HistoryView.color.test.tsx`: renders swatch with the project color; picker button aria-labels present; PUT issued on change (mock api). (Expected green immediately against existing render code — this pins the "render" clause.) Green vitest.

### Task 8: Deferred Playwright spec (authored, unrun)
- `project-colors-matrix.spec.ts`: seed 2 projects × sessions; ctx A gesture (Projects view → expand → picker → set `#e11d48` via native-setter + input event) → swatch updates; ctx B (same server) swatch updates without local action (broadcast); reload + `handle.restart()` same home → persistence (config.json on disk + swatch still colored); sibling project swatch unchanged (`rgb(107, 114, 128)`). Register regex in `MATRIX_SPECS`. NOT RUN.

### Task 9: Evidence + status
- Write `docs/plans/df1-evidence/SESSION-05.md` (annotation style: what landed, deliberate legacy fixes documented, deferred-spec path, remaining close-out work). Final status update with `spec-authored-unrun` note.
