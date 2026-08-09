# HARNESS-04 — Multi-provider session corpus builder

**Item (verbatim):** *Add a multi-provider session corpus builder. Generate isolated Claude,
Codex, OpenCode, and Amplifier histories, including archived/deleted sessions, summaries,
provider titles, nested git repositories, worktrees, fractional timestamps, and more than one
page of results.*

**Playwright validation (checklist):** *A fixture-only contract parses the corpus
manifest/hashes and optionally opens it through legacy to prove expected semantics; it does
not require Rust multi-provider indexing. It deletes the temporary home and proves the real
home was untouched.*

## Parity source

The corpus is a **data fixture generator**, so its parity sources are the real provider
on-disk layouts plus the real server readers that must consume them (frozen legacy `server/`
on `origin/df1/integration` = base `4c2297667`):

- **Claude**: `server/coding-cli/providers/claude.ts` — root `$CLAUDE_HOME/projects`
  (env honored, `server/claude-home.ts`), glob `projects/**/*.jsonl`; head+tail JSONL parse
  (`session-indexer.ts:readLightweightMeta`/`updateCacheEntry`): cwd/sessionId from
  `system`/`init` line, `createdAt` from first timestamp, `lastActivityAt` from LAST
  timestamped line walking the tail backwards, title from `summary`-line extractor
  (`claude-title.ts`, `titleSource:'provider-generated'`) else first user message
  (`extractUserAuthoredText`→`extractTitleFromMessage`), `summary` from the first
  `summary`/`sessionSummary` field (240-char cap), `isNonInteractive` ⇔ ≤1 user text message,
  `isSubagent` ⇔ path contains `/subagents/` inside `/.claude/` (`isSubagentSession`).
- **Codex**: `providers/codex.ts` — root `$CODEX_HOME/sessions`, glob `sessions/**/*.jsonl`
  (so `~/.codex/archived_sessions/**` is deliberately NOT indexed); `session_meta` record
  supplies `payload.id`/`payload.cwd`; title from first user `response_item`/`message` text.
- **OpenCode**: `providers/opencode.ts` + `opencode-listing-query.ts` — SQLite at
  `$XDG_DATA_HOME/opencode/opencode.db` (fallback `<home>/.local/share/opencode`); listing
  SQL: `WHERE s.time_archived IS NULL AND s.parent_id IS NULL` (provider-archived rows and
  child/subagent rows are never indexed); `project.worktree` → `projectPath`, `s.title` →
  title, `time_created`/`time_updated` integer epoch-ms.
- **Amplifier**: `providers/amplifier.ts` — root `$AMPLIFIER_HOME||<home>/.amplifier`, file
  discovery `projects/**/sessions/**/metadata.json`; `parseAmplifierMetadata`:
  `session_id`/`working_dir`/`created`/`description_updated_at`/`name` (→ title,
  `provider-generated`)/`description` (→ summary); numeric timestamps floored
  (`parseTimestampMs`); recency folds sibling `transcript.jsonl`/`events.jsonl` mtimes
  (`getActivityMtimeMs`) — so corpus files MUST be `utimes`-pinned to the seeded dates.
- **Overrides** (`sessionOverrides` in `$FRESHELL_HOME/.freshell/config.json`,
  `server/freshell-home.ts`): `applyOverride` (`session-indexer.ts:204`) —
  `deleted:true` drops the session entirely; `archived:true` keeps it listed with
  `archived` flag; `titleOverride`/`summaryOverride`/`createdAtOverride` win over provider
  data. Keys: composite `provider:sessionId`.
- **Read model / pagination**: `GET /api/session-directory`
  (`server/sessions-router.ts:94` + `session-directory/service.ts`), limit
  `min(limit ?? 50, 50)` (`shared/read-models.ts MAX_DIRECTORY_PAGE_ITEMS=50`), cursor =
  `(lastActivityAt, key)`; default visibility filters hide subagents / non-interactive /
  untitled-not-running (`includeSubagents`/`includeNonInteractive`/`includeEmpty` toggles
  sent as `=1` strings, per `src/lib/api.ts:347`); archived items sort AFTER non-archived
  (`projection.ts:compareSessionDirectoryComparableItems`).
- **Git root resolution**: `server/coding-cli/utils.ts` — innermost valid `.git` **dir**
  wins for nested repos ("valid" = contains a `HEAD` file); `.git` **file** + `gitdir:` to
  `.../.git/worktrees/<name>` + `commondir` `../..` ⇒ repo root = parent repo
  (`resolveGitRepoRoot`, worktrees collapse), checkout root = the worktree dir
  (`resolveGitCheckoutRoot`). Same hand-written fixture shapes as
  `test/unit/server/coding-cli/resolve-git-root.test.ts` (no real `git` binary needed).

