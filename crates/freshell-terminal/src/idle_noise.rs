//! Repaint-noise fingerprinting for the idle auto-kill sweep (DEV-0009).
//!
//! Distinguishes MEANINGFUL PTY output (genuinely new content: log lines,
//! streamed response text) from self-generated repaint noise (spinner frames,
//! ticking elapsed-time counters, status-bar redraws) so `enforce_idle_kills`
//! can reap detached terminals that are merely repainting. Detection fails
//! open: anything not provably a repeat of recent content counts as activity.
//!
//! Deliberately SEPARATE from `barrier_scanner.rs` ([PORT RISK — highest]):
//! that scanner decides `terminal.output.batch` merge boundaries and must stay
//! byte-exact with legacy; this one is a port-only addition (no wire-visible
//! output) and must never be merged into it.

/// How many recent distinct frame fingerprints to remember. Sized for the
/// worst REAL repaint cycle measured: codex (0.145.0) renders its "Working"
/// header with a shimmer animation through ratatui cell-diffing, emitting
/// per-frame LETTER-SUBSET runs of the word — ~13–16 distinct fingerprints
/// per ~2 s cycle. A ring of 8 never settles (codex would never be reaped);
/// 32 absorbs the cycle with headroom, and also absorbs read-coalescing
/// multiplicities and split-redraw cycles, while still recognizing genuine
/// new output on its first occurrence. Known fail-open limit (accepted):
/// redraw cycles longer than the ring (e.g. a full-screen repainter under a
/// shrunken `TERMINAL_STREAM_BATCH_MAX_BYTES` env override, floor 1024 B, or
/// a >4 KiB/read noise firehose) classify as meaningful forever — the
/// terminal is simply never reaped, which is the legacy status quo.
const RECENT_FINGERPRINTS: usize = 32;

/// Minimal VT escape-consumption state, persisted ACROSS frames so an escape
/// sequence split at a frame boundary never leaks bytes into the fingerprint.
/// Same mode SET as `barrier_scanner.rs` (without touching that file):
/// OSC/DCS/APC/PM/SOS all share one string-body state because we only need
/// "not Ground", never which string it was. Unlike the barrier scanner we
/// deliberately do NOT track ESC-intermediate bytes (`ESC ( B` etc.): a
/// mishandled charset/single-shift sequence leaks the SAME stray char into
/// the fingerprint on every byte-identical repaint, so fingerprint stability
/// — the only property this scanner needs — is unaffected (verified by
/// hand-traces; see the load-bearing ledger, A4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoiseMode {
    Ground,
    Esc,
    Csi,
    /// Inside an OSC/DCS/APC/PM/SOS string body (until BEL or ESC `\`).
    StringBody,
    /// Saw ESC inside a string body (possible ST terminator).
    StringEsc,
}

/// One frame's content fingerprint: FNV-1a 64 over the frame's significant
/// Ground-mode code points, plus their count (collision belt-and-braces).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    hash: u64,
    count: u32,
}

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Significant = printable Ground content NOT expected to vary between
/// repaints of the same status line. Excluded: whitespace (padding/alignment
/// shifts), ASCII digits (ticking counters, clocks, percentages, token
/// counts), the Braille Patterns block (codex's spinner glyphs), and a small
/// explicit spinner-glyph set: claude's ✻-family INCLUDING `✶` U+2736 (the
/// glyph the real claude 2.1.220 binary uses — it contains zero `✻`), the
/// classic `|/-\` cycle, and the separator bullets `·` U+00B7 / `•` U+2022 /
/// `◦` U+25E6 (codex's status row uses `•` between elapsed time and hint).
/// Stripping affects only the fingerprint — real content always carries
/// letters/punctuation that survive the strip and change the hash.
fn is_significant(ch: char) -> bool {
    if ch.is_whitespace() || ch.is_ascii_digit() {
        return false;
    }
    let cp = ch as u32;
    if (0x2800..=0x28ff).contains(&cp) {
        return false; // Braille Patterns block (braille spinners)
    }
    !matches!(
        ch,
        '✻' | '✽'
            | '✳'
            | '✢'
            | '✶'
            | '·'
            | '•'
            | '◦'
            | '∗'
            | '*'
            | '|'
            | '/'
            | '-'
            | '\\'
            | '●'
            | '○'
            | '◐'
            | '◓'
            | '◑'
            | '◒'
            | '◴'
            | '◵'
            | '◶'
            | '◷'
    )
}

