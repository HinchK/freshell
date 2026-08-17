// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTerminalModeTracker } from '../../../../server/terminal-stream/mode-tracker'

/**
 * Unit pins for the per-terminal emulator-mode tracker. The authoritative
 * cross-language contract is port/oracle/baselines/mode-preamble/README.md;
 * the fixture parity drive lives in mode-preamble-fixtures.test.ts.
 */

const ESC = '\u001b'
const CSI = '\u009b' // C1 CSI opener, equivalent to ESC [
const SET = `${ESC}[?` // CSI ? ... h shorthand pieces
const RST = `${ESC}[`

describe('mode tracker — family slots', () => {
  it('multi-param h lists apply per element, last protocol member wins', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1000;1002;1003h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('last h wins across separate sequences', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h`)
    tracker.scan(`${SET}9h`)
    expect(tracker.synthesize()).toBe(`${SET}9h`)
  })

  it('W-L-W: an l naming ANY family member clears the protocol slot unconditionally', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h`)
    tracker.scan(`${SET}9l`)
    expect(tracker.synthesize()).toBe('')
  })

  it('a multi-param l list clears the family slot and applies other elements flat', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1002h${SET}2004h`)
    tracker.scan(`${SET}9;2004l`)
    expect(tracker.synthesize()).toBe('')
  })

  it('encoding slot (1006/1016) is independent and last-wins within its family', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1006h${SET}1016h${SET}1000h`)
    expect(tracker.synthesize()).toBe(`${SET}1000h${SET}1016h`)
  })

  it('encoding l clears only the encoding slot', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h${SET}1006h`)
    tracker.scan(`${SET}1016l`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('47/1047/1049 fold into one alt slot; leader emits as tracked', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}47h${SET}1049h`)
    expect(tracker.synthesize()).toBe(`${SET}1049h`)
  })

  it('alt l naming any member clears the fold', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1049h`)
    tracker.scan(`${SET}47l`)
    expect(tracker.synthesize()).toBe('')
  })
})

describe('mode tracker — flat DEC private modes', () => {
  it('tracks every other ?Pm as param -> bool, multi-param lists per element', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004;1004h`)
    // ?1004 is tracked but never emitted (xterm re-fires a focus report on
    // every arm → junk input on rehydration; see mode-preamble README).
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('?1004 is tracked but never emitted (xterm fires an immediate focus report on every arm)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1004h`)
    expect(tracker.synthesize()).toBe('')
    tracker.scan(`${SET}1004l`)
    expect(tracker.synthesize()).toBe('')
  })

  it('h after l re-sets', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004h${SET}2004l${SET}2004h`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('empty/invalid param segments are ignored without corrupting later elements', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET};2004h`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('?2026 (synchronized output) is tracked but never emitted', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2026h`)
    expect(tracker.synthesize()).toBe('')
    tracker.scan(`${SET}1003h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('ignores non-private CSI finals entirely', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`plain${RST}2K${RST}1G${RST}0mtext`)
    expect(tracker.synthesize()).toBe('')
  })
})

describe('mode tracker — reset semantics', () => {
  it('RIS clears slots and all flat modes, but leaves ?25 tracking alone', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h${SET}1006h${SET}1049h${SET}2004h${SET}1004h${SET}25h`)
    tracker.scan(`${ESC}c`)
    expect(tracker.synthesize()).toBe(`${SET}25h`)
  })

  it('RIS preserves an explicit cursor-hidden (?25l) tracking', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}25l`)
    tracker.scan(`${ESC}c`)
    expect(tracker.synthesize()).toBe(`${SET}25l`)
  })

  it('DECSTR deletes its table modes from the flat map only (cursor default = visible)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1h${SET}1004h${SET}2004h${SET}1003h${SET}2026h${SET}25l`)
    tracker.scan(`${RST}!p`)
    // Flat ?1/?1004/?2004/?2026/?25 deleted (no trailing ?25l now); protocol
    // slot is NOT part of the DECSTR table and survives.
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('DECSTR leaves encoding and alt slots untouched', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1006h${SET}1049h`)
    tracker.scan(`${RST}!p`)
    expect(tracker.synthesize()).toBe(`${SET}1006h${SET}1049h`)
  })
})

describe('mode tracker — XTMODIFYKEYS resource parsing', () => {
  it('CSI > Pm ; Pv m forms (incl. >4;m / >4;0m clears) never emit and never corrupt', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1000h`)
    tracker.scan(`${RST}>4;1m`)
    tracker.scan(`${RST}>5;2m`)
    tracker.scan(`${RST}>4;m`)
    tracker.scan(`${RST}>5;0m`)
    expect(tracker.synthesize()).toBe(`${SET}1000h`)
  })

  it('garbage > forms are rejected; extra params are accepted but never observable', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h`)
    tracker.scan(`${RST}>m`)
    tracker.scan(`${RST}>x;ym`)
    tracker.scan(`${RST}>4;1;9m`) // extras ignored (parity w/ Rust), still never emitted
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })
})

describe('mode tracker — request finals never mutate', () => {
  it('$p / $y (DECRQM / DECRQSS) finals never set state', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1004$p${SET}2004$y${SET}1003h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('request finals never clear existing state', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004h${SET}2004$p${SET}2004$y`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })
})

