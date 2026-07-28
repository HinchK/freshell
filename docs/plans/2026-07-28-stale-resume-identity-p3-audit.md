# Audit: P3 — stale-resume-identity rebind descope

This document records the audit findings that led to descoping pane↔CLI-session rebinding for specific providers. Each section captures the validated findings for a provider and the rationale for not shipping rebind code.

## amplifier

**Why rebind was descoped (validated A8):** The originally-planned fork-lineage detection would have corrupted the durable pane ledger on the live substrate (8,535 session dirs / 8,083 `events.jsonl`, plus the installed `amplifier_app_cli 0.1.1` source).

**Findings:**

- amplifier's TUI has `/fork` but NO `/resume`/session picker (`amplifier_app_cli/main.py:398-412`).
- `/fork` does NOT rebind the running pane's session: `_fork_session` (`main.py:1113-1226`) creates the fork dir and prints "Resume with: `amplifier session resume <id>`" while the live session remains the old one — there is NO legitimate rebind trigger; rebinding on `/fork` would be actively wrong (the user keeps talking in the OLD session).
- 0 of 2,509 real `session:start` records carry `parent_id` (top-level key absent everywhere; `data.parent_id` non-null in 0) — fork lineage lives in `metadata.json` (`parent_id` + `forked_from_turn`, `fork.py:158-171`).
- The originally-planned predicate ("new session dir whose `session:start` carries `parent_id == watched id`, or a `session:fork` event referencing it") would match exactly the 5,553 subagent dirs (69% of the substrate) whose FIRST event is `session:fork` with `data.parent_id` = the parent session's id — spawned immediately after the pane's Enter, i.e. inside any Enter-anchored window → the pane would be rebound onto a subagent dir and the true binding durably retired `Superseded` (the A4 corruption shape).
- Future work (short note): a deterministic amplifier signal would need upstream lineage in `session:start` (or a hook analogous to claude's SessionStart). Until then amplifier keeps today's behavior — no mid-session rebind, no added corruption risk.

## opencode

**Why rebind was descoped (validated A9 confirmed-with-corrections + A10 FALSIFIED):** The originally-planned two-window correlation rebind is a heuristic with real false-positive drivers that would durably retire the true binding `Superseded`. Recording the audit is the P3 deliverable.

**Findings:**

- Switching sessions in the v1.18.8 TUI is PURE CLIENT NAVIGATION with zero DB write (`packages/tui/src/component/dialog-session-list.tsx:283` — `route.navigate(...)`); the chosen row's `time_updated` advances only on the NEXT prompt Enter (`packages/opencode/src/session/prompt.ts:1058` `sessions.touch`).
- `time_updated` is a real NOT NULL integer COLUMN on `session` (not JSON `$.time.updated`).
- Freshell's `list_sessions_since` floors on `time_created` (`crates/freshell-sessions/src/parse/opencode.rs:185`) and cannot express "updated-in-range" — a pre-existing switch target is filtered out; a new SQL variant would have been required.
- User forks (`session.fork`) set NO `parentID` (lineage = title-suffix convention only; `parent_id` is used solely for subagent child sessions) — a lineage-variant detector has no substrate field to key on.
- The correlation rebind is UNSAFE: non-switch writers of `session.time_updated` at the installed v1.18.8 include external prompts (a second TUI, ACP/IDE, `opencode run` loops — `opencode-ralph-loop` is installed on this machine), auto-compaction `setSummary`, `setAgentModel`, `setPermission`, revert stage/clear, `setShare`, `setWorkspace`, and API `setMetadata`. An externally-advanced session passes every planned guard (no live owner, A13 vacuous) → false-positive hijack of the pane + durable `Superseded` retirement of the true binding.
- Future work (short note): a deterministic path would be an opencode plugin/event signal (follow-up research) — never row-update correlation. Until then opencode keeps today's behavior (stale resume remains unfixed for opencode: status quo, no corruption added).
