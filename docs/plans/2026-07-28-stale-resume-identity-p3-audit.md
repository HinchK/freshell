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
