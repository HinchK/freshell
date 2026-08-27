# Server-Build Mismatch Auto-Reload Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** When a browser tab connects (or reconnects) to a Freshell server built from a different commit than the client bundle it is running, the client detects the mismatch from the WS `ready` frame and reloads itself exactly once — self-healing the "Fresh-agent snapshot response did not match the shared contract" class of stale-client failures without ever reload-looping.

**Architecture:** All three producers stamp the same identity — `git rev-parse HEAD` with literal `"unknown"` fallback (Rust at compile time via the existing `build.rs`, Node at first use via a new cached module, client at Vite build time via a `define` constant). The WS `ready` message gains an additive optional `buildId` field (omitted from the wire when the Rust value is `None`, so frozen transcripts stay byte-identical; the Node frame always stamps it, mirroring `bootId`). The client compares its baked `__FRESHELL_BUILD_ID__` against every parsed `ready.buildId`; on mismatch it sets a `sessionStorage` sentinel and calls `location.reload()` exactly once per tab session (the sentinel also self-clears on a subsequent match, re-arming the guard).

**Tech Stack:** Rust (serde/serde_json, tokio, existing `freshell-protocol`/`freshell-ws` crates), Node.js/ESM (`node:child_process`), React 18 + Vite `define` + Zod, Vitest (jsdom client config / node server config), Playwright (rust-chromium project).

## Global Constraints

- **Worktree discipline:** All work happens in `/home/dan/code/freshell/.worktrees/server-version-reload` on branch `the-usual/server-version-reload`. Never run `node dist/server/index.js`; never touch the live 3001 server or `~/.freshell` state. No deploy/restart is part of this plan.
- **Additive contract only ("bootId doctrine"):** `buildId` is optional everywhere and omitted from the wire when the Rust value is `None`. Old clients must not break; the frozen `port/oracle/fixtures/handshake-transcript.json` must remain byte-valid without regenerating it. The Node ready frame ALWAYS stamps `buildId` (string, `"unknown"` fallback) — mirroring how it always stamps `bootId` — and the Rust handshake always stamps `Some(...)` from `WsState.build_id`. Both servers MUST stamp in the same commit (Task 1): the T0 oracle deep-diffs node-vs-rust handshakes, so an intermediate where only one side stamps would fail it.
- **Value semantics on every side:** the value is the full `git rev-parse HEAD` SHA of the repo at build/bake time; when git is unavailable or the output is not 40 lowercase hex chars, the literal `"unknown"`. The client's compare rule: reload iff BOTH ids are present, non-empty, neither is `"unknown"`, and they differ. `"unknown" == "unknown"` is NOT a match-and-clear (it is a no-op) — two unknown builds must never trigger a reload and must never clear an armed sentinel.
- **Loop-guard invariant:** at most ONE reload per tab session. The sentinel key is `freshell.server-build-reload` (`sessionStorage`, value `"1"`), set BEFORE calling `reload()`. If `sessionStorage` throws, no reload happens (fail-safe). A matching `ready` clears the sentinel (self-re-arm).
- **Client module must not crash under Vitest:** the Vitest client config has no `__FRESHELL_BUILD_ID__` define, so the module must use a `typeof __FRESHELL_BUILD_ID__ === 'undefined'` guard (same precedent as `src/lib/perf-logger.ts:45` with `__PERF_LOGGING__`).
- **NodeNext/ESM:** every relative import in `server/` and `shared/` uses `.js` extensions; client code uses `@/` aliases without extensions.
- **Test coordination:** broad suites go through the repo coordinator (`npm run test:vitest -- run ...`); never raw `npx vitest`. Focused Rust tests use `cargo test -p <crate>` directly.
- **Scope boundary:** client-only redeploys (redeploying a new client bundle WITHOUT a server change) are deliberately NOT covered — no auto-refresh loop, no polling, no `/api/server-info` polling fallback. The ready-frame compare is the only trigger.
- **No unrelated restructuring; comments explain invariants, in the existing voice.**

---

### Task 1: Protocol + both servers stamp `ready.buildId`

**Files:**
- Modify: `shared/ws-protocol.ts:743-750` (`ReadyMessage` type)
- Modify: `crates/freshell-protocol/src/server_messages.rs:792-806` (`Ready` struct)
- Modify: `crates/freshell-ws/src/lib.rs:97-124` (`WsState` struct field), `:529-546` (`build_handshake_with_capabilities`), `:868-917` (`state()` test builder)
- Modify: `crates/freshell-server/src/main.rs:1011-1066` (`WsState` literal)
- Modify: `crates/freshell-protocol/tests/pane_reconcile.rs:52-82` (two `Ready` literals)
- Create: `server/build-id.ts`
- Modify: `server/ws-handler.ts` (import block; field after `:587`; init after `:651`; ready send `:2034-2039`)
- Modify (generated): `port/contract/ws-server-messages.schema.json` (via `npm run contract:generate`)
- Test: `crates/freshell-protocol/tests/roundtrip.rs` (new test after `ready_carries_server_instance_id_and_boot_id`, which ends at line 164)
- Test: `crates/freshell-ws/src/lib.rs` `#[cfg(test)] mod tests` (new test after `handshake_is_ordered_with_shared_bootid`, which ends at line 1026)
- Test: `test/server/build-id.test.ts` (new)
- Test: `test/server/ws-handshake-snapshot.test.ts` (new test after the `includes a bootId in the ready message...` test, which ends at line 301)

