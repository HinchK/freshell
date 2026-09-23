//! Wedge-backstop episode-3 r3, Finding 1: the REAL-PTY production-framing
//! proof for the capture signal.
//!
//! The byte-faithful fixture (`idle_noise.rs`'s `OPENCODE_*` units) feeds
//! hand-separated synchronized-update units directly to
//! `NoiseScanner::observe`. Production sees no such courtesy: the real PTY
//! reader thread (`pty.rs` `spawn_reader`) does blocking 8 KiB reads whose
//! boundaries are whatever the child and the kernel produce, and `ingest`
//! classifies whatever each read framed. This test closes that gap: a REAL
//! pty (`TerminalRegistry::create`, mode "opencode") whose child EMITS the
//! verbatim capture units — the first 60 synchronized-update units of the
//! 2026-09-20 wedged-opencode capture (read-only at
//! `~/.local/share/opencode/tool-output/tool_0c12faaa00018kQAHrSI1ySuOc`;
//! the capture file itself is never committed) — at the capture's measured
//! active-phase cadence (~250 ms/unit), then keeps repainting them forever,
//! then switches to genuinely-new text lines once a sentinel file appears.
//!
//! DEPENDENCY-FREE EMITTER (episode-3 r4, review Finding 4): the pty child
//! is THIS TEST BINARY re-exec'd — the parent spawns
//! `std::env::current_exe()` with `--exact stuck_real_pty_emitter_child`
//! and `FRESHELL_STUCK_TEST_EMITTER=1` (the standard Rust self-reexec
//! pattern), so the child's harness runs ONLY the embedded emitter test,
//! which writes the embedded units to raw stdout at the cadence when the
//! magic env var is set (and no-ops in a normal harness run). No python3 —
//! not a documented prerequisite on the supported native-Windows/macOS dev
//! hosts — no fixture files, no network. The child's libtest banner
//! ("running 1 test", "test stuck_real_pty_emitter_child ... ") precedes
//! the units on the pty stream: it is plain text (a one-time meaningful
//! refresh at t≈0, before the census firsts) and shows up as at most a
//! couple of banner-only frames ahead of the unit stream — counted under
//! `non_unit` in the framing report below.
//!
//! The load-bearing asserts: after the ring warms through REAL reads,
//! `enforce_stuck_detection` FLAGS the row — the wedge differential holds
//! through production framing (the classifier treats the real repaint
//! stream as noise, so `last_meaningful_output_at` froze at the last census
//! first while `last_output_activity_at` keeps flowing, and the raw clock
//! sits strictly past the frozen meaningful one) — and the switch to
//! genuinely-new text CLEARS it. If real reads ever coalesced units into
//! fail-open classification (the LB-1 hazard), the flag assert would fail:
//! that is a genuine discovery about the production seam, not a test defect
//! — do not weaken the test or touch `NoiseScanner`/`RECENT_FINGERPRINTS`.
//!
//! Hermetic by construction: the embedded slice includes ALL 14 bar-
//! composition census firsts (capture unit indices 0, 2, 3, 5, 6, 7, 9,
//! 20, 21, 23, 25, 26, 27, 29; verified by an independent `NoiseScanner`
//! reimplementation over these exact 60 units: exactly those 14 classify
//! meaningful, ring peak 14/32, every replay noise), so the test needs no
//! access to the capture file.
//!
//! Observed framing is checked and REPORTED (episode-3 r4, review
//! Finding 3): a PTY read may LEGALLY split a child write, and the
//! scanner's persistent cross-frame VT state machine stitches mid-unit
//! splits — so SPLIT frames are tolerated and recorded (counters +
//! eprintln), never a hard precondition. What IS asserted away is
//! SUSTAINED multi-unit coalescing — frames carrying two-or-more full
//! units must stay a small minority (the documented fail-open regime: a
//! two-unit frame is a novel fingerprint that refreshes the meaningful
//! clock; if most frames coalesced, the ring could never warm and the
//! load-bearing flag assert would fail — this assert names that regime
//! explicitly instead of leaving it to the flag assert's message). All
//! counters are eprintln'd for diagnostics.
//!
//! SAFETY: a local scratch PTY child only, SIGKILLed via the registry's own
//! `kill` (group kill) before the temp dir drops. This test never touches
//! the user's live server (:3001) and binds nothing.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_platform::SpawnSpec;
use freshell_protocol::ServerMessage;
use freshell_terminal::{
    build_child_env_from_process, FrameSink, TerminalRegistry, STUCK_ACTIVITY_FRESH_MS,
};

/// The capture's measured active-phase cadence: ~3.3-3.9 units/s.
const UNIT_INTERVAL: Duration = Duration::from_millis(250);