## Gap (today)

Everything is ad hoc: `session-directory-matrix.spec.ts` seeds 2 Claude + 1 Codex + 1
OpenCode + 1 Amplifier session inline; `perf/seed-server-home.ts` is a perf seeder, not a
verity fixture. No shared builder, no manifest, no hashes, no archived/deleted coverage, no
git-layout coverage, no pagination-scale corpus, no real-home-untouched proof for provider
homes. Later `SESSION-*` items need this corpus; this item delivers it as harness
capability.

## Architecture

New, item-scoped, additive-only modules (zero edits to existing helper files; one additive
regex line in `playwright.config.ts` MATRIX_SPECS at the end):

```
test/e2e-browser/helpers/session-corpus/
  index.ts      — public API: buildSessionCorpus(), types, marker helpers
  manifest.ts   — CorpusManifest types, sha256 writer/reader, coverage walk, disk round-trip
  claude.ts     — Claude JSONL writer (bulk + specials), real Claude slug encoding
  codex.ts      — Codex rollout writer (sessions/YYYY/MM/DD/… + archived_sessions/…)
  opencode.ts   — OpenCode opencode.db writer (node:sqlite, project/session rows)
  amplifier.ts  — Amplifier metadata.json + transcript/events sidecars (+utimes pinning)
  git-layout.ts — hand-written .git dir/file/commondir fixtures (nested repo, worktree)
  session-corpus.test.ts — Vitest unit tests (helpers vitest config includes helpers/**/*.test.ts)
test/e2e-browser/specs/harness-04-session-corpus.spec.ts — the Playwright contract spec
docs/plans/df1-evidence/HARNESS-04.md — evidence (final)
```

**Two Playwright legs** (per the validation text), one spec file:
1. **Fixture-only contract** (no server): build into an isolated `os.tmpdir()` home →
   re-parse `manifest.json` FROM DISK → recompute every file hash → assert manifest/disk
   equality + coverage (every file under the four provider roots + `.freshell/config.json`
   is hashed) + inventory semantics (counts, pagination math) → delete the temp home →
   assert gone + real-home tripwires.