**Interfaces:**
- Consumes: `crates/freshell-server/src/diag.rs:124` `pub(crate) fn build_commit() -> &'static str` (already returns the baked `FRESHELL_BUILD_COMMIT` or `"unknown"`; `build.rs` re-stamps on HEAD moves — no change needed there).
- Produces: `freshell_protocol::Ready { build_id: Option<String> }` (serde camelCase → wire key `buildId`, skipped when `None`); `freshell_ws::WsState { build_id: Arc<String> }`; `server/build-id.ts` exporting `computeBuildId(cwd?: string): string` (pure) and `serverBuildId(): string` (cached per process); TS `ReadyMessage.buildId?: string`; regenerated `port/contract/ws-server-messages.schema.json` with an optional `buildId` on `ready` (still `additionalProperties: false`). Task 2's client schema and Task 3's e2e injection consume the wire key `buildId`.

- [ ] **Step 1: Write the failing behavioral tests (protocol roundtrip, rust wire, node module, node wire)**

1a. Add to `crates/freshell-protocol/tests/roundtrip.rs` immediately after the `ready_carries_server_instance_id_and_boot_id` test (line 164):

```rust
#[test]
fn ready_carries_build_id_and_omits_it_when_absent() {
    // deliverable: `ready` accepts an additive optional `buildId` (the git
    // commit the server binary was built from) and OMITS it from the wire
    // when absent — frozen-transcript inertness, same rule as `bootId`.
    let with = r#"{"type":"ready","timestamp":"2026-07-05T04:20:52.546Z","serverInstanceId":"srv-abc","buildId":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"}"#;
    match server_roundtrip(with, "ready") {
        ServerMessage::Ready(r) => {
            assert_eq!(
                r.build_id.as_deref(),
                Some("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
            );
        }
        other => panic!("expected Ready, got {other:?}"),
    }

    let without = r#"{"type":"ready","timestamp":"2026-07-05T04:20:52.546Z","serverInstanceId":"srv-abc"}"#;
    let msg: ServerMessage = serde_json::from_str(without).unwrap();
    let reser = serde_json::to_value(&msg).unwrap();
    assert!(
        reser.get("buildId").is_none(),
        "ready must omit buildId when absent: {reser}"
    );
    match msg {
        ServerMessage::Ready(r) => assert_eq!(r.build_id, None),
        other => panic!("expected Ready, got {other:?}"),
    }
}
```

1b. Add to `crates/freshell-ws/src/lib.rs` inside `mod tests`, immediately after `handshake_is_ordered_with_shared_bootid` (line 1026):

```rust
    /// The handshake `ready` stamps the build identity (`WsState.build_id`,
    /// baked from `diag::build_commit()` by `freshell-server`'s `main.rs`) so
    /// the browser client can detect a client/server build mismatch and
    /// reload once. Serde omits the field when `None`; a real server always
    /// stamps `Some` (sha or `"unknown"`), so presence is asserted here.
    #[tokio::test]
    async fn handshake_ready_stamps_build_id() {
        let msgs = build_handshake(&state()).await;
        let ready = serde_json::to_value(&msgs[0]).unwrap();
        assert_eq!(ready["buildId"], "build-3333");
    }
```

1c. Create `test/server/build-id.test.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeBuildId, serverBuildId } from '../../server/build-id.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('server build id', () => {
  it('returns the current git HEAD sha for the repository', () => {
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim()
    expect(computeBuildId(REPO_ROOT)).toBe(expected)
  })

  it('falls back to "unknown" outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-no-git-'))
    try {
      expect(computeBuildId(dir)).toBe('unknown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caches the id within a process', () => {
    expect(serverBuildId()).toBe(serverBuildId())
  })
})
```

1d. In `test/server/ws-handshake-snapshot.test.ts`, immediately after the `includes a bootId in the ready message that differs from serverInstanceId` test (ends line 301), add:

```typescript
  it('includes a buildId in the ready message, stable across clients in the same process', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await Promise.all([
        new Promise<void>((resolve) => ws1.on('open', () => resolve())),
        new Promise<void>((resolve) => ws2.on('open', () => resolve())),
      ])

      const [ready1, ready2] = await Promise.all([
        waitForReady(ws1, 10_000),
        waitForReady(ws2, 10_000),
      ])

      // Always stamped (sha or "unknown" fallback), stable within the process.
      expect(typeof ready1.buildId).toBe('string')
      expect((ready1.buildId as string).length).toBeGreaterThan(0)
      expect(ready2.buildId).toBe(ready1.buildId)
      // Distinct identity axis: not the boot id, not the instance id.
      expect(ready1.buildId).not.toBe(ready1.bootId)
    } finally {
      await closeWs(ws1)
      await closeWs(ws2)
    }
  })
```

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
cargo test -p freshell-protocol --test roundtrip ready_carries_build_id_and_omits_it_when_absent
cargo test -p freshell-ws handshake_ready_stamps_build_id
npm run test:vitest -- run test/server/build-id.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: all FAIL for the missing behavior — the two Rust commands fail to COMPILE (`no field \`build_id\` on struct Ready` / `no field \`build_id\` on struct WsState`); `build-id.test.ts` fails to resolve `../../server/build-id.js` (module missing); the new snapshot test fails on `expect(typeof ready1.buildId).toBe('string')` (the Node ready frame carries no `buildId`).

