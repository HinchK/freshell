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

**Architecture:** The DEV-0009 machinery already computes exactly the needed signal server-side: `ingest` refreshes `last_meaningful_activity_at` only when `NoiseScanner::observe` classifies a PTY frame as genuinely new (registry.rs:3437-3439), while pure spinner repaints leave it stale. A new registry sweep `enforce_stuck_detection` (mirroring `enforce_idle_kills`, but WITHOUT the detached-only exemption — attached panes are the target class) flags agent-mode Running rows on the TWO-CLOCK differential: the meaningful clock older than a 2-hour window WHILE raw output stays fresh (`STUCK_ACTIVITY_FRESH_MS`, 5 min — separating a wedged repaint loop from a prompt-idle pane whose clocks age together), emitting transitions only on change. A `spawn_stuck_monitor` task in `freshell-ws` (the registry crate stays tokio-free) broadcasts a new additive `terminal.stuck` frame per transition; the registry's `attach` also enqueues the frame carrying the CURRENT truth (both directions) to a subscriber attaching to an agent-mode Running row, so reconnecting clients reconcile. The client folds `terminal.stuck` into `terminalLifecycleSlice` (per-paneId, resolved via `selectTabPaneByTerminalId`, the `terminal.idle` precedent), and `TerminalView` renders the stuck card for agent-mode running panes with two actions that await the correlated `terminal.killed` ack then diverge by intent: "Restart agent" kills with `reason:'stuck-recovery'` (a server branch that skips the durable pane-ledger close so the session stays resumable) and re-drives the existing `resetPaneForReconcileCreate` respawn intent (createRequestId preserved, D4); "Start fresh conversation" performs the DEFAULT durable close (the abandoned session is retired and tombstoned) and then REMINTS the pane identity (fresh createRequestId, session identity cleared) so the new conversation cannot inherit the closed one. Nothing ever fabricates `terminal.turn.complete` or `terminal.idle`; nothing kills automatically.

**Tech Stack:** Rust (freshell-terminal registry sweep, freshell-protocol additive message, freshell-ws monitor), TypeScript/React (Zod schema, Redux slice, presentational component), Vitest + Cargo tests, Playwright e2e.

## Global Constraints

