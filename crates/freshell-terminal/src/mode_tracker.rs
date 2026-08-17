//! Per-terminal emulator-mode projection (mode replay-sync) — the Rust half of
//! the cross-language tracker/synthesis contract in
//! `port/oracle/baselines/mode-preamble/README.md` (authoritative; implemented
//! literally) behind the `terminal.modes.sync` preamble.
//!
//! Apps arm DEC private modes (`?1003h` mouse, `?1006h` SGR encoding, `?1049h`
//! alt screen, `?25l` cursor hide, `?2004h` bracketed paste, ...) ONCE at
//! startup; those bytes scroll out of the retained replay window, so a freshly
//! recreated xterm surface reverts to defaults. This tracker scans the SAME
//! decoded output stream the barrier scanner sees (`registry.rs ingest`), keeps
//! a small projection of the emulator's mode state, and synthesizes a preamble
//! the server emits once per surface-reset attach (ordered
//! ready < sync < replay on that socket, direct channel only).
//!
//! ## Scanner domain
//!
//! Decoded STRING domain (post `Utf8StreamDecoder` lossy decode), scanned in
//! code points — same domain as [`crate::barrier_scanner::BarrierScanner`].
//! CSI openers are `ESC [` and C1 `U+009B`. A sequence split across chunks is
//! carried as pending payload, capped at 64 code points (mirroring
//! `CSI_PAYLOAD_SUFFIX_LIMIT`, `barrier_scanner.rs`). `U+FFFD` inside a pending
//! escape ABORTS it and re-enters ground state (it is text, not structure).

use std::collections::HashMap;

use indexmap::IndexMap;
use tracing::warn;

const ESC: char = '\u{001b}';
const CSI_C1: char = '\u{009b}';
const REPLACEMENT_CHARACTER: char = '\u{fffd}';

/// Pending-CSI carry cap in CODE POINTS — mirrors `CSI_PAYLOAD_SUFFIX_LIMIT`
/// (`barrier_scanner.rs`). That scanner keeps a TRAILING suffix window (its
/// payload is only classified by suffix), but this tracker dispatches on the
/// payload's PREFIX (`?`/`>`/`!`), so overflow ABORTS the sequence instead of
/// silently dropping leading bytes — a 64+ code-point mode payload is
/// pathological, and a front-truncated param list could alias a real mode.
const PENDING_CARRY_LIMIT: usize = 64;

/// Hygiene bound on the flat DEC-private map (the fixture/parity scope
/// excludes >128 entries; eviction drops the OLDEST insertion and logs).
const FLAT_MAP_CAPACITY: usize = 128;

/// Family slots (xterm 6.0.0 verified semantics): one mouse protocol slot over
/// {9,1000,1002,1003}, one SGR encoding slot over {1006,1016}, one alt-buffer
/// slot over {47,1047,1049}. `h` sets the slot to the param (last-wins,
/// including multi-param lists); `l` naming ANY family member clears the slot
/// unconditionally (W-L-W law: the reset need not name the leader).
const MOUSE_PROTOCOL_FAMILY: [u32; 4] = [9, 1000, 1002, 1003];
const SGR_ENCODING_FAMILY: [u32; 2] = [1006, 1016];
const ALT_BUFFER_FAMILY: [u32; 3] = [47, 1047, 1049];
/// DECSTR (`CSI ! p`) delete set (verified against xterm 6.0.0): removes these
/// keys from the flat map (an absent ?25 is the ON-DEFAULT cursor-visible
/// state). NOT mouse families, NOT the alt slot, NOT XTMODIFYKEYS.
const DECSTR_MODES: [u32; 8] = [1, 6, 45, 66, 1004, 2004, 2026, 25];
/// Cursor visibility: special ONLY at synthesis (tracked-false emits a trailing
/// `ESC[?25l` after all enables; an explicit true emits as a normal enable in
/// sort order). RIS never touches it; DECSTR deletes it.
const CURSOR_VISIBILITY: u32 = 25;
/// Synchronized output: tracked for fidelity but NEVER synthesized (per-frame
/// rendering hint; arming a wedge-prone mid-frame state on a fresh surface
/// could stall paints; absence is never a user-visible regression).
const SYNCHRONIZED_OUTPUT: u32 = 2026;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Ground,
    /// Saw `ESC`; the carry until the next char disambiguates (`[`, `c`, ...).
    Esc,
    /// Collecting the CSI payload (params + intermediates) up to its final.
    Csi,
}