- [ ] **Step 3: Add the minimal production implementation**

3a. `shared/ws-protocol.ts` — in `ReadyMessage` (lines 743-750), add after `bootId`:

```typescript
export type ReadyMessage = {
  type: 'ready'
  timestamp: string
  serverInstanceId?: string
  bootId?: string
  /** The git commit the server binary was built from ("unknown" fallback).
   *  Additive/optional bootId doctrine: the client bakes its own build id at
   *  Vite build time and reloads once on a mismatch. Omitted from the wire
   *  when the Rust value is None. */
  buildId?: string
  /** Present iff the client's hello opted in via capabilities.paneReconcileV1. */
  capabilities?: ReadyCapabilities
}
```

3b. Regenerate the outbound schema bundle (picks up `buildId` as an optional modeled property on `ready` — keeping `test/unit/port/ws-contract-freeze.test.ts`'s "committed schema deep-equals a fresh regeneration" AND `mutation-validation.test.ts`'s `additional-property` case green, since the schema stays `additionalProperties: false`):

```bash
npm run contract:generate
git diff --stat port/contract/ws-server-messages.schema.json
```

Expected: the regenerated diff adds an optional `buildId` property to the `ready` message schema; inventory/message counts unchanged.

3c. `crates/freshell-protocol/src/server_messages.rs` — in `Ready` (lines 792-806), add after the `server_instance_id` field:

```rust
    /// The git commit this server binary was built from (`"unknown"`
    /// fallback), stamped so the browser client can detect a client/server
    /// build mismatch and reload once. Omitted from the wire entirely when
    /// `None` (frozen-client inertness — same rule as `boot_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
```

3d. `crates/freshell-ws/src/lib.rs` — in `WsState`, after the `boot_id` field (line 103):

```rust
    /// The git commit this server binary was built from (`"unknown"`
    /// fallback) — baked once per build by `freshell-server`'s `main.rs` from
    /// `diag::build_commit()` and stamped into every handshake's `ready`.
    pub build_id: Arc<String>,
```

In `build_handshake_with_capabilities`, in the `Ready` literal (lines 536-546), add after `server_instance_id`:

```rust
            build_id: Some(state.build_id.as_ref().clone()),
```

3e. Fix every struct-literal site so the workspace compiles. In `crates/freshell-ws/src/lib.rs`'s `state()` test builder (after `boot_id: Arc::new("boot-2222".to_string()),` at line 878):

```rust
            build_id: Arc::new("build-3333".to_string()),
```

In `crates/freshell-server/src/main.rs`'s `WsState` literal (after the `boot_id: Arc::clone(&boot_id),` line at 1031):

```rust
        // The build identity every handshake `ready` stamps (client-side
        // stale-bundle auto-reload). SAME source `GET /api/server-info`'s
        // `commit` reports — one source of truth (`diag::build_commit()`).
        build_id: Arc::new(crate::diag::build_commit().to_string()),
```

In `crates/freshell-protocol/tests/pane_reconcile.rs`, both `Ready` literals (lines 56-61 and 71-79) each get:

```rust
        build_id: None,
```

Then enumerate any remaining literal sites:

```bash
cargo check --workspace --all-targets 2>&1 | rg "missing field" || echo "no missing-field errors"
```

Expected: `no missing-field errors` (if any site beyond the ones above is listed, add `build_id: None` — or, for `WsState` literals, a `build_id: Arc::new(...)` value — the same way; every site compiles before proceeding).

3f. Create `server/build-id.ts`:

```typescript
import { execFileSync } from 'node:child_process'

const SHA_PATTERN = /^[0-9a-f]{40}$/

/**
 * The git commit this server process runs from — the SAME identity the Rust
 * server bakes at compile time (`crates/freshell-server/src/diag.rs`'s
 * `build_commit()`) and the client bakes at Vite build time
 * (`__FRESHELL_BUILD_ID__`). Falls back to the literal `"unknown"` when git
 * is unavailable or the output is not a full 40-hex sha; the client's
 * compare rule ignores `"unknown"` on both sides, so a git-less deployment
 * never triggers a reload and never clears an armed one.
 */
export function computeBuildId(cwd: string = process.cwd()): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim()
    return SHA_PATTERN.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

let cached: string | undefined