2. **Legacy-open leg**: boot a worker-scoped **legacy** `TestServer`
   (`createE2eServerHandle(..., { kind: 'legacy', construct: { setupHome: buildSessionCorpus } })`)
   → drive `GET /api/session-directory` through `page.request` (a Playwright-owned call,
   valid per the checklist's "Validation shorthand") plus one real browser sidebar load →
   traverse BOTH pages via `nextCursor`; assert identities/titles/summaries/cwd/projectPath/
   checkoutPath/archived/fractional-ordering vs the manifest; assert the
   deleted/provider-archived set is absent on every page; assert default-hidden set appears
   only under the documented `=1` toggles. Corpus intentionally boots the same leg under
   both matrix projects (validation text only promises "opens it through legacy"; Rust
   multi-provider indexing of this corpus belongs to later SESSION-* items).

**Tripwire design** (real-home untouched, attributable on a live host): every corpus path,
session id, and title embeds a per-run marker `h04corpus-<runToken>`. Post-teardown the spec
asserts: no child of the REAL `~/.claude/projects`, `~/.codex`, `~/.amplifier`,
`~/.local/share/opencode` names contains the marker; the real `~/.freshell/config.json` (if
present) does not contain it; plus the HARNESS-01 idiom (dir absent-before ⇒ absent-after;
pre-existing ⇒ positive-isolation note).

**Sort/pagination determinism**: ALL `lastActivityAt` values are fixed past instants
(2026-07 / 2026-08), unique across the corpus, and **archived-override sessions carry the
oldest timestamps** so the archived-last comparator order equals natural time order — the
(lastActivityAt, key) cursor then traverses stably across the archived boundary.

## Global constraints

- ESM + `.js` extension relative imports (repo NodeNext rule) — helpers are imported by
  Playwright (tsx-compiled) and Vitest helpers config.
- No writes outside the corpus home; no git-config mutation; no real `git` requirement.
- Opencode DB via `node:sqlite` (`DatabaseSync`) — same as the production reader.
- No edits to sibling-owned files; MATRIX_SPECS edit is the single additive shared-file line.
- Corpus is deterministic GIVEN a homeDir/runToken (fixed timestamps, fixed content);
  hashes are recorded per-build because content embeds absolute home paths.

## Corpus inventory (all timestamps fixed; `<R>` = runToken; N=52 bulk)

| role | provider | where | title/summary source | expect |
|---|---|---|---|---|
| bulk-001…052 | claude | `projects/bulk-p<i%8>` slugs, `<home>/h04corpus-<R>/projects/bulk-p<i%8>` cwds | summary line = title+summary | listed, >1 page |
| alpha | claude | dir `corpus-alpha-project` | summary line | listed, provider title + summary |
| frac-100/200/300 | claude | one dir | last lines `.100/.200/.300Z` same second | listed, exact `.300<.200<.100` ms order |
| worktree | claude | cwd `<R>/repos/wt-session` (worktree of `main-repo`) | summary line | projectPath = main-repo root; checkoutPath = wt-session |
| nested-repo | claude | cwd `outer-repo/inner-repo` (own `.git`) | summary line | projectPath = inner-repo |
| repo-subdir | claude | cwd `outer-repo/src/pkg` | summary line | projectPath = outer-repo |
| archived-claude | claude | plain dir, oldest ts | summary + override `archived:true` | listed, `archived:true`, tail |
| deleted-claude | claude | plain dir | override `deleted:true` | ABSENT everywhere |
| subagent | claude | `…/<parentSessionId>/subagents/agent-*.jsonl` (real per-session-dir layout) | first-message title | hidden by default; visible w/ includeSubagents=1 |
| noninteractive | claude | plain dir, ONE user message | first-message title | hidden by default; visible w/ includeNonInteractive=1 |
| untitled-empty | claude | init line only | none | hidden by default; visible w/ includeEmpty=1 + includeNonInteractive=1 |
| gamma | codex | `sessions/2026/08/03/rollout-….jsonl` | first user message | listed |
| archived-codex | codex | sessions/…, oldest ts | first msg + override archived | listed archived tail |
| deleted-codex | codex | sessions/… | override deleted | ABSENT |
| provider-archived-codex | codex | `archived_sessions/2026/08/02/rollout-…` | first msg | ABSENT (glob never covers it) |
| codex-exec | codex | sessions/…, `source:'exec'` | first msg | hidden by default; visible w/ includeNonInteractive=1 |
| delta | opencode | `project`+`session` rows | row `title` (provider title) | listed |
| echo | opencode | 2nd row | row title + `titleOverride`/`summaryOverride` | listed, overrides win |
| archived-opencode-override | opencode | oldest ts | override archived | listed archived tail |
| provider-archived-opencode | opencode | `time_archived` set | row title | ABSENT (SQL filter) |
| child-opencode | opencode | `parent_id=delta` | row title | ABSENT (root filter) |
| deleted-opencode | opencode | row | override deleted | ABSENT |
| epsilon | amplifier | `metadata.json`+sidecars, utimes-pinned | `name`→title, `description`→summary; `created`=fractional number floored | listed, exact floored ts |
| archived-amplifier | amplifier | oldest ts | name + override archived | listed archived tail |
| deleted-amplifier | amplifier | dir | override deleted | ABSENT |

Listed total = 52+1+3+3+1 (claude) + 2 (codex) + 3 (opencode) + 2 (amplifier) = **67** →
page 1 = 50, page 2 = 17 at limit 50. Marked-absent = 7; default-hidden = 4 (claude subagent,
claude noninteractive, claude init-only/untitled-empty, codex exec).

Config seeded at `<home>/.freshell/config.json`: `version:1`, minimal settings incl.
`codingCli.enabledProviders: [claude, codex, opencode, amplifier]` (TestServer merges its
network block into it after `setupHome`), `sessionOverrides` with the archived/deleted/
rename entries above.

## Manifest (`<home>/.freshell-corpus/manifest.json`, `formatVersion: 1`)

`{ formatVersion, runId, generatedAt, homeDir, providers, roots: {…5 provider/config roots…},
files: [{ path(rel), sha256, bytes, role }],  // every hashed file; manifest.json excluded,
// git-fixture internals hashed too EXCEPT they are asserted structurally instead (see below)
sessions: [{ key, provider, sessionId, title?, summary?, projectPath, checkoutPath?, cwd,
createdAt, lastActivityAt, archived, visibility: 'listed'|'absent'|'hidden-default',
visibleWith?, role, sourceFiles:[rels] }],
gitFixtures: [{ kind:'nested-repo'|'worktree', path(rel), expectedProjectPath,
expectedCheckoutPath? }], pagination: { listedCount: 67, pageLimit: 50, expectedPages: 2 } }`

Coverage invariant: walking the home, every regular file is either in `files` (hashed) or
an explicitly-excluded `.git`-fixture-internal path (recorded under `gitFixtures[].
internalFiles`, unhashed, structurally asserted). Manifest parse = JSON + total-order
validation (`loadSessionCorpusManifest` throws on shape violations).

## Load-bearing ledger

| # | Assumption (falsifiable) | Cost if wrong | Method | Status |
|---|---|---|---|---|
| L1 | Hand-written `.git` dir (HEAD file only) + `gitdir:`+`commondir` files satisfy `resolveGitRepoRoot/resolveGitCheckoutRoot` per corpus expectations | High (git layouts shape projectPath/checkoutPath assertions) | run code (npx tsx probe against `server/coding-cli/utils.ts`) — fallback inspect unit test ids | VERIFIED 2026-08-09 (tsx probe: inner/subdir/worktree-repo/worktree-checkout/plain all resolve as designed) |
| L2 | Legacy server at this tip registers all four providers incl. amplifier | High | inspect (`server/index.ts:239` — done: claude/codex/opencode/amplifier all registered; amplifier files exist on this branch) | VERIFIED |
| L3 | `GET /api/session-directory` limit/cursor/visibility filters/archived-last semantics as read | Medium | inspect (service.ts/projection.ts/read-models — done) + runtime assert in spec | VERIFIED (runtime re-proof in leg 2) |
| L4 | TestServer preserves corpus `config.json` content (incl. `sessionOverrides`) and only merges `version`/`settings.network` | High (overrides drive archived/deleted) | inspect (`ensureSetupWizardBypassConfig` — done: spreads existing) + runtime assert | VERIFIED (runtime re-proof in leg 2) |
| L5 | `$CLAUDE_HOME`/`$CODEX_HOME`/`$XDG_DATA_HOME`/`$AMPLIFIER_HOME`/`$FRESHELL_HOME` env isolation reaches each provider reader | High (leak = real-home write) | inspect (claude-home.ts, codex.ts:26, amplifier.ts:14, opencode data home, freshell-home.ts, test-server.ts applyAppDataIsolation — done) + tripwire runtime proof | VERIFIED (runtime re-proof via tripwire) |
| L6 | `z.coerce.boolean()` treats query string `'1'` as true; omitted = filters on | Low | inspect (api.ts uses `'1'` idiom; zod semantics) | VERIFIED (probed 2026-08-09: '1'/'true'→true, ANY nonempty string incl 'false'→true ⇒ spec only ever passes '=1' or omits) |
| L7 | `node:sqlite` DatabaseSync works under repo Node/Vitest/Playwright | Medium | run (`node --version`; production reader already uses it; matrix spec seeds via it) | VERIFIED (probed 2026-08-09, Node 22.21.1) |
| L8 | Codex archived rollouts live in `~/.codex/archived_sessions/…` and are NOT globbed | Low | inspect (glob = `sessions/**/*` — done; rust has no archived_sessions reader either) | VERIFIED |
| L9 | Amplifier recency folds sidecar mtimes → corpus must utimes-pin or seed-time "now" dominates | Medium (time bomb class already documented in matrix spec) | inspect (getActivityMtimeMs — done; matrix-spec DEFLAKE note) | VERIFIED |
| L10 | Claude summary line yields BOTH `title` (provider-generated) and `summary` wire fields exactly as seeded | Medium | inspect (claude-title.ts + parse — done) + runtime assert | VERIFIED (re-proved leg 2) |
| L11 | `os.tmpdir()` corpus homes never walk up into a repo `.git` (bulk cwds under home keep projectPath = cwd) | Medium | inspect (tmpdir has no `.git` ancestors) + unit assert | VERIFIED |

## Tasks (TDD; commit each)

### Task 1 — Manifest + hashing core
- Create `manifest.ts` (types, `sha256File`, `writeManifest`, `loadSessionCorpusManifest`
  disk round-trip + validation, coverage walker) and a focused unit test.
- RED: test imports missing module. GREEN: implement. Commit.

### Task 2 — Claude writer
- `claude.ts`: `writeClaudeCorpus(homeDir, ctx)` — slug encoding (`[^a-zA-Z0-9]`→`-`),
  session JSONL builder (init/user/assistant/summary, parentUuid chain, exact fractional
  ISO timestamps), bulk generator, subagents path, one-message + init-only variants.
  Unit tests: line-shapes parse, summary last-without-ts, slug tokens embed marker,
  expected timestamps recoverable by the server's head/tail algorithm (assert last
  timestamped line = seed intent).
