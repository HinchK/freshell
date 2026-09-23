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
//! access to the capture file. The emitter script below is generated at
//! runtime into a temp dir from these embedded bytes.
//!
//! Observed framing is also checked and reported: at the capture's natural
//! cadence each 87-466 B unit lands in its own blocking read (one frame per
//! unit), so every warm-up frame must be a single complete synchronized-
//! update unit; coalesced reads (2+ units in one frame) are tolerated up to
//! a small fraction and counted, and any partial (split) unit fails loudly.
//!
//! SAFETY: a local scratch PTY child only, SIGKILLed via the registry's own
//! `kill` (group kill) before the temp dir drops. This test never touches
//! the user's live server (:3001) and binds nothing.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_platform::SpawnSpec;
use freshell_protocol::ServerMessage;
use freshell_terminal::{
    build_child_env_from_process, FrameSink, TerminalRegistry, STUCK_ACTIVITY_FRESH_MS,
};

/// The capture's measured active-phase cadence: ~3.3-3.9 units/s.
const UNIT_INTERVAL: Duration = Duration::from_millis(250);

/// Warm-up bound: the 60 embedded units plus at least two census replays,
/// so the ring provably holds every census composition before the flag.
const WARMUP_MIN_FRAMES: usize = 62;
const WARMUP_DEADLINE: Duration = Duration::from_secs(24);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(3);

/// Tiny window for a wall-clock test: far under the 5-minute freshness
/// bound (the merely-exists regime), and — load-bearing for the CLEAR
/// assert — comfortably above the recovery cadence, so the latest recovery
/// line is always fresher than the window at sweep time.
const REAL_PTY_TEST_WINDOW_MS: i64 = 1_000;

const SYNC_BEGIN: &str = "\u{1b}[?2026h";
const SYNC_END: &str = "\u{1b}[?2026l";

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

/// The runtime-generated emitter: splits the units blob on the capture's
/// own synchronized-update wrappers (the documented capture split), plays
/// the 60 units in order at the natural cadence, loops them forever, and —
/// once the sentinel file appears — switches to genuinely-new text lines
/// (a fresh fingerprint per line, so each refreshes the meaningful clock).
/// `os.write(1, ...)` is an unbuffered raw syscall: one write per unit.
/// The first 60 units contain no `\n`/`\r`/TAB (only ESC), so the pty's
/// default OPOST/ONLCR output processing is a no-op and the writes are
/// byte-faithful to the capture.
const EMITTER_SCRIPT: &str = r#"import os
import sys
import time

data = open(sys.argv[2], 'rb').read()
BEGIN = b'\x1b[?2026h'
END = b'\x1b[?2026l'
units = []
i = 0
while True:
    b = data.find(BEGIN, i)
    if b < 0:
        break
    e = data.find(END, b)
    if e < 0:
        break
    units.append(data[b:e + len(END)])
    i = e + len(END)
if not units:
    raise SystemExit(2)

switch = sys.argv[1]
n = 0
meaningful = False
while True:
    if not meaningful and os.path.exists(switch):
        meaningful = True
    if meaningful:
        line = 'recovery line %d: genuinely new content %d\r\n' % (n, n)
        os.write(1, line.encode('utf-8'))
    else:
        os.write(1, units[n % len(units)])
    n = n + 1
    time.sleep(0.25)
"#;

fn collector() -> (FrameSink, Arc<Mutex<Vec<ServerMessage>>>) {
    let seen: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    let sink: FrameSink = Arc::new(move |msg| {
        sink_seen.lock().unwrap().push(msg);
    });
    (sink, seen)
}

fn output_frame_count(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> usize {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|m| matches!(m, ServerMessage::TerminalOutput(_)))
        .count()
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

    // Hermetic scratch dir: emitter script + units blob + sentinel.
    let dir = tempfile::tempdir().expect("temp dir");
    let units_path = dir.path().join("capture-units.bin");
    let mut blob = String::new();
    for unit in OPENCODE_CAPTURE_FIRST_60_UNITS {
        blob.push_str(unit);
    }
    std::fs::write(&units_path, blob).expect("write units blob");
    let switch_path = dir.path().join("switch-to-meaningful");
    let script_path = dir.path().join("emitter.py");
    std::fs::write(&script_path, EMITTER_SCRIPT).expect("write emitter script");

    // The REAL path: create (spawn + reader-thread wiring), mode opencode.
    let spec = SpawnSpec {
        program: "python3".to_string(),
        args: vec![
            script_path.to_string_lossy().into_owned(),
            switch_path.to_string_lossy().into_owned(),
            units_path.to_string_lossy().into_owned(),
        ],
        env_overrides: BTreeMap::new(),
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

    // Warm-up: 60 units + census replays through real read boundaries.
    let warmup_deadline = Instant::now() + WARMUP_DEADLINE;
    loop {
        let n = output_frame_count(&seen);
        if n >= WARMUP_MIN_FRAMES {
            break;
        }
        assert!(
            Instant::now() < warmup_deadline,
            "warm-up stalled: only {n} frames in {WARMUP_DEADLINE:?} \
             (emitter or reader wedged?)"
        );
        std::thread::sleep(UNIT_INTERVAL);
    }

    // Production-framing observation: every warm-up frame must be one
    // complete synchronized-update unit. A coalesced read (2+ units in one
    // frame) is tolerated up to a small fraction (expected zero at this
    // cadence; sustained coalescing is the LB-1 fail-open hazard); any
    // PARTIAL (split) unit is a framing defect and fails loudly.
    let frames = output_frame_data(&seen);
    let warmup_total = frames.len();
    let mut single_unit = 0usize;
    let mut coalesced = 0usize;
    let mut partial = 0usize;
    for data in &frames {
        let begins = data.matches(SYNC_BEGIN).count();
        let full_shape = data.starts_with(SYNC_BEGIN) && data.ends_with(SYNC_END);
        if full_shape && begins == 1 {
            single_unit += 1;
        } else if full_shape {
            coalesced += 1;
        } else {
            partial += 1;
        }
    }
    assert_eq!(
        partial, 0,
        "a real read split a capture unit mid-frame — framing defect"
    );
    assert!(
        coalesced * 10 <= warmup_total,
        "unexpected read coalescing: {coalesced}/{warmup_total} frames"
    );
    eprintln!(
        "stuck_real_pty framing: {warmup_total} frames, {single_unit} single-unit, \
         {coalesced} coalesced, {partial} partial — real reads {} unit-aligned",
        if coalesced == 0 {
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
