# Wedged Agent Pane Backstop Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell detects wedged terminal-mode agent panes — running agent-mode terminals whose PTY output is a pure repaint loop (the eternal-spinner zombie class) — and surfaces a visible "Agent appears stuck" state with kill/restart actions, mirroring the existing freshcodex wedged-sidecar deadman UX.

### Explicit constraints
- Run the full the-usual workflow from an isolated worktree branched from origin/main; follow repo rules: red-green-refactor TDD, no production-server restarts, no PR creation without explicit user approval.
- Scope is the in-repo Freshell backstop only.
- The load-bearing stage must prove the detection-signal assumption: the DEV-0009 repaint-noise classifier classifies opencode TUI spinner/gradient frames as noise, leaving last_meaningful_activity_at stale while last_activity_at stays fresh on a wedged pane. If disproven, redesign the backstop's detection signal; do not repair the classifier or its fingerprint ring.
- Do not change the idle reaper's attached-terminal exemption (enforce_idle_kills keeps reaping detached terminals only).
- Do not fix the upstream opencode TUI defects — that is not the needed work.

### Accepted tradeoffs and residuals
- The upstream opencode TUI defects remain; the backstop detects and surfaces wedged panes rather than preventing them.
- Detection is threshold-based and heuristic; a legitimately very long quiet agent turn could look wedged. The backstop must not fabricate turn-complete events or otherwise alter non-wedged panes (mirrors the freshcodex deadman contract).

**Goal:** Flag agent-mode terminals that have produced no meaningful PTY output for a bounded window (attached or not), broadcast the flag, and render an amber "Agent appears stuck" card with restart/start-fresh actions on the pane — the terminal-mode twin of the freshcodex wedged-sidecar deadman.

**Architecture:** The DEV-0009 machinery already computes exactly the needed signal server-side: `ingest` refreshes `last_meaningful_activity_at` only when `NoiseScanner::observe` classifies a PTY frame as genuinely new (registry.rs:3437-3439), while pure spinner repaints leave it stale. A new registry sweep `enforce_stuck_detection` (mirroring `enforce_idle_kills`, but WITHOUT the detached-only exemption — attached panes are the target class) flags agent-mode Running rows whose meaningful clock is older than a 2-hour window, emitting transitions only on change. A `spawn_stuck_monitor` task in `freshell-ws` (the registry crate stays tokio-free) broadcasts a new additive `terminal.stuck` frame per transition and per fresh attach; the registry's `attach` also enqueues the frame to a subscriber attaching to an already-flagged row. The client folds `terminal.stuck` into `terminalLifecycleSlice` (per-paneId, resolved via `selectTabPaneByTerminalId`, the `terminal.idle` precedent), and `TerminalView` renders the stuck card for agent-mode running panes with two actions that kill the terminal (awaiting the correlated `terminal.killed` ack) and then re-drive the pane through the existing `resetPaneForReconcileCreate` respawn/fresh intents. Nothing ever fabricates `terminal.turn.complete` or `terminal.idle`; nothing kills automatically.

**Tech Stack:** Rust (freshell-terminal registry sweep, freshell-protocol additive message, freshell-ws monitor), TypeScript/React (Zod schema, Redux slice, presentational component), Vitest + Cargo tests, Playwright e2e.

## Global Constraints

- Work only in the run worktree `/home/dan/code/freshell/.worktrees/wedge-backstop` (branch `the-usual/wedge-backstop`, base_ref `855dae72`). Never touch the production server on port 3001 or its processes; never restart any server without explicit user approval. Tests boot their own scratch servers only.
- Red-green-refactor TDD for every task; never reduce or skip tests. Commit focused changes per task.
- TypeScript uses NodeNext/ESM: relative imports include `.js` extensions. Path aliases `@/` → `src/`, `@test/` → `test/`.
- A11y: the stuck card uses `role="alert"`, semantic `<button>`s, and non-empty accessible names (mirrors the freshcodex card, `FreshAgentView.tsx:3513-3538`).
- Broad/coordinated runs: set `FRESHELL_TEST_SUMMARY` to a human-meaningful reason; focused cargo/vitest selectors are fine to run directly (they are delegated, not coordinated). Use `npm run test:vitest -- run <path>` for Vitest; raw `npx vitest` is not a repo workflow.
- Do not modify `NoiseScanner`, `RECENT_FINGERPRINTS`, or the strip set (`idle_noise.rs`); do not modify `enforce_idle_kills`' eligibility rules (registry.rs:1215-1279). Additive-only changes to the reaper area.
- Wire-contract changes go through the frozen-route pattern: extend `ServerMessage` + `SERVER_MESSAGE_TYPES`, run `npm run contract:generate`, keep `test/unit/port/ws-contract-freeze.test.ts` green (the `terminal.idle` precedent, server_messages.rs:520-531, `SESSION` docs).
- Before running e2e: `FRESHELL_E2E_BACKEND` must be set or the user must be asked (cloud ~2-3 min, ~$0.03/run vs local ~28 min). Record the answer; do not silently pick a paid lane.
- Update `docs/index.html` (nonfunctional mock) for the new user-facing card.
- Full-suite gate (per usual-executing-plans) runs once after all tasks: coordinated `npm test` with `FRESHELL_TEST_SUMMARY=the-usual wedge-backstop full-suite gate`, green excluding ledger-recorded pre-existing failures (baseline ledger: none).

---

### Task 1: Registry stuck sweep + real-frame noise fixture

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (state field ~line 241 area; threshold field ~line 615 area; consts ~line 1189 area; sweep function near `enforce_idle_kills` ~line 1280; tests ~line 5700)
- Test: `crates/freshell-terminal/src/registry.rs` (in-file `#[cfg(test)]` module)
- Test: `crates/freshell-terminal/src/idle_noise.rs` (in-file tests, ~line 385)

**Interfaces:**
- Consumes: existing `TerminalShared` clocks (`last_activity_at` registry.rs:233, `last_meaningful_activity_at` registry.rs:241), `is_agent_mode` (registry.rs:1176-1181), `now_ms()` (registry.rs:122-124), `NoiseScanner::observe` (idle_noise.rs:126-197), test helpers `insert_headless`/`feed`/`backdate_last_activity` (registry.rs:4080-4133).
- Produces:
  - `pub const DEFAULT_STUCK_WINDOW_MS: i64 = 7_200_000;`
  - `TerminalShared.stuck_since: Option<i64>` (pub(crate))
  - `TerminalRegistry.stuck_window_ms: Arc<AtomicI64>` + `pub fn stuck_window_ms(&self) -> i64` + `pub fn set_stuck_window_ms(&self, v: i64)`
  - `pub struct StuckTransition { pub terminal_id: String, pub mode: String, pub stuck: bool, pub at: i64 }`
  - `pub fn enforce_stuck_detection(&self) -> Vec<StuckTransition>`

- [ ] **Step 1: Write the failing behavioral tests**