/// Per-terminal repaint-noise fingerprinter. See module docs.
#[derive(Debug)]
pub(crate) struct NoiseScanner {
    mode: NoiseMode,
    /// Ring of the most recent distinct frame fingerprints (FIFO, cap
    /// [`RECENT_FINGERPRINTS`]).
    recent: std::collections::VecDeque<Fingerprint>,
}

impl NoiseScanner {
    pub(crate) fn new() -> Self {
        Self {
            mode: NoiseMode::Ground,
            recent: std::collections::VecDeque::with_capacity(RECENT_FINGERPRINTS),
        }
    }

    /// Feed one PTY output frame. Returns `true` when the frame carries
    /// meaningful new content (refresh the idle reap clock), `false` when it
    /// is repaint noise.
    pub(crate) fn observe(&mut self, data: &str) -> bool {
        let mut hash: u64 = FNV_OFFSET_BASIS;
        let mut count: u32 = 0;
        for ch in data.chars() {
            let cp = ch as u32;
            match self.mode {
                NoiseMode::Ground => {
                    if cp == 0x1b {
                        self.mode = NoiseMode::Esc;
                    } else if cp < 0x20 || cp == 0x7f || (0x80..=0x9f).contains(&cp) {
                        // C0/C1 control (incl. \r \n \t): never significant.
                    } else if is_significant(ch) {
                        let mut buf = [0u8; 4];
                        for b in ch.encode_utf8(&mut buf).bytes() {
                            hash ^= u64::from(b);
                            hash = hash.wrapping_mul(FNV_PRIME);
                        }
                        count = count.saturating_add(1);
                    }
                }
                NoiseMode::Esc => {
                    self.mode = match cp {
                        0x1b => NoiseMode::Esc,
                        c if c == u32::from(b'[') => NoiseMode::Csi,
                        // OSC ] / DCS P / APC _ / PM ^ / SOS X
                        c if c == u32::from(b']')
                            || c == u32::from(b'P')
                            || c == u32::from(b'_')
                            || c == u32::from(b'^')
                            || c == u32::from(b'X') =>
                        {
                            NoiseMode::StringBody
                        }
                        _ => NoiseMode::Ground, // two-char ESC sequence done
                    };
                }
                NoiseMode::Csi => {
                    if (0x40..=0x7e).contains(&cp) {
                        self.mode = NoiseMode::Ground; // final byte
                    }
                    // else: parameter/intermediate byte — stay in Csi.
                }
                NoiseMode::StringBody => {
                    if cp == 0x07 {
                        self.mode = NoiseMode::Ground; // BEL terminator
                    } else if cp == 0x1b {
                        self.mode = NoiseMode::StringEsc;
                    }
                }
                NoiseMode::StringEsc => {
                    self.mode = match cp {
                        c if c == u32::from(b'\\') => NoiseMode::Ground, // ST
                        0x1b => NoiseMode::StringEsc,
                        _ => NoiseMode::StringBody,
                    };
                }
            }
        }

        if count == 0 {
            return false; // pure control/erase/spinner-glyph repaint
        }
        let fp = Fingerprint { hash, count };
        if self.recent.contains(&fp) {
            return false; // same normalized content as a recent frame
        }
        if self.recent.len() == RECENT_FINGERPRINTS {
            self.recent.pop_front();
        }
        self.recent.push_back(fp);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_frame_with_new_text_is_meaningful() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("compiling freshell-terminal v0.1.0\n"));
    }

    #[test]
    fn repeated_identical_status_line_is_noise() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\r\x1b[2Kbuilding... please wait"));
        assert!(!n.observe("\r\x1b[2Kbuilding... please wait"));
        assert!(!n.observe("\r\x1b[2Kbuilding... please wait"));
    }

    #[test]
    fn codex_style_spinner_and_ticking_counter_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        // First paint of the status line is genuinely new content.
        assert!(n.observe("\r\x1b[2K⠋ (1s • esc to interrupt)"));
        // Subsequent repaints differ only in braille glyph + digits.
        assert!(!n.observe("\r\x1b[2K⠙ (2s • esc to interrupt)"));
        assert!(!n.observe("\r\x1b[2K⠹ (3s • esc to interrupt)"));
        assert!(!n.observe("\r\x1b[2K⠸ (12s • esc to interrupt)"));
    }

    #[test]
    fn claude_style_ticking_crunch_line_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\r\x1b[2K✻ Crunched for 5s · 1.2k tokens · esc to interrupt"));
        assert!(!n.observe("\r\x1b[2K✽ Crunched for 6s · 1.3k tokens · esc to interrupt"));
        assert!(!n.observe("\r\x1b[2K✻ Crunched for 17s · 2.0k tokens · esc to interrupt"));
    }

    #[test]
    fn status_bar_clock_redraw_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\x1b[1;70Hbash | 12:34:56"));
        assert!(!n.observe("\x1b[1;70Hbash | 12:34:57"));
        assert!(!n.observe("\x1b[1;70Hbash | 12:35:03"));
    }

    #[test]
    fn pure_cursor_motion_frame_is_noise_even_when_first() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\x1b[2K\x1b[1;1H\x1b[?25l"));
    }

    #[test]
    fn braille_only_spinner_frame_is_noise_even_when_first() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\r⠋"));
        assert!(!n.observe("\r⠙"));
    }

    #[test]
    fn empty_frame_is_noise() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe(""));
    }

    #[test]
    fn distinct_log_lines_are_each_meaningful() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("compiling freshell-terminal v0.1.0\n"));
        assert!(n.observe("warning: unused variable `x`\n"));
        assert!(n.observe("    Finished dev profile\n"));
    }

    #[test]
    fn streamed_response_text_chunks_are_meaningful() {
        // A coding CLI mid-turn streaming a response: every chunk is new prose.
        let mut n = NoiseScanner::new();
        assert!(n.observe("The registry keeps a per-terminal "));
        assert!(n.observe("replay ring whose frames are "));
        assert!(n.observe("classified by a persistent scanner."));
    }

    #[test]
    fn osc_title_payload_never_contributes_to_the_fingerprint() {
        // Terminal-title clock updates are string-body content, not Ground text.
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\x1b]0;bash — 12:34\x07"));
        assert!(!n.observe("\x1b]0;bash — 12:35\x07"));
    }

    #[test]
    fn osc_split_across_frames_does_not_leak_payload_into_fingerprint() {
        let mut n = NoiseScanner::new();
        // Frame boundary lands MID-OSC: a stateless scanner would treat
        // "ock" in the second frame as Ground text and call it meaningful.
        assert!(!n.observe("\x1b]0;my title — cl"));
        assert!(!n.observe("ock\x07"));
    }

    #[test]
    fn csi_split_across_frames_does_not_corrupt_ground_text() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("hello"));
        // "\x1b[2" then "Khello": the K is the CSI final byte, so the second
        // frame's Ground text is exactly "hello" — already in the ring.
        assert!(!n.observe("\x1b[2"));
        assert!(!n.observe("Khello"));
    }

    #[test]
    fn alternating_repaint_cycle_is_noise_via_recent_ring() {
        // A big redraw split into two frames A, B repeating: A B A B ...
        // Comparing only against the immediately-previous frame would see
        // alternation as forever-new; ring membership must not.
        let mut n = NoiseScanner::new();
        let a = "\x1b[1;1Hpane one contents";
        let b = "\x1b[2;1Hstatus bar | ready";
        assert!(n.observe(a));
        assert!(n.observe(b));
        for _ in 0..5 {
            assert!(!n.observe(a));
            assert!(!n.observe(b));
        }
    }

    #[test]
    fn digits_only_change_is_noise() {
        // NOTE: this deliberately encodes ledger decision AD-1 — a workload
        // whose only novelty is numeric (curl/dd meters, numeric step logs)
        // classifies as noise and IS reaped after the threshold. Recorded as
        // an explicit product decision in DEV-0009; do not "fix" this test.
        let mut n = NoiseScanner::new();
        assert!(n.observe("Downloading 45% complete"));
        assert!(!n.observe("Downloading 46% complete"));
        assert!(!n.observe("Downloading 99% complete"));
    }

    #[test]
    fn codex_shimmer_letter_subset_cycle_is_noise_after_first_cycle() {
        // Real codex renders its "Working" header via ratatui cell-diffing
        // with a shimmer effect: each animation frame repaints a different
        // LETTER SUBSET of the word (measured on codex 0.145.0: ~13-16
        // distinct fingerprints per ~2s cycle, repeating). The ring must be
        // large enough to absorb one full cycle; with a ring of 8 these
        // frames churn forever and codex is never reaped.
        let variants: Vec<String> = (0..16)
            .map(|i| {
                let word = "Working";
                let end = 1 + (i % word.len());
                let start = i % end;
                format!(
                    "\x1b[3;5H\x1b[38;2;153;153;153m{}\x1b[39m",
                    &word[start..end]
                )
            })
            .collect();
        let mut n = NoiseScanner::new();
        // First cycle: each distinct subset is new content (fail-open).
        for v in &variants {
            n.observe(v);
        }
        // Every later cycle must classify as pure repaint noise.
        for _ in 0..3 {
            for v in &variants {
                assert!(!n.observe(v));
            }
        }
    }

    #[test]
    fn ring_evicts_oldest_after_capacity() {
        // Pins FIFO eviction: after RECENT_FINGERPRINTS distinct newer
        // frames, the oldest fingerprint is forgotten and counts as new
        // again (fail-open by design). Fillers must differ in LETTERS
        // (digits are stripped from fingerprints), so generate two-letter
        // suffixes. The loop count is RECENT_FINGERPRINTS on purpose; the
        // test pins the constant's semantics, whatever its value.
        let mut n = NoiseScanner::new();
        assert!(n.observe("line zero"));
        for i in 0..RECENT_FINGERPRINTS {
            let c1 = (b'a' + (i / 26) as u8) as char;
            let c2 = (b'a' + (i % 26) as u8) as char;
            assert!(n.observe(&format!("filler {c1}{c2}")));
        }
        assert!(n.observe("line zero"));
    }

    // ── Real-capture byte-faithful pin (delta-review round 4, Finding 2) ──
    //
    // Provenance: the 2026-09-20 capture of a genuinely-wedged opencode TUI
    // pane (~/.local/share/opencode/tool-output/tool_0c12faaa00018kQAHrSI1ySuOc
    // — a single JSON string literal, ~3.0 MB decoded, splitting into 18,471
    // synchronized-update units on `\x1b[?2026h … \x1b[?2026l`).
    //
    // EMBEDDED VERBATIM below (exact capture bytes; ESC escaped as `\x1b`,
    // glyphs kept literal):
    //  * `OPENCODE_CENSUS_UNITS` — the first-occurrence unit of each of the
    //    14 distinct bar compositions, in capture order: the forward
    //    bright-segment walk, the all-dim rest `⬝⬝⬝⬝⬝⬝⬝⬝`, and the reverse
    //    walk including the `⬝■■■■■■⬝` transition composition — the two
    //    census members the pre-round-4 synthetic fixture got wrong (it
    //    substituted an all-bright rest and dropped the reverse-sweep
    //    composition). Each unit is one complete synchronized-update
    //    repaint: cursor-hide, an optional braille spinner cell, the 8-cell
    //    bar at row 38 painted PER-CELL with its own SGR colors, cursor
    //    park.
    //  * `OPENCODE_SPINNER_ONLY_UNIT` — a real spinner-only unit (no bar).
    //  * `OPENCODE_SECOND_SWEEP_UNIT` — a real later repaint of the first
    //    composition with the next sweep's drifted colors.
    //
    // Selection note: these are the FIRST occurrences (capture unit indices
    // 0, 2, 3, 5, 6, 7, 9, 20, 21, 23, 25, 26, 27, 29; spinner-only unit 1;
    // second sweep unit 19) — the shortest complete units that cover the
    // whole census, chosen so the meaningful-first assertions in the test
    // below correspond one-to-one with an independent reimplementation of
    // `NoiseScanner` run over all 18,471 real units: 17 meaningful /
    // 18,454 noise (the 14 composition firsts + 3 genuinely-new text
    // frames), ring peak 17/32, zero evictions.

    /// The 14-composition census cycle, first occurrences, verbatim (see
    /// the provenance block above; entries are
    /// (composition, exact capture unit bytes, capture unit index)).
    const OPENCODE_CENSUS_UNITS: [(&str, &str); 14] = [
        ("⬝⬝■■■■■■", // capture unit 0
         "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠴\x1b[0m\x1b[38;4H\x1b[38;2;59;98;151m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[38;6H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝■■■■■", // capture unit 2
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;55;91;140m\x1b[48;2;10;10;10m⬝⬝⬝\x1b[0m\x1b[38;7H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝⬝■■■■", // capture unit 3
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;51;84;129m\x1b[48;2;10;10;10m⬝⬝⬝⬝\x1b[0m\x1b[38;8H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝⬝⬝■■■", // capture unit 5
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;48;77;118m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝\x1b[0m\x1b[38;9H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝⬝⬝⬝■■", // capture unit 6
         "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠇\x1b[0m\x1b[38;4H\x1b[38;2;44;70;107m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[38;10H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝⬝⬝⬝⬝■", // capture unit 7
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;40;64;97m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[38;11H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝⬝⬝⬝⬝⬝⬝⬝", // capture unit 9 (the all-dim rest)
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;36;57;86m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("⬝■■■■■■⬝", // capture unit 20 (the reverse-sweep transition)
         "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠼\x1b[0m\x1b[38;4H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝\x1b[0m\x1b[38;5H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■■■■■■⬝⬝", // capture unit 21
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;59;98;151m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■■■■■⬝⬝⬝", // capture unit 23
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;58;95;147m\x1b[48;2;10;10;10m⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■■■■⬝⬝⬝⬝", // capture unit 25
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;57;94;145m\x1b[48;2;10;10;10m⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■■■⬝⬝⬝⬝⬝", // capture unit 26
         "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠧\x1b[0m\x1b[38;4H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;56;91;141m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■■⬝⬝⬝⬝⬝⬝", // capture unit 27
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;6H\x1b[38;2;55;90;138m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
        ("■⬝⬝⬝⬝⬝⬝⬝", // capture unit 29
         "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;5H\x1b[38;2;53;87;134m\x1b[48;2;10;10;10m⬝⬝⬝⬝⬝⬝⬝\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l"),
    ];

    /// A real spinner-only unit (capture unit 1 — no bar cells; the
    /// shortest unit class in the capture, 87 UTF-8 bytes / 85 Unicode
    /// characters — the braille glyph occupies three UTF-8 bytes).
    const OPENCODE_SPINNER_ONLY_UNIT: &str = "\x1b[?2026h\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠦\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l";

    /// A real LATER repaint of the first composition (capture unit 19 —
    /// the next sweep's drifted gradient colors over the same significant
    /// content).
    const OPENCODE_SECOND_SWEEP_UNIT: &str = "\x1b[?2026h\x1b[?25l\x1b[38;4H\x1b[38;2;48;77;118m\x1b[48;2;10;10;10m⬝⬝\x1b[0m\x1b[38;6H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;7H\x1b[38;2;97;162;231m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;8H\x1b[38;2;63;105;163m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;9H\x1b[38;2;45;72;110m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;10H\x1b[38;2;33;50;75m\x1b[48;2;10;10;10m■\x1b[0m\x1b[38;11H\x1b[38;2;25;36;52m\x1b[48;2;10;10;10m■\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h\x1b[?2026l";

    #[test]
    fn opencode_tui_gradient_bar_spinner_cycle_is_noise_after_first_sweep() {
        // Feeds the VERBATIM capture units (see the provenance block above
        // the consts) plus the enumerated composition census. ■ U+25A0 /
        // ⬝ U+2B1D are NOT in the strip set — they are each unit's only
        // significant chars.
        assert_eq!(
            OPENCODE_CENSUS_UNITS.len(),
            14,
            "the capture's bar-composition census is exactly 14"
        );
        let mut n = NoiseScanner::new();
        // First sweep: the first occurrence of each census composition is
        // genuinely-new content (fail-open) — INCLUDING the all-dim rest
        // and the ⬝■■■■■■⬝ reverse-sweep transition composition.
        for (composition, unit) in OPENCODE_CENSUS_UNITS {
            assert!(
                n.observe(unit),
                "first occurrence of composition {composition} must be meaningful (fail-open)"
            );
        }
        // Spinner-only unit: zero significant chars — noise even the first
        // time (the count==0 path in `observe`).
        assert!(
            !n.observe(OPENCODE_SPINNER_ONLY_UNIT),
            "spinner-only unit must be noise even when first"
        );
        // A real later repaint of an already-seen composition — the next
        // sweep's drifted gradient colors, same significant content: noise.
        assert!(
            !n.observe(OPENCODE_SECOND_SWEEP_UNIT),
            "a color-drifted later occurrence must be noise"
        );
        // Later sweeps: byte-identical replays are all noise (ring
        // membership).
        for (_, unit) in OPENCODE_CENSUS_UNITS {
            assert!(!n.observe(unit), "later sweeps must be noise");
        }
        // Color-drifted later sweeps: the real capture repaints each sweep
        // with shifted gradient colors — colors ride CSI sequences and
        // must never change a fingerprint. Approximated here by shifting
        // the pane-background `48;2;10;10;10` params (present in every
        // embedded unit); the real drift itself is pinned above by
        // OPENCODE_SECOND_SWEEP_UNIT.
        for cycle in 0..3 {
            let bg = format!("10;{};10", 11 + cycle);
            for (_, unit) in OPENCODE_CENSUS_UNITS {
                let recolored = unit.replace("10;10;10", &bg);
                assert!(!n.observe(&recolored), "cycle {cycle} must be noise");
            }
        }
        // Genuinely-new text still classifies as meaningful (the capture's
        // own recovery moment, verbatim).
        assert!(n.observe("\x1b[?25lquestion is moot. Run task 3 of 4 froze at 18:06:47Z"));
    }
}
