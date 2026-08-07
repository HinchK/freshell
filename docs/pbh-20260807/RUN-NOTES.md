# Parallel bug-hunt run pbh-20260807 (started 2026-08-07 01:02)
Target: Rust `crates/` only. Node `server/` OUT of scope (reference only).
Coordination channel: agmsg not installed -> using append-only JSONL equivalent at /tmp/pbh-20260807/.
Base: origin/main @ 90fc866db. Branch: pbh/20260807/integration.
Live server on :3001 (pid 4157145) is NOT touched; scratch instances use unique high ports with recorded PIDs.

## Mapping-wave postmortem (fable, synthesis lead — 2026-08-07 02:13)

Artifacts landed: docs/pbh-20260807/map/{promise-ledger,fan-inventory,code-mass-heatmap,territories}.md.

Worker coverage:
- GOOD: Lens 3 (code-mass) — mm-mass.md + mm-churn.md (/tmp/pbh-20260807/map/) were excellent:
  concrete LoC/churn numbers, doc-tagging, and two pre-found asymmetries (idle-reaper vs
  background-session; tabs in-memory vs tabs-persist) that seeded the top territories.
- HUNG (no artifact ever appeared; polled 01:55-02:13, dir quiet since 01:42): Lens 1 (promises)
  and Lens 2 (fans) workers, plus the regional workers for freshell-freshagent, freshell-sessions,
  the reconcile/resume/reconnect machinery, freshell-protocol, and the UI-implied-promises pass.
  Synthesis covered all of these by targeted direct reads (module-doc headers + protocol enums +
  dispatch match arms + 7 SPA components); depth is shallower than a dedicated worker pass —
  treat the fan inventory's "declared-but-unmatched WS members" as high-value but unverified.
- Never assigned/dark: freshell-tauri, extensions lifecycle, freshell-server long tail
  (updater/proxy/checkpoints/screenshots) — flagged dark in territories.md.

Skill improvements (concrete):
1. TIME-BOX + CHECKPOINT workers: require a partial artifact write within ~15 min of start
   (append-as-you-go to the shared map dir, not write-once-at-end). The two workers that
   finished wrote once at the end; the five that hung left NOTHING — a mid-run checkpoint would
   have salvaged most of their reading. "Commit early" already exists for hunters; extend it
   explicitly to mappers.
2. SIMPLER TASK SHAPES for mapping: "read one 54k-LoC crate deeply" is an open-ended read that
   invites context exhaustion (the likely hang cause on freshell-ws/freshagent). Card should
   prescribe the cheap high-yield moves first: module-doc headers only (head -40 per file),
   protocol/enum listings, grep for dispatch sites — then depth ONLY on the top-3 files. Cap
   the region at ~10-15 files per worker and split big crates by concern, not by crate.
3. HEARTBEAT on the coordination channel: mappers must post claim + a 10-min heartbeat; the
   orchestrator re-assigns a region after 2 missed beats instead of discovering the gap at
   synthesis time (this run discovered 5 hung regions only when synthesis polled the artifact dir).