In `registry.rs`'s test module (mirroring the `enforce_idle_kills_*` suite at 5320-5700; reuse the same row-construction pattern as `enforce_idle_kills_spares_agent_mode_terminals_past_threshold` at 5414-5445 for agent-mode rows and `enforce_idle_kills_never_kills_an_attached_terminal` at 5365-5381 for attached rows):

```rust
const STUCK_TEST_WINDOW_MS: i64 = 100;

fn stuck_test_registry(mode: &str) -> TerminalRegistry {
    let reg = // mirror the agent-mode row construction from the 5414 test,
              // insert_headless with mode set the same way that test does
    reg.set_stuck_window_ms(STUCK_TEST_WINDOW_MS);
    reg
}

#[test]
fn stuck_detection_flags_attached_agent_pane_with_only_repaint_noise() {
    let reg = stuck_test_registry("opencode");
    // Attach a subscriber FIRST — the deliberate divergence from the idle
    // reaper: attached panes are the primary target class (the reaper
    // exempts them by design, registry.rs:1232).
    attach_test_subscriber(&reg, "T"); // mirror the 5365 test's attach helper
    // Warm the fingerprint ring, then backdate BOTH clocks past the window.
    reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
    reg.backdate_last_activity("T", now-ish minus window+1); // mirror 5383 test
    // Repaint-only output keeps last_activity_at fresh; the meaningful
    // clock stays stale.
    for (i, glyph) in ["⠙","⠹","⠸","⠼"].iter().enumerate() {
        reg.feed("T", frame(2 + i as i64, &format!("\r\x1b[2K{glyph} ({}s • esc to interrupt)", i+2), "S"));
    }
    let transitions = reg.enforce_stuck_detection();
    assert_eq!(transitions.len(), 1);
    assert!(transitions[0].stuck);
    assert_eq!(transitions[0].terminal_id, "T");
    assert_eq!(transitions[0].mode, "opencode");
    // Idempotent: a second sweep emits no transition.
    assert!(reg.enforce_stuck_detection().is_empty());
}

#[test]
fn stuck_detection_clears_on_meaningful_output() {
    let reg = stuck_test_registry("opencode");
    reg.backdate_last_activity("T", /* window+1 ago */);
    let t = reg.enforce_stuck_detection();
    assert_eq!(t.len(), 1);
    assert!(t[0].stuck);
    // Genuinely-new content refreshes the meaningful clock (ingest path).
    reg.feed("T", frame(9, "meaningful new text line\n", "S"));
    let cleared = reg.enforce_stuck_detection();
    assert_eq!(cleared.len(), 1);
    assert!(!cleared[0].stuck);
}

#[test]
fn stuck_detection_clears_on_user_input() {
    // Input bumps BOTH clocks (registry.rs:1818-1820).
    let reg = stuck_test_registry("opencode");
    reg.backdate_last_activity("T", /* window+1 ago */);
    reg.enforce_stuck_detection();
    reg.input("T", b"x").unwrap_or_else(|e| panic!("{e:?}"));
    let cleared = reg.enforce_stuck_detection();
    assert_eq!(cleared.len(), 1);
    assert!(!cleared[0].stuck);
}

#[test]
fn stuck_detection_ignores_shell_mode_and_exited_rows_and_under_window() {
    // shell-mode row past the window → no transition.
    // agent-mode row under the window → no transition.
    // agent-mode row with status != Running → no transition (mirror how
    // the 5320 suite forces an Exited row; e.g. finish_pty_exit or the
    // headless exit helper used by the exit-path tests).
}

#[test]
fn stuck_detection_disabled_when_window_zero_or_negative() {
    let reg = stuck_test_registry("opencode");
    reg.set_stuck_window_ms(0);
    reg.backdate_last_activity("T", /* far past */);
    assert!(reg.enforce_stuck_detection().is_empty());
}
```

In `idle_noise.rs` tests — the real-opencode-TUI fixture pin (data from the 2026-09-20 real capture analyzed in `plan-frame-evidence.md`: an 8-cell gradient bar of `⬝` U+2B1D / `■` U+25A0 cycling through exactly 14 distinct compositions per 52-frame sweep, colors varying per frame but riding CSI sequences, plus a braille spinner cell):

```rust
#[test]
fn opencode_tui_gradient_bar_spinner_cycle_is_noise_after_first_sweep() {
    // REAL opencode TUI animation shape (capture of 2026-09-20, plan-frame-
    // evidence.md §3.2): each repaint unit hides the cursor, repaints the
    // 8-cell bar at row 38 cols 4-11 with per-cell SGR colors, and parks the
    // cursor. ■ U+25A0 / ⬝ U+2B1D are NOT in the strip set — they are the
    // only significant chars. The sweep walks 14 distinct compositions
    // (bright-segment position 1..8, then the reverse fade), so after the
    // first ~30 frames the ring holds every composition and all later
    // frames classify as noise forever.
    let dim = "\u{1b}[38;2;36;57;86m\u{1b}[48;2;10;10;10m";
    let bright = "\u{1b}[38;2;92;156;245m\u{1b}[48;2;10;10;10m";
    let park = "\u{1b}[0m\u{1b}[0m\u{1b}[34;6H\u{1b}[?25h";
    let unit = |cells: &str| format!("\u{1b}[?25l\u{1b}[38;4H{cells}{park}");
    // 14 compositions: n ⬝ then 8-n ■, then the reverse walk (per the capture
    // census at plan-frame-evidence.md §3.2).
    let compositions: Vec<String> = (0..8)
        .map(|n| format!("{dim}{}\u{1b}[0m{bright}{}", "⬝".repeat(n), "■".repeat(8 - n)))
        .chain((1..7).map(|n| format!("{bright}{}\u{1b}[0m{dim}{}", "■".repeat(n), "⬝".repeat(8 - n))))
        .map(|cells| unit(&cells))
        .collect();
    assert_eq!(compositions.len(), 14);
    let mut n = NoiseScanner::new();
    // First sweep: each distinct composition is new content (fail-open).
    for c in &compositions { n.observe(c); }
    // Spinner-only unit (braille glyph, zero significant chars) is noise even
    // the first time — registry.rs:185-186 count==0 path.
    assert!(!n.observe("\u{1b}[?25l\u{1b}[6;6H\u{1b}[38;2;128;128;128m\u{1b}[48;2;10;10;10m⠦\u{1b}[0m\u{1b}[0m\u{1b}[34;6H\u{1b}[?25h"));
    // Many later sweeps — colors change each frame (new SGR params), the
    // significant content does not — all noise.
    for cycle in 0..20 {
        for c in &compositions {
            let recolored = c.replace("92;156;245", &format!("{};156;245", 92 - (cycle % 5)));
            assert!(!n.observe(&recolored), "cycle {cycle} must be noise");
        }
    }
    // Genuinely-new text still classifies as meaningful.
    assert!(n.observe("\u{1b}[?25lquestion is moot. Run task 3 of 4 froze at 18:06:47Z"));
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-terminal stuck_detection 2>&1 | tail -20` and `cargo test -p freshell-terminal opencode_tui 2>&1 | tail -20`