describe('mode tracker — scanner robustness', () => {
  it('U+FFFD inside a pending escape aborts it back to ground', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}[?100\ufffd3h${SET}1004h`)
    // ?1004 tracked but never emitted (junk-focus hazard) — scanner recovery is
    // observable via the next emitted marker mode below
    expect(tracker.synthesize()).toBe('')
  })

  it('U+FFFD in ground state is inert', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`abc\ufffd${SET}1007h`)
    expect(tracker.synthesize()).toBe(`${SET}1007h`)
  })

  it('ESC inside a pending CSI aborts it and restarts escape handling', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}[?100${SET}1007h`)
    expect(tracker.synthesize()).toBe(`${SET}1007h`)
  })

  it('C1 CSI opener (U+009B) is equivalent to ESC [', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${CSI}?1003h${CSI}?2004h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h${SET}2004h`)
  })

  it('carries a pending sequence across chunk boundaries (opener split)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`abc${ESC}`)
    tracker.scan(`[?1003h def`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('carries a pending sequence across chunk boundaries (params split)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}[?10`)
    tracker.scan(`03h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h`)
  })

  it('carries a pending sequence across chunk boundaries (final arrives alone)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}[?2004`)
    tracker.scan(`h`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('a pending blob over the 64-code-point carry cap aborts the sequence entirely', () => {
    const tracker = createTerminalModeTracker()
    // 100 param digits: pending exceeds the 64-code-point carry cap (mirrors
    // the output-barrier scanner's limit), so the sequence is aborted to
    // ground — never front-truncated, since this tracker dispatches on the
    // payload prefix and a truncated param list could alias a real mode.
    // The trailing 'h' after abort is ground text, not a final.
    const blob = '9'.repeat(100)
    tracker.scan(`${ESC}[?${blob}h`)
    expect(tracker.synthesize()).toBe('')
    tracker.scan(`${SET}1007h`)
    expect(tracker.synthesize()).toBe(`${SET}1007h`)
  })

  it('an overlong pending blob does not corrupt subsequent chunks', () => {
    const tracker = createTerminalModeTracker()
    const blob = '9'.repeat(100)
    tracker.scan(`${ESC}[?${blob};1003`)
    // The overflow abort landed mid-chunk, so ';1003' above and '9l' below are
    // ground text; the well-formed sequence then parses normally.
    tracker.scan(`9l${SET}2004h`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('a C1 CSI opener restarts a pending sequence', () => {
    const tracker = createTerminalModeTracker()
    // The first sequence never finalizes; the C1 opener starts a fresh
    // sequence whose params alone must apply.
    tracker.scan(`${ESC}[?100${CSI}?2004h`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('ESC c with an intermediate byte is NOT RIS', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004h`)
    tracker.scan(`${ESC}(c`)
    expect(tracker.synthesize()).toBe(`${SET}2004h`)
  })

  it('ESC ESC [ opens CSI (a doubled ESC restarts the escape)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}${ESC}[?1007h`)
    expect(tracker.synthesize()).toBe(`${SET}1007h`)
  })
})

describe('mode tracker — synthesis shape and reset', () => {
  it('enables emit ascending numeric regardless of arrival order', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004h${SET}1003h${SET}1049h${SET}1006h`)
    expect(tracker.synthesize()).toBe(`${SET}1003h${SET}1006h${SET}1049h${SET}2004h`)
  })

  it('explicit ?25l emits a trailing cursor-disable after all enables', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}2004h${SET}25l`)
    expect(tracker.synthesize()).toBe(`${SET}2004h${SET}25l`)
  })

  it('an explicitly tracked ?25h emits as a normal enable (no trailing l)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}25l${SET}25h`)
    expect(tracker.synthesize()).toBe(`${SET}25h`)
  })

  it('empty tracker synthesizes the empty string', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan('just plain text\r\n')
    expect(tracker.synthesize()).toBe('')
  })

  it('reset() returns the projection to defaults (replaceStreamIdentity rebirth)', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${SET}1003h${SET}1049h${SET}25l${ESC}[>4;1m`)
    tracker.reset()
    expect(tracker.synthesize()).toBe('')
  })

  it('reset() also drops any pending partial sequence', () => {
    const tracker = createTerminalModeTracker()
    tracker.scan(`${ESC}[?100`)
    tracker.reset()
    tracker.scan(`3h${SET}1007h`)
    expect(tracker.synthesize()).toBe(`${SET}1007h`)
  })
})