/// Warm-up bound: the 60 embedded units plus at least two census replays.
/// Counted in COMPLETE units observed across frames (not raw frames), so
/// the re-exec child's libtest banner frames (see the module docs) cannot
/// eat into the margin.
const WARMUP_MIN_UNITS: usize = 62;
const WARMUP_DEADLINE: Duration = Duration::from_secs(24);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(3);

/// Coalescing tolerance (r4 Finding 3): frames carrying 2+ full units
/// ("multi-unit" frames — the LB-1 fail-open regime) must stay a small
/// minority of observed frames; a sustained majority would mean the reader
/// runs behind the emitter and the ring could never warm.
const COALESCED_FRACTION_DENOM: usize = 10;

/// Tiny window for a wall-clock test: far under the 5-minute freshness
/// bound (the merely-exists regime), and — load-bearing for the CLEAR
/// assert — comfortably above the recovery cadence, so the latest recovery
/// line is always fresher than the window at sweep time.
const REAL_PTY_TEST_WINDOW_MS: i64 = 1_000;

const SYNC_BEGIN: &str = "\u{1b}[?2026h";
const SYNC_END: &str = "\u{1b}[?2026l";

/// Self-reexec contract (module docs): the parent spawns `current_exe()`
/// with `--exact <EMITTER_TEST_NAME>` and these env vars, so the child
/// harness runs ONLY the emitter test; the emitter performs the child role
/// when [`EMITTER_ENV`] is set and no-ops in a normal harness run.
const EMITTER_TEST_NAME: &str = "stuck_real_pty_emitter_child";
const EMITTER_ENV: &str = "FRESHELL_STUCK_TEST_EMITTER";
const EMITTER_SWITCH_ENV: &str = "FRESHELL_STUCK_TEST_EMITTER_SWITCH";

