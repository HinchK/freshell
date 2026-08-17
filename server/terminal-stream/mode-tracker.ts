import { logger } from '../logger.js'

const log = logger.child({ component: 'terminal-mode-tracker' })

/**
 * Per-terminal emulator-mode tracker.
 *
 * Scans the terminal's decoded output stream (string domain — node-pty's
 * UTF-8 decode) and maintains a projection of the DEC private mode state a
 * freshly constructed xterm surface needs re-asserted. The authoritative
 * contract — scanner domain, family-slot rules, reset tables, synthesis —
 * is port/oracle/baselines/mode-preamble/README.md, pinned cross-language by
 * that directory's f01..f15 fixtures. Implementations must not add parsing
 * behavior beyond that spec (both servers behave identically by construction).
 *
 * State model:
 * - mouse protocol slot over {9, 1000, 1002, 1003}: `?Pm h` sets (last-wins,
 *   multi-param lists apply per element in order); `?Pm l` naming ANY family
 *   member clears the slot unconditionally (W-L-W law).
 * - SGR encoding slot over {1006, 1016}: same rules.
 * - alt buffer slot over {47, 1047, 1049}: same rules; leader emits as tracked.
 * - every other `?Pm`: flat insertion-ordered map of param -> bool, capped at
 *   FLAT_MODE_LIMIT entries with oldest-entry eviction (logged).
 * - XTMODIFYKEYS resource map (`CSI > Pm ; Pv m`; `>Pm;m` / `>Pm;0m` clear to
 *   0): tracked for fidelity, never synthesized (xterm 6.0.0 has no
 *   modifyOtherKeys handling).
 * - `$p`/`$y` finals (DECRQM/DECRQSS) never mutate state.
 *
 * Resets (tables verified against xterm 6.0.0 InputHandler):
 * - RIS (`ESC c`): clears both slots, the alt slot, all flat modes EXCEPT ?25
 *   (xterm leaves cursor visibility alone), and the XTMODIFYKEYS map.
 * - DECSTR (`CSI ! p`): deletes {1, 6, 45, 66, 1004, 2004, 2026, 25} from the
 *   flat map; touches neither the family slots nor the XTMODIFYKEYS map.
 */
export type TerminalModeTracker = {
  scan(data: string): void
  synthesize(): string
  reset(): void
}

const ESC = 0x1b
const CSI = 0x9b
const REPLACEMENT_CHARACTER = 0xfffd

// Carry budget between scan() calls, mirroring the output-barrier scanner's
// CSI_PAYLOAD_SUFFIX_LIMIT; counted in code points (README: "at most 64 code
// points of pending bytes between chunks"). That scanner keeps a TRAILING
// suffix window (its payload is only classified by suffix), but this tracker
// dispatches on the payload's PREFIX (`?`/`>`/`!`), so overflow ABORTS the
// sequence instead of silently dropping leading bytes — a 64+ code-point mode
// payload is pathological, and a front-truncated param list could alias a
// real mode. (Parity: crates/freshell-terminal/src/mode_tracker.rs aborts
// identically.)
const CSI_PENDING_CODE_POINT_LIMIT = 64
const FLAT_MODE_LIMIT = 128

const MOUSE_PROTOCOL_FAMILY = new Set([9, 1000, 1002, 1003])
const SGR_ENCODING_FAMILY = new Set([1006, 1016])
const ALT_BUFFER_FAMILY = new Set([47, 1047, 1049])
const DECSTR_DELETED_MODES = new Set([1, 6, 45, 66, 1004, 2004, 2026, 25])
const CURSOR_VISIBILITY_MODE = 25
// ?2026 (synchronized output) is a per-frame rendering hint: re-arming it on a
// wedged mid-frame state could stall paints, and its absence is never a
// user-visible regression, so it is tracked but never synthesized.
const NEVER_EMITTED_FLAT_MODES = new Set([2026])

const DEC_PRIVATE_BODY_PATTERN = /^[0-9;]*$/
const XTM_BODY_PATTERN = /^[0-9;]*$/

const isCsiFinalByte = (codePoint: number) => codePoint >= 0x40 && codePoint <= 0x7e