- RED→GREEN→commit.

### Task 3 — Codex writer
- `codex.ts`: rollout writer with date-dir layout `sessions/2026/08/03/rollout-<ts>-<id>.jsonl`,
  `session_meta`(id/cwd)+user/assistant `response_item` records; archived variant under
  `archived_sessions/…`. Tests: shapes, ABSENT root separation.

### Task 4 — OpenCode writer
- `opencode.ts`: create `opencode.db` (project/session tables), rows incl. archived/child/
  deleted-target + project worktrees; `mtime`-free (integer ms columns). Test reads back
  with the SAME SQL filter as `opencode-listing-query.ts` (import the real query? No —
  assert via `runOpencodeListingQuery`? that file is prod-side; the corpus test may import
  from `server/` — path alias `@test`? helpers vitest has `@/` → src; use relative import
  `../../../../server/coding-cli/providers/opencode-listing-query.js` — verify it loads in
  vitest (ESM NodeNext). Fallback: re-implement the SELECT in the test.)

### Task 5 — Amplifier writer
- `amplifier.ts`: metadata.json/transcript.jsonl/events.jsonl; fractional numeric
  `created`; utimes-pin all files to seeded activity instant (L9). Tests: metadata shape,
  floored expectation values in manifest, mtime pins.

### Task 6 — Git layouts
- `git-layout.ts`: `makePlainDir`, `makeNestedGitRepos` (outer+inner `.git` dirs with HEAD),
  `makeWorktree` (main `.git` + `worktrees/<n>/commondir` + checkout `.git` file) — shapes
  copied from `resolve-git-root.test.ts`. Test asserts. **Validates L1**: additionally a
  vitest case importing the real `server/coding-cli/utils.ts` resolvers against the corpus
  fixtures (repo vitest default config includes test/unit only; helpers config may import
  server files via relative path — verify; else a one-off tsx probe in the audit phase).

