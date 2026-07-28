# Stale Resume Identity Fix — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make pane↔CLI-session identity *rebindable* mid-session — when the user switches
sessions inside a CLI (codex/claude in-TUI `/resume` both FORK to a new session id), freshell
rebinds the pane's identity everywhere (identity registry, registry meta, durable pane ledger,
rollout tailer, client `sessionRef`) so a server restart resumes the CORRECT session — and fix
the contested-cwd census that permanently starves codex association when ≥2 panes share a cwd.

**Architecture:** Detection uses deterministic lineage signals, never mtime/cwd heuristics:
codex writes `forked_from_id` into the new rollout's `session_meta` (verified on disk:
`019fa613…` child → `forked_from_id: 019fa60f…` parent); claude gets a `SessionStart` hook
(injected via the already-existing `--settings` channel) that writes the current `session_id`
to a per-terminal signal file; amplifier's `events.jsonl` carries `parent_id`/`session:fork`
lineage; opencode uses submit-window row-update correlation on its SQLite substrate (audited
first). The rebind write path reuses the existing adoption tail primitives — `identity.upsert`
is already an unconditional overwrite, `registry.set_meta` overwrites `resume_session_id`, and
`pane_ledger::record_binding_locked` already supersedes+tombstones the old row (`Retired`/
`Superseded`/`supersededBy`). The client accepts a server-authoritative rebind via a new
OPTIONAL `previousSessionId` field on `terminal.session.associated` — the client rebinds only
when the pane's current `sessionRef.sessionId` equals `previousSessionId` (a deterministic
supersession handshake), then `flushPersistedLayoutNow()`.

**Tech Stack:** Rust (crates/freshell-ws, freshell-sessions, freshell-platform,
freshell-protocol), TypeScript client (src/), Node server parity (server/), vitest + cargo test.

## Verified incident facts this plan is built on (do not re-litigate)

- codex in-TUI `/resume` FORKS: new rollout file, new `payload.id`, `forked_from_id` = parent id,
  `thread_source: "user"`, `originator: "codex-tui"`. Launch-time `codex resume <id>` appends to
  the ORIGINAL file. The locator module doc at `crates/freshell-sessions/src/codex_locator.rs:64-67`
  documents the opposite and is FALSE for in-TUI resume.
- claude's in-CLI `/resume` also forks: NEW file, NEW `sessionId`, full parent history COPIED with
  every record's `sessionId` rewritten to the child's; **no lineage field exists on disk** (verified
  by exhaustive key-walk of `~/.claude/projects/`). The only deterministic signal available is a
  `SessionStart` hook (fires on startup/resume/clear with the current `session_id` on stdin).
- Write-once identity is FIVE gates: `codex_locator.rs:174` arm gate, `:375-377` one-shot removal,
  `codex_association.rs:122-128` `terminal_already_bound`, the false doc premise, and the
  `CodexLane` tailer having no re-attach discipline (`activity.rs:163` map entry).
- Contested-cwd census (`codex_locator.rs:267-273`, `:325-330`) counts ALL armed same-cwd terminals
  and refuses forever; live evidence: never-promoted pending markers under
  `~/.freshell/pane-ledger/pending/`.
- Node already rebinds codex on fork via sidecar `thread_fork_response` →
  `SessionBindingAuthority.swapTerminalSession` (`server/session-binding-authority.ts:52-72`,
  called at `server/terminal-registry.ts:2783`). The Rust production server has no sidecar lane in
  the plain-PTY path; the `freshell-codex` `RemoteProxyEvent::Candidate` fork signal has ZERO
  consumers outside that crate — Rust must detect forks from the rollout substrate.
- Node locator audit (P2 parity): Node codex/opencode are `provider_managed`
  (`server/session-association-coordinator.ts:87`) — **no contested-cwd census exists in Node**, so
  there is no Node starvation fix to mirror. Rust-only.
- Rust opencode/amplifier locator audit (P2): `opencode_locator.rs` has NO cross-terminal cwd
  census (only per-terminal ambiguity refusal at `:340-349`); `amplifier_locator.rs` uses a
  first-come `claimed` mutex (`:478`, `:543`), not a refuse-while-contested census. The permanent
  starvation shape is **codex-only**. This satisfies the P2 audit requirement; record it in the
  Task 8 commit message.

## Global Constraints

- Production is the RUST server on port 3002. NEVER restart, stop, or touch the live 3002
  server/pid. Scratch runs: `scripts/launch-rust.sh --port <N>` with N ≠ 3002; integration tests
  use loopback ephemeral ports only (never 3001/3002).
- Work only in this worktree: `/home/dan/code/freshell/.worktrees/stale-resume-identity`
  (branched from origin/main). Red-green-refactor TDD for every task. Frequent, focused commits.