/** Per-process cached build id — one git probe per server lifetime. */
export function serverBuildId(): string {
  if (cached === undefined) cached = computeBuildId()
  return cached
}
```

3g. In `server/ws-handler.ts`:

Add the import alongside the other relative imports at the top of the file:

```typescript
import { serverBuildId } from './build-id.js'
```

Add the field after `private readonly bootId: string` (line 587):

```typescript
  private readonly buildId: string
```

Initialize it after `this.bootId = \`boot-${randomUUID()}\`` (line 651):

```typescript
    this.buildId = serverBuildId()
```

Extend the ready send (lines 2034-2039):

```typescript
        this.send(ws, {
          type: 'ready',
          timestamp: nowIso(),
          serverInstanceId: this.serverInstanceId,
          bootId: this.bootId,
          buildId: this.buildId,
        })
```

- [ ] **Step 4: Run the focused tests**

```bash
cargo test -p freshell-protocol --test roundtrip ready_carries_build_id_and_omits_it_when_absent
cargo test -p freshell-ws handshake_ready_stamps_build_id
npm run test:vitest -- run test/server/build-id.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor while green**

No refactor needed — every addition mirrors the adjacent `bootId` idiom on its side. Do NOT regenerate `port/oracle/fixtures/handshake-transcript.json`: the frozen transcript stays byte-valid because Rust omits `build_id` when deserialized as `None`, and the mutation/oracle suites consume the regenerated SCHEMA (not the live node bytes) for conformance.

- [ ] **Step 6: Run impacted-test verification**

This change touches the shared wire protocol, both server implementations, and the generated schema, so the impacted set is: both Rust crates' full test trees, the workspace compile of every literal site, the whole server-config suite (any test asserting handshake/ready shapes), and the port-oracle suites. **`npm run test:port` does NOT run the oracle suites** (`vitest.port.config.ts` excludes `test/unit/port/oracle/**`; they are deliberately outside the coordinator and run only via `npm run test:oracle`, which boots real servers — budget several minutes). Note on `t0-equivalence-rust.test.ts`: its node-vs-rust deep diff compares `ready` frames value-by-value (`buildId` is NOT in the normalization registry, so it is compared RAW) — both sides stamp the SAME value (the worktree HEAD sha: the oracle node target runs from an isolated runtime root under the worktree so `git rev-parse HEAD` walk-up resolves the worktree sha; the rust target is `cargo build`-ed at test time by `ensureRustServerBuilt` and `build.rs` re-stamps on HEAD moves; Node computes the same sha at runtime), or both `"unknown"` in git-less environments, so the diff stays clean — and this run is the proof.

```bash
cargo test -p freshell-protocol
cargo test -p freshell-ws
cargo check --workspace --all-targets
npm run test:integration
npm run test:port
npm run test:oracle
```

Expected: all PASS.

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts crates/freshell-protocol/src/server_messages.rs crates/freshell-protocol/tests/roundtrip.rs crates/freshell-protocol/tests/pane_reconcile.rs crates/freshell-ws/src/lib.rs crates/freshell-server/src/main.rs server/build-id.ts server/ws-handler.ts test/server/build-id.test.ts test/server/ws-handshake-snapshot.test.ts port/contract/ws-server-messages.schema.json
git commit -m "feat(protocol): both servers stamp additive optional ready.buildId (git HEAD)"
```

---

### Task 2: Client compares on `ready` and reloads once (module + Vite define + App wiring)

**Files:**
- Create: `src/lib/server-build-check.ts`
- Modify: `config/vite/vite.config.ts` (git-probe helper near the top-level helpers after line 10; extend the `define` block at lines 58-60)
- Modify: `src/vite-env.d.ts:12` (declare the constant)
- Modify: `src/App.tsx` (import near the other `@/lib` imports; `ReadyMessageSchema` at lines 157-166; call site after the bootId warn block ending at line 1031)
- Test: `test/unit/client/lib/server-build-check.test.ts` (new)
- Test: `test/unit/client/components/App.restart-signals.test.tsx` (new `describe` block at the end of the file, reusing that file's harness helpers)

**Interfaces:**
- Consumes: Task 1's wire contract (`ReadyMessage.buildId?: string`, parsed by `ReadyMessageSchema`).
- Produces: `checkServerBuildId(options?: ServerBuildCheckOptions): void` from `@/lib/server-build-check`, with `ServerBuildCheckOptions { clientBuildId?: string; serverBuildId?: string; reload?: () => void; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }`; `__FRESHELL_BUILD_ID__: string` available client-side at build time. Task 3's e2e exercises the production wiring end to end.

- [ ] **Step 1: Write the failing behavioral tests**

1a. Create `test/unit/client/lib/server-build-check.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkServerBuildId } from '@/lib/server-build-check'

const SENTINEL = 'freshell.server-build-reload'

function mapStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  }
}

describe('checkServerBuildId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads once and sets the sentinel on a real mismatch', () => {
    const storage = mapStorage()
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('1')
  })

  it('never reloads twice: an armed sentinel suppresses the reload', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, '1')
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('1')
  })

  it('a matching ready clears the sentinel (self-re-arm)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, '1')
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'a'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBeUndefined()
  })

  it('is a no-op when either side is missing, empty, or "unknown"', () => {
    for (const opts of [
      { clientBuildId: 'a'.repeat(40), serverBuildId: undefined },
      { clientBuildId: undefined, serverBuildId: 'b'.repeat(40) },
      { clientBuildId: '', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'unknown', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'a'.repeat(40), serverBuildId: 'unknown' },
      { clientBuildId: 'unknown', serverBuildId: 'unknown' },
    ] as const) {
      const storage = mapStorage()
      const reload = vi.fn()
      checkServerBuildId({ ...opts, reload, storage })
      expect(reload, JSON.stringify(opts)).not.toHaveBeenCalled()
      expect(storage._map.get(SENTINEL)).toBeUndefined()
    }
  })

  it('an armed sentinel survives an "unknown"-vs-"unknown" ready (never treated as a match)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, '1')
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'unknown', serverBuildId: 'unknown', reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('1')
  })

  it('does not reload when the sentinel cannot be persisted (fail-safe against reload loops)', () => {
    const reload = vi.fn()
    const storage = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('quota') },
    }
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
  })

  it('falls back to the __FRESHELL_BUILD_ID__ global and window defaults when options are omitted', () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'c'.repeat(40))
    const reload = vi.fn()
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // replace window-level with a spread copy.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()

    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(SENTINEL)).toBe('1')

    // And with the global absent (Vitest has no define), it is a no-op.
    vi.unstubAllGlobals()
    sessionStorage.removeItem(SENTINEL)
    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})
```

1b. In `test/unit/client/components/App.restart-signals.test.tsx`, append a new `describe` block at the end of the file. It reuses that file's existing harness plumbing (`createStore`, `renderApp`, `sendReady`, `wsMocks`, `messageHandler`, `stubAudio`, `terminalRestoreMocks`, `fetchSidebarSessionsSnapshot`, `getTerminalDirectoryPage`, `searchTerminalView`, `apiGet`, `defaultServerSettings`, `defaultSettings` — all defined at the top of that file; mirror the existing describe's beforeEach exactly):

```tsx
describe('App ready buildId → one-shot server-build reload', () => {
  let originalLocation: Location
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockReturnValue(() => {})
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    terminalRestoreMocks.addTerminalRestoreRequestId.mockClear()
    terminalRestoreMocks.addTerminalFreshRecoveryRequestId.mockClear()
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    getTerminalDirectoryPage.mockReset()
    getTerminalDirectoryPage.mockResolvedValue({ items: [], revision: 1, nextCursor: null })
    searchTerminalView.mockReset()
    searchTerminalView.mockResolvedValue({ matches: [] })

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })

    sessionStorage.clear()
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // window-level replacement with save/restore.
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()
  })

  it('mismatched ready buildId triggers exactly one reload, and the sentinel suppresses the next mismatched ready', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(window.location.reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBe('1')

    // Reconnect delivers another mismatched ready (stale server still up):
    // the sentinel must suppress the reload.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('a matching ready clears the sentinel and re-arms the guard', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    sessionStorage.setItem('freshell.server-build-reload', '1')
    const store = createStore()
    await renderApp(store)

    // Server caught up to the client build (the post-reload convergence
    // case): match → sentinel cleared, no reload.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'a'.repeat(40) })
    expect(window.location.reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })

  it('never reloads on missing or "unknown" buildIds', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'unknown' })
    expect(window.location.reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: FAIL — `server-build-check.test.ts` cannot resolve `@/lib/server-build-check` (module missing), and the App tests fail because a ready with `buildId` triggers no reload (`expect(window.location.reload).toHaveBeenCalledTimes(1)` sees 0).

- [ ] **Step 3: Add the minimal production implementation**

3a. Create `src/lib/server-build-check.ts`:

```typescript
import { createLogger } from '@/lib/client-logger'

const log = createLogger('ServerBuildCheck')

const SERVER_BUILD_RELOAD_SENTINEL = 'freshell.server-build-reload'

export interface ServerBuildCheckOptions {
  /** The client's own baked build id; defaults to `__FRESHELL_BUILD_ID__`. */
  clientBuildId?: string
  /** The server's `ready.buildId`. */
  serverBuildId?: string
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