### Task 7 — Orchestrator + manifest emission
- `index.ts`: `buildSessionCorpus(homeDir, opts?)` runs all writers, collects
  per-session expectations, hashes every file (sha256, incl. bulk, db, config.json),
  writes `.freshell/config.json` (settings + sessionOverrides), emits manifest; markers.
  Tests: inventory counts (67/7/3), pagination math, coverage invariant, marker embedding,
  manifest disk round-trip equals returned object.

### Task 8 — Contract leg A + MATRIX_SPECS registration
- `specs/harness-04-session-corpus.spec.ts` leg A (fixture-only, no server fixtures):
  full contract + teardown + real-home tripwires. Register
  `/harness-04-session-corpus\.spec\.ts$/` in MATRIX_SPECS (additive comment line).
- GREEN: `npx playwright test --project=legacy-chromium --project=rust-chromium specs/harness-04…` (pw lease).

### Task 9 — Legacy-open leg B + sidebar spot-check leg C
- Worker-scoped legacy TestServer with corpus home. Poll `GET /api/session-directory`
  (`priority=visible&limit=50`) until `listedCount` items (indexer readiness), traverse
  page 1 + page 2 via nextCursor; assert: union == manifest listed keys exactly once each;
  identity fields per headline session (title/summary/projectPath/checkoutPath/cwd/
  lastActivityAt exact); archived-override 4 at tail with `archived:true`; absent set never
  appears; frac trio exact order; hidden-default set: absent by default, present with the
  matching `=1` toggles (subagent / non-interactive / empty pair). Leg C: `freshellPage`
  sidebar shows alpha/gamma/delta/epsilon titles (opens the corpus through the real UI).
- GREEN ×2 consecutive on both matrix projects (pw lease). Commit.

### Task 10 — Evidence
- `docs/plans/df1-evidence/HARNESS-04.md`: item text, parity source, exact green commands
  + outputs (run SHAs), design decisions, review-loop log. Commit.

## Acceptance evidence (exact)

- `npm run test:e2e:helpers -- session-corpus` green (builder unit tests).
- `npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium --project=rust-chromium specs/harness-04-session-corpus.spec.ts` green **twice consecutively** on `origin/df1/integration` + this branch's tip.
- Typecheck of touched TS (`npx tsc --noEmit -p config/tsconfig/…` scoped) clean; eslint
  clean on new files.
- DoD extra (dispatch): ≥2 consecutive green runs on relevant projects; evidence file at
  `docs/plans/df1-evidence/HARNESS-04.md`; review loop (fresh subagent/round) clean.