export function createTerminalModeTracker(): TerminalModeTracker {
  type ScannerState = 'ground' | 'esc' | 'csi'
  let state: ScannerState = 'ground'
  let pending = ''
  let pendingCodePoints = 0

  let mouseProtocolSlot: number | undefined
  let sgrEncodingSlot: number | undefined
  let altBufferSlot: number | undefined
  const flatModes = new Map<number, boolean>()
  const xtModifyKeys = new Map<number, number>()

  const enterEsc = () => {
    state = 'esc'
  }
  const enterCsi = () => {
    state = 'csi'
    pending = ''
    pendingCodePoints = 0
  }
  const enterGround = () => {
    state = 'ground'
  }

  const setFlatMode = (param: number, value: boolean) => {
    if (!flatModes.has(param) && flatModes.size >= FLAT_MODE_LIMIT) {
      const evicted = flatModes.keys().next().value
      if (evicted !== undefined) flatModes.delete(evicted)
      log.warn({
        event: 'terminal_mode_tracker_flat_eviction',
        evictedParam: evicted,
        insertedParam: param,
        capacity: FLAT_MODE_LIMIT,
      }, 'Terminal mode tracker evicted oldest flat DEC private mode')
    }
    flatModes.set(param, value)
  }

  const applyPrivateMode = (param: number, enable: boolean) => {
    if (MOUSE_PROTOCOL_FAMILY.has(param)) {
      mouseProtocolSlot = enable ? param : undefined
      return
    }
    if (SGR_ENCODING_FAMILY.has(param)) {
      sgrEncodingSlot = enable ? param : undefined
      return
    }
    if (ALT_BUFFER_FAMILY.has(param)) {
      altBufferSlot = enable ? param : undefined
      return
    }
    setFlatMode(param, enable)
  }

  const applyCsiFinal = (payload: string, finalChar: string) => {
    if ((finalChar === 'h' || finalChar === 'l') && payload.startsWith('?')) {
      const body = payload.slice(1)
      if (!DEC_PRIVATE_BODY_PATTERN.test(body)) return
      const enable = finalChar === 'h'
      for (const segment of body.split(';')) {
        const param = Number.parseInt(segment, 10)
        if (!Number.isFinite(param)) continue
        applyPrivateMode(param, enable)
      }
      return
    }

    if (finalChar === 'm' && payload.startsWith('>')) {
      const body = payload.slice(1)
      if (!XTM_BODY_PATTERN.test(body)) return
      // XTMODIFYKEYS resource form `CSI > Pm ; Pv m`; `>Pm;m` and `>Pm;0m`
      // are the documented clear forms (value 0). Extras beyond Pv are
      // ignored (parity with the Rust tracker; the map is never synthesized,
      // so this corner has no observable output either way).
      const [resourceText, valueText] = body.split(';')
      const resource = Number.parseInt(resourceText, 10)
      if (!Number.isFinite(resource)) return
      const value = valueText === undefined || valueText === '' ? 0 : Number.parseInt(valueText, 10)
      if (!Number.isFinite(value)) return
      xtModifyKeys.set(resource, value)
      return
    }

    if (finalChar === 'p' && payload === '!') {
      for (const mode of DECSTR_DELETED_MODES) {
        flatModes.delete(mode)
      }
      return
    }

    // Every other final — including `$p`/`$y` (DECRQM/DECRQSS), which may carry
    // `?`-private payloads — never mutates the projection.
  }

  const applyRis = () => {
    mouseProtocolSlot = undefined
    sgrEncodingSlot = undefined
    altBufferSlot = undefined
    const cursorVisibility = flatModes.get(CURSOR_VISIBILITY_MODE)
    flatModes.clear()
    if (cursorVisibility !== undefined) {
      flatModes.set(CURSOR_VISIBILITY_MODE, cursorVisibility)
    }
    xtModifyKeys.clear()
  }

  return {
    scan(data: string): void {
      for (let index = 0; index < data.length;) {
        const codePoint = data.codePointAt(index)
        if (codePoint === undefined) break
        const char = String.fromCodePoint(codePoint)
        index += char.length

        if (state === 'ground') {
          if (codePoint === ESC) {
            enterEsc()
          } else if (codePoint === CSI) {
            enterCsi()
          }
          continue
        }

        if (state === 'esc') {
          if (codePoint === 0x5b) { // '['
            enterCsi()
            continue
          }
          if (codePoint === CSI) {
            enterCsi()
            continue
          }
          if (codePoint === ESC) {
            continue // re-opened escape: stay in esc
          }
          if (codePoint === 0x63) { // 'c' — RIS is exactly `ESC c`
            applyRis()
            enterGround()
            continue
          }
          // Nothing else this tracker models follows ESC: every other byte —
          // including U+FFFD (decoded text, not structure) — ends the escape.
          enterGround()
          continue
        }

        // state === 'csi'
        if (codePoint === REPLACEMENT_CHARACTER) {
          enterGround()
          continue
        }
        if (codePoint === ESC) {
          enterEsc()
          continue
        }
        if (codePoint === CSI) {
          enterCsi() // a C1 CSI opener restarts the pending sequence
          continue
        }
        if (isCsiFinalByte(codePoint)) {
          applyCsiFinal(pending, char)
          enterGround()
          continue
        }
        if (pendingCodePoints >= CSI_PENDING_CODE_POINT_LIMIT) {
          // Abort-on-overflow: never front-truncate a payload dispatched by
          // prefix (see the constant's comment).
          enterGround()
          continue
        }
        pending += char
        pendingCodePoints += 1
      }
    },

    synthesize(): string {
      const enables: number[] = []
      if (mouseProtocolSlot !== undefined) enables.push(mouseProtocolSlot)
      if (sgrEncodingSlot !== undefined) enables.push(sgrEncodingSlot)
      if (altBufferSlot !== undefined) enables.push(altBufferSlot)
      for (const [param, value] of flatModes) {
        if (value && !NEVER_EMITTED_FLAT_MODES.has(param)) enables.push(param)
      }
      enables.sort((left, right) => left - right)

      let data = ''
      for (const param of enables) {
        data += `\u001b[?${param}h`
      }
      // A default surface is cursor-visible, so an explicitly tracked ?25l
      // trails the enables; a tracked ?25h is an ordinary enable above.
      if (flatModes.get(CURSOR_VISIBILITY_MODE) === false) {
        data += '\u001b[?25l'
      }
      return data
    },

    reset(): void {
      state = 'ground'
      pending = ''
      pendingCodePoints = 0
      mouseProtocolSlot = undefined
      sgrEncodingSlot = undefined
      altBufferSlot = undefined
      flatModes.clear()
      xtModifyKeys.clear()
    },
  }
}