/**
 * The client's Vite-baked build id (`config/vite/vite.config.ts` defines it
 * from `git rev-parse HEAD`). `typeof`-guarded because the Vitest client
 * config has no define for it (same precedent as `__PERF_LOGGING__` in
 * `src/lib/perf-logger.ts`) — an unbaked id means "cannot compare", never
 * "reload".
 */
function resolveClientBuildId(): string | undefined {
  if (typeof __FRESHELL_BUILD_ID__ === 'undefined') return undefined
  const id = __FRESHELL_BUILD_ID__
  return id.length > 0 ? id : undefined
}

/**
 * Compare the server's `ready.buildId` against our own baked build id and
 * reload ONCE on a real mismatch. Invariants:
 * - reload iff BOTH ids are present, non-empty, neither is "unknown", and
 *   they differ ("unknown" == "unknown" is a no-op, never a match-and-clear);
 * - the sessionStorage sentinel is set BEFORE reloading and suppresses any
 *   further reloads this tab session (a half-deployed server can never
 *   reload-loop; sessionStorage access failure = no reload, fail-safe);
 * - a MATCHING ready clears the sentinel (self-re-arm after convergence).
 * KNOWN LIMIT (accepted for the self-hosted single-server threat model):
 * the "once" guarantee is per server identity — one origin fronted by
 * servers built from DIFFERENT commits can oscillate (mismatch → reload →
 * match clears → mismatch → …). Deliberately not hardened with a
 * clears-per-session cap; revisit only if a split-deploy origin appears.
 */
