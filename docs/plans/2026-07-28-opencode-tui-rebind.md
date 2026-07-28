# Opencode TUI-Plugin Mid-Session Rebind Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Deterministic mid-session rebind for terminal-mode opencode panes: when the user switches sessions inside the opencode TUI (`session_new` / `session_list` / `session_child_cycle`), freshell rebinds the pane's identity to the new session id so a later restart resumes the NEW session instead of the stale one.

**Architecture:** Ship a small static opencode TUI plugin (TypeScript) with freshell, injected per-pane via the `OPENCODE_CONFIG_CONTENT` env var (spike-proven to MERGE with user config and APPEND to the plugin list on opencode 1.18.8). The plugin reads `FRESHELL_TERMINAL_ID` from its env and writes atomic signal files in the exact shape the claude SessionStart lane already uses (`~/.freshell/session-signals/<provider>/<terminalId>__<nonce>.json`). A Rust sweep drains the files and feeds the existing guarded rebind lane (same guard ladder and pinned fan-out as claude/codex, ending in `terminal.session.associated` with `previousSessionId`).

**Tech Stack:** TypeScript (opencode TUI plugin, vitest), Rust (freshell-platform launch injection, freshell-ws signal consumer, cargo/clippy), existing WS contract (no changes).

## Global Constraints

- **Base branch:** this branch (`feat/opencode-tui-rebind`) is STACKED on `fix/stale-resume-identity` (unmerged), NOT `origin/main`. The repo rule says branch from `origin/main`, but this work depends on the unmerged rebind lane (claude signal watcher, `previousSessionId` wire field, guarded rebind plumbing) — the stacked branch is the correct, deliberate deviation. Never rebase onto `origin/main` mid-plan.
- **Production safety:** the live self-hosted Rust server on port **3002** must NEVER be restarted/stopped/touched. Scratch testing only on other ports (`scripts/launch-rust.sh --port <N>`).
- **No PR:** stop after pushing the branch. Do not run `gh pr create`.
- **Never set `--pure` / `OPENCODE_PURE`** anywhere. If the user runs pure mode, plugins are disabled → no signal → today's behavior. That degradation is correct.
- **NEVER fall back to the activity/row-update correlation heuristic** (banned as hijack-capable by `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md`). When unsure, do nothing.
- **Injection is env-only, per-pane.** Never write or modify the user's opencode config (`~/.config/opencode/*`, project `.opencode/opencode.json`). If the server env already carries `OPENCODE_CONFIG_CONTENT`, merge our plugin into that JSON; if it doesn't parse as a JSON object, skip injection entirely (preserve the user's value untouched).
- **Signal validation:** consumer acts only when the filename yields a non-empty terminal id AND the body's `session_id` matches `^ses_[A-Za-z0-9]+$`.
- **Version tolerance:** the plugin must silently no-op if any opencode API surface (`slots`, `route`, `lifecycle`) is absent or shaped differently. Plugin init failure is non-fatal in opencode (logged only); freshell must degrade to no-rebind.
- **Frozen WS contract:** no new frames, no schema changes. `previousSessionId` on `terminal.session.associated` already exists (`shared/ws-protocol.ts:841`, `crates/freshell-protocol/src/server_messages.rs:1074`). The contract-freeze gate (`npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract`) must show no diff.
- **Do not regress base-branch guarantees:** one-writer invariant, A13 (never two live owners of one session id), A8 retired-inclusive ledger guard, D7 live-session guards, D8 leases, pinned fan-out order (identity.upsert → registry.set_meta → awaited `ledger_resolve_identity` → `associated` THEN `meta.updated`), G3 retire-never-defend (new bound ledger row FIRST, then retire+link old).
- **No new `WsState` field** for the watcher — the sweep task owns it (deliberate; every integration test constructs `WsState` as an exhaustive struct literal across ~27 test files). Mirror `claude_signal.rs:12-14`.
- **Rust toolchain:** pinned 1.96.0; gates are `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` (warnings are errors).
- **Rust commit discipline for goldens:** update `cli_launch_goldens.rs` FIRST (verify RED), then implement (GREEN) — the idiom used by the claude signal commit `971a506f`.
- **Coordinated tests:** broad runs via `npm test`/`npm run check` wait on the shared coordinator gate; focused runs via `npm run test:vitest -- run <paths> --config <cfg>`. Never raw `npx vitest`.

## Scope Decisions (locked)

1. **The consumer is Rust-only**, exactly like the claude SessionStart lane on the base branch (`grep -rn "session-signals" server/ src/ shared/` returns zero hits — the Node server has no signal lane, by design). Injection lives in `crates/freshell-platform/src/cli_launch.rs`, which only Rust callers use, so the Node server keeps today's behavior and no unconsumed signal files are ever produced. Node parity for the fan-out already exists on the base branch (`server/session-binding-authority.ts:52-72 swapTerminalSession`: `from_session_mismatch` ≙ D7, `target_session_already_owned` ≙ A13) and is untouched.
2. **No D7 old-owner guard needed beyond the claude ladder:** like claude's hook, the producer is per-terminal by construction (the plugin reads `FRESHELL_TERMINAL_ID` from its own PTY env), so the live-pane + provider-match check substitutes for codex's old-owner predicate (see `claude_signal.rs:127-223` note).
3. **No sqlite `parent_id` cross-check:** the plugin reads the session id from the TUI's own route/slots (the session the user is LOOKING at), which is user-facing by construction. The server event bus is not consulted, so the subagent filter reduces to id-shape validation. (Documented in the audit-doc update, Task 6.)
4. **Activity/status tracking needs no repoint:** the Node terminal-opencode activity tracker keys on `terminalId` + the pane's own loopback SSE port (`server/opencode-activity-tracker.ts:207-211`), session-agnostic; the Rust server has no opencode activity tracker; `fresh_opencode` is a separate lane that never binds terminal panes (and the fresh-agent ledger guard refuses cross-kind claims). The Rust `opencode_locator` is single-bind adoption (arm consumed at first bind) and cannot fight a later rebind. No code change; the crown test's post-rebind assertions prove stability.
5. **MCP-injection coexistence:** freshell's opencode MCP tool is injected by mutating the project-local `.opencode/opencode.json` (`mcp_inject.rs:393`). `OPENCODE_CONFIG_CONTENT` MERGES with file config (spike-proven on opencode 1.18.8: user providers and plugins preserved, injected plugin appended). Our injected JSON contains ONLY the `plugin` key (Task 2 pins this with a unit test), so it cannot shadow `mcp`/provider config. Final task includes a manual real-opencode smoke check.

## File Structure

| File | Responsibility |
|---|---|
| `extensions/opencode/freshell-rebind-plugin.ts` (create) | The opencode TUI plugin: dedup-emit `(terminalId, sessionID)` signal files on every session switch. Pure-testable helpers exported. |
| `test/unit/server/opencode-rebind-plugin.test.ts` (create) | Vitest unit tests for the plugin (mocked TuiPluginApi, injected fs writer). |
| `crates/freshell-platform/src/opencode_plugin.rs` (create) | Embed plugin source (`include_str!`), idempotent install to `~/.freshell/opencode/`, `OPENCODE_CONFIG_CONTENT` build/merge (pure). Inline unit tests. |
| `crates/freshell-platform/src/cli_launch.rs` (modify, opencode block `:416-422` area) | Per-pane env injection of `OPENCODE_CONFIG_CONTENT` into `command_env`; `merged_env_value` helper beside `merged_env_truthy` (`:246-257`). |
| `crates/freshell-platform/src/cli_launch_goldens.rs` (modify) | Golden pins for the new opencode env injection. |
| `crates/freshell-platform/src/lib.rs` (modify) | `pub mod opencode_plugin;` |
| `crates/freshell-ws/src/opencode_signal.rs` (create) | `OpencodeSignalWatcher` (sorted drain, `ses_` validation), `drain_and_rebind_opencode` (guard ladder + pinned fan-out), `spawn_opencode_signal_sweep`. Inline unit tests. |
| `crates/freshell-ws/src/lib.rs` (modify) | `pub mod opencode_signal;` |
| `crates/freshell-ws/src/codex_identity.rs` (modify, `:268`) | Fix hardcoded `provider: Some("codex")` in the `meta.updated` upsert of `broadcast_terminal_session_associated` — use the `provider` parameter. |
| `crates/freshell-server/src/main.rs` (modify, after `:803`) | Boot the opencode signal sweep next to the claude one. |
| `crates/freshell-ws/tests/opencode_switch_rebind.rs` (create) | Crown integration test: switch → rebind → restart → resumes NEW id; A→B→A; invalid id; A13 hijack; no-signal regression. |
| `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md` (modify) | opencode section → shipped mechanism; amplifier section → strengthened "no rebind needed, by construction". |

---

### Task 1: The opencode TUI plugin (signal producer)

**Files:**
- Create: `extensions/opencode/freshell-rebind-plugin.ts`
- Test: `test/unit/server/opencode-rebind-plugin.test.ts`

**Interfaces:**
- Consumes: `FRESHELL_TERMINAL_ID` (already injected into every PTY env — Rust `crates/freshell-ws/src/terminal.rs:2598` `build_terminal_base_env`, Node `server/terminal-registry.ts:1548`).
- Produces:
  - The plugin file itself (embedded by Task 2 via `include_str!`).
  - **Signal-file contract** (consumed by Task 4): directory `<home>/.freshell/session-signals/opencode/`; filename `<FRESHELL_TERMINAL_ID>__<nonce>.json` (terminal id recovered by splitting the stem on the LAST `__`; nonce contains digits/`-` only, never `__`); staging file written as `<name>.tmp` then renamed to `<name>.json` (consumer ignores non-`.json`); body `{"session_id":"ses_...","source":"opencode-tui-plugin"}`.
  - Exports for tests: `extractSessionId(value: unknown): string | null`, `createEmitter(deps: EmitterDeps): (candidate: unknown) => void`, `interface EmitterDeps { env: Record<string, string | undefined>; writeFile?: (dir: string, name: string, body: string) => void; now?: () => number }`, default export `{ id: 'freshell-rebind', tui(api: unknown): void }`.

- [ ] **Step 1: Verify the plugin API surface against the installed opencode**

Read the installed opencode 1.18.8 types (informational — the plugin is defensive either way):

```bash
sed -n '1,200p' ~/.nvm/versions/node/v22.21.1/lib/node_modules/opencode-ai/node_modules/@opencode-ai/plugin/dist/tui.d.ts 2>/dev/null \
  || find ~/.nvm/versions/node/v22.21.1/lib/node_modules/opencode-ai -name 'tui.d.ts' -path '*plugin*' -exec sed -n '1,200p' {} \;
```

Confirm: `TuiPluginApi` exposes `route.current` (→ `{ name: "session", params: { sessionID } }`), `slots.register(name, renderer)`, `lifecycle` (AbortSignal and/or `onDispose`). Confirm what a slot renderer receives (context carrying the current `session_id`/`sessionID`) and that returning `undefined` leaves the host's default rendering in place. If slot registration would REPLACE visible host content unconditionally, drop the two `slots.register` calls in Step 4's code and lower the poll interval from 2000 to 1000 ms — route polling then carries the feature alone. Record which variant you shipped in the plugin's header comment.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/server/opencode-rebind-plugin.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import plugin, {
  createEmitter,
  extractSessionId,
  type EmitterDeps,
} from '../../../extensions/opencode/freshell-rebind-plugin'

