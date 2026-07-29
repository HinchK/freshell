# Audit: P3 — stale-resume-identity rebind descope

This document records the audit findings that led to descoping pane↔CLI-session rebinding for specific providers. Each section captures the validated findings for a provider and the rationale for not shipping rebind code.

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
