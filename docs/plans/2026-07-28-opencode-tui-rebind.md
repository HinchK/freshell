# Opencode TUI-Plugin Mid-Session Rebind Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Deterministic mid-session rebind for terminal-mode opencode panes: when the user switches sessions inside the opencode TUI (`session_new` / `session_list` / `session_child_cycle`), freshell rebinds the pane's identity to the new session id so a later restart resumes the NEW session instead of the stale one. Deterministic BECAUSE unacted signals are retained on disk and the consumer arbitrates first-bind and retired-pane cases (Task 5, D1); the one residual loss window is a pane dying before the plugin writes the signal file at all.

**Architecture:** Ship a small static opencode TUI plugin (TypeScript) with freshell. At launch, freshell idempotently installs TWO freshell-owned files: `~/.freshell/opencode/freshell-rebind-plugin.ts` (the embedded plugin source) and a plugin-only `~/.freshell/opencode/tui.json` (exactly `{"plugin":["file:///<abs home>/.freshell/opencode/freshell-rebind-plugin.ts"]}`), and injects `OPENCODE_TUI_CONFIG=<abs path to that tui.json>` per-pane. Why this vector (validated on opencode 1.18.8/1.18.9, source-traced + runtime-probed): plugins listed in MAIN config (opencode.json / `OPENCODE_CONFIG_CONTENT`) load only as SERVER plugins and never reach the TUI plugin host — `TuiConfig.get()` returns config without `plugin_origins`, so `plugin/tui/runtime.ts:1088` always falls back to `TuiConfig.pluginOrigins()`, which reads only TUI config sources. TUI config sources MERGE additively and plugin arrays UNION, so the env-pointed file never suppresses the user's own TUI config. The plugin reads `FRESHELL_TERMINAL_ID` from its env and writes atomic signal files in the exact shape the claude SessionStart lane already uses (`~/.freshell/session-signals/<provider>/<terminalId>__<nonce>.json`). A Rust sweep drains the files and feeds the existing guarded rebind lane (same guard ladder and pinned fan-out as claude/codex, ending in `terminal.session.associated` with `previousSessionId`).

**Tech Stack:** TypeScript (opencode TUI plugin, vitest), Rust (freshell-platform launch injection, freshell-ws signal consumer, cargo/clippy), existing WS contract (no changes).

## Global Constraints

- **Base branch:** this branch (`feat/opencode-tui-rebind`) is STACKED on `fix/stale-resume-identity` (unmerged), NOT `origin/main`. The repo rule says branch from `origin/main`, but this work depends on the unmerged rebind lane (claude signal watcher, `previousSessionId` wire field, guarded rebind plumbing) — the stacked branch is the correct, deliberate deviation. Never rebase onto `origin/main` mid-plan.
- **Production safety:** the live self-hosted Rust server on port **3002** must NEVER be restarted/stopped/touched. Scratch testing only on other ports (`scripts/launch-rust.sh --port <N>`).
- **No PR:** stop after pushing the branch. Do not run `gh pr create`.
- **Never set `--pure` / `OPENCODE_PURE`** anywhere. If the user runs pure mode, plugins are disabled → no signal → today's behavior. That degradation is correct.
- **NEVER fall back to the activity/row-update correlation heuristic** (banned as hijack-capable by `docs/plans/2026-07-28-stale-resume-identity-p3-audit.md`). When unsure, do nothing.
- **Injection is per-pane env + freshell-owned files only.** Freshell installs two freshell-owned files idempotently at launch (`~/.freshell/opencode/freshell-rebind-plugin.ts` and a plugin-only `~/.freshell/opencode/tui.json` — the `plugin` key ONLY, never any other key, pinned by a unit test) and injects `OPENCODE_TUI_CONFIG=<abs path to that tui.json>` into `command_env`. `OPENCODE_CONFIG_CONTENT` is NOT injected at all (main-config plugins never reach the TUI plugin host). Never write or modify the user's opencode config (`~/.config/opencode/*`, project `.opencode/opencode.json`, any `tui.json` outside `~/.freshell/opencode/`); never place our tui.json in an ancestor directory of pane cwds (project tui.json discovery walks up to `/` — `~/.freshell/opencode/` is safe). If the merged env already carries `OPENCODE_TUI_CONFIG`, skip injection entirely (a path var cannot be merged; preserving the user's value wins; degradation = today's no-rebind behavior). Kill switch: skip injection when `FRESHELL_OPENCODE_REBIND` in the merged env is `0`/`false` (inverted `merged_env_truthy`-style semantics) — opencode self-updates in place, so one env var + a pane restart must be able to disable the feature without a freshell release.
- **Signal validation:** consumer acts only when the filename yields a non-empty terminal id AND the body's `session_id` matches `^ses_[A-Za-z0-9]+$`. Rejects are warn-logged (`opencode_signal_rejected`) before the file is consumed — a silently-never-firing lane is the failure mode to avoid (the producer stays silent).
- **Version tolerance:** the plugin must silently no-op if any opencode API surface (`slots`, `route`, `lifecycle`) is absent or shaped differently. Plugin init failure is non-fatal in opencode (logged only); freshell must degrade to no-rebind.
- **Frozen WS contract:** no new frames, no schema changes. `previousSessionId` on `terminal.session.associated` already exists (`shared/ws-protocol.ts:841`, `crates/freshell-protocol/src/server_messages.rs:1074`). The contract-freeze gate (`npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract`) must show no diff.
- **Do not regress base-branch guarantees:** one-writer invariant, A13 (never two live owners of one session id), A8 retired-inclusive ledger guard, D7 live-session guards, D8 leases, pinned fan-out order (identity.upsert → registry.set_meta → awaited `ledger_resolve_identity` → `associated` THEN `meta.updated`), G3 retire-never-defend (new bound ledger row FIRST, then retire+link old).
- **No new `WsState` field** for the watcher — the sweep task owns it (deliberate; every integration test constructs `WsState` as an exhaustive struct literal across ~27 test files). Mirror `claude_signal.rs:12-14`.
- **Rust toolchain:** pinned 1.96.0; gates are `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` (warnings are errors).
- **Rust commit discipline for goldens:** update `cli_launch_goldens.rs` FIRST (verify RED), then implement (GREEN) — the idiom used by the claude signal commit `971a506f`.
- **Coordinated tests:** broad runs via `npm test`/`npm run check` wait on the shared coordinator gate; focused runs via `npm run test:vitest -- run <paths> --config <cfg>`. Never raw `npx vitest`.

## Scope Decisions (locked)

1. **The consumer is Rust-only**, exactly like the claude SessionStart lane on the base branch (`grep -rn "session-signals" server/ src/ shared/` returns zero hits — the Node server has no signal lane, by design). Injection lives in `crates/freshell-platform/src/cli_launch.rs`, which only Rust callers use, so the Node server keeps today's behavior and no unconsumed signal files are ever produced. Node parity for the fan-out already exists on the base branch (`server/session-binding-authority.ts:52-72 swapTerminalSession`: `from_session_mismatch` ≙ D7, `target_session_already_owned` ≙ A13) and is untouched.
2. **No D7 old-owner guard needed beyond the claude ladder:** like claude's hook, the producer is per-terminal by construction (the plugin reads `FRESHELL_TERMINAL_ID` from its own PTY env), so the live-pane + provider-match check substitutes for codex's old-owner predicate (see `claude_signal.rs:127-223` note). Locator × signal arbitration (validated, V6): the signal is user-facing route truth and OUTRANKS the opencode locator's DB heuristic — when a never-bound live opencode pane receives a signal, the sweep performs the FIRST BIND (Task 5, D1.2), and the bind itself disarms the locator: its existing `resume_session_id.is_some()` reject (`opencode_association.rs:127`) turns any later Located event into a no-op. The reverse order (locator binds first, signal later) is just the ordinary rebind path. No locator code change.
3. **No sqlite `parent_id` cross-check:** the plugin reads the session id from the TUI's own route/slots (the session the user is LOOKING at), which is user-facing by construction. The server event bus is not consulted, so the subagent filter reduces to id-shape validation. Note (validated, V2): after a deliberate drill-in the viewed session can be a subagent CHILD session — that is still the session the user is viewing, and the id-shape-only policy deliberately rebinds to it. (Documented in the audit-doc update, Task 6.)
4. **Activity/status tracking needs no repoint:** the Node terminal-opencode activity tracker keys on `terminalId` + the pane's own loopback SSE port (`server/coding-cli/opencode-activity-tracker.ts:207-211`), session-agnostic; the Rust server has no opencode activity tracker; `fresh_opencode` is a separate lane that never binds terminal panes (and the fresh-agent ledger guard refuses cross-kind claims). The Rust `opencode_locator` is single-bind adoption: once a pane is bound — by the locator OR by a signal first-bind (Task 5, D1.2) — its existing `resume_session_id.is_some()` reject (`opencode_association.rs:127`) makes later Located events no-ops, so it cannot fight a later rebind; and when locator and signal race on a never-bound pane, the SIGNAL wins (Scope Decision 2 arbitration: the signal is user-facing route truth, the locator is a DB heuristic). No locator code change; crown Phase 8 pins the signal first-bind half, and an in-crate `opencode_association.rs` unit test (Task 5, delta 7) pins the Located-event rejection half (the `pub(crate)` association surface is unreachable from `tests/`).
5. **MCP-injection coexistence:** freshell's opencode MCP tool is injected by mutating the project-local `.opencode/opencode.json` (`mcp_inject.rs:393`). Coexistence is trivially safe with the `OPENCODE_TUI_CONFIG` vector: `mcp` lives in opencode.json — a different namespace from tui.json — and our injected tui.json contains ONLY the `plugin` key (Task 2 pins this with a unit test). TUI config sources (global `<config-dir>/opencode/tui.json|jsonc`, the `OPENCODE_TUI_CONFIG`-pointed file, project `tui.json|jsonc` walk-up, `.opencode`-dir tui.json) all MERGE; plugin arrays UNION (dedup by file URL); the env-pointed file does NOT suppress the user's own TUI config (validated on opencode 1.18.8/1.18.9: runtime probe showed both user and env plugins fired, user theme/settings preserved). Main-config plugins never reach the TUI host at all (`TuiConfig.get()` drops `plugin_origins`; `plugin/tui/runtime.ts:1088` falls back to `TuiConfig.pluginOrigins()`) — which is WHY `OPENCODE_CONFIG_CONTENT` is not the vector. Final task includes a manual real-opencode smoke check.