Expected: FAIL — `stuck_detection_*` tests fail to compile (`enforce_stuck_detection`, `StuckTransition`, `set_stuck_window_ms` do not exist); the `opencode_tui` fixture test compiles and FAILS only if it mis-models the strip set (it should pass immediately against the existing scanner — it is a signal PIN, not new behavior; if it fails, the fixture is wrong, not the scanner).

- [ ] **Step 3: Add the minimal production implementation**

In `registry.rs`:

```rust
/// Stuck-pane detection window: an agent-mode terminal whose PTY produced no
/// MEANINGFUL output for this long is flagged `stuck` — surfaced to the pane
/// as the "Agent appears stuck" card, NEVER auto-killed. Attached panes are
/// the primary class (the idle reaper deliberately exempts them,
/// registry.rs:1232) — this sweep has NO subscribers exemption. The
/// terminal-mode analogue of the freshcodex quiet deadman
/// (FRESHELL_FRESHCODEX_QUIET_WINDOW_MS, codex.rs:113-142) but keyed on the
/// DEV-0009 meaningful clock because a wedged agent TUI (e.g. opencode
/// resumed onto an aborted session rendering an eternal spinner) keeps
/// repainting: only the noise classifier distinguishes it from progress.
/// 2h default: far above normal long-turn/LLM-thinking silence, well below
/// the observed 2-day zombie. Seeded from FRESHELL_TERMINAL_STUCK_WINDOW_MS
/// by freshell-server main; 0/negative disables.
pub const DEFAULT_STUCK_WINDOW_MS: i64 = 7_200_000;
```

On `TerminalShared` (after `last_meaningful_activity_at`, ~line 241):
```rust
/// Set (epoch ms) while `enforce_stuck_detection` flags this row stuck;
/// cleared by the first meaningful activity. Surface-only state.
pub stuck_since: Option<i64>,
```

On `TerminalRegistry` (near `auto_kill_idle_minutes`, ~line 615, seeded in `new()`):
```rust
stuck_window_ms: Arc<AtomicI64>,
```
with getter/setter mirroring `auto_kill_idle_minutes` (registry.rs:1105-1113).

