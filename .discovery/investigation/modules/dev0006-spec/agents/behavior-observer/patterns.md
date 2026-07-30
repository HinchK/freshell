# Recurring themes in post-2026-07-22 work bearing on S5 (quantified)

Scope: 263 commits since 2026-07-22 on `crates/{freshell-codex,freshell-ws,freshell-freshagent,freshell-platform}` + `port/oracle/DEVIATIONS.md`; grep counts against the working tree 2026-07-30 (note: `terminal.rs`, `terminal_tabs.rs`, `lib.rs` carry uncommitted diffs).

## P1. Codex terminal identity became server-authoritative — via DISK, not the proxy
The restart-resilience campaign (07-24 → 07-29) built the exact capability S5 was slated to deliver ("durable session binding for codex terminal panes"), but sourced from the codex **rollout JSONL on disk** (locator + lineage), not from the S4 remote proxy's frame-scanning:
- `sessionRef`/`session_ref`: **376 + 445 grep hits** across freshell-ws/freshagent — a pervasive first-class identity concept that barely existed at spec time.
- `pane_ledger`: **207 hits, 20+ files** — durable binding rows keyed on sessionRef, written at identity events, awaited before answer (P1.8).
- `rollout`: **446 hits** — locator, tailer, reconcile lane, fork-lineage detection.
- The proxy's event channel is explicitly **parked**: `launch_lifecycle.rs:373-375` (`_events` "Held (unconsumed) … for S5").
Consequence: S5's "consume proxy candidates to mint a durable sessionRef" is now a SECOND writer into a system that just enforced single-writer identity (candidate.persisted channel retired `4767b7ec`; misbind guards `857c9d48`).

## P2. Activity/turn tracking landed without the proxy
- `CodexActivity*`/`codex_activity`: **57 hits**; `ActivityHub`: **25 hits**; `turn_completed`: **37 hits**.
- G3/G9 (07-25, codex-status-completeness) delivered `bind_codex_session`, `reconcile_rollout`, a per-terminal codex rollout lane; hardened 07-29 (deadman force-reads, Rescan self-heal, PR #574).
- `codex.activity.updated` / `terminal.turn.complete` carry sessionId for codex terminal panes TODAY, flag OFF.
Consequence: S5's "drive codex-activity-tracker-equivalent turn events" is implemented by a parallel mechanism; proxy-sourced turn events would duplicate it.

## P3. `terminal.meta.updated` is no longer absent — but the paperwork says it is
- **23 grep hits** across protocol + 4 ws emit sites: create-time slice (`terminal.rs:3198-3270, 5116`; introduced `b9e0c1a3` 2026-07-16, i.e. BEFORE the spec) and association-time upserts for codex (`codex_identity.rs:229`) and opencode (`opencode_association.rs:172`), landed 07-24/26.
- Still absent: git enrichment (branch/dirty), token usage, exit-remove — the create-time builder returns bare cwd/provider/sessionId fields only.
- DEV-0008 record (`DEVIATIONS.md:588-653`) is textually unchanged: "rust emits NO terminal.meta.updated frames" — **stale**. The council's "whole-or-not" fence the spec repeats (§6) was in practice superseded by incremental slices with their own review trails.

## P4. The managed-launch lane itself is frozen and slightly decayed
- 7 commits to `freshell-codex` since 07-22: 3 are the S3/S4 landing itself, 2 are style, 2 are **deletions** (`35cf2864` removed the durability-store exports S5 was expected to write into — `default_durability_store_dir`, `DurabilityCandidate`; `2a68d027` removed 447 lines of restore-decision machinery).
- `FRESHELL_CODEX_MANAGED_LAUNCH`: 24 hits/8 files; every integration test except the host-gated e2e `remove_var`s it — the flag-ON path has accumulated **zero** new coverage alongside 5 weeks of identity work.
- Goldens: G-X0 still live-path pin (drifted :623→:738); G-X1/G-X2/G-W2 unchanged. No swap.

## P5. Flag-flip friction is accumulating, not shrinking
- Spawn gate (07-25/27): managed-launch planning now runs UNDER a shared WS+REST spawn permit; worst case ~226 s hold (5 attempts × 45 s) flagged as decision **D-C** with a `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` tripwire at the REST call site and on the flag const (`launch_plan.rs:56-59`, `e2e9cbc3`, rest-spawn-gate.md:109-123).
- `f3cef839`: spawn-gate rejection now has to clean up MCP/codex side effects — the create path around the codex branch grew failure modes S4 never saw.
- Auto-resume orchestrator (07-27) respawns agent terminals server-side; a flipped-on managed launch multiplies each respawn into sidecar+proxy replanning under the same permit.

## P6. Resume identity is now guarded, leased, and REBINDABLE
- D7 live-session guard (WS `043a9340`, REST `70c43c65`), D8 per-sessionRef single-flight + `SESSION_RESERVED` (`88a33933`, freshagent leases `c4cdc60d`+), `SESSION_IDENTITY_MISMATCH` input bounce (`60281e25`).
- Mid-session rebind: codex fork-lineage drain + guarded identity move + `previousSessionId` broadcast (`dde20036`, `146c5c36`, `5c591843`); claude SessionStart signals; ledger supersession chains.
- WS codex resume is derived sessionRef-first with raw fallback (`136b9e94`; `terminal.rs:1172-1176`); REST still hard-rejects raw codex resume (`terminal_tabs.rs:65,130`) while EDEV-07 synthesizes sessionRef for canonical shapes.
Consequence: the spec's static decision table (§1.2) and its "align WS raw-resume to legacy reject" follow-up describe a world without leases, verdicts, or rebind — the parity target itself moved (deliberately, recorded as EDEVs).

## P7. Documentation lags code by ~5 days, consistently
- DEV-0006 record: last touched 07-22 (closure_progress); accurate about the flag but its S5 sentence no longer describes reality (durability/activity/meta landed independently).
- DEV-0008 record: untouched since 07-14 adjudication; contradicted by shipping code.
- The spec's §2.3 "Nothing like this exists in Rust (no remote_proxy)" contradicts its own LANDED note; §3 impact list is 3/4 stale; §7 file:line anchors have all drifted.