export function checkServerBuildId(options?: ServerBuildCheckOptions): void {
  const clientBuildId = options?.clientBuildId ?? resolveClientBuildId()
  const serverBuildId = options?.serverBuildId
  if (!clientBuildId || !serverBuildId) return
  if (clientBuildId === 'unknown' || serverBuildId === 'unknown') return

  const reload = options?.reload ?? (() => window.location.reload())
  const storage = options?.storage ?? window.sessionStorage

  if (clientBuildId === serverBuildId) {
    try {
      storage.removeItem(SERVER_BUILD_RELOAD_SENTINEL)
    } catch {
      // Ignore sessionStorage access failures.
    }
    return
  }

  try {
    if (storage.getItem(SERVER_BUILD_RELOAD_SENTINEL) === '1') {
      log.warn(
        `server build ${serverBuildId} still differs from client build ${clientBuildId}; `
        + 'one reload already attempted this tab session — suppressing further reloads',
      )
      return
    }
    storage.setItem(SERVER_BUILD_RELOAD_SENTINEL, '1')
  } catch {
    // Cannot persist the sentinel: reloading without it risks a loop.
    return
  }
  log.warn(
    `server build ${serverBuildId} differs from client build ${clientBuildId}; `
    + 'reloading once to pick up the matching client bundle',
  )
  reload()
}
```

3b. In `config/vite/vite.config.ts` — add the import at the top (with the other node imports, after line 5):

```typescript
import { execFileSync } from 'node:child_process'
```

Add the helper after `projectRoot` (line 10):

```typescript
/**
 * The client's build identity: the git commit the bundle was built from,
 * matching the server-side stamp (`crates/freshell-server/src/diag.rs`'s
 * `build_commit()` / `server/build-id.ts`). `"unknown"` fallback — the
 * client's compare rule ignores `"unknown"` on both sides.
 */
function computeClientBuildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}
```

Extend the existing `define` block (lines 58-60):

```typescript
    define: {
      __PERF_LOGGING__: JSON.stringify(env.PERF_LOGGING || ''),
      __FRESHELL_BUILD_ID__: JSON.stringify(computeClientBuildId()),
    },
```

3c. In `src/vite-env.d.ts`, add after line 12:

```typescript
declare const __FRESHELL_BUILD_ID__: string
```

3d. In `src/App.tsx`:

Add the import near the other `@/lib` imports (after the `installTestHarness` import at line 35):

```typescript
import { checkServerBuildId } from '@/lib/server-build-check'
```

Extend `ReadyMessageSchema` (lines 157-166), after the `bootId` line:

```typescript
  bootId: z.string().min(1).optional(),
  // The server's baked build identity (additive/optional — old servers omit
  // it). Compared in checkServerBuildId below; must never fail the WHOLE
  // ready frame, hence optional + min(1) only.
  buildId: z.string().min(1).optional(),
```

Add the call inside the `else` (ready-success) branch, immediately after the `if (!newBootId) { ... }` warn block that ends at line 1031:

```typescript
            // Server-build mismatch detection: the server stamps the git
            // commit it was built from (ready.buildId, additive/optional);
            // we compare it against our own Vite-baked
            // __FRESHELL_BUILD_ID__ and reload ONCE on a mismatch (sentinel
            // loop-guard lives in src/lib/server-build-check.ts).
            checkServerBuildId({ serverBuildId: ready.data.buildId })