The sweep (placed directly after `enforce_idle_kills`, ~line 1280; mutation discipline per LB-3: mirror `enforce_idle_kills`' two-pass collect-then-apply — collect transitions during the registry-inner + per-row-lock walk (registry.rs:1222-1264), writing `stuck_since` under the same row lock in-walk or in a second re-lock pass over the same `Arc<Mutex<TerminalShared>>` rows; both shapes verified implementable; nothing is deferred because no kill happens). Log every transition in the house structured style, mirroring the freshcodex deadman's `phase=` lines (codex.rs:6487-6488):

```rust
// on stuck:true  → tracing::warn!(component="terminal-registry",
//     event="terminal_stuck_flagged", terminal_id, mode,
//     meaningful_idle_ms, "agent pane flagged stuck; surfacing to pane");
// on stuck:false → tracing::info!(component="terminal-registry",
//     event="terminal_stuck_cleared", terminal_id, mode,
//     "meaningful activity resumed; stuck flag cleared");
```

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct StuckTransition {
    pub terminal_id: String,
    pub mode: String,
    pub stuck: bool,
    pub at: i64,
}

/// Flag/unflag agent-mode RUNNING terminals whose MEANINGFUL clock went
/// stale past the stuck window. Emits transitions ONLY on state change
/// (stuck:false→true and true→false); never kills, never emits a
/// turn-complete, and unlike `enforce_idle_kills` does NOT exempt attached
/// terminals — an attached wedged pane is the primary failure class this
/// sweep exists for (see the 2026-09-18 opencode zombie RCA).
pub fn enforce_stuck_detection(&self) -> Vec<StuckTransition> {
    let window = self.stuck_window_ms();
    if window <= 0 { return Vec::new(); }
    let now = now_ms();
    let mut transitions = Vec::new();
    // Walk rows with the same locking pattern enforce_idle_kills uses;
    // for each row:
    //   should = s.status == Running && is_agent_mode(&s.mode)
    //            && (now - s.last_meaningful_activity_at) > window;
    //   match (s.stuck_since.is_some(), should) {
    //     (false, true) => { s.stuck_since = Some(now);
    //                       transitions.push(StuckTransition{ stuck: true, ..now }) }
    //     (true, false) => { s.stuck_since = None;
    //                       transitions.push(StuckTransition{ stuck: false, ..now }) }
    //     _ => {}
    //   }
    transitions
}
```

Note `is_agent_mode` is a private fn in the same file — call it directly. Do NOT touch `enforce_idle_kills` or `idle_noise.rs`. The predicate is MEANINGFUL-staleness ALONE — deliberately no `last_activity_at` freshness requirement (LB-2: the actual zombie's `lastActivityAt` was still FRESH on day 2 per the investigation's debug dump, while frozen-output wedges would keep it stale; staleness-alone fires under every observed reading) — and deliberately NO busy/turn-in-flight gate (the zombie class attaches to aborted sessions with no reliable turn state; a busy gate would produce false negatives on exactly the target class; idle-quiet false positives are the user-accepted tradeoff).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-terminal stuck_detection 2>&1 | tail -5` and `cargo test -p freshell-terminal opencode_tui 2>&1 | tail -5`

Expected: PASS (all new tests green).

- [ ] **Step 5: Refactor while green**

Extract any shared row-walk helper between the two sweeps ONLY if the shape is genuinely identical; otherwise leave two explicit functions (the eligibility predicates differ — subscribers exemption vs none — so explicit is likely clearer). State which in the commit message.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole `freshell-terminal` crate (registry + noise + existing idle-kill suite — the sweep shares their state).

Run: `cargo test -p freshell-terminal 2>&1 | tail -5`

Expected: PASS (zero failures; pre-existing suite untouched).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-terminal/src/registry.rs crates/freshell-terminal/src/idle_noise.rs
git commit -m "feat(terminal): registry stuck sweep flags agent panes past meaningful-idle window"
```

---

### Task 2: Wire contract — additive `terminal.stuck` message

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (enum ~line 126 area after `terminal.status`; consts ~line 183; struct near `TerminalIdle` ~line 527)
- Modify: `port/contract/ws-server-messages.schema.json` + `port/contract/ws-message-inventory.json` (via the generator — never by hand)
- Modify: `shared/ws-protocol.ts` (Zod schema near `TerminalIdleSchema` line 351; ServerMessage union member near the `terminal.idle` member ~line 1650s)
- Test: `test/unit/client/lib/terminal-stuck-ws.test.ts` (new) and the contract freeze suite

**Interfaces:**
- Consumes: Task 1's `StuckTransition` (field names; the wire struct carries the same facts).
- Produces:
  - Rust: `ServerMessage::TerminalStuck(TerminalStuck)`, `#[serde(rename_all = "camelCase")] pub struct TerminalStuck { pub terminal_id: String, pub at: i64, pub stuck: bool }`, `"terminal.stuck"` in `SERVER_MESSAGE_TYPES`.
  - TS: `TerminalStuckSchema` and the `ServerMessage` union member `{ type: 'terminal.stuck'; terminalId: string; at: number; stuck: boolean }`.

- [ ] **Step 1: Write the failing test**

`test/unit/client/lib/terminal-stuck-ws.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TerminalStuckSchema } from '@shared/ws-protocol'

describe('terminal.stuck wire contract', () => {
  it('accepts a stuck transition frame', () => {
    const frame = { type: 'terminal.stuck' as const, terminalId: 't-1', at: 1789947521195, stuck: true }
    expect(TerminalStuckSchema.parse(frame)).toEqual(frame)
  })
  it('accepts the unstuck transition and rejects wrong shapes', () => {
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1, stuck: false }).success).toBe(true)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.stuck', terminalId: 't-1', at: 1 }).success).toBe(false)
    expect(TerminalStuckSchema.safeParse({ type: 'terminal.idle', terminalId: 't-1', at: 1, stuck: true }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-stuck-ws.test.ts 2>&1 | tail -10`

Expected: FAIL — `TerminalStuckSchema` is not exported from `@shared/ws-protocol`.

- [ ] **Step 3: Add the minimal production implementation**

`server_messages.rs` — variant (alphabetical position near `terminal.status`, mirroring the `terminal.idle` comment style):

```rust
// Extension surface (wedge-backstop run, not in the frozen T0 inventory):
// the terminal-mode stuck edge — `{ terminalId, at, stuck }`, emitted ONCE
// per stuck/unstuck transition by the stuck monitor, and once to a
// freshly attaching subscriber while the row is flagged. The
// terminal-mode analogue of freshcodex's `freshAgent.status:"stuck"` —
// never a `terminal.turn.complete` fabrication. See
// [`TerminalStuck`] and `spawn_stuck_monitor`.
#[serde(rename = "terminal.stuck")]
TerminalStuck(TerminalStuck),
```

Struct (near `TerminalIdle`, server_messages.rs:527-531):

```rust
/// `terminal.stuck` — the agent-pane wedged flag (surface-only; the client
/// renders the "Agent appears stuck" card from it and offers kill/restart).
/// Pinned wire contract: `port/contract/ws-server-messages.schema.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStuck {
    pub terminal_id: String,
    pub at: i64,
    pub stuck: bool,
}
```

Add `"terminal.stuck"` to `SERVER_MESSAGE_TYPES` (update the array length `65` → `66` and the header count comment).

`shared/ws-protocol.ts` — near `TerminalIdleSchema` (line 351):

```ts
/**
 * `terminal.stuck` — the terminal-mode wedged-agent flag, emitted once per
 * stuck/unstuck transition (and to fresh subscribers while flagged).
 * Drives the pane's "Agent appears stuck" card; never a completion edge.
 */
export const TerminalStuckSchema = z.object({
  type: z.literal('terminal.stuck'),
  terminalId: z.string(),
  at: z.number(),
  stuck: z.boolean(),
})
```

and the plain-TS member in the `ServerMessage` union next to the `terminal.idle` member, with doc comment mirroring its style. Regenerate the contract files, then update ALL same-commit pins (LB-11 checklist — all verified to exist):
- `SERVER_MESSAGE_TYPES` length `65` → `66` (server_messages.rs:183).
- `crates/freshell-protocol/tests/inventory.rs:56` (`len() == 65` → `66`), `:66` (`all.len() == 106` → `107`), AND `:51` (`Some(65)` → `Some(66)`).
- `test/unit/port/ws-contract-freeze.test.ts` `ZOD_BACKED_SERVER_MESSAGES` gains `'terminal.stuck'` (the Zod-required vs TS-required field cross-check in generate-ws-contract.ts:616-641 must agree: `terminalId`, `at`, `stuck` all required on both sides).

Run: `npm run contract:generate`

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-stuck-ws.test.ts test/unit/port/ws-contract-freeze.test.ts 2>&1 | tail -8` and `cargo test -p freshell-protocol 2>&1 | tail -5`

Expected: PASS — new schema test green, freeze test green (regenerated files match source), protocol crate green (any existing discriminant-count tests updated by the new variant stay green — if a count-pinning test exists, update it in the same commit as an intended contract change).

- [ ] **Step 5: Refactor while green**

None expected — additive declarations only.

- [ ] **Step 6: Run impacted-test verification**

Impacted: protocol crate tests, contract freeze suite, and any client suites enumerating ServerMessage types.

Run: `cargo test -p freshell-protocol 2>&1 | tail -3` and `npm run test:vitest -- run test/unit/port/ test/unit/client/lib/fresh-agent-ws.test.ts 2>&1 | tail -5`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/server_messages.rs shared/ws-protocol.ts port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json
git commit -m "feat(protocol): additive terminal.stuck server message (wedge-backstop)"
```

---

### Task 3: Stuck monitor driver, boot wiring, attach emission

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (after `spawn_idle_monitor`, ~line 533)
- Modify: `crates/freshell-server/src/main.rs` (~lines 1131-1145 idle-monitor wiring area)
- Modify: `crates/freshell-terminal/src/registry.rs` (`attach` — enqueue stuck frame to new subscribers; ~lines 1509-1734)
- Test: `crates/freshell-ws/tests/terminal_stuck_monitor.rs` (new integration test)

**Interfaces:**
- Consumes: Task 1's `enforce_stuck_detection`/`StuckTransition`/`stuck_window_ms` setter; Task 2's `ServerMessage::TerminalStuck`.
- Produces:
  - `freshell_ws::broadcast_stuck_transitions(registry: &TerminalRegistry, broadcast_tx: &tokio::sync::broadcast::Sender<String>)` (testable tick body)
  - `freshell_ws::spawn_stuck_monitor(registry: TerminalRegistry, broadcast_tx: broadcast::Sender<String>, sweep_interval: Duration)`
  - `freshell_ws::stuck_window_ms_from_env() -> i64` (parses `FRESHELL_TERMINAL_STUCK_WINDOW_MS`, else `DEFAULT_STUCK_WINDOW_MS`)
  - Registry `attach` enqueues `ServerMessage::TerminalStuck{stuck: true}` to a subscriber attaching to a flagged row.

- [ ] **Step 1: Write the failing integration test**

`crates/freshell-ws/tests/terminal_stuck_monitor.rs` (mirror the harness style of `crates/freshell-ws/tests/pane_reconcile.rs` — headless rows via its `headless` helper at 284-295; broadcast channel subscription). NOTE (LB-13): the registry crate's `feed`/`insert_headless`/`backdate_last_activity` helpers are `#[cfg(test)]`-gated and NOT exported cross-crate — drive the sweep from ws tests with the PUBLIC API only: `register_headless` with a PAST `created_at` (registry.rs:2294 — `last_meaningful_activity_at` inits to `created_at`, so a row created "window+1 ago" is immediately flaggable) to FLAG, and `registry.input` (registry.rs:1802-1836 — bumps BOTH clocks even for headless rows) to CLEAR:

```rust
// RED: broadcast_stuck_transitions does not exist yet.
#[test]
fn stuck_monitor_broadcasts_transitions_only_on_change() {
    let registry = // register_headless agent-mode row "T" with created_at = now - (window+1)
                    // (mirror pane_reconcile.rs:284-295), set_stuck_window_ms(1);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    broadcast_stuck_transitions(&registry, &tx);
    let first = rx.try_recv().unwrap();
    assert!(first.contains("\"type\":\"terminal.stuck\""));
    assert!(first.contains("\"stuck\":true"));
    assert!(first.contains("\"terminalId\":\"T\""));
    // Second tick with no state change: nothing new.
    broadcast_stuck_transitions(&registry, &tx);
    assert!(rx.try_recv().is_err());
    // Meaningful output clears: stuck:false transition broadcast.
    registry.input("T", b"x").unwrap(); // bumps BOTH clocks (registry.rs:1818-1820)
    broadcast_stuck_transitions(&registry, &tx);
    let clear = rx.try_recv().unwrap();
    assert!(clear.contains("\"stuck\":false"));
}

#[test]
fn attaching_to_a_stuck_row_enqueues_the_stuck_frame_to_the_new_subscriber() {
    // Flag the row (as above), then registry.attach with a captured FrameSink
    // (registry.rs:71 Arc<dyn Fn(ServerMessage)>); assert the sink observed
    // TerminalStuck{ stuck: true } AFTER attach.ready/replay and BEFORE the
    // Exited block (LB-12 insertion point: registry.rs:1709-1721, inside
    // attach_to_shared's single-lock handoff; mirror the collector-sink
    // precedent at registry.rs:5369-5371).
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test terminal_stuck_monitor 2>&1 | tail -10`

Expected: FAIL — `broadcast_stuck_transitions` not found (compile error) is the intended missing-behavior failure.

- [ ] **Step 3: Add the minimal production implementation**

`freshell-ws/src/lib.rs` (after `spawn_idle_monitor`, mirroring its doc style):

```rust
/// Tick body of [`spawn_stuck_monitor`]: run the registry's stuck sweep and
/// broadcast one `terminal.stuck` frame per transition. Factored out so
/// tests can drive a single tick without a timer.
pub fn broadcast_stuck_transitions(
    registry: &freshell_terminal::TerminalRegistry,
    broadcast_tx: &tokio::sync::broadcast::Sender<String>,
) {
    for t in registry.enforce_stuck_detection() {
        let msg = freshell_protocol::ServerMessage::TerminalStuck(
            freshell_protocol::TerminalStuck {
                terminal_id: t.terminal_id.clone(),
                at: t.at,
                stuck: t.stuck,
            },
        );
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = broadcast_tx.send(json);
        }
    }
}

/// Start the wedged-agent-pane monitor (the terminal-mode analogue of the
/// freshcodex quiet deadman): periodic `enforce_stuck_detection` sweep whose
/// transitions broadcast `terminal.stuck` to every authenticated client.
/// Same cadence contract as [`spawn_idle_monitor`]; surface-only — nothing
/// is killed here.
pub fn spawn_stuck_monitor(
    registry: freshell_terminal::TerminalRegistry,
    broadcast_tx: tokio::sync::broadcast::Sender<String>,
    sweep_interval: std::time::Duration,
) {
    spawn_periodic(sweep_interval, move || {
        broadcast_stuck_transitions(&registry, &broadcast_tx);
    });
}

/// `FRESHELL_TERMINAL_STUCK_WINDOW_MS` override for the stuck window
/// (positive int ms); else `DEFAULT_STUCK_WINDOW_MS`. Mirrors the freshcodex
/// `FRESHELL_FRESHCODEX_QUIET_WINDOW_MS` env contract (codex.rs:134-142).
pub fn stuck_window_ms_from_env() -> i64 { /* parse std::env, default DEFAULT_STUCK_WINDOW_MS */ }
```

`main.rs` (next to the idle-monitor wiring, 1131-1145):

```rust
registry.set_stuck_window_ms(freshell_ws::stuck_window_ms_from_env());
// reuse the same 30s/250ms sweep_interval expression used for the idle
// monitor at 1140-1144:
freshell_ws::spawn_stuck_monitor(registry.clone(), state.broadcast_tx.clone().subscribe? /* the WsState broadcast sender */, stuck_sweep_interval);
```
(Use the same broadcast sender handle `auto_resume`'s `broadcast_frame` sends on — `WsState.broadcast_tx`, main.rs:1875 area. Confirm the exact clone type from `broadcast_settled_frame`'s usage, auto_resume.rs:1375-1406.)

`registry.rs` `attach` (~1509-1734), inside `attach_to_shared`'s single-lock handoff — insertion point per LB-12: AFTER the replay enqueue block and BEFORE the Exited block (registry.rs:1709-1721), preserving the ready < modes.sync < replay < live ordering invariant (1663-1666):

```rust
if s.stuck_since.is_some() {
    let frame = ServerMessage::TerminalStuck(TerminalStuck {
        terminal_id: s.terminal_id.clone(),
        at: s.stuck_since.unwrap_or_default(),
        stuck: true,
    });
    // enqueue to the NEW subscriber's sink only (not the broadcast), so a
    // reconnecting client learns the row is flagged. Repeated keepalive
    // re-attach re-sends the frame; the client fold is idempotent (sets a
    // keyed value), so this is harmless.
    (sink)(frame);
}
```
(`spawn_stuck_monitor` signature per LB-4: takes `Arc<tokio::sync::broadcast::Sender<String>>` — the exact type main.rs:916 creates and WsState.broadcast_tx holds (freshell-ws/src/lib.rs:162); wire with `Arc::clone(&broadcast_tx)` next to the idle-monitor spawn.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test terminal_stuck_monitor 2>&1 | tail -5`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If `broadcast_stuck_transitions` and `auto_resume::broadcast_frame` share a serialize-and-send helper worth extracting, extract a tiny `fn broadcast_server_message(tx, msg)` in `freshell-ws`; otherwise leave as-is (two-line duplication is acceptable across modules).

- [ ] **Step 6: Run impacted-test verification**

Impacted: freshell-ws suite + freshell-terminal suite (attach changed) + freshell-server compile (main wiring).

Run: `cargo test -p freshell-ws -p freshell-terminal 2>&1 | tail -5` and `cargo check -p freshell-server 2>&1 | tail -3`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/lib.rs crates/freshell-server/src/main.rs crates/freshell-terminal/src/registry.rs crates/freshell-ws/tests/terminal_stuck_monitor.rs
git commit -m "feat(ws): spawn_stuck_monitor broadcasts terminal.stuck transitions; attach replays stuck flag"
```

---

### Task 4: Client fold, stuck store, card, and actions

**Files:**
- Modify: `src/store/terminalLifecycleSlice.ts` (state + reducers)
- Modify: `src/store/turnCompletionThunks.ts` (or sibling location of `applyServerIdle`, ~line 22-36) — `applyTerminalStuck` thunk
- Modify: `src/App.tsx` (WS fold case near the `terminal.idle` case, 1678-1685)
- Create: `src/components/TerminalStuckCard.tsx`
- Modify: `src/components/TerminalView.tsx` (render + handlers + the created-fold clear-on-adoption dispatch, near the exit-banner block 5831-6140)
- Test: `test/unit/client/lib/terminal-stuck-ws.test.ts` (extend: fold tests), `test/unit/client/store/terminalLifecycleSlice` tests (extend or new), `test/unit/client/components/TerminalStuckCard.test.tsx` (new), `test/unit/client/components/TerminalView.stuckCard.test.tsx` (new, mirroring `TerminalView.exitBanner.test.tsx` harness)

**Interfaces:**
- Consumes: Task 2's `TerminalStuckSchema`/union member; existing `selectTabPaneByTerminalId` (`src/store/selectors/paneTerminalSelectors.ts:52`), `resetPaneForReconcileCreate` (`src/store/panesSlice.ts:2409-2475`), `sendTerminalKillAndAwait` (`src/lib/kill-ack.ts:116-173` — LB-6: REUSE this existing helper; do NOT add a new one; opts `createRequestId?/timeoutMs?/send?/observedEpoch?/observedGeneration?`, returns `KillAck = { ok: true } | { ok: false; error?; timedOut? }`; use the `send` opt in tests' ws-spy harnesses), `resolveTerminalKillFence` (`src/lib/terminal-kill.ts`), the `terminal.killed` correlated ack fold (`TerminalView.tsx:5032-5050`).
- Produces:
  - `terminalLifecycleSlice` state: `stuckAtByPaneId: Record<string, { at: number; terminalId: string }>` (LB-8: store the flagged terminalId WITH the entry — terminalId churn happens exactly on kill/respawn/replacement, which is when a prior flag is stale); reducers `recordTerminalStuck({paneId, terminalId, at})`, `clearTerminalStuck({paneId})`, and `clearTerminalStuckIfOtherTerminal({paneId, terminalId})` (delete the entry only when `stuck.terminalId !== payload.terminalId`); `recordTerminalExit`, `clearTerminalLifecycle`, and `foldTerminalReplacement` also delete/clear the pane's stuck entry (one-line belts; `foldTerminalReplacement` keys the clear on `newTerminalId`).
  - `applyTerminalStuck` thunk: parse with `TerminalStuckSchema`, resolve pane via `selectTabPaneByTerminalId`, dispatch record/clear. NEVER dispatches `turnCompletion/*`.
  - `TerminalStuckCard` presentational component: props `{ mode: string; onRestart: () => void; onStartFresh: () => void }`.
  - `TerminalView`: `restartStuckAgentPane()` (kill-await → `resetPaneForReconcileCreate({tabId, paneId, intent: 'respawn', sessionRef})`) and `startFreshFromStuckPane()` (kill-await → intent `'fresh'`), plus the render gate: `mode !== 'shell' && terminalContent.status === 'running' && stuckAtByPaneId[paneId] !== undefined`.
  - Clear-on-adoption call site (LB-8): in `TerminalView`'s `terminal.created` fold (4625-4777), immediately after the `updateContent({...})` dispatch ending at 4697: `dispatch(clearTerminalStuckIfOtherTerminal({ paneId: paneIdRef.current, terminalId: newId }))` — the flagged row is gone server-side (kill_internal removes it; a detached row has no subscriber to see the exit), so no `stuck:false` can ever arrive for it; a genuinely wedged replacement re-flags via the next sweep broadcast or the attach-time emission (self-healing, never flag-swallowing).

- [ ] **Step 1: Write the failing tests**

Store/fold tests (extend `test/unit/client/lib/terminal-stuck-ws.test.ts` from Task 2; mirror the harness of `fresh-agent-ws.test.ts:484-538` for the no-fabrication pin):

```ts
it('folds terminal.stuck true into stuckAtByPaneId for the owning pane and dispatches no turnCompletion action', async () => {
  // store with a terminal pane {terminalId: 't-1'}; spy on store.dispatch;
  // dispatch applyTerminalStuck({ type: 'terminal.stuck', terminalId: 't-1', at: 123, stuck: true });
  // expect state.terminalLifecycle.stuckAtByPaneId[paneId] === { at: 123, terminalId: 't-1' };
  // expect zero dispatched actions matching /turnCompletion\//.
})
it('folds terminal.stuck false by clearing the pane entry', async () => { /* ... */ })
it('ignores frames for unknown terminal ids (no pane resolution)', async () => { /* ... */ })
it('clearing terminal lifecycle (relaunch) drops the stuck entry', () => { /* dispatch clearTerminalLifecycle; expect gone */ })
it('adoption of a different terminalId clears a stale stuck entry and a re-flag re-records (self-healing pin)', () => {
  // seed recordTerminalStuck{paneId, terminalId:'T0', at}; dispatch the created
  // fold for T1 on the same paneId (or the clearTerminalStuckIfOtherTerminal
  // action) → entry gone; then drive a terminal.stuck{terminalId:'T1'} frame
  // → entry re-records under T1.
})
```

Component tests — `TerminalStuckCard.test.tsx` (pure presentational, mirror `TerminalExitBanner.test.tsx`):

```tsx
it('renders an alert with restart and start-fresh buttons', () => {
  render(<TerminalStuckCard mode="opencode" onRestart={vi.fn()} onStartFresh={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  expect(screen.getByRole('button', { name: /restart agent/i })).toBeTruthy()
  expect(screen.getByRole('button', { name: /start fresh conversation/i })).toBeTruthy()
})
it('invokes the callbacks', () => { /* click both */ })
```

`TerminalView.stuckCard.test.tsx` — the LB-7 both-orders matrix (the kill→ack→respawn composition has NO existing terminal-lane pin; server sends `terminal.exit` BEFORE the correlated `terminal.killed` — kill-ack.ts:33-52 — but the tests must drive BOTH orderings, plus the failure arms):

```tsx
// A (server order: exit → killed): click "Restart agent" →
//   A1. ws send called with terminal.kill carrying terminalId + fence pair
//   A2. drive terminal.exit for the live tid → pane content status 'exited',
//       exit record written (recordTerminalExit), stuck entry cleared
//   A3. drive terminal.killed{success:true} → no failure surface
//   A4. assert exactly ONE resetPaneForReconcileCreate to status 'creating'
//       with pendingReconcile 'respawn' + reconcileEpoch bumped (the
//       await-first discipline: the reset fires after the ack resolves)
//   then drive terminal.created for the new terminalId → status 'running',
//   clearTerminalStuckIfOtherTerminal fired for the stale flag.
// B (reversed: killed → exit): same assertions B1-B4 = A1-A4 — the killed
//   fold is silent on success and the exit fold matches the live tid; the
//   ref-sync effect (TerminalView.tsx:1287-1319) clears terminalIdRef after
//   the reset, so a later exit cannot double-consume.
// B' (same-tick hazard): drive exit + killed in the SAME act() batch; the
//   exit fold still writes 'exited' transiently but the post-ack reset is
//   the authoritative last writer — end state must converge to 'creating'.
// C (kill failure arms): terminal.killed{success:false} → NO reconcile
//   reset, pane keeps the card, failure notice logged; kill timeout → same.
// D (gate tests): shell-mode pane never renders the card; non-running
//   status never renders it; unstuck transition removes the card while the
//   terminal keeps running.
// E (advisory guard): restart bails when an opencode durable replacement is
//   in flight (pendingDurableReplacementRef set) — assert no kill is sent.
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-stuck-ws.test.ts test/unit/client/components/TerminalStuckCard.test.tsx test/unit/client/components/TerminalView.stuckCard.test.tsx 2>&1 | tail -12`

Expected: FAIL — `TerminalStuckCard` missing, `stuckAtByPaneId`/`recordTerminalStuck` missing, `applyTerminalStuck` missing (the intended missing-behavior failures, not harness syntax accidents).

- [ ] **Step 3: Add the minimal production implementation**

Implement each Produces item above. Key details:

- `TerminalStuckCard.tsx` (mirrors the freshcodex card, `FreshAgentView.tsx:3513-3538`):

```tsx
export function TerminalStuckCard({ mode, onRestart, onStartFresh }: Props) {
  return (
    <div role="alert" className="flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
      <span>Agent appears stuck — no agent output for a while.</span>
      <div className="flex gap-2">
        <button type="button" className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
          aria-label={`Restart the ${mode} agent and resume this conversation`} onClick={onRestart}>
          Restart agent
        </button>
        <button type="button" className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
          aria-label="Start a fresh conversation" onClick={onStartFresh}>
          Start fresh conversation
        </button>
      </div>
    </div>
  )
}
```

- `TerminalView` handlers (kill-await mirrors `sendFreshAgentKillAndAwait`'s bounded-wait shape):

```ts
const restartStuckAgentPane = useCallback(async () => {
  const tid = terminalIdRef.current
  if (!tid) return
  if (pendingDurableReplacementRef.current) return // advisory guard (LB-7 E)
  const fence = resolveTerminalKillFence(store, terminalContent)
  const ack = await sendTerminalKillAndAwait(tid, { ...fence }) // kill-ack.ts:116 — REUSE, do not add a new helper
  if (!ack.ok) {
    log.warn('terminal_stuck_restart_kill_failed', { terminalId: tid, ack })
    return // keep the card; the user can retry
  }
  dispatch(clearTerminalLifecycle({ paneId }))
  dispatch(resetPaneForReconcileCreate({ tabId, paneId, intent: 'respawn', sessionRef: terminalContent.sessionRef }))
}, [/* deps */])
// startFreshFromStuckPane: same kill-await, then intent 'fresh' (mirrors
// startFreshConversation, TerminalView.tsx:5917-5926).
// The await-first order is load-bearing: the reconcile reset must not fire
// before the correlated terminal.killed resolves (pinned by matrix A/B in the
// test step).
```

- Render: inside the banner block near the `TerminalExitBanner` render (6101-6140), gated as specified; the card sits ABOVE the xterm surface exactly as the exit banner does (same container/class structure).

- App fold (`src/App.tsx`, next to the `terminal.idle` case at 1678-1685): `case 'terminal.stuck': dispatch(applyTerminalStuck(msg)); break` — mirror the parse/validation discipline the `terminal.idle` case uses.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-stuck-ws.test.ts test/unit/client/components/TerminalStuckCard.test.tsx test/unit/client/components/TerminalView.stuckCard.test.tsx 2>&1 | tail -8`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected — the kill-await path REUSES `kill-ack.ts` wholesale (LB-6), so no duplicate helper should exist to merge. If the fold/thunk code duplicates `applyServerIdle`'s shape beyond the dispatch target, extract only if the two genuinely share a body.

- [ ] **Step 6: Run impacted-test verification**

Impacted: TerminalView suites (lifecycle/exitBanner/launchRetry), pane-activity pins, terminal-kill users (TabBar/BackgroundSessions), fresh-agent-ws folds.

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/lib/pane-activity.test.ts test/unit/client/components/TabBar.test.tsx test/unit/client/components/BackgroundSessions.test.tsx 2>&1 | tail -6` (adjust paths to the actual sibling suite names found in `test/unit/client/components/`)

Expected: PASS. Then `npm run typecheck:client 2>&1 | tail -3` — Expected: PASS (no-write check).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalStuckCard.tsx src/components/TerminalView.tsx src/store/terminalLifecycleSlice.ts src/store/turnCompletionThunks.ts src/App.tsx test/unit/client
git commit -m "feat(client): Agent-appears-stuck card for terminal-mode agent panes with kill+restart actions"
```

---

### Task 5: E2E coverage + docs + full-suite gate

**Files:**
- Create: `test/e2e-browser/specs/terminal-stuck-rust.spec.ts`
- Create: scratch fixture script written by the spec (fake `opencode` on PATH — no repo file)
- Modify: `docs/index.html` (stuck-card mock, mirroring the exit-banner mock if present)
- Modify: `README.md` (only if it enumerates pane indicators — check its features list first; end-user docs live only in README)
- Test: the new spec itself

**Interfaces:**
- Consumes: Task 3's `FRESHELL_TERMINAL_STUCK_WINDOW_MS` env + `FRESHELL_TEST_CLOCK` routing (registry `now_ms()` is platform-clock-routed, registry.rs:122-124; sweep interval drops to 250ms under the gate, main.rs:1136-1145; REST verbs `GET /api/test-clock` + `POST /api/test-clock/{advance,freeze,resume,reset}` behind `x-auth-token`, test_clock_router.rs) + Task 4's card/buttons; existing scratch-server boot helpers (mirror `agent-crash-autoresume-rust.spec.ts` boot flow at lines 211+ and cleanup discipline: `server.stop()` + `fs.rm(sharedRoot)` in `finally`).
- Produces: e2e proof of the user-visible story end to end.

**Fixture recipe (LB-9, verified):** do NOT bare-PATH-shim. `terminal.create{mode:'opencode'}` spawns the command resolved from the CliCommandSpec built from the builtin extension manifest (`crates/freshell-server/src/extensions.rs:311-386` — note: freshell-server crate, not freshell-ws), whose manifest declares `command: "opencode"`, `envVar: "OPENCODE_CMD"` — env override wins (`extensions.rs:188-222`). Follow the established recipe from `test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts:157-216`: install the fake CLI into the shared root, boot the scratch server with `OPENCODE_CMD` pointing at the ABSOLUTE shim path (via the RustServer fixture's `env` merge, rust-server.ts:285-286), and seed `enabledProviders` in the isolated HOME config so the picker creation flow accepts opencode panes. The shim emits the REAL animation shape from Task 1's fixture (cursor-hide + braille spinner + 8-cell gradient bar sweep, ~10 units/s, ignoring stdin).

**Cadence recipe (LB-10, verified):** use the HARNESS-14 test-clock recipe, NOT wall-clock bounds. Boot with `FRESHELL_TEST_CLOCK: '1'` (drops the stuck sweep to 250ms ticks; mounts the clock verbs) AND `FRESHELL_TERMINAL_STUCK_WINDOW_MS: '4000'`. Freeze-after-quiet discipline (harness-14-server-clock.spec.ts:137-146): the shim's real output must reach steady state (ring-warmed, ~3s) BEFORE freezing/advancing — frames landing after an advance re-stamp the meaningful clock at the advanced instant. Then `POST /api/test-clock/freeze`, `POST /api/test-clock/advance {"ms": 5000}` (window 4000 + 1000 margin). Expected flag latency after the advance: ≤ one 250ms sweep tick + broadcast + ws fold — poll for the alert with a ~5s bound. The kill/ack/created restart round runs on REAL ws time (unaffected by the virtual clock).

- [ ] **Step 1: Write the failing e2e spec**

`terminal-stuck-rust.spec.ts` — fake `opencode` shim (written into `sharedRoot/bin`, PATH-prepended) that emits the REAL animation shape from Task 1's fixture (cursor-hide + braille spinner + 8-cell gradient bar sweep, ~10 units/s, synchronized-update wrappers optional — plain writes suffice for the classifier; ignore stdin):

```ts
test.describe('terminal stuck backstop (rust only)', () => {
  test('wedged agent pane surfaces the stuck card, restart recovers it', async ({ page }) => {
    // boot scratch server with env { FRESHELL_TEST_CLOCK: '1',
    //   FRESHELL_TERMINAL_STUCK_WINDOW_MS: '4000', OPENCODE_CMD: <abs shim>,
    //   ...enabledProviders seed per the recipe }
    // create pane mode 'opencode' (fake shim); wait for terminal.created + buffer evidence
    // ring-warm in REAL time (~3s of shim animation; the meaningful clock keeps
    //   refreshing, so the card CANNOT appear): assert NO [role=alert] with
    //   /appears stuck/i during this phase (the false-start bound)
    // freeze-after-quiet: POST /api/test-clock/freeze; POST /api/test-clock/advance {"ms":5000}
    // poll (~5s bound): the alert appears; lifecycle stuck entry set
    // click "Restart agent"; the kill/ack/created round runs on REAL ws time;
    // assert pane status back to 'running' and alert count 0
  })
  test('a pane emitting meaningful output never shows the card', async ({ page }) => {
    // second shim variant printing distinct text lines every 250ms;
    // SAME warm-up + freeze + advance past the window, then assert NO alert
    // (the post-advance assertion is the load-bearing one — a fresh line
    // re-stamps the meaningful clock at the advanced instant)
  })
  test('unstuck transition removes the card while the terminal keeps running', async ({ page }) => {
    // third shim: spinner loop for ~6s, then switch to emitting meaningful lines;
    // card appears after the bound, then disappears on the next frames
  })
})
```

- [ ] **Step 2: Run the spec and verify the intended failure**

Run (after confirming `FRESHELL_E2E_BACKEND` is set, else ask the user first — see Global Constraints): `npm run test:e2e -- terminal-stuck-rust.spec.ts 2>&1 | tail -15`

Expected: FAIL before Tasks 3/4 behavior is fully wired — but since Tasks 3-4 already landed, the expected failure mode at RED time is either the spec's own fixture bugs (shim not spinning) or harness assertions (card absent). Verify it fails for the intended reason (missing user-visible behavior), not a boot/selector accident.

- [ ] **Step 3: Add the minimal production implementation**

If the spec fails on a genuine product gap, fix the product code per Tasks 3-4 interfaces. If it fails on the harness, fix the harness (shim PATH, selectors). Confirm the spec is NOT listed in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) so it runs on the configured backend.

- [ ] **Step 4: Run the focused spec**

Run: `npm run test:e2e -- terminal-stuck-rust.spec.ts 2>&1 | tail -8`

Expected: PASS (3 tests).

- [ ] **Step 5: Refactor while green**

Share the shim-emitter snippet between the three tests via one helper in the spec file; keep frames byte-faithful to the Task 1 fixture shapes.

- [ ] **Step 6: Run impacted-test verification + docs**

- Add the stuck-card mock to `docs/index.html` (search for the exit-banner/dead-pane mock area and mirror its structure).
- README: only add a sentence if the README already enumerates pane status UX features; do not create new doc files.
- Full-suite gate (coordinated, once, after all tasks): `FRESHELL_TEST_SUMMARY='the-usual wedge-backstop full-suite gate' npm test`

Expected: PASS green excluding baseline-ledger pre-existing failures (none recorded).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/terminal-stuck-rust.spec.ts docs/index.html README.md
git commit -m "test(e2e): terminal stuck backstop coverage + docs mock"
```

---

## Load-bearing validation results (Stage 2 — all claims resolved; see load-bearing-ledger.md + reports/load-bearing-validator-{A,B,C}.md)

1. **LB-1 VERIFIED (measured stream) / ACCEPTABLE (sibling→zombie transfer)** — an independent re-port of the real `NoiseScanner` over the real 18,471-unit capture reproduced the earlier probe's numbers exactly: 17 meaningful (14 bar-composition firsts + 3 text repaints), 0 ring evictions, ring peak 17/32; production wiring gives one PTY read → one classifier frame with no awaits or sustained-stall paths (coalescing fail-open requires ≥1.25 units/read sustained — not producible by the wiring). The zombie's own bytes were never captured — transfer rests on same-binary + the safe fail-open direction (a missed detection, never a false accusation); Task 1's fixture test pins the shape with the real Rust scanner. Residual: a hypothetical ≥18-cell gradient bar would exceed the 32-ring and fail open (same safe direction).
2. **LB-2 VERIFIED (decision stands)** — the actual zombie's `lastActivityAt` was FRESH on day 2 (investigation debug dump), refuting the frozen-output premise while CONFIRMING the design: meaningful-staleness ALONE fires under every observed reading (fresh-output zombie, frozen variant, degraded cadence). Deliberately NO busy/turn-in-flight gate: the zombie class attaches to aborted sessions with no reliable turn state — a busy gate would miss exactly the target class; idle-quiet false positives are the user-accepted tradeoff.
3. **LB-3..LB-13 VERIFIED** — two-pass collect-then-apply implementable (LB-3); `broadcast_tx` shape/wiring confirmed (LB-4); selector precedent confirmed (LB-5); `sendTerminalKillAndAwait` exists and is REUSED (LB-6); both kill/ack/respawn frame orderings converge, pinned by the Task 4 test matrix (LB-7); stale-stuck-card race is real — the plan adopts paneId keying with `{at, terminalId}` + clear-on-adoption via `clearTerminalStuckIfOtherTerminal` in the created fold (+ belts in recordTerminalExit/clearTerminalLifecycle/foldTerminalReplacement) (LB-8); the e2e fixture uses the OPENCODE_CMD + enabledProviders recipe (LB-9); the e2e uses the HARNESS-14 test-clock recipe with freeze-after-quiet discipline (LB-10); all wire-contract pins co-move in Task 2's commit, including inventory.rs:51/56/66 and ZOD_BACKED_SERVER_MESSAGES (LB-11); attach emission point after replay/before Exited preserves ordering (LB-12); ws tests drive the sweep via public `register_headless`(past created_at) + `registry.input` (LB-13).