- Do NOT create a PR. Stop after the branch is pushed (the workflow's later stages handle review).
- Coordinated JS test runs only: `npm run test:vitest -- run <path> --config
  config/vitest/vitest.config.ts` (client) or `--config config/vitest/vitest.server.config.ts`
  (server). `cargo test` is NOT coordinator-gated: `cargo test -p <crate> [filter]`.
- WS contract: the ONLY wire change is one OPTIONAL server→client field
  `previousSessionId?: string` on `terminal.session.associated`. Follow the contract process
  exactly: edit `shared/ws-protocol.ts` → `npm run contract:generate` → update
  `crates/freshell-protocol` → commit regenerated `port/contract/*.json` in the same commit →
  `npm run test:port` clean. **Decision: do NOT bump `WS_PROTOCOL_VERSION` (stays 7).**
  Rationale (documented here deliberately; reviewers should treat this as the plan's explicit
  call): the field is additive, optional, server→client only, not Zod-validated by the client
  (old clients ignore it safely, degrading to today's conflict-veto behavior), and a bump
  hard-disconnects every live client ("Please reload the page"). Encode this rationale in the
  Task 1 commit message.
- Do not regress: D7 live-session guards, D8 leases (`SESSION_RESERVED` single-flight), the
  restore spawn gate, create-dedupe, the P0.4 claude restore ladder
  (`terminal.rs:2152-2226`), pane ledger GC/boot_scan, one-writer invariant, and **A13: never two
  live CLIs on one session id**. Every rebind path in this plan guards with
  `registry.live_session_owner(...)` before moving identity.
- Pinned orders that must not change: `adopt_codex_identity` side-effect order (identity.upsert →
  set_meta → ledger (awaited, fsync-before-announce) → broadcast `terminal.session.associated`
  THEN `terminal.meta.updated` → activity hub); ledger supersession order (new bound row FIRST,
  then retire old).
- Prefer deterministic signals (lineage fields, hooks) over mtime/cwd heuristics, everywhere.
- `README.md` remains the only end-user markdown doc; files under `docs/plans/` are working docs.
- Real fixture shapes: model codex fork fixtures on the verified `019fa60f`/`019fa613` pair
  (payload keys: `session_id`, `id`, `forked_from_id`, `timestamp`, `cwd`, `originator:"codex-tui"`,
  `cli_version`, `source:"cli"` (string), `thread_source:"user"`, `model_provider`,
  `base_instructions:{text}`, `history_mode`, `multi_agent_version` (child only),
  `context_window:{window_id}`, `git:{commit_hash,branch,repository_url}` — no `dirty` key).

## File Structure (what changes where)

| Area | File | Responsibility in this plan |
|---|---|---|
| Contract | `shared/ws-protocol.ts` | add optional `previousSessionId` to `TerminalSessionAssociatedMessage` |
| Contract | `port/contract/*.json` | regenerated projections (committed) |
| Contract | `crates/freshell-protocol/src/` (TerminalSessionAssociated struct) | mirror the optional field |
| Client | `src/lib/terminal-session-association.ts` | accept authoritative rebind keyed on `previousSessionId` |
| Client | `test/unit/client/lib/terminal-session-association.test.ts` | rebind acceptance tests |
| Rust locator | `crates/freshell-sessions/src/codex_locator.rs` | probe reads `forked_from_id`; ForkWatch lane; census fix; doc premise fix |
| Rust identity | `crates/freshell-ws/src/codex_identity.rs` | shared guards; `rebind_codex_identity`; broadcast gains `previous_session_id` |
| Rust assoc | `crates/freshell-ws/src/codex_association.rs` | drain fork candidates → rebind; register fork-watch after adopt; fork-submit wiring |
| Rust activity | `crates/freshell-ws/src/activity.rs` | `attach_codex_rollout` re-attach REPLACES the existing `CodexLane` |
| Rust ws | `crates/freshell-ws/src/terminal.rs` | fork-watch arming for resume-launched codex panes; `FRESHELL_TERMINAL_ID` env |
| Rust ledger | `crates/freshell-ws/src/pane_ledger_scan.rs` | orphaned pending-marker GC rule |
| Rust parse | `crates/freshell-sessions/src/parse/codex.rs` | `thread_source == "user"` veto on `forked_from_id`-derived `is_subagent` |
| Rust launch | `crates/freshell-platform/src/cli_launch.rs` (+`cli_launch_goldens.rs`) | claude `SessionStart` hook in `--settings` |
| Rust claude | `crates/freshell-ws/src/claude_signal.rs` (NEW) | signal-file watcher + `rebind_claude_identity` |
| Rust amplifier | `crates/freshell-sessions/src/amplifier_locator.rs`, `crates/freshell-ws/src/amplifier_association.rs` | fork-lineage watch + rebind |
| Rust opencode | `crates/freshell-sessions/src/opencode_locator.rs`, `crates/freshell-ws/src/opencode_association.rs` | audited switch detection + rebind |
| Rust tests | `crates/freshell-ws/tests/codex_fork_rebind.rs` (NEW), `crates/freshell-ws/tests/claude_session_rebind.rs` (NEW) | end-to-end user-story tests |
| Fixtures | `test/fixtures/coding-cli/codex/fork-child-meta.sanitized.jsonl` (NEW) | sanitized real fork-child session_meta |
| Node | `server/index.ts`, `server/terminal-registry.ts` | emit `previousSessionId` on fork-handoff fanout |
| Node tests | `test/unit/server/session-binding-authority.test.ts` | swapTerminalSession coverage (currently zero) |
| Node parse | `server/coding-cli/providers/codex.ts` | mirror the `thread_source` veto (parser parity source) |
| Audit doc | `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md` (NEW) | opencode/amplifier in-TUI switch on-disk findings |

Tasks 1–2 (contract+client) come first so every later server task can assert the full frame.
Tasks 3–7 are the codex P1 spine. Task 8–9 are P2. Task 10 is P5. Tasks 11–12 are P4.
Tasks 13–14 are P3. Task 15 is P6. Task 16 is the final verification gate.

---

### Task 1: Contract — optional `previousSessionId` on `terminal.session.associated`

**Files:**
- Modify: `shared/ws-protocol.ts:829-833` (`TerminalSessionAssociatedMessage`)
- Regenerate: `port/contract/ws-server-messages.schema.json` (+ the other two contract JSONs if the generator touches them)
- Modify: `crates/freshell-protocol/src/` — the `TerminalSessionAssociated` message struct
  (find it: `grep -rn "TerminalSessionAssociated" crates/freshell-protocol/src/`)
- Test: `npm run test:port`, `cargo test -p freshell-protocol`

**Interfaces:**
- Consumes: nothing.
- Produces: wire field `previousSessionId?: string` (TS) /
  `previous_session_id: Option<String>` serialized as `previousSessionId`, omitted when `None`
  (Rust). Every later task that broadcasts or reads the frame relies on exactly these names.

- [ ] **Step 1: Write the failing TS-side check (contract drift)**

Edit `shared/ws-protocol.ts` — extend the type (this alone makes the freeze test fail,
which is the RED state):

```ts
export type TerminalSessionAssociatedMessage = {
  type: 'terminal.session.associated'
  terminalId: string
  sessionRef: SessionLocator
  /**
   * Present ONLY on a server-authoritative mid-session rebind (the CLI under
   * this pane switched/forked to a new session). Names the session id this
   * association supersedes; the client accepts the overwrite only when its
   * current sessionRef.sessionId equals this value. Optional + additive:
   * WS_PROTOCOL_VERSION deliberately NOT bumped (server->client only, not
   * client-validated; old clients ignore it and keep the conflict veto).
   */
  previousSessionId?: string
}
```

- [ ] **Step 2: Run the freeze test to verify it fails**

Run: `npm run test:port`
Expected: FAIL — `ws-contract-freeze.test.ts` reports the regenerated schema differs from the
committed `port/contract/ws-server-messages.schema.json`.

- [ ] **Step 3: Regenerate the contract**

Run: `npm run contract:generate`
Expected: `port/contract/ws-server-messages.schema.json` now contains an optional
`previousSessionId: { "type": "string" }` property under `terminal.session.associated`
(NOT in `required`). `git diff port/contract/` shows only that addition (plus any
generator-stable churn).

- [ ] **Step 4: Run the freeze test to verify it passes**

Run: `npm run test:port`
Expected: PASS.

- [ ] **Step 5: Write the failing Rust serde test**

In the `freshell-protocol` module that defines the struct (same file, `#[cfg(test)]` mod or the
crate's existing test location), add:

```rust
#[test]
fn terminal_session_associated_previous_session_id_is_optional_and_camel_case() {
    let with = TerminalSessionAssociated {
        terminal_id: "t1".into(),
        session_ref: SessionLocator { provider: "codex".into(), session_id: "b".into() },
        previous_session_id: Some("a".into()),
    };
    let v = serde_json::to_value(&with).unwrap();
    assert_eq!(v.get("previousSessionId").and_then(|x| x.as_str()), Some("a"));

    let without = TerminalSessionAssociated {
        terminal_id: "t1".into(),
        session_ref: SessionLocator { provider: "codex".into(), session_id: "b".into() },
        previous_session_id: None,
    };
    let v = serde_json::to_value(&without).unwrap();
    assert!(v.get("previousSessionId").is_none(), "None must serialize to ABSENT, not null");
}
```

(Adapt the struct/variant construction to the actual definition found by the grep — if it is an
enum variant, construct via the enum. Keep the two assertions identical.)

Run: `cargo test -p freshell-protocol previous_session_id`
Expected: FAIL to compile — `previous_session_id` field does not exist.

- [ ] **Step 6: Add the Rust field**

```rust
    /// Present only on a server-authoritative mid-session rebind; names the
    /// session id this association supersedes. Optional+additive on the wire
    /// (WS_PROTOCOL_VERSION deliberately not bumped -- see plan
    /// 2026-07-28-stale-resume-identity.md, Task 1).
    #[serde(rename = "previousSessionId", skip_serializing_if = "Option::is_none", default)]
    pub previous_session_id: Option<String>,
```

Fix all existing constructors of the struct/variant across `crates/` by adding
`previous_session_id: None` (compiler-driven; `cargo check --workspace` lists every site).

- [ ] **Step 7: Run tests to verify pass**

Run: `cargo test -p freshell-protocol && cargo check --workspace && npm run test:port`
Expected: all PASS. If `freshell-protocol` has inventory/count pin tests that fail, update the
pins per the failure message (the README's step 3: "arrays + inventory-test counts").

- [ ] **Step 8: Commit**

```bash
git add shared/ws-protocol.ts port/contract/ crates/
git commit -m "feat(contract): optional previousSessionId on terminal.session.associated

Additive, optional, server->client only. WS_PROTOCOL_VERSION deliberately
NOT bumped: the field is not client-validated (old clients ignore it and
keep the conflict veto), and a bump hard-disconnects every live client."
```

---

### Task 2: Client — accept a server-authoritative rebind

**Files:**
- Modify: `src/lib/terminal-session-association.ts` (conflict veto at `:88-100`; signature `:62-72`)
- Modify: callers that handle a `terminal.session.associated` frame — `src/App.tsx:1159`,
  `src/App.tsx:1188`, `src/components/TerminalView.tsx:3945`, `:4027`, `:4174` (pass the field
  through ONLY where the input is an actual `terminal.session.associated` frame; pass `undefined`
  where the call is synthesized from other sources)
- Test: `test/unit/client/lib/terminal-session-association.test.ts`

**Interfaces:**
- Consumes: `previousSessionId?: string` from Task 1's frame.
- Produces: `reconcileTerminalSessionAssociation({ dispatch, getState, terminalId, sessionRef,
  previousSessionId })` — new optional param. Return type unchanged
  (`'ignored' | 'reconciled' | 'conflict'`). On an accepted rebind it dispatches the EXISTING
  reducer `reconcileTerminalSessionRefByTerminalId` (which already rebinds unconditionally:
  overwrites the differing ref, clears `resumeSessionId`, drops mismatched `codexDurability` —
  `src/store/panesSlice.ts:1790-1826`) and then `flushPersistedLayoutNow()` (persist + cross-tab
  broadcast via `persistMiddleware.ts:693-696`).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/lib/terminal-session-association.test.ts` (mirror the existing
tests' state/dispatch scaffolding in that file — reuse its helpers for building `panes`/`tabs`
state with a terminal pane holding a sessionRef):

```ts
describe('server-authoritative rebind (previousSessionId)', () => {
  it('rebinds when previousSessionId matches the pane current sessionRef', () => {
    // pane holds { provider: 'codex', sessionId: 'old-id' }
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalledWith(
      reconcileTerminalSessionRefByTerminalId({
        terminalId: 't1',
        sessionRef: { provider: 'codex', sessionId: 'new-id' },
      }),
    )
    expect(dispatch).toHaveBeenCalledWith(flushPersistedLayoutNow())
  })

  it('still conflicts when previousSessionId does NOT match the pane sessionRef', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'some-other-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still conflicts when previousSessionId is absent (write-once preserved)', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
```

If the existing file has no `makeStateWithTerminalPane`-style helper, extract one from the
existing write-once test at `:25-43` (do not duplicate state literals three times).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts --config config/vitest/vitest.config.ts`
Expected: the first new test FAILS with `'conflict'` returned instead of `'reconciled'`; the
other two PASS (they codify current behavior).

- [ ] **Step 3: Implement**

In `src/lib/terminal-session-association.ts`:

```ts
export function reconcileTerminalSessionAssociation({
  dispatch,
  getState,
  terminalId,
  sessionRef: rawSessionRef,
  previousSessionId,
}: {
  dispatch: Dispatch
  getState: () => SessionAssociationState
  terminalId?: string
  sessionRef?: unknown
  previousSessionId?: string
}): TerminalSessionAssociationReconcileStatus {
```

and replace the conflict predicate inside the tab loop (currently `:98-101`):

```ts
    // A server-authoritative rebind (previousSessionId names the ref being
    // superseded) is NOT a conflict: the deterministic supersession handshake
    // -- accept only when the pane's current ref is exactly the superseded one.
    const isAuthorizedRebind = (content: TerminalPaneContent): boolean =>
      typeof previousSessionId === 'string'
      && previousSessionId.length > 0
      && content.sessionRef?.provider === sessionRef.provider
      && content.sessionRef?.sessionId === previousSessionId
    if (matches.some(({ content }) =>
      content.sessionRef
      && !sessionRefsEqual(content.sessionRef, sessionRef)
      && !isAuthorizedRebind(content),
    )) {
      conflictingPane = true
      continue
    }
```

(Nothing else in the body changes: an authorized-rebind pane now flows into the
`terminalPaneNeedsDurableIdentityUpdate` check at `:102`, which is true for a differing ref, so
`shouldFlush` is set and `flushPersistedLayoutNow()` fires — this is what defeats the cross-tab
local-wins resurrection hazard: the flush broadcasts the rebound layout to other tabs.)

Thread the field at frame-handling call sites, e.g. in `TerminalView.tsx` / `App.tsx` where the
handler receives the `terminal.session.associated` message `msg`:

```ts
reconcileTerminalSessionAssociation({
  dispatch,
  getState,
  terminalId: msg.terminalId,
  sessionRef: msg.sessionRef,
  previousSessionId: msg.previousSessionId,
})
```

Only frame-driven call sites get the new argument; leave synthesized call sites untouched.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/crossTabSync.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (all pre-existing tests unchanged and green — the write-once test at `:25-43`
must still pass as-is).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminal-session-association.ts src/App.tsx src/components/TerminalView.tsx test/unit/client/lib/terminal-session-association.test.ts
git commit -m "feat(client): accept server-authoritative sessionRef rebind via previousSessionId"
```

---

### Task 3: codex locator — probe reads `forked_from_id`

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs` — `probe_rollout` (`:439`, returns
  `Probe::{Candidate, NotYet, Never}`) and the test helper `write_rollout` (`:293-306`)
- Test: inline `#[cfg(test)] mod tests` in the same file

**Interfaces:**
- Consumes: nothing new.
- Produces: `Probe::Candidate` gains `forked_from_id: Option<String>`; a new test helper
  `write_rollout_full(root, rel_dir, thread_id, cwd: Option<&str>, forked_from: Option<&str>) -> PathBuf`
  that Task 4/8 tests reuse (existing `write_rollout` delegates to it with `forked_from: None`).

- [ ] **Step 1: Write the failing test**

```rust
    /// Extended writer: same session_meta shape, with optional fork lineage
    /// (modeled on the verified 019fa613 fork child: forked_from_id +
    /// thread_source:"user" + originator:"codex-tui").
    fn write_rollout_full(
        root: &Path,
        rel_dir: &str,
        thread_id: &str,
        cwd: Option<&str>,
        forked_from: Option<&str>,
    ) -> PathBuf {
        let dir = root.join(rel_dir);
        std::fs::create_dir_all(&dir).expect("create rollout dir");
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{thread_id}.jsonl"));
        let mut payload = serde_json::json!({ "id": thread_id, "session_id": thread_id });
        if let Some(c) = cwd { payload["cwd"] = serde_json::json!(c); }
        if let Some(f) = forked_from {
            payload["forked_from_id"] = serde_json::json!(f);
            payload["thread_source"] = serde_json::json!("user");
            payload["originator"] = serde_json::json!("codex-tui");
        }
        let line = serde_json::json!({
            "timestamp": "2026-07-26T08:00:00.000Z",
            "type": "session_meta",
            "payload": payload,
        });
        std::fs::write(&file, format!("{line}\n")).expect("write rollout");
        file
    }

    #[test]
    fn probe_surfaces_forked_from_id() {
        let root = unique_temp_dir("probe-fork");
        let path = write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-parent"));
        match probe_rollout(&path) {
            Probe::Candidate { forked_from_id, .. } => {
                assert_eq!(forked_from_id.as_deref(), Some("aaaa-parent"));
            }
            other => panic!("expected Candidate, got {other:?}"),
        }
        let plain = write_rollout_full(&root, "2026/07/27", "22222222-2222-3333-4444-555555555555", Some("/tmp/x"), None);
        match probe_rollout(&plain) {
            Probe::Candidate { forked_from_id, .. } => assert_eq!(forked_from_id, None),
            other => panic!("expected Candidate, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }
```

Also rewrite the existing `write_rollout` as a delegating wrapper:

```rust
    fn write_rollout(root: &Path, rel_dir: &str, thread_id: &str, cwd: Option<&str>) -> PathBuf {
        write_rollout_full(root, rel_dir, thread_id, cwd, None)
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-sessions codex_locator::tests::probe_surfaces_forked_from_id`
Expected: FAIL to compile — `Probe::Candidate` has no `forked_from_id` field.

- [ ] **Step 3: Implement**

In `probe_rollout` (`:439`), where the first line's `payload` is already parsed for
`id`/`cwd`, additionally read (matching `parse/codex.rs:264`'s trim-nonempty semantics):

```rust
    let forked_from_id = payload
        .get("forked_from_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
```

and carry it on `Probe::Candidate { thread_id, cwd, forked_from_id }`. Update every existing
`match`/constructor of `Probe::Candidate` in the file (compiler-driven).

- [ ] **Step 4: Run the whole locator suite**

Run: `cargo test -p freshell-sessions codex_locator`
Expected: PASS (all pre-existing locator tests unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/codex_locator.rs
git commit -m "feat(freshell-sessions): codex probe_rollout surfaces forked_from_id lineage"
```

---

### Task 4: codex locator — ForkWatch lane (deterministic in-TUI fork detection)

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs`
- Test: inline `#[cfg(test)]` in the same file

**Interfaces:**
- Consumes: Task 3's `Probe::Candidate.forked_from_id`, `write_rollout_full`.
- Produces (all `pub`, used by Tasks 5–7):

```rust
pub const CODEX_FORK_WINDOW_MS: i64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkLocated {
    pub terminal_id: String,
    pub old_session_id: String,
    pub new_session_id: String,
    pub rollout_path: PathBuf,
    pub cwd: Option<String>,
}

impl CodexLocator {
    /// Register (or move) the fork watch for a BOUND pane. Snapshots the
    /// current rollout file set; overwrites any existing watch (chained
    /// forks re-register with the new id).
    pub fn watch_fork(&self, terminal_id: &str, session_id: &str) -> bool;
    /// Open an Enter-anchored fork-scan window (in-TUI /resume is driven by
    /// Enter presses; scanning is gated on this window to bound fs cost).
    pub fn note_fork_submit(&self, terminal_id: &str, at_ms: i64) -> bool;
    /// Scan (at most once per call, only when >=1 window is open) for NEW
    /// rollout files whose session_meta forked_from_id == a watched pane's
    /// bound session id. Positive lineage proof -- no cwd census applies.
    pub fn tick_forks(&self, now_ms: i64) -> Vec<ForkLocated>;
}
```

`disarm(terminal_id)` (`:198`) additionally clears the fork watch (the PTY exit hook already
calls `disarm` — `terminal.rs:1743`).

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn fork_rollout_with_lineage_rebinds_within_window() {
        let root = unique_temp_dir("fork-happy");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        // No window open: a fork file appearing is NOT scanned/claimed yet.
        let path = write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-old"));
        assert!(locator.tick_forks(1_000).is_empty());
        // Enter opens the window; the same file is now claimed.
        assert!(locator.note_fork_submit("t1", 2_000));
        let located = locator.tick_forks(2_100);
        assert_eq!(located, vec![ForkLocated {
            terminal_id: "t1".into(),
            old_session_id: "aaaa-old".into(),
            new_session_id: TID.into(),
            rollout_path: path,
            cwd: Some("/tmp/x".into()),
        }]);
        // One-shot per fork: drained.
        assert!(locator.tick_forks(2_200).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fork_pointing_at_foreign_session_never_matches() {
        let root = unique_temp_dir("fork-foreign");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("zzzz-not-ours"));
        assert!(locator.tick_forks(1_100).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plain_new_rollout_is_not_a_fork_candidate() {
        let root = unique_temp_dir("fork-plain");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), None);
        assert!(locator.tick_forks(1_100).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn expired_window_never_scans_or_claims() {
        let root = unique_temp_dir("fork-expired");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-old"));
        let scans_before = locator.fs_scan_count();
        assert!(locator.tick_forks(1_000 + CODEX_FORK_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.fs_scan_count(), scans_before, "expired window must not walk the fs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn chained_fork_rebinds_twice() {
        let root = unique_temp_dir("fork-chain");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-old"));
        let first = locator.tick_forks(1_100);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].new_session_id, TID);
        // Watch auto-advanced to TID: a second fork off TID is claimed next.
        const TID2: &str = "33333333-2222-3333-4444-555555555555";
        assert!(locator.note_fork_submit("t1", 2_000));
        write_rollout_full(&root, "2026/07/27", TID2, Some("/tmp/x"), Some(TID));
        let second = locator.tick_forks(2_100);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].old_session_id, TID);
        assert_eq!(second[0].new_session_id, TID2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_watched_panes_same_cwd_each_claim_their_own_fork() {
        // Lineage is positive proof of ownership -- NO cwd census applies to
        // the fork lane (contrast: the arm/census lane, Task 8).
        let root = unique_temp_dir("fork-two-panes");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.watch_fork("t2", "bbbb-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        assert!(locator.note_fork_submit("t2", 1_000));
        const TID2: &str = "33333333-2222-3333-4444-555555555555";
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-old"));
        write_rollout_full(&root, "2026/07/27", TID2, Some("/tmp/x"), Some("bbbb-old"));
        let mut located = locator.tick_forks(1_100);
        located.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        assert_eq!(located.len(), 2);
        assert_eq!((located[0].terminal_id.as_str(), located[0].new_session_id.as_str()), ("t1", TID));
        assert_eq!((located[1].terminal_id.as_str(), located[1].new_session_id.as_str()), ("t2", TID2));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disarm_clears_the_fork_watch() {
        let root = unique_temp_dir("fork-disarm");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        locator.disarm("t1");
        assert!(locator.note_fork_submit("t1", 1_000) == false);
        write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), Some("aaaa-old"));
        assert!(locator.tick_forks(1_100).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-sessions codex_locator::tests::fork_`
Expected: FAIL to compile — `watch_fork`/`tick_forks`/`ForkLocated` do not exist.

- [ ] **Step 3: Implement**

Add to `Inner`:

```rust
#[derive(Debug, Clone)]
struct ForkWatch {
    session_id: String,
    /// Files known at watch registration / last fork; only NEW files are probed.
    known_files: HashSet<PathBuf>,
    /// Enter-anchored scan window; scanning happens only while open.
    window_until_ms: Option<i64>,
}
// Inner gains:
//   fork_watch: HashMap<String, ForkWatch>,   // terminal_id -> watch
```

Implementation (add below `tick`):

```rust
    pub fn watch_fork(&self, terminal_id: &str, session_id: &str) -> bool {
        if terminal_id.is_empty() || session_id.is_empty() {
            return false;
        }
        let known_files = self.scan_rollout_files();
        let mut inner = self.inner.lock().unwrap();
        inner.fork_watch.insert(
            terminal_id.to_string(),
            ForkWatch { session_id: session_id.to_string(), known_files, window_until_ms: None },
        );
        true
    }

    pub fn note_fork_submit(&self, terminal_id: &str, at_ms: i64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(watch) = inner.fork_watch.get_mut(terminal_id) else { return false };
        watch.window_until_ms = Some(at_ms + CODEX_FORK_WINDOW_MS);
        true
    }

    pub fn tick_forks(&self, now_ms: i64) -> Vec<ForkLocated> {
        {
            let inner = self.inner.lock().unwrap();
            if !inner.fork_watch.values().any(|w| w.window_until_ms.is_some_and(|u| now_ms <= u)) {
                return Vec::new(); // no open window -> zero fs cost
            }
        }
        let current = self.scan_rollout_files();
        let mut located = Vec::new();
        let mut inner = self.inner.lock().unwrap();
        for (terminal_id, watch) in inner.fork_watch.iter_mut() {
            if !watch.window_until_ms.is_some_and(|u| now_ms <= u) {
                continue;
            }
            let mut hits: Vec<(PathBuf, String, Option<String>)> = Vec::new();
            for path in current.difference(&watch.known_files) {
                match probe_rollout(path) {
                    Probe::Candidate { thread_id, cwd, forked_from_id }
                        if forked_from_id.as_deref() == Some(watch.session_id.as_str())
                            && thread_id != watch.session_id
                            && is_uuid_shaped(&thread_id) =>
                    {
                        hits.push((path.clone(), thread_id, cwd));
                    }
                    Probe::NotYet => { /* leave un-merged; retried next tick */ }
                    _ => { watch.known_files.insert(path.clone()); }
                }
            }
            match hits.len() {
                0 => {}
                1 => {
                    let (path, new_id, cwd) = hits.remove(0);
                    located.push(ForkLocated {
                        terminal_id: terminal_id.clone(),
                        old_session_id: std::mem::replace(&mut watch.session_id, new_id.clone()),
                        new_session_id: new_id,
                        rollout_path: path.clone(),
                        cwd,
                    });
                    watch.known_files.insert(path);
                    watch.window_until_ms = None; // one-shot per fork
                }
                n => {
                    tracing::warn!(terminal_id = %terminal_id, candidates = n,
                        "codex_fork_ambiguous: multiple forks of one session in one window; refusing");
                }
            }
        }
        located
    }
```

Also: in `disarm` (`:198-200`) add `inner.fork_watch.remove(terminal_id);`.
`fs_scan_count` already counts via `scan_rollout_files` — no change.

- [ ] **Step 4: Run the full locator suite**

Run: `cargo test -p freshell-sessions codex_locator`
Expected: PASS (new fork tests + all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/codex_locator.rs
git commit -m "feat(freshell-sessions): CodexLocator ForkWatch lane -- lineage-proven in-TUI fork detection"
```

---

### Task 5: Rust — codex rebind write path, tailer re-attach, drain wiring

**Files:**
- Modify: `crates/freshell-ws/src/codex_identity.rs` (guards extraction; `rebind_codex_identity`;
  broadcast helper gains `previous_session_id`)
- Modify: `crates/freshell-ws/src/codex_association.rs` (drain fork candidates; register
  fork-watch after adopt; forward Enter to `note_fork_submit`)
- Modify: `crates/freshell-ws/src/activity.rs` (`attach_codex_lane` re-attach REPLACES the lane)
- Modify: `crates/freshell-ws/src/pane_ledger.rs` tests (resolve-without-marker supersession)
- Test: `crates/freshell-ws/tests/codex_fork_rebind.rs` (NEW — happy path only in this task;
  Task 7 extends it), plus a `pane_ledger` unit test

**Interfaces:**
- Consumes: `ForkLocated`, `watch_fork`, `note_fork_submit`, `tick_forks` (Task 4);
  `previous_session_id` frame field (Task 1).
- Produces:

```rust
// codex_identity.rs
pub(crate) struct CodexRebind<'a> {
    pub terminal_id: &'a str,
    pub old_session_id: &'a str,
    pub new_session_id: &'a str,
    pub rollout_path: &'a std::path::Path,
    pub cwd: Option<&'a str>,
}
/// Move a live pane's codex identity to a fork child. Guards: (1) the pane is
/// the LIVE owner of old_session_id (D7 predicate), (2) new_session_id has no
/// live owner (A13) and is not bound elsewhere retired-inclusive (ledger A8),
/// (3) the shared freshagent guards. Returns false (rebinds nothing) on any
/// guard failure.
pub(crate) async fn rebind_codex_identity(state: &WsState, r: CodexRebind<'_>) -> bool;
```

Broadcast helper signature becomes
`broadcast_terminal_session_associated(state, terminal_id, session_id, cwd, previous_session_id: Option<String>)`
— `adopt_codex_identity` passes `None`; rebind passes `Some(old)`. Pinned emission order
(`associated` then `meta.updated`) unchanged.

- [ ] **Step 1: Write the failing pane-ledger unit test (rebind ledger semantics)**

In the pane-ledger test module (`crates/freshell-ws/src/pane_ledger_tests.rs` — the file with
`rebind_retires_old_row` at `:195`), add:

```rust
#[test]
fn resolve_identity_without_pending_marker_supersedes_prior_binding() {
    // The mid-session rebind path calls resolve_pending with NO pending
    // marker on disk (the pane bound long ago). The binding row must still
    // be written and the previous bound row retired as Superseded with
    // supersededBy -- and the absent marker delete must be a no-op, not an
    // error surfaced to the caller.
    let (ledger, root) = test_ledger(); // reuse this file's existing harness helper
    ledger
        .resolve_pending(&BindingWrite {
            terminal_id: "t1", provider: "codex", session_id: "old-id",
            cwd: Some("/tmp/x"), now_ms: 1_000,
            // ...fill remaining BindingWrite fields exactly as the sibling
            // tests in this file do
        })
        .expect("first bind");
    ledger
        .resolve_pending(&BindingWrite {
            terminal_id: "t1", provider: "codex", session_id: "new-id",
            cwd: Some("/tmp/x"), now_ms: 2_000,
        })
        .expect("rebind without marker must succeed");
    let hit = ledger.lookup_by_session("codex", "old-id").expect("old row remains, retired");
    assert!(hit.corrected, "stale claim answered from the chain terminus");
    assert_eq!(hit.row.session_id, "new-id");
    let _ = std::fs::remove_dir_all(&root);
}
```

(Adapt `BindingWrite` construction/harness names to the sibling tests in that file — copy their
literal shape; the ASSERTIONS are the contract.)

Run: `cargo test -p freshell-ws resolve_identity_without_pending_marker`
Expected: either PASS immediately (resolve_pending already tolerates a missing marker — then this
test is the pinned regression guard; proceed) or FAIL (marker delete errors) — if FAIL, make the
marker delete in `resolve_pending` tolerate NotFound before proceeding.

- [ ] **Step 2: Write the failing integration test (happy path)**

Create `crates/freshell-ws/tests/codex_fork_rebind.rs`, using the shared harness
(`mod common;` + `spawn_server_with_specs_activity_and_codex_locator` — see
`crates/freshell-ws/tests/codex_locator_activity.rs` for the working adoption-flow precedent,
including how it drives Enter via `send_input(ws, tid, "\r")` and writes rollout files into the
harness's sessions root):

```rust
//! Mid-session rebind: a bound codex pane whose CLI forks via in-TUI /resume
//! (new rollout, forked_from_id == bound id) must be rebound end-to-end.
//! Contract under test (incident 2026-07-27, session 019fa60f -> 019fa613):
//!   1. terminal.session.associated arrives with sessionRef.sessionId == NEW
//!      id AND previousSessionId == OLD id.
//!   2. registry meta resume_session_id == NEW id.
mod common;
use common::*;

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn in_tui_fork_rebinds_the_pane_identity() {
    // 1. spawn server with codex locator rooted at a temp sessions dir
    // 2. create a codex terminal (fake codex `sh` spec), drive Enter,
    //    write rollout A (id=OLD) -> drain until terminal.session.associated
    //    with sessionRef.sessionId == OLD (adoption; existing behavior)
    // 3. drive Enter again (opens the fork window), write rollout B with
    //    payload.id == NEW and payload.forked_from_id == OLD
    // 4. next_frame_of_type(ws, "terminal.session.associated") ->
    //    assert sessionRef.sessionId == NEW
    //    assert frame["previousSessionId"] == OLD
    // 5. assert registry meta: registry.identity_probe_rows() row for the
    //    terminal has resume_session_id == Some(NEW)
}
```

Write it fully (no stubs): copy the server/create/drain scaffolding from
`codex_locator_activity.rs`, and reuse Task 3/4's fork-shaped rollout line format (the
`session_meta` JSON with `forked_from_id`) for the file writes. Use OLD/NEW uuid literals.

Run: `cargo test -p freshell-ws --test codex_fork_rebind`
Expected: FAIL — no rebind occurs (frame never arrives; drain times out).

- [ ] **Step 3: Implement — codex_identity.rs**

(a) Extract the three adoption guards (Guard A `session_bound_elsewhere` at `:60-72`, Guard B
freshagent-live at `:73-88`, Guard C freshagent-ledger-row at `:89-100`) into:

```rust
/// Shared hijack/misbind guards for BOTH adoption and rebind. `thread_id` is
/// the id being CLAIMED. Semantics identical to the inline originals
/// (retired-INCLUSIVE ledger A8; same-terminal re-adopt allowed).
async fn codex_claim_refused(state: &WsState, terminal_id: &str, thread_id: &str) -> bool
```

`adopt_codex_identity` calls it first (behavior unchanged — verify by running the existing
suite). (b) Extract the write tail (`:101-135` — upsert, set_meta, ledger, broadcast, hub) into:

```rust
async fn apply_codex_identity(
    state: &WsState,
    terminal_id: &str,
    thread_id: &str,
    rollout_path: Option<&std::path::Path>,
    cwd: Option<&str>,
    previous_session_id: Option<&str>,
)
```

preserving the pinned order exactly; `broadcast_terminal_session_associated` gains the
`previous_session_id: Option<String>` parameter and sets the new frame field. (c) Add:

```rust
pub(crate) async fn rebind_codex_identity(state: &WsState, r: CodexRebind<'_>) -> bool {
    // Guard 1 -- the pane must be the LIVE owner of the id being superseded
    // (D7 predicate: identity arm + registry-row arm, Running only). This is
    // the anti-hijack core: fork lineage alone is not enough; the lineage
    // must point at THIS pane's current identity while the pane is alive.
    if state
        .registry
        .live_session_owner(Some(&state.identity), "codex", r.old_session_id)
        .as_deref()
        != Some(r.terminal_id)
    {
        tracing::warn!(terminal_id = %r.terminal_id, old = %r.old_session_id,
            "codex_rebind_refused: pane is not the live owner of the superseded session");
        return false;
    }
    // Guard 2 -- A13: the NEW id must have no live owner anywhere.
    if let Some(owner) = state
        .registry
        .live_session_owner(Some(&state.identity), "codex", r.new_session_id)
    {
        tracing::warn!(terminal_id = %r.terminal_id, new = %r.new_session_id, owner = %owner,
            "codex_rebind_refused: target session already live-owned (A13)");
        return false;
    }
    // Guard 3 -- shared adoption guards on the claimed id (retired-inclusive
    // bound-elsewhere + freshagent lanes).
    if codex_claim_refused(state, r.terminal_id, r.new_session_id).await {
        return false;
    }
    tracing::info!(terminal_id = %r.terminal_id, old = %r.old_session_id, new = %r.new_session_id,
        "codex_rebind: in-TUI fork detected; moving pane identity");
    apply_codex_identity(
        state, r.terminal_id, r.new_session_id,
        Some(r.rollout_path), r.cwd, Some(r.old_session_id),
    ).await;
    true
}
```

- [ ] **Step 4: Implement — activity.rs re-attach**

Read `attach_codex_lane` (around `activity.rs:304`; lane struct at `:163`). Ensure the final
write into `codex_lanes` is an **explicit `insert`** (replacing any existing `CodexLane`, which
drops the old `RolloutTailer` + `_watcher`, unregistering inotify). If it is currently
`or_insert_with`/`entry(...).or_default()`, change it to `insert` and add this comment:

```rust
        // Re-attach REPLACES the lane: a mid-session fork moves the pane to a
        // NEW rollout file; keeping the old tailer would keep busy/turn
        // signals keyed to the abandoned parent file (stale-tailer defect,
        // plan 2026-07-28-stale-resume-identity.md).
```

If it is already `insert`, add the comment anyway (the behavior is now load-bearing).

- [ ] **Step 5: Implement — codex_association.rs wiring**

(a) In `drain_and_associate` (`:81-144`), after the existing `tick(now)` adoption drain, add the
fork drain (the `terminal_already_bound` gate at `:122-128` does NOT apply — being bound is the
fork lane's precondition):

```rust
    // Fork lane: lineage-proven mid-session rebinds. Runs on the same sweep.
    let forks = locator.tick_forks(now_ms);
    for f in forks {
        let ok = crate::codex_identity::rebind_codex_identity(
            state,
            crate::codex_identity::CodexRebind {
                terminal_id: &f.terminal_id,
                old_session_id: &f.old_session_id,
                new_session_id: &f.new_session_id,
                rollout_path: &f.rollout_path,
                cwd: f.cwd.as_deref(),
            },
        )
        .await;
        if !ok {
            tracing::warn!(terminal_id = %f.terminal_id, "codex_fork_rebind_refused");
        }
    }
```

(b) After a successful `adopt_codex_identity` (`:133`), register the fork watch:

```rust
        if adopted {
            locator.watch_fork(&hit.terminal_id, &hit.thread_id);
        }
```

(c) In `note_possible_submit` (`:57` — already awaited before the Enter byte reaches the PTY,
`terminal.rs:631`), alongside the existing `note_submit` call add:

```rust
        locator.note_fork_submit(terminal_id, at_ms);
```

- [ ] **Step 6: Run the tests**

Run: `cargo test -p freshell-ws --test codex_fork_rebind && cargo test -p freshell-ws --test codex_locator_activity && cargo test -p freshell-ws --test codex_session_ref_resume && cargo test -p freshell-ws pane_ledger`
Expected: ALL PASS — the new happy path binds; all adoption-lane regressions stay green.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/
git commit -m "feat(freshell-ws): mid-session codex rebind -- fork drain, guarded identity move, tailer re-attach, previousSessionId broadcast"
```

---

### Task 6: Rust — fork watch for resume-launched panes + doc premise fix

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (arm site around `:1922`)
- Modify: `crates/freshell-sessions/src/codex_locator.rs:57-67` (module doc premise)
- Test: extend `crates/freshell-ws/tests/codex_fork_rebind.rs`

**Interfaces:**
- Consumes: `watch_fork` (Task 4), rebind pipeline (Task 5).
- Produces: every codex pane that launches with a resume id (`codex resume <id>`) — including
  every restart-restored pane — has an active fork watch from spawn, closing the "resume-launched
  panes never get detection" gate (#1 of the five).

- [ ] **Step 1: Write the failing test**

Add a second test fn to `codex_fork_rebind.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn resume_launched_pane_gets_fork_detection() {
    // 1. spawn server (same harness)
    // 2. create a codex terminal WITH sessionRef {provider:"codex",
    //    sessionId: OLD} (the resume path -- arm() refuses these panes today
    //    and must keep refusing; the FORK watch is the new coverage)
    // 3. drive Enter; write rollout B (id=NEW, forked_from_id=OLD)
    // 4. expect terminal.session.associated with sessionRef.sessionId == NEW
    //    and previousSessionId == OLD; registry meta == NEW
}
```

Write it fully — the create payload shape with `sessionRef` is shown in
`codex_session_ref_resume.rs` Phase 1 (`create_codex_terminal(ws, rid, json!({"sessionRef":
{"provider":"codex","sessionId": OLD}, "restore": true}))`-style). NOTE: the resume-created pane
must be treated as the live owner of OLD — the create path writes
`identity.upsert` at `terminal.rs:1962` and `registry.create(..., resume_session_id ...)`, so
`live_session_owner` already answers this terminal. No production change needed for the guard.

Run: `cargo test -p freshell-ws --test codex_fork_rebind resume_launched`
Expected: FAIL — no watch exists for resume-launched panes; no frame arrives.

- [ ] **Step 2: Implement the spawn-time watch**

In `terminal.rs`, immediately after the `codex_association::maybe_arm(...)` call site (`:1922`):

```rust
        // Resume-launched codex panes are (correctly) refused by arm() --
        // their session already exists. They DO need fork detection: an
        // in-TUI /resume forks to a NEW rollout and the pane would otherwise
        // go permanently stale (incident 2026-07-27).
        if mode == "codex" {
            if let (Some(locator), Some(rsid)) =
                (state.codex_locator.as_ref(), resume_session_id.as_deref())
            {
                locator.watch_fork(&terminal_id, rsid);
            }
        }
```

(Match the surrounding code's actual variable names for `mode`/`state`/`terminal_id` at that
site.)

- [ ] **Step 3: Fix the false module premise**

Replace `codex_locator.rs:64-67`'s bullet with:

```rust
//! - CLI-launch `codex resume <id>` appends to the EXISTING rollout file (no
//!   new file) -- consistent with the arm gate refusing resume panes. In-TUI
//!   `/resume` is DIFFERENT: it FORKS -- a NEW rollout file with a NEW
//!   session id and `forked_from_id` lineage (verified on disk 2026-07-27,
//!   019fa60f -> 019fa613). The ForkWatch lane exists for exactly that case.
//!   Compressed artifacts (`.jsonl.zst`) fail the `.jsonl` suffix filter.
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p freshell-ws --test codex_fork_rebind && cargo test -p freshell-sessions codex_locator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-sessions/src/codex_locator.rs crates/freshell-ws/tests/codex_fork_rebind.rs
git commit -m "feat(freshell-ws): arm fork detection for resume-launched codex panes; correct locator premise doc"
```

---

### Task 7: Crown integration test — fork → rebind → restart resumes the NEW id

**Files:**
- Modify: `crates/freshell-ws/tests/codex_fork_rebind.rs` (extend with three phases)

**Interfaces:**
- Consumes: everything from Tasks 1–6. Produces: the pinned end-user-story regression tests.

- [ ] **Step 1: Write the restart-resume phase (the incident's actual harm)**

Add a test fn using the `CODEX_ARGV_CAPTURE_PATH` fake-codex idiom (copy `write_fake_codex()` and
`wait_for_captured_argv`/`resume_pair_position` verbatim from
`crates/freshell-ws/tests/codex_session_ref_resume.rs:82-274` — this test mutates process-global
env, so keep it a single sequential test fn per that file's discipline; if both files would race
on `CODEX_CMD`, keep this fn in its own `#[cfg(unix)]` test file exactly like the precedent):

```rust
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn after_rebind_a_recreate_resumes_the_new_session_id() {
    // Phase 1 -- bind: create codex pane, Enter, write rollout OLD, drain
    //            until associated(OLD).
    // Phase 2 -- fork: Enter, write rollout NEW (forked_from_id=OLD), drain
    //            until associated(NEW, previousSessionId=OLD).
    // Phase 3 -- the restart story: kill the terminal
    //            (registry.kill(&terminal_id)), then create a NEW terminal
    //            with sessionRef {codex, NEW} + restore:true (exactly what a
    //            client that accepted the Task-2 rebind persists and replays
    //            after a server restart), with CODEX_ARGV_CAPTURE_PATH set.
    //   assert: captured argv contains the pair ["resume", NEW]  -- and NOT
    //           ["resume", OLD] (the incident: the pane resumed the earlier
    //           fork).
    //   assert: registry meta resume_session_id == Some(NEW).
}
```

Write all three phases fully with the established helpers.

- [ ] **Step 2: Write the hijack-guard phase**

```rust
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn fork_targeting_a_live_owned_session_is_refused() {
    // pane1 bound to A; pane2 bound to C (two adoptions, distinct cwds to
    // stay out of each other's way).
    // Write a rollout whose payload.id == C and forked_from_id == A (a forged
    // fork of pane1 pointing AT pane2's live session).
    // Drive pane1's Enter; sweep.
    // assert: NO associated frame moves pane1 to C (drain with a short
    // deadline and assert absence via drain_until_marker_or_deadline);
    // assert: registry meta pane1 == A, pane2 == C (A13 held).
}
```

- [ ] **Step 3: Write the tailer-follows-the-fork phase (stale-tailer defect)**

Extend `in_tui_fork_rebinds_the_pane_identity` (Task 5) after the rebind assertions: append a
turn-completion event line to rollout NEW (copy the exact rollout event-line fixture used by
`crates/freshell-ws/tests/codex_locator_activity.rs:235-243` to trigger the reconcile lane), and
drain until a `codex.activity.updated` / `terminal.turn.complete` frame whose `sessionId` is NEW.
Then append the same event shape to rollout OLD and assert (short-deadline drain) that NO frame
keyed to OLD arrives — the old tailer is gone.

- [ ] **Step 4: Run to verify failures, then fix anything real**

Run: `cargo test -p freshell-ws --test codex_fork_rebind`
Expected: the restart-resume and tailer phases PASS if Tasks 5–6 were complete; the hijack phase
must PASS via Guard 2. Any failure here is a real defect in Tasks 5–6 — fix it there (do not
weaken the test).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/tests/codex_fork_rebind.rs
git commit -m "test(freshell-ws): fork->rebind->restart-resume, hijack guard, and tailer re-attach regressions"
```

---

### Task 8: P2 — contested-cwd census: contenders are in-flight windows, not all armed panes

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs` (`tick`, census at `:267-273`;
  enforcement `:325-330`; tests `:705-771`)

**Interfaces:**
- Consumes/Produces: no API change — `tick(now_ms) -> Vec<Located>` behavior change only.

- [ ] **Step 1: Rewrite the pinned-starvation test and add the new contracts (failing first)**

Replace `staggered_same_cwd_armed_terminals_never_bind_uncontested` (`:743-771`) with:

```rust
    #[test]
    fn idle_armed_cwd_mate_does_not_starve_a_submitting_pane() {
        // Incident 2026-07-27 (DirectorDeck): three panes armed in one repo,
        // ONE submitted and created its session -- the census refused
        // forever because it counted ARMED panes, not contenders. Only panes
        // with an in-flight Enter window can claim a file; idle armed mates
        // are not contenders.
        let root = unique_temp_dir("census-idle-mate");
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_string_lossy().to_string();
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
        assert!(locator.arm("t2", "codex", true, None, Some(&cwd_s)));
        assert!(locator.note_submit("t1", 10_000)); // t2 never submits
        let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));
        let located = locator.tick(10_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1, "solo submitter must bind despite an idle armed cwd-mate");
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(located[0].rollout_path, path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn overlapping_windows_same_cwd_still_refuse_then_solo_reenter_binds() {
        // Genuine ambiguity (two in-flight windows, one new file) still
        // refuses -- but refusal is not forever: a later SOLO Enter binds.
        let root = unique_temp_dir("census-overlap");
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_string_lossy().to_string();
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
        assert!(locator.arm("t2", "codex", true, None, Some(&cwd_s)));
        assert!(locator.note_submit("t1", 10_000));
        assert!(locator.note_submit("t2", 10_500));
        write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));
        assert!(locator.tick(10_500 + CODEX_WINDOW_MS).is_empty(), "contested: refuse");
        assert_eq!(locator.armed_count(), 2, "refusal never disarms");
        // t2's evaluation resolved; t1 re-enters SOLO -> binds (re-opens
        // never re-snapshot, so the file is still a candidate for t1).
        assert!(locator.note_submit("t1", 20_000));
        let located = locator.tick(20_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].terminal_id, "t1");
        let _ = std::fs::remove_dir_all(&root);
    }
```

Keep `same_rollout_claimed_by_two_armed_terminals_refuses_both` (`:726`) and
`two_new_rollouts_in_one_window_refuse_to_bind` (`:705`) unchanged — both submitters have
in-flight windows there, so they still refuse (pass-2 same-tick conflict + census).

Run: `cargo test -p freshell-sessions codex_locator`
Expected: `idle_armed_cwd_mate_does_not_starve_a_submitting_pane` FAILS (census refuses);
`overlapping_windows_...` first half passes, second half FAILS today only if the census keys on
armed count — verify both fail for the census reason, not compile errors.

- [ ] **Step 2: Implement the census change**

Replace the census construction (`:267-273`) with:

```rust
        // Cross-tick contested-cwd census over CONTENDERS -- armed terminals
        // with an in-flight Enter-anchored evaluation window -- not over all
        // armed terminals. An armed pane that never submitted (or whose
        // evaluation already resolved) cannot claim a file and must not
        // starve its cwd-mates (P2, incident 2026-07-27: permanently
        // never-promoted pending markers). Genuine ambiguity -- >=2
        // overlapping windows in one cwd -- still refuses, and refusal still
        // never disarms (a later solo Enter re-evaluates).
        let mut cwd_counts: HashMap<String, usize> = HashMap::new();
        for a in inner.armed.values() {
            if a.enter_ms.is_some() && !a.resolved {
                *cwd_counts.entry(a.cwd_normalized.clone()).or_insert(0) += 1;
            }
        }
```

The enforcement site (`:325-330`) is unchanged. IMPORTANT: build the census BEFORE the
evaluation loop mutates `resolved` (it already is — keep it that way).

- [ ] **Step 3: Run the full locator suite**

Run: `cargo test -p freshell-sessions codex_locator`
Expected: ALL PASS, including the two kept refusal tests and the fork-lane tests.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-sessions/src/codex_locator.rs
git commit -m "fix(freshell-sessions): contested-cwd census counts in-flight windows, ending permanent codex association starvation

P2 audit result recorded: opencode_locator has no cross-terminal census
(per-terminal ambiguity only) and amplifier_locator uses a first-come
claimed mutex -- the permanent starvation shape was codex-only; no
changes needed in those locators."
```

---

### Task 9: P2 — orphaned pending-marker GC

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger_scan.rs` (`gc_marker_locked` at `:256-289`; its
  caller supplies liveness)
- Test: the scan test module used by `pane_ledger_scan.rs`'s existing tests

**Interfaces:**
- Consumes: the live terminal-id set from the periodic GC caller (it has `state.registry`;
  a terminal is live iff it appears in the registry — use the same probe the caller already uses
  for the covered-by-binding rule, or `registry.identity_probe_rows()` ids).
- Produces: new rule + constant:

```rust
/// A pending marker whose terminal is not live and which is older than this
/// is orphaned (server death before resolution -- exit hook never ran).
/// Deliberately >> the boot window: boot_scan's fresh-by-race vs
/// fresh-by-intent job (P1.8) reads markers minutes old; this rule only
/// clears the multi-day residue (live evidence: DirectorDeck markers from
/// 2026-07-28 still present).
pub const PENDING_MARKER_ORPHAN_TTL_MS: i64 = 24 * 60 * 60 * 1000;
```

`gc_marker_locked` gains a `live_terminal_ids: &HashSet<String>` parameter (threaded from the
GC entry point; `boot_scan` passes the post-restore live set).

- [ ] **Step 1: Write the failing test**

In the existing scan test module (mirror its marker-construction helpers):

```rust
#[test]
fn orphaned_pending_marker_is_gced_after_orphan_ttl() {
    // marker: terminal "dead-t", spawned_at = now - (ORPHAN_TTL + 1h), no
    // binding row, terminal NOT in the live set -> deleted.
    // marker: terminal "live-t", same age, IS in the live set -> kept.
    // marker: terminal "young-t", spawned_at = now - 60_000, not live ->
    // kept (younger than the orphan TTL; boot_scan semantics preserved).
}
```

Write it fully with the module's existing ledger/marker fixtures and a `HashSet` live set of
`{"live-t"}`; assert via the module's marker-listing helper.

Run: `cargo test -p freshell-ws orphaned_pending_marker`
Expected: FAIL to compile (new param/constant) or FAIL on the kept/deleted assertions.

- [ ] **Step 2: Implement**

In `gc_marker_locked`, after the existing age/covered rules, add:

```rust
        // Orphan rule (P2): the exit hook deletes markers on PTY exit, but a
        // SERVER death orphans them (terminal.rs:1738 never runs). A marker
        // older than the orphan TTL whose terminal is not live has no
        // remaining job.
        if !live_terminal_ids.contains(marker_terminal_id)
            && now_ms - marker.spawned_at_ms > PENDING_MARKER_ORPHAN_TTL_MS
        {
            /* delete via the same deletion path the TTL rule uses */
        }
```

(Adapt field/variable names to the function's actuals; reuse the existing deletion call.)
Thread `live_terminal_ids` from both callers (periodic GC and `boot_scan`).

- [ ] **Step 3: Run the scan + ledger suites**

Run: `cargo test -p freshell-ws pane_ledger`
Expected: PASS (including all pre-existing boot_scan/gc tests).

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/src/pane_ledger_scan.rs crates/freshell-ws/src/
git commit -m "fix(freshell-ws): GC orphaned pending markers (dead terminal + 24h TTL) without touching boot_scan semantics"
```

---

### Task 10: P5 — user forks are not subagents (sidebar visibility)

**Files:**
- Modify: `crates/freshell-sessions/src/parse/codex.rs:355-363`
- Create: `test/fixtures/coding-cli/codex/fork-child-meta.sanitized.jsonl`
- Test: new `#[test]`s in `parse/codex.rs`'s test module + fixture-parity-style test
- Modify (Node parity — the Rust parser's declared 1:1 source):
  `server/coding-cli/providers/codex.ts` (same predicate change)

**Interfaces:**
- Consumes: real fork-child session_meta shape (Global Constraints fixture list).
- Produces: classification rule — `is_subagent = subagent_source || (forked_from_id present AND
  thread_source != "user")`. A fork child with `thread_source: "user"` is a visible user
  continuation. `thread_source` ABSENT (older CLIs) keeps today's behavior (hidden) — fail
  toward hiding, never toward showing machine forks.

- [ ] **Step 1: Create the sanitized fixture**

`test/fixtures/coding-cli/codex/fork-child-meta.sanitized.jsonl` — two lines, modeled exactly on
the verified 019fa613 child (ids replaced, text elided):

```json
{"timestamp":"2026-07-28T00:15:22.570Z","type":"session_meta","payload":{"session_id":"11111111-aaaa-7133-a2fb-000000000001","id":"11111111-aaaa-7133-a2fb-000000000001","forked_from_id":"00000000-aaaa-7133-a2fb-000000000000","timestamp":"2026-07-28T00:15:22.453Z","cwd":"/tmp/sanitized-project","originator":"codex-tui","cli_version":"0.145.0","source":"cli","thread_source":"user","model_provider":"openai","base_instructions":{"text":"sanitized"},"history_mode":"legacy","multi_agent_version":"v2","context_window":{"window_id":"22222222-2222-2222-2222-222222222222"},"git":{"commit_hash":"0000000000000000000000000000000000000000","branch":"main","repository_url":"https://example.invalid/sanitized.git"}}}
{"timestamp":"2026-07-28T00:15:30.000Z","type":"event_msg","payload":{"type":"user_message","message":"sanitized user turn"}}
```

- [ ] **Step 2: Write the failing tests**

In `parse/codex.rs`'s test module:

```rust
    #[test]
    fn user_fork_with_thread_source_user_is_not_a_subagent() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex/fork-child-meta.sanitized.jsonl");
        let content = std::fs::read_to_string(&path).unwrap();
        let meta = parse_codex_session_content(&content);
        assert_ne!(meta.is_subagent, Some(true),
            "an in-TUI /resume continuation (forked_from_id + thread_source=user) must stay sidebar-visible");
    }

    #[test]
    fn fork_without_thread_source_stays_classified_subagent() {
        let content = r#"{"timestamp":"t","type":"session_meta","payload":{"id":"a","forked_from_id":"b","cwd":"/tmp/x"}}"#;
        let meta = parse_codex_session_content(content);
        assert_eq!(meta.is_subagent, Some(true), "fail toward hiding when thread_source is absent");
    }

    #[test]
    fn explicit_subagent_source_always_wins() {
        let content = r#"{"timestamp":"t","type":"session_meta","payload":{"id":"a","forked_from_id":"b","thread_source":"user","source":{"subagent":{"thread_spawn":true}},"cwd":"/tmp/x"}}"#;
        let meta = parse_codex_session_content(content);
        assert_eq!(meta.is_subagent, Some(true));
    }
```

Run: `cargo test -p freshell-sessions parse::codex`
Expected: first test FAILS (`is_subagent == Some(true)` today); other two PASS.

- [ ] **Step 3: Implement**

Replace `:355-360` with:

```rust
            // A forked_from_id with thread_source == "user" is an in-TUI
            // /resume continuation -- the user's REAL session -- not a
            // subagent (verified fork pair 019fa60f -> 019fa613; the child
            // carries thread_source:"user"). thread_source ABSENT falls back
            // to the old classification (fail toward hiding).
            let forked_user_thread = has_codex_forked_from_session(payload)
                && payload.get("thread_source").and_then(Value::as_str) == Some("user");
            if is_subagent.is_none()
                && (is_codex_subagent_source(payload.get("source"))
                    || (has_codex_forked_from_session(payload) && !forked_user_thread))
            {
                is_subagent = Some(true);
            }
```

- [ ] **Step 4: Mirror in the Node parser**

`server/coding-cli/providers/codex.ts` is the declared 1:1 source of the Rust port — apply the
identical predicate there (find the `forked_from_id`/subagent classification block via
`grep -n "forked_from_id" server/coding-cli/providers/codex.ts`), with the same comment. If a
vitest covers this parser (`grep -rl "forked_from" test/`), extend it with the same three cases.

- [ ] **Step 5: Run tests**

Run: `cargo test -p freshell-sessions && npm run test:vitest -- run test/unit/server --config config/vitest/vitest.server.config.ts`
Expected: PASS (the `codex_fixture_parity` whole-struct test is unaffected — its fixture has no
`forked_from_id`; if it fails, update its expected literal per the diff).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-sessions/src/parse/codex.rs server/coding-cli/providers/codex.ts test/fixtures/coding-cli/codex/fork-child-meta.sanitized.jsonl test/
git commit -m "fix(sessions): in-TUI codex forks with thread_source=user are visible sessions, not subagents (P5)"
```

---

### Task 11: P4 — claude SessionStart hook injection

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs` (`claude_settings_json` `:212-227`;
  constants `:185-189`)
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs` (`CLAUDE_SETTINGS_UNIX` `:9`,
  `CLAUDE_SETTINGS_WIN` `:13`, plus any golden asserting the `--settings` argv token)
- Modify: `crates/freshell-ws/src/terminal.rs` (inject `FRESHELL_TERMINAL_ID` into CLI launch env)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Env: every coding-CLI PTY gets `FRESHELL_TERMINAL_ID=<terminal_id>`.
  - Signal files: claude's `SessionStart` hook writes its stdin JSON (which carries
    `session_id`, `source`, `cwd`) atomically to
    `$HOME/.freshell/session-signals/claude/<FRESHELL_TERMINAL_ID>__<nonce>.json`.
    The `__` delimiter is load-bearing (terminal ids contain `-`); Task 12 parses it.
  - New constants in `cli_launch.rs`:
    `CLAUDE_SESSION_START_COMMAND_UNIX`, `CLAUDE_SESSION_START_COMMAND_WINDOWS`.

- [ ] **Step 1: Update the goldens first (RED)**

Rewrite `claude_settings_json` to build via `serde_json` (ending the string-concat literal), with
Stop unchanged and SessionStart added:

Unix hook command constant:

```rust
/// SessionStart fires with the CURRENT session id on startup/resume/clear --
/// the deterministic signal for claude's fork-on-resume (claude writes NO
/// lineage field on disk; verified 2026-07-27). Atomic tmp+rename; never
/// blocks or fails the CLI (trailing `|| true`).
pub const CLAUDE_SESSION_START_COMMAND_UNIX: &str = "sh -lc 'd=\"$HOME/.freshell/session-signals/claude\"; f=\"$d/${FRESHELL_TERMINAL_ID:-unknown}__$$-$(date +%s%N)\"; mkdir -p \"$d\" && cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.json\"' 2>/dev/null || true";
```

Windows: a PowerShell one-liner reading `[Console]::In.ReadToEnd()` and writing it to
`$env:USERPROFILE\.freshell\session-signals\claude\${env:FRESHELL_TERMINAL_ID}__<ticks>.json`
(mirror the existing `CLAUDE_BELL_COMMAND_WINDOWS` style at `:189`, including its fallbacks).

New settings shape (both platforms):

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"<session-start-cmd>"}]}],"Stop":[{"hooks":[{"type":"command","command":"<bell-cmd>"}]}]}}
```

Update `CLAUDE_SETTINGS_UNIX`/`CLAUDE_SETTINGS_WIN` golden constants to the exact new bytes
(run the golden test once to capture the serde_json output ordering, then pin it — key order in
`serde_json::json!` maps follows insertion; construct `SessionStart` before `Stop` to match the
golden).

Run: `cargo test -p freshell-platform cli_launch`
Expected: FAIL — goldens mismatch (RED confirmed against the OLD implementation), then after the
implementation lands in Step 2, PASS.

- [ ] **Step 2: Implement `claude_settings_json` + env injection**

Implement the serde_json construction in `claude_settings_json` (keep the
`ProviderTarget`-keyed platform switch). Then in `crates/freshell-ws/src/terminal.rs`, at the
point where the built `CliLaunch`'s env is finalized before PTY spawn (find it:
`grep -n "launch.env\|command_env" crates/freshell-ws/src/terminal.rs` near the spawn), add for
every coding-CLI mode:

```rust
        // Deterministic pane identity for CLI-side hooks (claude SessionStart
        // signal files; harmless for other CLIs).
        launch.env.insert("FRESHELL_TERMINAL_ID".to_string(), terminal_id.clone());
```

- [ ] **Step 3: Run goldens + spot-check**

Run: `cargo test -p freshell-platform && cargo check --workspace`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-platform/ crates/freshell-ws/src/terminal.rs
git commit -m "feat(freshell-platform): inject claude SessionStart hook writing session-id signal files; FRESHELL_TERMINAL_ID env"
```

---

### Task 12: P4 — claude signal watcher + mid-session rebind

**Files:**
- Create: `crates/freshell-ws/src/claude_signal.rs` (+ `mod claude_signal;` in `lib.rs`)
- Modify: `crates/freshell-server/src/main.rs` (spawn the sweep next to the locator sweeps,
  `main.rs:385-408` area)
- Test: unit tests inline; integration `crates/freshell-ws/tests/claude_session_rebind.rs` (NEW)

**Interfaces:**
- Consumes: signal files from Task 11; `previousSessionId` frame field (Task 1).
- Produces:

```rust
pub struct ClaudeSignalWatcher { root: PathBuf }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSignal {
    pub terminal_id: String,
    pub session_id: String,
    pub source: Option<String>, // "startup" | "resume" | "clear" | ...
}
impl ClaudeSignalWatcher {
    pub fn new(root: PathBuf) -> Self;
    pub fn default_root() -> Option<PathBuf>; // $HOME/.freshell/session-signals/claude
    /// Read+parse+DELETE every *.json in root. Filename: <terminal_id>__<nonce>.json
    /// (split on the LAST "__"). Malformed files are deleted and skipped.
    pub fn drain(&self) -> Vec<ClaudeSignal>;
}
/// Sweep body: drain signals; for each, no-op if the id matches the pane's
/// current claude identity; otherwise guarded rebind.
pub(crate) async fn drain_and_rebind_claude(state: &WsState, watcher: &ClaudeSignalWatcher);
/// Spawned by freshell-server boot next to the locator sweeps.
pub fn spawn_claude_signal_sweep(state: /* same handle type the codex sweep takes */, watcher: ClaudeSignalWatcher);
```

Deliberate design: NO new `WsState` field (every integration test constructs `WsState` as an
exhaustive literal — a new field would touch ~27 test files for nothing; the watcher is owned by
the sweep task).

- [ ] **Step 1: Write the failing watcher unit tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drain_parses_and_deletes_signal_files() {
        let root = std::env::temp_dir().join(format!("freshell-claude-sig-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("term-abc-123__42-9.json"),
            r#"{"session_id":"new-id","source":"resume","cwd":"/tmp/x","hook_event_name":"SessionStart"}"#,
        ).unwrap();
        std::fs::write(root.join("junk__1.json"), "not json").unwrap();
        let w = ClaudeSignalWatcher::new(root.clone());
        let got = w.drain();
        assert_eq!(got, vec![ClaudeSignal {
            terminal_id: "term-abc-123".into(),
            session_id: "new-id".into(),
            source: Some("resume".into()),
        }]);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "processed AND malformed files deleted");
        let _ = std::fs::remove_dir_all(&root);
    }
}
```

Run: `cargo test -p freshell-ws claude_signal`
Expected: FAIL to compile (module absent).

- [ ] **Step 2: Implement the watcher + rebind**

`drain`: `read_dir`, filter `.json`, parse filename `stem.rsplit_once("__")` → terminal_id;
parse body with `serde_json` reading `session_id` (required non-empty) and `source`; delete each
file after processing (also on parse failure). `drain_and_rebind_claude`:

```rust
pub(crate) async fn drain_and_rebind_claude(state: &WsState, watcher: &ClaudeSignalWatcher) {
    for sig in watcher.drain() {
        // Registry row: must be a live claude pane.
        let Some(current) = state.identity.get(&sig.terminal_id) else { continue };
        if current.retired || current.provider.as_deref() != Some("claude") {
            continue;
        }
        if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
            continue; // startup echo of the id we launched with -- idempotent
        }
        // A13: the claimed id must have no live owner.
        if let Some(owner) = state
            .registry
            .live_session_owner(Some(&state.identity), "claude", &sig.session_id)
        {
            tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
                "claude_rebind_refused: target session already live-owned (A13)");
            continue;
        }
        // Ledger A8 (retired-inclusive) + freshclaude guard, mirroring codex
        // Guard A/C semantics.
        if let Some(existing) = state
            .identity
            .find_by_session_including_retired("claude", &sig.session_id)
        {
            if existing != sig.terminal_id {
                tracing::warn!(terminal_id = %sig.terminal_id,
                    "claude_rebind_refused: session_bound_elsewhere");
                continue;
            }
        }
        if state
            .pane_ledger
            .lookup_by_session("claude", &sig.session_id)
            .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
        {
            continue;
        }
        let previous = current.session_id.clone();
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source, "claude_rebind: SessionStart reported a new session id");
        // Same pinned order as the codex tail: identity -> meta -> ledger
        // (awaited) -> associated THEN meta.updated.
        state.identity.upsert(&sig.terminal_id, Some("claude"), Some(&sig.session_id),
            current.cwd.as_deref(), now_ms());
        state.registry.set_meta(&sig.terminal_id, None, None,
            Some("claude".to_string()), Some(sig.session_id.clone()));
        crate::pane_ledger::ledger_resolve_identity(
            state, &sig.terminal_id, "claude", &sig.session_id, current.cwd.as_deref(),
        ).await;
        crate::codex_identity::broadcast_terminal_session_associated(
            state, &sig.terminal_id, &sig.session_id, current.cwd.clone(), previous,
        );
    }
}
```

(Make Task 5's `broadcast_terminal_session_associated` `pub(crate)` and provider-parameterized —
add a `provider: &str` parameter, with the codex callers passing `"codex"` — the frame's
`sessionRef.provider` must say `claude` here. Adjust Task 5's signature accordingly if this task
lands after it; keep one shared broadcaster, no copy.)

`spawn_claude_signal_sweep`: mirror the codex locator sweep's task shape (interval ~1s, call
`drain_and_rebind_claude`). Wire in `freshell-server/src/main.rs` next to the locator wiring
(`:385-408`), rooted at `ClaudeSignalWatcher::default_root()` when `Some`.

- [ ] **Step 3: Write the failing integration test**

`crates/freshell-ws/tests/claude_session_rebind.rs` (harness: `mod common;`, fake claude via a
`sleeper_cli_spec`-style claude spec with `env_var: Some("CLAUDE_CMD")`, argv capture like the
codex fake for phase 2):

```rust
//! Claude mid-session rebind via SessionStart signal files.
//! Phase 1: create a claude terminal (spawn identity A via the preallocated
//!   --session-id path), spawn the sweep with a temp signal root, drop a
//!   signal file {session_id: "B", source: "resume"} named
//!   "<terminal_id>__1.json"; expect terminal.session.associated with
//!   sessionRef {provider:"claude", sessionId:"B"} and previousSessionId ==
//!   "A"; registry meta resume_session_id == "B".
//! Phase 2 (the restart story): kill; create with sessionRef {claude, "B"} +
//!   restore:true and CLAUDE_ARGV capture -> argv contains ["--resume","B"].
//! Phase 3 (hijack): second live claude pane bound to "C"; drop a signal
//!   for pane1 claiming "C" -> refused; both panes' meta unchanged (A13).
```

Write all three phases fully; the test spawns the sweep itself:
`freshell_ws::claude_signal::spawn_claude_signal_sweep(state_handle, ClaudeSignalWatcher::new(tmp_root))`
— or calls `drain_and_rebind_claude` directly on a state reference if the sweep handle type is
awkward from the test (either is acceptable; direct calls make the test deterministic —
prefer direct calls + one `tokio::task::yield_now().await`).

Run: `cargo test -p freshell-ws --test claude_session_rebind`
Expected: FAIL before Step 2's wiring compiles/passes; then PASS.

- [ ] **Step 4: Run the suites**

Run: `cargo test -p freshell-ws --test claude_session_rebind && cargo test -p freshell-ws --test claude_restore_unavailable && cargo test -p freshell-ws claude`
Expected: PASS — including the P0.4 restore-ladder tests (untouched).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/ crates/freshell-server/src/main.rs
git commit -m "feat(freshell-ws): claude mid-session rebind via SessionStart signal files (P4 -- deterministic, no heuristic coordinator port)"
```

---

### Task 13: P3 — amplifier fork-lineage rebind

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_locator.rs` (fork-watch analog; its probe
  already parses `events.jsonl` `session:start` and REJECTS `parent_id`/`session:fork` — those
  rejection sites define the lineage format to match)
- Modify: `crates/freshell-ws/src/amplifier_association.rs` (`:128-134` gate untouched for the
  adoption lane; new fork drain + rebind tail; adoption is currently INLINE at `:136-181` —
  extract it into `apply_amplifier_identity(state, terminal_id, session_id, session_dir, cwd,
  previous_session_id)` so adopt and rebind share one write path, mirroring Task 5's shape)
- Test: locator inline tests + `crates/freshell-ws/tests/amplifier_fork_rebind.rs` (NEW, frames +
  meta assertions only — modeled on `codex_fork_rebind.rs` but without the argv phase)

**Interfaces:**
- Consumes: Task 1 frame field; Task 5's provider-parameterized broadcaster.
- Produces: `AmplifierLocator::{watch_fork, note_fork_submit, tick_forks} -> Vec<AmplifierForkLocated>`
  with the same shape and window discipline as Task 4 (constant
  `AMPLIFIER_FORK_WINDOW_MS: i64 = 30_000`), where a fork candidate is a NEW
  `projects/<slug>/sessions/<id>/` dir whose `events.jsonl` `session:start` carries
  `parent_id == watched id` (or a `session:fork` event referencing it).

- [ ] **Step 1: Audit-first gate (P3 requirement — do not assume codex semantics)**

Before writing code, read `amplifier_locator.rs`'s probe to extract the EXACT field names it
parses for `session:start`/`session:config` and the exact rejection predicates for
`parent_id`/`session:fork`. Then check the live substrate if present:
`ls ~/.amplifier 2>/dev/null || true` and locate the projects/sessions dir the locator's
`default root` uses; if any real session dir contains a `session:start` with `parent_id`,
record 1-2 sanitized lines in `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md`
(create it in this step) under an "amplifier" heading. If no real fork evidence exists on this
machine, record that and proceed with the locator-parser-defined synthetic format — the parser's
own rejection code is the repo's authoritative format knowledge.

- [ ] **Step 2: Write the failing locator tests**

Mirror Task 4's six test shapes (happy lineage, foreign lineage, plain new session, expired
window, chained, disarm-clears) using the amplifier locator test module's existing synthetic
`events.jsonl` fixture helpers (it has them — its probe tests construct session dirs; reuse and
extend with a `parent_id` writer). Same assertions, amplifier types.

Run: `cargo test -p freshell-sessions amplifier_locator::tests::fork_`
Expected: FAIL to compile.

- [ ] **Step 3: Implement locator + association**

Locator: same `ForkWatch` structure as Task 4, with `scan` = the locator's existing session-dir
enumeration and `probe` = its existing `session:start` parse, but ACCEPTING (as fork candidates)
exactly what the adoption probe rejects: `parent_id == watch.session_id`. Association: fork
drain in the amplifier sweep calling a new `rebind_amplifier_identity` that (1) applies the same
three guards as Task 5 (live-owner of old, A13 on new via
`live_session_owner(.., "amplifier", ..)`, retired-inclusive bound-elsewhere), (2) calls the
extracted `apply_amplifier_identity` with `previous_session_id: Some(old)`, (3) re-attaches the
amplifier events tailer to the NEW session dir (the attach call currently made inline at
`:175-181` — same replace-the-lane requirement as Task 5 Step 4; verify the amplifier lane map
insert semantics in `activity.rs:1512+` and fix to `insert` if needed). Register `watch_fork`
after successful adoption and for resume-launched amplifier panes (same `terminal.rs` site
pattern as Task 6, keyed `mode == "amplifier"`). Wire `note_fork_submit` in amplifier's
`note_possible_submit` equivalent.

- [ ] **Step 4: Write + pass the integration test**

`crates/freshell-ws/tests/amplifier_fork_rebind.rs`: bind (existing amplifier adoption flow —
copy from the amplifier association integration test if one exists, else drive the locator via
the harness's amplifier locator seam), fork (write new session dir with `parent_id` = old id),
assert `terminal.session.associated` with new id + `previousSessionId` = old id + registry meta.

Run: `cargo test -p freshell-sessions amplifier_locator && cargo test -p freshell-ws --test amplifier_fork_rebind`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_locator.rs crates/freshell-ws/ docs/plans/2026-07-28-stale-resume-identity-p3-audit.md
git commit -m "feat(amplifier): lineage-proven mid-session rebind (parent_id/session:fork) mirroring the codex fork lane (P3)"
```

---

### Task 14: P3 — opencode in-TUI switch: audit + correlation rebind

**Files:**
- Modify: `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md` (opencode section)
- Modify: `crates/freshell-sessions/src/opencode_locator.rs`
- Modify: `crates/freshell-ws/src/opencode_association.rs` (adoption inline at `:135-167` —
  extract shared write path as in Task 13)
- Test: locator inline tests (synthetic SQLite fixtures — the locator's existing tests already
  build a fake `opencode.db`; reuse those helpers)

**Interfaces:**
- Consumes: Task 1 field; shared broadcaster.
- Produces: `OpencodeLocator::{watch_switch(terminal_id, session_id, directory),
  note_switch_submit(terminal_id, at_ms), tick_switches(now_ms) -> Vec<OpencodeSwitchLocated>}`
  with `OpencodeSwitchLocated { terminal_id, old_session_id, new_session_id, directory }`.

- [ ] **Step 1: The audit (mandatory first; this defines the trigger predicate)**

opencode's substrate is a SQLite `session` row per session (the locator diffs rows via its
bounded `list_sessions_since`). Audit procedure — run it and record results in the audit doc:

1. `sqlite3 <opencode data_home>/opencode.db "SELECT id, directory, json_extract(data,'$.time.updated') FROM session ORDER BY 3 DESC LIMIT 10;"`
   (adapt table/column names to what `opencode_locator.rs`'s queries actually use — copy its SQL).
2. In a scratch terminal (NOT via the 3002 server): run `opencode` in a temp dir, create a
   session, exit; run `opencode` again, use the session list (leader+l) to switch to the first
   session, send one message, exit.
3. Re-run the query. Record: did switching create a NEW row (fork semantics) or UPDATE the
   existing row's `time.updated` (append semantics)? Does any lineage column/field exist?

Expected finding (design assumption to verify): opencode switching APPENDS to the chosen
existing session — the deterministic signal is "after this pane's Enter, a DIFFERENT session row
in the same directory advanced while the bound session did not".

If the audit contradicts this (e.g. opencode also forks with a lineage field), implement the
LINEAGE variant instead (Task 13's shape) — the interfaces above stay identical; only the
predicate inside `tick_switches` changes. Record whichever variant shipped in the audit doc.

- [ ] **Step 2: Write the failing locator tests (correlation variant)**

```rust
    #[test]
    fn switch_to_another_session_in_directory_is_detected_after_two_windows() {
        // Bound pane on session A in dir D. Enter at t1: session B (same D)
        // advances in-window, A does not -> candidate (1st confirmation, no
        // emit -- hijack guard requires TWO consecutive confirming windows).
        // Enter at t2: B advances again, A does not -> SwitchLocated{A->B}.
    }
    #[test]
    fn bound_session_advancing_suppresses_the_candidate() { /* A advances too -> no candidate, streak reset */ }
    #[test]
    fn two_foreign_sessions_advancing_is_ambiguous_and_never_emits() { /* B and C advance -> refuse, streak reset */ }
    #[test]
    fn foreign_directory_updates_never_match() { /* B in dir E -> ignored */ }
```

Write them fully against the locator's fake-db helpers (rows with injectable
`time.updated`; injected clocks like the codex tests). Two-window confirmation constant:
`OPENCODE_SWITCH_CONFIRMATIONS: u32 = 2`.

Run: `cargo test -p freshell-sessions opencode_locator::tests::switch_`
Expected: FAIL to compile.

- [ ] **Step 3: Implement locator + association wiring**

`tick_switches` per open window: query sessions updated in `[enter_ms, now]` for the watched
directory (reuse `list_sessions_since`); classify: bound advanced → reset streak; exactly one
foreign advanced → increment streak (emit on reaching 2, then advance the watch to the new id
and reset); zero or ≥2 foreign → reset. Association: drain in the opencode sweep →
`rebind_opencode_identity` with the same three guards (live-owner of old, A13 on new,
retired-inclusive bound-elsewhere) → shared write path with `previous_session_id: Some(old)`.
Register `watch_switch` after adoption and for resume-launched opencode panes (`terminal.rs`,
`mode == "opencode"`); wire `note_switch_submit` from opencode's submit seam.

- [ ] **Step 4: Run tests**

Run: `cargo test -p freshell-sessions opencode_locator && cargo test -p freshell-ws opencode`
Expected: PASS (all pre-existing opencode association tests green).

- [ ] **Step 5: Commit**

```bash
git add crates/ docs/plans/2026-07-28-stale-resume-identity-p3-audit.md
git commit -m "feat(opencode): audited in-TUI switch detection (two-window row-update correlation) + guarded rebind (P3)"
```

---

### Task 15: P6 — Node parity: previousSessionId on fork handoff + swap coverage

**Files:**
- Modify: `server/index.ts:689` (the `terminal.session.bound` → `terminal.session.associated`
  fanout) and the record-scoped sends at `server/terminal-registry.ts:2826` / `:3058`
- Modify: `server/terminal-registry.ts` fork-handoff commit (`:2722-2835`) — thread the parent id
  into the bound event payload so the fanout can emit it
- Test: `test/unit/server/session-binding-authority.test.ts` (currently ZERO swap coverage)

**Interfaces:**
- Consumes: Task 1's shared `shared/ws-protocol.ts` type (both servers author from it).
- Produces: Node's codex fork handoff emits `previousSessionId: <parent id>` on its
  `terminal.session.associated` fanout, so the Task 2 client accepts Node-originated rebinds too.
  Scope note (audited): parity discipline on main is CONTRACT-only (CI: `test:port` +
  `contract:generate` diff-clean + `cargo test -p freshell-protocol`); there is no
  behavior-mirroring rule, Node codex/opencode locators are `provider_managed` with no census,
  and `rebindSession` (`:4817-4832`) stays uncalled — do NOT port the Rust locator changes to
  Node.

- [ ] **Step 1: Write the failing swap tests**

Append to `test/unit/server/session-binding-authority.test.ts` (mirror its existing setup):

```ts
describe('swapTerminalSession', () => {
  it('moves the session key for a bound terminal', () => {
    const authority = new SessionBindingAuthority()
    authority.bind('t1', keyOf('codex', 'a'))
    const result = authority.swapTerminalSession('t1', keyOf('codex', 'a'), keyOf('codex', 'b'))
    expect(result.ok).toBe(true)
    expect(authority.ownerForSession(keyOf('codex', 'b'))).toBe('t1')
    expect(authority.ownerForSession(keyOf('codex', 'a'))).toBeUndefined()
  })
  it('refuses when the terminal is not bound', () => {
    const authority = new SessionBindingAuthority()
    expect(authority.swapTerminalSession('t1', keyOf('codex', 'a'), keyOf('codex', 'b')).ok).toBe(false)
  })
  it('refuses on from-session mismatch (optimistic concurrency)', () => {
    const authority = new SessionBindingAuthority()
    authority.bind('t1', keyOf('codex', 'a'))
    const result = authority.swapTerminalSession('t1', keyOf('codex', 'zzz'), keyOf('codex', 'b'))
    expect(result.ok).toBe(false)
    expect(authority.ownerForSession(keyOf('codex', 'a'))).toBe('t1')
  })
  it('refuses when the target session is owned by another terminal', () => {
    const authority = new SessionBindingAuthority()
    authority.bind('t1', keyOf('codex', 'a'))
    authority.bind('t2', keyOf('codex', 'b'))
    expect(authority.swapTerminalSession('t1', keyOf('codex', 'a'), keyOf('codex', 'b')).ok).toBe(false)
  })
  it('self-swap is an ok no-op', () => {
    const authority = new SessionBindingAuthority()
    authority.bind('t1', keyOf('codex', 'a'))
    expect(authority.swapTerminalSession('t1', keyOf('codex', 'a'), keyOf('codex', 'a')).ok).toBe(true)
    expect(authority.ownerForSession(keyOf('codex', 'a'))).toBe('t1')
  })
})
```

(Adapt `keyOf`/constructor/result-shape names to the file's existing tests and
`session-binding-authority.ts:35-93`'s actual API — the guards at `:55`, `:57`, `:61` and the
`:66-70` mutation define the five behaviors above.)

Run: `npm run test:vitest -- run test/unit/server/session-binding-authority.test.ts --config config/vitest/vitest.server.config.ts`
Expected: FAIL only if the API shape was mis-adapted; these pin EXISTING behavior — get them
green against the current implementation without changing it.

- [ ] **Step 2: Emit previousSessionId on the fork-handoff fanout**

In the fork-handoff commit success path (`terminal-registry.ts` around `:2783-2835`), the parent
(pre-swap) session id is in scope — include it in the emitted `terminal.session.bound` payload
(add an optional `previousSessionId` to that internal event's type) and in the record-scoped
associated sends at `:2826`/`:3058`. In `server/index.ts:689`, forward it onto the
`terminal.session.associated` message:

```ts
        send({
          type: 'terminal.session.associated',
          terminalId: event.terminalId,
          sessionRef: event.sessionRef,
          ...(event.previousSessionId ? { previousSessionId: event.previousSessionId } : {}),
        })
```

Extend the existing fork-handoff tests
(`test/unit/server/terminal-registry.codex-sidecar.test.ts:908/984/1343` neighborhood) with one
assertion: the emitted associated message carries `previousSessionId` equal to the parent id.

- [ ] **Step 3: Run the Node suites**

Run: `npm run test:vitest -- run test/unit/server/session-binding-authority.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --config config/vitest/vitest.server.config.ts && npm run test:port`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/ test/unit/server/
git commit -m "feat(server): Node fork handoff emits previousSessionId; pin swapTerminalSession guards (P6)"
```

---

### Task 16: Final verification gate

**Files:** none new — full-tree verification.

- [ ] **Step 1: Rust**

Run: `cargo test --workspace` then `cargo clippy --workspace -- -D warnings`
Expected: PASS, zero warnings. Fix anything found (in the owning task's files, as follow-up
commits with `fix:` prefixes).

- [ ] **Step 2: Contract + JS**

Run: `npm run test:port && npm run contract:generate && git diff --exit-code port/contract/`
Expected: PASS, no diff.
Run: `npm run test:unit` (coordinator-gated full unit suite) — if the environment's coordinator
gate blocks, fall back to the scoped runs from Tasks 2/10/15 plus
`npm run test:vitest -- run test/unit/client test/unit/server --config config/vitest/vitest.config.ts`
per the coordinator's guidance, and say which ran in the commit message.
Expected: PASS.

- [ ] **Step 3: Verify no 3002 contact (constraint audit)**

Run: `grep -rn "3002\|3001" crates/freshell-ws/tests/*.rs | grep -v "never 3001/3002" || true`
Expected: no test binds or targets 3001/3002 (loopback ephemeral only).

- [ ] **Step 4: Commit any stragglers and push the branch**

```bash
git status --short   # must be clean or only intended files
git push -u origin HEAD
```

Do NOT open a PR (explicit user approval required; the workflow stops here).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- P1 mid-session codex rebind end-to-end (identity registry, meta, ledger tombstone/supersede,
  tailer re-attach, client-accepted authoritative frame, restart resumes NEW id, hijack guard):
  Tasks 1–7.
- P2 contested-cwd starvation + audit of opencode/amplifier census + orphaned pending markers:
  Task 8 (audit recorded in commit message; findings in the "Verified incident facts" section),
  Task 9.
- P3 opencode/amplifier rebind with audit-first discipline: Tasks 13–14 (+ committed audit doc).
- P4 claude deterministic mechanism (SessionStart hook — chosen over the JSONL-watcher fallback
  because claude writes no lineage on disk; fully implemented, not a design doc): Tasks 11–12.
- P5 sidebar fork visibility: Task 10.
- P6 Node parity (contract-only discipline audited; previousSessionId emission + swap tests;
  Node parser mirror in Task 10): Task 15.
- Constraints (3002 untouched, worktree, TDD, no PR, D7/D8/A13/restore-ladder preserved,
  deterministic signals, real fixture shapes): Global Constraints + guard steps throughout +
  Task 16 audit.

**1b. No silent deferrals:** every requirement lands as production behavior with a
production-path test: the codex story is proven by `codex_fork_rebind.rs` (real server, real
frames, real argv of the respawned CLI); claude by `claude_session_rebind.rs` (same); amplifier
by `amplifier_fork_rebind.rs`; opencode by locator-level tests against its real SQLite substrate
shape plus the shared guarded write path (the audit doc records the verified trigger semantics).
Fake CLIs (`sh` scripts) are the repo's established argv-capture idiom for launch verification,
not behavior stubs — the behavior under test (identity movement + resume argv) is fully real.
No requirement was moved to "known limitations"/"future work". No unresolved coverage gaps.

**2. Placeholder scan:** the remaining "adapt names to the file's actuals" instructions are
anchored to exact files/lines with the contract pinned by the surrounding test code — none are
TBDs. Steps that intentionally summarize a test's phases (Tasks 7, 12, 14) still specify every
assertion and the exact fixtures/helpers to copy from named precedents.

**3. Type consistency:** `previousSessionId` (wire, camelCase) / `previous_session_id` (Rust)
used consistently across Tasks 1, 2, 5, 12, 13, 15. `ForkLocated`/`watch_fork`/
`note_fork_submit`/`tick_forks` names match between Task 4 (definition) and Tasks 5–7
(consumption); amplifier/opencode analogs are namespaced per-locator. The shared broadcaster's
provider parameterization is reconciled in Task 12's note against Task 5's definition.