```

- [ ] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Verify the Vite define actually bakes the sha into the bundle:

```bash
npm run build:client
rg -o "$(git rev-parse HEAD)" dist/client/assets/*.js | head -1
```

Expected: at least one match (the baked sha appears in the built bundle). (`npm run build:client` from this worktree writes the worktree's own `dist/client` — the main-checkout `npm run build` production-server guard does not apply here.)

- [ ] **Step 6: Run impacted-test verification**

`ReadyMessageSchema` and App's ready handling are shared client-critical paths and the define constant touches the whole client build; the impacted set is the client unit suite plus typecheck and lint:

```bash
npm run typecheck:client
npm run lint
npm run test:vitest -- run test/unit/client
```

Expected: all PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/server-build-check.ts config/vite/vite.config.ts src/vite-env.d.ts src/App.tsx test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
git commit -m "feat(client): reload once when ready.buildId differs from the baked build id"
```

---

### Task 3: E2E proof (rust-chromium) + docs

**Files:**
- Create: `test/e2e-browser/specs/server-build-mismatch-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to `RUST_ONLY_SPECS`, whose `/create-protection-isolation-rust\.spec\.ts$/,` entry is at line 204; add the spec to the `rust-chromium` project's `testMatch`, whose `/codex-terminal-bounce-rust\.spec\.ts$/,` entry is at line 371)
- Modify: `AGENTS.md` (one-line note under "Key Architectural Patterns → WebSocket Protocol")

**Interfaces:**
- Consumes: Tasks 1-2 (both servers stamp `ready.buildId`; the client compares and reloads once; `TestHarness.receiveWsMessage` → `ws.receiveMessageForTest` → `handleIncomingMessage` feeds an injected frame through the real App ready handler — verified at `src/lib/ws-client.ts:917-919`).
- Produces: the user-outcome proof — a stale client against a newer server reboots itself exactly once and converges to a healthy ready connection; repeat mismatches are suppressed by the sentinel.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/specs/server-build-mismatch-rust.spec.ts`:

```typescript
/**
 * Server-build mismatch auto-reload (the-usual/server-version-reload).
 *
 * The user story: a tab running a client bundle built at commit A connects
 * to a server built at commit B; the server's `ready.buildId` differs from
 * the client's baked `__FRESHELL_BUILD_ID__`; the client reloads EXACTLY
 * ONCE (sentinel `freshell.server-build-reload` in sessionStorage) and
 * converges to a healthy ready connection. A repeat mismatched ready must
 * NOT reload again — a half-deployed server can never reload-loop.
 *
 * Mismatch is injected with `harness.receiveWsMessage` (a REAL server
 * stamps its own sha, which may or may not equal this worktree's client
 * bake — the injection makes the compare deterministic either way). The
 * injected frame flows through the production pipeline: ws-client
 * `receiveMessageForTest` → `handleIncomingMessage` → App's ready handler
 * → `ReadyMessageSchema` → `checkServerBuildId`.
 *
 * Service workers are blocked (perf-harness precedent,
 * recover-my-panes-rust.spec.ts's FRESH_CONTEXT_OPTIONS) so the count of
 * navigations is exactly the reloads this feature performs.
 *
 * Rust-only: registers under `rust-chromium` + RUST_ONLY_SPECS (owns a
 * RustServer directly, the e2eServerKind seam not used).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const MISMATCHED_BUILD_ID = 'f'.repeat(40)
const SENTINEL = 'freshell.server-build-reload'

test.describe('server build mismatch reload (rust)', () => {
  let server: RustServer | undefined
  let info: TestServerInfo

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    server = new RustServer()
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
  })

  test('mismatched ready buildId reloads exactly once and converges; the sentinel suppresses repeats', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    let harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Start counting AFTER the boot-time compare so the real ready's own
    // match/mismatch outcome (both artifacts usually share this worktree's
    // HEAD) cannot pollute the count; also re-clear the sentinel so the
    // injected mismatch is the one that arms it.
    await page.evaluate((key) => sessionStorage.removeItem(key), SENTINEL)
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })

    // 1) Injected mismatch → exactly one reload, and the page reboots into a
    //    healthy ready connection (convergence).
    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await expect.poll(() => navigations, { timeout: 20_000 }).toBe(1)
    harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // 2) Re-arm explicitly, then inject the SAME mismatch again: the
    //    sentinel must suppress the reload (no loop). The explicit re-arm
    //    keeps this assertion deterministic regardless of whether the real
    //    server's ready matched the client bake (which would self-clear).
    await page.evaluate((key) => sessionStorage.setItem(key, '1'), SENTINEL)
    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await page.waitForTimeout(3_000)
    expect(navigations, 'sentinel must suppress the second mismatched ready').toBe(1)

    await context.close()
  })
})
```

Register the spec in `test/e2e-browser/playwright.config.ts`:

In `RUST_ONLY_SPECS`, after the `/create-protection-isolation-rust\.spec\.ts$/,` entry:

```typescript
  // Server-build mismatch auto-reload: injects a mismatched ready.buildId
  // through the test harness and proves ONE sentinel-guarded reload.
  // Rust-only: owns a RustServer directly (see the spec header).
  /server-build-mismatch-rust\.spec\.ts$/,
```

In the `rust-chromium` project's `testMatch` array, after the `/codex-terminal-bounce-rust\.spec\.ts$/,` entry:

```typescript
        // Server-build mismatch auto-reload (the-usual/server-version-reload):
        // mismatched ready.buildId → one reload, sentinel suppresses repeats.
        /server-build-mismatch-rust\.spec\.ts$/,
```

In `AGENTS.md`, under "Key Architectural Patterns", append to the **WebSocket Protocol** paragraph:

```
The `ready` frame carries an optional additive `buildId` (the server's baked git commit, `"unknown"` fallback): the client bakes its own at Vite build time (`__FRESHELL_BUILD_ID__`) and, on a mismatch, reloads exactly once per tab session (sessionStorage sentinel `freshell.server-build-reload`), self-healing stale-client contract errors; `"unknown"` on either side never triggers or clears the guard (`src/lib/server-build-check.ts`). The once-guard is per server identity: an origin fronted by mixed-build servers could oscillate (accepted for the single-server self-hosted model).
```

- [ ] **Step 2: Run the test and verify it passes, then RED-VERIFY it exercises the feature**

Build the client fresh first so the served bundle provably contains the feature (the red-verification's validity depends on it):

```bash
npm run build:client
```

With Tasks 1-2 landed the behavior exists, so the fresh test should be green — but a green-only run is not sufficient proof. First run it green:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: PASS.

Then prove it fails for the right reason: temporarily comment out the `checkServerBuildId(...)` call in `src/App.tsx`, rebuild the client, and re-run:

```bash
npm run build:client
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: FAIL — `expect.poll` times out with `navigations` stuck at 0 (no reload happens without the compare).

Restore the call and rebuild:

```bash
npm run build:client
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: PASS. (Record all three runs in the task review — the red-verification is mandatory.)

- [ ] **Step 3: No production implementation step**

Tasks 1-2 implemented the behavior; this task only proves it end to end.

- [ ] **Step 4: Run the focused test**

Same command as Step 2's final run. Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor needed. Confirm the spec is excluded from the match-all `chromium` project by the `RUST_ONLY_SPECS` entry (`testIgnore: RUST_ONLY_SPECS` at `playwright.config.ts:330`) and runs ONLY under `rust-chromium`. Note the spec also runs on the CLOUD e2e lane when `FRESHELL_E2E_BACKEND=cloud` (`playwright.cloud.config.ts` filters only firefox/webkit/continuity-smoke, so `rust-chromium` survives; the spec is not in `CLOUD_SKIP_SPECS`) — do not add it there; coverage comes from Step 6's backend run.

- [ ] **Step 6: Run impacted-test verification**

Playwright registration changed (a new rust-only spec) and AGENTS.md was touched; the impacted set is the rust-chromium smoke that boots a real server (proving the registration change disturbed nothing) plus the two unit files most adjacent to the feature as a final belt-and-suspenders:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/continuity-smoke.spec.ts test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: all PASS.

**Backend proof (repo rule: an affected e2e spec must pass on the configured `FRESHELL_E2E_BACKEND` before a PR is filed):** before the branch is PR'd, run this spec on the configured backend — if `FRESHELL_E2E_BACKEND=cloud`, `npm run test:e2e:cloud` filtered to this spec (this also proves `cargo` availability and the build stamp inside the cloud image); if unset/local, the local runs above satisfy the rule. This is a pre-PR gate recorded in the run log, not part of the task commit.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/server-build-mismatch-rust.spec.ts test/e2e-browser/playwright.config.ts AGENTS.md
git commit -m "test(e2e): rust spec proves one-shot sentinel-guarded reload on ready.buildId mismatch"
```

---

## Post-execution verification (after Task 3)

Run the coordinated full suite once, from the worktree, plus the oracle suites (which `npm run check` deliberately does NOT cover — they live outside the coordinator):

```bash
npm run check
npm run test:oracle
```

Expected: typecheck + full default + server suites PASS, and the oracle suites (t0-equivalence, handshake-determinism, external-handshake, mutation-validation) PASS — `npm run test:oracle` boots real servers and cargo-builds the workspace, so budget several minutes. Also confirm the Task 3 backend proof was recorded (the spec passing on the configured `FRESHELL_E2E_BACKEND`).

**User-outcome recap (maps every requirement to its proof):**

| Requirement | Production behavior | Proof |
| --- | --- | --- |
| Server stamps build identity in `ready` | Rust `WsState.build_id` → `Ready.build_id` (`Some`, sha/`"unknown"`); Node `serverBuildId()` → `buildId`; schema regenerated | roundtrip + wire tests; `test:port`; Node snapshot test |
| Identity = git HEAD, `"unknown"` fallback, everywhere | `build.rs` (existing, HEAD-move aware), `server/build-id.ts`, `computeClientBuildId()` | `build-id.test.ts`; bundle-bake check (Task 2 Step 5) |
| Client compares on every `ready` | `ReadyMessageSchema.buildId` → `checkServerBuildId` in App's ready handler | App.restart-signals describe block |
| Mismatch → reload exactly once | sentinel set before `reload()`; armed sentinel suppresses | unit matrix; e2e navigation count === 1 |
| Never reload-loops (incl. storage failure, repeated mismatches) | fail-safe catch; suppression branch; `"unknown"` no-op | unit cases; e2e repeat-injection step |
| Match clears the sentinel (self-re-arm) | removeItem on equal ids | unit cases; App re-arm test |
| Old servers/forks unaffected (additive contract) | optional field, omitted when `None`; schema stays `additionalProperties: false` | frozen transcript roundtrip; contract-freeze + mutation suites |
| Real-world convergence | reloaded page reconnects and reaches ready | e2e `waitForConnection` after reload |
