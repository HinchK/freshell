# Findings — is the DEV-0006 spec (and its S5 follow-ups) stale? (Agent 2: Behavior Observer)

All evidence against `main` working tree, 2026-07-30. Uncommitted diffs exist in `crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/lib.rs`, `crates/freshell-freshagent/src/terminal_tabs.rs` (and `auto_resume.rs`, `backpressure.rs`, `create_limit.rs`) — cited lines in those files reflect the uncommitted state.

## F1. The spec's §3 user-impact claims are 3/4 stale
The spec (§3) lists four consequences of the open gap. Code as of 07-29:
1. "No durable session binding for codex terminal panes" — **FALSE now.** Server-side rollout locator + `adopt_codex_identity` + pane-identity ledger bind fresh codex panes (flag OFF): `codex_association.rs` (arm at create, 150ms sweep), `codex_identity.rs:185-229` (identity upsert → registry meta → ledger → broadcasts → activity bind), `pane_ledger.rs` (207 grep hits). Landed 07-25/26 (`8ad550fd`, `5cfcb93e`, `c8d59245`, `40e57088`).
2. "features.apps not forced off" — **still TRUE** (flag default OFF; `launch_plan.rs:59`).
3. "No managed turn/activity tracking" — **FALSE in effect.** Disk rollout lane delivers turn/activity with sessionId (`2d592afa`, `71dd4830`; hardened `18bc5443` 07-29). It is not the *managed* (proxy) stream, but the user-visible absence the spec describes is gone.
4. "DEV-0008 badges stay absent" — **PARTLY FALSE.** `terminal.meta.updated` is emitted at create time (`terminal.rs:3198-3270,5116`; builder introduced `b9e0c1a3` 2026-07-16 — *pre-dating the spec*, which missed it) and at codex/opencode association (`codex_identity.rs:229`, `opencode_association.rs:172`, since 07-24/26). Git branch/dirty and token-usage fields are still never populated; no exit-remove.

## F2. S5's designed mechanism has been pre-empted by a different architecture
Spec S5 = "Consume the proxy's captured candidates to mint a durable sessionRef, drive codex-activity-tracker-equivalent turn events, and emit terminal.meta.updated." Each of the three outcomes now exists via the restart-resilience campaign's **disk-based** machinery (locator + ledger + activity lane), which works with the flag OFF and for which the proxy is irrelevant. The proxy's event stream is deliberately parked unconsumed (`launch_lifecycle.rs:373-375` `_events`, "Held (unconsumed) … for S5"). What S5 uniquely still owns:
- argv/behavior parity: `--remote` 4-tuple + `features.apps=false` (flag flip);
- proxy-only fidelity: fork-request rewrite, fs-changed repair triggers, in-band candidate capture (vs. disk polling);
- G-X0→G-X1 golden swap; DEV-0006 + DEV-0008 record closure;
- meta enrichment still missing everywhere (git fields, tokenUsage).
An S5 that re-implements binding/activity from proxy events as specced would create a **second identity writer**, violating the single-writer discipline established 07-26 (`4767b7ec` retired the candidate.persisted writer precisely to get to "exactly one writer owns codex identity facts"; misbind guards at `857c9d48`).

## F3. The "whole-or-not" DEV-0008 fence was overtaken in practice — and the deviation record is now stale
Spec §6: "NO partial DEV-0008 shipment… Slice 5 lands whole or not at all." In practice: a create-time `terminal.meta.updated` slice shipped 07-16, an association-time slice shipped 07-24/26, each with its own review trail (P0.3 plan; rollout-locator plan). `port/oracle/DEVIATIONS.md:588-653` (DEV-0008) still reads "rust emits NO terminal.meta.updated frames" / "open gap" — **contradicted by shipping code**; no closure_progress was appended (only DEV-0006 got one, dated 07-22). Whoever executes S5 should treat both the spec fence and the DEV-0008 record text as historical, not current.