describe('extractSessionId', () => {
  it('accepts direct sessionID / session_id / sessionId keys', () => {
    expect(extractSessionId({ sessionID: 'ses_abc123' })).toBe('ses_abc123')
    expect(extractSessionId({ session_id: 'ses_abc123' })).toBe('ses_abc123')
    expect(extractSessionId({ sessionId: 'ses_abc123' })).toBe('ses_abc123')
  })

  it('accepts the TUI route shape { name: "session", params: { sessionID } }', () => {
    expect(
      extractSessionId({ name: 'session', params: { sessionID: 'ses_route1' } }),
    ).toBe('ses_route1')
  })

  it('rejects non-ses_ ids, empty, and junk shapes', () => {
    expect(extractSessionId({ sessionID: 'not-a-session' })).toBeNull()
    expect(extractSessionId({ sessionID: '' })).toBeNull()
    expect(extractSessionId({ sessionID: 'ses_' })).toBeNull()
    expect(extractSessionId(null)).toBeNull()
    expect(extractSessionId(42)).toBeNull()
    expect(extractSessionId('ses_bare-string-ok')).toBeNull() // ses_ + non-alnum rejected
    expect(extractSessionId('ses_barestringok')).toBe('ses_barestringok')
  })
})

describe('createEmitter', () => {
  const writes: Array<{ dir: string; name: string; body: string }> = []
  const deps = (env: EmitterDeps['env']): EmitterDeps => ({
    env,
    writeFile: (dir, name, body) => writes.push({ dir, name, body }),
    now: () => 1_700_000_000_000,
  })
  beforeEach(() => writes.splice(0))

  it('writes <terminalId>__<nonce> with a session_id body into the opencode signal dir', () => {
    const emit = createEmitter(deps({ HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' }))
    emit({ sessionID: 'ses_aaa1' })
    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/home/u/.freshell/session-signals/opencode')
    expect(writes[0].name).toMatch(/^term-1__\d{14}-\d{6}-\d+$/)
    expect(writes[0].name.split('__')).toHaveLength(2) // nonce never contains the __ delimiter
    expect(JSON.parse(writes[0].body)).toEqual({
      session_id: 'ses_aaa1',
      source: 'opencode-tui-plugin',
    })
  })

  it('dedupes repeats of the same id but emits again on change (A -> A -> B -> A)', () => {
    const emit = createEmitter(deps({ HOME: '/h', FRESHELL_TERMINAL_ID: 't' }))
    emit({ sessionID: 'ses_a' })
    emit({ sessionID: 'ses_a' })
    emit({ sessionID: 'ses_b' })
    emit({ sessionID: 'ses_a' })
    expect(writes.map((w) => JSON.parse(w.body).session_id)).toEqual(['ses_a', 'ses_b', 'ses_a'])
  })

  it('never writes without FRESHELL_TERMINAL_ID or a home dir', () => {
    createEmitter(deps({ HOME: '/h' }))({ sessionID: 'ses_a' })
    createEmitter(deps({ FRESHELL_TERMINAL_ID: 't' }))({ sessionID: 'ses_a' })
    expect(writes).toHaveLength(0)
  })

  it('swallows writer exceptions (losing a signal degrades to no-rebind)', () => {
    const emit = createEmitter({
      env: { HOME: '/h', FRESHELL_TERMINAL_ID: 't' },
      writeFile: () => {
        throw new Error('disk full')
      },
    })
    expect(() => emit({ sessionID: 'ses_a' })).not.toThrow()
  })
})

describe('default export (TuiPluginModule)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('HOME', '/h')
    vi.stubEnv('FRESHELL_TERMINAL_ID', 'term-tui')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('has the TuiPluginModule shape', () => {
    expect(plugin.id).toBe('freshell-rebind')
    expect(typeof plugin.tui).toBe('function')
  })

  it('registers slots, polls route.current, and stops on lifecycle abort — without throwing', () => {
    const slots: Record<string, (ctx: unknown) => unknown> = {}
    const abort = new AbortController()
    const api = {
      slots: { register: (name: string, fn: (ctx: unknown) => unknown) => (slots[name] = fn) },
      route: { current: { name: 'session', params: { sessionID: 'ses_poll1' } } },
      lifecycle: { signal: abort.signal },
    }
    expect(() => plugin.tui(api)).not.toThrow()
    expect(Object.keys(slots).sort()).toEqual(['session_prompt', 'sidebar_title'])
    // slot renderer must return undefined (never replace host content)
    expect(slots.session_prompt({ session_id: 'ses_slot1' })).toBeUndefined()
    // polling keeps running until abort, then stops
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    abort.abort()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })

  it('no-ops silently when the API surface is absent or hostile (version tolerance)', () => {
    expect(() => plugin.tui(undefined)).not.toThrow()
    expect(() => plugin.tui({})).not.toThrow()
    expect(() =>
      plugin.tui({
        slots: {
          register: () => {
            throw new Error('changed API')
          },
        },
        get route(): never {
          throw new Error('changed API')
        },
      }),
    ).not.toThrow()
    vi.advanceTimersByTime(10_000)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/server/opencode-rebind-plugin.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL — cannot resolve `extensions/opencode/freshell-rebind-plugin`.

- [ ] **Step 4: Write the plugin**

Create `extensions/opencode/freshell-rebind-plugin.ts`:

```ts
// Freshell opencode TUI plugin — deterministic mid-session rebind signal.
//
// Injected per-pane by the freshell Rust server via OPENCODE_CONFIG_CONTENT
// (crates/freshell-platform/src/opencode_plugin.rs). On every session switch
// it writes an atomic signal file in the claude-SessionStart shape:
//   <home>/.freshell/session-signals/opencode/<FRESHELL_TERMINAL_ID>__<nonce>.json
//   body: {"session_id":"ses_...","source":"opencode-tui-plugin"}
// The freshell server sweeps that directory (crates/freshell-ws/src/opencode_signal.rs)
// and rebinds the pane identity through the guarded rebind lane.
//
// HARD RULES (version tolerance): this file must NEVER break the TUI. Every
// interaction with the opencode plugin API is wrapped; if any surface is
// absent or changed, the plugin silently no-ops and freshell degrades to
// today's no-rebind behavior. Primary edge: slot re-render (session_prompt /
// sidebar_title receive the current session id on every switch). Belt and
// suspenders: a low-frequency api.route.current poll.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/
const POLL_INTERVAL_MS = 2000

export interface EmitterDeps {
  env: Record<string, string | undefined>
  writeFile?: (dir: string, name: string, body: string) => void
  now?: () => number
}

export function extractSessionId(value: unknown): string | null {
  if (typeof value === 'string') return SESSION_ID_RE.test(value) ? value : null
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  for (const key of ['sessionID', 'session_id', 'sessionId']) {
    const v = obj[key]
    if (typeof v === 'string' && SESSION_ID_RE.test(v)) return v
  }
  const params = obj['params']
  if (params && typeof params === 'object') return extractSessionId(params)
  return null
}

function defaultWriteFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${name}.tmp`)
  writeFileSync(tmp, body, { encoding: 'utf-8' })
  renameSync(tmp, join(dir, `${name}.json`))
}

export function createEmitter(deps: EmitterDeps): (candidate: unknown) => void {
  const home = deps.env.HOME ?? deps.env.USERPROFILE
  const terminalId = deps.env.FRESHELL_TERMINAL_ID
  if (!home || !terminalId) return () => {}
  const dir = join(home, '.freshell', 'session-signals', 'opencode')
  const write = deps.writeFile ?? defaultWriteFile
  const now = deps.now ?? Date.now
  let lastEmitted: string | null = null
  let seq = 0
  return (candidate: unknown) => {
    try {
      const sessionId = extractSessionId(candidate)
      if (!sessionId || sessionId === lastEmitted) return
      lastEmitted = sessionId
      seq += 1
      // Nonce: timestamp-first so one pane's signals sort lexicographically in
      // emission order (the consumer's sorted drain makes A->B->A deterministic).
      // Digits and '-' only — can never contain '__' (the filename delimiter).
      const nonce = `${String(now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
      write(
        dir,
        `${terminalId}__${nonce}`,
        JSON.stringify({ session_id: sessionId, source: 'opencode-tui-plugin' }),
      )
    } catch {
      // Losing a signal degrades to no-rebind. Never surface into the TUI.
    }
  }
}

// TuiPluginModule shape per @opencode-ai/plugin: { id?, tui: (api) => void }
export default {
  id: 'freshell-rebind',
  tui(api: unknown): void {
    try {
      const emit = createEmitter({ env: process.env })
      const a = api as {
        slots?: { register?: (name: string, fn: (ctx: unknown) => unknown) => unknown }
        route?: { current?: unknown }
        lifecycle?: {
          signal?: AbortSignal
          onDispose?: (fn: () => void) => unknown
        }
      } | undefined
      // Primary edge: host slots re-render with the current session id on
      // every switch. The renderer returns undefined so the host's own
      // content is never replaced.
      for (const slot of ['session_prompt', 'sidebar_title']) {
        try {
          a?.slots?.register?.(slot, (ctx: unknown) => {
            emit(ctx)
            return undefined
          })
        } catch {
          /* slot API absent/changed -> polling still covers us */
        }
      }
      // Belt and suspenders: low-frequency route poll.
      const tick = (): void => {
        try {
          emit(a?.route?.current)
        } catch {
          /* route API absent/changed */
        }
      }
      tick()
      const timer = setInterval(tick, POLL_INTERVAL_MS)
      const stop = (): void => clearInterval(timer)
      try {
        a?.lifecycle?.signal?.addEventListener?.('abort', stop)
      } catch {
        /* no lifecycle signal */
      }
      try {
        a?.lifecycle?.onDispose?.(stop)
      } catch {
        /* no onDispose */
      }
    } catch {
      // Version tolerance: silently no-op.
    }
  },
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/server/opencode-rebind-plugin.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS (all tests).

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add extensions/opencode/freshell-rebind-plugin.ts test/unit/server/opencode-rebind-plugin.test.ts
git commit -m "feat(opencode): freshell TUI rebind plugin emitting session-switch signal files"
```

---

### Task 2: Rust plugin embed, install, and OPENCODE_CONFIG_CONTENT merge

**Files:**
- Create: `crates/freshell-platform/src/opencode_plugin.rs`
- Modify: `crates/freshell-platform/src/lib.rs` (add `pub mod opencode_plugin;` next to the existing module list)
- Test: inline `#[cfg(test)] mod tests` in `opencode_plugin.rs`

**Interfaces:**
- Consumes: `extensions/opencode/freshell-rebind-plugin.ts` (Task 1) via `include_str!`; `serde_json` (already a freshell-platform dependency — `claude_settings_json` uses `serde_json::json!`).
- Produces (used by Task 3):
  - `pub const REBIND_PLUGIN_SOURCE: &str`
  - `pub fn rebind_plugin_path(home: &Path) -> PathBuf` → `<home>/.freshell/opencode/freshell-rebind-plugin.ts`
  - `pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf>` (idempotent, atomic tmp+rename, rewrites only when content differs)
  - `pub fn plugin_file_spec(plugin_path: &Path) -> String` (portable `file://` spec)
  - `pub fn build_opencode_config_content(existing: Option<&str>, plugin_path: &Path) -> Option<String>` (None ⇒ SKIP injection, preserve the user's value untouched)

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-platform/src/opencode_plugin.rs` with ONLY the test module first:

```rust
//! Freshell's opencode TUI rebind plugin: embedded source, idempotent
//! install into the freshell data dir, and OPENCODE_CONFIG_CONTENT
//! composition (merge-with-user-value, never clobber).

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn plugin_source_is_embedded_and_nonempty() {
        assert!(REBIND_PLUGIN_SOURCE.contains("freshell-rebind"));
        assert!(REBIND_PLUGIN_SOURCE.contains("session-signals"));
    }

    #[test]
    fn install_is_idempotent_and_heals_content_drift() {
        let home = tempfile::tempdir().unwrap();
        let path = ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(path, rebind_plugin_path(home.path()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), REBIND_PLUGIN_SOURCE);
        // Second call: no error, same content.
        ensure_rebind_plugin_installed(home.path()).unwrap();
        // Drifted content is healed.
        std::fs::write(&path, "tampered").unwrap();
        ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), REBIND_PLUGIN_SOURCE);
    }

    #[test]
    fn config_content_with_no_user_value_is_exactly_the_plugin_stanza() {
        let out =
            build_opencode_config_content(None, Path::new("/h/.freshell/opencode/p.ts")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // ONLY the plugin key — must never shadow user mcp/provider config
        // (OPENCODE_CONFIG_CONTENT merges with file config; see plan Scope
        // Decision 5 / mcp_inject.rs coexistence).
        assert_eq!(
            v,
            serde_json::json!({ "plugin": ["file:///h/.freshell/opencode/p.ts"] })
        );
        // Empty string behaves like no value.
        assert!(build_opencode_config_content(Some(""), Path::new("/p.ts")).is_some());
    }

    #[test]
    fn config_content_merges_into_a_user_value_preserving_their_keys() {
        let user = r#"{"username":"me","plugin":["./their-plugin.ts"]}"#;
        let out = build_opencode_config_content(Some(user), Path::new("/x/p.ts")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["username"], "me");
        assert_eq!(
            v["plugin"],
            serde_json::json!(["./their-plugin.ts", "file:///x/p.ts"])
        );
    }

    #[test]
    fn config_content_does_not_duplicate_an_already_present_spec() {
        let user = r#"{"plugin":["file:///x/p.ts"]}"#;
        let out = build_opencode_config_content(Some(user), Path::new("/x/p.ts")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["plugin"], serde_json::json!(["file:///x/p.ts"]));
    }

    #[test]
    fn unparseable_or_non_object_user_value_skips_injection() {
        // None ⇒ caller must NOT set the env var, preserving the user's raw value.
        assert!(build_opencode_config_content(Some("{oops"), Path::new("/p.ts")).is_none());
        assert!(build_opencode_config_content(Some("[1,2]"), Path::new("/p.ts")).is_none());
        // A user `plugin` key of the wrong type also skips (never destroy it).
        assert!(
            build_opencode_config_content(Some(r#"{"plugin":"one"}"#), Path::new("/p.ts"))
                .is_none()
        );
    }

    #[test]
    fn file_spec_is_a_file_url() {
        assert_eq!(plugin_file_spec(Path::new("/a/b c/p.ts")), "file:///a/b c/p.ts");
    }
}
```

If `tempfile` is not already a dev-dependency of `freshell-platform`, add it to `crates/freshell-platform/Cargo.toml` under `[dev-dependencies]` (it is already used elsewhere in the workspace).

- [ ] **Step 2: Run tests to verify they fail to compile**

```bash
cargo test -p freshell-platform opencode_plugin 2>&1 | head -30
```

Expected: compile FAIL — `REBIND_PLUGIN_SOURCE` etc. not found. (Add `pub mod opencode_plugin;` to `crates/freshell-platform/src/lib.rs` now so the failure is the missing items, not a missing module.)

- [ ] **Step 3: Implement**

Add above the test module in `opencode_plugin.rs`:

```rust
use std::io::Write;
use std::path::{Path, PathBuf};

/// The TUI plugin shipped with freshell (single source of truth lives in the
/// repo at extensions/opencode/freshell-rebind-plugin.ts; embedded at compile
/// time so the Rust server needs no runtime lookup).
pub const REBIND_PLUGIN_SOURCE: &str =
    include_str!("../../../extensions/opencode/freshell-rebind-plugin.ts");

pub fn rebind_plugin_path(home: &Path) -> PathBuf {
    home.join(".freshell")
        .join("opencode")
        .join("freshell-rebind-plugin.ts")
}

/// Idempotently materialize the plugin into the freshell data dir.
/// Atomic (tmp + rename); rewrites only when content differs, so a running
/// opencode never observes a torn file.
pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf> {
    let path = rebind_plugin_path(home);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == REBIND_PLUGIN_SOURCE {
            return Ok(path);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("ts.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(REBIND_PLUGIN_SOURCE.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// `file://` spec for the opencode config `plugin` array. Unix: `file:///abs`.
/// Windows drive paths get forward slashes and a third slash.
pub fn plugin_file_spec(plugin_path: &Path) -> String {
    let s = plugin_path.display().to_string().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Compose the OPENCODE_CONFIG_CONTENT value for a freshell-spawned pane.
///
/// - No/empty user value: exactly `{"plugin":[<spec>]}` — the single-key
///   stanza can never shadow user mcp/provider/file config (opencode MERGES
///   env config with file config; spike-verified on 1.18.8).
/// - User value present: parse and append our spec to their `plugin` array,
///   preserving every other key.
/// - Unparseable / non-object / wrong-typed `plugin`: return `None` — the
///   caller must skip injection so the user's raw value passes through
///   untouched (rebind degrades to no-op; NEVER destroy user config).
pub fn build_opencode_config_content(existing: Option<&str>, plugin_path: &Path) -> Option<String> {
    let spec = plugin_file_spec(plugin_path);
    match existing {
        None | Some("") => Some(serde_json::json!({ "plugin": [spec] }).to_string()),
        Some(raw) => {
            let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
            let obj = value.as_object_mut()?;
            let plugins = obj
                .entry("plugin")
                .or_insert_with(|| serde_json::Value::Array(Vec::new()));
            let arr = plugins.as_array_mut()?;
            if !arr.iter().any(|p| p.as_str() == Some(spec.as_str())) {
                arr.push(serde_json::Value::String(spec));
            }
            Some(value.to_string())
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-platform opencode_plugin
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all
git add crates/freshell-platform/src/opencode_plugin.rs crates/freshell-platform/src/lib.rs crates/freshell-platform/Cargo.toml
git commit -m "feat(platform): embed + install opencode rebind plugin; OPENCODE_CONFIG_CONTENT merge"
```

---

### Task 3: Inject OPENCODE_CONFIG_CONTENT in the launch resolver (golden-first)

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs` (opencode block at `:416-422`; helper beside `merged_env_truthy` at `:246-257`)
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs`

**Interfaces:**
- Consumes: Task 2's `opencode_plugin::{ensure_rebind_plugin_installed, rebind_plugin_path, build_opencode_config_content}`; the resolver's env abstraction (the `env` parameter `resolve_coding_cli_command(&cli_commands, &inputs, env)` already used by `get_opencode_env_overrides(env, &command_env)` and `merged_env_truthy`).
- Produces: every freshell-spawned opencode pane (WS create `freshell-ws/src/terminal.rs:1635`, REST create `freshell-freshagent/src/terminal_tabs.rs:954`, and restore relaunches — `command_env` is rebuilt identically on restore) carries `OPENCODE_CONFIG_CONTENT` in `command_env`. New helper: `fn merged_env_value(env: &impl <the resolver's env trait>, command_env: &BTreeMap<String, String>, key: &str) -> Option<String>` with the same JS-spread shadowing semantics as `merged_env_truthy` (a present-but-empty `command_env` value shadows the process env).

**Home-dir resolution rule (locked):** resolve `home` through the resolver's env abstraction — `merged_env_value(env, &command_env, "HOME")` falling back to `"USERPROFILE"` — NOT `dirs::home_dir()` or `std::env`. This keeps the goldens hermetic (they pass a fake env with a temp HOME) and matches `claude_signal.rs`'s `$HOME`-then-`%USERPROFILE%` convention. No home ⇒ skip injection (degrade, mirroring `ClaudeSignalWatcher::default_root() -> None` skipping the sweep).

- [ ] **Step 1: Read the exact current shape**

Read `crates/freshell-platform/src/cli_launch.rs:240-300` (the env-lookup helpers and `get_opencode_env_overrides`) and `:405-480` (the opencode block, resume args). Read the opencode golden(s) in `cli_launch_goldens.rs` (argv pins near `:393,418,457,472`; note how the golden constructs its fake env and whether it asserts `command_env`). Keep `get_opencode_env_overrides` pure and untouched — the injection is a separate statement in the same `mode == "opencode"` block, because it performs fs I/O (plugin install) which does not belong in the pure overrides function.

- [ ] **Step 2: Update the goldens FIRST (verify RED)**

In `cli_launch_goldens.rs`, for every opencode golden case, extend the expected `command_env` with the new key. Use the real composition functions against the golden's fake HOME so the assertion is host-independent, e.g.:

```rust
let home = tempfile::tempdir().unwrap();
// (set HOME=<home> in the golden's fake env, alongside its existing vars)
let expected_plugin_path = crate::opencode_plugin::rebind_plugin_path(home.path());
let expected_config = crate::opencode_plugin::build_opencode_config_content(
    None,
    &expected_plugin_path,
)
.unwrap();
// assert command_env["OPENCODE_CONFIG_CONTENT"] == expected_config
// assert the plugin file now exists on disk with the embedded content:
assert_eq!(
    std::fs::read_to_string(&expected_plugin_path).unwrap(),
    crate::opencode_plugin::REBIND_PLUGIN_SOURCE
);
```

Add two NEW golden cases:
1. **User value present:** fake env contains `OPENCODE_CONFIG_CONTENT={"username":"me","plugin":["./their.ts"]}` → resolved `command_env` value preserves `username` and appends our `file://` spec after `./their.ts`.
2. **Unparseable user value:** fake env contains `OPENCODE_CONFIG_CONTENT={oops` → resolved `command_env` does NOT contain the key at all (the user's raw process-env value passes through to the PTY untouched).

Also assert in an existing opencode golden that **argv is byte-identical to before** (the injection is env-only; `--hostname/--port/--session` args unchanged).

```bash
cargo test -p freshell-platform cli_launch 2>&1 | tail -20
```

Expected: FAIL (goldens demand the new env key that isn't produced yet).

- [ ] **Step 3: Implement the helper and the injection**

Beside `merged_env_truthy` (`cli_launch.rs:246-257`), add (adapting the trait/type names to exactly what `merged_env_truthy` uses):

```rust
/// Merged-view env lookup with JS spread semantics: a key present in
/// command_env (even empty) shadows the process env. Companion to
/// merged_env_truthy, returning the value instead of truthiness.
fn merged_env_value(
    env: &impl EnvSource, // ← use merged_env_truthy's exact env-parameter type
    command_env: &std::collections::BTreeMap<String, String>,
    key: &str,
) -> Option<String> {
    if let Some(v) = command_env.get(key) {
        return Some(v.clone());
    }
    env.var(key) // ← use the same accessor merged_env_truthy uses
}
```

In the `mode == "opencode"` block (after the existing `get_opencode_env_overrides` insertion at `:416-422`):

```rust
// Freshell TUI rebind plugin (docs/plans/2026-07-28-opencode-tui-rebind.md):
// install the plugin file into ~/.freshell/opencode/ and inject it per-pane
// via OPENCODE_CONFIG_CONTENT. Merges with any user value; skips entirely
// (preserving the user's raw value) when the user value is unparseable or
// home is unresolvable. Failure here must never block the launch.
let home = merged_env_value(env, &command_env, "HOME")
    .filter(|s| !s.is_empty())
    .or_else(|| merged_env_value(env, &command_env, "USERPROFILE").filter(|s| !s.is_empty()));
if let Some(home) = home {
    let home = std::path::PathBuf::from(home);
    match crate::opencode_plugin::ensure_rebind_plugin_installed(&home) {
        Ok(plugin_path) => {
            let existing = merged_env_value(env, &command_env, "OPENCODE_CONFIG_CONTENT");
            if let Some(content) = crate::opencode_plugin::build_opencode_config_content(
                existing.as_deref(),
                &plugin_path,
            ) {
                command_env.insert("OPENCODE_CONFIG_CONTENT".to_string(), content);
            }
        }
        Err(error) => {
            tracing::warn!(%error, "opencode_rebind_plugin_install_failed: launching without rebind signal");
        }
    }
}
```

(If `tracing` is not already a freshell-platform dependency, use the crate's existing logging idiom in `cli_launch.rs` — check how other warnings in this file are emitted and match it.)

- [ ] **Step 4: Run tests to verify GREEN**

```bash
cargo test -p freshell-platform
```

Expected: PASS, including all pre-existing goldens (claude/codex untouched).

- [ ] **Step 5: Quality gates and commit**

```bash
cargo fmt --all --check && cargo clippy -p freshell-platform --all-targets -- -D warnings
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/cli_launch_goldens.rs
git commit -m "feat(platform): inject freshell rebind plugin into opencode panes via OPENCODE_CONFIG_CONTENT"
```

---

### Task 4: Rust signal watcher for opencode (sorted drain + ses_ validation)

**Files:**
- Create: `crates/freshell-ws/src/opencode_signal.rs` (watcher half only — the rebind consumer is Task 5)
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod opencode_signal;` next to `pub mod claude_signal;` at `lib.rs:26`)
- Test: inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: the signal-file contract from Task 1.
- Produces (used by Task 5 and the crown test):
  - `pub struct OpencodeSignalWatcher` with `pub fn new(root: PathBuf) -> Self`, `pub fn default_root() -> Option<PathBuf>` (`$HOME`/`%USERPROFILE%` + `.freshell/session-signals/opencode`, `None` when home unresolvable — mirror `claude_signal.rs:52-66`), `pub fn drain(&self) -> Vec<OpencodeSignal>`
  - `pub struct OpencodeSignal { pub terminal_id: String, pub session_id: String, pub source: Option<String> }` (derive `Debug, Clone, PartialEq, Eq`)
  - `pub(crate) fn is_valid_opencode_session_id(id: &str) -> bool`

This module deliberately mirrors `claude_signal.rs`'s shape rather than extracting a provider-generic watcher. The spec prefers "the server-side consumer is reused, not duplicated" — what is REUSED is the signal-file contract, the sweep architecture, the entire guard/fan-out surface (`identity`, `registry`, `pane_ledger`, `broadcast_terminal_session_associated`), and the pinned tail; only the ~80-line watcher/ladder shell is mirrored, because (a) the codebase's stated preference is shape duplication over premature provider-generic controllers (`codex_association.rs:4-6`), (b) parameterizing `claude_signal.rs` would touch the base branch's shipped claude lane (Global Constraint: don't regress it), and (c) opencode needs two behavioral deltas claude must not inherit. Two deltas from claude: (1) `drain()` **sorts** entries by filename before processing, so one pane's timestamp-first nonces process in emission order and rapid A→B→A resolves last-write-wins deterministically; (2) `parse_signal_file` **rejects** any `session_id` not matching `^ses_[A-Za-z0-9]+$` (the spec's hard shape requirement — opencode ids are `ses_*`; claude skips shape checks because claude ids are validated elsewhere).

- [ ] **Step 1: Read the reference implementation**

Read `crates/freshell-ws/src/claude_signal.rs` in full (268 lines). The watcher half you are mirroring: `ClaudeSignalWatcher::{new, default_root, drain}` (`:44-93`), `parse_signal_file` (`:98-118`), the unit test `drain_parses_and_deletes_signal_files` (`:238-267`), and the module doc's no-`WsState`-field rationale (`:12-14`).

- [ ] **Step 2: Write the failing tests**

In the new `opencode_signal.rs`, start with the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn write_signal(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn session_id_shape_is_enforced() {
        assert!(is_valid_opencode_session_id("ses_abc123XYZ"));
        assert!(!is_valid_opencode_session_id("ses_"));
        assert!(!is_valid_opencode_session_id("ses_ab-cd"));
        assert!(!is_valid_opencode_session_id("22222222-3333-4444-8555-666677778888"));
        assert!(!is_valid_opencode_session_id(""));
    }

    #[test]
    fn drain_parses_sorts_deletes_and_rejects_bad_shapes() {
        let dir = tempfile::tempdir().unwrap();
        // Timestamp-first nonces: lexicographic order == emission order.
        write_signal(dir.path(), "term-1__00000000000002-000002-9.json",
            r#"{"session_id":"ses_bbb","source":"opencode-tui-plugin"}"#);
        write_signal(dir.path(), "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#);
        // Rejected: bad id shape (claude-style uuid), malformed json, missing __.
        write_signal(dir.path(), "term-1__00000000000003-000003-9.json",
            r#"{"session_id":"22222222-3333-4444-8555-666677778888"}"#);
        write_signal(dir.path(), "junk__1.json", "{not json");
        write_signal(dir.path(), "no-delimiter.json", r#"{"session_id":"ses_x"}"#);
        // Ignored entirely (staging file), must survive the drain.
        write_signal(dir.path(), "term-1__00000000000004-000004-9.tmp",
            r#"{"session_id":"ses_ccc"}"#);

        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert_eq!(
            signals,
            vec![
                OpencodeSignal {
                    terminal_id: "term-1".into(),
                    session_id: "ses_aaa".into(),
                    source: Some("opencode-tui-plugin".into()),
                },
                OpencodeSignal {
                    terminal_id: "term-1".into(),
                    session_id: "ses_bbb".into(),
                    source: Some("opencode-tui-plugin".into()),
                },
            ]
        );
        // Every .json is consumed (even rejected ones — single-shot semantics);
        // the .tmp staging file is untouched.
        let remaining: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(remaining, vec!["term-1__00000000000004-000004-9.tmp".to_string()]);
    }

    #[test]
    fn drain_on_missing_directory_is_empty() {
        let watcher = OpencodeSignalWatcher::new(std::path::PathBuf::from(
            "/nonexistent/freshell-opencode-signals",
        ));
        assert!(watcher.drain().is_empty());
    }
}
```

- [ ] **Step 3: Run tests to verify RED**

```bash
cargo test -p freshell-ws opencode_signal 2>&1 | head -20
```

Expected: compile FAIL (types not defined). Add `pub mod opencode_signal;` to `crates/freshell-ws/src/lib.rs` first so the failure is the missing items.

- [ ] **Step 4: Implement the watcher**

Above the tests in `opencode_signal.rs` (mirroring `claude_signal.rs:24-118` with the two documented deltas):

```rust
//! Opencode mid-session rebind: signal-file watcher.
//!
//! The freshell TUI plugin (extensions/opencode/freshell-rebind-plugin.ts,
//! injected per-pane via OPENCODE_CONFIG_CONTENT) writes
//! `$HOME/.freshell/session-signals/opencode/<terminal_id>__<nonce>.json`
//! on every in-TUI session switch. This module drains those files.
//!
//! Shape-mirrors claude_signal.rs (the codebase prefers duplication over a
//! premature provider-generic controller — see codex_association.rs:4-6),
//! with two deltas: drain() sorts by filename (timestamp-first nonces ⇒
//! deterministic last-write-wins under rapid A→B→A switching), and
//! session ids must match `ses_[A-Za-z0-9]+` (opencode's id shape; reject
//! everything else before any guard runs).
//!
//! Deliberately NOT a WsState field: the sweep task owns the watcher
//! (claude_signal.rs:12-14 — WsState is an exhaustive struct literal in
//! ~27 test files).

use std::path::{Path, PathBuf};

const OPENCODE_SIGNAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Clone)]
pub struct OpencodeSignalWatcher {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSignal {
    pub terminal_id: String,
    pub session_id: String,
    /// The plugin's `source` field ("opencode-tui-plugin"); logged only.
    pub source: Option<String>,
}

pub(crate) fn is_valid_opencode_session_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

impl OpencodeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `$HOME` (unix) / `%USERPROFILE%` (windows) + `.freshell/session-signals/opencode`.
    /// `None` when home is unresolvable — boot skips the sweep (mirrors
    /// ClaudeSignalWatcher::default_root).
    pub fn default_root() -> Option<PathBuf> {
        // Copy the body of ClaudeSignalWatcher::default_root (claude_signal.rs:52-66)
        // verbatim, changing the final path segment from "claude" to "opencode".
        let home = std::env::var("HOME")
            .ok()
            .filter(|h| !h.is_empty())
            .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))?;
        Some(
            PathBuf::from(home)
                .join(".freshell")
                .join("session-signals")
                .join("opencode"),
        )
    }

    /// Read + parse + DELETE every `*.json`, sorted by filename. Malformed and
    /// invalid-shape files are deleted AND skipped (single-shot semantics —
    /// junk must not re-fail every sweep). `*.tmp` staging files are ignored.
    pub fn drain(&self) -> Vec<OpencodeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no opencode pane has ever signaled
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            if let Some(sig) = parse_signal_file(&path) {
                signals.push(sig);
            }
            let _ = std::fs::remove_file(&path);
        }
        signals
    }
}

fn parse_signal_file(path: &Path) -> Option<OpencodeSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?; // LAST "__" — load-bearing
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let session_id = body.get("session_id")?.as_str()?;
    if !is_valid_opencode_session_id(session_id) {
        return None;
    }
    Some(OpencodeSignal {
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body.get("source").and_then(|v| v.as_str()).map(str::to_string),
    })
}
```

While here, verify against the actual `claude_signal.rs:52-66` `default_root` body and match its exact home-resolution idiom (it may use a helper — mirror whatever it does, keeping the `opencode` leaf).

- [ ] **Step 5: Run tests to verify GREEN, then commit**

```bash
cargo test -p freshell-ws opencode_signal
cargo fmt --all --check && cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): opencode signal-file watcher (sorted drain, ses_ shape validation)"
```

---

### Task 5: Guarded rebind consumer, sweep boot, provider-hardcode fix, and the crown test

**Files:**
- Modify: `crates/freshell-ws/src/opencode_signal.rs` (add the consumer half)
- Modify: `crates/freshell-ws/src/codex_identity.rs:268` (provider hardcode fix)
- Modify: `crates/freshell-server/src/main.rs` (boot the sweep, immediately after the claude sweep block at `:792-803`)
- Test: Create `crates/freshell-ws/tests/opencode_switch_rebind.rs`

**Interfaces:**
- Consumes: Task 4's `OpencodeSignalWatcher`/`OpencodeSignal`; the base branch's guard/fan-out surface — `state.identity.get / upsert / find_by_session_including_retired` (`identity.rs`), `state.registry.live_session_owner(Some(&state.identity), "opencode", id)` (`registry.rs:2180`), `state.registry.set_meta`, `state.pane_ledger.lookup_by_session`, `crate::pane_ledger::ledger_resolve_identity(state, tid, "opencode", sid, cwd).await`, `crate::codex_identity::broadcast_terminal_session_associated(state, "opencode", tid, sid, cwd, previous)`.
- Produces: `pub async fn drain_and_rebind_opencode(state: &WsState, watcher: &OpencodeSignalWatcher)` (`pub` so the integration test drives drains deterministically instead of racing the timer — same rationale as `drain_and_rebind_claude`), `pub fn spawn_opencode_signal_sweep(state: WsState, watcher: OpencodeSignalWatcher)`.

- [ ] **Step 1: Read the two reference files**

Read `crates/freshell-ws/src/claude_signal.rs:127-236` (`drain_and_rebind_claude` + `spawn_claude_signal_sweep`) and `crates/freshell-ws/src/codex_identity.rs` (esp. `broadcast_terminal_session_associated` at `:238-277` and the `:268` hardcode). Read `crates/freshell-ws/tests/claude_session_rebind.rs` in full (436 lines) — it is the structural template for the crown test — and skim `crates/freshell-ws/tests/codex_fork_rebind.rs:321-360` for the argv-capture fake-CLI idiom and the file-level `static ENV_LOCK`.

- [ ] **Step 2: Write the failing crown test**

Create `crates/freshell-ws/tests/opencode_switch_rebind.rs` by copying `crates/freshell-ws/tests/claude_session_rebind.rs` and applying these exact deltas (keep its helper structure — `spawn_server_returning_state`-style spawner, `TestWs`, `next_frame_of_type`, fake-CLI installer — reusing `tests/common/mod.rs` where the claude test does):

1. **Fake CLI:** a fake `opencode` shell script that dumps `"$@"` to `$OPENCODE_ARGV_CAPTURE_PATH` and sleeps (copy the fake-claude script from the claude test, renaming the capture env var). Register it as the `opencode` mode command the way the claude test registers its fake (spawn-spec/`OPENCODE_CMD`-equivalent — mirror the claude test's mechanism exactly).
2. **Session ids:** `ses_aaaaaaaaaaaaaaaaaaaaaaaaaa` (A), `ses_bbbbbbbbbbbbbbbbbbbbbbbbbb` (B), `ses_cccccccccccccccccccccccccc` (C, hijack target).
3. **Signal root:** a `tempfile::tempdir()`; `let watcher = freshell_ws::opencode_signal::OpencodeSignalWatcher::new(root.clone())`. Write signal files directly in the test (simulating the plugin):

```rust
fn write_opencode_signal(root: &std::path::Path, terminal_id: &str, seq: u64, session_id: &str) {
    std::fs::create_dir_all(root).unwrap();
    let name = format!("{terminal_id}__{seq:014}-000001-1.json");
    std::fs::write(
        root.join(name),
        format!(r#"{{"session_id":"{session_id}","source":"opencode-tui-plugin"}}"#),
    )
    .unwrap();
}
```

4. **Test name and phases** — one test fn `tui_switch_signal_rebinds_and_restart_resumes_the_new_id`:
   - **Phase 1 (rebind):** create an opencode terminal bound to A (`terminal.create` with `restore:true` + `sessionRef {provider:"opencode", sessionId:A}` — exactly how the claude test binds its initial session). Write a signal for B, call `freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await`, then assert: `terminal.session.associated` frame with `sessionRef {opencode, B}` AND `previousSessionId == A`; the following `terminal.meta.updated` frame carries **provider `"opencode"`** (this pins the `:268` fix — it currently says `"codex"`); registry meta `resume_session_id == B`; pane-ledger: A's row retired with reason Superseded and `superseded_by` → B's bound row (assert via the same ledger accessors the claude test uses).
   - **Phase 2 (restart resumes NEW id):** kill the terminal, re-create with `restore:true` + `sessionRef {opencode, B}`; assert captured argv contains `--session ses_bbb…` and does NOT contain `ses_aaa…`.
   - **Phase 3 (rapid A→B→A):** starting from the pane bound to A (use a fresh pane bound to A, or continue from phase 2's B-bound pane with B→A→B — keep the same three-signals-one-drain shape), write three signals in one sweep window with ascending seq (`A`, then `B`, then `A`), one `drain_and_rebind_opencode` call; assert the final identity/meta equals the LAST signal's id and the intermediate frames arrive in sorted order (last-write-wins, idempotent, no flapping error).
   - **Phase 4 (invalid shape ignored):** write a signal whose body is `{"session_id":"not-a-session"}`; drain; assert no `associated` frame and meta unchanged, but the file IS consumed (`std::fs::read_dir(&root).unwrap().count() == 0`).
   - **Phase 5 (A13 hijack refusal):** second live opencode pane owns C; forge a signal naming pane 1's terminal id claiming C; drain; assert no `associated` frame, both panes' meta unchanged, file consumed. (Mirror the claude test's phase 3 assertions verbatim.)
   - **Phase 6 (no-signal regression — the `--pure`/plugin-missing story):** with no signal files present, drain; assert zero frames and unchanged meta — freshell without a signal behaves exactly like today, which is precisely what `--pure`, `disableAllHooks`-style plugin loss, or plugin init failure produce.
5. Keep the claude test's `ENV_LOCK`/env-serialization discipline if it mutates process env for the fake CLI.

- [ ] **Step 3: Run to verify RED**

```bash
cargo test -p freshell-ws --test opencode_switch_rebind 2>&1 | head -30
```

Expected: compile FAIL — `drain_and_rebind_opencode` does not exist yet.

- [ ] **Step 4: Implement the consumer + sweep**

Append to `crates/freshell-ws/src/opencode_signal.rs` (this is `drain_and_rebind_claude` — `claude_signal.rs:127-223` — with `"claude"` → `"opencode"` and the A7-compaction comment replaced by the plugin-dedupe note; copy the real file's exact `use` items and `now_ms` idiom):

```rust
/// Drain opencode switch signals and rebind live panes through the guarded
/// lane. `pub` so integration tests drive drains deterministically.
///
/// Guard ladder (identical to drain_and_rebind_claude; the producer is
/// per-terminal by construction — the plugin reads FRESHELL_TERMINAL_ID from
/// its own PTY env — so codex's D7 old-owner predicate is subsumed by the
/// live-pane + provider-match check, exactly as in the claude lane):
///   (0) live opencode pane, (1) same-id no-op (the plugin dedupes, but the
///   initial route poll re-reports the bound id at startup), (2) A13 no live
///   owner of the target, (3) ledger A8 retired-inclusive, (4) fresh-agent
///   sessions never bind terminal panes.
/// NEVER any activity/row-correlation fallback: no signal ⇒ no rebind.
pub async fn drain_and_rebind_opencode(state: &WsState, watcher: &OpencodeSignalWatcher) {
    // drain() is sync fs I/O -> blocking pool (claude_signal.rs pattern, a9583449)
    let drain_watcher = watcher.clone();
    let signals = match tokio::task::spawn_blocking(move || drain_watcher.drain()).await {
        Ok(signals) => signals,
        Err(join_error) => {
            tracing::warn!(error = %join_error,
                "opencode_signal_drain_panicked: blocking drain task panicked, skipping this cycle");
            return;
        }
    };
    for sig in signals {
        let Some(current) = state.identity.get(&sig.terminal_id) else { continue };
        if current.retired || current.provider.as_deref() != Some("opencode") {
            continue;
        }
        if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
            continue; // same-id no-op
        }
        if let Some(owner) = state
            .registry
            .live_session_owner(Some(&state.identity), "opencode", &sig.session_id)
        {
            tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
                "opencode_rebind_refused: target session already live-owned (A13)");
            continue;
        }
        if let Some(existing) = state
            .identity
            .find_by_session_including_retired("opencode", &sig.session_id)
        {
            if existing != sig.terminal_id {
                tracing::warn!(terminal_id = %sig.terminal_id,
                    "opencode_rebind_refused: session_bound_elsewhere");
                continue;
            }
        }
        if state
            .pane_ledger
            .lookup_by_session("opencode", &sig.session_id)
            .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
        {
            continue;
        }

        let previous = current.session_id.clone();
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source, "opencode_rebind: TUI plugin reported a new session id");

        // PINNED order: identity -> meta -> ledger(await) -> associated THEN meta.updated.
        state.identity.upsert(
            &sig.terminal_id,
            Some("opencode"),
            Some(&sig.session_id),
            current.cwd.as_deref(),
            now_ms(),
        );
        state.registry.set_meta(
            &sig.terminal_id,
            None,
            None,
            Some("opencode".to_string()),
            Some(sig.session_id.clone()),
        );
        crate::pane_ledger::ledger_resolve_identity(
            state,
            &sig.terminal_id,
            "opencode",
            &sig.session_id,
            current.cwd.as_deref(),
        )
        .await;
        crate::codex_identity::broadcast_terminal_session_associated(
            state,
            "opencode",
            &sig.terminal_id,
            &sig.session_id,
            current.cwd.clone(),
            previous,
        );
    }
}

pub fn spawn_opencode_signal_sweep(state: WsState, watcher: OpencodeSignalWatcher) {
    // Copy spawn_claude_signal_sweep (claude_signal.rs:228-236) verbatim,
    // swapping the interval const and the drain call.
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(OPENCODE_SIGNAL_SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            drain_and_rebind_opencode(&state, &watcher).await;
        }
    });
}
```

Match the REAL signatures while implementing: `drain_and_rebind_claude` takes `&WsState` (possibly `&Arc<WsState>`) — mirror it exactly, along with its `now_ms()` import and `WsState` field access patterns.

**Fix `codex_identity.rs:268`:** in `broadcast_terminal_session_associated`, the `meta.updated` upsert hardcodes `provider: Some("codex".to_string())` although the function takes `provider: &str` (the `associated` frame at `:249` already uses it). Change to `provider: Some(provider.to_string())`. This corrects claude rebinds too (they currently emit a `meta.updated` claiming provider codex) and is asserted by crown Phase 1.

**Boot the sweep** — in `crates/freshell-server/src/main.rs`, immediately after the claude sweep block (`:792-803`):

```rust
// Opencode TUI-plugin signal sweep — drains the signal files the injected
// freshell-rebind plugin writes
// (`$HOME/.freshell/session-signals/opencode/<terminal_id>__<nonce>.json`)
// and rebinds a live opencode pane whose TUI navigated to a NEW session
// mid-session (session_new / session_list / session_child_cycle). `None`
// root (unresolvable HOME) skips the sweep, mirroring the claude sweep.
if let Some(signal_root) = freshell_ws::opencode_signal::OpencodeSignalWatcher::default_root() {
    freshell_ws::opencode_signal::spawn_opencode_signal_sweep(
        ws_state.clone(),
        freshell_ws::opencode_signal::OpencodeSignalWatcher::new(signal_root),
    );
}
```

- [ ] **Step 5: Run the crown test to verify GREEN**

```bash
cargo test -p freshell-ws --test opencode_switch_rebind
```

Expected: PASS. Then the neighbors that share the touched surfaces:

```bash
cargo test -p freshell-ws --test claude_session_rebind --test codex_fork_rebind
cargo test -p freshell-ws
```

Expected: PASS (the `:268` fix must not break codex/claude suites; if any test pinned the wrong `meta.updated` provider, fix the TEST — the frame was a bug).

- [ ] **Step 6: Quality gates and commit**

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/src/codex_identity.rs \
        crates/freshell-server/src/main.rs crates/freshell-ws/tests/opencode_switch_rebind.rs
git commit -m "feat(ws): opencode mid-session rebind via TUI-plugin signal files (P5)"
```

---

### Task 6: Audit-doc update (opencode shipped, amplifier descope strengthened)

**Files:**
- Modify: `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md` (28 lines; two `##` sections: `amplifier`, `opencode`)

**Interfaces:**
- Consumes: the shipped mechanism from Tasks 1–5.
- Produces: an accurate audit record (this doc is cited as the reason opencode had no rebind; leaving it stale is context poison).

- [ ] **Step 1: Read the current doc, then rewrite the two sections**

Keep each section's existing "Why rebind was descoped" + "Findings:" bullet structure. Replace the **opencode** section body with (adjust heading level/format to match the file):

```markdown
## opencode

**Status: rebind SHIPPED (2026-07-28, feat/opencode-tui-rebind) — the passive-detection descope stands; the follow-up plugin signal predicted below is now the mechanism.**

**Findings (passive detection — still true, still banned):**
- In-TUI switching (`session_new` / `session_list` / `session_child_cycle`,
  `@opencode-ai/sdk` `dist/gen/types.gen.d.ts:673,677,821,825`) is pure client
  navigation (`route.navigate`) — writes NOTHING to disk. Passive detection is
  impossible; `time_updated` correlation has non-switch writers (external
  prompts, compaction `setSummary`, `setPermission`, …) and remains a
  hijack-capable false-positive machine. NEVER use it.
- `session.parent_id` is populated only for subagent children (verified against
  `~/.local/share/opencode/opencode.db`) — no user-fork lineage substrate.

**Shipped mechanism (active signal, opencode 1.18.8):**
- opencode loads TUI plugins from the config `plugin` array
  (`TuiPluginModule { id?, tui }`, `@opencode-ai/plugin`); `OPENCODE_CONFIG_CONTENT`
  MERGES with user config and APPENDS to the plugin list (empirically verified:
  user providers/plugins preserved, injected plugin appended; `~/.config/opencode`
  untouched; env is per-PTY so only freshell-spawned panes are affected).
- Freshell ships `extensions/opencode/freshell-rebind-plugin.ts` (installed to
  `~/.freshell/opencode/`, injected per-pane by
  `crates/freshell-platform/src/cli_launch.rs` + `opencode_plugin.rs`). The
  plugin reads `FRESHELL_TERMINAL_ID` and emits claude-shaped signal files
  (`~/.freshell/session-signals/opencode/<tid>__<nonce>.json`) on every switch;
  primary edge = slot re-render (`session_prompt`/`sidebar_title`), belt-and-
  suspenders = low-frequency `api.route.current` poll; dedupe on repeat ids.
- Consumer: `crates/freshell-ws/src/opencode_signal.rs` — sorted drain,
  `ses_[A-Za-z0-9]+` shape validation, then the claude guard ladder (live pane +
  provider match, same-id no-op, A13, ledger A8, fresh-agent guard) and the
  pinned fan-out ending in `terminal.session.associated` + `previousSessionId`.
  The route-derived id is user-facing by construction (no bus consultation ⇒ no
  `parent_id` cross-check needed).
- Degradation: `--pure`/`OPENCODE_PURE` disables plugins; plugin init failure is
  non-fatal in opencode; unparseable user `OPENCODE_CONFIG_CONTENT` skips
  injection — all three yield exactly today's no-rebind behavior. Crown test:
  `crates/freshell-ws/tests/opencode_switch_rebind.rs`.
```

Replace the **amplifier** section body with:

```markdown
## amplifier

**Status: descope STANDS — amplifier needs no rebind mechanism, by construction.**

**Findings (verified against amplifier_app_cli):**
- There is NO in-TUI session switching at all: `amplifier_app_cli/main.py:369-411`
  is the exhaustive interactive command dict — no `/resume`, no session-switch
  command of any kind.
- `/fork` creates a new session directory, but the LIVE pane keeps its original
  session id — rebinding on `/fork` would be wrong (the pane's identity does not
  change; the fork is a copy, not a navigation).
- One `create_session` per process; `session_id` is fixed at construction. The
  id a pane launches with is the id it dies with.
- Conclusion: the resume-launch identity handling on this branch is complete for
  amplifier; no signal producer or consumer is needed.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plans/2026-07-28-stale-resume-identity-p3-audit.md
git commit -m "docs: P3 audit updated -- opencode rebind shipped via TUI plugin; amplifier descope stands"
```

---

### Task 7: Full verification, real-opencode smoke, push

**Files:** none created (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch pushed to origin. **NO PR** (repo rule: stop before `gh pr create`).

- [ ] **Step 1: Rust gates (workspace-wide)**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all PASS, zero warnings.

- [ ] **Step 2: Focused vitest + contract freeze**

```bash
npm run test:vitest -- run test/unit/server/opencode-rebind-plugin.test.ts test/unit/server/opencode-launch.test.ts --config config/vitest/vitest.server.config.ts
npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract
```

Expected: PASS; `git diff --exit-code` exits 0 (frozen contract untouched — this feature adds no frames; `previousSessionId` shipped on the base branch).

- [ ] **Step 3: Coordinated full suite**

```bash
FRESHELL_TEST_SUMMARY="opencode-tui-rebind: full suite before push" npm run check
```

Expected: typecheck + both vitest configs PASS. (Waits on the shared coordinator gate; if another agent holds it, wait — never kill a foreign holder.)

- [ ] **Step 4: Real-opencode manual smoke (scratch server — NEVER port 3002)**

```bash
scripts/launch-rust.sh --port 3499
```

Then, in a browser at `http://localhost:3499/?token=<AUTH_TOKEN from .env>`:
1. Open a terminal pane in opencode mode. In the pane run nothing — just confirm opencode starts (plugin init failure is non-fatal, but a hard TUI crash means the injected config is malformed: STOP and fix before pushing).
2. From another shell: `OPENCODE_CONFIG_CONTENT=$(tr -d '\n' < /dev/null); ls ~/.freshell/opencode/freshell-rebind-plugin.ts && ls ~/.freshell/session-signals/opencode/ 2>/dev/null` — the plugin file exists; after the pane is up, at most transient signal files (the sweep consumes them within ~1s).
3. In the TUI, create/switch sessions (session list keybind). Within ~3s the pane's session association should update; check the server log (`~/.freshell/logs/rust-server-3499.log`) for `opencode_rebind: TUI plugin reported a new session id`.
4. Kill the pane process and restore the pane: the relaunch argv (visible in the log or via `ps`) must carry `--session <NEW id>`.
5. Verify the freshell MCP tool still appears inside opencode (Scope Decision 5 coexistence check).
6. Stop the scratch server: `scripts/launch-rust.sh --port 3499 --stop`.

If step 3 shows NO signal on switch: check `~/.freshell/session-signals/opencode/` for accumulating files (consumer problem) vs none at all (producer problem — re-verify the plugin API surface per Task 1 Step 1 and adjust the extraction, then rerun Tasks 1/5 tests). Do not push until the live smoke passes or the failure is understood and documented in the commit message.

- [ ] **Step 5: Push the branch (stop — no PR)**

```bash
git push -u origin feat/opencode-tui-rebind
```

Do NOT create a PR. The workflow's later stages handle review.

---

## Self-Review Record

- **Spec coverage:** injected TUI plugin (Task 1), OPENCODE_CONFIG_CONTENT per-pane injection with user-value merge + skip-on-unparseable (Tasks 2–3), signal-file shape reuse of the claude lane (Tasks 1, 4), Rust-first guarded rebind with full fan-out incl. ledger supersede + `previousSessionId` + restart-resumes-new-id (Task 5), activity-tracking repoint audited as no-op with citations (Scope Decision 4), Node parity resolved as Rust-only consumer matching the claude precedent with Node fan-out untouched (Scope Decision 1), safety/degradation (`--pure`, plugin failure, version tolerance, no heuristic fallback — Global Constraints + crown Phases 4/6 + plugin tolerance tests), rapid A→B→A last-write-wins (sorted drain + crown Phase 3), subagent filter via id shape + no bus consultation (Scope Decision 3), doc updates for both audit sections (Task 6), tests mirroring the codex/claude crown pattern with simulated signal files + plugin unit tests with mocked TuiPluginApi + merge-behavior fixtures + no-signal regression (Tasks 1–5), contract freeze + clippy + coordinated suite + no-PR + production-3002 safety (Task 7, Global Constraints). No unresolved coverage gaps.
- **Silent deferrals:** none. The one environment-dependent surface (real opencode 1.18.8 plugin API behavior) is covered by a mandatory manual smoke against a real opencode in Task 7 Step 4 with an explicit do-not-push-on-failure rule, in the same spirit as the repo's opt-in real-provider contract tests.
- **Placeholder scan:** no TBD/TODO/"add error handling" steps; the two "copy the reference file and apply deltas" steps (crown test, sweep spawner) name the exact source file, line ranges, and every delta.
- **Type consistency:** `OpencodeSignalWatcher::{new, default_root, drain}`, `OpencodeSignal{terminal_id, session_id, source}`, `drain_and_rebind_opencode(&WsState, &OpencodeSignalWatcher)`, `opencode_plugin::{REBIND_PLUGIN_SOURCE, rebind_plugin_path, ensure_rebind_plugin_installed, plugin_file_spec, build_opencode_config_content}`, plugin exports `extractSessionId`/`createEmitter`/`EmitterDeps`/default `{id, tui}` — consistent across Tasks 1–5 and the goldens.