- Work only in the run worktree `/home/dan/code/freshell/.worktrees/wedge-backstop` (branch `the-usual/wedge-backstop`, base_ref `855dae72`). Never touch the production server on port 3001 or its processes; never restart any server without explicit user approval. Tests boot their own scratch servers only.
- Red-green-refactor TDD for every task; never reduce or skip tests. Commit focused changes per task.
- TypeScript uses NodeNext/ESM: relative imports include `.js` extensions. Path aliases `@/` → `src/`, `@test/` → `test/`.
- A11y: the stuck card uses `role="alert"`, semantic `<button>`s, and non-empty accessible names (mirrors the freshcodex card, `FreshAgentView.tsx:3513-3538`).
- Broad/coordinated runs: set `FRESHELL_TEST_SUMMARY` to a human-meaningful reason; focused cargo/vitest selectors are fine to run directly (they are delegated, not coordinated). Use `npm run test:vitest -- run <path>` for Vitest; raw `npx vitest` is not a repo workflow.
- **Exit-status discipline (round-3 review):** every verification command in this plan that pipes (`cargo test … | tail`) must run under `set -o pipefail` — otherwise `tail`'s exit 0 masks the runner's failure and a red gate reads green. Every "Expected: PASS" below means the COMMAND's exit status, observed under pipefail.
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
- Test: `crates/freshell-terminal/tests/stuck_real_pty.rs` (episode-3 r3, hardened r4: the production-framing proof — a REAL pty via `create` whose child is this test binary re-exec'd dependency-free (`current_exe()` + `--exact` on an embedded emitter test, magic env var; no python3), emitting the verbatim capture units at the measured ~250 ms cadence; asserts the flag fires through production 8 KiB reads and clears on meaningful output, ~30 s bound)

**Interfaces:**
- Consumes: existing `TerminalShared` clocks (`last_activity_at` registry.rs:233, `last_meaningful_activity_at` registry.rs:241), `is_agent_mode` (registry.rs:1176-1181), `now_ms()` (registry.rs:122-124), `NoiseScanner::observe` (idle_noise.rs:126-197), test helpers `insert_headless`/`feed`/`backdate_last_activity` (registry.rs:4080-4133).
- Produces:
  - `pub const DEFAULT_STUCK_WINDOW_MS: i64 = 7_200_000;`
  - `TerminalShared.last_meaningful_output_at: i64` — the output-only MEANINGFUL clock (advances ONLY on NoiseScanner-accepted ingest output; never keystrokes, teardown/detach grace, or exit)
  - `TerminalShared.last_output_activity_at: i64` — the output-only RAW clock (advances on EVERY ingest output frame; never keystrokes or grace)
  - `TerminalShared.stuck_since: Option<i64>` (pub(crate))
  - `TerminalRegistry.stuck_window_ms: Arc<AtomicI64>` + `pub fn stuck_window_ms(&self) -> i64` + `pub fn set_stuck_window_ms(&self, v: i64)`
  - `pub struct StuckTransition { pub terminal_id: String, pub mode: String, pub stuck: bool, pub at: i64 }`
  - `pub fn enforce_stuck_detection(&self) -> Vec<StuckTransition>` — the freshness conjunct reads the raw OUTPUT clock (`last_output_activity_at`), plus the strict ordering conjunct `last_output_activity_at > last_meaningful_output_at` (a merely-quiet row's two output clocks stay equal; a wedge's repaint stream advances the raw clock strictly past the frozen meaningful one)

- [ ] **Step 1: Write the failing behavioral tests — staged additions in this exact order**

Cargo compiles the whole crate test target before name filters (the plan's own finding), so the additions are STAGED within this one step and each stage is run before the next:

**Stage (a): add ONLY the `idle_noise.rs` fixture test (alone).** Run it immediately (Run A, below) BEFORE adding any registry test. This is the round-3 review's sequencing fix: Step 1 and Step 2 must agree on the order.
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

**Stage (b): after Run A passes, add the registry stuck tests.** Run them (Run B, below) and observe the intended RED before writing any production code.

In `registry.rs`'s test module (mirroring the `enforce_idle_kills_*` suite at 5320-5700; reuse the same row-construction pattern as `enforce_idle_kills_spares_agent_mode_terminals_past_threshold` at 5414-5445 for agent-mode rows and `enforce_idle_kills_never_kills_an_attached_terminal` at 5365-5381 for attached rows):

```rust
const STUCK_TEST_WINDOW_MS: i64 = 100;

fn stuck_test_registry(mode: &str) -> TerminalRegistry {
    let reg = // mirror the agent-mode row construction from the 5414 test,
              // insert_headless with mode set the same way that test does
    reg.set_stuck_window_ms(STUCK_TEST_WINDOW_MS);
    reg
}

/// The shared flag-setup: warm the fingerprint ring with one meaningful
/// first-occurrence frame, backdate BOTH clocks past the window, then feed
/// ring-repeat repaint variants (noise → activity fresh, meaningful stale).
/// This is the ONLY way a row reaches the flagged state — both the flag
/// test and the clear tests must start from here (round-3 review Major:
/// backdating alone can never flag, because the predicate also requires
/// activity freshness).
fn flag_stuck_row(reg: &TerminalRegistry) {
    reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
    reg.backdate_last_activity("T", /* now - (window+1) */);
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
fn stuck_detection_flags_attached_agent_pane_with_only_repaint_noise() {
    let reg = stuck_test_registry("opencode");
    // Attach a subscriber FIRST — the deliberate divergence from the idle
    // reaper: attached panes are the primary target class (the reaper
    // exempts them by design, registry.rs:1232). The flag transition and
    // its shape are asserted by the helper — an ATTACHED row flagging is
    // the whole point of this test.
    attach_test_subscriber(&reg, "T"); // mirror the 5365 test's attach helper
    flag_stuck_row(&reg);
}

#[test]
fn stuck_detection_clears_on_meaningful_output() {
    let reg = stuck_test_registry("opencode");
    flag_stuck_row(&reg);
    // Genuinely-new content refreshes the meaningful clock (ingest path).
    reg.feed("T", frame(9, "meaningful new text line\n", "S"));
    let cleared = reg.enforce_stuck_detection();
    assert_eq!(cleared.len(), 1);
    assert!(!cleared[0].stuck);
}

#[test]
fn stuck_detection_survives_user_input() {
    // EPISODE-3 FOCUSED-REVIEW AMENDMENT (r1): the original sketch
    // asserted the WRONG contract — that a keystroke CLEARS the stuck
    // flag. Keystrokes refresh the reaper's mixed clock
    // (`last_meaningful_activity_at`) only; BOTH wedge clocks are
    // output-only (`last_meaningful_output_at` advances exclusively via
    // NoiseScanner-accepted output in `ingest`,
    // `last_output_activity_at` via every output frame), so typing at /
    // Ctrl+C-ing a genuinely wedged pane (the natural first response)
    // neither clears nor postpones the stuck state — and a healthy
    // engaged pane's keystroke echo arrives via `ingest` and keeps the
    // clocks fresh through output anyway. `input` returns `InputOutcome`
    // (NOT a Result — no unwrap).
    let reg = stuck_test_registry("opencode");
    flag_stuck_row(&reg);
    assert!(reg.input("T", b"x").found);
    // The sweep must emit NO clear transition — the row still matches
    // the wedge predicate (meaningful output stale, activity fresh).
    assert!(reg.enforce_stuck_detection().is_empty(),
            "typing at a wedged pane must not un-wedge it");
    // And the flag SURVIVED: a fresh subscriber's attach-time stuck
    // truth still reports stuck:true (the page_refresh probe shape).
    let (sink, seen) = collector();
    assert!(reg.attach("T", 1, sink, Some("att-surv".into()), 0, false, None, None)
        .found);
    let stuck = stuck_frames(&seen);
    assert_eq!(stuck.len(), 1);
    assert!(stuck[0].stuck, "the stuck flag survived the user input");
}

#[test]
fn stuck_detection_ignores_shell_mode_and_exited_rows_and_under_window() {
    // shell-mode row past the window with fresh activity → no transition.
    // agent-mode row under the window → no transition.
    // agent-mode row with status != Running → no transition (mirror how
    // the 5320 suite forces an Exited row; e.g. finish_pty_exit or the
    // headless exit helper used by the exit-path tests).
}

#[test]
fn stuck_detection_ignores_prompt_idle_rows_where_both_clocks_are_stale() {
    // The round-1 review pin: a pane sitting quietly at a prompt emits
    // NOTHING — both clocks age together, so there is no repaint loop and
    // the pane must NOT be flagged (flagging it would alter a non-wedged
    // pane). Backdate BOTH clocks equally past the window; do NOT feed.
    let reg = stuck_test_registry("opencode");
    reg.backdate_last_activity("T", /* window+1 ago, both clocks */);
    assert!(reg.enforce_stuck_detection().is_empty());
}

#[test]
fn stuck_detection_clears_when_output_freezes_entirely() {
    // A flagged pane whose repaint stream stops (activity goes stale) is no
    // longer provably a repaint loop: clear the flag with a transition.
    let reg = stuck_test_registry("opencode");
    flag_stuck_row(&reg);
    // now backdate BOTH clocks far past the freshness bound, feed nothing
    // (the ring-warm discipline lives in the helper — a bare "⠋ repaint"
    // feed here would carry the significant word "repaint" and refresh the
    // MEANINGFUL clock, breaking the test)
    reg.backdate_last_activity("T", /* window+1 ago again */);
    let cleared = reg.enforce_stuck_detection();
    assert_eq!(cleared.len(), 1);
    assert!(!cleared[0].stuck);
}

#[test]
fn stuck_detection_disabled_when_window_zero_or_negative() {
    let reg = stuck_test_registry("opencode");
    reg.set_stuck_window_ms(0);
    reg.backdate_last_activity("T", /* far past */);
    reg.feed("T", frame(1, "\r\x1b[2K⠋", "S")); // activity fresh
    assert!(reg.enforce_stuck_detection().is_empty());
}
```

**Stage (c) — the production-framing proof test (episode-3 r3, hardened r4): `crates/freshell-terminal/tests/stuck_real_pty.rs`.** A REAL pty via `TerminalRegistry::create` (mode "opencode") whose child re-execs this test binary dependency-free (`current_exe()` spawned with `--exact stuck_real_pty_emitter_child` + `FRESHELL_STUCK_TEST_EMITTER=1`, so the child harness runs only the embedded emitter test — no python3 prerequisite, no fixture files, no network), writing the first 60 capture units VERBATIM (embedded in the test file) at the measured ~250 ms cadence, looping forever, then switching to genuinely-new lines once a sentinel file appears. Asserts: the ring warms through production 8 KiB reads (framing recorded — mid-unit splits tolerated + recorded, sustained multi-unit coalescing asserted away), the sweep FLAGS the row (the differential holds through real framing), and the meaningful switch CLEARS it. Deterministic in outcome, hermetic, bounded ~30 s, SIGKILLed via the registry's own `kill`.

- [ ] **Step 2: Run the staged tests and verify each stage's intended result**

Each staged addition from Step 1 is run immediately after being added, under `set -o pipefail` (see Global Constraints):

Run A (after Stage (a)): `cargo test -p freshell-terminal opencode_tui 2>&1 | tail -20`

Expected: PASS — the fixture pins EXISTING scanner behavior (a characterization pin in the family of the codex-shimmer tests, idle_noise.rs:337-366); if it FAILS, the fixture mis-models the strip set and the fixture is wrong, not the scanner.

Run B (after Stage (b)): `cargo test -p freshell-terminal stuck_detection 2>&1 | tail -20`

Expected: FAIL to COMPILE — `enforce_stuck_detection`, `StuckTransition`, `set_stuck_window_ms` do not exist (the intended missing-behavior failure).

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

/// Flag/unflag agent-mode RUNNING terminals whose output-only MEANINGFUL
/// clock went stale past the stuck window WHILE the output-only RAW
/// output clock keeps flowing (the three-clock wedge differential — the
/// User Request's load-bearing constraint names it in its original
/// mixed-clock terms, "last_meaningful_activity_at stale while
/// last_activity_at stays fresh"; the final contract reads the
/// output-only twins so keystrokes and teardown grace can neither
/// manufacture nor mask a wedge — see the amendment notes below). The
/// activity-freshness conjunct is what separates a WEDGED repaint loop
/// (the eternal spinner keeps painting — raw output fresh) from a pane
/// sitting quietly at a prompt or mid-idle (both output clocks equally
/// stale — NOT the requested detection class, and flagging it would
/// alter non-wedged panes). The strict clock-ordering conjunct
/// (`last_output_activity_at > last_meaningful_output_at`, episode-3 r3)
/// closes the tiny-window merely-exists case: both output clocks init to
/// the creation time, so under a configured window below
/// `STUCK_ACTIVITY_FRESH_MS` a row that merely EXISTS past the window
/// would otherwise satisfy staleness+freshness without ever having
/// emitted — a wedge's repaint stream advances the raw clock STRICTLY
/// past the frozen meaningful clock, while a merely-quiet row's output
/// clocks stay equal. Emits transitions ONLY on state change
/// (stuck:false→true and true→false); never kills, never emits a
/// turn-complete, and unlike `enforce_idle_kills` does NOT exempt
/// attached terminals — an attached wedged pane is the primary failure
/// class this sweep exists for (see the 2026-09-18 opencode zombie RCA).
/// A wedged pane whose output later FREEZES entirely stops matching (no
/// longer a repaint loop) and the flag clears — an accepted
/// safe-direction residual.
pub fn enforce_stuck_detection(&self) -> Vec<StuckTransition> {
    let window = self.stuck_window_ms();
    if window <= 0 { return Vec::new(); }
    let now = now_ms();
    let mut transitions = Vec::new();
    // Walk rows with the same locking pattern enforce_idle_kills uses;
    // for each row:
    //   should = s.status == Running && is_agent_mode(&s.mode)
    //            && (now - s.last_meaningful_output_at) > window
    //            && (now - s.last_output_activity_at) < STUCK_ACTIVITY_FRESH_MS
    //            && s.last_output_activity_at > s.last_meaningful_output_at;
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

with the freshness const next to the window consts:

```rust
/// How recent raw PTY output must be for a row to count as "still
/// repainting". 5 minutes: far above the 30s sweep tick, generous to any
/// degraded repaint cadence, and hours below the 2h meaningful-silence
/// window — so the two conjuncts never fight on real wedges.
pub const STUCK_ACTIVITY_FRESH_MS: i64 = 300_000;
```

Note `is_agent_mode` is a private fn in the same file — call it directly. Do NOT touch `enforce_idle_kills` or `idle_noise.rs`. The predicate is the WEDGE DIFFERENTIAL — output-meaningful staleness AND output-raw freshness together (the User Request's Explicit constraint names the differential signal; the round-1 review caught the staleness-only variant flagging prompt-idle panes, which would alter non-wedged panes). Deliberately NO busy/turn-in-flight gate (the zombie class attaches to aborted sessions with no reliable turn state; a busy gate would produce false negatives on exactly the target class). (Episode-3 focused-review amendment — final three-clock contract: the sweep flags when the output-only MEANINGFUL clock is past the window while the output-only RAW activity clock stays fresh — keystrokes and teardown grace touch neither. The staleness conjunct reads `last_meaningful_output_at` (advances exclusively via NoiseScanner-accepted output, so typing at / Ctrl+C-ing a genuinely wedged pane does not clear or postpone the stuck state); the freshness conjunct reads `last_output_activity_at` (refreshed by every output frame in `ingest` alone, never by keystrokes or the detach/socket-close grace bumps, so a keypress cannot manufacture the differential on a healthy quiet pane either — focused-e3r2 Finding 1). Episode-3 r3 adds the strict clock-ordering conjunct `last_output_activity_at > last_meaningful_output_at` (focused-e3r3 Finding 3): both output clocks init to the creation time, so without it a row that merely EXISTS past a window below `STUCK_ACTIVITY_FRESH_MS` flags without ever having emitted; a wedge's repaint stream advances the raw clock strictly past the frozen meaningful one, a merely-quiet row's stay equal.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-terminal stuck_detection 2>&1 | tail -5` and `cargo test -p freshell-terminal opencode_tui 2>&1 | tail -5` and `cargo test -p freshell-terminal --test stuck_real_pty 2>&1 | tail -5` (the Stage (c) production-framing proof; ~30 s, hermetic, no python3)

Expected: PASS (all new tests green).

- [ ] **Step 5: Refactor while green**

Extract any shared row-walk helper between the two sweeps ONLY if the shape is genuinely identical; otherwise leave two explicit functions (the eligibility predicates differ — subscribers exemption vs none — so explicit is likely clearer). State which in the commit message.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole `freshell-terminal` crate (registry + noise + existing idle-kill suite — the sweep shares their state).

Run: `cargo test -p freshell-terminal 2>&1 | tail -5`

Expected: PASS (zero failures; pre-existing suite untouched).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-terminal/src/registry.rs crates/freshell-terminal/src/idle_noise.rs crates/freshell-terminal/tests/stuck_real_pty.rs
git commit -m "feat(terminal): registry stuck sweep flags agent panes past meaningful-idle window"
```

**Episode-3 focused-review amendment:** the review loop corrected Task 1's input/clearing semantics after the sketches were written, in two rounds. Round 1 (staleness half): keystrokes refresh the reaper clock (`last_meaningful_activity_at`) only; the wedge staleness clock (`last_meaningful_output_at`, the round-4 output-only twin the implemented sweep reads) advances exclusively via NoiseScanner-accepted output in `ingest`, and typing at / Ctrl+C-ing a genuinely wedged pane does not un-wedge it (a healthy engaged pane's keystroke echo arrives via `ingest` and keeps the clocks fresh through output anyway). Round 2 (r2 — freshness half, focused-e3r2 Finding 1): the freshness conjunct reads a third clock, the output-only RAW `last_output_activity_at` (refreshed by every output frame in `ingest` alone), instead of the mixed `last_activity_at` — the mixed clock is refreshed by keystrokes too, so reading it let a single keypress manufacture the differential on a healthy quiet pane (both output clocks stale past the window; the keypress refreshes the mixed clock → false flag). Final three-clock contract: the sweep flags when the output-only MEANINGFUL clock is past the window while the output-only RAW activity clock stays fresh — keystrokes and teardown grace touch neither. The predicate note above and the `stuck_detection_survives_user_input` sketch state the corrected contract; the implemented tests are `stuck_detection_survives_user_input` and `keypress_does_not_manufacture_wedge_freshness`, and the other code blocks (e.g. the `stuck_since` doc sketch's "cleared by the first meaningful activity", which reads "first meaningful output") remain pre-implementation history per this plan's rules. r3 remediation (focused-e3r3 Findings 2 and 3): the two executable sketch blocks are now ALIGNED to the final contract — the test sketch is renamed and re-asserted as `stuck_detection_survives_user_input` (typing must not un-wedge), and the predicate sketch reads the output-only clocks plus the r3 strict clock-ordering conjunct, pinned by `tiny_window_does_not_flag_a_merely_existing_row` — so executing the plan as written reproduces HEAD; only the non-executable prose sketches remain pre-implementation history. r4 remediation (focused-e3r4 Findings 1 and 2): the Task 1 Produces list now names the two output-only clock fields (`TerminalShared.last_meaningful_output_at`, `TerminalShared.last_output_activity_at`) and the predicate's raw-output freshness + strict clock-ordering conjuncts, and the Task 1 test roster (Files list, Step 1 Stage (c), Step 4 run) now includes the `tests/stuck_real_pty.rs` production-framing proof — real pty via `create`, verbatim capture units at the measured cadence through production reads, flag fires, clear-on-meaningful — so executing the plan as written reproduces the implemented three-clock contract end to end.

---

### Task 2: Wire contract — additive `terminal.stuck` message

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (enum ~line 126 area after `terminal.status`; consts ~line 183; struct near `TerminalIdle` ~line 527)
- Modify: `crates/freshell-protocol/src/client_messages.rs` (`TerminalKill` struct — add `reason: Option<String>`)
- Modify: `port/contract/ws-server-messages.schema.json` + `port/contract/ws-message-inventory.json` (via the generator — never by hand)
- Modify: `shared/ws-protocol.ts` (Zod schema near `TerminalIdleSchema` line 351 + `TerminalKillSchema` ~line 648 gains `reason: z.string().optional()`; ServerMessage union member near the `terminal.idle` member ~line 1650s)
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
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-protocol/src/client_messages.rs shared/ws-protocol.ts port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/ws-protocol.schema.json crates/freshell-protocol/tests/inventory.rs test/unit/port/ws-contract-freeze.test.ts test/unit/client/lib/terminal-stuck-ws.test.ts
git commit -m "feat(protocol): additive terminal.stuck server message + terminal.kill reason (wedge-backstop)"
```
(`ws-protocol.schema.json` is the committed INBOUND bundle the generator rewrites when `TerminalKillSchema` changes — round-2 review Major; staging it is what keeps the freeze test green against the COMMITTED tree, not just the dirty worktree.)

---

### Task 3: Stuck monitor driver, boot wiring, attach emission

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (after `spawn_idle_monitor`, ~line 533)
- Modify: `crates/freshell-ws/src/terminal.rs` (kill handler ~7699-7985: the `stuck-recovery` reason branch)
- Modify: `crates/freshell-server/src/main.rs` (~lines 1131-1145 idle-monitor wiring area)
- Modify: `crates/freshell-terminal/src/registry.rs` (attach — enqueue the current stuck truth to new subscribers; ~lines 1509-1734)
- Test: `crates/freshell-ws/tests/terminal_stuck_monitor.rs` (new integration test)

**Interfaces:**
- Consumes: Task 1's `enforce_stuck_detection`/`StuckTransition`/`stuck_window_ms` setter; Task 2's `ServerMessage::TerminalStuck` and the extended `TerminalKill` (`reason` field).
- Produces:
  - `freshell_ws::broadcast_stuck_frame(transition: &StuckTransition, broadcast_tx: &tokio::sync::broadcast::Sender<String>)` (pure: serialize one `terminal.stuck` frame and send; the unit-testable seam — cross-crate tests cannot construct the wedge row state via the public registry API, so they drive THIS function with constructed transitions)
  - `freshell_ws::spawn_stuck_monitor(registry: TerminalRegistry, broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>, sweep_interval: Duration)` (tick = `for t in registry.enforce_stuck_detection() { broadcast_stuck_frame(&t, &tx) }`; the composition is 3 lines whose components are each pinned — the sweep by Task 1's in-file suite, the frame by the ws tests, the end-to-end flag by the e2e)
  - `freshell_ws::stuck_window_ms_from_env() -> i64` (parses `FRESHELL_TERMINAL_STUCK_WINDOW_MS`; any parseable integer is used AS-IS — 0 or negative DISABLES detection, mirroring `auto_kill_idle_minutes`' disable semantics; unparseable values fall back to `DEFAULT_STUCK_WINDOW_MS`)
  - Registry `attach` enqueues the CURRENT stuck truth (both directions) to new subscribers of agent-mode Running rows — tested in the registry crate's in-file suite (Task 3 adds these tests there, where the `feed`/`backdate_last_activity` helpers can construct the wedge state).
  - `terminal.kill{reason:'stuck-recovery'}` server branch in `crates/freshell-ws/src/terminal.rs` (~7699-7985): when the kill's `reason` is `"stuck-recovery"`, run the fenced stop + PTY kill + row removal + `terminal.killed` ack EXACTLY as today, but SKIP the durable `ledger.close_pane(PaneCloseWrite{...})` envelope write (~7882-7900, unconditional for every kill today) AND skip the session-identity retirement/tombstone consult — the pane's durable session must stay resumable so the follow-up `resetPaneForReconcileCreate` → `terminal.create{restore:true}` can resume it. This mirrors the idle reaper's server-initiated kill (no close envelope; `pane_reconcile.rs:768` proves reaped rows converge to respawn, not suppression). Any other `reason` (or absent) keeps today's full pane-close semantics byte-for-byte.

- [ ] **Step 1: Write the failing integration test**

`crates/freshell-ws/tests/terminal_stuck_monitor.rs` — cross-crate tests drive the PURE frame function with constructed transitions (the wedge row state is not constructible via the public registry API — `register_headless` seeds BOTH clocks from `created_at`, and `registry.input` refreshes BOTH — so registry-state tests stay in the registry crate's in-file suite; see below):

```rust
// RED: broadcast_stuck_frame does not exist yet.
#[test]
fn stuck_frames_serialize_both_directions() {
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    broadcast_stuck_frame(&freshell_terminal::StuckTransition {
        terminal_id: "T".into(), mode: "opencode".into(), stuck: true, at: 123,
    }, &tx);
    let first = rx.try_recv().unwrap();
    assert!(first.contains("\"type\":\"terminal.stuck\""));
    assert!(first.contains("\"stuck\":true"));
    assert!(first.contains("\"terminalId\":\"T\""));
    assert!(first.contains("\"at\":123"));
    broadcast_stuck_frame(&freshell_terminal::StuckTransition {
        terminal_id: "T".into(), mode: "opencode".into(), stuck: false, at: 456,
    }, &tx);
    let clear = rx.try_recv().unwrap();
    assert!(clear.contains("\"stuck\":false"));
}
```

Attach-emission tests go in the REGISTRY crate's in-file `#[cfg(test)]` module (registry.rs ~5700, where `insert_headless`/`feed`/`backdate_last_activity`/collector-sink precedents at 5365-5371 can construct the flagged state) — added by this task because the attach emission ships in this task:

```rust
#[test]
fn attaching_to_an_agent_row_enqueues_the_current_stuck_truth_both_directions() {
    // LB-12 insertion (registry.rs:1709-1721, inside attach_to_shared's
    // single-lock handoff, AFTER replay, BEFORE the Exited block).
    // Flagged row: backdate both clocks past the window, feed repaint frames
    // (activity fresh), sweep → flagged; attach with a collector sink →
    // assert TerminalStuck{ stuck: true } arrives after attach.ready/replay.
    // Healthy row (fresh meaningful clock): attach → assert the sink received
    // TerminalStuck{ stuck: false } — the reconnect reconciliation frame.
}

#[test]
fn attach_reconciles_a_late_clear_for_a_reconnecting_client() {
    // Flag the row, attach (sink A sees stuck:true), then registry.input(...)
    // clears the flag (next sweep), then attach with a FRESH sink B:
    // assert sink B received stuck:false — a client that missed the
    // stuck:false broadcast reconciles on re-attach.
}
```

Kill-reason tests (same file — they exercise the ws kill handler through the existing harness patterns; if the handler requires a full `WsState`, place them beside the existing kill-handler tests in `crates/freshell-ws/tests/pane_ledger_triggers.rs`'s harness style instead):

```rust
#[test]
fn stuck_recovery_kill_leaves_the_session_resumable() {
    // The round-1 review Major: terminal.kill is the DURABLE pane-close
    // primitive (unconditional ledger.close_pane envelope at terminal.rs
    // ~7882-7900 + identity retirement/tombstones consulted by recovery
    // suppression — recovery_inventory.rs apply_kill_tombstone_dominance).
    // The stuck-restart MUST NOT corrupt that durable state. Drive a kill
    // with reason:'stuck-recovery': assert (1) the row is gone and the
    // correlated terminal.killed{success:true} ack still fires, (2) NO
    // close-envelope journal record exists for the terminal (pane_ledger
    // surface — mirror the ledger-assertion patterns in
    // crates/freshell-ws/tests/pane_ledger_triggers.rs), and (3) the
    // session identity is still resolvable (session_ref_for still answers)
    // so a restore:create respawn is not suppressed.
}

#[test]
fn pane_close_kill_keeps_the_full_durable_close() {
    // Regression pin: a kill WITHOUT the stuck-recovery reason (absent
    // reason, or any other value) must keep today's byte-for-byte
    // semantics: the close envelope IS written and identity retirement
    // happens — assert the ledger journal gained the record (guards the
    // branch against swallowing the legacy path).
}
```

- [ ] **Step 2: Run ALL the new tests and verify each group's intended RED**

Cargo accepts ONE positional test-name filter per invocation, so run each group separately. Every test from Step 1 must execute RED before any production change (round-2 review Major — red-before-green applies to the attach and kill behaviors just as to the monitor frame):

Run A (ws frames): `cargo test -p freshell-ws --test terminal_stuck_monitor 2>&1 | tail -10`

Expected: FAIL to COMPILE — `broadcast_stuck_frame` does not exist (the intended missing-symbol failure).

Run B (registry attach emission, in-file suite): `cargo test -p freshell-terminal attaching 2>&1 | tail -10` and `cargo test -p freshell-terminal attach_reconciles 2>&1 | tail -10`

Expected: FAIL on ASSERTIONS — the tests compile (Task 2 landed `TerminalStuck`) but no stuck frame is enqueued on attach yet (the intended missing-behavior failure, not a compile accident).

Run C (kill reason, ws harness): `cargo test -p freshell-ws stuck_recovery 2>&1 | tail -10` and `cargo test -p freshell-ws pane_close_kill 2>&1 | tail -10`

Expected: FAIL on ASSERTIONS — `reason` parses (Task 2 landed the schema) but the handler ignores it (stuck-recovery still writes the close envelope; the pane-close regression pin fails against the un-branched handler only if it asserts the envelope — if it passes vacuously before the branch exists, note that and keep it as the post-branch regression pin; the stuck-recovery test is the behavioral RED).

- [ ] **Step 3: Add the minimal production implementation**

`freshell-ws/src/lib.rs` (after `spawn_idle_monitor`, mirroring its doc style):

```rust
/// Serialize one `terminal.stuck` transition frame and broadcast it. Pure
/// seam: cross-crate tests drive THIS with constructed transitions (the
/// wedge row state is not constructible through the public registry API).
pub fn broadcast_stuck_frame(
    transition: &freshell_terminal::StuckTransition,
    broadcast_tx: &tokio::sync::broadcast::Sender<String>,
) {
    let msg = freshell_protocol::ServerMessage::TerminalStuck(
        freshell_protocol::TerminalStuck {
            terminal_id: transition.terminal_id.clone(),
            at: transition.at,
            stuck: transition.stuck,
        },
    );
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = broadcast_tx.send(json);
    }
}

/// Start the wedged-agent-pane monitor (the terminal-mode analogue of the
/// freshcodex quiet deadman): periodic `enforce_stuck_detection` sweep whose
/// transitions broadcast `terminal.stuck` to every authenticated client.
/// Same cadence contract as [`spawn_idle_monitor`]; surface-only — nothing
/// is killed here.
pub fn spawn_stuck_monitor(
    registry: freshell_terminal::TerminalRegistry,
    broadcast_tx: std::sync::Arc<tokio::sync::broadcast::Sender<String>>,
    sweep_interval: std::time::Duration,
) {
    spawn_periodic(sweep_interval, move || {
        for transition in registry.enforce_stuck_detection() {
            broadcast_stuck_frame(&transition, &broadcast_tx);
        }
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
freshell_ws::spawn_stuck_monitor(registry.clone(), Arc::clone(&broadcast_tx), stuck_sweep_interval);
```
(Use the same broadcast sender handle `auto_resume`'s `broadcast_frame` sends on — the `Arc<tokio::sync::broadcast::Sender<String>>` created at main.rs:916; confirm the exact clone shape from `broadcast_settled_frame`'s usage, auto_resume.rs:1375-1406.)

`terminal.rs` kill handler (~7699-7985): gate the durable-close portion on the reason. Read `kill.reason` (added to the `TerminalKill` client message in Task 2):

```rust
let stuck_recovery = kill.reason.as_deref() == Some("stuck-recovery");
// ... existing fenced-stop + kill + ack machinery runs UNCHANGED ...
// The durable close block (spawn_blocking ledger.close_pane(PaneCloseWrite{...}),
// terminal.rs:~7882-7900) AND the session-identity retirement/tombstone
// consult run ONLY when !stuck_recovery. For stuck_recovery, log
// tracing::info!(terminal_id, "terminal_kill_stuck_recovery: process-only
// kill; session left resumable") and skip both — the pane's session must
// survive for the restore:create respawn the client dispatches next.
// Everything else (terminal.killed ack, row removal, ownership claim
// release) is identical.
```

`registry.rs` `attach` (~1509-1734), inside `attach_to_shared`'s single-lock handoff — insertion point per LB-12: AFTER the replay enqueue block and BEFORE the Exited block (registry.rs:1709-1721), preserving the ready < modes.sync < replay < live ordering invariant (1663-1666). The round-1 review requires the emission to carry the CURRENT truth in BOTH directions for agent-mode Running rows — `stuck: true` when flagged, `stuck: false` when healthy — so a reconnecting client that missed a `stuck:false` broadcast reconciles its stale card:

```rust
if is_agent_mode(&s.mode) && s.status == TerminalRunStatus::Running {
    let frame = ServerMessage::TerminalStuck(TerminalStuck {
        terminal_id: s.terminal_id.clone(),
        at: s.stuck_since.unwrap_or_else(|| now_ms()),
        stuck: s.stuck_since.is_some(),
    });
    // enqueue to the NEW subscriber's sink only (not the broadcast), so a
    // reconnecting client learns the CURRENT stuck state in both
    // directions. Repeated keepalive re-attach re-sends the frame; the
    // client fold is idempotent (sets/clears a keyed value).
    (sink)(frame);
}
```
(`spawn_stuck_monitor` signature per LB-4: takes `Arc<tokio::sync::broadcast::Sender<String>>` — the exact type main.rs:916 creates and WsState.broadcast_tx holds (freshell-ws/src/lib.rs:162); wire with `Arc::clone(&broadcast_tx)` next to the idle-monitor spawn.)

- [ ] **Step 4: Run the focused test**

Run (one filter per invocation — cargo takes a single positional filter): `cargo test -p freshell-ws --test terminal_stuck_monitor 2>&1 | tail -5` and `cargo test -p freshell-terminal stuck 2>&1 | tail -5` and `cargo test -p freshell-terminal attaching 2>&1 | tail -5` and `cargo test -p freshell-ws stuck_recovery 2>&1 | tail -5`

Expected: PASS (all groups green).

- [ ] **Step 5: Refactor while green**

If `broadcast_stuck_frame` and `auto_resume::broadcast_frame` share a serialize-and-send helper worth extracting, extract a tiny `fn broadcast_server_message(tx, msg)` in `freshell-ws`; otherwise leave as-is (two-line duplication is acceptable across modules).

- [ ] **Step 6: Run impacted-test verification**

Impacted: freshell-ws suite + freshell-terminal suite (attach changed) + freshell-server compile (main wiring).

Run: `cargo test -p freshell-ws -p freshell-terminal 2>&1 | tail -5` and `cargo check -p freshell-server 2>&1 | tail -3`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-server/src/main.rs crates/freshell-terminal/src/registry.rs crates/freshell-ws/tests/terminal_stuck_monitor.rs
git commit -m "feat(ws): spawn_stuck_monitor broadcasts terminal.stuck transitions; stuck-recovery kill stays resumable"
```

---

### Task 4: Client fold, stuck store, card, and actions

**Files:**
- Modify: `src/store/terminalLifecycleSlice.ts` (state + reducers)
- Modify: `src/store/turnCompletionThunks.ts` (or sibling location of `applyServerIdle`, ~line 22-36) — `applyTerminalStuck` thunk
- Modify: `src/App.tsx` (WS fold case near the `terminal.idle` case, 1678-1685)
- Create: `src/components/TerminalStuckCard.tsx`
- Modify: `src/lib/kill-ack.ts` (ONE additive opt: `reason?: string`, forwarded onto the `terminal.kill` frame)
- Modify: `src/components/TerminalView.tsx` (render + handlers + the created-fold clear-on-adoption dispatch, near the exit-banner block 5831-6140)
- Test: `test/unit/client/lib/terminal-stuck-ws.test.ts` (extend: fold tests), `test/unit/client/store/terminalLifecycleSlice` tests (extend or new), `test/unit/client/components/TerminalStuckCard.test.tsx` (new), `test/unit/client/components/TerminalView.stuckCard.test.tsx` (new, mirroring `TerminalView.exitBanner.test.tsx` harness)

**Interfaces:**
- Consumes: Task 2's `TerminalStuckSchema`/union member + the extended `TerminalKillSchema` (`reason` field); existing `selectTabPaneByTerminalId` (`src/store/selectors/paneTerminalSelectors.ts:52`), `resetPaneForReconcileCreate` (`src/store/panesSlice.ts:2409-2475`), `sendTerminalKillAndAwait` (`src/lib/kill-ack.ts:116-173` — LB-6: REUSE this helper; opts `createRequestId?/timeoutMs?/send?/observedEpoch?/observedGeneration?`, returns `KillAck = { ok: true } | { ok: false; error?; timedOut? }`; Task 4 adds ONE additive opt `reason?: string` that the helper forwards onto the `terminal.kill` frame — use the `send` opt in tests' ws-spy harnesses), `resolveTerminalKillFence` (`src/lib/terminal-kill.ts`), the `terminal.killed` correlated ack fold (`TerminalView.tsx:5032-5050`).
- Produces:
  - `terminalLifecycleSlice` state: `stuckAtByPaneId: Record<string, { at: number; terminalId: string }>` (LB-8: store the flagged terminalId WITH the entry — terminalId churn happens exactly on kill/respawn/replacement, which is when a prior flag is stale); reducers `recordTerminalStuck({paneId, terminalId, at})`, `clearTerminalStuck({paneId})`, and `clearTerminalStuckIfOtherTerminal({paneId, terminalId})` (delete the entry only when `stuck.terminalId !== payload.terminalId`); `recordTerminalExit`, `clearTerminalLifecycle`, and `foldTerminalReplacement` also delete/clear the pane's stuck entry (one-line belts; `foldTerminalReplacement` keys the clear on `newTerminalId`).
  - `applyTerminalStuck` thunk: parse with `TerminalStuckSchema`, resolve pane via `selectTabPaneByTerminalId`, dispatch record/clear. NEVER dispatches `turnCompletion/*`.
  - `TerminalStuckCard` presentational component: props `{ mode: string; onRestart: () => void; onStartFresh: () => void }`.
  - `TerminalView`: `restartStuckAgentPane()` (kill-await → `resetPaneForReconcileCreate({tabId, paneId, intent: 'respawn', sessionRef})`) and `startFreshFromStuckPane()` (kill-await with the DEFAULT durable-close kill — NO `reason` on the wire, so the abandoned session's identity is retired like any pane close — then, after the ack, a pane-identity REMINT via `updateContent`: fresh-nanoid `createRequestId`, live handles + session identity cleared, status `'creating'`; NOT `resetPaneForReconcileCreate`, because the durable close journaled the old `createRequestId` and a preserved identity would inherit the closed state), plus the render gate: `mode !== 'shell' && terminalContent.status === 'running' && stuckAtByPaneId[paneId] !== undefined`.
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
//   A1. ws send called with terminal.kill carrying terminalId, reason
//       'stuck-recovery', + fence pair
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
// F (start-fresh behavioral coverage — round-2 review Major; close
//   semantics corrected by the round-3 delta review): click "Start
//   fresh conversation" → assert the kill-await runs with the DEFAULT
//   durable-close kill (NO reason on the wire — unlike A1's
//   'stuck-recovery'), then on the success ack assert exactly ONE
//   pane-identity REMINT: a fresh createRequestId with the session
//   identity cleared and status 'creating' (and NO
//   resetPaneForReconcileCreate — the durable close journaled the old
//   createRequestId, so a preserved identity would inherit the retired
//   one); and the kill-failure arm keeps the pane and card (same C
//   shape). This pins that the second required action cannot silently
//   skip the process kill or re-use the retired identity.
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
  // reason:'stuck-recovery' is load-bearing (round-1 review Major): a bare
  // terminal.kill is the DURABLE pane-close primitive (close envelope +
  // identity retirement + recovery suppression). The stuck restart must
  // kill the process WITHOUT retiring the session so the respawn can
  // restore:true-resume it.
  const ack = await sendTerminalKillAndAwait(tid, { ...fence, reason: 'stuck-recovery' })
  if (!ack.ok) {
    log.warn('terminal_stuck_restart_kill_failed', { terminalId: tid, ack })
    return // keep the card; the user can retry
  }
  dispatch(clearTerminalLifecycle({ paneId }))
  dispatch(resetPaneForReconcileCreate({ tabId, paneId, intent: 'respawn', sessionRef: terminalContent.sessionRef }))
}, [/* deps */])
// startFreshFromStuckPane: kill-await with the DEFAULT durable-close kill
// (NO reason on the wire — the user is abandoning the conversation, so its
// identity is retired like any pane close), then, after the ack, the
// pane-identity REMINT: fresh-nanoid createRequestId, live handles + session
// identity cleared, status 'creating' (the terminal lane's
// clearTerminalContentForRecreate semantics, NOT resetPaneForReconcileCreate
// — the durable close journaled the old createRequestId, and a preserved
// identity would inherit the closed state and be omitted from recovery).
// The await-first order is load-bearing: the reset/remint must not fire
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
git add src/components/TerminalStuckCard.tsx src/components/TerminalView.tsx src/store/terminalLifecycleSlice.ts src/store/turnCompletionThunks.ts src/App.tsx src/lib/kill-ack.ts test/unit/client
git commit -m "feat(client): Agent-appears-stuck card for terminal-mode agent panes with kill+restart actions"
```

**Round-3 delta-review amendment:** the review loop corrected Task 4's start-fresh close semantics after the sketches were written. Start-fresh sends the DEFAULT durable-close kill (no `reason` field — the abandoned session is retired + tombstoned, mirroring the freshcodex `startNewConversation` twin), awaits the correlated `terminal.killed` ack, then REMINTS the pane identity (fresh-nanoid `createRequestId`, session identity cleared, status `'creating'`) instead of `resetPaneForReconcileCreate({intent:'fresh'})` — the durable close journaled the old `createRequestId`, so a preserved identity would inherit the closed state and recovery would omit the new conversation. The Produces entry, the handler sketch's comment, and matrix arm F above state the corrected contract; the other code blocks remain pre-implementation history per this plan's rules.

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

- [ ] **Step 2: Run the spec and verify the intended outcome**

The red-green obligation for this feature is discharged by the per-task focused tests in Tasks 1-4 (each ran RED first against the then-missing behavior). This e2e is the acceptance-level spec for the completed feature: written and first-run AFTER Tasks 3-4 land, its first run on a correct implementation is expected to PASS.

Run (after confirming `FRESHELL_E2E_BACKEND` is set, else ask the user first — see Global Constraints): `npm run test:e2e -- terminal-stuck-rust.spec.ts 2>&1 | tail -15`

Expected: PASS. Any failure is a defect — either the fixture recipe (shim not spawning, env not merged, clock verbs 404) or a product gap the focused tests missed. Diagnose which before changing anything; do NOT treat a fixture accident as a product RED.

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
- Full-suite gate (coordinated, once, after all tasks — per the usual-executing-plans gate procedure): `FRESHELL_TEST_SUMMARY='the-usual wedge-backstop full-suite gate' npm run check` (typecheck + the coordinated full suite). NOTE (round-3 review): `npm test` alone covers neither the typecheck nor the Playwright e2e lane — the gate must include `npm run check` AND the affected e2e spec run from Task 5 (`npm run test:e2e -- terminal-stuck-rust.spec.ts`), all under `set -o pipefail`.

Expected: PASS green excluding baseline-ledger pre-existing failures (none recorded).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/terminal-stuck-rust.spec.ts docs/index.html README.md
git commit -m "test(e2e): terminal stuck backstop coverage + docs mock"
```

---

## Load-bearing validation results (Stage 2 — all claims resolved; see load-bearing-ledger.md + reports/load-bearing-validator-{A,B,C}.md; round-1 review corrections applied below)

1. **LB-1 VERIFIED (measured stream) / ACCEPTABLE (sibling→zombie transfer)** — an independent re-port of the real `NoiseScanner` over the real 18,471-unit capture reproduced the earlier probe's numbers exactly: 17 meaningful (14 bar-composition firsts + 3 text repaints), 0 ring evictions, ring peak 17/32; production wiring gives one PTY read → one classifier frame with no awaits or sustained-stall paths (coalescing fail-open requires ≥1.25 units/read sustained — not producible by the wiring). The zombie's own bytes were never captured — transfer rests on same-binary + the safe fail-open direction (a missed detection, never a false accusation); Task 1's fixture test pins the shape with the real Rust scanner. Residual: a hypothetical ≥18-cell gradient bar would exceed the 32-ring and fail open (same safe direction).
2. **LB-2 — CORRECTED BY ROUND-1 REVIEW (predicate now the two-clock differential)** — the User Request's own constraint text names the signal: "last_meaningful_activity_at stale while last_activity_at stays fresh". The original staleness-only predicate would have flagged prompt-idle panes (both clocks equally stale) — broader than the accepted tradeoff and a violation of "must not alter non-wedged panes". The sweep now requires BOTH meaningful-staleness beyond the window AND raw-activity freshness (`STUCK_ACTIVITY_FRESH_MS` = 5 min): the zombie evidence (lastActivityAt fresh on day 2, continuous 1.4-core render loop, in-flight-write quarantine warnings) shows real wedges keep painting; a pane that stops emitting entirely is no longer a "pure repaint loop" and is not flagged (safe-direction residual, unit-pinned). Still deliberately NO busy/turn-in-flight gate — the zombie class attaches to aborted sessions with no reliable turn state.
3. **LB-3..LB-13 VERIFIED** — two-pass collect-then-apply implementable (LB-3); `broadcast_tx` shape/wiring confirmed (LB-4); selector precedent confirmed (LB-5); `sendTerminalKillAndAwait` exists and is REUSED (LB-6); both kill/ack/respawn frame orderings converge, pinned by the Task 4 test matrix (LB-7); stale-stuck-card race is real — the plan adopts paneId keying with `{at, terminalId}` + clear-on-adoption via `clearTerminalStuckIfOtherTerminal` in the created fold (+ belts in recordTerminalExit/clearTerminalLifecycle/foldTerminalReplacement) (LB-8); the e2e fixture uses the OPENCODE_CMD + enabledProviders recipe (LB-9); the e2e uses the HARNESS-14 test-clock recipe with freeze-after-quiet discipline (LB-10); all wire-contract pins co-move in Task 2's commit, including inventory.rs:51/56/66 and ZOD_BACKED_SERVER_MESSAGES (LB-11); attach emission point after replay/before Exited preserves ordering (LB-12); ws tests drive the sweep via public `register_headless`(past created_at) + `registry.input` (LB-13).

## Round-1 review corrections (all 8 findings dispositioned; see plan-review-log.md)

1. Detection predicate gained the activity-freshness conjunct (Major → CLEARED — the constraint text itself specifies the differential; new unit tests pin prompt-idle non-flagging and freeze-clears-flag).
2. Attach-time emission now carries the current truth in BOTH directions so a reconnecting client reconciles a missed `stuck:false` (Major → CLEARED; reconcile test added).
3. `terminal.kill` is the durable pane-close primitive (unconditional `ledger.close_pane` envelope at terminal.rs:~7882, identity retirement, kill tombstones consulted by recovery suppression — verified first-hand); the stuck restart now sends `terminal.kill{reason:'stuck-recovery'}` whose server branch skips the durable close + retirement so the respawned pane's session stays resumable (Major → CLEARED; both-direction kill tests added: no envelope written, identity resolvable, default close path regression-pinned).
4. Task 2's commit now stages every file it modifies/creates (inventory.rs, freeze test, the new client test) (Major → CLEARED).
5. Task 1's RED step split: the classifier fixture pin (expected PASS as a characterization pin) runs before the registry tests' intended compile-fail RED (Major → CLEARED).
6. Test sketches use the real `input` API — it returns `InputOutcome`, not `Result`; no unwrap (Major → CLEARED).
7. The e2e is acceptance-level: written/first-run after Tasks 3-4, expected PASS on a correct implementation; red-green is discharged by the per-task focused RED tests (Major → CLEARED).
8. The window env parser accepts any integer; 0/negative disables as documented (Minor → CLEARED).