/// One terminal's emulator-mode projection. Stateful across [`scan`](Self::scan)
/// calls (chunk boundaries carry seamlessly); instantiate ONE per terminal row
/// and feed it the same decoded frames the barrier scanner receives.
#[derive(Debug, Clone)]
pub struct ModeTracker {
    state: ScanState,
    /// The in-progress CSI payload (opener excluded), ≤ [`PENDING_CARRY_LIMIT`]
    /// code points; only meaningful while `state == Csi`.
    csi_payload: String,
    /// Mouse protocol slot: current family leader, if any.
    mouse_protocol: Option<u32>,
    /// SGR mouse encoding slot leader.
    sgr_encoding: Option<u32>,
    /// Alt-buffer slot leader (47/1047 fold into the same state as 1049).
    alt_buffer: Option<u32>,
    /// Every OTHER `?Pm`, param → bool. Insertion-ordered for the 128-entry
    /// eviction; a `false` entry is still tracked (only ?25's false is
    /// synthesis-relevant; the rest cost one slot of hygiene).
    flat: IndexMap<u32, bool>,
    /// XTMODIFYKEYS resource map (`CSI > Pm ; Pv m`; absent/0 Pv clears to 0).
    /// Tracked for fidelity (+ future use), NEVER synthesized (xterm 6.0.0
    /// implements no modifyOtherKeys handling).
    xt_modify_keys: HashMap<u32, u32>,
}

impl Default for ModeTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ModeTracker {
    pub fn new() -> Self {
        Self {
            state: ScanState::Ground,
            csi_payload: String::new(),
            mouse_protocol: None,
            sgr_encoding: None,
            alt_buffer: None,
            flat: IndexMap::new(),
            xt_modify_keys: HashMap::new(),
        }
    }

    /// Scan one decoded output frame (the SAME string the barrier scanner
    /// receives — callers must NOT re-decode bytes). Advances the persistent
    /// state machine, applying mode mutations.
    pub fn scan(&mut self, data: &str) {
        for ch in data.chars() {
            self.step(ch);
        }
    }

    fn step(&mut self, ch: char) {
        match self.state {
            ScanState::Ground => match ch {
                ESC => self.state = ScanState::Esc,
                CSI_C1 => self.enter_csi(),
                // Ground text — including U+FFFD and transparent C0 controls.
                _ => {}
            },
            ScanState::Esc => match ch {
                '[' => self.enter_csi(),
                'c' => {
                    // RIS (`ESC c`): full reset except ?25 (xterm leaves cursor
                    // visibility alone).
                    self.apply_ris();
                    self.enter_ground();
                }
                ESC => {} // re-opened escape: stay in Esc
                CSI_C1 => self.enter_csi(),
                // Abort: U+FFFD or any untracked ESC final/other byte; nothing
                // this tracker models follows ESC but `[` and `c`.
                _ => self.enter_ground(),
            },
            ScanState::Csi => match ch {
                c if is_csi_final(c) => {
                    let payload = std::mem::take(&mut self.csi_payload);
                    self.apply_csi(&payload, c);
                    self.enter_ground();
                }
                ESC => self.enter_esc_from_csi(),
                CSI_C1 => self.enter_csi(),
                REPLACEMENT_CHARACTER => self.enter_ground(), // text, not structure
                c => {
                    self.csi_payload.push(c);
                    if self.csi_payload.chars().count() > PENDING_CARRY_LIMIT {
                        // Abort-on-overflow (see the constant's doc): never
                        // front-truncate a payload we dispatch by prefix.
                        self.enter_ground();
                    }
                }
            },
        }
    }

