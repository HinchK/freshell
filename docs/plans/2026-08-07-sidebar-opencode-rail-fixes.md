# Sidebar OpenCode Rail Fixes Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix two root-caused sidebar (rail) bugs for OpenCode sessions: (1) live opencode terminals targeting subagent/child sessions no longer clutter the rail as permanent raw-command entries — they are classified as subagents and respect the existing `showSubagents` visibility filter; (2) sessions in OpenCode's catch-all `global` project (`worktree='/'`) display their real directory instead of literal `/`.

**Architecture:** Bug 2 is a mechanical guard in both servers' opencode parsers: treat `'/'` (and empty) worktree as absent so the existing cwd fallback fires. Bug 1 flows a new server-computed classification to the client: whenever a terminal acquires (or changes) its resume-target `ses_` id, the server runs a one-row `SELECT parent_id FROM session WHERE id = ?` against opencode.db and exposes an additive, optional `resumeTargetIsSubagent: true` field on the per-terminal record (`/api/terminals`, `terminal.inventory`); the Rust server additionally marks its server-fabricated live-terminal session-directory item's existing `isSubagent` field. Classification runs at every hook point where a resume target is acquired or changes: Node — `terminal.create` plus `bindSession` re-classification; Rust — four hook sites: WS create, auto-resume respawn, the signal rebind lane, and the REST/fresh-agent binder. The client hides BOTH rail-entry variants it can mint from the flag: manufactured `terminal:<id>` rows AND tab/pane-derived fallback rows (the latter via the `runningSessionMap` consult in `pushFallbackItem`) — both feed `SidebarSessionItem.isSubagent`, which the existing `showSubagents` filter (default `false`) already hides. The by-design refusal to *bind* terminals to subagent rows is untouched.

**Tech Stack:** Node/TypeScript server (`server/`, NodeNext ESM, `node:sqlite`), Rust workspace (`crates/`, rusqlite/axum/tokio), React+Redux client (`src/`), Vitest (coordinated), cargo test, Playwright (`test/e2e-browser/`).

## Global Constraints

- Work ONLY in the worktree `/home/dan/code/freshell/.worktrees/sidebar-opencode-rail-fixes` (branch `fix/sidebar-opencode-rail-fixes`). All commands below run from that directory.
- Red-Green-Refactor TDD for every task; never skip the failing-test step. Unit AND e2e coverage (per AGENTS.md).
- **NEVER restart the live self-hosted Rust server** (port 3001 per main AGENTS.md; the worktree copy says 3002 — treat BOTH as live) without the literal word "APPROVED" from the user. `cargo build` / `cargo test` are always safe. Do not deploy anything in this plan.
- Node server is NodeNext ESM: relative imports in `server/` MUST carry `.js` extensions.
- Vitest runs go through the coordinator: `npm run test:vitest -- run <files> --config <config>`. NEVER raw `npx vitest`. Server tests use `config/vitest/vitest.server.config.ts`; client tests use `config/vitest/vitest.config.ts`.
- Rust: `cargo test -p <crate>` from the worktree root; `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check` must stay green (CI gates).
- **Do NOT weaken the by-design refusal to bind terminals to subagent rows**: the `AND s.parent_id IS NULL` filters in `server/coding-cli/providers/opencode-listing-query.ts:44` and `crates/freshell-sessions/src/parse/opencode.rs:146-150` stay exactly as they are. Child sessions stay OUT of listings.
- New wire fields are additive + optional + server→client only: NO `WS_PROTOCOL_VERSION` bump (precedent: `shared/ws-protocol.ts:876-884`; `crates/freshell-protocol/src/server_messages.rs:1099-1102`).
- Real user-started (root) opencode sessions must keep appearing in the rail — every task's tests include a root-session control case.
- Commit after every task (conventional commits, focused and atomic).

## Non-Goals (explicit scoping decisions, not omissions)

- **No Rust `TerminalTitleUpdated` emitter.** The spec's root cause notes the Rust server never emits `terminal.title.updated` (Node does at `server/index.ts:906-978`). That gap *aggravated* Bug 1 by locking raw-command titles in, but it is not needed for the desired outcome: once subagent-target terminals are classified, they are hidden by default and their titles no longer surface as permanent rail entries. Title-repair parity is a separate concern.
- **No relaxation of listing filters.** Child sessions remain excluded from session listings on both servers (the spec calls the listing filter correct).
- Classification keys off `parent_id` only (true child sessions). 3-views-marked sessions are already classified `isSubagent` by the existing listing path; the spec explicitly warns not to conflate the Rust `is_subagent` (3-views marker) flag with parent_id children.
- No change to the `hasTitle` tautology at `sidebarSelectors.ts:504` (pre-existing, orthogonal).

---

### Task 1: Node — Bug 2: treat `worktree='/'` as absent in the opencode provider

**Files:**
- Modify: `server/coding-cli/providers/opencode.ts` (mapping at line ~185; new exported helper)
- Test: `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts` (append new test)

**Interfaces:**
- Consumes: `resolveGitRepoRoot(cwd: string): Promise<string>` from `server/coding-cli/utils.js` (already imported by opencode.ts; never returns nullish — falls back to its input).
- Produces: `export function meaningfulWorktree(worktree: string | null | undefined): string | undefined` from `server/coding-cli/providers/opencode.ts` (returns `undefined` for `null`/`undefined`/empty/whitespace/`'/'`; the trimmed worktree otherwise). Used by later reviewers as the single Node-side definition of "meaningful worktree".

- [ ] **Step 1: Write the failing test**

Append to `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts` (this file already uses real `node:sqlite` on a temp dir and constructs the provider with the in-process listing runner — reuse its existing imports of `OpencodeProvider` and `inProcessListingRunner`, and its existing temp-`homeDir` setup helper; the test body below is complete, only the seeding helper wiring follows the file's established local pattern):

```ts
describe('global project worktree "/" fallback (Bug 2)', () => {
  it('treats worktree="/" as absent and falls back to the git repo root of cwd', async () => {
    // Throwaway tmp dirs — never the user's real opencode data dir (session safety rule).
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-worktree-'))
    const dataDir = path.join(homeDir, '.local', 'share', 'opencode')
    await fsp.mkdir(dataDir, { recursive: true })
    const realCwd = path.join(homeDir, 'work', 'timeline')
    await fsp.mkdir(realCwd, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(dataDir, 'opencode.db'))
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
      `)
      db.prepare(`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)`) 
        .run('global', '/', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
        .run('ses_globalroot', 'global', null, 'ses_globalroot', realCwd, 'Global session', 'test', 1000, 3000, null)
    } finally {
      db.close()
    }

    // The ctor arg is the opencode DATA HOME (the directory containing
    // opencode.db, e.g. ~/.local/share/opencode) — NOT the user home. Same
    // as this file's existing tests, which pass the mkdtemp data dir directly.
    const provider = new OpencodeProvider(dataDir, { queryRunner: inProcessListingRunner })
    const sessions = await provider.listSessionsDirect()

    expect(sessions).toHaveLength(1)
    // realCwd is not a git repo, so resolveGitRepoRoot returns the cwd itself.
    expect(sessions[0].projectPath).toBe(realCwd)
    expect(sessions[0].projectPath).not.toBe('/')
    await fsp.rm(homeDir, { recursive: true, force: true })
  })
})
```

Also add a pure-function test for the helper (same file, top level):

```ts
describe('meaningfulWorktree', () => {
  it('rejects "/", empty, whitespace, and nullish; passes real paths through trimmed', () => {
    expect(meaningfulWorktree('/')).toBeUndefined()
    expect(meaningfulWorktree('')).toBeUndefined()
    expect(meaningfulWorktree('   ')).toBeUndefined()
    expect(meaningfulWorktree(null)).toBeUndefined()
    expect(meaningfulWorktree(undefined)).toBeUndefined()
    expect(meaningfulWorktree('/repo/root')).toBe('/repo/root')
    expect(meaningfulWorktree(' /repo/root ')).toBe('/repo/root')
  })
})
```

Import `meaningfulWorktree` alongside the existing `OpencodeProvider` import (same module).

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
FRESHELL_TEST_SUMMARY="bug2-node-red" npm run test:vitest -- run test/unit/server/coding-cli/opencode-provider.sqlite.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: FAIL — `meaningfulWorktree` is not exported (import error), and/or `projectPath` equals `'/'`.

- [ ] **Step 3: Implement**

In `server/coding-cli/providers/opencode.ts`, add near the top-level module functions:

```ts
/**
 * OpenCode's catch-all "global" project stores `worktree = '/'` — a
 * non-informative placeholder, not a real checkout. Treat it (and empty)
 * as absent so callers fall back to deriving from the session's real cwd.
 */
