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
  // Mirror the Rust consumer's home resolution (OpencodeSignalWatcher::
  // default_root is cfg-gated: USERPROFILE only on Windows, HOME otherwise)
  // — otherwise a Windows git-bash/MSYS shell with HOME set would emit
  // signals into a directory the server never sweeps.
  const home =
    process.platform === 'win32'
      ? (deps.env.USERPROFILE ?? deps.env.HOME)
      : (deps.env.HOME ?? deps.env.USERPROFILE)
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