    fn enter_ground(&mut self) {
        self.state = ScanState::Ground;
        self.csi_payload.clear();
    }
    fn enter_csi(&mut self) {
        self.state = ScanState::Csi;
        self.csi_payload.clear();
    }
    fn enter_esc_from_csi(&mut self) {
        self.state = ScanState::Esc;
        self.csi_payload.clear();
    }

    /// Dispatch one completed CSI sequence. Payload contains parameter bytes
    /// (`0-9 ; < = > ?`) and intermediates (`0x20..=0x2F`); `final_char` drove
    /// the completion. Anything outside the tracked shapes is a no-op, never a
    /// partial parse.
    fn apply_csi(&mut self, payload: &str, final_char: char) {
        match final_char {
            'h' | 'l' => {
                let Some(params) = payload.strip_prefix('?') else {
                    return;
                };
                // DECSET/DECRST carry params only; ANY intermediate byte
                // disqualifies the whole sequence (e.g. `?1003$ h`).
                if !is_param_list(params) {
                    return;
                }
                let set = final_char == 'h';
                for raw in params.split(';') {
                    if raw.is_empty() {
                        continue; // `?1003;;2004h`: apply per element, skip gaps
                    }
                    let Ok(pm) = raw.parse::<u32>() else {
                        continue;
                    };
                    self.apply_dec_private(pm, set);
                }
            }
            'm' => {
                let Some(params) = payload.strip_prefix('>') else {
                    return;
                };
                // XTMODIFYKEYS resource form `> Pm ; Pv m` (`> Pm ; m` /
                // `> Pm ; 0 m` clear to 0). Extra params are ignored.
                if !is_param_list(params) {
                    return;
                }
                let mut it = params.split(';');
                let Some(Ok(pm)) = it.next().map(|s| s.parse::<u32>()) else {
                    return;
                };
                let pv = it
                    .next()
                    .filter(|s| !s.is_empty())
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0);
                self.xt_modify_keys.insert(pm, pv);
            }
            'p' if payload == "!" => self.apply_decstr(),
            // `$p` (DECRQM) / `$y` (DECRQSS) finals fall here and NEVER
            // mutate; every other untracked final is likewise inert.
            _ => {}
        }
    }

    /// Route one DEC private param through the family-slot semantics; anything
    /// outside the three families lands in the flat map.
    fn apply_dec_private(&mut self, pm: u32, set: bool) {
        if MOUSE_PROTOCOL_FAMILY.contains(&pm) {
            self.mouse_protocol = set.then_some(pm);
        } else if SGR_ENCODING_FAMILY.contains(&pm) {
            self.sgr_encoding = set.then_some(pm);
        } else if ALT_BUFFER_FAMILY.contains(&pm) {
            self.alt_buffer = set.then_some(pm);
        } else {
            if !self.flat.contains_key(&pm) && self.flat.len() >= FLAT_MAP_CAPACITY {
                // Insertion-ordered hygiene eviction (README: evict oldest + log).
                if let Some((&evicted, _)) = self.flat.first() {
                    warn!(
                        evicted_mode = evicted,
                        capacity = FLAT_MAP_CAPACITY,
                        "terminal.mode_tracker.flat_eviction"
                    );
                }
                self.flat.shift_remove_index(0);
            }
            // `insert` preserves an existing key's position (order = FIRST
            // insertion) while refreshing the value — the right hygiene order.
            self.flat.insert(pm, set);
        }
    }

    /// RIS (`ESC c`): clear the three family slots, ALL flat modes EXCEPT
    /// `?25` (xterm leaves cursor visibility alone), and the XTMODIFYKEYS map.
    fn apply_ris(&mut self) {
        self.mouse_protocol = None;
        self.sgr_encoding = None;
        self.alt_buffer = None;
        self.xt_modify_keys.clear();
        self.flat.retain(|pm, _| *pm == CURSOR_VISIBILITY);
    }

    /// DECSTR (`CSI ! p`): delete the verified soft-reset set from the flat
    /// map (cursor becomes visible = the absent-key default). Family slots and
    /// the XTMODIFYKEYS map are untouched.
    fn apply_decstr(&mut self) {
        for pm in DECSTR_MODES {
            self.flat.shift_remove(&pm);
        }
    }

    /// Project the current state to sync `data` bytes (the README synthesis
    /// contract): enables ascending numeric as `ESC [ ? Pm h`; a tracked-FALSE
    /// `?25` appends one trailing `ESC [ ? 2 5 l`. `?2026` and XTMODIFYKEYS
    /// are never emitted. Empty when there is nothing to arm (the server skips
    /// emission on empty data).
    pub fn synthesize(&self) -> String {
        let mut enables: Vec<u32> = Vec::new();
        if let Some(pm) = self.mouse_protocol {
            enables.push(pm);
        }
        if let Some(pm) = self.sgr_encoding {
            enables.push(pm);
        }
        if let Some(pm) = self.alt_buffer {
            enables.push(pm);
        }
        let cursor_hidden = matches!(self.flat.get(&CURSOR_VISIBILITY), Some(false));
        for (&pm, &on) in &self.flat {
            if on && pm != SYNCHRONIZED_OUTPUT {
                enables.push(pm);
            }
        }
        enables.sort_unstable();
        let mut out = String::with_capacity(enables.len() * 12 + 8);
        for pm in enables {
            out.push_str("\u{1b}[?");
            out.push_str(&pm.to_string());
            out.push('h');
        }
        if cursor_hidden {
            out.push_str("\u{1b}[?25l");
        }
        out
    }
}