export function meaningfulWorktree(worktree: string | null | undefined): string | undefined {
  if (typeof worktree !== 'string') return undefined
  const trimmed = worktree.trim()
  if (!trimmed || trimmed === '/') return undefined
  return trimmed
}
```

Change line ~185 (inside `listSessionsDirect()`), from:

```ts
const projectPath = row.projectPath || await resolveGitRepoRoot(row.cwd)
```

to:

```ts
const projectPath = meaningfulWorktree(row.projectPath) ?? await resolveGitRepoRoot(row.cwd)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command as Step 2. Expected: PASS (all tests in the file, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/opencode.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts
git commit -m "fix(opencode): treat global-project worktree '/' as absent in Node listing (Bug 2)"
```

---

### Task 2: Rust — Bug 2: `'/'` worktree guard in listing, by-id, and on the wire

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (listing mapping at lines 341-344; by-id row extraction at line ~555; new private helper)
- Test: `crates/freshell-sessions/tests/opencode_sqlite.rs` (new `#[test]`)
- Test: `crates/freshell-sessions/tests/opencode_row_by_id.rs` (new `#[test]`)
- Test: `crates/freshell-server/src/session_directory.rs` (new `#[tokio::test]` in the existing test module, modeled on `session_override_applies_to_codex_and_opencode_keys` at line ~2404)

**Interfaces:**
- Consumes: `OpencodeProvider::list_sessions(now_ms: i64) -> Result<OpencodeListing, OpencodeReadError>` and `opencode_session_row_by_id(data_home: &Path, session_id: &str) -> Result<Option<OpencodeByIdRow>, OpencodeByIdError>` (both in `crates/freshell-sessions/src/parse/opencode.rs`).
- Produces: `fn meaningful_worktree(p: Option<String>) -> Option<String>` (private to `parse/opencode.rs`); listing `OpencodeSession.project_path` now falls back to `cwd` when the DB worktree is `'/'`; by-id `OpencodeByIdRow.project_path` is `None` when the DB worktree is `'/'`. (Rust matches the repo's documented convention of raw-cwd fallback — git-root resolution is deliberately deferred repo-wide, see `session_directory.rs:26-28`; Node keeps its `resolveGitRepoRoot` fallback per Task 1.)

- [ ] **Step 1: Write the failing listing test**

Append to `crates/freshell-sessions/tests/opencode_sqlite.rs` (self-contained; uses the same rusqlite temp-db idiom as the file's existing tests):

```rust
#[test]
fn global_project_worktree_slash_falls_back_to_cwd() {
    let dir = std::env::temp_dir().join(format!(
        "freshell-oc-worktree-slash-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES ('global', '/')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('ses_globalroot','/tmp/analysis/work/timeline','Global',1000,3000,NULL,'global',NULL)",
            [],
        )
        .unwrap();
    }

    let provider = OpencodeProvider::new(dir.clone());
    let listing = provider.list_sessions(42).expect("read ok");

    assert_eq!(listing.sessions.len(), 1);
    assert_eq!(
        listing.sessions[0].project_path, "/tmp/analysis/work/timeline",
        "worktree '/' must not win over cwd"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
```

(Match the file's existing imports — `OpencodeProvider` is already imported by the existing tests in this file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p freshell-sessions --test opencode_sqlite global_project_worktree_slash_falls_back_to_cwd -- --exact --nocapture`
Expected: FAIL with `assertion failed` — `project_path` is `"/"`.

- [ ] **Step 3: Write the failing by-id test**

Append to `crates/freshell-sessions/tests/opencode_row_by_id.rs` (mirror the file's existing fixture idiom — it already creates `project`/`session` tables in a temp `opencode.db`):

```rust
#[test]
fn by_id_row_worktree_slash_yields_no_project_path() {
    let dir = std::env::temp_dir().join(format!(
        "freshell-oc-byid-worktree-slash-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             INSERT INTO project (id, worktree) VALUES ('global', '/');
             INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_globalbyid', 'global', NULL, '/tmp/real/dir', 'By id', 100, 200, NULL);",
        )
        .unwrap();
    }

    let row = opencode_session_row_by_id(&dir, "ses_globalbyid")
        .expect("query ok")
        .expect("row found");
    assert_eq!(row.project_path, None, "worktree '/' must map to None");
    let _ = std::fs::remove_dir_all(&dir);
}
```

Run: `cargo test -p freshell-sessions --test opencode_row_by_id by_id_row_worktree_slash_yields_no_project_path -- --exact --nocapture`
Expected: FAIL — `project_path` is `Some("/")`.

- [ ] **Step 4: Implement**

In `crates/freshell-sessions/src/parse/opencode.rs`, add near the mapping code:

```rust
/// OpenCode's catch-all "global" project stores `worktree = "/"` — a
/// non-informative placeholder, not a real checkout. Treat it (and empty)
/// as absent so callers fall back to the session's real cwd.
fn meaningful_worktree(p: Option<String>) -> Option<String> {
    p.filter(|p| !p.is_empty() && p != "/")
}
```

Change the listing mapping (lines 341-344), from:

```rust
let project_path = row
    .project_path
    .filter(|p| !p.is_empty())
    .unwrap_or_else(|| cwd.clone());
```

to:

```rust
let project_path = meaningful_worktree(row.project_path).unwrap_or_else(|| cwd.clone());
```

Change the by-id row extraction (line ~555 inside `opencode_session_row_by_id`), from:

```rust
project_path: to_opt_string(&row.get::<_, SqlValue>(5)?),
```

to:

```rust
project_path: meaningful_worktree(to_opt_string(&row.get::<_, SqlValue>(5)?)),
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cargo test -p freshell-sessions --test opencode_sqlite` and `cargo test -p freshell-sessions --test opencode_row_by_id`
Expected: PASS (all tests in both files).

- [ ] **Step 6: Write the failing wire-level test (freshell-server)**

In `crates/freshell-server/src/session_directory.rs`, inside the existing `#[cfg(test)]` module that contains `session_override_applies_to_codex_and_opencode_keys` (line ~2404), add a new test that reuses that test's exact scaffolding (settings/auth/`SessionIndex`/`router`/`oneshot` — copy its setup lines verbatim and adjust only the DB seeding + assertions):

```rust
#[tokio::test]
async fn global_project_session_reports_real_directory_as_project_path() {
    use axum::http::Request;
    use tower::ServiceExt;
    // Copy the home/auth/settings setup verbatim from
    // `session_override_applies_to_codex_and_opencode_keys` (above), keeping
    // ONLY the opencode source (drop the codex one), then seed:
    //   conn.execute_batch(
    //       "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    //        CREATE TABLE session (
    //           id TEXT PRIMARY KEY, directory TEXT, title TEXT,
    //           time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
    //           project_id TEXT, parent_id TEXT
    //        );",
    //   ).unwrap();
    //   conn.execute("INSERT INTO project (id, worktree) VALUES ('global', '/')", []).unwrap();
    //   conn.execute(
    //       "INSERT INTO session VALUES ('oc-global','/tmp/real/dir','OC Global',1,2,NULL,'global',NULL)",
    //       [],
    //   ).unwrap();
    // Then:
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/session-directory?priority=visible&includeEmpty=1")
                .header("x-auth-token", "tok")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let items = v["items"].as_array().expect("items array");
    let item = items
        .iter()
        .find(|i| i["sessionId"] == "oc-global")
        .expect("seeded session present");
    assert_eq!(item["projectPath"], "/tmp/real/dir", "wire projectPath must be the cwd, not '/'");
}
```

NOTE for the implementer: the commented block is a seeding DESCRIPTION — inline it as real code copied from the sibling test's structure (that sibling shows the exact `SessionDirectoryState`/`router(state)` wiring and the response-shape idiom; follow whichever body/response accessor pattern the sibling test uses if it differs from `v["items"]`). The test must FAIL before Task 2 Step 4's change and PASS after; since Step 4 is already applied at this point, verify RED by temporarily asserting `item["projectPath"] == "/"` fails — i.e., confirm the assertion is exercising a real item (non-empty `items`), then keep the correct assertion.

Run: `cargo test -p freshell-server global_project_session_reports_real_directory_as_project_path -- --exact --nocapture`
Expected: PASS (this is the wire-level pin for the already-landed parser fix).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/tests/opencode_sqlite.rs crates/freshell-sessions/tests/opencode_row_by_id.rs crates/freshell-server/src/session_directory.rs
git commit -m "fix(opencode): treat global-project worktree '/' as absent in Rust listing + by-id (Bug 2)"
```

---

### Task 3: Node — Bug 1a: subagent classification query

**Files:**
- Create: `server/coding-cli/providers/opencode-subagent-query.ts`
- Modify: `server/coding-cli/providers/opencode.ts` (export the DB-path resolution)
- Modify: `server/coding-cli/providers/opencode-listing-query.ts` (`OpencodeSessionRow` gains optional `parentId`)
- Modify: `server/coding-cli/providers/opencode-by-id-query.ts` (project `parent_id`, schema-guarded)
- Test: `test/unit/server/coding-cli/opencode-subagent-query.test.ts`

**Interfaces:**
- Consumes: the EXISTING off-thread by-id worker triad — `runOpencodeSessionByIdOffThread(dbPath, sessionId): Promise<OpencodeSessionRow | null>` (`server/coding-cli/providers/opencode-by-id-runner.ts:124-126`, production-wired at `resolve-fallbacks.ts:83,115`; one short-lived `worker_threads.Worker` per lookup, 500ms busy timeout inside the worker, 15s outer timeout, rejects on failure). NEVER `node:sqlite` `DatabaseSync` on the main thread: `opencode-by-id-query.ts:3-11` states the rule verbatim ("Never call it on the main thread in production" — `DatabaseSync` blocks whatever thread runs it for up to the busy timeout when the DB is locked), and every production opencode SQLite read in this codebase runs inside a worker thread.
- Produces:
  - `export function resolveOpencodeDatabasePath(dataHome?: string): string` from `server/coding-cli/providers/opencode.ts` — a NEW module-level one-liner `path.join(dataHome, 'opencode.db')` whose `dataHome` parameter defaults to the ALREADY-EXPORTED `defaultOpencodeDataHome()` (`opencode.ts:39-48`, which owns the `XDG_DATA_HOME` branch and the win32/`~/.local/share/opencode` platform defaults). The provider's `getDatabasePath()` (`opencode.ts:80-83`) is PUBLIC (its doc comment cites an external consumer — resolve-fallbacks builds the off-thread by-id lookup from it; do NOT make it private) and is today a one-liner `path.join(this.homeDir, 'opencode.db')` with NO XDG logic — it delegates: `return resolveOpencodeDatabasePath(this.homeDir)`. Behavior must be byte-identical to today. (Note: the `OpencodeProvider` ctor arg `homeDir` is the opencode DATA HOME, defaulting to `defaultOpencodeDataHome()` — `opencode.ts:73-78`.)
  - `export async function isOpencodeSubagentSession(sessionId: string, dbPath?: string): Promise<boolean>` from `server/coding-cli/providers/opencode-subagent-query.ts` — `true` ONLY when the session row exists AND has `parent_id NOT NULL`. Returns `false` for: missing DB file, missing row, schema without a `parent_id` column, and ANY read/worker error (classification is best-effort; it must never block or fail terminal creation). `dbPath` defaults to `resolveOpencodeDatabasePath()`. Implemented as a thin wrapper over the off-thread by-id runner: the SQLite read runs in a short-lived worker thread, and the runner's rejections (locked/corrupt DB, worker failure, timeout) are swallowed to `false` HERE at the call site — the runner itself keeps its reject-on-failure contract for its existing `resolve-fallbacks` consumer.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/server/coding-cli/opencode-subagent-query.test.ts`:

```ts
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOpencodeSubagentSession } from '../../../../server/coding-cli/providers/opencode-subagent-query'

vi.unmock('node:sqlite')

describe('isOpencodeSubagentSession', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    // Throwaway tmp DB — never the user's real opencode data dir (session safety rule).
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-subagent-'))
    dbPath = path.join(tempDir, 'opencode.db')
  })
  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function seed(opts: { parentIdColumn?: boolean } = {}): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const parentCol = opts.parentIdColumn === false ? '' : 'parent_id TEXT,'
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, ${parentCol} directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);`)
      if (opts.parentIdColumn === false) {
        db.prepare(`INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_flat', 'p1', '/repo', 'flat', 1, 2, null)
      } else {
        db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_root', 'p1', null, '/repo', 'root', 1, 2, null)
        db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_child', 'p1', 'ses_root', '/repo', 'child', 1, 2, null)
      }
    } finally {
      db.close()
    }
  }

  it('returns true for a child session (parent_id set)', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_child', dbPath)).toBe(true)
  })

  it('returns false for a root session', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_root', dbPath)).toBe(false)
  })

  it('returns false for a missing row', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_nope', dbPath)).toBe(false)
  })

  it('returns false when the schema has no parent_id column', async () => {
    await seed({ parentIdColumn: false })
    expect(await isOpencodeSubagentSession('ses_flat', dbPath)).toBe(false)
  })

  it('returns false when the DB file does not exist', async () => {
    expect(await isOpencodeSubagentSession('ses_child', path.join(tempDir, 'missing.db'))).toBe(false)
  })

  it('returns false on an unreadable/corrupt DB (never throws)', async () => {
    await fsp.writeFile(dbPath, 'not a sqlite file')
    expect(await isOpencodeSubagentSession('ses_child', dbPath)).toBe(false)
  })
})
```

Also add (same file, top level) a default-resolution pin — NO other test exercises the no-args production default, and it is exactly what would have silently broken under the wrong `os.homedir()` model:

```ts
import { resolveOpencodeDatabasePath } from '../../../../server/coding-cli/providers/opencode'

describe('resolveOpencodeDatabasePath', () => {
  it('defaults to <XDG_DATA_HOME>/opencode/opencode.db (production default) and joins explicit data homes', async () => {
    const savedXdg = process.env.XDG_DATA_HOME
    const xdgTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-xdg-'))
    process.env.XDG_DATA_HOME = xdgTmp
    try {
      expect(resolveOpencodeDatabasePath()).toBe(path.join(xdgTmp, 'opencode', 'opencode.db'))
      expect(resolveOpencodeDatabasePath('/explicit/data/home')).toBe(path.join('/explicit/data/home', 'opencode.db'))
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = savedXdg
      await fsp.rm(xdgTmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
FRESHELL_TEST_SUMMARY="bug1-node-query-red" npm run test:vitest -- run test/unit/server/coding-cli/opencode-subagent-query.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: FAIL — module `opencode-subagent-query` does not exist, and `resolveOpencodeDatabasePath` is not yet exported from `opencode.ts` (import error).

- [ ] **Step 3: Implement**

The read MUST run OFF the event loop. The by-id worker triad already exists and is production-wired (`server/coding-cli/providers/opencode-by-id-query.ts` + `opencode-by-id.worker.ts` + `opencode-by-id-runner.ts`; `resolve-fallbacks.ts:83,115` is the precedent consumer) — the only gap is that its SELECT does not project `parent_id`. Close the gap additively, then wrap the runner:

1. `server/coding-cli/providers/opencode-listing-query.ts` — add to `OpencodeSessionRow` (:1-9): `parentId?: string | null`.
2. `server/coding-cli/providers/opencode-by-id-query.ts` — in `runOpencodeSessionByIdQuery` (:23-55), project `parent_id` guarded by the schema probe idiom the listing query already uses (`PRAGMA table_info(session)` — `opencode-listing-query.ts:42-43`): after the existing `sqlite_master` table checks, compute `hasParentId` from `PRAGMA table_info(session)`, then add `${hasParentId ? 's.parent_id' : 'NULL'} AS parentId,` to the SELECT's projection list. Old schemas keep returning rows (with `parentId: null`) — behavior for the existing `resolve-fallbacks` consumer is unchanged apart from an additive optional field. Worker entry, runner, and message validators need ZERO changes (`WorkerByIdInput` is already `{dbPath, sessionId}`; the worker passes `row` through at `opencode-by-id.worker.ts:39`; `isOkMessage` only checks object-or-null at `opencode-by-id-runner.ts:51-57`).
3. Create `server/coding-cli/providers/opencode-subagent-query.ts` as a thin wrapper over the runner:

```ts
import fsp from 'fs/promises'
import { runOpencodeSessionByIdOffThread } from './opencode-by-id-runner.js'
import { resolveOpencodeDatabasePath } from './opencode.js'

/**
 * Best-effort classification: does `sessionId` name an opencode SUBAGENT
 * (child) session — a `session` row with `parent_id NOT NULL`?
 *
 * `false` for: missing DB, missing row, schema without parent_id, and ANY
 * read/worker error. Classification must never block or fail terminal
 * creation, so runner rejections are swallowed HERE at the call site (the
 * runner keeps its reject-on-failure contract for resolve-fallbacks).
 *
 * The SQLite read runs INSIDE A WORKER THREAD (one short-lived worker per
 * lookup, 500ms busy timeout in the worker, hard outer timeout). NEVER open
 * DatabaseSync on the main thread here — it blocks the whole event loop
 * while the DB is locked (opencode-by-id-query.ts:3-11).
 */
export async function isOpencodeSubagentSession(
  sessionId: string,
  dbPath: string = resolveOpencodeDatabasePath(),
): Promise<boolean> {
  try {
    await fsp.access(dbPath)
  } catch {
    return false
  }
  try {
    const row = await runOpencodeSessionByIdOffThread(dbPath, sessionId)
    return row?.parentId != null
  } catch {
    return false
  }
}
```

In `server/coding-cli/providers/opencode.ts`: the provider's `getDatabasePath()` is already PUBLIC (`opencode.ts:80-83`; its doc comment cites an external consumer — resolve-fallbacks builds the off-thread by-id lookup from it — so keep it public) and is a one-liner `path.join(this.homeDir, 'opencode.db')` with NO XDG logic; the XDG branch lives in the already-exported `defaultOpencodeDataHome()` (`opencode.ts:39-48`). Add a new exported module-level function next to `defaultOpencodeDataHome`:

```ts
/**
 * The opencode.db path inside an opencode DATA home. With no argument this
 * is the PRODUCTION default: `$XDG_DATA_HOME/opencode/opencode.db`,
 * `%LOCALAPPDATA%\opencode\opencode.db`, or `~/.local/share/opencode/opencode.db`
 * (whatever defaultOpencodeDataHome() resolves).
 */
export function resolveOpencodeDatabasePath(dataHome: string = defaultOpencodeDataHome()): string {
  return path.join(dataHome, 'opencode.db')
}
```

and make the provider's public method delegate (behavior byte-identical to today): `getDatabasePath(): string { return resolveOpencodeDatabasePath(this.homeDir) }` — keep the method's existing name, PUBLIC visibility, and doc comment so all call sites are untouched.

- [ ] **Step 4: Run to verify pass**

Same command as Step 2. Expected: PASS (7 tests — the wrapper's tests exercise a REAL worker against the temp DB; precedent: `test/unit/server/coding-cli/opencode-by-id-runner.test.ts:144-181`). Also re-run Task 1's file plus the by-id triad's own tests to prove the delegation and the projection change didn't regress anything:
```bash
FRESHELL_TEST_SUMMARY="bug1-node-query-green" npm run test:vitest -- run test/unit/server/coding-cli/opencode-subagent-query.test.ts test/unit/server/coding-cli/opencode-by-id-query.test.ts test/unit/server/coding-cli/opencode-by-id-runner.test.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts test/unit/server/coding-cli/opencode-provider.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: PASS. (If `opencode-by-id-query.test.ts` pins the exact row projection with a full-object equality, extend its expected row with the additive `parentId` value rather than weakening the assertion.)

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/opencode-subagent-query.ts server/coding-cli/providers/opencode.ts server/coding-cli/providers/opencode-listing-query.ts server/coding-cli/providers/opencode-by-id-query.ts test/unit/server/coding-cli/opencode-subagent-query.test.ts test/unit/server/coding-cli/opencode-by-id-query.test.ts
git commit -m "feat(opencode): add best-effort off-thread subagent (parent_id) classification on Node (Bug 1)"
```

---

### Task 4: Node — Bug 1b: carry `resumeTargetIsSubagent` through the terminal record to the wire

**Files:**
- Modify: `server/terminal-registry.ts` (`TerminalRecord` type at ~566-654; `create()` opts + record init at ~1582-1729, record init line ~1682 region; `list()` at ~4337-4365)
- Modify: `server/terminal-view/service.ts` (`TerminalListRecord` at 23-36; `buildDirectoryItem` at ~309-325)
- Modify: `server/terminal-view/types.ts` (`TerminalDirectoryItem` at 6-24)
- Modify: `server/ws-handler.ts` (the `case 'terminal.create':` handler at ~2039+)
- Modify: `shared/ws-protocol.ts` (`TerminalInventoryMessage` at ~1108-1125 — additive optional field)
- Regenerate: `port/contract/ws-server-messages.schema.json` (via `npm run contract:generate` — see Step 7)
- Test: `test/unit/server/terminal-registry.test.ts` (append)
- Test: `test/server/terminals-api.test.ts` (append)

**Interfaces:**
- Consumes: `isOpencodeSubagentSession(sessionId: string, dbPath?: string): Promise<boolean>` from Task 3 (import in ws-handler as `./coding-cli/providers/opencode-subagent-query.js` — note the `.js` extension).
- Produces:
  - `TerminalRegistry.create(opts)` accepts a new optional `resumeTargetIsSubagent?: boolean`; `TerminalRecord.resumeTargetIsSubagent?: boolean` (recomputed whenever the resume target changes — set at create time and re-derived by `bindSession` when it overwrites `resumeSessionId`, see Step 6); `list()` items include `resumeTargetIsSubagent?: boolean`.
  - Wire: `/api/terminals` items and `terminal.inventory` rows carry `resumeTargetIsSubagent: true` ONLY when true (omitted otherwise — undefined-omitted, matching every optional field on these payloads). `terminal.inventory` gets it for free via the `...rest` spread in `normalizeTerminalInventoryForClient` (`ws-handler.ts:350-371` strips only `resumeSessionId`).
  - Protocol: `resumeTargetIsSubagent?: boolean` declared on the terminal-inventory item type in `shared/ws-protocol.ts` (`TerminalInventoryMessage`, ~:1108-1125) — additive + optional, server→client only, NO `WS_PROTOCOL_VERSION` bump (the Global Constraint's `:876-884` precedent) — and the frozen contract `port/contract/ws-server-messages.schema.json` regenerated to admit it (its `terminal.inventory` items carry `additionalProperties: false`, so without this the Node runtime would formally violate its own contract whenever the flag is set). The Rust protocol crate is deliberately unaffected (serde is accept-and-strip crate-wide; the Node/Rust inventory asymmetry stays).

- [ ] **Step 1: Write the failing registry test**

Append to `test/unit/server/terminal-registry.test.ts` (inside the top-level describe, following the file's existing `registry.create(...)` / `registry.list()` idiom, e.g. the codex sessionRef test at lines ~2322-2343):

```ts
describe('resumeTargetIsSubagent (opencode subagent-target classification)', () => {
  it('stores the flag from create opts and surfaces it from list()', () => {
    registry.create({
      mode: 'opencode',
      cwd: '/home/user/project',
      resumeSessionId: 'ses_child0000000000000000000000',
      resumeTargetIsSubagent: true,
    })
    expect(registry.list()[0]).toMatchObject({
      mode: 'opencode',
      resumeTargetIsSubagent: true,
    })
  })

  it('omits the flag when not provided (root/unknown target)', () => {
    registry.create({ mode: 'opencode', cwd: '/home/user/project' })
    expect(registry.list()[0].resumeTargetIsSubagent).toBeUndefined()
  })
})
```

Run:
```bash
FRESHELL_TEST_SUMMARY="bug1-node-registry-red" npm run test:vitest -- run test/unit/server/terminal-registry.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: FAIL — TypeScript rejects the unknown `resumeTargetIsSubagent` create opt / `list()` lacks the field.

- [ ] **Step 2: Implement the registry plumbing**

In `server/terminal-registry.ts`:

1. `TerminalRecord` (type at ~566): add after `resumeSessionId?: string`:
```ts
  /**
   * True when this terminal's resume target is an opencode subagent
   * (child) session (`parent_id NOT NULL` in opencode.db). Computed at
   * create time from the requested resume id and RECOMPUTED whenever the
   * resume target changes (bindSession re-classifies when it overwrites
   * resumeSessionId — root-resolved ids in the happy path, raw child ids
   * possible in the degraded chain-walk-failure edge). Server→client only;
   * drives the sidebar's showSubagents visibility filter.
   */
  resumeTargetIsSubagent?: boolean
```
2. `create(opts)` (signature at ~1582): add `resumeTargetIsSubagent?: boolean` to the opts type; in the record literal (where `resumeSessionId: undefined` is set at ~1682), add:
```ts
      resumeTargetIsSubagent: opts.resumeTargetIsSubagent || undefined,
```
3. `list()` (~4337): add to both the return type object and the mapped literal:
```ts
      resumeTargetIsSubagent: t.resumeTargetIsSubagent,
```

Run the Step 1 command again. Expected: PASS.

- [ ] **Step 3: Write the failing `/api/terminals` test**

Append to `test/server/terminals-api.test.ts`, following that file's existing setup idiom (it builds the terminal-view service/router around a registry fake or real registry — mirror however the sibling `GET /api/terminals` tests in the file seed a terminal):

```ts
it('carries resumeTargetIsSubagent on directory items only when true', async () => {
  // Seed two running opencode terminals through the file's existing
  // registry-seeding helper: one with resumeTargetIsSubagent: true, one without.
  // (Use the same seeding call the surrounding tests use, adding the new field
  //  to the seeded record — it flows through registry.list().)
  const res = await request(app).get('/api/terminals').set('x-auth-token', token)
  expect(res.status).toBe(200)
  const items = res.body as Array<Record<string, unknown>>
  const flagged = items.find((t) => t.resumeTargetIsSubagent === true)
  expect(flagged).toBeTruthy()
  const unflagged = items.filter((t) => t.resumeTargetIsSubagent !== true)
  for (const item of unflagged) {
    expect(item).not.toHaveProperty('resumeTargetIsSubagent')
  }
})
```

(Adapt the request/auth idiom — `request(app)`/headers — to exactly match the sibling tests in this file; the assertion body stays as written.)

Run:
```bash
FRESHELL_TEST_SUMMARY="bug1-node-rest-red" npm run test:vitest -- run test/server/terminals-api.test.ts --config config/vitest/vitest.server.config.ts
```
Expected: FAIL — item lacks `resumeTargetIsSubagent`.

- [ ] **Step 4: Implement the terminal-view projection**

1. `server/terminal-view/service.ts` `TerminalListRecord` (23-36): add `resumeTargetIsSubagent?: boolean`.
2. `server/terminal-view/service.ts` `buildDirectoryItem` (~309-325): add to the returned literal:
```ts
    ...(terminal.resumeTargetIsSubagent ? { resumeTargetIsSubagent: true } : {}),
```
3. `server/terminal-view/types.ts` `TerminalDirectoryItem` (6-24): add `resumeTargetIsSubagent?: boolean`.

Run the Step 3 command again. Expected: PASS.

- [ ] **Step 5: Wire the classification into terminal.create (ws-handler)**

In `server/ws-handler.ts`:

1. Add the import (with the other provider imports near the top):
```ts
import { isOpencodeSubagentSession } from './coding-cli/providers/opencode-subagent-query.js'
```
2. Inside `case 'terminal.create': {` (starts at ~2039), locate the single `registry.create(`/`this.registry.create(` call for the requested terminal (`grep -n "registry.create" server/ws-handler.ts` and pick the call inside this case). Immediately BEFORE it, add:
```ts
        // Bug-1 (sidebar rail): classify the requested opencode resume target
        // at create time (bindSession later re-classifies whenever it
        // overwrites resumeSessionId — see Step 6). Best-effort:
        // any failure classifies as "not a subagent". The await parks on a
        // WORKER-THREAD SQLite read (Task 3) — the event loop stays free;
        // this create path already awaits allocateLocalhostPort() just
        // below (~:2562), so an await here is the established shape.
        const requestedOpencodeTarget = m.mode === 'opencode'
          ? (m.resumeSessionId ?? (m.sessionRef?.provider === 'opencode' ? m.sessionRef.sessionId : undefined))
          : undefined
        const resumeTargetIsSubagent = requestedOpencodeTarget
          ? await isOpencodeSubagentSession(requestedOpencodeTarget)
          : undefined
```
   (The handler already reads `m.resumeSessionId ?? m.sessionRef.sessionId` at line ~2056, so both fields exist on `m` here. The handler is `async` — the `await` is legal.)
3. Add `resumeTargetIsSubagent,` to the options object passed to that `registry.create(...)` call.

- [ ] **Step 6: Re-classify on bindSession (Node mirror of the Rust rebind fix)**

`bindSession` (`server/terminal-registry.ts:4797`) overwrites `record.resumeSessionId` post-create (`term.resumeSessionId = normalized`, the tracker-driven association write — root-resolved ids in the happy path, raw child ids possible in the degraded chain-walk-failure edge), which can leave the create-time flag stale in BOTH directions (e.g. created targeting a child → user switches the TUI to a root session → the terminal would stay hidden).

First append the failing test to `test/unit/server/terminal-registry.test.ts` (inside the Step 1 describe block):

```ts
  it('re-classifies resumeTargetIsSubagent when bindSession changes the resume target (both directions)', async () => {
    const created = registry.create({
      mode: 'opencode',
      cwd: '/home/user/project',
      resumeSessionId: 'ses_child0000000000000000000000',
      resumeTargetIsSubagent: true,
    })
    // Rebind to a ROOT id: the fire-and-forget re-classification must clear
    // the stale flag (no opencode.db here -> isOpencodeSubagentSession
    // resolves false, which is exactly the root/unknown answer).
    const bound = registry.bindSession(created.terminalId, 'opencode', 'ses_root0000000000000000000000', 'association')
    expect(bound.ok).toBe(true)
    await vi.waitFor(() => {
      expect(registry.list().find((t) => t.terminalId === created.terminalId)?.resumeTargetIsSubagent).toBeUndefined()
    })
  })
```

(Adapt the `registry.create(...)` return-value access to the file's existing idiom if `create` returns the record differently, and reuse the file's existing `vi` import. The inverse direction — root→child flips the flag to `true` — is covered end-to-end by classification against a real seeded DB in Task 9; here the DB-less `false` answer pins the clearing behavior, which is the direction the create-time flag can never fix on its own.)

Then implement in `server/terminal-registry.ts` — in `bindSession` (:4797), immediately after `term.resumeSessionId = normalized` (before the `terminal.session.bound` emit), add a fire-and-forget re-classification:

```ts
    // Bug-1 (sidebar rail): the resume target just changed — re-derive the
    // subagent classification for the NEW target (both directions: a switch
    // to a root session must CLEAR a stale true). Fire-and-forget:
    // classification must never block or fail binding (bindSession is fully
    // synchronous), and the SQLite read itself runs on a worker thread
    // (Task 3), so nothing here can stall the event loop.
    if (provider === 'opencode') {
      void isOpencodeSubagentSession(normalized)
        .then((isSubagent) => {
          const current = this.terminals.get(terminalId)
          if (current) current.resumeTargetIsSubagent = isSubagent || undefined
        })
        .catch(() => {})
    }
```

Add the import at the top of `terminal-registry.ts` (NodeNext ESM — `.js` extension): `import { isOpencodeSubagentSession } from './coding-cli/providers/opencode-subagent-query.js'`.

Run the Step 1 command again. Expected: PASS.

- [ ] **Step 7: Declare the field on the frozen WS contract**

The frozen contract `port/contract/ws-server-messages.schema.json` has `additionalProperties: false` on `terminal.inventory` items, so the `...rest`-spread inventory carrying the new field would formally violate the contract (invisible to CI today — the oracle sweeps only create shell terminals — but a latent fidelity gap for any future capture).

1. In `shared/ws-protocol.ts`, add to the terminal-inventory item type (`TerminalInventoryMessage`, ~:1108-1125), alongside its other optional fields:
```ts
  /** Server→client only, additive + optional: the terminal's resume target is an opencode subagent (child) session. */
  resumeTargetIsSubagent?: boolean
```
   (Additive + optional, server→client — consistent with the Global Constraint and its `:876-884` precedent; NO `WS_PROTOCOL_VERSION` bump.)
2. Regenerate the committed schema so it admits the field:
```bash
npm run contract:generate
git diff --stat port/contract/   # expect ws-server-messages.schema.json to gain the optional prop
```
   The Rust protocol crate is deliberately unaffected (serde accept-and-strips unknown fields crate-wide; the Node/Rust inventory asymmetry stays).

- [ ] **Step 8: Run the touched suites + typecheck**

```bash
npm run typecheck:server
FRESHELL_TEST_SUMMARY="bug1-node-green" npm run test:vitest -- run test/unit/server/terminal-registry.test.ts test/server/terminals-api.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts
npm run test:port
```
Expected: PASS (the handshake-snapshot suite proves the inventory spread didn't regress — its exact-strip assertion only checks `resumeSessionId`; `test:port` proves the regenerated contract is in sync with `shared/ws-protocol.ts`).

- [ ] **Step 9: Commit**

```bash
git add server/terminal-registry.ts server/terminal-view/service.ts server/terminal-view/types.ts server/ws-handler.ts shared/ws-protocol.ts port/contract/ws-server-messages.schema.json test/unit/server/terminal-registry.test.ts test/server/terminals-api.test.ts
git commit -m "feat(terminals): expose resumeTargetIsSubagent on the Node terminal record and /api/terminals (Bug 1)"
```

---

### Task 5: Rust — Bug 1a: `session_is_subagent_by_id` + locator classification helper

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (new pub fn next to `session_exists_by_id` at ~421)
- Modify: `crates/freshell-sessions/src/parse/mod.rs` (re-export, next to the existing re-exports at ~14)
- Modify: `crates/freshell-sessions/src/opencode_locator.rs` (new pub method)
- Test: `crates/freshell-sessions/tests/opencode_subagent_by_id.rs` (new file)

**Interfaces:**
- Consumes: rusqlite `Connection`, the `OpencodeReadError` type and the PRAGMA schema-guard idiom already in `parse/opencode.rs:135-145`.
- Produces:
  - `pub fn session_is_subagent_by_id(data_home: &Path, session_id: &str) -> Result<Option<bool>, OpencodeReadError>` in `crates/freshell-sessions/src/parse/opencode.rs`, re-exported from `parse/mod.rs`. `Ok(None)` = DB file missing or row missing; `Ok(Some(true))` = row exists with `parent_id NOT NULL`; `Ok(Some(false))` = root row, or row exists under a legacy schema without `parent_id`. `Err` = read failure (callers treat as unknown).
  - `impl OpencodeLocator { pub fn classify_resume_target(&self, session_id: &str) -> Option<bool> }` — thin best-effort wrapper: `Some(true|false)` on a definite answer, `None` on missing/unknown/error. Uses a NEW private `data_home: PathBuf` field retained by both constructors (the locator does NOT keep the data home today — it is consumed into the private `OpencodeProvider`; Step 2 adds the field, constructor signatures unchanged).

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-sessions/tests/opencode_subagent_by_id.rs`:

```rust
//! Unit tests for `session_is_subagent_by_id` — the one-row parent_id
//! classification behind the sidebar's subagent-terminal filtering.

use freshell_sessions::parse::session_is_subagent_by_id;
use rusqlite::Connection;
use std::path::PathBuf;

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-oc-subagent-byid-{tag}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed(home: &std::path::Path, with_parent_id_column: bool) {
    let conn = Connection::open(home.join("opencode.db")).unwrap();
    if with_parent_id_column {
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_root', 'p1', NULL, '/repo', 'root', 1, 2, NULL);
             INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_child', 'p1', 'ses_root', '/repo', 'child', 1, 2, NULL);",
        )
        .unwrap();
    } else {
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_flat', 'p1', '/repo', 'flat', 1, 2, NULL);",
        )
        .unwrap();
    }
}

#[test]
fn child_row_is_subagent() {
    let home = temp_home("child");
    seed(&home, true);
    assert_eq!(session_is_subagent_by_id(&home, "ses_child").unwrap(), Some(true));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn root_row_is_not_subagent() {
    let home = temp_home("root");
    seed(&home, true);
    assert_eq!(session_is_subagent_by_id(&home, "ses_root").unwrap(), Some(false));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_row_is_none() {
    let home = temp_home("missing-row");
    seed(&home, true);
    assert_eq!(session_is_subagent_by_id(&home, "ses_nope").unwrap(), None);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_db_is_none() {
    let home = temp_home("missing-db");
    assert_eq!(session_is_subagent_by_id(&home, "ses_child").unwrap(), None);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn legacy_schema_without_parent_id_is_some_false() {
    let home = temp_home("legacy");
    seed(&home, false);
    assert_eq!(session_is_subagent_by_id(&home, "ses_flat").unwrap(), Some(false));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn unreadable_db_is_err() {
    let home = temp_home("corrupt");
    std::fs::write(home.join("opencode.db"), b"not a sqlite file").unwrap();
    assert!(session_is_subagent_by_id(&home, "ses_child").is_err());
    let _ = std::fs::remove_dir_all(&home);
}
```

Run: `cargo test -p freshell-sessions --test opencode_subagent_by_id`
Expected: FAIL to compile — `session_is_subagent_by_id` does not exist.

- [ ] **Step 2: Implement**

In `crates/freshell-sessions/src/parse/opencode.rs`, next to `session_exists_by_id` (~421):

```rust
/// Classify a session id as SUBAGENT (`parent_id IS NOT NULL`) via a single
/// indexed row lookup — the classification behind the sidebar rail's
/// subagent-terminal filtering (never used for association decisions; the
/// locator's candidate SQL keeps its own `parent_id IS NULL` refusal).
///
/// - `Ok(None)`: DB file missing (opencode never ran here) or no matching row;
/// - `Ok(Some(true))`: row exists with a parent (subagent/child session);
/// - `Ok(Some(false))`: root row, or a legacy schema without `parent_id`
///   (every session is a root there);
/// - `Err`: ANY read failure — callers must treat as "unknown", never
///   "subagent" (a lock-contention misclassification would hide a real
///   user session from the rail).
pub fn session_is_subagent_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<bool>, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|e| OpencodeReadError(e.to_string()))?;

    // PRAGMA table_info(session) -> hasParentId (same guard as run_opencode_query_inner).
    let has_parent_id = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let mut found = false;
        for name in names {
            if name.map_err(|e| OpencodeReadError(e.to_string()))? == "parent_id" {
                found = true;
            }
        }
        found
    };

    if !has_parent_id {
        return match conn.query_row(
            "SELECT 1 FROM session WHERE id = ?1",
            rusqlite::params![session_id],
            |_| Ok(()),
        ) {
            Ok(()) => Ok(Some(false)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(OpencodeReadError(e.to_string())),
        };
    }

    match conn.query_row(
        "SELECT parent_id FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |row| row.get::<_, Option<String>>(0),
    ) {
        Ok(parent) => Ok(Some(parent.is_some())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}
```

Re-export in `crates/freshell-sessions/src/parse/mod.rs` alongside the existing `session_exists_by_id` re-export (line ~14): add `session_is_subagent_by_id` to the same `pub use` list.

In `crates/freshell-sessions/src/opencode_locator.rs`: the locator does NOT retain the data home today — both constructors (`new` at :150, `with_config` at :156) consume `data_home` straight into `OpencodeProvider::new(...)` (:158), the struct's fields (:129-144) don't include a path, and the provider's `home_dir` is itself private with no accessor (`parse/opencode.rs:243-248`). So first:

1. Add a private field to the struct definition: `data_home: PathBuf,` (alongside `provider`).
2. Set it in BOTH constructors: clone the incoming `data_home` into the new field before handing the original to `OpencodeProvider::new`. Constructor SIGNATURES are unchanged — zero call-site churn (e.g. the ws crate's `state_with_locator` fixture, which calls `OpencodeLocator::new(data_home)` at `opencode_association.rs:302`, keeps compiling untouched).

Then add to `impl OpencodeLocator`:

```rust
    /// Best-effort resume-target classification for the sidebar rail:
    /// `Some(true)` when the target row exists and has a parent (subagent),
    /// `Some(false)` for a definite root, `None` when unknown (missing
    /// DB/row, read error). Bounded by the 500ms by-id busy timeout; never
    /// panics. This is a READ for display classification only — it does not
    /// participate in association (the candidate SQL keeps refusing
    /// `parent_id` rows by design).
    pub fn classify_resume_target(&self, session_id: &str) -> Option<bool> {
        crate::parse::session_is_subagent_by_id(&self.data_home, session_id)
            .ok()
            .flatten()
    }
```

Add an inline test to the existing `mod tests` in `opencode_locator.rs` (its fixtures `open_seed_db`/`insert_session` at ~405-456 already support `parent_id`):

```rust
    #[test]
    fn classify_resume_target_answers_child_root_unknown() {
        let home = unique_temp_dir("classify");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());
        insert_session(&db, "ses_root", "/proj", 100, None, None);
        insert_session(&db, "ses_child", "/proj", 150, Some("ses_root"), None);

        assert_eq!(locator.classify_resume_target("ses_child"), Some(true));
        assert_eq!(locator.classify_resume_target("ses_root"), Some(false));
        assert_eq!(locator.classify_resume_target("ses_missing"), None);
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 3: Run to verify pass**

Run: `cargo test -p freshell-sessions`
Expected: PASS (new by-id tests, locator test, and all pre-existing tests — especially `row_with_parent_id_is_never_a_candidate`, which must stay green untouched).

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/src/parse/mod.rs crates/freshell-sessions/src/opencode_locator.rs crates/freshell-sessions/tests/opencode_subagent_by_id.rs
git commit -m "feat(opencode): add parent_id subagent classification lookup + locator helper on Rust (Bug 1)"
```

---

### Task 6: Rust — Bug 1b: identity `is_subagent` flag, classified at every resume-target acquisition (create, respawn, signal rebind, REST bind)

**Files:**
- Modify: `crates/freshell-ws/src/identity.rs` (`TerminalIdentity` struct at ~34-44; upsert preserve semantics; new setter)
- Modify: `crates/freshell-ws/src/opencode_association.rs` (new `classify_and_mark_resume_target`)
- Modify: `crates/freshell-ws/src/terminal.rs` (call sites after the create `set_meta` at ~2799-2806 and the auto-resume respawn `set_meta` at ~3498-3507; make `broadcast_terminals_changed` `pub(crate)`)
- Modify: `crates/freshell-ws/src/opencode_signal.rs` (hook site #3: `rebind_fanout` at :399-437 and the (0b) retired-rebind branch at ~:508)
- Modify: `crates/freshell-ws/src/pane_identity_binder.rs` (hook site #4: classifier injected into `LedgerPaneIdentityBinder`; classification after the `:110` upsert in `register_create_identity`)
- Modify: `crates/freshell-server/src/main.rs` (move the `opencode_locator` creation block from :433-437 up above the `fresh_agent_state` builder chain at :305-318, then wire the classifier into the binder construction at :314-317 — see Step 6.3)
- Test: inline `#[cfg(test)]` additions in `identity.rs`, `opencode_association.rs`, `opencode_signal.rs`, and `pane_identity_binder.rs`

**Interfaces:**
- Consumes: `OpencodeLocator::classify_resume_target(&self, session_id: &str) -> Option<bool>` (Task 5); the locator handle already held by `opencode_association.rs`'s `drain_and_associate`/`maybe_arm` (reuse the exact same field/handle those functions read from `WsState` — grep `locator` in that file); `broadcast_terminals_changed(state: &WsState)` in `terminal.rs` (currently private — widen to `pub(crate)`).
- Produces:
  - `TerminalIdentity.is_subagent: Option<bool>` (new field; `None` = unclassified). The flag is NOT immutable: it is recomputed at every resume-target acquisition/change — WS create, auto-resume respawn, signal rebind, REST bind.
  - `TerminalIdentityRegistry::set_is_subagent(&self, terminal_id: &str, value: Option<bool>)` — sets the flag on an existing entry, or creates a minimal entry (`terminal_id`, `is_subagent`, `updated_at = now`, everything else `None`/`false`) when none exists.
  - `upsert(...)` PRESERVES an existing entry's `is_subagent` (it does not gain an `is_subagent` parameter). IMPORTANT: this preserve contract does NOT exist today — `upsert` is a blind `map.insert` (`identity.rs:73-84`) — so Task 6 CREATES it via a get-mutate-or-insert restructure that must preserve the two pinned behaviors: un-retire-on-reseed (existing test `upsert_over_a_retired_entry_un_retires_it`, `identity.rs:322-331`) and full replacement of provider/session_id/cwd/updated_at (the signal rebinds depend on replacement — `opencode_signal.rs:399-405`, `:508-514`).
  - `pub(crate) fn classify_and_mark_resume_target(state: &WsState, terminal_id: &str, mode: &str, resume_session_id: Option<&str>)` in `opencode_association.rs` — no-op unless `mode == "opencode"` and a resume id is present; spawns a tokio task that runs the SQLite read via `spawn_blocking` (the `drain_and_associate` precedent at `opencode_association.rs:86-104`), and writes the classified value in BOTH directions — for any `Some(true)`/`Some(false)` answer it calls `state.identity.set_is_subagent(terminal_id, Some(value))` (never only-when-true — rebinds must be able to CLEAR a stale flag when the new target is a root) then `crate::terminal::broadcast_terminals_changed(&state)` so clients refetch `/api/terminals`. `None` (unknown/missing/error) writes nothing. (When the reconcile gate has cleared a definitively-absent id to `None`, no resume id reaches the hook and it simply no-ops — existing behavior, keep.)
  - `LedgerPaneIdentityBinder` gains an injected classifier at construction (the shared `OpencodeLocator` or an `Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>` closure wrapping Task 5's `classify_resume_target`) — the binder seam has no `WsState` (`pane_identity_binder.rs:14-18`), so it cannot call `classify_and_mark_resume_target`.

**Hook-site completeness (verified by exhaustive enumeration):** with the four hook sites in this task — WS create (`terminal.rs:2908` seed), auto-resume respawn (`respawn_agent_terminal`, seed upsert at `terminal.rs:3562`), signal rebind lane (`opencode_signal.rs:399`/`:508`), and the REST/fresh-agent binder (`pane_identity_binder.rs:111`) — every production identity-seed path carrying an opencode resume target is covered; the only other lane, locator association, fresh-mints ids only and skips resume-bound panes (`opencode_association.rs:127`).

- [ ] **Step 1: Write the failing identity tests**

In `crates/freshell-ws/src/identity.rs`'s existing `#[cfg(test)] mod tests` (add one if none exists, using the registry's public constructor):

```rust
    #[test]
    fn set_is_subagent_creates_minimal_entry_and_upsert_preserves_it() {
        let registry = TerminalIdentityRegistry::new();

        // Setter on a terminal with no identity entry yet: creates minimal entry.
        registry.set_is_subagent("t-sub", Some(true));
        assert_eq!(registry.get("t-sub").unwrap().is_subagent, Some(true));

        // A later upsert (association writes provider/session) must PRESERVE it.
        registry.upsert("t-sub", Some("opencode"), Some("ses_x"), Some("/repo"), 1_000);
        let identity = registry.get("t-sub").unwrap();
        assert_eq!(identity.is_subagent, Some(true));
        assert_eq!(identity.provider.as_deref(), Some("opencode"));

        // Unclassified terminals stay None.
        registry.upsert("t-plain", Some("opencode"), Some("ses_y"), Some("/repo"), 1_000);
        assert_eq!(registry.get("t-plain").unwrap().is_subagent, None);
    }
```

(Adjust the `upsert` argument list to the function's exact existing signature — do NOT change that signature; the test exercises preserve-on-update semantics.)

Run: `cargo test -p freshell-ws set_is_subagent_creates_minimal_entry_and_upsert_preserves_it -- --exact`
Expected: FAIL to compile — no `is_subagent` field / no `set_is_subagent`.

- [ ] **Step 2: Implement the identity flag**

In `crates/freshell-ws/src/identity.rs`:

1. Add to `TerminalIdentity` (after `retired: bool`):
```rust
    /// `Some(true)` when this terminal's resume target is an opencode
    /// SUBAGENT (child) session — display classification for the sidebar
    /// rail (`showSubagents` filter). `None` = unclassified. Recomputed
    /// whenever the resume target changes (create, respawn, signal rebind,
    /// REST bind); preserved across plain upserts. Never consulted by
    /// association logic.
    pub is_subagent: Option<bool>,
```
2. Restructure `upsert` (TODAY a blind `map.insert` at `identity.rs:73-84` — the preserve contract does not exist yet; this step CREATES it) into get-mutate-or-insert: when an entry exists, overwrite `provider`/`session_id`/`cwd`/`updated_at`, set `retired = false`, and carry `is_subagent` forward UNCHANGED; when none exists, insert a fresh entry with `is_subagent: None`. Two pinned behaviors must survive the restructure: un-retire-on-reseed (existing test `upsert_over_a_retired_entry_un_retires_it`, `identity.rs:322-331`) and full field replacement (the signal rebinds upsert a NEW session_id over the old one — `opencode_signal.rs:399-405`, `:508-514` — and depend on replacement). Initialize `is_subagent: None` in any other `TerminalIdentity` construction inside this file.
3. Add the setter to the registry impl:
```rust
    /// Set the subagent display classification. Creates a minimal entry when
    /// the terminal has no identity yet (classification can land before the
    /// first provider/session upsert); otherwise patches the existing entry
    /// in place without touching provider/session/cwd.
    pub fn set_is_subagent(&self, terminal_id: &str, value: Option<bool>) {
        // Follow this registry's existing lock/entry idiom (same as upsert):
        // get-or-insert the entry keyed by terminal_id, set entry.is_subagent = value,
        // and bump entry.updated_at with the same now-source upsert uses.
    }
```
(Write the body using the file's existing map/lock pattern — the comment describes the exact required behavior; the test from Step 1 pins it.)

Run the Step 1 test again. Expected: PASS. Then run `cargo test -p freshell-ws` and fix any struct-literal sites elsewhere in the crate that now miss `is_subagent` (initialize `None`).

- [ ] **Step 3: Write the failing classification-hook test**

In `crates/freshell-ws/src/opencode_association.rs`'s existing `#[cfg(test)] mod tests` (schema fixture `open_seed_db` at :338-358 — its `session` table already HAS a `parent_id` column — and state builders already exist; follow the `drain_and_associate` test's state construction at ~447-536).

FIXTURE WIDENING FIRST (required — the test below cannot compile without it): this file's `insert_session` (:360-374) takes only 4 arguments `(conn, id, cwd, time_created)` and hardcodes `parent_id`/`time_archived` as NULL literals in its SQL text, so it cannot seed a child session. Widen it to the exact 6-argument signature its `opencode_locator.rs` twin already has — `insert_session(conn, id, cwd, time_created, parent_id: Option<&str>, time_archived: Option<i64>)` (`opencode_locator.rs:428-435`) — binding the two new parameters instead of the NULL literals, and update its three existing call sites in this file (:488, :598, :693) to pass `, None, None`. Then add the test:

```rust
    #[tokio::test]
    async fn classify_and_mark_resume_target_flags_child_targets() {
        let home = unique_temp_dir_for_assoc("classify-mark");
        let db = open_seed_db(&home);
        insert_session(&db, "ses_root", "/proj", 100, None, None);
        insert_session(&db, "ses_child", "/proj", 150, Some("ses_root"), None);
        let (state, mut rx) = /* the same WsState builder the drain_and_associate
                                 test uses, wired to `home` as the opencode data home */;

        // Child target -> identity flagged + terminals.changed ping.
        classify_and_mark_resume_target(&state, "t-child", "opencode", Some("ses_child"));
        // The work is spawned; poll for the identity write (bounded).
        for _ in 0..100 {
            if state.identity.get("t-child").and_then(|i| i.is_subagent) == Some(true) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            state.identity.get("t-child").and_then(|i| i.is_subagent),
            Some(true)
        );
        let mut saw_changed = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains("terminals.changed") {
                saw_changed = true;
            }
        }
        assert!(saw_changed, "expected a terminals.changed ping after classification");

        // Root target -> classified Some(false), written BOTH directions so a
        // rebind can CLEAR a stale true (pre-seed true to prove the clear).
        state.identity.set_is_subagent("t-root", Some(true));
        classify_and_mark_resume_target(&state, "t-root", "opencode", Some("ses_root"));
        for _ in 0..100 {
            if state.identity.get("t-root").and_then(|i| i.is_subagent) == Some(false) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            state.identity.get("t-root").and_then(|i| i.is_subagent),
            Some(false)
        );

        // Non-opencode / no-resume -> no-op.
        classify_and_mark_resume_target(&state, "t-shell", "shell", Some("ses_child"));
        classify_and_mark_resume_target(&state, "t-fresh", "opencode", None);
        let _ = std::fs::remove_dir_all(&home);
    }
```

(Fill the state-builder line from the sibling test verbatim; if the sibling helpers have different names, use those. The assertions are the contract.)

Run: `cargo test -p freshell-ws classify_and_mark_resume_target_flags_child_targets -- --exact`
Expected: FAIL to compile — function does not exist.

- [ ] **Step 4: Implement the hook + call sites**

1. In `crates/freshell-ws/src/terminal.rs`: change `fn broadcast_terminals_changed(state: &WsState)` (~3792-3813) to `pub(crate) fn broadcast_terminals_changed(state: &WsState)`.
2. In `crates/freshell-ws/src/opencode_association.rs`, add:
```rust
/// Bug-1 (sidebar rail): classify a resume target at the moment a `ses_` id
/// is acquired or CHANGES (WS create, auto-resume respawn, signal rebind),
/// and mark the terminal identity so the directory projections
/// (`/api/terminals`, session-directory live items) can expose it. The write
/// goes BOTH directions (Some(true) AND Some(false)) so a rebind to a root
/// session clears a stale flag. Display classification only — association
/// keeps refusing `parent_id` rows via its candidate SQL, untouched.
///
/// Fire-and-forget: the one-row SQLite read runs on the blocking pool (the
/// drain_and_associate precedent) and any failure classifies as "unknown"
/// (no write), so terminal creation is never blocked or failed by this.
pub(crate) fn classify_and_mark_resume_target(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    resume_session_id: Option<&str>,
) {
    if mode != "opencode" {
        return;
    }
    let Some(session_id) = resume_session_id.map(str::to_string) else {
        return;
    };
    let state = state.clone();
    let terminal_id = terminal_id.to_string();
    tokio::spawn(async move {
        // Reuse the SAME locator handle drain_and_associate reads from state
        // (grep `locator` in this file for the field name).
        let locator = state.opencode_locator.clone();
        let classified =
            tokio::task::spawn_blocking(move || locator.classify_resume_target(&session_id))
                .await
                .ok()
                .flatten();
        if let Some(value) = classified {
            // BOTH directions: Some(true) flags, Some(false) clears a stale
            // flag after a rebind to a root session. None (unknown) writes
            // nothing.
            state.identity.set_is_subagent(&terminal_id, Some(value));
            // Ping clients to refetch /api/terminals with the new flag. This
            // is a standalone lifecycle ping — NOT inserted between the pinned
            // `terminal.session.associated` -> `terminal.meta.updated` pair
            // (codex_identity.rs:234-237 ordering contract).
            crate::terminal::broadcast_terminals_changed(&state);
        }
    });
}
```
   (`state.opencode_locator` is illustrative — substitute the actual `WsState` field `drain_and_associate` uses to reach the `OpencodeLocator`. If the locator is not directly cloneable, wrap the read the same way `drain_and_associate`'s `spawn_blocking` block does at `opencode_association.rs:86-104`.)
3. In `crates/freshell-ws/src/terminal.rs`, immediately AFTER the create-path `set_meta` (lines 2799-2806), add:
```rust
    // Bug-1 (sidebar rail): classify an opencode resume target as
    // subagent/root off the dispatch path. No-op for fresh panes and other
    // modes.
    crate::opencode_association::classify_and_mark_resume_target(
        state,
        &terminal_id,
        &mode,
        resume_session_id.as_deref(),
    );
```
4. Same call immediately after the auto-resume respawn `set_meta` (~3498-3507), with that scope's variable names.

These are hook sites #1 (WS create) and #2 (auto-resume respawn). Steps 5 and 6 add the remaining two production hook sites.

- [ ] **Step 5: Hook site #3 — signal rebind lane (`opencode_signal.rs`)**

Why: the signal rebind lane accepts child ids (ZERO `parent_id` references anywhere in its guard ladder — the only session-id validation is shape, `is_valid_opencode_session_id` at `opencode_signal.rs:70-73`) and writes `identity.upsert` + `set_meta` post-create. Without this hook, a TUI session-switch INTO a child session leaves the terminal visible on the rail (the bug persists), and a switch OUT of a child leaves it wrongly hidden (preserve semantics keep the stale flag).

First write the failing test. Add to `crates/freshell-ws/tests/opencode_switch_rebind.rs`, mirroring the existing `tui_switch_signal_rebinds_and_restart_resumes_the_new_id` test (:437) — reuse its exact helpers (`spawn_server_returning_state`, `write_opencode_signal`, `send_create`, frame-wait helpers) and extend the seeded opencode.db with a root + child row (parent_id = root):

```rust
#[tokio::test]
async fn tui_switch_signal_reclassifies_is_subagent_in_both_directions() {
    // Setup: copy tui_switch_signal_rebinds_and_restart_resumes_the_new_id's
    // scaffolding; seed the isolated opencode.db with 'ses_switchroot'
    // (parent_id NULL) and 'ses_switchchild' (parent_id = 'ses_switchroot').
    // Create an opencode terminal resuming ses_switchroot, then:

    // 1) signal a switch to the CHILD id -> flag becomes Some(true).
    //    (write_opencode_signal(root, &terminal_id, 1, "ses_switchchild"),
    //     drain, then poll state.identity bounded like the sibling test polls
    //     its frames)
    //    assert_eq!(state.identity.get(&terminal_id).and_then(|i| i.is_subagent), Some(true));

    // 2) signal a switch back to the ROOT id -> flag becomes Some(false)
    //    (the clearing direction — a stale true must not keep hiding the pane).
    //    assert_eq!(state.identity.get(&terminal_id).and_then(|i| i.is_subagent), Some(false));
}
```

(The comment block describes the required scenario — inline it as real code copied from the sibling test's structure; the two `assert_eq!` lines are the contract. Bounded polling, not fixed sleeps, per the file's idiom.)

Run: `cargo test -p freshell-ws --test opencode_switch_rebind tui_switch_signal_reclassifies_is_subagent_in_both_directions -- --exact`
Expected: FAIL — the flag stays `None`/stale.

Then implement in `crates/freshell-ws/src/opencode_signal.rs`:

1. Inside `rebind_fanout` (:399-437), after the `state.identity.upsert(...)` + `state.registry.set_meta(...)` pair, add:
```rust
    // Bug-1 (sidebar rail): the resume target just changed — re-classify the
    // newly bound session id (both directions; a switch back to a root
    // session must clear a stale subagent flag).
    crate::opencode_association::classify_and_mark_resume_target(
        state,
        &sig.terminal_id,
        "opencode",
        Some(&sig.session_id),
    );
```
2. The same call in the (0b) retired-pane rebind branch (~:508), after its `identity.upsert` (before the re-`retire`), with that scope's variable names.

**PLACEMENT CAVEAT (do not skip):** this lane no-ops when the identity already carries the signal's session id (same-id short-circuit at `opencode_signal.rs:494-496`) — so this hook does NOT cover REST-created terminals, whose identity is already bound to the requested id before the TUI plugin's first signal arrives. That is exactly what hook site #4 (Step 6) is for.

Run the test again. Expected: PASS.

- [ ] **Step 6: Hook site #4 — REST/fresh-agent binder (`pane_identity_binder.rs`)**

Why: `LedgerPaneIdentityBinder::register_create_identity` (`crates/freshell-ws/src/pane_identity_binder.rs:109-122`) seeds identity with the RAW child id for ALL REST spawn lanes — `POST /api/tabs`, `/api/panes/:id/split`, and `/api/panes/:id/respawn` all funnel through `spawn_terminal_pane`'s single binder call at `terminal_tabs.rs:1973` — and never enters WS `terminal.create`. This lane is production-reachable via MCP `new-tab`/`split-pane`/`respawn-pane` and the CLI, which accept arbitrary `ses_` ids today. The binder seam has no `WsState` (`pane_identity_binder.rs:14-18`), so it gets an injected classifier instead of calling `classify_and_mark_resume_target`.

First write the failing test. Add a sibling next to `register_create_identity_writes_identity_row_and_binding` (`pane_identity_binder.rs:214`), reusing its `binder(...)` fixture but constructing the binder with a real classifier over a seeded opencode.db (same rusqlite temp-db seeding idiom as Task 5's tests: `ses_root` with `parent_id NULL`, `ses_child` with `parent_id = 'ses_root'`):

```rust
    #[test]
    fn register_create_identity_classifies_opencode_resume_targets() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // Build the binder as in `binder(...)` but pass a classifier wrapping
        // Task 5's classify_resume_target over a temp data home seeded with
        // ses_root (parent_id NULL) and ses_child (parent_id = 'ses_root').
        b.register_create_identity("t-rest-child", "opencode", Some("ses_child"), Some("/tmp"), Some("req-c"));
        assert_eq!(
            identity.get("t-rest-child").and_then(|i| i.is_subagent),
            Some(true),
            "REST-created child-target terminal must be classified"
        );
        b.register_create_identity("t-rest-root", "opencode", Some("ses_root"), Some("/tmp"), Some("req-r"));
        assert_eq!(
            identity.get("t-rest-root").and_then(|i| i.is_subagent),
            Some(false),
            "definite root classifies Some(false) (both-directions semantics)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
```

(Follow the sibling test's exact fixture/variable names; the assertions are the contract — `Some(false)` for the root case matches the both-directions semantics chosen for every hook in this task.)

Run: `cargo test -p freshell-ws register_create_identity_classifies_opencode_resume_targets -- --exact`
Expected: FAIL — no classifier parameter exists / flag stays `None`.

Then implement:

1. `LedgerPaneIdentityBinder` (`pane_identity_binder.rs:26-34`): add a field `classify_resume_target: Option<Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>>` and extend `new(...)` to take it (update the existing test fixture `binder(...)` to pass `None` where classification is irrelevant).
2. In `register_create_identity`, immediately after the `:110` `self.identity.upsert(...)`, add:
```rust
        // Bug-1 (sidebar rail): classify the REST resume target. This call
        // site already runs inside the caller's spawn_blocking
        // (terminal_tabs.rs:1973), so the one-row SQLite read is off the
        // async path. Log-only on error / no ping — this seam has no
        // WsState (matching its existing degradation policy); the flag is
        // set before the create response returns, ahead of any client
        // refetch.
        if mode == "opencode" {
            if let Some(classify) = self.classify_resume_target.as_ref() {
                if let Some(value) = classify(session_id) {
                    self.identity.set_is_subagent(terminal_id, Some(value));
                }
            }
        }
```
3. Wire it at construction in `crates/freshell-server/src/main.rs`. ORDERING FIX REQUIRED: the binder is built as an inline temporary inside the `fresh_agent_state` builder chain (:305-318; `LedgerPaneIdentityBinder::new(terminal_identity.clone(), Arc::clone(&pane_ledger))` at :314-317), but `opencode_locator` is created ~120 lines LATER (:433-437) — wiring it in place would be a use-before-definition and would not compile. First MOVE the `opencode_locator` creation block (the `let opencode_locator: Option<Arc<OpencodeLocator>> = ...` built from `default_opencode_data_home()`) up above the `fresh_agent_state` builder chain (above :305). The move is dependency-free: its only input is the zero-arg free function `default_opencode_data_home()`, and nothing in the span between :305 and its old position reads it (that span only builds registry config, the liveness closure, tabs, extension registry, and shutdown/revision plumbing); its downstream consumers (`with_opencode_locator` at ~:453, the `WsState` literal at ~:756, the sweep-spawn guard at ~:1024-1030) all sit after both positions and keep working unchanged. Then, in the binder construction, pass the classifier by MAPPING the `Option` (the local is `Option<Arc<OpencodeLocator>>`, not a bare locator):

```rust
opencode_locator.as_ref().map(|locator| {
    let locator = Arc::clone(locator);
    Arc::new(move |sid: &str| locator.classify_resume_target(sid))
        as Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>
})
```

which yields exactly the binder's new `Option<Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>>` parameter (`None` when the locator is disabled — REST-lane classification simply stays off, matching the seam's existing degradation policy).

Run the test again. Expected: PASS.

- [ ] **Step 7: Run to verify pass**

Run: `cargo test -p freshell-ws`
Expected: PASS — the new tests plus all pre-existing association/broadcast/signal tests (including the exact-frame `broadcast_emits_legacy_wire_shape` at `terminal.rs:5639`, which is untouched because `TerminalMetaRecord` is unchanged). Also `cargo build -p freshell-server` (the main.rs wiring compiles).

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-ws/src/identity.rs crates/freshell-ws/src/opencode_association.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/src/pane_identity_binder.rs crates/freshell-ws/tests/opencode_switch_rebind.rs crates/freshell-server/src/main.rs
git commit -m "feat(ws): classify opencode subagent resume targets on the terminal identity (Bug 1)"
```

---

### Task 7: Rust — Bug 1c: project the classification on `/api/terminals` and the session-directory live item

**Files:**
- Modify: `crates/freshell-server/src/terminals.rs` (`directory_items` at 634-740; check `list_terminals` 395-530 for the paged branch)
- Modify: `crates/freshell-server/src/session_directory.rs` (`build_live_terminal_session_item` at 786-819, line 808)
- Test: `crates/freshell-server/src/terminals.rs` (`mod sidebar_projection_tests` at ~1197)
- Test: `crates/freshell-server/src/session_directory.rs` (`mod join_tests` at ~851)

**Interfaces:**
- Consumes: `TerminalIdentity.is_subagent: Option<bool>` via `TerminalsState.identity: TerminalIdentityRegistry` (already on the state, `terminals.rs:76-98`) and the `identity: &TerminalIdentity` parameter of `build_live_terminal_session_item`.
- Produces:
  - `/api/terminals` items carry `"resumeTargetIsSubagent": true` ONLY when the terminal's identity says `Some(true)` (omitted otherwise) — on BOTH the bare-array and the paged (`?priority=`) response branches (the sidebar fetches the paged form).
  - Session-directory live-terminal items: `is_subagent` mirrors the identity flag (wire `isSubagent: true` via the existing `DirItem::to_value` emission at `session_directory.rs:168-170`).

**Cascade note (V2 — for implementers AND reviewers):** once fabricated live session-directory items carry `isSubagent: true`, the client's DEFAULT session-directory fetch (`includeSubagents` falsy — `sessionsThunks.ts:316`) may exclude them SERVER-SIDE; any such terminal then surfaces (if at all) as a tab/pane-derived FALLBACK row on the client, which Task 8's fallback-row extension classifies. BOTH branches yield "hidden" — the desired outcome — so do NOT treat disappearing live items as a regression. Consequence for tests: any positive assertion that a FLAGGED live item is present in a session-directory ENDPOINT response must pass `includeSubagents=1` on the request (otherwise the server may filter it out and the test asserts on an absence caused by the filter, not the projection). This task's Step 3 live-item test is a unit test on `build_live_terminal_session_item` (no endpoint), so it is unaffected; negative/default-visibility assertions stay as they are.

- [ ] **Step 1: Write the failing `/api/terminals` projection test**

In `crates/freshell-server/src/terminals.rs`, inside `mod sidebar_projection_tests` (~1197 — follow its existing state/registry/identity seeding idiom exactly; it already builds a `TerminalsState`, seeds registry terminals, seeds the identity registry, and asserts on `directory_items`/route JSON):

```rust
    #[tokio::test]
    async fn directory_item_carries_resume_target_is_subagent_only_when_flagged() {
        // Follow the sibling test's setup: build TerminalsState with a registry
        // containing two running opencode terminals ("t-sub", "t-root").
        // Then flag one:
        state.identity.set_is_subagent("t-sub", Some(true));

        let items = directory_items(&state).await;
        let sub = items
            .iter()
            .find(|i| i["terminalId"] == "t-sub")
            .expect("t-sub present");
        assert_eq!(sub["resumeTargetIsSubagent"], serde_json::json!(true));

        let root = items
            .iter()
            .find(|i| i["terminalId"] == "t-root")
            .expect("t-root present");
        assert!(
            root.get("resumeTargetIsSubagent").is_none(),
            "unflagged terminals must OMIT the key (undefined-omitted convention)"
        );
    }
```

Run: `cargo test -p freshell-server directory_item_carries_resume_target_is_subagent_only_when_flagged -- --exact`
Expected: FAIL — key absent on `t-sub`.

- [ ] **Step 2: Implement the `/api/terminals` projection**

In `directory_items` (`terminals.rs:634-740`), inside the `.map(|e| { ... })` closure, BEFORE `e.terminal_id` is moved into the object (i.e., near the top of the closure), add:

```rust
            // Bug-1 (sidebar rail): additive, omitted-when-absent flag (the
            // server_messages.rs:1099-1102 additive-field precedent). Pure
            // in-memory read — no new I/O on this request path.
            let resume_target_is_subagent = state
                .identity
                .get(&e.terminal_id)
                .and_then(|i| i.is_subagent)
                == Some(true);
```

and after the `obj.insert("hasClients", ...)` line:

```rust
            if resume_target_is_subagent {
                obj.insert("resumeTargetIsSubagent".into(), Value::Bool(true));
            }
```

Then inspect `list_terminals` (395-530): if the paged read-model branch (the `{items, nextCursor, revision}` response at ~524-529) builds its items through a DIFFERENT function than `directory_items`, apply the identical two edits there; if it reuses `directory_items`, no further change. Extend the Step 1 test (or add a sibling) to hit the route with `?priority=visible` and assert the flagged item appears in the paged response's `items` — the sidebar consumes this form:

```rust
        // Paged branch (what the sidebar actually fetches):
        // GET /api/terminals?priority=visible via the router, then assert the
        // same two facts on body["items"] — follow the sibling route-level
        // test's oneshot idiom in this module.
```

Run the tests again. Expected: PASS.

- [ ] **Step 3: Write the failing live-item test**

In `crates/freshell-server/src/session_directory.rs`, inside `mod join_tests` (~851 — next to `build_live_terminal_session_item_with_session_id_is_not_live_terminal_only` at ~924, reusing its `TerminalIdentity` construction idiom):

```rust
    #[test]
    fn live_terminal_item_mirrors_identity_subagent_flag() {
        let mut identity = /* the same TerminalIdentity literal the sibling test
                              builds (provider Some("opencode"), session_id Some(...)) */;
        identity.is_subagent = Some(true);
        let item = build_live_terminal_session_item(&identity).expect("item");
        assert!(item.is_subagent, "identity Some(true) must project");
        assert_eq!(item.to_value()["isSubagent"], serde_json::json!(true));

        identity.is_subagent = None;
        let item = build_live_terminal_session_item(&identity).expect("item");
        assert!(!item.is_subagent, "unclassified stays non-subagent");
    }
```

Run: `cargo test -p freshell-server live_terminal_item_mirrors_identity_subagent_flag -- --exact`
Expected: FAIL — `is_subagent` is hardcoded `false`.

- [ ] **Step 4: Implement the live-item projection**

In `build_live_terminal_session_item` (`session_directory.rs:786-819`), change line 808 from:

```rust
        is_subagent: false,
```

to:

```rust
        // Bug-1 (sidebar rail): a live terminal launched at a subagent
        // session projects the classification; the client's existing
        // showSubagents filter (sidebarSelectors.ts:656) then hides it.
        is_subagent: identity.is_subagent.unwrap_or(false),
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p freshell-server`
Expected: PASS (new tests + all pre-existing `join_tests`/`sidebar_projection_tests`/route tests).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/terminals.rs crates/freshell-server/src/session_directory.rs
git commit -m "feat(server): project subagent-target classification on /api/terminals and live session items (Bug 1)"
```

---

### Task 8: Client — Bug 1: classify manufactured AND tab/pane-derived (fallback) live-terminal rail entries

**Files:**
- Modify: `src/store/types.ts` (`BackgroundTerminal` at 69-81)
- Modify: `src/store/selectors/sidebarSelectors.ts` (sessionRef-bearing terminals loop at ~175-225; `pushFallbackItem` new-item branch at ~336-367; manufacture block at 467-520)
- Test: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` (append)

**Interfaces:**
- Consumes: `resumeTargetIsSubagent?: boolean` on `/api/terminals` items (Tasks 4 & 7) — these land verbatim in `state.terminalDirectory.windows.sidebar.items` (`src/store/terminalDirectoryThunks.ts:87` applies no whitelist) and are passed as the `terminals` array into `buildSessionItems` by `Sidebar.tsx:221-224`.
- Produces: BOTH rail-entry variants the client can mint for a live terminal carry `isSubagent`:
  - Manufactured `SidebarSessionItem`s (the `terminal:<id>` rows) carry `isSubagent: true` when the terminal record is flagged. NOTE the `:469` guard (`if (terminal.sessionRef) continue`): only sessionRef-LESS terminals ever take this block.
  - Tab/pane-derived FALLBACK rows (keyed `opencode:<sessionId>`, minted by `pushFallbackItem` for paned terminals whose pane content carries `sessionRef`) consult the `runningSessionMap` — `RunningSessionInfo` (`sidebarSelectors.ts:128`) gains `resumeTargetIsSubagent?: boolean`, recorded in the `:175-225` loop. This is the LOAD-BEARING half for the production shape (child-target terminals normally carry `sessionRef`).
  - `filterSessionItemsByVisibility` (`sidebarSelectors.ts:656`) then hides both under the default `showSubagents: false`. `SidebarSessionItem.isSubagent` already exists (`sidebarSelectors.ts:38`) — no interface change there.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` (the file already imports `buildSessionItems` / the selector and fakes state via `as unknown as RootState`; follow its existing terminal-array idiom — the existing manufacture test passes `[{ terminalId, title, createdAt, lastActivityAt, status, hasClients, mode, cwd }]`):

```ts
describe('subagent-target live terminals (Bug 1)', () => {
  const subagentTerminal = {
    terminalId: 'term-oc-subagent',
    title: 'opencode --session ses_024e59f87ffeEvZWqgMpBXAo78',
    createdAt: 1_100,
    lastActivityAt: 1_200,
    status: 'running' as const,
    hasClients: true,
    mode: 'opencode' as const,
    cwd: '/repo/live',
    resumeTargetIsSubagent: true,
  }
  const rootTerminal = {
    terminalId: 'term-oc-root',
    title: 'OpenCode',
    createdAt: 1_100,
    lastActivityAt: 1_200,
    status: 'running' as const,
    hasClients: true,
    mode: 'opencode' as const,
    cwd: '/repo/live',
  }

  it('marks the manufactured entry isSubagent when the terminal record is flagged', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal, rootTerminal],
      {},
      'repo',
    )
    const flagged = items.find((i) => i.sessionId === 'terminal:term-oc-subagent')
    expect(flagged?.isSubagent).toBe(true)
    const unflagged = items.find((i) => i.sessionId === 'terminal:term-oc-root')
    expect(unflagged?.isSubagent).toBeUndefined()
  })

  it('hides the flagged entry under default visibility (showSubagents=false) but keeps the root one', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal, rootTerminal],
      {},
      'repo',
    )
    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: false,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    const ids = visible.map((i) => i.sessionId)
    expect(ids).not.toContain('terminal:term-oc-subagent')
    expect(ids).toContain('terminal:term-oc-root')
  })

  it('shows the flagged entry when showSubagents is true (opt-in visibility)', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal],
      {},
      'repo',
    )
    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: true,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    expect(visible.map((i) => i.sessionId)).toContain('terminal:term-oc-subagent')
  })

  it('classifies tab/pane-derived FALLBACK rows for sessionRef-bearing child-target terminals (the load-bearing half)', () => {
    // sessionRef-bearing live terminals NEVER take the manufactured block
    // (sidebarSelectors.ts:469 `if (terminal.sessionRef) continue`); when
    // paned, they surface via pushFallbackItem as an `opencode:<child>` row.
    const CHILD_ID = 'ses_024e59f87ffeEvZWqgMpBXAo78'
    const ROOT_ID = 'ses_rootcontrol000000000000000'
    const makePanedFixture = (tag: string, terminalId: string, sessionId: string) => ({
      tab: {
        id: `tab-${tag}`,
        title: 'OpenCode',
        mode: 'opencode',
        createRequestId: `tab-${tag}`,
        status: 'running',
        createdAt: 1_000,
      },
      layout: {
        type: 'leaf',
        id: `pane-${tag}`,
        content: {
          kind: 'terminal',
          mode: 'opencode',
          terminalId,
          status: 'running',
          sessionRef: { provider: 'opencode', sessionId },
        },
      },
    })
    const child = makePanedFixture('oc-child', 'term-oc-paned-child', CHILD_ID)
    const root = makePanedFixture('oc-root', 'term-oc-paned-root', ROOT_ID)
    const tabs = [child.tab, root.tab] as any
    const panes = {
      layouts: {
        [child.tab.id]: child.layout,
        [root.tab.id]: root.layout,
      },
      activePaneByTabId: {},
      paneTitles: {},
    } as any
    const terminals = [
      {
        terminalId: 'term-oc-paned-child',
        title: `opencode --session ${CHILD_ID}`,
        createdAt: 1_100,
        lastActivityAt: 1_200,
        status: 'running' as const,
        hasClients: true,
        mode: 'opencode' as const,
        cwd: '/repo/live',
        sessionRef: { provider: 'opencode' as const, sessionId: CHILD_ID },
        resumeTargetIsSubagent: true,
      },
      {
        terminalId: 'term-oc-paned-root',
        title: 'OpenCode',
        createdAt: 1_100,
        lastActivityAt: 1_200,
        status: 'running' as const,
        hasClients: true,
        mode: 'opencode' as const,
        cwd: '/repo/live',
        sessionRef: { provider: 'opencode' as const, sessionId: ROOT_ID },
      },
    ]
    // NO matching indexed session for either id (empty projects) -> both
    // become pushFallbackItem rows, not indexed-session rows.
    const items = buildSessionItems([], tabs, panes, terminals, {}, 'repo')
    const fallback = items.find((i) => i.sessionId === CHILD_ID)
    expect(fallback?.isFallback).toBe(true)
    expect(fallback?.isSubagent).toBe(true)
    const rootFallback = items.find((i) => i.sessionId === ROOT_ID)
    expect(rootFallback?.isSubagent).toBeUndefined()

    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: false,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    const ids = visible.map((i) => i.sessionId)
    expect(ids).not.toContain(CHILD_ID)
    expect(ids).toContain(ROOT_ID)
  })
})
```

Adjust the `buildSessionItems` positional args to the file's existing calls (it may pass `paneLastInputAt`; match the surrounding tests exactly). Import `filterSessionItemsByVisibility` from the selectors module alongside the existing imports. Note the fixture-drift warning: use `ignoreCodexSubagents` (the real key), NOT `ignoreCodexSubagentSessions`.

- [ ] **Step 2: Run to verify failure**

```bash
FRESHELL_TEST_SUMMARY="bug1-client-red" npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts --config config/vitest/vitest.config.ts
```
Expected: FAIL — TypeScript rejects `resumeTargetIsSubagent` on the terminal object, and/or `isSubagent` is `undefined` on the flagged entry / the visibility filter keeps it.

- [ ] **Step 3: Implement**

1. `src/store/types.ts` — `BackgroundTerminal` (69-81), add after `codexDurability`:
```ts
  /**
   * Server-computed: this terminal's resume target is an opencode
   * SUBAGENT (child) session. Manufactured rail entries and tab/pane
   * fallback rows copy it into SidebarSessionItem.isSubagent so
   * showSubagents filtering applies.
   */
  resumeTargetIsSubagent?: boolean
```
2. `src/store/selectors/sidebarSelectors.ts` — in the manufacture block's item literal (lines 498-517), add after `isRestorable: false,`:
```ts
      isSubagent: terminal.resumeTargetIsSubagent === true ? true : undefined,
```
   Keep this manufactured-block patch — it covers sessionRef-LESS terminals — but note it is gated by `:469` (`if (terminal.sessionRef) continue`): sessionRef-bearing live terminals (the production shape for child-target terminals) never reach it, which is why the fallback-row extension below is the load-bearing half.
3. `src/store/selectors/sidebarSelectors.ts` — `RunningSessionInfo` (type at :128): add `resumeTargetIsSubagent?: boolean`. In the sessionRef-bearing terminals loop (~:175-225) that builds `runningSessionMap`, record it on the entry: in the `runningSessionMap.set(sessionKey, { ... })` new-entry literal add `resumeTargetIsSubagent: terminal.resumeTargetIsSubagent,` and in the existing-entry merge branch OR-merge it (like `isRestorable`): `existing.resumeTargetIsSubagent = existing.resumeTargetIsSubagent || terminal.resumeTargetIsSubagent`.
4. `src/store/selectors/sidebarSelectors.ts` — in `pushFallbackItem`'s new-item branch (the `SidebarSessionItem` literal at ~:341-366), change the `:357` line from:
```ts
      isSubagent: input.metadata?.isSubagent,
```
   to:
```ts
      isSubagent: input.metadata?.isSubagent
        ?? (runningSessionMap.get(key)?.resumeTargetIsSubagent === true ? true : undefined),
```
   (Adapt to the actual local variable names — the branch already computes `const runningTerminal = runningSessionMap.get(key)`, so `runningTerminal?.resumeTargetIsSubagent` is equivalent and preferred; verified code shape in `reports/V2-a2-a10.md` §6.)

- [ ] **Step 4: Run to verify pass**

Same command as Step 2, plus the sibling selector suites:
```bash
FRESHELL_TEST_SUMMARY="bug1-client-green" npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts --config config/vitest/vitest.config.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/types.ts src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
git commit -m "fix(sidebar): classify subagent-target live terminals so showSubagents hides them (Bug 1)"
```

---

### Task 9: End-to-end Playwright spec (runs against BOTH the Node and Rust servers)

**Files:**
- Create: `test/e2e-browser/specs/sidebar-opencode-rail.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to the `rust-chromium` project's `testMatch` — NOT to `RUST_ONLY_SPECS`, so the default chromium/legacy project also runs it against the Node server)

**Interfaces:**
- Consumes: `createE2eServerHandle(process.env, { kind: e2eServerKind, construct: { env, setupHome } })` from `../helpers/external-target.js`; `TestHarness` (`waitForHarness`, `waitForConnection`, in-page `__FRESHELL_TEST_HARNESS__.sendWsMessage` and `__FRESHELL_TEST_HARNESS__.dispatch` — both exposed by `src/lib/test-harness.ts`); the fake opencode CLI fixture `test/e2e-browser/fixtures/fake-opencode-terminal.mjs`; `info.baseUrl` / `info.token` / `info.homeDir` from `server.start()`; REST auth header `x-auth-token`.
- Produces: user-level proof of both bugs against both servers. No new helpers exported.

- [ ] **Step 1: Write the spec**

Create `test/e2e-browser/specs/sidebar-opencode-rail.spec.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')

const ROOT_ID = 'ses_e2erailroot1'
const CHILD_ID = 'ses_e2erailchild1'
const ROOT_TITLE = 'Rail e2e global root session'
const CHILD_TITLE = 'Rail e2e subagent child session'

async function installFakeOpencodeTerminal(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fs.copyFile(FAKE_OPENCODE_TERMINAL_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

/**
 * Seed the ISOLATED home's opencode.db (`<homeDir>/.local/share/opencode/`,
 * where applyIsolatedHomeEnvironment pins XDG_DATA_HOME — same pattern as
 * opencode-rebind-rust.spec.ts's seedOpencodeSessionRow) with:
 *  - the catch-all "global" project (worktree = '/'),
 *  - a ROOT session in it whose real cwd is `workDir` (Bug 2 subject),
 *  - a CHILD (parent_id = root) session (Bug 1 subject).
 */
async function seedOpencodeDb(homeDir: string, workDir: string): Promise<void> {
  const dataHome = path.join(homeDir, '.local', 'share', 'opencode')
  await fs.mkdir(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );
    `)
    const now = Date.now()
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run('global', '/')
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
       VALUES (?, 'global', NULL, ?, ?, ?, 'rail-e2e-seed', ?, ?, NULL)`,
    ).run(ROOT_ID, ROOT_ID, workDir, ROOT_TITLE, now, now)
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
       VALUES (?, 'global', ?, ?, ?, ?, 'rail-e2e-seed', ?, ?, NULL)`,
    ).run(CHILD_ID, ROOT_ID, CHILD_ID, workDir, CHILD_TITLE, now, now)
  } finally {
    db.close()
  }
}

test.describe('sidebar opencode rail', () => {
  test.setTimeout(240_000)

  test('global-project sessions show their real directory; subagent-target terminals stay off the rail', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-rail-'))
    try {
      const fakeOpencodePath = await installFakeOpencodeTerminal(path.join(sharedRoot, 'bin'))
      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: { OPENCODE_CMD: fakeOpencodePath },
          setupHome: async (homeDir: string) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: { codingCli: { enabledProviders: ['opencode'] } },
            }, null, 2))
            const workDir = path.join(homeDir, 'work', 'timeline')
            await fs.mkdir(workDir, { recursive: true })
            await seedOpencodeDb(homeDir, workDir)
          },
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()

        // ── Bug 2: the root session appears, grouped/badged by its REAL
        // directory leaf ("timeline"), never literal '/'.
        await expect(page.getByText(ROOT_TITLE)).toBeVisible({ timeout: 60_000 })
        await expect(page.getByText('timeline').first()).toBeVisible({ timeout: 30_000 })

        // ── Bug 1 (listing side): the child session itself never appears.
        expect(await page.getByText(CHILD_TITLE).count()).toBe(0)

        // ── Bug 1 (live-terminal side): create a background opencode
        // terminal targeting the CHILD session via the real WS API — the
        // shape orchestration-spawned subagent terminals take.
        await page.evaluate(({ sessionId }) => {
          (window as unknown as { __FRESHELL_TEST_HARNESS__?: { sendWsMessage: (m: unknown) => void } })
            .__FRESHELL_TEST_HARNESS__?.sendWsMessage({
              type: 'terminal.create',
              requestId: `e2e-rail-subagent-${Date.now()}`,
              mode: 'opencode',
              sessionRef: { provider: 'opencode', sessionId },
            })
        }, { sessionId: CHILD_ID })

        // Wire fact: the terminal record carries the classification.
        await expect.poll(async () => {
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          const items = await res.json() as Array<Record<string, unknown>>
          return items.some((t) => t.mode === 'opencode' && t.resumeTargetIsSubagent === true)
        }, { timeout: 60_000 }).toBe(true)

        // User-visible fact: the rail never grows a raw-command / child-id
        // entry for that live terminal.
        await page.waitForTimeout(2_000) // let a terminals.changed refetch land
        expect(await page.getByText(new RegExp(CHILD_ID)).count()).toBe(0)
        expect(await page.getByText(/opencode --session/).count()).toBe(0)

        // ── Bug 1 (paned variant, V2): a child-target terminal that sits in
        // a tab/pane takes the client's FALLBACK-row pathway (sessionRef on
        // the pane content), not the manufactured-row block — assert that
        // pathway hides it too. Create a second child-target terminal, then
        // open it into a tab so the pane content carries sessionRef (the
        // session-resume open shape, tabsSlice.ts:706-717).
        const listTerminalIds = async (): Promise<string[]> => {
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          const items = await res.json() as Array<Record<string, unknown>>
          return items.map((t) => String(t.terminalId))
        }
        const idsBefore = await listTerminalIds()
        await page.evaluate(({ sessionId }) => {
          (window as unknown as { __FRESHELL_TEST_HARNESS__?: { sendWsMessage: (m: unknown) => void } })
            .__FRESHELL_TEST_HARNESS__?.sendWsMessage({
              type: 'terminal.create',
              requestId: `e2e-rail-subagent-paned-${Date.now()}`,
              mode: 'opencode',
              sessionRef: { provider: 'opencode', sessionId },
            })
        }, { sessionId: CHILD_ID })
        let panedTerminalId: string | undefined
        await expect.poll(async () => {
          const idsNow = await listTerminalIds()
          panedTerminalId = idsNow.find((id) => !idsBefore.includes(id))
          return panedTerminalId != null
        }, { timeout: 60_000 }).toBe(true)
        // Open it into a tab/pane via the harness store dispatch (the
        // openSessionTab terminalId branch's resulting state shape). If the
        // harness exposes a higher-level open API, use it instead — the
        // REQUIREMENT is only that the pane content carries
        // `sessionRef: { provider: 'opencode', sessionId: CHILD_ID }`.
        await page.evaluate(({ terminalId, sessionId }) => {
          const harness = (window as unknown as {
            __FRESHELL_TEST_HARNESS__?: { dispatch: (a: unknown) => void }
          }).__FRESHELL_TEST_HARNESS__
          const tabId = `e2e-rail-paned-tab`
          harness?.dispatch({
            type: 'tabs/addTab',
            payload: {
              id: tabId,
              title: 'OpenCode',
              status: 'running',
              mode: 'opencode',
              codingCliProvider: 'opencode',
              sessionRef: { provider: 'opencode', sessionId },
            },
          })
          harness?.dispatch({
            type: 'panes/initLayout',
            payload: {
              tabId,
              content: {
                kind: 'terminal',
                mode: 'opencode',
                terminalId,
                sessionRef: { provider: 'opencode', sessionId },
                status: 'running',
              },
            },
          })
        }, { terminalId: panedTerminalId!, sessionId: CHILD_ID })
        // (Match the real action type strings/payloads of `addTab` and
        // `initLayout` in src/store/tabsSlice.ts / src/store/panesSlice.ts —
        // mirror what openSessionTab dispatches at tabsSlice.ts:706-717.)

        // Re-assert under default visibility: the paned child-target
        // terminal's fallback row never surfaces either.
        await page.waitForTimeout(2_000) // let the rail settle
        expect(await page.getByText(new RegExp(CHILD_ID)).count()).toBe(0)
        expect(await page.getByText(/opencode --session/).count()).toBe(0)
      } finally {
        await server.stop()
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Register the spec for the rust matrix**

In `test/e2e-browser/playwright.config.ts`, add to the `rust-chromium` project's `testMatch` array (NOT to `RUST_ONLY_SPECS` — the default chromium project must also pick it up so the Node server is covered):

```ts
        // Sidebar opencode rail fixes (Bug 1 + Bug 2): runs in BOTH matrix
        // projects — Node parity is part of the fix.
        /sidebar-opencode-rail\.spec\.ts$/,
```

- [ ] **Step 3: Run the spec (both projects)**

```bash
npm run build
npm run test:e2e -- sidebar-opencode-rail
```
Expected: PASS under both `chromium` (Node server) and `rust-chromium` (Rust server) projects. If a locator needs tightening (e.g. `timeline` matching elsewhere), scope assertions to the sidebar's accessible region using role-based locators only — never CSS selectors (repo e2e convention). This spec never touches the live server: `createE2eServerHandle` boots isolated instances on ephemeral ports.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/sidebar-opencode-rail.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): sidebar opencode rail — global-project directory + subagent terminal hiding (both servers)"
```

---

### Task 10: Full-suite verification

**Files:**
- No planned source changes — fix anything these gates surface (each fix gets its own focused commit).

**Interfaces:**
- Consumes: everything above. Produces: a green tree.

- [ ] **Step 1: Rust gates**

```bash
cargo test -p freshell-sessions -p freshell-terminal -p freshell-ws -p freshell-server
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```
Expected: all PASS / clean.

- [ ] **Step 2: Node + client gates (coordinated — wait for the gate, never kill a foreign holder)**

```bash
FRESHELL_TEST_SUMMARY="sidebar-opencode-rail-fixes full suite" npm run check
```
Expected: typecheck clean; full coordinated suite PASS.

- [ ] **Step 3: Commit any straggler fixes**

```bash
git status --short   # should be clean; if fixes were needed, commit them:
git add -A && git commit -m "chore: green the coordinated suite for sidebar-opencode-rail-fixes"
```

---

## Self-Review (performed at plan time)

**1. Spec coverage.**
- Bug 2 Node listing fallback (`opencode.ts:185`) → Task 1. Bug 2 Rust listing (`parse/opencode.rs:341-344`) + by-id (`:555`, the spec's "by-id fallback path") + wire proof → Task 2. (Spec's `session_directory.rs:337-341` attribution was corrected by file:line-verified exploration: the worktree SQL/mapping lives in `parse/opencode.rs`; `session_directory.rs` consumes `project_path` verbatim — the Task 2 wire test pins that consumption.) Client `getLeafDirectoryName('/')` needs no change once servers stop emitting `/`.
- Bug 1 server classification exposure → Tasks 3-7 (Node: query → registry → `/api/terminals`/inventory + `bindSession` re-classification (Task 4 Step 6) + the `shared/ws-protocol.ts`/frozen-schema declaration (Task 4 Step 7); Rust: by-id lookup → identity flag at ALL FOUR production hook sites — WS create, auto-resume respawn (`terminal.rs`), signal rebind lane (`opencode_signal.rs:399`/`:508`), REST/fresh-agent binder (`pane_identity_binder.rs:111`) — verified-complete by exhaustive enumeration (the locator lane fresh-mints only, `opencode_association.rs:127`) → `/api/terminals` + session-directory live item). Client classification + `showSubagents` filtering → Task 8, covering BOTH rail-entry variants the client mints: manufactured `terminal:<id>` rows (sessionRef-less terminals) AND tab/pane-derived fallback rows (sessionRef-bearing paned terminals, via the `runningSessionMap` consult — the load-bearing half, since the `:469` guard keeps sessionRef-bearing terminals out of the manufactured block). "Real user-started sessions must still appear" → root-session control cases in Tasks 4, 5, 6, 7, 8, 9 (including root cases for the rebind/binder hooks and the fallback row). "Do NOT remove the by-design refusal" → Global Constraints + Task 5 Step 3 re-runs `row_with_parent_id_is_never_a_candidate` untouched. "Fix both Node and Rust for parity" → mirrored task pairs + the dual-project e2e (Task 9, including the paned fallback-row variant). The Rust `is_subagent`-means-3-views caution → classification reads `parent_id` directly (Tasks 3/5), never `OpencodeSession.is_subagent`. The Rust `TerminalTitleUpdated` gap → explicit Non-Goal with rationale (not needed for the desired outcome; classification hides the entries).
**1b. No silent deferrals.** Every user-facing outcome has a production path and a real test: Bug 2 is proven at SQL-fixture (unit), HTTP-wire (Task 2 Step 6), and browser (Task 9) levels; Bug 1 at query-unit, registry/projection, selector, and browser levels — including the new pieces: `bindSession` re-classification (unit, Task 4 Step 6), the signal-rebind hook (integration, `opencode_switch_rebind.rs`, both directions), the REST-binder hook (unit, `pane_identity_binder.rs` sibling test with a seeded opencode.db), the fallback-row pathway (selector unit test + the Task 9 paned e2e variant), and the contract regeneration (`npm run test:port` gate). The Playwright spec runs against real spawned Node AND Rust servers with a real seeded opencode.db and the repo's standard fake opencode CLI (the established production-shaped fixture). No stubs stand in for required behavior. No known-limitations bucket used.
**2. Placeholder scan.** Steps that reference sibling-test scaffolding (Task 2 Step 6, Task 4 Step 3, Task 6 Step 3, Task 6 Step 5 — mirrors `tui_switch_signal_rebinds_and_restart_resumes_the_new_id` at `crates/freshell-ws/tests/opencode_switch_rebind.rs:437`, Task 6 Step 6 — sibling of `register_create_identity_writes_identity_row_and_binding` at `pane_identity_binder.rs:214`, Task 7 Steps 1/3) name the exact sibling test/file:line to copy from and give the complete new assertions — the only adaptation allowed is matching existing local helper/builder names, which cannot be known more precisely without freezing brittle line-level duplicates. No TBD/TODO/"handle edge cases" items remain.
**3. Type consistency.** `meaningfulWorktree` (Node) / `meaningful_worktree` (Rust, private) — per-language names, single definition each. `resolveOpencodeDatabasePath(dataHome: string = defaultOpencodeDataHome())` is the single Node DB-path definition (Task 3) — the provider's public `getDatabasePath()` delegates to it and `isOpencodeSubagentSession` defaults through it. `resumeTargetIsSubagent` is the wire + record + protocol (`shared/ws-protocol.ts`) + client-store (`BackgroundTerminal`, `RunningSessionInfo`) name everywhere (Tasks 4, 7, 8, 9). `TerminalIdentity.is_subagent: Option<bool>` + `set_is_subagent` (Task 6) are what Task 7 reads. `session_is_subagent_by_id -> Result<Option<bool>, OpencodeReadError>` (Task 5) is what `classify_resume_target -> Option<bool>` wraps; Task 6 consumes it via the locator in `classify_and_mark_resume_target` (both-directions write semantics) and via the injected binder classifier (`Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>` wrapping the same `classify_resume_target`) — one classifier, two transports. `SidebarSessionItem.isSubagent` is pre-existing and unchanged.