/// The capture's first 60 synchronized-update units, verbatim (see the module
/// provenance docs above). Extracted read-only from the 2026-09-20 wedged-
/// opencode capture; the capture file itself is never committed.
const OPENCODE_CAPTURE_FIRST_60_UNITS: [&str; 60] = [
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠴\x1b[0m\x1b[38;4H\x1b[38;2;59;98;151m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[38;6H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠦\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;55;91;140m\x1b[48;2;10;10;10m⬝⬝⬝\x1b[0m\x1b[38;7H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;51;84;129m\x1b[48;2;10;10;10m⬝⬝⬝⬝\x1b[0m\x1b[38;8H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠧\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;48;77;118m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝\x1b[0m\x1b[38;9H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠇\x1b[0m\x1b[38;4H\x1b[38;2;44;70;107m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[38;10H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;40;64;97m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[38;11H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠏\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;36;57;86m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠋\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;29;43;63m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠙\x1b[0m\x1b[38;4H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[38;10H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;31;47;69m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝\x1b[0m\x1b[38;9H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠹\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;36;57;86m\x1b[48;2;10;10;10m⬝⬝⬝⬝\x1b[0m\x1b[38;8H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;42;67;101m\x1b[48;2;10;10;10m⬝⬝⬝\x1b[0m\x1b[38;7H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠸\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;48;77;118m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[38;6H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠼\x1b[0m\x1b[38;4H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝\x1b[0m\x1b[38;5H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;59;98;151m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠴\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;58;95;147m\x1b[48;2;10;10;10m⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠦\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;57;94;145m\x1b[48;2;10;10;10m⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠧\x1b[0m\x1b[38;4H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;56;91;141m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;55;90;138m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠇\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;52;86;132m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠏\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;51;83;128m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠋\x1b[0m\x1b[38;4H\x1b[38;2;50;81;124m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;49;79;122m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠙\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;48;77;118m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;47;75;115m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠹\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;45;73;111m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠸\x1b[0m\x1b[38;4H\x1b[38;2;44;71;109m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;43;69;105m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠼\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;42;67;101m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;41;65;98m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠴\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;40;63;95m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠦\x1b[0m\x1b[38;4H\x1b[38;2;39;61;92m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;37;59;88m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠧\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;36;57;86m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;35;55;82m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠇\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;34;52;78m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠏\x1b[0m\x1b[38;4H\x1b[38;2;33;51;75m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;32;48;72m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠋\x1b[0m\x1b[38;4H\x1b[38;2;31;47;69m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;29;44;65m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠙\x1b[0m\x1b[38;4H\x1b[38;2;28;43;63m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
    "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;27;40;59m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l",
];

/// The emitter child role (module docs): when the parent re-execs this test
/// binary as the pty child, the harness runs only this test; the magic env
/// var routes it to the child role — write the embedded units to raw stdout
/// at the capture cadence forever, then switch to genuinely-new text lines
/// once the sentinel file appears (each line a fresh fingerprint, so each
/// refreshes the meaningful clock). In a NORMAL harness run (the flag
/// unset) it is a fast no-op. `write_all` + `flush` on the locked stdout is
/// one unbuffered write per unit (the units contain no `\n`, so the
/// LineWriter cannot split early; `io::Write` bypasses libtest's per-test
/// output capture and hits fd 1 directly — exactly the raw
/// `os.write(1, ...)` contract the retired python emitter had). The first
/// 60 units contain no `\n`/`\r`/TAB (only ESC), so the pty's default
/// OPOST/ONLCR output processing is a no-op on them and the writes are
/// byte-faithful to the capture; the recovery lines end `\r\n` as before.
#[test]
fn stuck_real_pty_emitter_child() {
    if std::env::var_os(EMITTER_ENV).is_none() {
        return;
    }
    let switch = std::env::var_os(EMITTER_SWITCH_ENV).unwrap_or_else(|| {
        panic!("{EMITTER_SWITCH_ENV} not set — miswired self-reexec parent spawn")
    });
    let switch = std::path::PathBuf::from(switch);
    let mut out = std::io::stdout().lock();
    let mut n: usize = 0;
    loop {
        let bytes: Vec<u8> = if switch.exists() {
            format!("recovery line {n}: genuinely new content {n}\r\n").into_bytes()
        } else {
            OPENCODE_CAPTURE_FIRST_60_UNITS[n % OPENCODE_CAPTURE_FIRST_60_UNITS.len()]
                .as_bytes()
                .to_vec()
        };
        out.write_all(&bytes).expect("emitter stdout write");
        out.flush().expect("emitter stdout flush");
        n += 1;
        std::thread::sleep(UNIT_INTERVAL);
    }
}

fn collector() -> (FrameSink, Arc<Mutex<Vec<ServerMessage>>>) {
    let seen: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    let sink: FrameSink = Arc::new(move |msg| {
        sink_seen.lock().unwrap().push(msg);
    });
    (sink, seen)
}

fn output_frame_data(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            ServerMessage::TerminalOutput(o) => Some(o.data.clone()),
            _ => None,
        })
        .collect()
}

/// How many complete `SYNC_BEGIN..SYNC_END` synchronized-update units live
/// FULLY inside one production-read frame. Units never nest (each wraps
/// itself exactly once), so a left-to-right span walk is exact; a unit the
/// pty split across frames contributes zero here (its halves are counted
/// as fragments by [`frame_fragments`]).
fn complete_units_in(data: &str) -> usize {
    let mut units = 0;
    let mut rest = data;
    while let Some(b) = rest.find(SYNC_BEGIN) {
        let after = &rest[b + SYNC_BEGIN.len()..];
        match after.find(SYNC_END) {
            Some(e) => {
                units += 1;
                rest = &after[e + SYNC_END.len()..];
            }
            None => break,
        }
    }
    units
}

/// How many sync markers live in the frame OUTSIDE its complete units —
/// the fragments of a unit the pty split across reads (a dangling
/// `SYNC_BEGIN` head, an orphan `SYNC_END` tail). Zero for whole-unit
/// frames and plain-text frames alike.
fn frame_fragments(data: &str) -> usize {
    let begins = data.matches(SYNC_BEGIN).count();
    let ends = data.matches(SYNC_END).count();
    begins + ends - 2 * complete_units_in(data)
}

/// One whole test, in order: warm the ring through real reads, flag, then
/// clear on meaningful output. ~18 s nominal, hard-bounded under 30 s.
#[test]
fn real_pty_capture_stream_flags_stuck_and_clears_on_meaningful() {
    let reg = TerminalRegistry::new();
    reg.set_stuck_window_ms(REAL_PTY_TEST_WINDOW_MS);
    assert!(
        reg.stuck_window_ms() < STUCK_ACTIVITY_FRESH_MS,
        "precondition: the window sits inside the merely-exists regime"
    );

    // Hermetic scratch dir: the sentinel file only — the python-era emitter
    // script and units blob are gone; the re-exec child carries the embedded
    // units in this very binary.
    let dir = tempfile::tempdir().expect("temp dir");
    let switch_path = dir.path().join("switch-to-meaningful");

    // The REAL path, dependency-free (r4 Finding 4): re-exec THIS test
    // binary as the pty child. `--exact` makes the child's harness run
    // ONLY the embedded emitter test; the magic env var routes it to the
    // child role (module docs). An absolute `current_exe()` needs no PATH
    // resolution.
    let exe = std::env::current_exe().expect("current exe");
    let spec = SpawnSpec {
        program: exe.to_string_lossy().into_owned(),
        args: vec!["--exact".to_string(), EMITTER_TEST_NAME.to_string()],
        env_overrides: BTreeMap::from([
            (EMITTER_ENV.to_string(), "1".to_string()),
            (
                EMITTER_SWITCH_ENV.to_string(),
                switch_path.to_string_lossy().into_owned(),
            ),
        ]),
        cwd: Some(dir.path().to_string_lossy().into_owned()),
        cols: 120,
        rows: 30,
    };
    let env = build_child_env_from_process(&spec);
    reg.create(
        &spec,
        &env,
        "T-real".to_string(),
        "S-real".to_string(),
        "opencode",
        None,
        None,
        None,
        None,
    )
    .expect("real pty create");

    // Attach a collector (replay + live): the public window into what the
    // production reader thread actually framed.
    let (sink, seen) = collector();
    assert!(
        reg.attach(
            "T-real",
            1,
            sink,
            Some("att-real".into()),
            0,
            false,
            None,
            None
        )
        .found
    );

    // Warm-up: the 60 units + census replays through real read boundaries,
    // counted in COMPLETE units observed across frames — the re-exec child's
    // libtest banner frames are plain text and must not eat the margin.
    let warmup_deadline = Instant::now() + WARMUP_DEADLINE;
    let frames = loop {
        let frames = output_frame_data(&seen);
        let units_seen: usize = frames.iter().map(|d| complete_units_in(d)).sum();
        if units_seen >= WARMUP_MIN_UNITS {
            break frames;
        }
        assert!(
            Instant::now() < warmup_deadline,
            "warm-up stalled: only {units_seen} complete units in {WARMUP_DEADLINE:?} \
             (emitter or reader wedged?)"
        );
        std::thread::sleep(UNIT_INTERVAL);
    };

    // Production-framing observation (r4 Finding 3): PTY reads may legally
    // split a child write, and the scanner's persistent cross-frame VT
    // state machine stitches mid-unit splits — so SPLIT frames are
    // tolerated and recorded, never a hard precondition. What must not
    // happen is SUSTAINED multi-unit coalescing: a frame carrying two or
    // more FULL units is the LB-1 fail-open regime.
    let mut single_unit = 0usize;
    let mut multi_unit = 0usize;
    let mut split = 0usize;
    let mut non_unit = 0usize;
    for data in &frames {
        let units = complete_units_in(data);
        if units >= 2 {
            multi_unit += 1;
        } else if frame_fragments(data) > 0 {
            split += 1;
        } else if units == 1 {
            single_unit += 1;
        } else {
            non_unit += 1;
        }
    }
    let warmup_total = frames.len();
    assert!(
        multi_unit * COALESCED_FRACTION_DENOM <= warmup_total,
        "sustained read coalescing (the fail-open regime): {multi_unit}/{warmup_total} \
         frames carry two or more full units"
    );
    eprintln!(
        "stuck_real_pty framing: {warmup_total} frames, {single_unit} single-unit, \
         {multi_unit} multi-unit, {split} split (tolerated), \
         {non_unit} non-unit (child harness banner) — real reads {} unit-aligned",
        if multi_unit == 0 && split == 0 {
            "stayed"
        } else {
            "mostly stayed"
        }
    );

    // THE LOAD-BEARING ASSERT: the wedge differential holds through real
    // pty reads — the classifier judged the real repaint stream noise, so
    // the meaningful clock froze at the last census first while raw output
    // kept flowing strictly past it.
    let transitions = reg.enforce_stuck_detection();
    assert_eq!(
        transitions.len(),
        1,
        "the real-capture repaint stream must produce exactly one flag \
         transition (0 = the classifier fail-opened through real reads — a \
         genuine production-framing discovery, not a test defect)"
    );
    assert!(transitions[0].stuck);
    assert_eq!(transitions[0].terminal_id, "T-real");
    assert_eq!(transitions[0].mode, "opencode");
    // Idempotent while the repaint loop continues.
    assert!(reg.enforce_stuck_detection().is_empty());

    // Clear-on-meaningful: flip the sentinel; the emitter switches to
    // genuinely-new text lines, each refreshing the meaningful clock.
    std::fs::write(&switch_path, b"1").expect("arm sentinel");
    let recovery_deadline = Instant::now() + RECOVERY_DEADLINE;
    loop {
        if output_frame_data(&seen)
            .iter()
            .any(|data| data.contains("recovery line"))
        {
            break;
        }
        assert!(
            Instant::now() < recovery_deadline,
            "no recovery frame arrived within {RECOVERY_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let cleared = reg.enforce_stuck_detection();
    assert_eq!(cleared.len(), 1, "meaningful output must clear the flag");
    assert!(!cleared[0].stuck);
    assert_eq!(cleared[0].terminal_id, "T-real");
    // Idempotent while meaningful output keeps flowing.
    assert!(reg.enforce_stuck_detection().is_empty());

    // Cleanup: the registry's own kill (group SIGKILL), then drop the dir.
    assert!(reg.kill("T-real"));
    let _ = dir.close();
}