fn is_csi_final(ch: char) -> bool {
    matches!(ch as u32, 0x40..=0x7e)
}

/// A mode-tracked payload body is digits + `;` separators ONLY. Anything else
/// (intermediates like `$`/` `/`!`, negative-sign junk, ...) disqualifies the
/// whole sequence — we never half-parse a mangled one into a mode.
fn is_param_list(params: &str) -> bool {
    params.bytes().all(|b| b.is_ascii_digit() || b == b';')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_after(chunks: &[&str]) -> String {
        let mut t = ModeTracker::new();
        for c in chunks {
            t.scan(c);
        }
        t.synthesize()
    }

    // ── Family slot semantics ────────────────────────────────────────────

    #[test]
    fn mouse_family_last_wins_including_multi_param_and_family_clear_is_unconditional() {
        // Last-wins across separate sequences.
        assert_eq!(synth_after(&["\u{1b}[?9h", "\u{1b}[?1002h"]), "\u{1b}[?1002h");
        // Last-wins within ONE multi-param list (f01 shape, isolated).
        assert_eq!(synth_after(&["\u{1b}[?1000;1002;1003h"]), "\u{1b}[?1003h");
        // W-L-W: the reset need not name the leader.
        assert_eq!(synth_after(&["\u{1b}[?1003h", "\u{1b}[?9l"]), "");
        assert_eq!(synth_after(&["\u{1b}[?9h", "\u{1b}[?1003l"]), "");
    }

    #[test]
    fn encoding_slot_last_wins_and_ignores_foreign_family_resets() {
        // f03: a mouse-family reset must NOT clear the encoding slot.
        assert_eq!(
            synth_after(&["\u{1b}[?1006h", "\u{1b}[?1016h", "\u{1b}[?1000l"]),
            "\u{1b}[?1016h"
        );
        assert_eq!(synth_after(&["\u{1b}[?1016h", "\u{1b}[?1006l"]), "");
    }

    #[test]
    fn alt_family_folds_and_emits_as_tracked() {
        assert_eq!(synth_after(&["\u{1b}[?47h"]), "\u{1b}[?47h");
        // A later family member becomes the leader; emitted as tracked.
        assert_eq!(
            synth_after(&["\u{1b}[?47h", "\u{1b}[?1049h"]),
            "\u{1b}[?1049h"
        );
        // Clear via ANY family member.
        assert_eq!(synth_after(&["\u{1b}[?1049h", "\u{1b}[?47l"]), "");
        assert_eq!(synth_after(&["\u{1b}[?1049h", "\u{1b}[?1049l"]), "");
    }

    #[test]
    fn flat_modes_track_every_other_private_param() {
        assert_eq!(synth_after(&["\u{1b}[?2004h"]), "\u{1b}[?2004h");
        assert_eq!(synth_after(&["\u{1b}[?2004h", "\u{1b}[?2004l"]), "");
        // Mixed multi-param: family members route to slots, others to flat.
        assert_eq!(
            synth_after(&["\u{1b}[?1000;2004h"]),
            "\u{1b}[?1000h\u{1b}[?2004h"
        );
    }

    #[test]
    fn enables_emit_ascending_numeric_order() {
        assert_eq!(
            synth_after(&["\u{1b}[?2004h", "\u{1b}[?1049h", "\u{1b}[?1003h"]),
            "\u{1b}[?1003h\u{1b}[?1049h\u{1b}[?2004h"
        );
    }

    // ── Cursor visibility (?25) ──────────────────────────────────────────

    #[test]
    fn cursor_hidden_false_trails_after_all_enables() {
        assert_eq!(
            synth_after(&["\u{1b}[?2004h", "\u{1b}[?25l"]),
            "\u{1b}[?2004h\u{1b}[?25l"
        );
    }

    #[test]
    fn explicit_25h_emits_as_a_normal_enable() {
        // f13: restoring visibility after a hide is emitted like any enable.
        assert_eq!(synth_after(&["\u{1b}[?25l", "\u{1b}[?25h"]), "\u{1b}[?25h");
    }

    // ── XTMODIFYKEYS ─────────────────────────────────────────────────────

    #[test]
    fn xtmodifykeys_are_tracked_but_never_emitted() {
        // f08 shape plus the `> Pm ; 0 m` clear form.
        assert_eq!(
            synth_after(&["\u{1b}[?1000h", "\u{1b}[>4;1m", "\u{1b}[>5;2m", "\u{1b}[>4;m"]),
            "\u{1b}[?1000h"
        );
        assert_eq!(synth_after(&["\u{1b}[>4;1m", "\u{1b}[>4;0m"]), "");
    }

    // ── DECRQM / DECRQSS guard ───────────────────────────────────────────

    #[test]
    fn request_finals_dollar_p_and_dollar_y_never_mutate() {
        // f12: report queries must not record anything.
        assert_eq!(
            synth_after(&["\u{1b}[?1003h", "\u{1b}[?1004$p", "\u{1b}[?2004$y"]),
            "\u{1b}[?1003h"
        );
    }

    // ── Reset semantics ──────────────────────────────────────────────────

    #[test]
    fn ris_clears_everything_except_cursor_visibility() {
        // f06: slots, alt, flat, XTM all cleared; the ?25 state survives.
        assert_eq!(
            synth_after(&[
                "\u{1b}[?1003h\u{1b}[?1006h",
                "\u{1b}[?25l\u{1b}[?2004h\u{1b}[?1004h\u{1b}[?1049h",
                "\u{1b}c",
            ]),
            "\u{1b}[?25l"
        );
        // ?25 tracked TRUE also survives RIS (xterm leaves it alone).
        assert_eq!(
            synth_after(&["\u{1b}[?25l", "\u{1b}[?25h", "\u{1b}c"]),
            "\u{1b}[?25h"
        );
        // The XTMODIFYKEYS map is cleared as well.
        assert_eq!(synth_after(&["\u{1b}[>4;1m", "\u{1b}c"]), "");
        // RIS split across chunks: ESC in one chunk, 'c' in the next.
        assert_eq!(synth_after(&["\u{1b}[?1003h", "\u{1b}", "c"]), "");
    }

    #[test]
    fn decstr_deletes_the_documented_set_only() {
        // f07: the mouse family + alt + XTM survive; the delete set is removed.
        assert_eq!(
            synth_after(&[
                "\u{1b}[?1h\u{1b}[?1004h\u{1b}[?2004h\u{1b}[?1003h\u{1b}[?2026h\u{1b}[?25l",
                "\u{1b}[!p",
            ]),
            "\u{1b}[?1003h"
        );
        // ?25 deletion = cursor-visible default: no trailing ?25l either.
        assert_eq!(synth_after(&["\u{1b}[?25l", "\u{1b}[!p"]), "");
        // The alt slot and the XTMODIFYKEYS map are not in the delete set.
        assert_eq!(
            synth_after(&["\u{1b}[?1049h", "\u{1b}[>4;1m", "\u{1b}[!p"]),
            "\u{1b}[?1049h"
        );
        // DECSTR via the C1 CSI opener.
        assert_eq!(synth_after(&["\u{1b}[?1004h", "\u{9b}!p"]), "");
    }

    // ── Scanner mechanics ────────────────────────────────────────────────

    #[test]
    fn c1_csi_opener_is_equivalent_to_esc_bracket() {
        // f10: U+009B openers, synthesized as canonical ESC[ bytes.
        assert_eq!(
            synth_after(&["\u{9b}?1003h\u{9b}?2004h"]),
            "\u{1b}[?1003h\u{1b}[?2004h"
        );
        // C1 opener split from its payload across chunks.
        assert_eq!(synth_after(&["\u{9b}", "?2004h"]), "\u{1b}[?2004h");
    }

    #[test]
    fn chunk_boundary_carry_completes_split_sequences() {
        // f09: a sequence split mid-payload; ESC split from its '['.
        assert_eq!(
            synth_after(&[
                "abc\u{1b}[?100",
                "3h def \u{1b}",
                "[?2004h more \u{1b}[?104",
                "9h tail",
            ]),
            "\u{1b}[?1003h\u{1b}[?1049h\u{1b}[?2004h"
        );
    }

    #[test]
    fn replacement_character_aborts_a_pending_escape() {
        // f11: U+FFFD is text, not structure; the poisoned escape never
        // half-parses, and later well-formed sequences still apply.
        assert_eq!(
            synth_after(&[
                "\u{1b}[?100\u{fffd}3h\u{1b}[?1004h",
                "\u{fffd}\u{1b}[?10",
                "06h",
            ]),
            "\u{1b}[?1004h\u{1b}[?1006h"
        );
        // Ground-state U+FFFD in isolation is harmless text.
        assert_eq!(synth_after(&["plain \u{fffd} text"]), "");
        // U+FFFD after a bare ESC aborts it (an ESC[ opener never forms).
        assert_eq!(synth_after(&["\u{1b}\u{fffd}[?1003h"]), "");
    }

    #[test]
    fn esc_inside_a_pending_escape_restarts_it() {
        // The aborted partial sequence must not half-parse; the restart wins.
        assert_eq!(synth_after(&["\u{1b}[?10\u{1b}[?25h"]), "\u{1b}[?25h");
        // A C1 CSI likewise restarts a pending ESC[ sequence.
        assert_eq!(synth_after(&["\u{1b}[?10\u{9b}?1003h"]), "\u{1b}[?1003h");
    }

    #[test]
    fn pending_carry_beyond_64_code_points_aborts_the_sequence() {
        let long_payload = format!("\u{1b}[?1003{}", ";0".repeat(40)); // ~80 cp of params
        // Overflow aborts: none of the params in the overlong sequence apply
        // (the 'h' arrives in ground as text), and the NEXT well-formed
        // sequence still works.
        assert_eq!(
            synth_after(&[&long_payload, "h\u{1b}[?2004h"]),
            "\u{1b}[?2004h"
        );
    }

    #[test]
    fn junk_payloads_and_non_private_modes_do_not_mutate_dec_private_state() {
        // Plain CSI (SGR, erases, cursor moves) carries no mode state.
        assert_eq!(synth_after(&["\u{1b}[31m\u{1b}[2K\u{1b}[1;1H"]), "");
        // Intermediates in a ?-prefixed sequence are not DECSET/DECRST — the
        // sequence is dropped wholesale (never half-parsed into a mode).
        assert_eq!(synth_after(&["\u{1b}[?1003$h", "\u{1b}[?1003 h"]), "");
        // Non-numeric/empty params in a list are skipped elementwise.
        assert_eq!(
            synth_after(&["\u{1b}[?1003;;2004h"]),
            "\u{1b}[?1003h\u{1b}[?2004h"
        );
    }

    // ── Synthesis hygiene ────────────────────────────────────────────────

    #[test]
    fn synchronized_output_2026_is_tracked_but_never_emitted() {
        assert_eq!(synth_after(&["\u{1b}[?2026h"]), "");
        assert_eq!(
            synth_after(&["\u{1b}[?2026h", "\u{1b}[?1003h"]),
            "\u{1b}[?1003h"
        );
    }

    #[test]
    fn synthesis_is_empty_for_plain_text() {
        assert_eq!(synth_after(&["just plain text\r\nno escapes here\r\n"]), "");
    }

    #[test]
    fn flat_map_evicts_oldest_beyond_128_entries_with_log_line() {
        let mut t = ModeTracker::new();
        for pm in 0..(FLAT_MAP_CAPACITY as u32 + 1) {
            // Params 9000+ are in no family; each is a distinct flat entry.
            t.scan(&format!("\u{1b}[?{}h", 9000 + pm));
        }
        let sync = t.synthesize();
        // 129 inserts into a 128-capacity map: the first param is evicted,
        // the rest remain, exactly at capacity.
        assert!(
            !sync.contains(&format!("\u{1b}[?{}h", 9000)),
            "oldest flat entry must be evicted: {sync}"
        );
        assert!(sync.contains(&format!("\u{1b}[?{}h", 9000 + FLAT_MAP_CAPACITY as u32)));
        assert_eq!(
            sync.matches('\u{1b}').count(),
            FLAT_MAP_CAPACITY,
            "exactly capacity entries remain: {sync:?}"
        );
    }

    // ── Cross-language fixture contract ──────────────────────────────────
    //
    // `port/oracle/baselines/mode-preamble/*.json` is THE shared tracker +
    // synthesis contract (`README.md` there): feed `chunks` in order through
    // this tracker's scan path directly, then synthesize and compare exactly.
    // `surfaceReset == false` fixtures are SERVER-gating cases (the registry
    // must not emit terminal.modes.sync regardless of tracker state) — that
    // gating is asserted in registry.rs tests; the pure tracker is flag-free.

    #[test]
    fn mode_preamble_baseline_fixtures_match_expected_synthesis() {
        use std::path::PathBuf;


        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../port/oracle/baselines/mode-preamble");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("fixture dir {dir:?} unreadable: {e}"))
            .map(|e| e.expect("dir entry").path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        assert!(
            files.len() >= 15,
            "expected at least the f01..f15 fixture family, found {}",
            files.len()
        );

        for path in files {
            let raw =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?} unreadable: {e}"));
            let v: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path:?} bad json: {e}"));
            let name = v["name"].as_str().expect("fixture name").to_string();
            let chunks: Vec<&str> = v["chunks"]
                .as_array()
                .expect("chunks array")
                .iter()
                .map(|c| c.as_str().expect("chunk string"))
                .collect();
            let surface_reset = v["surfaceReset"].as_bool().expect("surfaceReset bool");
            let expected = v["expectedSyncData"].as_str().expect("expectedSyncData string");

            let mut tracker = ModeTracker::new();
            for chunk in chunks {
                tracker.scan(chunk);
            }
            let synthesized = tracker.synthesize();

if !surface_reset {
                // Server-gating fixture (f14): emission suppression lives in
                // the registry's attach path, not the tracker. Skip here.
                continue;
            }
            assert_eq!(
                synthesized, expected,
                "{name}: synthesized preamble must equal expectedSyncData byte-for-byte"
            );
        }
    }
}