## File Structure

| File | Responsibility |
|---|---|
| `extensions/opencode/freshell-rebind-plugin.ts` (create) | The opencode TUI plugin: dedup-emit `(terminalId, sessionID)` signal files on every session switch. Pure-testable helpers exported. |
| `test/unit/server/opencode-rebind-plugin.test.ts` (create) | Vitest unit tests for the plugin (mocked TuiPluginApi, injected fs writer). |
| `crates/freshell-platform/src/opencode_plugin.rs` (create) | Embed plugin source (`include_str!`), idempotent install of the plugin AND the plugin-only `tui.json` to `~/.freshell/opencode/`; pure `tui_config_path` / `tui_config_content` / `plugin_file_spec` helpers. Inline unit tests. |
| `crates/freshell-platform/src/cli_launch.rs` (modify, opencode block `:416-422` area) | Per-pane env injection of `OPENCODE_TUI_CONFIG` into `command_env` (skip when user-set; `FRESHELL_OPENCODE_REBIND=0/false` kill switch); `merged_env_value` helper beside `merged_env_truthy` (`:246-257`); new `CliLaunchInputs.opencode_rebind_tui_config` field — the resolver stays pure, consuming the IO-precomputed install result (the `mcp_injection` precedent). |
| `crates/freshell-platform/src/cli_launch_goldens.rs` (modify) | Golden pins for the new opencode env injection (pure — inputs field set directly, no fs I/O). |
| `crates/freshell-ws/src/terminal.rs` (modify, `:1596-1646` area) | WS create call site: precompute the rebind-plugin install (fs I/O, warn-on-failure) and pass the tui.json path via `CliLaunchInputs`. |
| `crates/freshell-freshagent/src/terminal_tabs.rs` (modify, `:839-957` area) | REST create call site: same precompute-and-pass. |
| `crates/freshell-platform/src/lib.rs` (modify) | `pub mod opencode_plugin;` |
| `crates/freshell-ws/src/opencode_signal.rs` (create) | `OpencodeSignalWatcher` (sorted non-destructive drain, `ses_` validation + `opencode_signal_rejected` logging, ~10-min staleness cap), `drain_and_rebind_opencode` (guard ladder + first-bind arbitration + retired-pane rebind, act-then-delete, pinned fan-out), `spawn_opencode_signal_sweep`. Inline unit tests. |
| `crates/freshell-ws/src/lib.rs` (modify) | `pub mod opencode_signal;` |
| `crates/freshell-ws/src/codex_identity.rs` (modify, `:268`) | Fix hardcoded `provider: Some("codex")` in the `meta.updated` upsert of `broadcast_terminal_session_associated` — use the `provider` parameter. |
| `crates/freshell-server/src/main.rs` (modify, after `:803`) | Boot the opencode signal sweep next to the claude one. |
| `crates/freshell-ws/tests/opencode_switch_rebind.rs` (create) | Crown integration test: switch → rebind → restart → resumes NEW id; rapid switch flapping (fresh ids, D→E→D); invalid id; A13 hijack; no-signal regression; dead-pane retired rebind + retention; first-bind arbitration (signal half; the locator-rejection half lives in an in-crate `opencode_association.rs` unit test). |
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

- [ ] **Step 1: Verified API surface (record — do NOT re-derive)**

The npm install of opencode is binary-only: there is NO `@opencode-ai/plugin/dist/tui.d.ts` on disk to read — do not go looking for one. The surface below was verified against the sst/opencode source at tags v1.18.8 and v1.18.9 (byte-identical in every inspected path) plus live runtime probes on the installed binary (validation reports V2/V3/V7, 2026-07-28):

- The accepted TUI module shape is default export `{ id, tui(api) }` — and `id` is REQUIRED and non-empty for file plugins (`plugin/shared.ts:306-316`; a missing/empty id silently skips the plugin).
- `api.route.current` is a live getter over the single global route store, shape `{ name: "session", params: { sessionID } }`; EVERY in-TUI switch path (session_new, session_list select, child cycle, quick-switch, fork, server-pushed select) writes it.
- Slots `session_prompt` / `sidebar_title` exist via `api.slots.register(name, renderer)`, remount keyed per sessionID with `session_id = route.sessionID` in the renderer context, and a renderer returning `undefined` leaves the host's default UI fully intact (renderer errors contained). CAVEAT: `session_prompt` renders only while the prompt is visible and `sidebar_title` only while the sidebar is shown — slots have visibility gaps, so the `route.current` POLL is the PRIMARY edge and the slots are latency accelerators only (Step 4 is written accordingly).
- A bare `file:///abs/path.ts` plugin file loads fine (Bun imports TS; no package.json needed), but Bun caches failed imports for the process lifetime: the file must exist and be syntactically valid BEFORE the TUI starts (Task 3 installs it before launch).

Keep the version-tolerance posture regardless: every API touch is wrapped and the plugin silently no-ops if any surface is absent or changed. Optional re-verification against a future opencode version:

```bash
git clone --depth 1 --branch "v$(opencode --version)" https://github.com/sst/opencode /tmp/opencode-src \
  && sed -n '300,320p' /tmp/opencode-src/packages/opencode/src/plugin/shared.ts
```

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
// Injected per-pane by the freshell Rust server via OPENCODE_TUI_CONFIG,
// which points at the freshell-owned plugin-only tui.json installed next to
// this file in ~/.freshell/opencode/
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
// today's no-rebind behavior. PRIMARY edge: the api.route.current poll (1s)
// — the route store is written by every switch path. Latency accelerators:
// slot re-renders (session_prompt / sidebar_title), which have visibility
// gaps (session_prompt only while the prompt is visible, sidebar_title only
// while the sidebar is shown) and therefore must never be the only edge.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/
const POLL_INTERVAL_MS = 1000

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
      // Latency accelerators: host slots re-render with the current session
      // id on every switch, but only while visible (session_prompt: prompt
      // shown; sidebar_title: sidebar shown) — never the only edge. The
      // renderer returns undefined so the host's own content is never
      // replaced.
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
      // PRIMARY edge: 1s route poll — covers the slots' visibility gaps.
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

### Task 2: Rust plugin embed and install of the plugin + freshell-owned tui.json

**Files:**
- Create: `crates/freshell-platform/src/opencode_plugin.rs`
- Modify: `crates/freshell-platform/src/lib.rs` (add `pub mod opencode_plugin;` next to the existing module list)
- Test: inline `#[cfg(test)] mod tests` in `opencode_plugin.rs`