## F4. Classification of the four "S5 follow-ups recorded from the S4 review"
1. **Spawn-helper unification — UNTOUCHED.** `freshell-freshagent/src/codex.rs::spawn_sidecar` (`codex.rs:1959`, 5 call sites) still carries its own spawn mechanics; `launch_lifecycle.rs:9-11` still says "a follow-up refactor points `codex.rs` here too." No commit since 07-22 touches this seam.
2. **Singleton vs DI — UNTOUCHED and further entrenched.** `CodexTerminalLaunchManager::global()` now has ~13 call sites (`terminal.rs:1135,1336,2333,2375,2926,2969,2980`; `terminal_tabs.rs:1298,1439,1548,1588`; `main.rs:1204`). Meanwhile the codebase built DI precedents S5 could reuse (`PaneIdentitySink`, `SessionIdentityLookup`, the spawn-gate set-once handle on `FreshAgentState` + boot assertion `ce88e23c`) — the pattern exists; the manager was never migrated.
3. **binding_reason consumer — UNTOUCHED, and arguably SUPERSEDED.** `binding_reason` (20 hits) and `get_codex_session_binding_reason` remain confined to `launch_plan.rs`; the only `sessionBindingReason` mention outside is a legacy-parity comment (`cli_launch.rs:84`). No Rust registry consumer exists. But identity binding is now owned by ledger binding rows + `adopt_codex_identity`, which have their own reason vocabulary (`RetiredReason::{Superseded,Closed,GcExpired}`, pending markers). S5 must decide whether a registry `sessionBindingReason` is still meaningful or whether the plan field should feed the ledger/adoption tail instead.
4. **Recovery re-plan-on-loss — UNTOUCHED at the sidecar layer, scope reshaped above it.** `launch_lifecycle.rs:30-36` still records the deferral. Since then, a terminal-level auto-resume orchestrator (`6379f24f`, `4b417ab0`, flap breaker `544901fa`, cancel `2edbbc9d`) respawns crashed agent terminals server-side. Sidecar-loss re-planning added by S5 must compose with (not race) auto-resume and the spawn gate.

## F5. The flag flip acquired a NEW documented precondition the spec doesn't know about
`D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` tripwire (`e2e9cbc3`, 07-29; markers at `launch_plan.rs:56-59` and the REST call site `terminal_tabs.rs:1271`): the managed-launch plan runs UNDER the shared WS+REST spawn permit, worst case ~226 s hold (5 attempts × 45 s `SIDECAR_START_BUDGET`), and the default flip "cannot ship without hitting this decision" (rest-spawn-gate.md:109-123). Also `f3cef839`: spawn-gate rejection must clean up codex/MCP side effects. S5's "flag default flips" step is therefore no longer a one-line change + golden swap.

## F6. Golden state: unchanged in substance, drifted in anchors
`g_x0_codex_shipped_deviation_shape_dev_0006` still pins the live path — now at `cli_launch_goldens.rs:738` (spec cites :623-650). G-X1 (:262) / G-X2 (:290) / G-W2 (:609) still pass as resolver goldens. No swap occurred; consistent with the flag still defaulting OFF. Spec's §7 index has drifted throughout (`terminal.rs` codex branch now ~:1038-1135 and :2005+, not :831-835).

## F7. The raw-resume follow-up was overtaken by sessionRef canonicalization
Spec follow-up: "consider aligning the WS path's raw-resume acceptance to the legacy reject." Instead the design moved to server-authoritative sessionRef: WS derives codex resume sessionRef-first with raw fallback (`136b9e94`; `terminal.rs:1172-1176`), guarded by D7 live-session refusal (`043a9340`), D8 per-sessionRef leases + `SESSION_RESERVED` (`88a33933`), and `SESSION_IDENTITY_MISMATCH` input bounces (`60281e25`). REST still hard-rejects raw codex resume (`terminal_tabs.rs:65,:130`) and EDEV-07 synthesizes sessionRef from canonical legacy ids. "Align to legacy" is no longer the frame — Rust intentionally exceeds legacy here, recorded as EDEVs.

## F8. S5's assumed substrate in freshell-codex was partially deleted as dead code
`35cf2864` (07-24) removed `default_durability_store_dir` / `DurabilityCandidate` (-114 lines in `freshell-codex/src/durability.rs`); `2a68d027` removed 447 lines of restore-decision machinery from `launch_plan.rs`. The spec's launch_lifecycle note "S5 swaps the recording for the real write" now points at a durability store whose exports no longer exist; the pane-identity ledger (in `freshell-ws`, planned to hoist for P1.13) is the incumbent durable store.

## F9. Net effect on S5 scope (what changed)
- **Shrunk:** durability binding, turn/activity events, and baseline meta.updated no longer need building — they exist, tested, flag-independent.
- **Changed shape:** S5 becomes (a) flag flip + `--remote`/`features.apps=false` parity + G-X0→G-X1 + DEV-0006/0008 record closure, (b) an explicit integration decision: proxy events → feed the EXISTING adoption tail/ledger (or justify discarding them), respecting single-writer, rebind (`previousSessionId`), leases, and misbind guards, (c) the D-C spawn-permit revisit, (d) optionally the still-missing meta enrichment (git/token fields) if parity demands it.
- **Grown risk surface:** any proxy-driven binding must not race the rollout locator, the fork-rebind lane (`dde20036`, `146c5c36`), or auto-resume respawn.

## F10. Documentation-vs-code verdict
- Spec §0/§2/§3/§6/§7: stale in the specific ways above (its S4 LANDED note remains accurate).
- DEV-0006 record: accurate but frozen at 07-22; its S5 sentence no longer describes the remaining work.
- DEV-0008 record: factually contradicted by shipping code; needs a closure_progress/amendment before S5 planning trusts it.