**Interfaces:**
- Consumes: `extensions/opencode/freshell-rebind-plugin.ts` (Task 1) via `include_str!`; `serde_json` (already a freshell-platform dependency — `claude_settings_json` uses `serde_json::json!`).
- Produces (used by Task 3):
  - `pub const REBIND_PLUGIN_SOURCE: &str`
  - `pub fn rebind_plugin_path(home: &Path) -> PathBuf` → `<home>/.freshell/opencode/freshell-rebind-plugin.ts`
  - `pub fn tui_config_path(home: &Path) -> PathBuf` → `<home>/.freshell/opencode/tui.json`
  - `pub fn plugin_file_spec(plugin_path: &Path) -> String` (portable `file://` spec)
  - `pub fn tui_config_content(plugin_path: &Path) -> String` → exactly `{"plugin":["file:///…"]}` — the `plugin` key ONLY, never any other key (pinned by a unit test; TUI config sources merge and plugin arrays union, so a plugin-only file preserves the no-shadowing property)
  - `pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf>` (idempotent, atomic tmp+rename, rewrites only when content differs; installs BOTH freshell-owned files and returns the tui.json path — the value Task 3 injects as `OPENCODE_TUI_CONFIG`)

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-platform/src/opencode_plugin.rs` with ONLY the test module first:

```rust
//! Freshell's opencode TUI rebind plugin: embedded source and idempotent
//! install of TWO freshell-owned files into ~/.freshell/opencode/ — the
//! plugin itself and a plugin-only tui.json pointing at it. The tui.json
//! is injected per-pane via OPENCODE_TUI_CONFIG (cli_launch.rs); TUI config
//! sources merge and plugin arrays union, so a plugin-only file can never
//! shadow the user's own TUI config.

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
    fn install_writes_both_files_idempotently_and_heals_content_drift() {
        let home = tempfile::tempdir().unwrap();
        let tui_json = ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(tui_json, tui_config_path(home.path()));
        let plugin = rebind_plugin_path(home.path());
        assert_eq!(std::fs::read_to_string(&plugin).unwrap(), REBIND_PLUGIN_SOURCE);
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
        // Second call: no error, same content.
        ensure_rebind_plugin_installed(home.path()).unwrap();
        // Drifted content is healed (both files).
        std::fs::write(&plugin, "tampered").unwrap();
        std::fs::write(&tui_json, "tampered").unwrap();
        ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&plugin).unwrap(), REBIND_PLUGIN_SOURCE);
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
    }

    #[test]
    fn tui_config_content_is_exactly_the_plugin_key_and_nothing_else() {
        let content = tui_config_content(Path::new("/h/.freshell/opencode/p.ts"));
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        // ONLY the plugin key — TUI config sources MERGE (scalar keys:
        // later-order source wins) and plugin arrays UNION, so a plugin-only
        // file can never shadow the user's own tui.json (plan Scope
        // Decision 5 / validation report V7). This pin is load-bearing:
        // never add another key.
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        assert_eq!(
            v["plugin"],
            serde_json::json!(["file:///h/.freshell/opencode/p.ts"])
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

/// The freshell-owned TUI config injected per-pane via OPENCODE_TUI_CONFIG.
/// Lives under ~/.freshell/opencode/ — deliberately NOT an ancestor of any
/// pane cwd (opencode's project tui.json discovery walks up to `/`).
pub fn tui_config_path(home: &Path) -> PathBuf {
    home.join(".freshell").join("opencode").join("tui.json")
}

/// `file://` spec for the tui.json `plugin` array. Unix: `file:///abs`.
/// Windows drive paths get forward slashes and a third slash.
pub fn plugin_file_spec(plugin_path: &Path) -> String {
    let s = plugin_path.display().to_string().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Exactly `{"plugin":[<spec>]}` — the plugin key and NOTHING else. TUI
/// config sources MERGE and plugin arrays UNION (dedup by file URL), so
/// this single-key file can never shadow the user's global/project
/// tui.json (validated on opencode 1.18.8/1.18.9, report V7). Load-bearing:
/// never add another key (pinned by unit test).
pub fn tui_config_content(plugin_path: &Path) -> String {
    serde_json::json!({ "plugin": [plugin_file_spec(plugin_path)] }).to_string()
}

fn write_atomic_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Idempotently materialize BOTH freshell-owned files into
/// `~/.freshell/opencode/`: the plugin source and the plugin-only tui.json
/// pointing at it. Atomic (tmp + rename); rewrites only when content
/// differs, so a running opencode never observes a torn file. Returns the
/// tui.json path — the value cli_launch.rs injects as OPENCODE_TUI_CONFIG.
/// Bun caches failed imports for the process lifetime, so this MUST run
/// (and succeed) before the TUI launches.
pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf> {
    let plugin = rebind_plugin_path(home);
    write_atomic_if_changed(&plugin, REBIND_PLUGIN_SOURCE)?;
    let tui_json = tui_config_path(home);
    write_atomic_if_changed(&tui_json, &tui_config_content(&plugin))?;
    Ok(tui_json)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-platform opencode_plugin
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all
git add crates/freshell-platform/src/opencode_plugin.rs crates/freshell-platform/src/lib.rs crates/freshell-platform/Cargo.toml
git commit -m "feat(platform): embed + install opencode rebind plugin and plugin-only tui.json"
```

---

### Task 3: Inject OPENCODE_TUI_CONFIG in the launch resolver (golden-first)

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs` (opencode block at `:416-422`; helper beside `merged_env_truthy` at `:246-257`; new field on `CliLaunchInputs` at `:106-124`)
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs`
- Modify: `crates/freshell-ws/src/terminal.rs` (WS create call site, `:1596-1646` — precompute the plugin install beside the existing `generate_mcp_injection` precompute)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST create call site, `:839-957` — same precompute)

**Interfaces:**
- Consumes: Task 2's `opencode_plugin::{ensure_rebind_plugin_installed, tui_config_path, rebind_plugin_path}`; the resolver's env abstraction (`env: &dyn Env` with `.get(key) -> Option<String>`, already used by `get_opencode_env_overrides(env, &command_env)` and `merged_env_truthy`); the existing precomputed-IO seam — `CliLaunchInputs` (`cli_launch.rs:106-124`), whose `mcp_injection` field is THE precedent this task mirrors ("Pure: all IO … arrives through `CliLaunchInputs`", `cli_launch.rs:5-8` and `:366-368`).
- Produces: every freshell-spawned opencode pane (WS create `freshell-ws/src/terminal.rs:1635`, REST create `freshell-freshagent/src/terminal_tabs.rs:954`, and restore relaunches — `command_env` is rebuilt identically on restore) carries `OPENCODE_TUI_CONFIG=<abs path to ~/.freshell/opencode/tui.json>` in `command_env`. `OPENCODE_CONFIG_CONTENT` is NOT injected at all. **Split of responsibilities (mirrors `mcp_injection` exactly):** the plugin INSTALL (fs I/O) runs at the two IO call sites BEFORE the resolver, and its result is passed in via a new `CliLaunchInputs.opencode_rebind_tui_config: Option<String>` field (`Some(tui.json path)` on success; `None` = do not inject). `resolve_coding_cli_command` stays pure — it never touches the filesystem (its doc comment pins this contract; performing the install inside it would violate `cli_launch.rs:5-8`/`:366-369` and force fs writes into the hermetic goldens; `freshell-platform` also deliberately has no logging dependency, so the install's warn-on-failure cannot live there). Skip rules (each degrades to today's no-rebind behavior): (a) PURE, in the resolver — the merged env already carries `OPENCODE_TUI_CONFIG` (a path var cannot be merged; preserving the user's value wins, skip injection entirely); (b) PURE, in the resolver — kill switch: `FRESHELL_OPENCODE_REBIND` set to `0`/`false` in the merged env skips injection (opencode self-updates in place; one env var + a pane restart disables the feature without a freshell release); (c) IO layer — unresolvable home ⇒ pass `None`; (d) IO layer — install failure ⇒ `tracing::warn!` (both call-site crates already depend on and use `tracing`) and pass `None`, never blocking the launch. New pure helper: `fn merged_env_value(parent: &dyn Env, command_env: &BTreeMap<String, String>, key: &str) -> Option<String>` (mirror `merged_env_truthy`'s exact parameter types at `:246-257`) with the same JS-spread shadowing semantics (a present-but-empty `command_env` value shadows the process env).

**Home-dir resolution rule (locked):** home is resolved at the IO call sites (where the real process env is the correct source), matching `ClaudeSignalWatcher::default_root`'s exact home-resolution idiom — read `claude_signal.rs:52-66` and mirror whatever it does (`$HOME`-then-`%USERPROFILE%` convention). NOT in the resolver: the resolver receives only the precomputed `Option<String>`. No home ⇒ pass `None` ⇒ skip injection (degrade, mirroring `default_root() -> None` skipping the sweep). The goldens stay hermetic because they never call the installer — they set `opencode_rebind_tui_config` directly, building the expected path with the PURE `opencode_plugin::tui_config_path` helper. Note for integration tests: a test that creates a real opencode pane through these call sites installs the two freshell-owned files under the process `$HOME`; point `HOME` at a tempdir (under the suite's env lock) if isolation matters.

- [ ] **Step 1: Read the exact current shape**

Read `crates/freshell-platform/src/cli_launch.rs:100-130` (`CliLaunchInputs` and the `mcp_injection` precedent field), `:240-300` (the env-lookup helpers and `get_opencode_env_overrides`), and `:405-480` (the opencode block, resume args). Read the two IO call sites you are extending — `freshell-ws/src/terminal.rs:1596-1646` and `freshell-freshagent/src/terminal_tabs.rs:839-957` — noting how each precomputes `generate_mcp_injection` and then builds the `CliLaunchInputs` literal (that precompute-then-pass shape is exactly what this task replicates). Read the goldens' input constructors in `cli_launch_goldens.rs` (`claude_inputs` `:78`, `codex_inputs` `:243`, `opencode_inputs` `:367`, `amplifier_inputs` `:677`; argv pins near `:393,418,457,472`; note how the golden constructs its fake env and whether it asserts `command_env`). Keep `get_opencode_env_overrides` pure and untouched — the injection is a separate statement in the same `mode == "opencode"` block, consuming only the precomputed input and the merged env.

- [ ] **Step 2: Update the goldens FIRST (verify RED)**

In `cli_launch_goldens.rs`, for every opencode golden case, extend the expected `command_env` with the new key (the goldens now pin the `OPENCODE_TUI_CONFIG` injection). The goldens stay PURE — no tempdir, no fs I/O, no installer call (the file-install behavior is already pinned by Task 2's `opencode_plugin` unit tests). Build the expected value with the pure path helper and pass it through the new inputs field:

```rust
let fake_home = std::path::Path::new("/golden-home");
let expected_tui_config = crate::opencode_plugin::tui_config_path(fake_home)
    .display()
    .to_string();
let mut inputs = opencode_inputs();
inputs.opencode_rebind_tui_config = Some(expected_tui_config.clone());
// resolve, then:
// assert command_env["OPENCODE_TUI_CONFIG"] == expected_tui_config
```

Add three NEW golden cases:
1. **User value present (skip):** fake env contains `OPENCODE_TUI_CONFIG=/their/tui.json` and inputs carry `Some(...)` → resolved `command_env` does NOT contain the key at all (a path var cannot be merged; the user's raw process-env value passes through to the PTY untouched; no freshell files are forced on the pane).
2. **Kill switch (skip):** fake env contains `FRESHELL_OPENCODE_REBIND=0` and inputs carry `Some(...)` → resolved `command_env` does NOT contain `OPENCODE_TUI_CONFIG`; repeat with `false` (inverted `merged_env_truthy`-style semantics).
3. **No precomputed install (skip):** inputs carry `opencode_rebind_tui_config: None` (the IO layer's unresolvable-home / install-failure outcome) → resolved `command_env` does NOT contain the key.

Also assert in an existing opencode golden that **argv is byte-identical to before** (the injection is env-only; `--hostname/--port/--session` args unchanged).

```bash
cargo test -p freshell-platform cli_launch 2>&1 | tail -20
```

Expected: FAIL — initially as a COMPILE error (`opencode_rebind_tui_config` does not exist until Step 3 adds it; that compile failure is the RED state), and, once the field exists, as assertion failures because the injection isn't implemented yet.

- [ ] **Step 3: Implement the field, the helper, the pure injection, and the IO-layer precompute**

**(a) New input field** — in `CliLaunchInputs` (`cli_launch.rs:106-124`), beside `mcp_injection`:

```rust
/// Precomputed by the IO layer (like `mcp_injection` — this resolver never
/// does fs I/O): `Some(<abs path to the freshell-owned tui.json>)` when the
/// opencode rebind-plugin install succeeded at the call site, `None`
/// otherwise (non-opencode pane, unresolvable home, or install failure —
/// skip injection, degrading to today's no-rebind behavior).
pub opencode_rebind_tui_config: Option<String>,
```

The struct is built as an exhaustive literal at both IO call sites and in the goldens' four constructor helpers (`claude_inputs`/`codex_inputs`/`opencode_inputs`/`amplifier_inputs`) — the compiler will point at every construction that needs the new field. Set `None` everywhere except the opencode paths below and the golden cases from Step 2.

**(b) Pure merged-env helper** — beside `merged_env_truthy` (`cli_launch.rs:246-257`), mirroring its exact parameter types:

```rust
/// Merged-view env lookup with JS spread semantics: a key present in
/// command_env (even empty) shadows the process env. Companion to
/// merged_env_truthy, returning the value instead of truthiness.
fn merged_env_value(
    parent: &dyn Env, // ← merged_env_truthy's exact env-parameter type
    command_env: &std::collections::BTreeMap<String, String>,
    key: &str,
) -> Option<String> {
    if let Some(v) = command_env.get(key) {
        return Some(v.clone());
    }
    parent.get(key) // ← the same accessor merged_env_truthy uses
}
```

**(c) Pure injection decision** — in the `mode == "opencode"` block (after the existing `get_opencode_env_overrides` insertion at `:416-422`). No fs I/O here — the install already happened (or didn't) at the IO layer:

```rust
// Freshell TUI rebind plugin (docs/plans/2026-07-28-opencode-tui-rebind.md):
// the IO layer installed the plugin + plugin-only tui.json into
// ~/.freshell/opencode/ and passed the tui.json path via
// inputs.opencode_rebind_tui_config (the mcp_injection precedent — this
// resolver stays pure). Point this pane's TUI at it via OPENCODE_TUI_CONFIG.
// Main-config plugins (opencode.json / OPENCODE_CONFIG_CONTENT) load as
// SERVER plugins only and never reach the TUI plugin host; TUI config
// sources MERGE and plugin arrays UNION, so the injected plugin-only file
// can never shadow user config (validated on opencode 1.18.8/1.18.9).
// Skips (each degrades to today's no-rebind behavior): user-set
// OPENCODE_TUI_CONFIG (a path var cannot be merged — preserve the user's
// value), the FRESHELL_OPENCODE_REBIND=0/false kill switch (opencode
// self-updates in place), and a None input (unresolvable home or install
// failure at the IO layer, which warn-logs and never blocks the launch).
let rebind_disabled = matches!(
    merged_env_value(env, &command_env, "FRESHELL_OPENCODE_REBIND").as_deref(),
    Some("0") | Some("false")
);
let user_tui_config = merged_env_value(env, &command_env, "OPENCODE_TUI_CONFIG");
if !rebind_disabled && user_tui_config.is_none() {
    if let Some(tui_config) = &inputs.opencode_rebind_tui_config {
        command_env.insert("OPENCODE_TUI_CONFIG".to_string(), tui_config.clone());
    }
}
```

**(d) IO-layer precompute** — at BOTH call sites (`freshell-ws/src/terminal.rs:1596-1646` and `freshell-freshagent/src/terminal_tabs.rs:839-957`), beside the existing `generate_mcp_injection` precompute, feeding the new field into the `CliLaunchInputs` literal. Both crates already depend on and use `tracing`; adapt the platform-crate path to how each file already imports the resolver, and adapt the `mode == "opencode"` condition to the call site's existing opencode branch/variable (`terminal.rs:1517` / `terminal_tabs.rs:852`):

```rust
// Freshell opencode TUI rebind plugin: the install (fs I/O) happens HERE at
// the IO layer; the pure resolver only reads the result from
// CliLaunchInputs (mcp_injection precedent). Failure must never block the
// launch.
let opencode_rebind_tui_config = if mode == "opencode" {
    // Home from the real process env — verify against the actual
    // ClaudeSignalWatcher::default_root body (claude_signal.rs:52-66) and
    // mirror its exact home-resolution idiom; the chain below is
    // illustrative, the real body wins.
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()));
    match home {
        Some(home) => {
            match freshell_platform::opencode_plugin::ensure_rebind_plugin_installed(
                std::path::Path::new(&home),
            ) {
                Ok(tui_config) => Some(tui_config.display().to_string()),
                Err(error) => {
                    tracing::warn!(%error,
                        "opencode_rebind_plugin_install_failed: launching without rebind signal");
                    None
                }
            }
        }
        None => None,
    }
} else {
    None
};
// … then in the CliLaunchInputs literal:
//     opencode_rebind_tui_config,
```

- [ ] **Step 4: Run tests to verify GREEN**

```bash
cargo test -p freshell-platform
cargo check -p freshell-ws -p freshell-freshagent
```

Expected: PASS, including all pre-existing goldens (claude/codex untouched), and clean compilation of both call-site crates (their runtime behavior is exercised by Task 5's crown test).

- [ ] **Step 5: Quality gates and commit**

```bash
cargo fmt --all --check && cargo clippy -p freshell-platform -p freshell-ws -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/cli_launch_goldens.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "feat(platform,ws,freshagent): inject freshell rebind plugin into opencode panes via OPENCODE_TUI_CONFIG, install precomputed at the IO call sites"
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
  - `pub struct OpencodeSignalWatcher` with `pub fn new(root: PathBuf) -> Self`, `pub fn default_root() -> Option<PathBuf>` (`$HOME`/`%USERPROFILE%` + `.freshell/session-signals/opencode`, `None` when home unresolvable — mirror `claude_signal.rs:52-66`), `pub fn drain(&self) -> Vec<OpencodeSignal>` — NON-DESTRUCTIVE for valid signals: they are returned WITH their file paths and left on disk (the Task 5 consumer deletes each file only after ACTING on it — D1.1); rejected files (bad id shape, empty terminal id, malformed json) are warn-logged (`opencode_signal_rejected`) and deleted; files older than `STALE_SIGNAL_MAX_AGE` (~10 min) are reaped without emitting; `*.tmp` ignored
  - `pub struct OpencodeSignal { pub path: PathBuf, pub terminal_id: String, pub session_id: String, pub source: Option<String> }` (derive `Debug, Clone, PartialEq, Eq`)
  - `pub(crate) const STALE_SIGNAL_MAX_AGE: std::time::Duration` (~10 minutes — the retention cap)
  - `pub(crate) fn is_valid_opencode_session_id(id: &str) -> bool`

This module deliberately mirrors `claude_signal.rs`'s shape rather than extracting a provider-generic watcher. The spec prefers "the server-side consumer is reused, not duplicated" — what is REUSED is the signal-file contract, the sweep architecture, the entire guard/fan-out surface (`identity`, `registry`, `pane_ledger`, `broadcast_terminal_session_associated`), and the pinned tail; only the ~80-line watcher/ladder shell is mirrored, because (a) the codebase's stated preference is shape duplication over premature provider-generic controllers (`codex_association.rs:4-6`), (b) parameterizing `claude_signal.rs` would touch the base branch's shipped claude lane (Global Constraint: don't regress it), and (c) opencode needs two behavioral deltas claude must not inherit. Three deltas from claude: (1) `drain()` **sorts** entries by filename before processing, so one pane's timestamp-first nonces process in emission order and rapid A→B→A resolves last-write-wins deterministically; (2) `parse_signal_file` **rejects** any `session_id` not matching `^ses_[A-Za-z0-9]+$` (the spec's hard shape requirement — opencode ids are `ses_*`; a census of 2151 real sessions showed zero violations, but opencode's own acceptance is weaker, so rejects are also **warn-logged** as `opencode_signal_rejected` before being consumed — a silently-never-firing lane is the failure mode to avoid; the producer stays silent); (3) drain is **non-destructive for valid signals** — each is returned WITH its file path and left on disk; the Task 5 consumer deletes a file only after ACTING on it (act-then-delete, D1.1), so signals for panes that are momentarily absent are retained for later sweeps, with a `STALE_SIGNAL_MAX_AGE` (~10 min) reap. Rationale (V6, falsified A14): a fire-and-forget drain permanently lost signals whenever a pane died within ~1-3s of a switch — every later restore then resumed the OLD id.

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

    fn remaining(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn drain_parses_sorts_retains_valid_files_and_consumes_rejects() {
        let dir = tempfile::tempdir().unwrap();
        // Timestamp-first nonces: lexicographic order == emission order.
        write_signal(dir.path(), "term-1__00000000000002-000002-9.json",
            r#"{"session_id":"ses_bbb","source":"opencode-tui-plugin"}"#);
        write_signal(dir.path(), "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#);
        // Rejected (warn-logged as opencode_signal_rejected + deleted):
        // bad id shape (claude-style uuid), malformed json, missing __.
        write_signal(dir.path(), "term-1__00000000000003-000003-9.json",
            r#"{"session_id":"22222222-3333-4444-8555-666677778888"}"#);
        write_signal(dir.path(), "junk__1.json", "{not json");
        write_signal(dir.path(), "no-delimiter.json", r#"{"session_id":"ses_x"}"#);
        // Ignored entirely (staging file), must survive the drain.
        write_signal(dir.path(), "term-1__00000000000004-000004-9.tmp",
            r#"{"session_id":"ses_ccc"}"#);

        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        let ids: Vec<(&str, &str)> = signals
            .iter()
            .map(|s| (s.terminal_id.as_str(), s.session_id.as_str()))
            .collect();
        assert_eq!(ids, vec![("term-1", "ses_aaa"), ("term-1", "ses_bbb")]);
        assert_eq!(signals[0].source.as_deref(), Some("opencode-tui-plugin"));
        // Valid signals carry their file paths and are RETAINED on disk —
        // the Task 5 consumer deletes each file only after ACTING on it
        // (act-then-delete, D1.1).
        assert!(signals.iter().all(|s| s.path.exists()));
        // Rejected .json files are consumed (single-shot — junk must not
        // re-fail every sweep); the .tmp staging file is untouched.
        assert_eq!(
            remaining(dir.path()),
            vec![
                "term-1__00000000000001-000001-9.json".to_string(),
                "term-1__00000000000002-000002-9.json".to_string(),
                "term-1__00000000000004-000004-9.tmp".to_string(),
            ]
        );
    }

    #[test]
    fn drain_reaps_stale_files_without_emitting() {
        let dir = tempfile::tempdir().unwrap();
        write_signal(dir.path(), "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_old"}"#);
        let path = dir.path().join("term-1__00000000000001-000001-9.json");
        // Backdate past the retention cap (D1.1 staleness reap).
        let stale = std::time::SystemTime::now() - STALE_SIGNAL_MAX_AGE - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        assert!(watcher.drain().is_empty());
        assert!(!path.exists());
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
//! injected per-pane via OPENCODE_TUI_CONFIG pointing at the freshell-owned
//! plugin-only tui.json) writes
//! `$HOME/.freshell/session-signals/opencode/<terminal_id>__<nonce>.json`
//! on every in-TUI session switch. This module drains those files.
//!
//! Shape-mirrors claude_signal.rs (the codebase prefers duplication over a
//! premature provider-generic controller — see codex_association.rs:4-6),
//! with three deltas: drain() sorts by filename (timestamp-first nonces ⇒
//! deterministic last-write-wins under rapid A→B→A switching); session ids
//! must match `ses_[A-Za-z0-9]+` (opencode's id shape; reject everything
//! else before any guard runs, warn-logging rejects for detectability);
//! and drain is NON-DESTRUCTIVE for valid signals — the consumer deletes a
//! file only after acting on it (act-then-delete, D1.1), with a ~10-minute
//! staleness reap for signals nobody ever acts on.
//!
//! Deliberately NOT a WsState field: the sweep task owns the watcher
//! (claude_signal.rs:12-14 — WsState is an exhaustive struct literal in
//! ~27 test files).

use std::path::{Path, PathBuf};

// NOTE: the sweep-interval const (OPENCODE_SIGNAL_SWEEP_INTERVAL) is added in
// Task 5 together with its only consumer, spawn_opencode_signal_sweep —
// introducing it here would make this task's `clippy -D warnings` gate fail
// as dead_code.
/// Retention cap for unacted signal files (D1.1): a signal whose pane never
/// (re)appears is reaped after this age instead of living forever.
pub(crate) const STALE_SIGNAL_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Clone)]
pub struct OpencodeSignalWatcher {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSignal {
    /// The signal file itself. The consumer deletes it only after ACTING on
    /// the signal (act-then-delete, D1.1) — never delete-on-read.
    pub path: PathBuf,
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

    /// Read + parse every `*.json`, sorted by filename. Valid signals are
    /// returned WITH their file paths and RETAINED on disk — act-then-delete
    /// is the consumer's job (D1.1: a fire-and-forget drain permanently lost
    /// signals when a pane died within seconds of a switch, V6). Malformed
    /// and invalid-shape files are warn-logged (`opencode_signal_rejected`)
    /// and deleted (single-shot semantics — junk must not re-fail every
    /// sweep). Files older than STALE_SIGNAL_MAX_AGE are reaped without
    /// emitting. `*.tmp` staging files are ignored.
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
            let stale = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_SIGNAL_MAX_AGE);
            if stale {
                let _ = std::fs::remove_file(&path); // retention cap (D1.1)
                continue;
            }
            match parse_signal_file(&path) {
                Some(sig) => signals.push(sig), // retained: consumer act-then-deletes
                None => {
                    // A silently-never-firing lane is the failure mode to
                    // avoid (A8 detectability): log rejects before consuming.
                    tracing::warn!(path = %path.display(),
                        "opencode_signal_rejected: bad terminal id or session_id shape, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
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
        path: path.to_path_buf(),
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
git commit -m "feat(ws): opencode signal-file watcher (sorted retained drain, ses_ shape validation)"
```

---

### Task 5: Guarded rebind consumer, sweep boot, provider-hardcode fix, and the crown test

**Files:**
- Modify: `crates/freshell-ws/src/opencode_signal.rs` (add the consumer half)
- Modify: `crates/freshell-ws/src/codex_identity.rs:268` (provider hardcode fix)
- Modify: `crates/freshell-server/src/main.rs` (boot the sweep, immediately after the claude sweep block at `:792-803`)
- Modify: `crates/freshell-ws/src/opencode_association.rs` (in-crate `#[cfg(test)]` unit test ONLY — no production change; pins D1.2's locator-rejection half, which is unreachable from `tests/`)
- Test: Create `crates/freshell-ws/tests/opencode_switch_rebind.rs`

**Interfaces:**
- Consumes: Task 4's `OpencodeSignalWatcher`/`OpencodeSignal` (each signal carries its file `path`); the base branch's guard/fan-out surface — `state.identity.get / upsert / retire / find_by_session_including_retired` (`identity.rs`), `state.registry.live_session_owner(Some(&state.identity), "opencode", id)` (`registry.rs:2180`), the registry's per-terminal entry accessor (mode / Running / `resume_session_id` / cwd — needed for D1.2 first-bind arbitration; match the real accessor names), `state.registry.set_meta`, `state.pane_ledger.lookup_by_session`, `crate::pane_ledger::ledger_resolve_identity(state, tid, "opencode", sid, cwd).await`, `crate::codex_identity::broadcast_terminal_session_associated(state, "opencode", tid, sid, cwd, previous)`.
- Produces: `pub async fn drain_and_rebind_opencode(state: &WsState, watcher: &OpencodeSignalWatcher)` (`pub` so the integration test drives drains deterministically instead of racing the timer — same rationale as `drain_and_rebind_claude`), `pub fn spawn_opencode_signal_sweep(state: WsState, watcher: OpencodeSignalWatcher)`. ACT-THEN-DELETE semantics (D1.1): a signal file is deleted only after the signal was ACTED ON — rebound (live, first-bind, or retired-pane), same-id no-op, or a deliberate guard refusal (A13 / ledger A8 / fresh-agent); signals with no actionable pane (no identity row and no live never-bound opencode pane, or a foreign-provider row) are RETAINED on disk for later sweeps, and the watcher's ~10-minute staleness cap reaps abandoned ones.

- [ ] **Step 1: Read the two reference files**

Read `crates/freshell-ws/src/claude_signal.rs:127-236` (`drain_and_rebind_claude` + `spawn_claude_signal_sweep`) and `crates/freshell-ws/src/codex_identity.rs` (esp. `broadcast_terminal_session_associated` at `:238-277` and the `:268` hardcode). Read `crates/freshell-ws/tests/claude_session_rebind.rs` in full (436 lines) — it is the structural template for the crown test — and skim `crates/freshell-ws/tests/codex_fork_rebind.rs:321-360` for the argv-capture fake-CLI idiom and the file-level `static ENV_LOCK`.

- [ ] **Step 2: Write the failing crown test**

Create `crates/freshell-ws/tests/opencode_switch_rebind.rs` by copying `crates/freshell-ws/tests/claude_session_rebind.rs` and applying these exact deltas (keep its helper structure — `spawn_server_returning_state`-style spawner, `TestWs`, `next_frame_of_type`, fake-CLI installer — reusing `tests/common/mod.rs` where the claude test does):

1. **Fake CLI:** a fake `opencode` shell script that dumps `"$@"` to `$OPENCODE_ARGV_CAPTURE_PATH` and sleeps (copy the fake-claude script from the claude test, renaming the capture env var). Register it as the `opencode` mode command the way the claude test registers its fake (spawn-spec/`OPENCODE_CMD`-equivalent — mirror the claude test's mechanism exactly).
2. **Session ids (one-owner-forever — every successful-bind phase gets FRESH ids):** under the pinned guards a session id ever bound to one pane — live OR retired — can never successfully bind a different pane (A13 live-owner refusal via `registry.live_session_owner`, plus the identity A8 retired-inclusive refusal via `find_by_session_including_retired`, which only permits `existing == sig.terminal_id`), so this shared-state test MUST NOT reuse an id across phases that expect a bind on a different pane. Ids, all the same 26-char shape: `ses_aaaaaaaaaaaaaaaaaaaaaaaaaa` (A) and `ses_bbbbbbbbbbbbbbbbbbbbbbbbbb` (B) for Phases 1–2, `ses_cccccccccccccccccccccccccc` (C, hijack target, Phase 5 only — it stays live-owned by the second pane for the rest of the test), `ses_dddddddddddddddddddddddddd` (D) and `ses_eeeeeeeeeeeeeeeeeeeeeeeeee` (E) for Phase 3, `ses_ffffffffffffffffffffffffff` (F) and `ses_gggggggggggggggggggggggggg` (G) for Phase 7, `ses_hhhhhhhhhhhhhhhhhhhhhhhhhh` (H) for Phase 8.
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

4. **Ledger (ENABLED — the claude template's is DISABLED):** the copied spawner constructs `pane_ledger: PaneLedger::disabled()` (`claude_session_rebind.rs:132`), which stores nothing — no ledger assertion can pass against it, and the claude test itself makes NO ledger assertions (do not look there for an idiom). Change that one construction line to an enabled, lock-free ledger over a second `tempfile::tempdir()`: `PaneLedger::new(Some(ledger_dir.path().to_path_buf()))` (`pane_ledger.rs:217` — the constructor the test/integration harness uses; production's flock `new_locked` at `:236` is unnecessary here). Assert rows against the SAME instance that lives in the spawned `WsState` (keep the handle you passed in / read it back off the state) — a `PaneLedger` loads its read index at construction, so a separately-constructed reader over the same dir will NOT see the server's later writes. For the row-assertion idiom, mirror the existing ledger-asserting integration tests (e.g. `crates/freshell-ws/tests/pane_ledger_triggers.rs`, `pane_ledger_restore.rs`). Row shape (use these names, not `retired: bool`/`reason`): `state: RowState::{Bound,Retired}`, `retired_reason: Option<RetiredReason>` with `RetiredReason::Superseded`, `superseded_by: Option<SessionLocator>`, `live_terminal_id`.
5. **Test name and phases** — one test fn `tui_switch_signal_rebinds_and_restart_resumes_the_new_id`:
   - **Phase 1 (rebind):** create an opencode terminal bound to A (`terminal.create` with `restore:true` + `sessionRef {provider:"opencode", sessionId:A}` — exactly how the claude test binds its initial session). Write a signal for B, call `freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await`, then assert: `terminal.session.associated` frame with `sessionRef {opencode, B}` AND `previousSessionId == A`; the following `terminal.meta.updated` frame carries **provider `"opencode"`** (this pins the `:268` fix — it currently says `"codex"`); registry meta `resume_session_id == B`; pane-ledger (via delta 4's ENABLED ledger — the claude test asserts nothing here and its idiom cannot be mirrored): A's row has `state == RowState::Retired`, `retired_reason == Some(RetiredReason::Superseded)`, and `superseded_by` pointing at B, while B's row is `Bound` (G3: new bound row first, then retire+link old); assert against the ledger instance inside the spawned `WsState`.
   - **Phase 2 (restart resumes NEW id):** kill the terminal, re-create with `restore:true` + `sessionRef {opencode, B}`; assert captured argv contains `--session ses_bbb…` and does NOT contain `ses_aaa…`.
   - **Phase 3 (rapid D→E→D — FRESH ids and a FRESH pane; A and B are one-owner-forever spent by Phases 1–2):** create a fresh pane bound to D; write three signals in one sweep window with ascending seq (`D`, then `E`, then `D`), one `drain_and_rebind_opencode` call; assert the final identity/meta equals the LAST signal's id (D), the first `D` signal is a same-id no-op (no frame), and the two `associated` frames arrive in sorted order (D→E with `previousSessionId == D`, then E→D with `previousSessionId == E`): last-write-wins, idempotent, no flapping error. Why the D re-bind passes the guards: the E leg upserted the pane's single identity row from D to E, so no identity row carries D when the third signal lands (and A8 would permit the SAME terminal anyway — it only refuses `existing != sig.terminal_id`); no live pane owns D (A13 clean). This works ONLY because D and E were never bound to any OTHER pane — do not substitute A/B/C here.
   - **Phase 4 (invalid shape ignored):** write a signal whose body is `{"session_id":"not-a-session"}`; drain; assert no `associated` frame and meta unchanged, but the file IS consumed (`std::fs::read_dir(&root).unwrap().count() == 0`) — the watcher warn-logs it as `opencode_signal_rejected` (F7 detectability; the log itself is not asserted).
   - **Phase 5 (A13 hijack refusal):** second live opencode pane owns C; forge a signal naming pane 1's terminal id claiming C; drain; assert no `associated` frame, both panes' meta unchanged, file consumed. (Mirror the claude test's phase 3 assertions verbatim.)
   - **Phase 6 (no-signal regression — the `--pure`/plugin-missing story):** with no signal files present, drain; assert zero frames and unchanged meta — freshell without a signal behaves exactly like today, which is precisely what `--pure`, `disableAllHooks`-style plugin loss, plugin init failure, a user-set `OPENCODE_TUI_CONFIG`, or the kill switch produce.
   - **Phase 7 (dead-pane retired rebind + retention — pins D1.3; FRESH ids F/G — A and B are spent: pane1's retired row and pane2's live row still hold them, so their reuse would be A8/A13-refused and no frame would ever arrive):** bind a fresh pane to F; write a signal for G; KILL the pane BEFORE draining (the identity row is now retired — the exact window that permanently lost the signal under fire-and-forget drain, V6); call `drain_and_rebind_opencode`; assert an `associated` frame with `sessionRef {opencode, G}` and `previousSessionId == F`, the identity row STILL retired but now carrying G, the ledger showing F's row `Retired` with `retired_reason == Some(RetiredReason::Superseded)` and `superseded_by` → G's `Bound` row (G3, via delta 4's enabled ledger), and the signal file consumed (acted on). Then re-create the pane through the ref/restore flow the association produced (the frozen client moves the persisted pane ref on `associated` by layout presence — `src/lib/terminal-session-association.ts:84-105` — so restore now carries G) and assert the captured relaunch argv contains `--session ses_ggg…` and NOT `ses_fff…`.
   - **Phase 8 (first-bind arbitration — pins D1.2's SIGNAL half):** create a live opencode pane WITHOUT any session binding (never-bound: `resume_session_id` unset); write a signal for the FRESH id H (NOT C — Phase 5's second pane stays alive and live-owns C until test teardown, so a C signal here would be A13-refused and the expected frame would never arrive); drain; assert an `associated` frame binding H with `previousSessionId == null` and registry meta `resume_session_id == H` (file consumed). The LOCATOR half of D1.2 — a later Located event is rejected once the bind set `resume_session_id` — is NOT drivable from `tests/`: `drain_and_associate` is `pub(crate)`, its test helpers are private, the mandated spawner sets `opencode_locator: None`, and the only pub locator surface is the infinite sweep spawner (racing it would break this test's determinism stance). That half is covered by the in-crate unit test in delta 7 instead.
6. Keep the claude test's `ENV_LOCK`/env-serialization discipline if it mutates process env for the fake CLI.
7. **In-crate locator-arbitration unit test (D1.2's locator half — Phase 8 cannot cover it):** in `crates/freshell-ws/src/opencode_association.rs`'s existing `#[cfg(test)] mod tests`, add a sibling to `restore_created_pane_without_identity_arms_and_resolves_into_the_ledger` (`:535-620` — the existing seeded-DB idiom, with access to the private `state_with_locator`/`open_seed_db`/`insert_session` helpers and the `pub(crate)` `drain_and_associate`): arrange a live opencode pane whose registry meta already has `resume_session_id = Some("ses_hhhhhhhhhhhhhhhhhhhhhhhhhh")` (exactly the state a signal first-bind leaves behind), seed the locator DB with a DIFFERENT session row that would otherwise associate, run `drain_and_associate`, and assert REJECTION by ABSENCE OF EFFECT — identity row absent/unchanged and no binding written — because the `:127-133` reject emits only a `tracing::warn!` (`opencode_association_rejected: terminal_already_bound`), no frame or event, so state (not logs) is the assertable surface. This pins that a signal bind disarms the locator.

- [ ] **Step 3: Run to verify RED**

```bash
cargo test -p freshell-ws --test opencode_switch_rebind 2>&1 | head -30
```

Expected: compile FAIL — `drain_and_rebind_opencode` does not exist yet.

- [ ] **Step 4: Implement the consumer + sweep**

Append to `crates/freshell-ws/src/opencode_signal.rs` (this is `drain_and_rebind_claude` — `claude_signal.rs:127-223` — with `"claude"` → `"opencode"`, the A7-compaction comment replaced by the plugin-dedupe note, and the D1 extensions: act-then-delete on `sig.path`, first-bind arbitration, retired-pane rebind; copy the real file's exact `use` items and `now_ms` idiom):

```rust
/// Drain opencode switch signals and rebind panes through the guarded lane.
/// `pub` so integration tests drive drains deterministically.
///
/// Guard ladder (drain_and_rebind_claude's ladder + the D1 extensions from
/// the 2026-07-28 validation pass; the producer is per-terminal by
/// construction — the plugin reads FRESHELL_TERMINAL_ID from its own PTY
/// env — so codex's D7 old-owner predicate is subsumed by the live-pane +
/// provider-match check, exactly as in the claude lane):
///   (0)  identity row present with provider opencode, PLUS two extensions:
///   (0a) FIRST-BIND ARBITRATION (D1.2, also resolves the locator race):
///        no identity row, but the registry shows a LIVE never-bound
///        opencode pane (mode=="opencode", Running,
///        resume_session_id.is_none()) ⇒ first bind through guards (2)-(4),
///        cwd from the registry entry, previousSessionId None. The signal
///        is user-facing route truth and outranks the locator's DB
///        heuristic; the bind itself disarms the locator
///        (opencode_association.rs:127 rejects once
///        resume_session_id.is_some()). No pane at all ⇒ RETAIN the file.
///   (0b) RETIRED-PANE REBIND (D1.3): identity row RETIRED with provider
///        opencode and a different session id ⇒ run guards (2)-(4), then
///        identity.upsert + immediate re-retire (upsert clears the retired
///        flag; retire preserves fields), SKIP registry.set_meta (no live
///        row), await ledger_resolve_identity (G3 supersede), broadcast
///        `associated` with previousSessionId — the frozen client applies
///        association by layout presence, not liveness
///        (src/lib/terminal-session-association.ts:84-105), so the
///        persisted pane ref moves and a future restore resumes the NEW id.
///   (1) same-id no-op (the plugin dedupes, but the initial route poll
///   re-reports the bound id at startup), (2) A13 no live owner of the
///   target, (3) ledger A8 retired-inclusive, (4) fresh-agent sessions
///   never bind terminal panes.
/// ACT-THEN-DELETE (D1.1): sig.path is removed only after the signal was
/// acted on (rebound, same-id no-op, or a deliberate guard refusal); files
/// with no actionable pane are RETAINED for later sweeps (the watcher's
/// staleness cap reaps abandoned ones).
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
        let acted = apply_opencode_signal(state, &sig).await;
        if acted {
            let _ = std::fs::remove_file(&sig.path); // act-then-delete (D1.1)
        }
        // Not acted ⇒ the file stays for a later sweep (retention).
    }
}

/// Guards (2)-(4): A13 live-owner, ledger A8 retired-inclusive, fresh-agent.
/// `false` (warn-logged where meaningful) = the target session must NOT be
/// bound to this terminal — a deliberate refusal, which still counts as
/// ACTED ON for act-then-delete purposes.
fn target_session_guards_pass(state: &WsState, sig: &OpencodeSignal) -> bool {
    if let Some(owner) = state
        .registry
        .live_session_owner(Some(&state.identity), "opencode", &sig.session_id)
    {
        tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
            "opencode_rebind_refused: target session already live-owned (A13)");
        return false;
    }
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("opencode", &sig.session_id)
    {
        if existing != sig.terminal_id {
            tracing::warn!(terminal_id = %sig.terminal_id,
                "opencode_rebind_refused: session_bound_elsewhere");
            return false;
        }
    }
    if state
        .pane_ledger
        .lookup_by_session("opencode", &sig.session_id)
        .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
    {
        return false;
    }
    true
}

/// PINNED fan-out for live panes: identity -> meta -> ledger(await) ->
/// associated THEN meta.updated.
async fn rebind_fanout(
    state: &WsState,
    sig: &OpencodeSignal,
    cwd: Option<&str>,
    previous: Option<String>,
) {
    state
        .identity
        .upsert(&sig.terminal_id, Some("opencode"), Some(&sig.session_id), cwd, now_ms());
    state.registry.set_meta(
        &sig.terminal_id,
        None,
        None,
        Some("opencode".to_string()),
        Some(sig.session_id.clone()),
    );
    crate::pane_ledger::ledger_resolve_identity(state, &sig.terminal_id, "opencode", &sig.session_id, cwd)
        .await;
    crate::codex_identity::broadcast_terminal_session_associated(
        state,
        "opencode",
        &sig.terminal_id,
        &sig.session_id,
        cwd.map(str::to_string),
        previous,
    );
}

/// One signal through the ladder. Returns whether the signal was ACTED ON
/// (delete the file) vs skipped (retain it for a later sweep).
async fn apply_opencode_signal(state: &WsState, sig: &OpencodeSignal) -> bool {
    let Some(current) = state.identity.get(&sig.terminal_id) else {
        // (0a) D1.2 first-bind arbitration. Match the registry's real
        // per-terminal accessor names for mode/liveness/resume_session_id
        // and cwd when implementing.
        let Some(entry) = state.registry.get(&sig.terminal_id) else {
            return false; // no pane (yet): RETAIN for a later sweep
        };
        if entry.mode.as_deref() != Some("opencode")
            || !entry.is_running()
            || entry.resume_session_id.is_some()
        {
            return false; // not a live never-bound opencode pane: RETAIN
        }
        if !target_session_guards_pass(state, sig) {
            return true; // deliberate refusal — acted
        }
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source,
            "opencode_rebind: first bind via TUI signal (signal outranks locator)");
        rebind_fanout(state, sig, entry.cwd.as_deref(), None).await;
        return true;
    };

    if current.provider.as_deref() != Some("opencode") {
        return false; // foreign-provider row: never touch; RETAIN until stale
    }
    if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
        return true; // same-id no-op — acted
    }
    if !target_session_guards_pass(state, sig) {
        return true; // A13 / ledger A8 / fresh-agent refusal — acted
    }

    let previous = current.session_id.clone();
    if current.retired {
        // (0b) D1.3 retired-pane rebind: the pane died after the switch but
        // the signal survived (retention). Move the persisted ref so a
        // future restore resumes the NEW id.
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source, "opencode_rebind: retired pane ref moved to new session");
        state.identity.upsert(
            &sig.terminal_id,
            Some("opencode"),
            Some(&sig.session_id),
            current.cwd.as_deref(),
            now_ms(),
        );
        // upsert cleared the retired flag; re-retire preserves fields.
        state.identity.retire(&sig.terminal_id);
        // SKIP registry.set_meta: no live row.
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
        return true;
    }

    // (0) live pane — the ordinary rebind path.
    tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
        source = ?sig.source, "opencode_rebind: TUI plugin reported a new session id");
    rebind_fanout(state, sig, current.cwd.as_deref(), previous).await;
    true
}

// Introduced here (not in Task 4) because this is its only consumer — an
// unused private const would fail Task 4's `clippy -D warnings` gate.
const OPENCODE_SIGNAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

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

**Fix `codex_identity.rs:268`:** in `broadcast_terminal_session_associated`, the `meta.updated` upsert hardcodes `provider: Some("codex".to_string())` although the function takes `provider: &str` (the `associated` frame at `:249` already uses it). Change to `provider: Some(provider.to_string())`. This corrects claude rebinds too (they currently emit a `meta.updated` claiming provider codex) and is asserted by crown Phase 1. Validated safe (V5): NO consumer depends on the buggy value, and the fix REPAIRS two live client consumers currently broken by it for claude rebinds — `src/store/sessionsSlice.ts:198-223` (running-session keys) and `src/components/PaneContainer.tsx:100-124` (provider-matched meta). Mention that repair in the commit message.

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
        crates/freshell-ws/src/opencode_association.rs \
        crates/freshell-server/src/main.rs crates/freshell-ws/tests/opencode_switch_rebind.rs
git commit -m "feat(ws): opencode mid-session rebind via TUI-plugin signal files (P5)" \
  -m "Includes the codex_identity.rs:268 provider fix, which also repairs the claude-rebind meta.updated consumers (src/store/sessionsSlice.ts:198-223, src/components/PaneContainer.tsx:100-124)."
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

**Shipped mechanism (active signal, opencode 1.18.8/1.18.9 — validated on
both; opencode SELF-UPDATES in place, observed live during validation):**
- The TUI plugin host loads plugins ONLY from TUI config sources (global
  `<config-dir>/opencode/tui.json|jsonc`, an `OPENCODE_TUI_CONFIG`-pointed
  file, project `tui.json|jsonc` walk-up, `.opencode`-dir tui.json);
  main-config plugins (opencode.json / `OPENCODE_CONFIG_CONTENT`) load as
  SERVER plugins only and never reach the TUI host. TUI config sources MERGE
  and plugin arrays UNION (dedup by file URL), so the injected file never
  suppresses the user's own TUI config (`~/.config/opencode` untouched; env
  is per-PTY so only freshell-spawned panes are affected).
- Freshell ships `extensions/opencode/freshell-rebind-plugin.ts`, installs it
  plus a plugin-only `tui.json` to `~/.freshell/opencode/`
  (`opencode_plugin.rs`), and injects `OPENCODE_TUI_CONFIG=<that tui.json>`
  per-pane (`crates/freshell-platform/src/cli_launch.rs`). Kill switch:
  `FRESHELL_OPENCODE_REBIND=0/false` skips injection (future-version drift
  mitigation); a user-set `OPENCODE_TUI_CONFIG` also skips (their value
  wins). The plugin reads `FRESHELL_TERMINAL_ID` and emits claude-shaped
  signal files (`~/.freshell/session-signals/opencode/<tid>__<nonce>.json`)
  on every switch; PRIMARY edge = 1s `api.route.current` poll, latency
  accelerators = slot re-renders (`session_prompt`/`sidebar_title` — both
  have visibility gaps, so never the only edge); dedupe on repeat ids.
- Consumer: `crates/freshell-ws/src/opencode_signal.rs` — sorted drain,
  `ses_[A-Za-z0-9]+` shape validation (rejects warn-logged as
  `opencode_signal_rejected`), then the claude guard ladder (live pane +
  provider match, same-id no-op, A13, ledger A8, fresh-agent guard) and the
  pinned fan-out ending in `terminal.session.associated` + `previousSessionId`.
  D1 drain semantics: act-then-delete with on-disk RETENTION for signals
  whose pane is momentarily absent (~10-min staleness cap); FIRST-BIND
  arbitration for never-bound live panes (the signal outranks the opencode
  locator and the bind disarms it); RETIRED-PANE rebind (moves the persisted
  ref so a later restore resumes the new id). The route-derived id is
  user-facing by construction (no bus consultation ⇒ no `parent_id`
  cross-check needed).
- Degradation: `--pure`/`OPENCODE_PURE` disables plugins; plugin init failure
  is non-fatal in opencode (1.18.8/1.18.9, source-verified across every
  loader path); a user-set `OPENCODE_TUI_CONFIG` or the kill switch skips
  injection — all yield exactly today's no-rebind behavior. Crown test:
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

(Binary note: the pane's opencode command resolves via `cli_launch.rs:380-385` — `env[OPENCODE_CMD]` else plain `opencode` PATH resolution — an override lane exists, currently unset, if you need to pin a specific binary for this smoke. The installed opencode is 1.18.8/1.18.9-class and SELF-UPDATES in place — observed live during validation — so note the version you actually smoked against.)

1. Open a terminal pane in opencode mode. In the pane run nothing — just confirm opencode starts (plugin init failure is non-fatal, but a hard TUI crash means the injected config is malformed: STOP and fix before pushing).
2. From another shell: `ls ~/.freshell/opencode/freshell-rebind-plugin.ts ~/.freshell/opencode/tui.json && cat ~/.freshell/opencode/tui.json` — BOTH freshell-owned files exist next to each other and tui.json contains ONLY the `plugin` key. From INSIDE the pane: `echo $OPENCODE_TUI_CONFIG` prints that tui.json path. Then `ls ~/.freshell/session-signals/opencode/ 2>/dev/null` — after the pane is up, at most transient signal files (the sweep consumes acted-on files within ~1s).
3. In the TUI, create/switch sessions (session list keybind). Within ~3s the pane's session association should update; check the server log (`~/.freshell/logs/rust-server-3499.log`) for `opencode_rebind: TUI plugin reported a new session id`.
4. Kill the pane process and restore the pane: the relaunch argv (visible in the log or via `ps`) must carry `--session <NEW id>`.
5. Verify the freshell MCP tool still appears inside opencode (Scope Decision 5 coexistence check).
6. Stop the scratch server: `scripts/launch-rust.sh --port 3499 --stop`.

If step 3 shows NO signal on switch: check `~/.freshell/session-signals/opencode/` for accumulating files (consumer problem) vs none at all (producer problem). For a producer problem, verify the TUI actually LOADED the plugin — check the opencode TUI log (or run opencode with `--print-logs` in a pane-equivalent env) for the `freshell-rebind` plugin / its `file://` URL; confirm `OPENCODE_TUI_CONFIG` is set inside the pane; and remember Bun caches failed imports for the process lifetime, so a plugin file that was missing/invalid at TUI start stays dead until pane restart. (There are no d.ts files to re-read — the install is binary-only; if the API surface drifted, re-verify against the matching sst/opencode source tag per Task 1 Step 1 and rerun Tasks 1/5 tests.) Do not push until the live smoke passes or the failure is understood and documented in the commit message.

- [ ] **Step 5: Push the branch (stop — no PR)**

```bash
git push -u origin feat/opencode-tui-rebind
```

Do NOT create a PR. The workflow's later stages handle review.

---

## Self-Review Record

- **Spec coverage:** injected TUI plugin with poll-primary (1s) / slot-accelerator edges (Task 1), freshell-owned plugin + plugin-only tui.json install and per-pane `OPENCODE_TUI_CONFIG` injection with skip-if-user-set + `FRESHELL_OPENCODE_REBIND` kill switch (Tasks 2–3), signal-file shape reuse of the claude lane (Tasks 1, 4), Rust-first guarded rebind with full fan-out incl. ledger supersede + `previousSessionId` + restart-resumes-new-id (Task 5), D1 drain semantics — act-then-delete retention, first-bind arbitration vs the locator, retired-pane rebind (Tasks 4–5, crown Phases 7–8), rejected-signal detectability via the `opencode_signal_rejected` warn (Task 4, crown Phase 4), activity-tracking repoint audited as no-op with the corrected `server/coding-cli/` citation (Scope Decision 4), Node parity resolved as Rust-only consumer matching the claude precedent with Node fan-out untouched (Scope Decision 1), safety/degradation (`--pure`, plugin failure, version tolerance, kill switch, no heuristic fallback — Global Constraints + crown Phases 4/6 + plugin tolerance tests), rapid switch-flapping last-write-wins (sorted drain + crown Phase 3, fresh ids D→E→D), subagent filter via id shape + no bus consultation incl. the deliberate drilled-in-child case (Scope Decision 3), doc updates for both audit sections (Task 6), tests mirroring the codex/claude crown pattern with simulated signal files + plugin unit tests with mocked TuiPluginApi + the tui.json plugin-key-only pin + no-signal regression (Tasks 1–5), contract freeze + clippy + coordinated suite + no-PR + production-3002 safety (Task 7, Global Constraints). Every falsified finding from the 2026-07-28 validation pass is reflected — F1 injection vector (`OPENCODE_TUI_CONFIG`, not `OPENCODE_CONFIG_CONTENT`), F2 dead d.ts step replaced with the verified-surface record, F3 poll-primary at 1000 ms, F4 drain retention/arbitration (D1), F5 locator × signal arbitration, F6 version/citation/consumer-repair text, F7 reject logging, F8 audit-doc, F9 smoke — and no step contradicts the validated facts. No unresolved coverage gaps.
- **Silent deferrals:** none. The environment-dependent surface (real opencode plugin API behavior on a self-updating binary) is covered by a mandatory manual smoke against a real opencode in Task 7 Step 4 with an explicit do-not-push-on-failure rule, plus the kill switch for post-ship drift, in the same spirit as the repo's opt-in real-provider contract tests.
- **Placeholder scan:** no TBD/TODO/"add error handling" steps; no dead commands (the binary-only install has no d.ts to read — Task 1 Step 1 records the verified surface and offers a source-clone re-verification instead); the "copy the reference file and apply deltas" steps (crown test, sweep spawner) name the exact source file, line ranges, and every delta, including the D1 deltas.
- **Type consistency:** `OpencodeSignalWatcher::{new, default_root, drain}`, `OpencodeSignal{path, terminal_id, session_id, source}`, `STALE_SIGNAL_MAX_AGE`, `drain_and_rebind_opencode(&WsState, &OpencodeSignalWatcher)` with act-then-delete on `sig.path` (helpers `apply_opencode_signal`, `target_session_guards_pass`, `rebind_fanout`), `opencode_plugin::{REBIND_PLUGIN_SOURCE, rebind_plugin_path, tui_config_path, tui_config_content, plugin_file_spec, ensure_rebind_plugin_installed}` (install returns the tui.json path Task 3 injects as `OPENCODE_TUI_CONFIG`), plugin exports `extractSessionId`/`createEmitter`/`EmitterDeps`/default `{id, tui}` with `POLL_INTERVAL_MS = 1000` — consistent across Tasks 1–5 and the goldens. The crown-test phase list (Phases 1–8) matches Task 5's step text, incl. Phase 7 (retired-pane rebind + retention) and Phase 8 (first-bind arbitration).

## Validation Record (2026-07-28)

Load-bearing-assumption validation ledger:
`/home/dan/code/freshell/.worktrees/.the-usual-logs/opencode-tui-rebind/load-bearing-ledger.md`
(detail reports V1–V7 alongside). Outcome: **11 verified, 5 falsified — all
planned around** (injection vector → `OPENCODE_TUI_CONFIG` + plugin-only
tui.json; dead d.ts verification step → recorded verified API surface; slot
visibility gaps → route poll as the primary edge; fire-and-forget drain signal
loss → D1 act-then-delete/retention/arbitration; locator × signal interleaving
→ D1.2 first-bind arbitration), and **2 accepted residuals**: the stacked-base
branch (A11) and future opencode version drift (A5/A12 — opencode self-updates
in place, observed live; mitigated by the `FRESHELL_OPENCODE_REBIND` kill
switch, the plugin's version tolerance, and the Task 7 real-opencode smoke).
All findings were validated on opencode 1.18.8/1.18.9 (byte-identical in every
inspected source path).
