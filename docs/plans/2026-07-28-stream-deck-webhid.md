# Baked-In Stream Deck Support (WebHID) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Drive an Elgato Stream Deck directly from the freshell web client via WebHID — one key per freshell tab with title + terminal preview + status rings, short-press to focus, long-press action layer (APPROVE/STOP), overflow paging, Stream Deck+ dials/touch-strip, idle dimming, and a fake/virtual transport for tests and hardware-free use. No sidecar, no server changes.

**Architecture:** The whole feature lives in `src/` behind a thin `DeckDevice` transport seam with two implementations: WebHID (via `@elgato-stream-deck/webhid`) and a fake/emulator. A `DeckController` subscribes to the Redux store, derives per-tab status from existing slices, computes a pure `FrameSpec` (key/strip descriptions), renders specs to RGBA buffers via an injectable canvas renderer, and diffs-paints the device. Input events flow back through the controller to existing Redux actions and WS messages. A manager + `useStreamDeck()` hook own lifecycle (enable toggle, auto-reconnect, hotplug, exclusivity). Settings persist client-side via the existing `LocalSettings` split.

**Tech Stack:** React 18, Redux Toolkit, TypeScript 5.7, Vitest 3 (jsdom), `@elgato-stream-deck/webhid` ^7.6.3, Canvas 2D (runtime only — tests use injected fakes).

## Global Constraints

- Client-only feature: **zero server changes** (neither Node nor Rust server is touched).
- Branch from `origin/main`, work in this worktree, **never** create/open a PR without explicit user approval; never restart the live server; never use broad kill patterns.
- Red-Green-Refactor TDD for every task; run focused tests via `npm run test:vitest -- run <path>`; `npm run typecheck` and `npm run lint` must stay clean; final full run via the coordinated suite (`npm run check`).
- Test env is jsdom with `test/setup/dom.ts`: **`console.error` is fatal** in tests; `HTMLCanvasElement.prototype.getContext` returns `null` — never depend on real canvas in tests; use injected fake contexts / spec-recording renderers.
- New dependencies (exact): `@elgato-stream-deck/webhid@^7.6.3` (dependencies), `@types/w3c-web-hid` (devDependencies). No other new deps.
- Deck colors (verbatim): tile bg `#0a0a0a`; preview text `#a8a8a8`; busy blue `#3b82f6`; green `#22c55e`; amber `#f59e0b`; active white `#ffffff`; stop red `#ef4444`; disabled grey `#555555`; control-key bg `#101036`; control dim text `#8888aa`; empty key `#000000`.
- Ring geometry (verbatim): status+active → status ring 3px at inset 0 + white ring 2px at inset 3; status only → 4px at inset 0; active only → white 3px at inset 0. Ring priority: **amber > green > blue**.
- Preview geometry constants (starting point, A12): font size 11, line height 13, char width 5.5, left margin 3, banner height 20, banner fill rgba(0,0,0,170/255), title font 16 white, 10-char title cap + `…` + pixel-fit. These constants came from PIL-rendered tuning and MAY be retuned at implementation via `measureText` if browser canvas metrics overflow tiles (browser 11px monospace advances ~6.6px vs the assumed 5.5px) — the unit tests pin whatever final constants ship.
- Timings (verbatim): long-press ≥ 0.5s (measured on key release); action layer auto-close 10s; STOP escalation window 5s; idle timeout default 300s (0 disables); active brightness default 100; idle brightness default 10.
- **Never send raw keys to a fresh-agent pane** (they become prompt text). Fresh-agent stop = WS `freshAgent.interrupt` only.
- Approve decision payload is exactly `{ behavior: 'allow' }` — **`updatedInput` must be absent** (a defined `updatedInput`, even `{}`, wholesale replaces the tool input).
- Deck-rendered text is ASCII-only (canvas fonts are fine with unicode, but keep the validated ASCII labels `NEXT >` etc.; the ellipsis `…` is allowed).
- All new UI follows repo a11y rules (semantic elements, `aria-label` on icon-only/bare controls, eslint-plugin-jsx-a11y clean).
- Commit after every green step; commit messages append the Amplifier co-author trailer used by this repo's agents.

## Design decisions locked by investigation (do not re-open)

- **Previews (spec wrinkle #5):** all tabs stay mounted (`src/App.tsx:1651`, `visibility:hidden` via `.tab-hidden`), so xterm instances and buffers are live for background tabs. Terminal panes read the live xterm buffer through a tiny reader registry (Task 11). Non-terminal panes (fresh-agent/browser/editor/picker/extension) render **title-only tiles**. No capture polling, no server involvement.
- **Per-tab ring aggregation (spec wrinkle #4):** blue = `getBusyPaneIdsForTab(...)` (exactly what TabBar uses); green = `state.turnCompletion.attentionByTab[tabId]` (tab-level flag, exactly what TabBar uses); amber = any fresh-agent pane in the tab whose session has non-empty `pendingPermissions`/`pendingQuestions` (no tab-level amber exists today — Task 3 builds it, factoring out the existing `hasWaitingPrompt` predicate instead of duplicating it a third time).
- **Exclusivity (redesigned after load-bearing review, A1+A2 falsified):** Chromium opens HID devices SHARED on all platforms (Windows `FILE_SHARE_READ|WRITE`, macOS non-seizing `kIOHIDOptionsTypeNone`, Linux plain `O_RDWR`) — a second tab of the same profile gets its own live connection with no error, so concurrent opens generally SUCCEED and `open()`-failure CANNOT be the exclusivity mechanism. Same-origin multi-window exclusivity uses a **Web Locks leader election**: `navigator.locks.request('freshell-stream-deck', ...)` held for the manager's enabled lifetime; non-leader windows show status `in-use` ("in use elsewhere / another window") and wait; when the leader closes/disables, the lock releases and a waiting window acquires it (leadership handoff). The `DeckOpenError('in-use')` mapping + retry on `visibilitychange`/`focus` is kept ONLY as a secondary signal for the other-OS-app case (e.g. an exclusive-mode holder on Windows). Recorded explicitly: cross-app contention mostly does NOT fail the open — both parties may paint and fight; the user resolves it by closing one. Accepted residual with a hardware checkpoint (see "Hardware checkpoints" at the end of this plan). Also: an open failure surfaces as a `NetworkError` DOMException that is indistinguishable from a Linux udev permission denial — status copy must say "in use by another app — or missing device permissions (Linux udev)".
- **Focus press:** dispatch `dismissTabGreen(tabId)` (gated on `settings.panes.attentionDismiss === 'click'`) then `setActiveTab(tabId)` — byte-for-byte what a TabBar click does, and works when the window is unfocused.
- **Browser Allow bug is real and in scope:** `FreshAgentView.tsx:2344` and `:2214` send `decision: { behavior: 'allow', updatedInput: {} }`; the server resolves it verbatim (`server/sdk-bridge.ts:771-783`). Task 6 fixes both client sites minimally (omit the key) and updates the 4 tests that pin `{}`. No server change.
- **`docs/index.html`:** a settings section + optional debug panel is not a major default-experience change → no update. (Decision recorded here per AGENTS.md.)
- **Electron (A11, decision recorded):** keep **zero `electron/` changes**. In the packaged Electron app `navigator.hid` exists but `requestDevice()` always resolves `[]` (no picker, no crash) and `getDevices()` is always `[]` (no persistence) because no `select-hid-device` handler is registered. The settings UI must be honest: detect Electron client-side (`navigator.userAgent.includes('Electron')`) and show a "not supported in the desktop app — use Chrome/Edge" message instead of a dead Connect button (Task 13). The connect flow treats `requestDevice() -> []` as a clean no-op everywhere — never index `[0]` blindly.
- **Long-press semantics:** press duration measured at key-up; ≥0.5s opens the action layer, <0.5s focuses. Ports the hardware-validated behavior.
- **Pager wraps; dial-1 paging clamps; dial-0 tab cycling wraps** (validated on prior branch).

---

## File Structure

New directory `src/deck/` (all client code):

| File | Responsibility |
|---|---|
| `src/deck/deck-device.ts` | The transport seam: `DeckDevice`, `DeckCapabilities`, `DeckInputEvent` types. Zero logic. |
| `src/deck/fake-deck-device.ts` | Fake/emulator transport: records painted images/brightness, emits synthetic input. Used by tests AND the virtual deck panel. |
| `src/deck/deck-selectors.ts` | Redux → deck model: tab list, active tab, per-tab `TabRingStatus`, approve/stop target lookup. |
| `src/deck/frame.ts` | Pure layout: `planLayout` (FULL vs KEYS mode), page math, `buildFrame` → `FrameSpec` (tab/pager/empty/action key specs + strip text). |
| `src/deck/tile-renderer.ts` | Canvas draw layer: `KeySpec` → RGBA buffer via injected 2D-context factory; strip renderer; pure geometry helpers. |
| `src/deck/deck-actions.ts` | Side effects: focus tab, send approval (no `updatedInput`), stop (interrupt / ESC / Ctrl+C). |
| `src/deck/deck-controller.ts` | The stateful coordinator: store subscription → frame diff → paint; input dispatch; long-press/action layer; paging; idle dim; tick loop. |
| `src/deck/terminal-text-registry.ts` | terminalId → live-xterm-text reader registry + `readXtermTail` + registration hook. |
| `src/deck/webhid-transport.ts` | `DeckDevice` implementation wrapping `@elgato-stream-deck/webhid`. |
| `src/deck/deck-manager.ts` | Singleton lifecycle: Web Locks leader election, enable/disable, request/auto-reconnect, hotplug, in-use retry; publishes status to `deckSlice`. |
| `src/lib/terminal-interrupt.ts` | `sendTerminalInterrupt(content, terminalId, key)` (modeled on `terminal-kill.ts`). |
| `src/lib/webhid-support.ts` | `isWebHidSupported()` feature detection. |
| `src/store/deckSlice.ts` | Runtime-only slice: connection status, model, keyCount, virtual-panel open flag. Never persisted. |
| `src/hooks/useStreamDeck.ts` | App-level hook wiring the manager to settings + store. |
| `src/components/settings/StreamDeckSettings.tsx` | Settings section UI. |
| `src/components/VirtualDeckPanel.tsx` | In-app emulator panel (fake transport, clickable keys). |

Modified files: `shared/settings.ts`, `src/store/browserPreferencesPersistence.ts`, `src/store/store.ts`, `src/lib/pane-activity.ts` (export `hasWaitingPrompt`), `src/components/context-menu/ContextMenuProvider.tsx` (import it), `src/components/fresh-agent/FreshAgentView.tsx` (updatedInput fix), `src/components/SettingsView.tsx`, `src/App.tsx`, `src/components/TerminalView.tsx` (one hook call), `README.md`, `package.json`.

---

### Task 1: Client-only `streamDeck` settings section

**Files:**
- Modify: `shared/settings.ts` (types at :182/:227, `defaultLocalSettings` :828, `resolveLocalSettings` :1246, `composeResolvedSettings` :1330, `extractLegacyLocalSettingsSeed` :1372)
- Modify: `src/store/browserPreferencesPersistence.ts:87` (`buildLocalSettingsPatch`)
- Create: `src/lib/webhid-support.ts`
- Test: `test/unit/shared/settings.stream-deck.test.ts`

**Interfaces:**
- Consumes: existing `LocalSettings`/`ResolvedSettings` machinery.
- Produces: `LocalSettings['streamDeck'] = { enabled: boolean; brightness: number; idleBrightness: number; idleTimeoutSeconds: number }` (defaults `false`, `100`, `10`, `300`), visible at `state.settings.settings.streamDeck`; `isWebHidSupported(): boolean` and `isElectronClient(): boolean` from `@/lib/webhid-support` (in Electron `navigator.hid` exists but is non-functional without main-process handlers — Task 13 uses `isElectronClient` to show honest messaging). Later tasks read `settings.streamDeck.*` and call `applyLocalSetting({ streamDeck: {...} })`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/shared/settings.stream-deck.test.ts
import { describe, expect, it } from 'vitest'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  defaultLocalSettings,
  extractLegacyLocalSettingsSeed,
  resolveLocalSettings,
} from '@shared/settings'
import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'

describe('streamDeck local settings section', () => {
  it('has safe defaults', () => {
    expect(defaultLocalSettings.streamDeck).toEqual({
      enabled: false,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 300,
    })
  })

  it('round-trips a patch through resolve -> buildLocalSettingsPatch', () => {
    const resolved = resolveLocalSettings({
      streamDeck: { enabled: true, idleTimeoutSeconds: 60 },
    })
    expect(resolved.streamDeck).toEqual({
      enabled: true,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 60,
    })
    const patch = buildLocalSettingsPatch(resolved)
    expect(patch.streamDeck).toEqual({ enabled: true, idleTimeoutSeconds: 60 })
  })

  it('defaults produce no persisted patch entry', () => {
    expect(buildLocalSettingsPatch(resolveLocalSettings({})).streamDeck).toBeUndefined()
  })

  it('appears in ResolvedSettings', () => {
    const resolved = composeResolvedSettings(
      createDefaultServerSettings(),
      resolveLocalSettings({ streamDeck: { enabled: true } }),
    )
    expect(resolved.streamDeck.enabled).toBe(true)
    expect(resolved.streamDeck.brightness).toBe(100)
  })

  it('survives the legacy seed normalizer (load path)', () => {
    const seed = extractLegacyLocalSettingsSeed({
      streamDeck: { enabled: true, brightness: 80 },
    })
    expect(seed?.streamDeck).toEqual({ enabled: true, brightness: 80 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts`
Expected: FAIL — `streamDeck` does not exist on `defaultLocalSettings` (TS error surfaces as test failure).

- [ ] **Step 3: Thread the section through `shared/settings.ts`**

Mirror the existing `notifications` section at each touch point (it is the one purely-local section — copy its handling shape exactly, adjusted for four fields):

```ts
// 1) LocalSettings (~:182) — add alongside notifications:
streamDeck: {
  enabled: boolean
  brightness: number
  idleBrightness: number
  idleTimeoutSeconds: number
}

// 2) ResolvedSettings (~:227):
streamDeck: LocalSettings['streamDeck']

// 3) defaultLocalSettings (~:828):
streamDeck: { enabled: false, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 },

// 4) resolveLocalSettings (~:1246) — wherever notifications fills defaults, add:
streamDeck: {
  enabled: patch?.streamDeck?.enabled ?? defaultLocalSettings.streamDeck.enabled,
  brightness: patch?.streamDeck?.brightness ?? defaultLocalSettings.streamDeck.brightness,
  idleBrightness: patch?.streamDeck?.idleBrightness ?? defaultLocalSettings.streamDeck.idleBrightness,
  idleTimeoutSeconds: patch?.streamDeck?.idleTimeoutSeconds ?? defaultLocalSettings.streamDeck.idleTimeoutSeconds,
},

// 5) composeResolvedSettings (~:1330) — alongside `notifications: local.notifications`:
streamDeck: local.streamDeck,

// 6) extractLegacyLocalSettingsSeed (~:1372) — following the notifications key-selection shape
// (notifications does this inline via pickKeys at ~:1407):
const sd = record?.streamDeck
if (sd && typeof sd === 'object') {
  const out: Partial<LocalSettings['streamDeck']> = {}
  if (typeof (sd as any).enabled === 'boolean') out.enabled = (sd as any).enabled
  if (typeof (sd as any).brightness === 'number') out.brightness = (sd as any).brightness
  if (typeof (sd as any).idleBrightness === 'number') out.idleBrightness = (sd as any).idleBrightness
  if (typeof (sd as any).idleTimeoutSeconds === 'number') out.idleTimeoutSeconds = (sd as any).idleTimeoutSeconds
  if (Object.keys(out).length > 0) patch.streamDeck = out
}

// 7) normalizeExtractedLocalSeed (~:474-625) — REQUIRED, this is the whitelist gate.
// extractLegacyLocalSettingsSeed ends with `return normalizeExtractedLocalSeed(patch)`
// (~:1410), and that normalizer builds a fresh object from hard-coded sections only —
// any section it does not enumerate is silently DROPPED, which would both fail this
// task's Step 6 and make the runtime enable path a silent no-op: updateSettingsLocal
// routes every patch through normalizeLocalPatch → extractLegacyLocalSettingsSeed
// (src/store/settingsSlice.ts:45-50, :117-121), so Task 11's
// `store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))` and
// Task 13's enable toggle depend on this block. Mirror the notifications block
// (~:614-622) alongside it:
if (isRecord(patch.streamDeck)) {
  const streamDeck: LocalSettingsPatch['streamDeck'] = {}
  if (typeof patch.streamDeck.enabled === 'boolean') {
    streamDeck.enabled = patch.streamDeck.enabled as boolean
  }
  if (typeof patch.streamDeck.brightness === 'number') {
    streamDeck.brightness = patch.streamDeck.brightness as number
  }
  if (typeof patch.streamDeck.idleBrightness === 'number') {
    streamDeck.idleBrightness = patch.streamDeck.idleBrightness as number
  }
  if (typeof patch.streamDeck.idleTimeoutSeconds === 'number') {
    streamDeck.idleTimeoutSeconds = patch.streamDeck.idleTimeoutSeconds as number
  }
  if (Object.keys(streamDeck).length > 0) {
    normalized.streamDeck = streamDeck
  }
}
```

Also check `mergeLocalSettings` (:1269) — if it enumerates sections explicitly (like `notifications`), add a `streamDeck` merge line there too. Note the existing full-shape `toEqual` assertions in `test/unit/shared/settings.test.ts` (~:382 extract, ~:548 strip) may need their expected objects extended if they break on the new section — extend the expectations, do not weaken them.

- [ ] **Step 4: Add the persistence allowlist entry**

In `src/store/browserPreferencesPersistence.ts` `buildLocalSettingsPatch` (:87), following the `notifications` block:

```ts
const streamDeck: LocalSettingsPatch['streamDeck'] = {}
assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'enabled')
assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'brightness')
assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'idleBrightness')
assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'idleTimeoutSeconds')
if (Object.keys(streamDeck).length > 0) patch.streamDeck = streamDeck
```

- [ ] **Step 5: Create `src/lib/webhid-support.ts`**

```ts
export function isWebHidSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'hid' in navigator
  } catch {
    return false
  }
}

// In the packaged Electron app navigator.hid EXISTS but requestDevice() always
// resolves [] (no picker) and getDevices() is always [] (no persistence) because
// no select-hid-device handler is registered. Zero electron/ changes is a recorded
// decision — the UI must detect Electron and message honestly instead.
export function isElectronClient(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
  } catch {
    return false
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts`
Expected: PASS (5 tests). Also run `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts src/lib/webhid-support.ts test/unit/shared/settings.stream-deck.test.ts
git commit -m "feat(deck): add client-only streamDeck settings section"
```

---

### Task 2: DeckDevice seam + FakeDeckDevice

**Files:**
- Create: `src/deck/deck-device.ts`
- Create: `src/deck/fake-deck-device.ts`
- Test: `test/unit/client/deck/fake-deck-device.test.ts`

**Interfaces:**
- Produces (consumed by every later task):

```ts
// src/deck/deck-device.ts
export interface DeckCapabilities {
  model: string
  keyCount: number
  keyRows: number
  keyColumns: number
  keyPixelWidth: number
  keyPixelHeight: number
  dialCount: number
  hasTouchStrip: boolean
  touchStripPixelWidth: number   // 0 when hasTouchStrip is false
  touchStripPixelHeight: number  // 0 when hasTouchStrip is false
}

export type DeckInputEvent =
  | { type: 'keyDown'; keyIndex: number }
  | { type: 'keyUp'; keyIndex: number }
  | { type: 'dialRotate'; dialIndex: number; ticks: number }
  | { type: 'dialPress'; dialIndex: number }
  | { type: 'touchTap' }

export interface DeckDevice {
  readonly capabilities: DeckCapabilities
  setKeyImage(keyIndex: number, rgba: Uint8ClampedArray): Promise<void>
  setTouchStripImage(rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
  setBrightness(percent: number): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
  onInput(listener: (event: DeckInputEvent) => void): () => void
  onDisconnect(listener: () => void): () => void
}
```

- `FakeDeckDevice` additionally exposes: constructor `new FakeDeckDevice(caps?: Partial<DeckCapabilities>)` (defaults to the Mini profile), `MINI_CAPS` / `PLUS_CAPS` exported profile constants, `keyImages: Map<number, Uint8ClampedArray>`, `stripImage: { rgba: Uint8ClampedArray; width: number; height: number } | null`, `brightnessHistory: number[]`, `closed: boolean`, `cleared: boolean`, `emit(event: DeckInputEvent): void`, `press(keyIndex: number): void` (down+up), `disconnect(): void`, and `changeListenerCount(): number`.

Profiles (verbatim):

```ts
export const MINI_CAPS: DeckCapabilities = {
  model: 'Fake Mini', keyCount: 6, keyRows: 2, keyColumns: 3,
  keyPixelWidth: 80, keyPixelHeight: 80,
  dialCount: 0, hasTouchStrip: false, touchStripPixelWidth: 0, touchStripPixelHeight: 0,
}
export const PLUS_CAPS: DeckCapabilities = {
  model: 'Fake Plus', keyCount: 8, keyRows: 2, keyColumns: 4,
  keyPixelWidth: 120, keyPixelHeight: 120,
  dialCount: 4, hasTouchStrip: true, touchStripPixelWidth: 800, touchStripPixelHeight: 100,
}
```

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/client/deck/fake-deck-device.test.ts
import { describe, expect, it, vi } from 'vitest'
import { FakeDeckDevice, MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'

describe('FakeDeckDevice', () => {
  it('defaults to the 6-key Mini profile', () => {
    const d = new FakeDeckDevice()
    expect(d.capabilities).toEqual(MINI_CAPS)
  })

  it('records key images, brightness, strip, clear and close', async () => {
    const d = new FakeDeckDevice(PLUS_CAPS)
    const buf = new Uint8ClampedArray(120 * 120 * 4)
    await d.setKeyImage(3, buf)
    expect(d.keyImages.get(3)).toBe(buf)
    await d.setBrightness(40)
    await d.setBrightness(100)
    expect(d.brightnessHistory).toEqual([40, 100])
    const strip = new Uint8ClampedArray(800 * 100 * 4)
    await d.setTouchStripImage(strip, 800, 100)
    expect(d.stripImage).toEqual({ rgba: strip, width: 800, height: 100 })
    await d.clear()
    expect(d.cleared).toBe(true)
    expect(d.keyImages.size).toBe(0)
    await d.close()
    expect(d.closed).toBe(true)
  })

  it('emits input events to listeners and supports unsubscribe', () => {
    const d = new FakeDeckDevice()
    const seen: unknown[] = []
    const off = d.onInput((e) => seen.push(e))
    d.press(2)
    expect(seen).toEqual([
      { type: 'keyDown', keyIndex: 2 },
      { type: 'keyUp', keyIndex: 2 },
    ])
    off()
    d.press(2)
    expect(seen).toHaveLength(2)
  })

  it('notifies disconnect listeners once', () => {
    const d = new FakeDeckDevice()
    const cb = vi.fn()
    d.onDisconnect(cb)
    d.disconnect()
    d.disconnect()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/fake-deck-device.test.ts`
Expected: FAIL — module `@/deck/fake-deck-device` not found.

- [ ] **Step 3: Implement `deck-device.ts` (types above, verbatim) and `fake-deck-device.ts`**

```ts
// src/deck/fake-deck-device.ts
import type { DeckCapabilities, DeckDevice, DeckInputEvent } from './deck-device'

export const MINI_CAPS: DeckCapabilities = { /* verbatim from Interfaces above */ }
export const PLUS_CAPS: DeckCapabilities = { /* verbatim from Interfaces above */ }

export class FakeDeckDevice implements DeckDevice {
  readonly capabilities: DeckCapabilities
  keyImages = new Map<number, Uint8ClampedArray>()
  stripImage: { rgba: Uint8ClampedArray; width: number; height: number } | null = null
  brightnessHistory: number[] = []
  closed = false
  cleared = false
  private inputListeners = new Set<(e: DeckInputEvent) => void>()
  private disconnectListeners = new Set<() => void>()
  private disconnected = false

  constructor(caps?: Partial<DeckCapabilities>) {
    this.capabilities = { ...MINI_CAPS, ...caps }
  }
  async setKeyImage(keyIndex: number, rgba: Uint8ClampedArray): Promise<void> {
    this.keyImages.set(keyIndex, rgba)
  }
  async setTouchStripImage(rgba: Uint8ClampedArray, width: number, height: number): Promise<void> {
    this.stripImage = { rgba, width, height }
  }
  async setBrightness(percent: number): Promise<void> {
    this.brightnessHistory.push(percent)
  }
  async clear(): Promise<void> {
    this.cleared = true
    this.keyImages.clear()
    this.stripImage = null
  }
  async close(): Promise<void> {
    this.closed = true
  }
  onInput(listener: (e: DeckInputEvent) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }
  emit(event: DeckInputEvent): void {
    for (const l of [...this.inputListeners]) l(event)
  }
  press(keyIndex: number): void {
    this.emit({ type: 'keyDown', keyIndex })
    this.emit({ type: 'keyUp', keyIndex })
  }
  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const l of [...this.disconnectListeners]) l()
  }
  changeListenerCount(): number {
    return this.inputListeners.size
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/fake-deck-device.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-device.ts src/deck/fake-deck-device.ts test/unit/client/deck/fake-deck-device.test.ts
git commit -m "feat(deck): DeckDevice transport seam and fake transport"
```

---

### Task 3: Per-tab ring status + approve/stop target selectors

**Files:**
- Modify: `src/lib/pane-activity.ts` (export `hasWaitingPrompt`)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:123` (delete the private copy, import from `@/lib/pane-activity`)
- Create: `src/deck/deck-selectors.ts`
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `getBusyPaneIdsForTab`, `resolvePaneActivity` inputs (`src/lib/pane-activity.ts`), `collectPaneEntries`/`findPaneContent` (`src/lib/pane-utils.ts`), `makeFreshAgentSessionKey` (`@shared/fresh-agent`), `getFreshOpenCodeRouteCwd` (`src/lib/fresh-opencode-route.ts:5`), `state.turnCompletion.attentionByTab`, `state.freshAgent.sessions`, `state.panes.layouts`, `state.tabs`.
- Produces:

```ts
// src/deck/deck-selectors.ts
import type { RootState } from '@/store/store'
import type { Tab } from '@/store/types'
import type { FreshAgentPaneContent, TerminalPaneContent } from '@/store/paneTypes'

export type TabRingStatus = { busy: boolean; green: boolean; amber: boolean }
export type DeckTab = { id: string; title: string; status: TabRingStatus; active: boolean }
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null }

export function getTabRingStatus(state: RootState, tab: Tab): TabRingStatus
export function selectDeckModel(state: RootState): DeckModel

export type ApproveTarget = {
  sessionId: string
  sessionType: FreshAgentPaneContent['sessionType']
  provider: FreshAgentPaneContent['provider']
  requestId: string | number
  cwd?: string   // REQUIRED for freshopencode sessions (server auth keys embed cwd); undefined otherwise
}
export function findApproveTarget(state: RootState, tabId: string): ApproveTarget | null

export type StopTarget =
  | { kind: 'fresh-agent'; sessionId: string; sessionType: FreshAgentPaneContent['sessionType']; provider: FreshAgentPaneContent['provider']; cwd?: string }
  | { kind: 'terminal'; paneId: string; terminalId: string; content: TerminalPaneContent }
export function findStopTarget(state: RootState, tabId: string): StopTarget | null
```

Semantics: `busy` = `getBusyPaneIdsForTab(...).length > 0` (same inputs TabBar wires at `TabBar.tsx:179-186`); `green` = `!!state.turnCompletion.attentionByTab[tab.id]`; `amber` = any fresh-agent pane entry whose session (looked up via `makeFreshAgentSessionKey({ sessionType, provider, sessionId })`) satisfies `hasWaitingPrompt`. `findApproveTarget` returns the first pending permission (fall back to first pending question's requestId only if no permissions — APPROVE targets permissions; if only questions are pending return `null`, questions need the full UI). `findStopTarget`: first **busy fresh-agent** pane wins; else first busy **terminal** pane with a defined `terminalId` (busy per `resolvePaneActivity`).

**cwd rule (load-bearing, A8 falsified):** a cwd-less `freshAgent.interrupt` / `freshAgent.approval.respond` for a durable (`ses_`-prefixed) freshopencode session is rejected `UNAUTHORIZED` server-side — the auth key embeds cwd (`server/ws-handler.ts:1290-1293`) and the runtime manager also requires cwd. Both target lookups therefore derive `cwd` client-side via the existing `getFreshOpenCodeRouteCwd` (`src/lib/fresh-opencode-route.ts:5`): `getFreshOpenCodeRouteCwd(entry.content, { freshAgentSessions: state.freshAgent.sessions })` — it returns `undefined` for anything that isn't a freshopencode pane, so claude/codex/kilroy targets stay cwd-less (confirmed fine: their auth keys are plain `sessionType:provider:sessionId`). Targets also forward the pane's exact `sessionType` (e.g. kilroy sessions send `sessionType: 'kilroy'` with `provider: 'claude'`), matching what FreshAgentView sends.

- [ ] **Step 1: Write the failing test**

Build a minimal `RootState`-shaped object via a local `configureStore` with the real reducers `tabs, panes, turnCompletion, freshAgent, codexActivity, claudeActivity, amplifierActivity, opencodeActivity, paneRuntimeActivity, settings` and `preloadedState` fixtures (repo convention: local store factory per test file). Fixture: tab `t1` with a single terminal leaf pane `p1` (`terminalId: 'term-1'`, `mode: 'claude'`, `status: 'running'`), tab `t2` with a fresh-agent leaf `p2` (`sessionType: 'freshclaude'`, `provider: 'claude'`, `sessionId: 's1'`, `createRequestId: 'c2'`, `status: 'running'`).

```ts
// test/unit/client/deck/deck-selectors.test.ts
import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer from '@/store/settingsSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import {
  findApproveTarget, findStopTarget, getTabRingStatus, selectDeckModel,
} from '@/deck/deck-selectors'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

function makeState(overrides: {
  claudeBusy?: boolean
  attention?: Record<string, boolean>
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
} = {}) {
  const store = configureStore({
    reducer,
    preloadedState: {
      tabs: {
        tabs: [
          { id: 't1', createRequestId: 'c1', title: 'build', status: 'running', mode: 'shell', createdAt: 1 },
          { id: 't2', createRequestId: 'c2', title: 'claude', status: 'running', mode: 'shell', createdAt: 2 },
        ],
        activeTabId: 't1', renameRequestTabId: null, tombstones: [],
      },
      panes: {
        layouts: {
          t1: { type: 'leaf', id: 'p1', content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'claude' } },
          t2: { type: 'leaf', id: 'p2', content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: 'c2', status: 'running' } },
        },
        activePane: { t1: 'p1', t2: 'p2' },
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: { byTerminalId: overrides.claudeBusy ? { 'term-1': { phase: 'busy' } } : {} },
      turnCompletion: {
        seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [],
        attentionByTab: overrides.attention ?? {}, attentionByPane: {},
      },
      freshAgent: {
        sessions: {
          [s1Key]: {
            sessionKey: s1Key, threadId: 's1', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1',
            status: overrides.freshAgentRunning ? 'running' : 'idle', streamingActive: false,
            pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
          },
        },
        pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
      },
    } as never,
  })
  return store.getState() as never
}

describe('deck-selectors', () => {
  it('quiet tabs have no ring', () => {
    const state = makeState()
    const model = selectDeckModel(state)
    expect(model.tabs).toHaveLength(2)
    expect(model.tabs[0]).toMatchObject({ id: 't1', title: 'build', active: true, status: { busy: false, green: false, amber: false } })
  })

  it('busy terminal pane -> busy tab (blue)', () => {
    const state = makeState({ claudeBusy: true })
    const tab = (state as { tabs: { tabs: unknown[] } }).tabs.tabs[0]
    expect(getTabRingStatus(state, tab as never).busy).toBe(true)
    expect(selectDeckModel(state).tabs[0].status.busy).toBe(true)
  })

  it('attentionByTab -> green', () => {
    const state = makeState({ attention: { t1: true } })
    expect(selectDeckModel(state).tabs[0].status.green).toBe(true)
  })

  it('pending permission -> amber on the fresh-agent tab, and busy is suppressed', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } }, freshAgentRunning: true })
    const t2 = selectDeckModel(state).tabs[1]
    expect(t2.status.amber).toBe(true)
    expect(t2.status.busy).toBe(false) // isFreshAgentBusy yields false while waiting
  })

  it('findApproveTarget returns the pending permission for the tab', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } } })
    expect(findApproveTarget(state, 't2')).toEqual({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    })
    expect(findApproveTarget(state, 't1')).toBeNull()
  })

  it('findStopTarget: busy fresh-agent wins; busy terminal otherwise; null when quiet', () => {
    const busyAgent = makeState({ freshAgentRunning: true })
    expect(findStopTarget(busyAgent, 't2')).toEqual({
      kind: 'fresh-agent', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    expect(findStopTarget(busyAgent, 't2')).not.toHaveProperty('cwd') // claude stays cwd-less
    const busyTerm = makeState({ claudeBusy: true })
    expect(findStopTarget(busyTerm, 't1')).toMatchObject({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1' })
    expect(findStopTarget(makeState(), 't1')).toBeNull()
  })
})

describe('freshopencode targets carry cwd (server auth keys embed it — A8)', () => {
  const oKey = makeFreshAgentSessionKey({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1' })
  function makeOpencodeState(overrides: { pendingPermissions?: Record<string, { requestId: string }>; running?: boolean } = {}) {
    const store = configureStore({
      reducer,
      preloadedState: {
        tabs: {
          tabs: [{ id: 't3', createRequestId: 'c3', title: 'oc', status: 'running', mode: 'shell', createdAt: 3 }],
          activeTabId: 't3', renameRequestTabId: null, tombstones: [],
        },
        panes: {
          layouts: {
            t3: { type: 'leaf', id: 'p3', content: { kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1', createRequestId: 'c3', status: 'running', initialCwd: '/repo/a' } },
          },
          activePane: { t3: 'p3' },
          paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
          zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
        },
        freshAgent: {
          sessions: {
            [oKey]: {
              sessionKey: oKey, threadId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1',
              status: overrides.running ? 'running' : 'idle', streamingActive: false,
              pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
            },
          },
          pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
        },
      } as never,
    })
    return store.getState() as never
  }

  it('findApproveTarget includes cwd for a freshopencode pane', () => {
    const state = makeOpencodeState({ pendingPermissions: { r9: { requestId: 'r9' } } })
    expect(findApproveTarget(state, 't3')).toEqual({
      sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'r9', cwd: '/repo/a',
    })
  })

  it('findStopTarget includes cwd for a busy freshopencode pane', () => {
    const state = makeOpencodeState({ running: true })
    expect(findStopTarget(state, 't3')).toEqual({
      kind: 'fresh-agent', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a',
    })
  })
})
```

Note: preloadedState slices not listed use their reducer defaults; the `as never` casts keep fixture noise down. If a preloaded slice shape is rejected at runtime (missing required field), extend the fixture — do not weaken the selector.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts`
Expected: FAIL — `@/deck/deck-selectors` not found.

- [ ] **Step 3: Export `hasWaitingPrompt` from `src/lib/pane-activity.ts`**

Add next to `isFreshAgentBusy` (it already contains the identical inline `hasWaitingItems` logic at :57-61):

```ts
export function hasWaitingPrompt(
  session: Pick<FreshAgentSessionState, 'pendingPermissions' | 'pendingQuestions'> | undefined,
): boolean {
  if (!session) return false
  return Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
}
```

Then in `src/components/context-menu/ContextMenuProvider.tsx` delete the module-private `hasWaitingPrompt` (:123) and `import { hasWaitingPrompt } from '@/lib/pane-activity'`. Run the existing ContextMenuProvider tests to confirm no regression: `npm run test:vitest -- run test/unit/client/components/context-menu`.

- [ ] **Step 4: Implement `src/deck/deck-selectors.ts`**

```ts
import type { RootState } from '@/store/store'
import type { Tab } from '@/store/types'
import type { FreshAgentPaneContent, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { collectPaneEntries } from '@/lib/pane-utils'
import { getBusyPaneIdsForTab, hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'

export type TabRingStatus = { busy: boolean; green: boolean; amber: boolean }
export type DeckTab = { id: string; title: string; status: TabRingStatus; active: boolean }
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null }

function activityInputs(state: RootState) {
  return {
    codexActivityByTerminalId: state.codexActivity.byTerminalId,
    opencodeActivityByTerminalId: state.opencodeActivity.byTerminalId,
    claudeActivityByTerminalId: state.claudeActivity.byTerminalId,
    amplifierActivityByTerminalId: state.amplifierActivity.byTerminalId,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity.byPaneId,
    freshAgentSessions: state.freshAgent.sessions,
  }
}

function freshAgentSessionFor(state: RootState, content: FreshAgentPaneContent) {
  if (!content.sessionId) return undefined
  return state.freshAgent.sessions[makeFreshAgentSessionKey({
    sessionType: content.sessionType, provider: content.provider, sessionId: content.sessionId,
  })]
}

export function tabHasPendingApproval(state: RootState, tabId: string): boolean {
  const layout = state.panes.layouts[tabId]
  if (!layout) return false
  return collectPaneEntries(layout).some((entry) =>
    entry.content.kind === 'fresh-agent' && hasWaitingPrompt(freshAgentSessionFor(state, entry.content)))
}

export function getTabRingStatus(state: RootState, tab: Tab): TabRingStatus {
  const busy = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  }).length > 0
  return {
    busy,
    green: !!state.turnCompletion.attentionByTab[tab.id],
    amber: tabHasPendingApproval(state, tab.id),
  }
}

export function selectDeckModel(state: RootState): DeckModel {
  const activeTabId = state.tabs.activeTabId
  return {
    activeTabId,
    tabs: state.tabs.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      active: tab.id === activeTabId,
      status: getTabRingStatus(state, tab),
    })),
  }
}

export type ApproveTarget = {
  sessionId: string
  sessionType: FreshAgentPaneContent['sessionType']
  provider: FreshAgentPaneContent['provider']
  requestId: string | number
  cwd?: string
}

// freshopencode auth keys embed cwd server-side; claude/codex/kilroy are cwd-less.
// getFreshOpenCodeRouteCwd returns undefined for any non-freshopencode pane.
function freshOpenCodeCwdFor(state: RootState, content: FreshAgentPaneContent): string | undefined {
  return getFreshOpenCodeRouteCwd(content, { freshAgentSessions: state.freshAgent.sessions })
}

export function findApproveTarget(state: RootState, tabId: string): ApproveTarget | null {
  const layout = state.panes.layouts[tabId]
  if (!layout) return null
  for (const entry of collectPaneEntries(layout)) {
    if (entry.content.kind !== 'fresh-agent' || !entry.content.sessionId) continue
    const session = freshAgentSessionFor(state, entry.content)
    const pending = session ? Object.values(session.pendingPermissions) : []
    if (pending.length > 0) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        requestId: pending[0].requestId,
        ...(cwd ? { cwd } : {}),
      }
    }
  }
  return null
}

export type StopTarget =
  | { kind: 'fresh-agent'; sessionId: string; sessionType: FreshAgentPaneContent['sessionType']; provider: FreshAgentPaneContent['provider']; cwd?: string }
  | { kind: 'terminal'; paneId: string; terminalId: string; content: TerminalPaneContent }

export function findStopTarget(state: RootState, tabId: string): StopTarget | null {
  const layout = state.panes.layouts[tabId]
  const tab = state.tabs.tabs.find((t) => t.id === tabId)
  if (!layout || !tab) return null
  const entries = collectPaneEntries(layout)
  const isOnlyPane = layout.type === 'leaf'
  let terminalHit: StopTarget | null = null
  for (const entry of entries) {
    const { isBusy } = resolvePaneActivity({
      paneId: entry.paneId, content: entry.content, tabMode: tab.mode, isOnlyPane,
      ...activityInputs(state),
    })
    if (!isBusy) continue
    if (entry.content.kind === 'fresh-agent' && entry.content.sessionId) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        kind: 'fresh-agent',
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        ...(cwd ? { cwd } : {}),
      }
    }
    if (!terminalHit && entry.content.kind === 'terminal' && entry.content.terminalId) {
      terminalHit = { kind: 'terminal', paneId: entry.paneId, terminalId: entry.content.terminalId, content: entry.content }
    }
  }
  return terminalHit
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts test/unit/client/components/context-menu`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/pane-activity.ts src/components/context-menu/ContextMenuProvider.tsx src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts
git commit -m "feat(deck): per-tab ring status aggregation and approve/stop target selectors"
```

---

### Task 4: Pure frame layout (`planLayout`, page math, `buildFrame`)

**Files:**
- Create: `src/deck/frame.ts`
- Test: `test/unit/client/deck/frame.test.ts`

**Interfaces:**
- Consumes: `DeckCapabilities` (Task 2), `DeckModel`/`DeckTab` (Task 3).
- Produces (consumed by renderer, controller, e2e):

```ts
// src/deck/frame.ts
export type RingColor = 'amber' | 'green' | 'blue' | null
export type DeckAction = 'back' | 'approve' | 'stop'
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; tabId: string; title: string; previewLines: string[]; ring: RingColor; active: boolean }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
export type StripSpec = { text: string } | null
export type FrameSpec = { keys: KeySpec[]; strip: StripSpec }

export type LayoutPlan = {
  mode: 'full' | 'keys'
  keyCount: number
  tabSlots: number[]        // physical key indices that show tabs, reading order
  pagerKey: number | null   // key_count-1 in keys-mode overflow, else null
  tabsPerPage: number
  useDials: boolean
  useStrip: boolean
}
export function planLayout(caps: DeckCapabilities, tabCount: number): LayoutPlan
export function pageCount(tabCount: number, tabsPerPage: number): number       // max(1, ceil)
export function clampPage(page: number, pages: number): number
export function visibleTabs<T>(tabs: T[], page: number, tabsPerPage: number): T[]
export function ringColor(status: { busy: boolean; green: boolean; amber: boolean }): RingColor
export function stripText(model: { tabs: Array<{ title: string; active: boolean; status: { busy: boolean; amber: boolean } }> }, page: number, pages: number): string
export const ACTION_KEYS: Record<DeckAction, number> // { back: 0, approve: 1, stop: 2 }

export type FrameInputs = {
  model: import('./deck-selectors').DeckModel
  caps: DeckCapabilities
  page: number
  actionLayer: { tabId: string; approveEnabled: boolean; stopEnabled: boolean } | null
  previewFor: (tabId: string) => string[]
}
export function buildFrame(inputs: FrameInputs): FrameSpec
```

Rules (verbatim ports): FULL mode when `caps.dialCount >= 2 && caps.hasTouchStrip` — every key a tab tile, no pager, `tabsPerPage = keyCount`. KEYS mode otherwise: no overflow → all keys tab slots; overflow (`tabCount > keyCount`) → pager at `keyCount - 1`, `tabsPerPage = keyCount - 1`. `ringColor`: amber → `'amber'`, else green → `'green'`, else busy → `'blue'`, else `null`. Action layer frame: all keys `empty` except 0=back (always enabled), 1=approve, 2=stop. Strip text: `` `${activeTitle}  |  page ${page}/${pages}  |  ${busyCount} busy  ${amberCount} waiting` `` with `-` for no active tab, forced ASCII (`text.replace(/[^\x20-\x7e]/g, '?')`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/client/deck/frame.test.ts
import { describe, expect, it } from 'vitest'
import { MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'
import {
  ACTION_KEYS, buildFrame, clampPage, pageCount, planLayout, ringColor, stripText, visibleTabs,
} from '@/deck/frame'
import type { DeckModel } from '@/deck/deck-selectors'

const quiet = { busy: false, green: false, amber: false }
function model(n: number, activeId = 'tab-0'): DeckModel {
  return {
    activeTabId: activeId,
    tabs: Array.from({ length: n }, (_, i) => ({
      id: `tab-${i}`, title: `Tab ${i}`, active: `tab-${i}` === activeId, status: { ...quiet },
    })),
  }
}
const noPreview = () => []

describe('planLayout', () => {
  it('mini, 3 tabs: keys mode, no pager, 6 tab slots', () => {
    expect(planLayout(MINI_CAPS, 3)).toEqual({
      mode: 'keys', keyCount: 6, tabSlots: [0, 1, 2, 3, 4, 5], pagerKey: null,
      tabsPerPage: 6, useDials: false, useStrip: false,
    })
  })
  it('mini, 8 tabs: pager at key 5, 5 tabs per page', () => {
    const plan = planLayout(MINI_CAPS, 8)
    expect(plan.pagerKey).toBe(5)
    expect(plan.tabSlots).toEqual([0, 1, 2, 3, 4])
    expect(plan.tabsPerPage).toBe(5)
  })
  it('plus: full mode regardless of overflow', () => {
    const plan = planLayout(PLUS_CAPS, 20)
    expect(plan).toMatchObject({ mode: 'full', pagerKey: null, tabsPerPage: 8, useDials: true, useStrip: true })
  })
})

describe('page math', () => {
  it('pageCount and clampPage', () => {
    expect(pageCount(8, 5)).toBe(2)
    expect(pageCount(0, 5)).toBe(1)
    expect(clampPage(3, 2)).toBe(2)
    expect(clampPage(0, 2)).toBe(1)
  })
  it('visibleTabs slices by page', () => {
    expect(visibleTabs([1, 2, 3, 4, 5, 6, 7, 8], 2, 5)).toEqual([6, 7, 8])
  })
})

describe('ringColor priority', () => {
  it('amber > green > blue > none', () => {
    expect(ringColor({ busy: true, green: true, amber: true })).toBe('amber')
    expect(ringColor({ busy: true, green: true, amber: false })).toBe('green')
    expect(ringColor({ busy: true, green: false, amber: false })).toBe('blue')
    expect(ringColor(quiet)).toBeNull()
  })
})

describe('buildFrame', () => {
  it('tabs fit: all tab tiles, active flag set, rest empty', () => {
    const frame = buildFrame({ model: model(3), caps: MINI_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(frame.keys).toHaveLength(6)
    expect(frame.keys[0]).toMatchObject({ kind: 'tab', tabId: 'tab-0', title: 'Tab 0', active: true })
    expect(frame.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-2', active: false })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
    expect(frame.strip).toBeNull()
  })
  it('overflow: pager key at 5 with page/pageCount; page 2 shows the tail', () => {
    const f1 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(f1.keys[5]).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect((f1.keys[0] as { tabId: string }).tabId).toBe('tab-0')
    const f2 = buildFrame({ model: model(8), caps: MINI_CAPS, page: 2, actionLayer: null, previewFor: noPreview })
    expect((f2.keys[0] as { tabId: string }).tabId).toBe('tab-5')
    expect(f2.keys[3]).toEqual({ kind: 'empty' })
    expect(f2.keys[5]).toEqual({ kind: 'pager', page: 2, pageCount: 2 })
  })
  it('action layer replaces the frame', () => {
    const frame = buildFrame({
      model: model(3), caps: MINI_CAPS, page: 1,
      actionLayer: { tabId: 'tab-1', approveEnabled: false, stopEnabled: true }, previewFor: noPreview,
    })
    expect(frame.keys[ACTION_KEYS.back]).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(frame.keys[ACTION_KEYS.approve]).toEqual({ kind: 'action', action: 'approve', enabled: false })
    expect(frame.keys[ACTION_KEYS.stop]).toEqual({ kind: 'action', action: 'stop', enabled: true })
    expect(frame.keys[3]).toEqual({ kind: 'empty' })
  })
  it('full mode fills the strip and never emits a pager', () => {
    const m = model(10)
    m.tabs[1].status.busy = true
    m.tabs[2].status.amber = true
    const frame = buildFrame({ model: m, caps: PLUS_CAPS, page: 1, actionLayer: null, previewFor: noPreview })
    expect(frame.keys.every((k) => k.kind !== 'pager')).toBe(true)
    expect(frame.strip).toEqual({ text: 'Tab 0  |  page 1/2  |  1 busy  1 waiting' })
  })
})

describe('stripText', () => {
  it('uses - for no active tab and forces ASCII', () => {
    expect(stripText({ tabs: [] }, 1, 1)).toBe('-  |  page 1/1  |  0 busy  0 waiting')
    expect(stripText({ tabs: [{ title: 'café', active: true, status: { busy: false, amber: false } }] }, 1, 1))
      .toBe('caf?  |  page 1/1  |  0 busy  0 waiting')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/deck/frame.ts`**

```ts
import type { DeckCapabilities } from './deck-device'
import type { DeckModel } from './deck-selectors'

export type RingColor = 'amber' | 'green' | 'blue' | null
export type DeckAction = 'back' | 'approve' | 'stop'
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; tabId: string; title: string; previewLines: string[]; ring: RingColor; active: boolean }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
export type StripSpec = { text: string } | null
export type FrameSpec = { keys: KeySpec[]; strip: StripSpec }

export const ACTION_KEYS: Record<DeckAction, number> = { back: 0, approve: 1, stop: 2 }

export type LayoutPlan = {
  mode: 'full' | 'keys'
  keyCount: number
  tabSlots: number[]
  pagerKey: number | null
  tabsPerPage: number
  useDials: boolean
  useStrip: boolean
}

export function planLayout(caps: DeckCapabilities, tabCount: number): LayoutPlan {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)
  if (caps.dialCount >= 2 && caps.hasTouchStrip) {
    return {
      mode: 'full', keyCount: caps.keyCount, tabSlots: range(caps.keyCount),
      pagerKey: null, tabsPerPage: caps.keyCount, useDials: true, useStrip: true,
    }
  }
  if (tabCount > caps.keyCount) {
    return {
      mode: 'keys', keyCount: caps.keyCount, tabSlots: range(caps.keyCount - 1),
      pagerKey: caps.keyCount - 1, tabsPerPage: caps.keyCount - 1,
      useDials: false, useStrip: caps.hasTouchStrip,
    }
  }
  return {
    mode: 'keys', keyCount: caps.keyCount, tabSlots: range(caps.keyCount),
    pagerKey: null, tabsPerPage: caps.keyCount, useDials: false, useStrip: caps.hasTouchStrip,
  }
}

export function pageCount(tabCount: number, tabsPerPage: number): number {
  return Math.max(1, Math.ceil(tabCount / Math.max(1, tabsPerPage)))
}
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pages))
}
export function visibleTabs<T>(tabs: T[], page: number, tabsPerPage: number): T[] {
  const start = (page - 1) * tabsPerPage
  return tabs.slice(start, start + tabsPerPage)
}

export function ringColor(status: { busy: boolean; green: boolean; amber: boolean }): RingColor {
  if (status.amber) return 'amber'
  if (status.green) return 'green'
  if (status.busy) return 'blue'
  return null
}

function toAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?')
}

export function stripText(
  model: { tabs: Array<{ title: string; active: boolean; status: { busy: boolean; amber: boolean } }> },
  page: number, pages: number,
): string {
  const active = model.tabs.find((t) => t.active)
  const busy = model.tabs.filter((t) => t.status.busy).length
  const amber = model.tabs.filter((t) => t.status.amber).length
  return toAscii(`${active?.title ?? '-'}  |  page ${page}/${pages}  |  ${busy} busy  ${amber} waiting`)
}

export type FrameInputs = {
  model: DeckModel
  caps: DeckCapabilities
  page: number
  actionLayer: { tabId: string; approveEnabled: boolean; stopEnabled: boolean } | null
  previewFor: (tabId: string) => string[]
}

export function buildFrame({ model, caps, page, actionLayer, previewFor }: FrameInputs): FrameSpec {
  const plan = planLayout(caps, model.tabs.length)
  const pages = pageCount(model.tabs.length, plan.tabsPerPage)
  const keys: KeySpec[] = Array.from({ length: plan.keyCount }, () => ({ kind: 'empty' as const }))
  const strip: StripSpec = plan.useStrip ? { text: stripText(model, clampPage(page, pages), pages) } : null

  if (actionLayer) {
    keys[ACTION_KEYS.back] = { kind: 'action', action: 'back', enabled: true }
    if (plan.keyCount > ACTION_KEYS.approve)
      keys[ACTION_KEYS.approve] = { kind: 'action', action: 'approve', enabled: actionLayer.approveEnabled }
    if (plan.keyCount > ACTION_KEYS.stop)
      keys[ACTION_KEYS.stop] = { kind: 'action', action: 'stop', enabled: actionLayer.stopEnabled }
    return { keys, strip }
  }

  const current = clampPage(page, pages)
  const visible = visibleTabs(model.tabs, current, plan.tabsPerPage)
  plan.tabSlots.forEach((keyIndex, slot) => {
    const tab = visible[slot]
    if (!tab) return
    keys[keyIndex] = {
      kind: 'tab', tabId: tab.id, title: tab.title,
      previewLines: previewFor(tab.id), ring: ringColor(tab.status), active: tab.active,
    }
  })
  if (plan.pagerKey !== null) keys[plan.pagerKey] = { kind: 'pager', page: current, pageCount: pages }
  return { keys, strip }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/frame.ts test/unit/client/deck/frame.test.ts
git commit -m "feat(deck): pure frame layout - plan, paging, ring priority, action layer, strip text"
```

---

### Task 5: Canvas tile + strip renderer

**Files:**
- Create: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `KeySpec`/`RingColor` (Task 4), `DeckCapabilities` (Task 2).
- Produces:

```ts
// src/deck/tile-renderer.ts
export type Ctx2D = Pick<CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'getImageData'> & {
  fillStyle: string | CanvasGradient | CanvasPattern
  font: string
  textBaseline: CanvasTextBaseline
}
export type CtxFactory = (width: number, height: number) => Ctx2D

export function previewGeometry(width: number, height: number): { lines: number; columns: number }
export function cropPreviewLines(lines: string[], maxLines: number, maxColumns: number): string[]
export function truncateTitle(title: string): string                       // 10-char cap + '…'
export function fitLabel(measure: (t: string) => number, text: string, maxWidth: number): string
export function drawRing(ctx: Ctx2D, w: number, h: number, color: string, width: number, inset?: number): void
export function renderKey(spec: KeySpec, caps: DeckCapabilities, createCtx: CtxFactory): Uint8ClampedArray
export function renderStrip(text: string, width: number, height: number, createCtx: CtxFactory): Uint8ClampedArray
export function defaultCtxFactory(width: number, height: number): Ctx2D    // document.createElement('canvas') — runtime only
export type KeyRenderer = (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray
export type StripRenderer = (text: string, width: number, height: number) => Uint8ClampedArray
```

Constants (exported for tests; geometry values are the tuned starting point — see the retune note below): `PREVIEW_BG = '#0a0a0a'`, `PREVIEW_TEXT_COLOR = '#a8a8a8'`, `PREVIEW_FONT_SIZE = 11`, `PREVIEW_LINE_HEIGHT = 13`, `PREVIEW_CHAR_WIDTH = 5.5`, `PREVIEW_LEFT_MARGIN = 3`, `BANNER_HEIGHT = 20`, `BANNER_FILL = 'rgba(0,0,0,0.667)'`, `TITLE_FONT_SIZE = 16`, `RING_COLORS = { amber: '#f59e0b', green: '#22c55e', blue: '#3b82f6' }`, `ACTIVE_COLOR = '#ffffff'`, `STOP_COLOR = '#ef4444'`, `APPROVE_COLOR = '#22c55e'`, `DISABLED_ACTION_COLOR = '#555555'`, `CONTROL_BG = '#101036'`, `CONTROL_DIM = '#8888aa'`, `EMPTY_BG = '#000000'`, `STRIP_FONT_SIZE = 22`, `MAX_TITLE_CHARS = 10`.

Geometry: `lines = max(1, floor((h - 20 - 2) / 13) + 1)`, `columns = max(1, floor((w - 3) / 5.5))` (80×80 → 5 lines × 14 cols; 120×120 → 8 × 21). Crop: strip trailing blank lines, keep last `lines`, first `columns` chars of each. Rings via nested 1px `fillRect` strips (top/bottom/left/right per pixel of width, offset by `inset + w`). Draw order: bg fill → preview lines bottom-up from `baseY = h - lines.length*13 - 2` at x=3 → banner rect (0,0,w,20) → centered title (fit to `w - 4`) → rings per the combination table. Pager key: `#101036` bg; `PAGE` (11px, `#8888aa`, y≈2, centered), `${page}/${pageCount}` (15px, white, centered both axes), `NEXT >` (11px, dim, bottom). Action keys: `#101036` bg, centered uppercase label (`BACK`/`APPROVE`/`STOP`, 15px, white), flat 3px ring in action color (white/green/red), or `#555555` when disabled. Empty key: solid `#000000`. `renderKey` returns `ctx.getImageData(0, 0, w, h).data`.

- [ ] **Step 1: Write the failing tests (recording fake context)**

```ts
// test/unit/client/deck/tile-renderer.test.ts
import { describe, expect, it } from 'vitest'
import { MINI_CAPS } from '@/deck/fake-deck-device'
import {
  cropPreviewLines, drawRing, fitLabel, previewGeometry, renderKey, truncateTitle,
  RING_COLORS, ACTIVE_COLOR, DISABLED_ACTION_COLOR,
} from '@/deck/tile-renderer'
import type { Ctx2D } from '@/deck/tile-renderer'

type Rect = { x: number; y: number; w: number; h: number; style: string }
type Text = { text: string; x: number; y: number; style: string; font: string }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
  const ctx = {
    fillStyle: '#000000' as string,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) })
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, style: String(this.fillStyle), font: this.font })
    },
    measureText(t: string) { return { width: t.length * 6 } as TextMetrics },
    getImageData() { return { data: new Uint8ClampedArray(width * height * 4) } as ImageData },
  } as unknown as Ctx2D
  return { ctx, rects, texts }
}

describe('previewGeometry', () => {
  it('matches the hardware-anchored values', () => {
    expect(previewGeometry(120, 120)).toEqual({ lines: 8, columns: 21 })
    expect(previewGeometry(80, 80)).toEqual({ lines: 5, columns: 14 })
    expect(previewGeometry(72, 72)).toEqual({ lines: 4, columns: 12 })
  })
})

describe('cropPreviewLines', () => {
  it('drops trailing blanks, keeps last N lines and first M columns', () => {
    const lines = ['one', 'two-is-longer-than-five', 'three', '', '   ']
    expect(cropPreviewLines(lines, 2, 5)).toEqual(['two-i', 'three'])
  })
})

describe('title fitting', () => {
  it('truncateTitle caps at 10 chars with ellipsis', () => {
    expect(truncateTitle('short')).toBe('short')
    expect(truncateTitle('exactly-10')).toBe('exactly-10')
    expect(truncateTitle('longer-than-ten')).toBe('longer-th…')
  })
  it('fitLabel pixel-fits with ellipsis', () => {
    const measure = (t: string) => t.length * 6
    expect(fitLabel(measure, 'abcdef', 100)).toBe('abcdef')
    expect(fitLabel(measure, 'abcdefghij', 30)).toBe('abcd…')
  })
})

describe('drawRing', () => {
  it('paints width nested 1px frames at the given inset', () => {
    const { ctx, rects } = recordingCtx(80, 80)
    drawRing(ctx, 80, 80, '#3b82f6', 2, 1)
    // each 1px frame = 4 rects (top, bottom, left, right) => 8 rects
    expect(rects).toHaveLength(8)
    expect(rects.every((r) => r.style === '#3b82f6')).toBe(true)
    // first frame at offset 1: top strip spans full width at y=1
    expect(rects[0]).toMatchObject({ x: 1, y: 1, w: 78, h: 1 })
  })
})

describe('renderKey', () => {
  it('tab tile: bg, preview text, banner, title, rings (status+active widths)', () => {
    let captured: ReturnType<typeof recordingCtx> | null = null
    const factory = (w: number, h: number) => {
      captured = recordingCtx(w, h)
      return captured.ctx
    }
    const out = renderKey(
      { kind: 'tab', tabId: 't1', title: 'build', previewLines: ['$ npm test', 'PASS'], ring: 'blue', active: true },
      MINI_CAPS, factory,
    )
    expect(out).toBeInstanceOf(Uint8ClampedArray)
    const { rects, texts } = captured!
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: '#0a0a0a' })       // bg
    expect(texts.some((t) => t.text === '$ npm test' && t.style === '#a8a8a8')).toBe(true) // preview
    expect(rects.some((r) => r.y === 0 && r.h === 20 && r.style.startsWith('rgba'))).toBe(true) // banner
    expect(texts.some((t) => t.text === 'build' && t.style === '#ffffff')).toBe(true)     // title
    const blue = rects.filter((r) => r.style === RING_COLORS.blue)
    const white = rects.filter((r) => r.style === ACTIVE_COLOR && r.h <= 1)
    expect(blue).toHaveLength(3 * 4)   // 3px status ring: 3 frames x 4 rects each
    // The h <= 1 filter matches ONLY the top+bottom strips of each 1px frame (2 per
    // frame); drawRing paints verticals as single TALL rects (h = h - 2*o), which the
    // filter deliberately excludes to avoid counting anything else white on the tile.
    expect(white).toHaveLength(2 * 2)  // 2px active ring at inset 3: 2 frames x 2 horizontal strips
  })

  it('status-only tile paints a 4px ring; active-only a 3px white ring', () => {
    const make = (ring: 'green' | null, active: boolean) => {
      let cap: ReturnType<typeof recordingCtx> | null = null
      renderKey({ kind: 'tab', tabId: 't', title: 't', previewLines: [], ring, active },
        MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
      return cap!.rects
    }
    expect(make('green', false).filter((r) => r.style === RING_COLORS.green)).toHaveLength(4 * 4)
    // Same h <= 1 caveat as above: 3 frames x 2 horizontal strips each (verticals are tall rects).
    expect(make(null, true).filter((r) => r.style === ACTIVE_COLOR && r.h <= 1)).toHaveLength(3 * 2)
  })

  it('pager key renders PAGE / n/m / NEXT > on the control background', () => {
    let cap: ReturnType<typeof recordingCtx> | null = null
    renderKey({ kind: 'pager', page: 2, pageCount: 3 }, MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
    const { rects, texts } = cap!
    expect(rects[0].style).toBe('#101036')
    expect(texts.map((t) => t.text)).toEqual(expect.arrayContaining(['PAGE', '2/3', 'NEXT >']))
  })

  it('disabled action key gets the grey ring; enabled approve gets green', () => {
    const rectsFor = (enabled: boolean) => {
      let cap: ReturnType<typeof recordingCtx> | null = null
      renderKey({ kind: 'action', action: 'approve', enabled }, MINI_CAPS, (w, h) => (cap = recordingCtx(w, h)).ctx)
      return cap!.rects
    }
    expect(rectsFor(false).some((r) => r.style === DISABLED_ACTION_COLOR)).toBe(true)
    expect(rectsFor(true).some((r) => r.style === RING_COLORS.green)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/deck/tile-renderer.ts`**

Implement per the Interfaces block. Core pieces:

```ts
export function previewGeometry(width: number, height: number) {
  return {
    lines: Math.max(1, Math.floor((height - BANNER_HEIGHT - 2) / PREVIEW_LINE_HEIGHT) + 1),
    columns: Math.max(1, Math.floor((width - PREVIEW_LEFT_MARGIN) / PREVIEW_CHAR_WIDTH)),
  }
}

export function cropPreviewLines(lines: string[], maxLines: number, maxColumns: number): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.slice(-maxLines).map((l) => l.slice(0, maxColumns))
}

export function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

export function fitLabel(measure: (t: string) => number, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text
  let t = text
  while (t.length > 0 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1)
  return `${t}…`
}

export function drawRing(ctx: Ctx2D, w: number, h: number, color: string, width: number, inset = 0): void {
  ctx.fillStyle = color
  for (let i = 0; i < width; i++) {
    const o = inset + i
    ctx.fillRect(o, o, w - 2 * o, 1)             // top
    ctx.fillRect(o, h - 1 - o, w - 2 * o, 1)     // bottom
    ctx.fillRect(o, o, 1, h - 2 * o)             // left
    ctx.fillRect(w - 1 - o, o, 1, h - 2 * o)     // right
  }
}
```

`renderKey(spec, caps, createCtx)`: allocate ctx at `caps.keyPixelWidth × caps.keyPixelHeight`; switch on `spec.kind`:
- `empty`: fill `#000000`, return image data.
- `tab`: fill `#0a0a0a`; `const { lines, columns } = previewGeometry(w, h)`; `const body = cropPreviewLines(spec.previewLines, lines, columns)`; set `font = '11px monospace'`, `textBaseline = 'top'`, fillStyle `#a8a8a8`; `baseY = h - body.length * 13 - 2`; draw each non-empty line at `(3, baseY + i * 13)`; banner: fillStyle `BANNER_FILL`, `fillRect(0, 0, w, 20)`; title: font `'16px sans-serif'`, white, `label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 4)`, centered `x = (w - measure(label)) / 2`, `textBaseline = 'top'`, `y = 2`; rings: `ring && active → drawRing(ring, 3, 0) + drawRing(white, 2, 3)`; `ring → drawRing(ring, 4, 0)`; `active → drawRing(white, 3, 0)` with `ring` mapped through `RING_COLORS`.
- `pager`: fill `#101036`; `PAGE` 11px `#8888aa` centered at y=2; body `${page}/${pageCount}` 15px white centered (x centered by measureText, y = `(h - 15) / 2` with `textBaseline = 'top'`); footer `NEXT >` 11px dim at `y = h - 11 - 4`.
- `action`: fill `#101036`; centered uppercase label 15px white; `drawRing` 3px with color `enabled ? ({ back: ACTIVE_COLOR, approve: APPROVE_COLOR, stop: STOP_COLOR })[action] : DISABLED_ACTION_COLOR`.

`renderStrip(text, width, height, createCtx)`: fill black, font `'22px sans-serif'`, white, single line centered both axes (`textBaseline='top'`, `y=(height-22)/2`), return image data. `defaultCtxFactory` creates a DOM canvas and returns its 2d context (throw a descriptive `Error` if `getContext` returns null — production browsers always provide it; tests always inject).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): canvas tile and strip renderer with validated geometry constants"
```

---

### Task 6: Fix the browser Allow `updatedInput: {}` bug

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:2344` and `:2214`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:326`, `:392`
- Modify: `test/unit/server/ws-handler-fresh-agent.test.ts:431`, `:467`

**Interfaces:**
- Consumes/produces: the `freshAgent.approval.respond` allow decision becomes exactly `{ behavior: 'allow' }` (schema `shared/ws-protocol.ts:521-529` types `decision` as an open record — no schema change). Deny path unchanged.

- [ ] **Step 1: Update the two CLIENT assertions to require the absence of `updatedInput` (RED)**

The RED gate is the two client test sites only. Task 6 changes no server code, so the
server test CANNOT be part of the RED gate: `ws-handler-fresh-agent.test.ts:431` is the
test's *own fixture* (the `ws.send(...)` frame the test itself constructs) and `:467`
asserts the server passes that fixture through verbatim to `resolveApproval` — update
both together and the server test passes immediately, before any client fix.

At the two client sites (`FreshAgentView.test.tsx:326`, `:392`), change the expected
decision from `{ behavior: 'allow', updatedInput: {} }` to `{ behavior: 'allow' }` and
add an explicit absence assertion where the frame object is available, e.g.:

```ts
expect(sent.decision).toEqual({ behavior: 'allow' })
expect('updatedInput' in sent.decision).toBe(false)
```

- [ ] **Step 2: Run the client suite to verify the RED gate fails**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: the 2 updated client assertions FAIL (decision still carries `updatedInput: {}`).

- [ ] **Step 2b: Update the server test's fixture+assertion pair to document the new wire shape (passes immediately — NOT a RED gate)**

In `test/unit/server/ws-handler-fresh-agent.test.ts`, update the fixture at `:431` (the
decision inside the frame the test sends) from `{ behavior: 'allow', updatedInput: {} }`
to `{ behavior: 'allow' }`, and the paired assertion at `:467` to
`expect(runtimeManager.resolveApproval).toHaveBeenCalledWith(locator, 'approval-1', { behavior: 'allow' })`
(`toHaveBeenCalledWith` uses deep equality). Update BOTH together — updating only `:467`
leaves a test that can never pass, since nothing in this task changes the frame the
fixture sends.

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent.test.ts --config config/vitest/vitest.server.config.ts` (if that flag path fails, run it via `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent.test.ts` and use whichever config the file's header/existing CI uses).
Expected: PASS immediately (the server passes the decision through verbatim; this pair
documents the new `{ behavior: 'allow' }` wire shape rather than gating the client fix).

- [ ] **Step 3: Fix both client sites (GREEN)**

`FreshAgentView.tsx:2344` (manual Allow) and `:2214` (always-allow auto-approve): change

```ts
decision: { behavior: 'allow', updatedInput: {} },
```

to

```ts
// A defined updatedInput (even {}) wholesale REPLACES the tool input server-side
// (sdk-bridge resolves the decision verbatim). Omit the key entirely.
decision: { behavior: 'allow' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run the client command from Step 2 and the server command from Step 2b. Expected: PASS, including the rest of both suites.

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "fix(fresh-agent): omit updatedInput from browser Allow decision (wholesale-replace bug)"
```

---

### Task 7: Deck side-effect actions (focus / approve / stop)

**Files:**
- Create: `src/lib/terminal-interrupt.ts`
- Create: `src/deck/deck-actions.ts`
- Test: `test/unit/client/deck/deck-actions.test.ts`

**Interfaces:**
- Consumes: `getWsClient` (`@/lib/ws-client`), `buildTerminalInputMessage` (`@/components/terminal-view-utils`), `dismissTabGreen` (`@/store/turnCompletionAttention`), `setActiveTab` (`@/store/tabsSlice`), `ApproveTarget`/`StopTarget` (Task 3).
- Produces:

```ts
// src/lib/terminal-interrupt.ts
import type { TerminalPaneContent } from '@/store/paneTypes'
export type InterruptKey = 'esc' | 'ctrl-c'
export function sendTerminalInterrupt(content: TerminalPaneContent | null | undefined, terminalId: string, key: InterruptKey): void
// sends buildTerminalInputMessage(content, terminalId, key === 'esc' ? '\x1b' : '\x03') via getWsClient().send

// src/deck/deck-actions.ts
import type { AppDispatch, RootState } from '@/store/store'
export type DeckStore = { getState(): RootState; dispatch: AppDispatch }
export function focusTabFromDeck(store: DeckStore, tabId: string): void
export function sendDeckApproval(target: import('./deck-selectors').ApproveTarget): void
export function executeDeckStop(target: import('./deck-selectors').StopTarget, escalate: boolean): void
```

Semantics: `focusTabFromDeck` = `if (state.settings.settings.panes.attentionDismiss === 'click') dispatch(dismissTabGreen(tabId))` then `dispatch(setActiveTab(tabId))`. `sendDeckApproval` sends `{ type: 'freshAgent.approval.respond', sessionId, sessionType, provider, requestId, ...(target.cwd ? { cwd: target.cwd } : {}), decision: { behavior: 'allow' } }` — **no `updatedInput` key**; `cwd` is present exactly when the target carries it (freshopencode — the server's auth key embeds cwd, and a cwd-less frame for a durable `ses_` session dies `UNAUTHORIZED`; claude/codex/kilroy targets have no `cwd`). The exact `sessionType` from the target is forwarded (kilroy sends `sessionType: 'kilroy'` with `provider: 'claude'`, matching FreshAgentView). `executeDeckStop`: fresh-agent → `{ type: 'freshAgent.interrupt', sessionId, sessionType, provider, ...(target.cwd ? { cwd: target.cwd } : {}) }`; terminal → `sendTerminalInterrupt(content, terminalId, escalate ? 'ctrl-c' : 'esc')`. (Escalation *timing* lives in the controller, Task 9 — this module is stateless.)

**Accepted residual (A9):** after a WS reconnect or a fresh mount there is a transient window where per-connection fresh-agent auth isn't re-established yet (the client auto re-attaches every pane, paced by a rebind queue) — a deck action sent in that window is silently dropped (`UNAUTHORIZED` error frame with no requestId to correlate). Accepted: the user presses the key again; deck-actions stay fire-and-forget with no attach logic.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/client/deck/deck-actions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import settingsReducer from '@/store/settingsSlice'
import { executeDeckStop, focusTabFromDeck, sendDeckApproval } from '@/deck/deck-actions'
import { sendTerminalInterrupt } from '@/lib/terminal-interrupt'

beforeEach(() => sendMock.mockClear())

function makeStore(attention: Record<string, boolean> = {}) {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer, settings: settingsReducer },
    preloadedState: {
      tabs: { tabs: [{ id: 't1', createRequestId: 'c1', title: 'a', status: 'running', mode: 'shell', createdAt: 1 }], activeTabId: null, renameRequestTabId: null, tombstones: [] },
      turnCompletion: { seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [], attentionByTab: attention, attentionByPane: {} },
    } as never,
  })
}

describe('focusTabFromDeck', () => {
  it('dismisses green then activates, matching a TabBar click', () => {
    const store = makeStore({ t1: true })
    focusTabFromDeck(store as never, 't1')
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t1')
    expect(state.turnCompletion.attentionByTab.t1).toBeFalsy()
  })
})

describe('sendDeckApproval', () => {
  it('sends the allow decision WITHOUT updatedInput', () => {
    sendDeckApproval({ sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toEqual({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
      requestId: 'r1', decision: { behavior: 'allow' },
    })
    expect('updatedInput' in frame.decision).toBe(false)
    expect('cwd' in frame).toBe(false) // claude/codex/kilroy frames stay cwd-less
  })

  it('includes cwd for a freshopencode target (server auth keys embed it)', () => {
    sendDeckApproval({ sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'r9', cwd: '/repo/a' })
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode',
      requestId: 'r9', cwd: '/repo/a', decision: { behavior: 'allow' },
    })
  })
})

describe('executeDeckStop', () => {
  const termContent = { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell' } as never

  it('fresh-agent target -> freshAgent.interrupt (never terminal input)', () => {
    executeDeckStop({ kind: 'fresh-agent', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude' }, false)
    expect(sendMock).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    expect('cwd' in sendMock.mock.calls[0][0]).toBe(false)
  })

  it('freshopencode target -> interrupt frame carries cwd', () => {
    executeDeckStop({ kind: 'fresh-agent', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a' }, false)
    expect(sendMock).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a',
    })
  })

  it('terminal target -> ESC first, Ctrl+C when escalating', () => {
    executeDeckStop({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1', content: termContent }, false)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    executeDeckStop({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1', content: termContent }, true)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
  })
})

describe('sendTerminalInterrupt', () => {
  it('uses buildTerminalInputMessage so expectedSessionRef is preserved when derivable', () => {
    sendTerminalInterrupt(
      { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell', serverInstanceId: 'srv-1' } as never,
      'term-1', 'esc',
    )
    const frame = sendMock.mock.calls[0][0]
    expect(frame.type).toBe('terminal.input')
    expect(frame.data).toBe('\x1b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-actions.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/terminal-interrupt.ts  (modeled on src/lib/terminal-kill.ts)
import { getWsClient } from '@/lib/ws-client'
import { buildTerminalInputMessage } from '@/components/terminal-view-utils'
import type { TerminalPaneContent } from '@/store/paneTypes'

export type InterruptKey = 'esc' | 'ctrl-c'
const KEY_DATA: Record<InterruptKey, string> = { esc: '\x1b', 'ctrl-c': '\x03' }

export function sendTerminalInterrupt(
  content: TerminalPaneContent | null | undefined,
  terminalId: string,
  key: InterruptKey,
): void {
  getWsClient().send(buildTerminalInputMessage(content, terminalId, KEY_DATA[key]))
}
```

```ts
// src/deck/deck-actions.ts
import { getWsClient } from '@/lib/ws-client'
import { setActiveTab } from '@/store/tabsSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { sendTerminalInterrupt } from '@/lib/terminal-interrupt'
import type { AppDispatch, RootState } from '@/store/store'
import type { ApproveTarget, StopTarget } from './deck-selectors'

export type DeckStore = { getState(): RootState; dispatch: AppDispatch }

export function focusTabFromDeck(store: DeckStore, tabId: string): void {
  if (store.getState().settings.settings.panes.attentionDismiss === 'click') {
    store.dispatch(dismissTabGreen(tabId) as never)
  }
  store.dispatch(setActiveTab(tabId))
}

export function sendDeckApproval(target: ApproveTarget): void {
  getWsClient().send({
    type: 'freshAgent.approval.respond',
    sessionId: target.sessionId,
    sessionType: target.sessionType,
    provider: target.provider,
    requestId: target.requestId,
    // freshopencode auth keys embed cwd server-side; cwd-less durable-opencode frames die UNAUTHORIZED.
    // The selector (Task 3) sets target.cwd only for freshopencode; claude/codex/kilroy stay cwd-less.
    ...(target.cwd ? { cwd: target.cwd } : {}),
    // A defined updatedInput (even {}) wholesale replaces the tool input. Omit it.
    decision: { behavior: 'allow' },
  })
}

export function executeDeckStop(target: StopTarget, escalate: boolean): void {
  if (target.kind === 'fresh-agent') {
    // HARD RULE: never send raw keys to a fresh-agent pane (they become prompt text).
    getWsClient().send({
      type: 'freshAgent.interrupt',
      sessionId: target.sessionId,
      sessionType: target.sessionType,
      provider: target.provider,
      ...(target.cwd ? { cwd: target.cwd } : {}),
    })
    return
  }
  sendTerminalInterrupt(target.content, target.terminalId, escalate ? 'ctrl-c' : 'esc')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminal-interrupt.ts src/deck/deck-actions.ts test/unit/client/deck/deck-actions.test.ts
git commit -m "feat(deck): focus/approve/stop side-effect actions and terminal interrupt helper"
```

---

### Task 8: Preview registry (`terminal-text-registry`)

**Files:**
- Create: `src/deck/terminal-text-registry.ts`
- Test: `test/unit/client/deck/terminal-text-registry.test.ts`

**Interfaces:**
- Produces:

```ts
// src/deck/terminal-text-registry.ts
export type TerminalTextReader = () => string[]
export function registerTerminalTextReader(terminalId: string, reader: TerminalTextReader): () => void
export function getTerminalTextSnapshot(terminalId: string): string[] | null
export function resetTerminalTextRegistryForTests(): void

// Structural xterm shape so tests need no real xterm:
export type XtermLike = {
  buffer: {
    active: {
      length: number
      viewportY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}
export function readXtermTail(term: XtermLike, maxLines: number): string[]
// Reads the last maxLines rows ending at the bottom of the buffer
// (indices [length - maxLines, length)), translateToString(true), preserving order.

import type { MutableRefObject } from 'react'
export function useTerminalTextRegistration(
  terminalId: string | undefined,
  termRef: MutableRefObject<XtermLike | null>,
  maxLines?: number, // default 12
): void
// useEffect keyed on terminalId: registers a reader that reads termRef.current
// lazily (null-safe -> []), unregisters on cleanup/terminalId change.
```

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/client/deck/terminal-text-registry.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import {
  getTerminalTextSnapshot, readXtermTail, registerTerminalTextReader,
  resetTerminalTextRegistryForTests, useTerminalTextRegistration,
} from '@/deck/terminal-text-registry'
import type { XtermLike } from '@/deck/terminal-text-registry'

afterEach(() => resetTerminalTextRegistryForTests())

function fakeXterm(lines: string[]): XtermLike {
  return {
    buffer: {
      active: {
        length: lines.length,
        viewportY: 0,
        getLine: (y: number) => (lines[y] === undefined ? undefined : { translateToString: () => lines[y] }),
      },
    },
  }
}

describe('registry', () => {
  it('registers, reads, and unregisters readers', () => {
    const off = registerTerminalTextReader('term-1', () => ['hello'])
    expect(getTerminalTextSnapshot('term-1')).toEqual(['hello'])
    expect(getTerminalTextSnapshot('nope')).toBeNull()
    off()
    expect(getTerminalTextSnapshot('term-1')).toBeNull()
  })
})

describe('readXtermTail', () => {
  it('returns the last N buffer lines in order', () => {
    const term = fakeXterm(['a', 'b', 'c', 'd', 'e'])
    expect(readXtermTail(term, 3)).toEqual(['c', 'd', 'e'])
    expect(readXtermTail(term, 10)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('useTerminalTextRegistration', () => {
  function Probe({ terminalId, term }: { terminalId?: string; term: XtermLike | null }) {
    const ref = createRef<XtermLike | null>() as { current: XtermLike | null }
    ref.current = term
    useTerminalTextRegistration(terminalId, ref, 3)
    return null
  }
  it('registers while mounted and cleans up on unmount', () => {
    const { unmount } = render(<Probe terminalId="term-9" term={fakeXterm(['x', 'y'])} />)
    expect(getTerminalTextSnapshot('term-9')).toEqual(['x', 'y'])
    unmount()
    expect(getTerminalTextSnapshot('term-9')).toBeNull()
  })
  it('no-ops without a terminalId and tolerates a null term', () => {
    render(<Probe terminalId={undefined} term={null} />)
    expect(getTerminalTextSnapshot('undefined')).toBeNull()
    const { rerender } = render(<Probe terminalId="term-8" term={null} />)
    expect(getTerminalTextSnapshot('term-8')).toEqual([])
    rerender(<Probe terminalId="term-8" term={fakeXterm(['z'])} />)
    expect(getTerminalTextSnapshot('term-8')).toEqual(['z'])
  })
})
```

(File extension: `.test.tsx` if JSX requires it — name it `terminal-text-registry.test.tsx`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/terminal-text-registry.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/deck/terminal-text-registry.ts
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'

export type TerminalTextReader = () => string[]
const readers = new Map<string, TerminalTextReader>()

export function registerTerminalTextReader(terminalId: string, reader: TerminalTextReader): () => void {
  readers.set(terminalId, reader)
  return () => {
    if (readers.get(terminalId) === reader) readers.delete(terminalId)
  }
}
export function getTerminalTextSnapshot(terminalId: string): string[] | null {
  const reader = readers.get(terminalId)
  return reader ? reader() : null
}
export function resetTerminalTextRegistryForTests(): void {
  readers.clear()
}

export type XtermLike = {
  buffer: {
    active: {
      length: number
      viewportY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

export function readXtermTail(term: XtermLike, maxLines: number): string[] {
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - maxLines)
  const out: string[] = []
  for (let y = start; y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return out
}

export function useTerminalTextRegistration(
  terminalId: string | undefined,
  termRef: MutableRefObject<XtermLike | null>,
  maxLines = 12,
): void {
  useEffect(() => {
    if (!terminalId) return
    return registerTerminalTextReader(terminalId, () => {
      const term = termRef.current
      return term ? readXtermTail(term, maxLines) : []
    })
  }, [terminalId, termRef, maxLines])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/terminal-text-registry.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/terminal-text-registry.ts test/unit/client/deck/terminal-text-registry.test.tsx
git commit -m "feat(deck): live-xterm text reader registry for tab previews"
```

---

### Task 9: DeckController (painting, input, action layer, paging, idle dim)

**Files:**
- Create: `src/deck/deck-controller.ts`
- Test: `test/unit/client/deck/deck-controller.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8 (`DeckDevice`, `selectDeckModel`, `buildFrame`/`planLayout`/`pageCount`, `KeyRenderer`/`StripRenderer` shapes, `focusTabFromDeck`/`sendDeckApproval`/`executeDeckStop`, `findApproveTarget`/`findStopTarget`, `getTerminalTextSnapshot`).
- Produces:

```ts
// src/deck/deck-controller.ts
import type { DeckDevice } from './deck-device'
import type { KeySpec } from './frame'
import type { DeckCapabilities } from './deck-device'
import type { DeckStore } from './deck-actions'

export type DeckControllerOptions = {
  store: DeckStore & { subscribe(cb: () => void): () => void }
  device: DeckDevice
  renderKey?: (spec: KeySpec, caps: DeckCapabilities) => Uint8ClampedArray   // default: tile-renderer via defaultCtxFactory
  renderStrip?: (text: string, width: number, height: number) => Uint8ClampedArray
  settings: () => { brightness: number; idleBrightness: number; idleTimeoutSeconds: number }
  now?: () => number                       // default Date.now
}
export const LONG_PRESS_MS = 500
export const ACTION_LAYER_TIMEOUT_MS = 10_000
export const STOP_ESCALATE_MS = 5_000
export const TICK_MS = 500
export const PREVIEW_REFRESH_TICKS = 6     // previews re-checked every 3s

export class DeckController {
  constructor(options: DeckControllerOptions)
  start(): void      // paints initial frame, asserts brightness, subscribes, starts tick interval
  stop(): void       // unsubscribes, clears interval, clears device (best-effort), removes listeners
}
```

Behavior (single stateful class; private fields `page`, `actionLayer: { tabId, openedAt } | null`, `pressedAt: Map<number, number>`, `lastStopAt: Map<string, number>` (per paneId), `lastActivityAt`, `dimmed`, `lastPaintedSpecs: string[]` (JSON of each key spec), `lastStripText: string | null`, `tickCount`):

1. **Painting**: `repaint()` computes `buildFrame({ model: selectDeckModel(store.getState()), caps, page, actionLayer: actionLayerInputs(), previewFor })` where `previewFor(tabId)` finds the tab's focused pane (`state.panes.activePane[tabId]`, then `findPaneContent`) and, when it is a terminal pane with a `terminalId`, returns `getTerminalTextSnapshot(terminalId) ?? []`; else `[]`. Diff per key on `JSON.stringify(spec)`; only changed keys go through `renderKey` → `device.setKeyImage`. Strip: painted only when `strip.text` changed. If any key/strip actually painted → `noteRepaintActivity()` (wakes from dim).
2. **Store subscription**: on every store notification, recompute + clamp `page` to the new `pageCount` (rebuild page to 1 if `tabsPerPage` changed), and `repaint()`. Cheap guard (ordering is load-bearing, A10a): the JSON compare of the `selectDeckModel` output happens **BEFORE any xterm buffer reads** — if the model is unchanged, skip without touching `previewFor`. Previews are only re-read on the periodic preview-refresh tick and on actual repaints (model changed), never on every dispatch. Benchmarked: 13.2 µs/dispatch at 20 tabs — no memoization needed.
3. **Key input**: `keyDown` → `pressedAt.set(k, now())`, `noteActivity()`. `keyUp` → duration = `now() - pressedAt.pop(k)` (ignore unmatched). If action layer open → `handleActionKey(k)` regardless of duration. Else classify via `planLayout`: pager key → advance page (wrap past last page to 1) + repaint; tab slot with a visible tab → duration ≥ `LONG_PRESS_MS` ? open action layer (`actionLayer = { tabId, openedAt: now() }`, repaint) : `focusTabFromDeck(store, tabId)` (repaint happens via store subscription; also call `repaint()` directly for optimistic immediacy); empty slot → ignore.
4. **Action layer**: `actionLayerInputs()` = `{ tabId, approveEnabled: findApproveTarget(state, tabId) !== null, stopEnabled: findStopTarget(state, tabId) !== null }`. `handleActionKey`: BACK(0) → close+repaint. APPROVE(1) → re-read target; `null` → stay open; else `sendDeckApproval(target)`, `store.dispatch(dismissTabGreen(tabId))` gated as in focus, close+repaint. STOP(2) → re-read target; `null` → stay open; else `escalate = target.kind === 'terminal' && lastStopAt has paneId within STOP_ESCALATE_MS`; `executeDeckStop(target, escalate)`; if terminal, `lastStopAt.set(paneId, now())`; close+repaint. Other keys → ignored.
5. **Dials** (only when `planLayout(...).useDials`): `dialRotate` dial 0 → cycle active tab by ticks with wrap-around modulo over `model.tabs`, then `focusTabFromDeck`; dial 0 press → re-focus current active tab; dial 1 rotate → `page = clampPage(page + ticks, pages)` + repaint; dial 1 press → `page = 1` + repaint. All dial events `noteActivity()`.
6. **Touch**: `touchTap` → `noteActivity()` only.
7. **Idle dim**: every `TICK_MS` tick: close action layer if `now() - openedAt >= ACTION_LAYER_TIMEOUT_MS`; if `idleTimeoutSeconds > 0 && !dimmed && now() - lastActivityAt >= idleTimeoutSeconds * 1000` → `dimmed = true; device.setBrightness(idleBrightness)`. `noteActivity()`: `lastActivityAt = now()`; if dimmed → `dimmed = false; device.setBrightness(brightness)`. Waking input still performs its action (wake is not swallow). Every `PREVIEW_REFRESH_TICKS` ticks → `repaint()` (picks up xterm buffer changes; diffing keeps it cheap and only real changes count as activity).
8. **start()**: `device.setBrightness(settings().brightness)`, initial `repaint()`, subscribe store, `device.onInput(...)`, `setInterval(tick, TICK_MS)`, and a `document.addEventListener('visibilitychange', ...)` that runs a `tick()` catch-up pass when the tab becomes visible. **stop()**: tear all down (incl. the visibilitychange listener); `void device.clear()`.

**Timing constraint (load-bearing, A4/A3 verified):** ALL durations — long-press classification, action-layer auto-close (10s), STOP escalation window (5s), idle dim — are computed from `Date.now()` deltas against event timestamps, **NEVER from tick counts**. Hidden tabs throttle `setInterval` to ~1/min (Chrome intensive throttling); tick-count math would inflate every duration ~120×. The 500ms tick may therefore fire as rarely as once a minute while hidden — acceptable degradation: auto-close late by ≤60s, dim late by ~60s, previews stale up to ~60s while hidden (invisible anyway). Reconcile timers on `visibilitychange` (item 8) and on any HID input event: run the same duty checks (`tick()` logic) at the top of every input handler — HID input dispatch is NOT throttled in background tabs (verified), so each press is an exact wakeup. Related residual (note in the README, Task 16): Chrome's Memory Saver can DISCARD a long-hidden tab despite the open HID connection (HID is not on the discard-exempt list) — the deck goes dark until the tab is revisited; accepted residual.

- [ ] **Step 1: Write the failing tests**

Use a real store (reducers from Task 3's test plus `settings`), `FakeDeckDevice`, a spec-recording renderer, `vi.useFakeTimers()` + `vi.setSystemTime` so `Date.now` drives both durations and ticks, and `vi.mock('@/lib/ws-client')` for approve/stop frames.

```ts
// test/unit/client/deck/deck-controller.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer from '@/store/settingsSlice'
import { FakeDeckDevice, MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'
import { DeckController, LONG_PRESS_MS } from '@/deck/deck-controller'
import type { KeySpec } from '@/deck/frame'

// ... makeStore(preloaded) mirroring Task 3's fixture builder, parameterized by
// tab count / busy / pending permissions (build tabs t1..tN, terminal leaf panes p1..pN
// with terminalId term-N, mode 'claude'; one fresh-agent tab where needed).

function specRenderer() {
  const painted: Array<{ key: number; spec: KeySpec }> = []
  const renderKey = (spec: KeySpec) => {
    // encode the spec so tests can decode what landed on the device
    return new TextEncoder().encode(JSON.stringify(spec)) as unknown as Uint8ClampedArray
  }
  return { painted, renderKey }
}
function decodeKey(device: FakeDeckDevice, key: number): KeySpec | null {
  const buf = device.keyImages.get(key)
  return buf ? JSON.parse(new TextDecoder().decode(buf as unknown as Uint8Array)) : null
}

const settings = () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sendMock.mockClear()
})
afterEach(() => vi.useRealTimers())

// Tests (each constructs store+device+controller, calls start(), and tears down with stop()):

it('paints tab tiles in tab order with active ring and asserts brightness on start', ...)
// decodeKey(device, 0) matches { kind:'tab', tabId:'t1', active:true }; brightnessHistory[0] === 100

it('short press focuses the tab in the browser and dismisses green', ...)
// seed attentionByTab.t2, device.emit keyDown(1); advance 100ms; keyUp(1)
// -> store.getState().tabs.activeTabId === 't2'; attentionByTab.t2 falsy; key 1 repainted with active:true

it('store changes repaint only changed keys', ...)
// clear device.keyImages after start; dispatch(markTabAttention({tabId:'t1'})); key 0 repainted with ring 'green'; key 1 untouched

it('overflow paging: pager press advances and wraps', ...)
// 8 tabs on MINI: key 5 pager page 1/2; press key 5 -> page 2 (key 0 shows tab-6... adjust ids); press again -> wraps to 1

it('long press opens the action layer; BACK closes; 10s auto-closes', ...)
// keyDown(0); advance 600ms; keyUp(0) -> decodeKey(device,0).kind === 'action'
// press key 0 (BACK) -> back to tab tiles; reopen; advance 10_500ms via timers -> closed

it('APPROVE sends the allow frame without updatedInput and closes the layer', ...)
// fresh-agent tab with pendingPermissions r1; long-press its key; press key 1
// sendMock called with freshAgent.approval.respond, decision === { behavior: 'allow' }

it('disabled APPROVE press keeps the layer open', ...)
// no pending permission; press key 1; layer still action; sendMock not called

it('STOP on a busy terminal sends ESC, then Ctrl+C within 5s', ...)
// claudeActivity busy on term-1; long-press key 0; press key 2 -> terminal.input '\x1b'
// reopen layer; press key 2 again (within 5s of first stop) -> '\x03'

it('STOP on a busy fresh-agent pane sends freshAgent.interrupt, never terminal.input', ...)

it('idle dim after timeout and wake on key press (wake does not swallow the press)', ...)
// advance 300_000ms of ticks -> brightnessHistory ends with 10
// press key 1 -> brightness 100 appended AND activeTabId becomes 't2'

it('dials on PLUS: dial 0 cycles with wrap, dial 1 pages with clamp, strip updates', ...)
// PLUS_CAPS, 10 tabs: emit dialRotate(0, 1) -> active moves t1->t2 (wrap check with -1 from t1 -> t10)
// dialRotate(1, 5) -> page clamped to 2; dialPress(1) -> page 1; device.stripImage reflects text via injected renderStrip recorder
```

Write these out fully (they are the heart of the feature); use the `makeStore` fixture pattern from Task 3 verbatim, extended with a `tabCount` parameter. Inject `renderStrip` as a recorder returning an encoded text buffer so strip assertions decode `device.stripImage`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/deck/deck-controller.ts` per the behavior spec above (GREEN one test at a time)**

Implementation skeleton:

```ts
import { clampPage, buildFrame, pageCount, planLayout, ACTION_KEYS } from './frame'
import type { FrameSpec, KeySpec } from './frame'
import { selectDeckModel, findApproveTarget, findStopTarget } from './deck-selectors'
import { executeDeckStop, focusTabFromDeck, sendDeckApproval } from './deck-actions'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { findPaneContent } from '@/lib/pane-utils'
import { getTerminalTextSnapshot } from './terminal-text-registry'
import { renderKey as canvasRenderKey, renderStrip as canvasRenderStrip, defaultCtxFactory } from './tile-renderer'
// class DeckController { ... } as specified in Interfaces/Behavior above
```

Keep every branch small; extract private methods `repaint`, `handleKeyUp`, `handleActionKey`, `handleDial`, `tick`, `noteActivity`. The tick uses `setInterval(() => this.tick(), TICK_MS)`; fake timers drive it in tests. REFACTOR pass: after green, ensure no duplicated `planLayout` computation per event (compute per handler from current state; do not cache stale plans).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts`
Expected: PASS (all scenarios).

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-controller.ts test/unit/client/deck/deck-controller.test.ts
git commit -m "feat(deck): DeckController - diff painting, press routing, action layer, paging, dials, idle dim"
```

---

### Task 10: WebHID transport

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/deck/webhid-transport.ts`
- Test: `test/unit/client/deck/webhid-transport.test.ts`

**Interfaces:**
- Consumes: `@elgato-stream-deck/webhid` (`requestStreamDecks`, **`openDevice(hidDevice)`** (public export), `StreamDeckWeb`: `CONTROLS`, `PRODUCT_NAME`, `fillKeyBuffer(index, buffer, { format: 'rgba' })`, `fillLcd`, `setBrightness(0-100)`, `clearPanel`, `close`, events `down`/`up`/`rotate`/`lcdShortPress`), plus `navigator.hid` (`getDevices()`, `'disconnect'` events). Full API notes: `.worktrees/.the-usual-logs/stream-deck-webhid/reports/webhid-lib.md`. **Do NOT use `getStreamDecks()`** — it silently swallows open failures (`.catch(() => null)` + filter, webhid `index.js:41-44`) and can never signal in-use.
- Produces:

```ts
// src/deck/webhid-transport.ts
import type { DeckDevice } from './deck-device'
export class DeckOpenError extends Error { constructor(readonly reason: 'in-use' | 'unknown', message: string) }
export async function requestWebHidDeck(): Promise<DeckDevice | null>   // user gesture; null = user cancelled the picker (or Electron's handler-less requestDevice() -> [])
export async function getGrantedWebHidDeck(): Promise<DeckDevice | null> // silent reconnect: navigator.hid.getDevices() -> filter Elgato vendor -> lib openDevice() per device; null = no granted deck
// both throw DeckOpenError('in-use') when the OS-level open fails: the failure surfaces as a
// `NetworkError` DOMException (note: indistinguishable from a Linux udev permission denial —
// which is why the UI status copy says "in use by another app — or missing device permissions (Linux udev)")
```

Capability derivation: walk `deck.CONTROLS` — entries with `type: 'button'` contribute `keyCount`/`keyRows = max(row)+1`/`keyColumns = max(column)+1` and `keyPixelWidth/Height` from the button's `pixelSize`; `type: 'encoder'` entries → `dialCount`; `type: 'lcd-segment'` → `hasTouchStrip` + strip pixel size from its `pixelSize: { width: 800, height: 100 }` field (the control also carries `id: 0` and `drawRegions: true`). Key indices arrive in reading order (0 = top-left) on every model — the lib normalizes the 15-key right-to-left layout internally via `hidIndex`. Event normalization: the lib's `down`/`up` events fire for BOTH buttons and encoders, with control objects `{ type: 'button' | 'encoder', index, ... }` whose indices collide (Plus encoders 0-3 vs buttons 0-7) — the transport MUST branch on `control.type`: `button` → `keyDown`/`keyUp`; `encoder` → emit `{ type: 'dialPress', dialIndex: control.index }` on `down` (ignore the encoder `up`). `rotate` → `{ type: 'dialRotate', dialIndex, ticks: amount }`; `lcdShortPress` → `{ type: 'touchTap' }`. Error/disconnect lifecycle: the lib's `'error'` event **never fires** for Elgato webhid decks (webhid's only emit site is commented out, `hid-device.js:18`; the core relay is therefore dead) — **including on unplug**. Disconnect detection comes from `navigator.hid.addEventListener('disconnect', ...)`, matching `event.device` to the opened `HIDDevice`, plus write-promise rejections (`fillKeyBuffer`/`fillLcd` failures) as a secondary signal. Still attach a defensive `error` listener (harmless; log via `createLogger('StreamDeckWebHid')`, never `console.error`) — but nothing may rely on it. `setKeyImage` → `fillKeyBuffer(index, rgba, { format: 'rgba' })` — the lib accepts `Uint8ClampedArray` directly at exact `pixelSize` (no Node Buffer, no flipping — per-model flips are handled internally; wrong length throws `RangeError`); `setTouchStripImage` → `fillLcd(0, rgba, { format: 'rgba' })` — exactly one full-strip 800×100 RGBA buffer (320,000 bytes), the options argument is REQUIRED; `clear` → `clearPanel()`.

- [ ] **Step 1: Install dependencies**

```bash
npm install @elgato-stream-deck/webhid@^7.6.3
npm install -D @types/w3c-web-hid
```

Verify: `npm run typecheck` still passes (add `"w3c-web-hid"` to `tsconfig` `types` only if `navigator.hid` references fail to resolve — this task references it in the transport). The lib bundles under Vite with zero config changes (verified by a build spike on vite 6.4.3): no polyfills, no shims, no `vite.config` edits.

- [ ] **Step 2: Write the failing test (module mocked)**

```ts
// test/unit/client/deck/webhid-transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

class FakeLibDeck extends EventEmitter {
  PRODUCT_NAME = 'Stream Deck Mini'
  CONTROLS: Array<Record<string, unknown>> = [
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'button', index: i, row: Math.floor(i / 3), column: i % 3, pixelSize: { width: 80, height: 80 },
    })),
  ]
  fillKeyBuffer = vi.fn(async () => {})
  fillLcd = vi.fn(async () => {})
  setBrightness = vi.fn(async () => {})
  clearPanel = vi.fn(async () => {})
  close = vi.fn(async () => {})
}
function plusControls(): Array<Record<string, unknown>> {
  return [
    ...Array.from({ length: 8 }, (_, i) => ({
      type: 'button', index: i, row: Math.floor(i / 4), column: i % 4, pixelSize: { width: 120, height: 120 },
    })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'encoder', index: i, hidIndex: i })),
    { type: 'lcd-segment', id: 0, pixelSize: { width: 800, height: 100 }, drawRegions: true },
  ]
}

// The lib is mocked at the two exports the transport uses. getStreamDecks is
// deliberately NOT exported here — the transport must not import it.
const requestStreamDecks = vi.fn(async (): Promise<FakeLibDeck[]> => [])
const openDevice = vi.fn(async (_dev: unknown): Promise<FakeLibDeck> => new FakeLibDeck())
vi.mock('@elgato-stream-deck/webhid', () => ({
  requestStreamDecks: (...a: never[]) => requestStreamDecks(...a),
  openDevice: (...a: never[]) => openDevice(...a),
}))

import { getGrantedWebHidDeck, requestWebHidDeck, DeckOpenError } from '@/deck/webhid-transport'

// jsdom has no navigator.hid: stub getDevices + disconnect events.
type FakeHidDevice = { vendorId: number; productId: number }
const ELGATO = 0x0fd9
function stubHid(devices: FakeHidDevice[]) {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const hid = {
    getDevices: vi.fn(async () => devices),
    addEventListener: (t: string, cb: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(cb)
    },
    removeEventListener: (t: string, cb: (e: unknown) => void) => listeners.get(t)?.delete(cb),
    fire: (t: string, event: unknown) => listeners.get(t)?.forEach((cb) => cb(event)),
  }
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true })
  return hid
}

beforeEach(() => {
  requestStreamDecks.mockClear()
  openDevice.mockClear()
  openDevice.mockImplementation(async () => new FakeLibDeck())
})
afterEach(() => {
  Reflect.deleteProperty(navigator as object, 'hid')
})

describe('webhid transport', () => {
  it('derives capabilities from CONTROLS', async () => {
    stubHid([]) // wrap() registers the navigator.hid disconnect listener
    requestStreamDecks.mockResolvedValueOnce([new FakeLibDeck()])
    const dev = await requestWebHidDeck()
    expect(dev?.capabilities).toMatchObject({
      model: 'Stream Deck Mini', keyCount: 6, keyRows: 2, keyColumns: 3,
      keyPixelWidth: 80, keyPixelHeight: 80, dialCount: 0, hasTouchStrip: false,
    })
  })

  it('returns null on an empty picker result (user cancel — or Electron, which always resolves [])', async () => {
    expect(await requestWebHidDeck()).toBeNull()
  })

  it('silent reconnect enumerates getDevices() and opens Elgato-vendor devices via the lib openDevice export', async () => {
    const granted: FakeHidDevice = { vendorId: ELGATO, productId: 0x0063 }
    stubHid([{ vendorId: 0x1234, productId: 0x1 }, granted])
    const dev = await getGrantedWebHidDeck()
    expect(dev).not.toBeNull()
    expect(openDevice).toHaveBeenCalledTimes(1)
    expect(openDevice).toHaveBeenCalledWith(granted)
  })

  it('returns null from getGrantedWebHidDeck when no Elgato device is granted', async () => {
    stubHid([{ vendorId: 0x1234, productId: 0x1 }])
    expect(await getGrantedWebHidDeck()).toBeNull()
    expect(openDevice).not.toHaveBeenCalled()
  })

  it('forwards button events, branching on control.type', async () => {
    const lib = new FakeLibDeck()
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    const seen: unknown[] = []
    dev.onInput((e) => seen.push(e))
    lib.emit('down', { type: 'button', index: 4 })
    lib.emit('up', { type: 'button', index: 4 })
    expect(seen).toEqual([{ type: 'keyDown', keyIndex: 4 }, { type: 'keyUp', keyIndex: 4 }])
  })

  it('encoder down does NOT become a keyDown — it becomes a dialPress (indices collide on the Plus)', async () => {
    const lib = new FakeLibDeck()
    lib.PRODUCT_NAME = 'Stream Deck +'
    lib.CONTROLS = plusControls()
    stubHid([{ vendorId: ELGATO, productId: 0x0084 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    expect(dev.capabilities).toMatchObject({ dialCount: 4, hasTouchStrip: true, touchStripPixelWidth: 800, touchStripPixelHeight: 100 })
    const seen: unknown[] = []
    dev.onInput((e) => seen.push(e))
    lib.emit('down', { type: 'encoder', index: 1 })
    lib.emit('up', { type: 'encoder', index: 1 })
    expect(seen).toEqual([{ type: 'dialPress', dialIndex: 1 }])
  })

  it('paints keys via fillKeyBuffer with rgba format and forwards brightness/clear/close', async () => {
    const lib = new FakeLibDeck()
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    const buf = new Uint8ClampedArray(80 * 80 * 4)
    await dev.setKeyImage(2, buf)
    expect(lib.fillKeyBuffer).toHaveBeenCalledWith(2, expect.anything(), { format: 'rgba' })
    await dev.setBrightness(55)
    expect(lib.setBrightness).toHaveBeenCalledWith(55)
    await dev.clear()
    expect(lib.clearPanel).toHaveBeenCalled()
    await dev.close()
    expect(lib.close).toHaveBeenCalled()
  })

  it('maps a NetworkError DOMException from openDevice to DeckOpenError(in-use)', async () => {
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockRejectedValueOnce(new DOMException('Failed to open the device.', 'NetworkError'))
    const failure = await getGrantedWebHidDeck().then(() => null, (e: unknown) => e)
    expect(failure).toBeInstanceOf(DeckOpenError)
    expect((failure as DeckOpenError).reason).toBe('in-use')
  })

  it('navigator.hid disconnect for the opened device drives onDisconnect (the lib error event never fires)', async () => {
    const granted: FakeHidDevice = { vendorId: ELGATO, productId: 0x0063 }
    const hid = stubHid([granted])
    const dev = (await getGrantedWebHidDeck())!
    const cb = vi.fn()
    dev.onDisconnect(cb)
    hid.fire('disconnect', { device: { vendorId: 0x9999, productId: 0x1 } }) // some other device
    expect(cb).not.toHaveBeenCalled()
    hid.fire('disconnect', { device: granted })
    hid.fire('disconnect', { device: granted })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/webhid-transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/deck/webhid-transport.ts`**

Wrap a lib deck in a `WebHidDeckDevice implements DeckDevice` class doing the derivations/normalizations from the Interfaces block.

- `requestWebHidDeck` = `const decks = await requestStreamDecks(); return decks[0] ? wrap(decks[0]) : null` — an empty array means the user cancelled the picker OR the app is Electron (whose handler-less `requestDevice()` always resolves `[]`): treat it as a clean no-op everywhere, **never index `[0]` blindly**.
- `getGrantedWebHidDeck` = enumerate `navigator.hid.getDevices()`, filter `device.vendorId === 0x0fd9` (Elgato), and call the lib's exported `openDevice(hidDevice)` on the first match — this is the only path where open failures are observable (`getStreamDecks()` swallows them). Return `null` when no Elgato device is granted.
- Open-failure classification (both entry points): catch, and if `error instanceof DOMException && error.name === 'NetworkError'` → `DeckOpenError('in-use', ...)` (do NOT match on message text — it is unspecified; note this same `NetworkError` is what a missing Linux udev rule produces), else `DeckOpenError('unknown', ...)`.
- `wrap(lib, hidDevice?)`: the `getGranted` path passes the `HIDDevice` it opened; the `request` path recovers it defensively via `(lib as { hid?: { device?: HIDDevice } }).hid?.device` (untyped but stable lib internals). Register `navigator.hid.addEventListener('disconnect', handler)` where `handler` fires the wrapper's disconnect listeners once iff `event.device` is the wrapped `HIDDevice` (remove the listener on `close()`). Secondary disconnect signal: if a `setKeyImage`/`setTouchStripImage` write promise rejects, log it and re-check `navigator.hid.getDevices()` — if the device is gone, fire the disconnect listeners. Attach a defensive `error` listener that only logs (it never fires for Elgato webhid decks — do not build any behavior on it).
- Input wiring: `down`/`up` handlers receive a control object and MUST branch on `control.type` — `'button'` → `keyDown`/`keyUp` with `keyIndex: control.index`; `'encoder'` → `dialPress` with `dialIndex: control.index` on `down` only (ignore encoder `up`). For Plus support include `encoder`/`lcd-segment` handling per the report (`rotate` handler signature `(control, amount)`), guarded so a deck without those never registers them. Use `createLogger('StreamDeckWebHid')`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/webhid-transport.test.ts`
Expected: PASS. Run `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/deck/webhid-transport.ts test/unit/client/deck/webhid-transport.test.ts
git commit -m "feat(deck): WebHID transport wrapping @elgato-stream-deck/webhid"
```

---

### Task 11: deckSlice + DeckManager + `useStreamDeck()` + App wiring

**Files:**
- Create: `src/store/deckSlice.ts`
- Create: `src/deck/deck-manager.ts`
- Create: `src/hooks/useStreamDeck.ts`
- Modify: `src/store/store.ts` (register `deck` reducer)
- Modify: `src/App.tsx` (call `useStreamDeck()` alongside the first three lifecycle hooks at :167-169)
- Test: `test/unit/client/deck/deck-manager.test.ts`

**Interfaces:**
- Consumes: Tasks 9–10, `isWebHidSupported`, `settings.streamDeck.*`, `navigator.locks` (Web Locks leader election; treated as "immediately leader" when absent) and `navigator.hid` `connect` events (both stubbed in jsdom tests below).
- Produces:

```ts
// src/store/deckSlice.ts  (runtime-only; NEVER add to any persistence allowlist)
export type DeckConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'in-use' | 'error'
export interface DeckSliceState {
  status: DeckConnectionStatus
  model: string | null
  keyCount: number | null
  virtualDeckOpen: boolean
}
export const { setDeckStatus, setVirtualDeckOpen } = deckSlice.actions
// setDeckStatus: PayloadAction<{ status: DeckConnectionStatus; model?: string | null; keyCount?: number | null }>
// setVirtualDeckOpen: PayloadAction<boolean>
export default deckSlice.reducer

// src/deck/deck-manager.ts
import type { Store } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
export type DeckTransports = {
  request: () => Promise<import('./deck-device').DeckDevice | null>
  getGranted: () => Promise<import('./deck-device').DeckDevice | null>
}
export function installStreamDeckManager(store: Store<RootState>, transports?: DeckTransports): () => void
export function requestDeckConnect(): Promise<void>   // called by the Settings button (user gesture)
export function resetStreamDeckManagerForTests(): void
```

Manager behavior:
- `installStreamDeckManager`: idempotent singleton (module-level state + reset-for-tests, per the `useEnsureExtensionsRegistry` pattern). If `!isWebHidSupported()` → `setDeckStatus({ status: 'unsupported' })` and do nothing else. Subscribes to the store watching `state.settings.settings.streamDeck.enabled`:
  - **On install, evaluate the current value first — do not wait for a transition.** Local settings hydrate synchronously from localStorage at store creation (`src/store/settingsSlice.ts:67-83` `loadInitialLocalSettings`), so for a returning user `enabled` is already `true` before `useStreamDeck()` installs the manager and no enabled-transition will ever be observed. Seed the subscription's change detector with `prev = false` (NOT the current store value) so an already-true `enabled` runs the exact same enable path below immediately at install time. This is the feature's headline persistence behavior — reload the page → silent `getDevices()` auto-reconnect — promised by Task 16's README copy ("auto-reconnects afterwards") and the Memory-Saver checkpoint; it is pinned by the "already enabled at install" test in Step 1.
  - enabled turning true → **Web Locks leader election wraps the enable lifecycle**: create a fresh `AbortController` for this enable cycle (`cycleAbort`) and call `navigator.locks.request('freshell-stream-deck', { mode: 'exclusive', signal: cycleAbort.signal }, () => { ... leaderGate })` where `leaderGate` is a deferred promise the manager resolves on disable/uninstall — the lock is held for the manager's enabled lifetime. The `signal` is essential: it is the ONLY way to withdraw a `locks.request` that is still queued behind another window's lock (without it, a disabled window would later seize the lock on handoff and connect with its toggle off). Catch and swallow the `AbortError` the aborted request rejects with. Until the lock callback runs (another freshell window is the leader) → `setDeckStatus({ status: 'in-use' })` (this is the same-origin "in use elsewhere / another window" case). When the callback runs, this window is the leader — including leadership handoff: when the previous leader closes or disables, the lock releases and this waiting window acquires it. **First thing inside the lock callback, re-check `store.getState().settings.settings.streamDeck.enabled` and that the manager is still installed with the same enable cycle (`cycleAbort.signal.aborted === false`); if not, return immediately (releasing the lock) without touching state or the device** — belt-and-suspenders for any path where the abort loses the race with the grant. Otherwise connect as leader: `setDeckStatus({status:'connecting'})`; `getGranted()`; device → adopt; `null` → `'disconnected'` (waiting for the user to press Connect); `DeckOpenError('in-use')` → `'in-use'` + arm retry (secondary signal: an OS app holds the device exclusively, e.g. an exclusive-mode holder on Windows — concurrent opens generally SUCCEED, see the locked exclusivity decision). If `navigator.locks` is missing (old browser / jsdom), skip the election and proceed as leader.
  - enabled turning false → `cycleAbort.abort()` (withdraws a still-queued `locks.request` so this window never becomes leader after the user turned it off — the disable-while-waiting case — and prevents a later re-enable from double-queuing; a fresh enable cycle creates a fresh controller), resolve `leaderGate` (releases the Web Lock, if held, so a waiting window can take over), tear down controller (`controller.stop()`, `device.close()`), `'disconnected'`. Pinned by the "disable while waiting" test in Step 1.
- Adopt(device): create `DeckController` with `settings: () => store.getState().settings.settings.streamDeck`, `start()`, `setDeckStatus({ status: 'connected', model: caps.model, keyCount: caps.keyCount })`; `device.onDisconnect(...)` → teardown → `'disconnected'` (hotplug replug then reconnects via the HID `connect` event below). Note: `device.onDisconnect` is driven by the transport's `navigator.hid` `'disconnect'` listener + write-rejection fallback — the lib's `'error'` event never fires and nothing may depend on it.
- Hotplug: `navigator.hid.addEventListener('connect', ...)` → if enabled, leader, and not connected, try `getGranted()` again.
- In-use retry: `window` listeners on `focus` and `visibilitychange` (when visible) → if status `in-use`, enabled, **and this window holds the leader lock**, retry `getGranted()` (covers the OS-app case; the non-leader case resolves itself via lock handoff, not retry).
- `requestDeckConnect()`: `request()` (user gesture); adopt on success; `null` (picker cancel — or Electron's handler-less `requestDevice()`, which always resolves `[]`) → keep prior status, clean no-op; `in-use` → `'in-use'`. Only meaningful for the leader; a non-leader window keeps status `'in-use'`.
- The uninstall function removes all listeners, calls `cycleAbort.abort()` (so a queued lock request from a torn-down manager can never fire its callback later — HMR safety), resolves `leaderGate`, and tears down (used by tests and HMR safety).
- `useStreamDeck()`: `useEffect(() => installStreamDeckManager(storeFromUseAppStore), [])` — one-liner hook using `useAppStore()`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/client/deck/deck-manager.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import deckReducer from '@/store/deckSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { FakeDeckDevice } from '@/deck/fake-deck-device'
import { DeckOpenError } from '@/deck/webhid-transport'
import {
  installStreamDeckManager, requestDeckConnect, resetStreamDeckManagerForTests,
} from '@/deck/deck-manager'

// jsdom has no navigator.hid: define a stub with add/removeEventListener so the
// manager can install hotplug listeners.
function stubHid() {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const hid = {
    addEventListener: (t: string, cb: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(cb)
    },
    removeEventListener: (t: string, cb: (e: unknown) => void) => listeners.get(t)?.delete(cb),
    fire: (t: string) => listeners.get(t)?.forEach((cb) => cb({})),
  }
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true })
  return hid
}

// jsdom has no navigator.locks either: a minimal exclusive-lock stub with FIFO
// handoff and AbortSignal support (per the Web Locks spec, aborting the signal
// of a still-queued request withdraws it and rejects with AbortError), for the
// leader-election tests. The manager treats a missing navigator.locks as
// "immediately leader", so the other tests need no stub.
function stubLocks() {
  let busy = false
  const waiters: Array<{ grant: () => void }> = []
  const locks = {
    async request(name: string, opts: { mode?: string; signal?: AbortSignal }, cb: (lock: unknown) => unknown) {
      const signal = opts?.signal
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (busy) {
        await new Promise<void>((resolve, reject) => {
          const entry = { grant: resolve }
          waiters.push(entry)
          signal?.addEventListener('abort', () => {
            const i = waiters.indexOf(entry)
            if (i >= 0) waiters.splice(i, 1) // withdrawn: handoff skips this waiter
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      busy = true
      try {
        return await cb({ name })
      } finally {
        busy = false
        waiters.shift()?.grant()
      }
    },
  }
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
  return locks
}

function makeStore() { /* configureStore with all reducers above incl. deck */ }

let uninstall: (() => void) | null = null
beforeEach(() => stubHid())
afterEach(() => {
  uninstall?.()
  uninstall = null
  resetStreamDeckManagerForTests()
  // remove the hid + locks stubs
  Reflect.deleteProperty(navigator as object, 'hid')
  Reflect.deleteProperty(navigator as object, 'locks')
})

it('marks unsupported and does nothing when navigator.hid is missing', () => {
  Reflect.deleteProperty(navigator as object, 'hid')
  const store = makeStore()
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted: vi.fn() })
  expect(store.getState().deck.status).toBe('unsupported')
})

it('auto-reconnects a previously granted deck when the toggle turns on', async () => {
  const store = makeStore()
  const device = new FakeDeckDevice()
  const getGranted = vi.fn(async () => device)
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted })
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
  expect(store.getState().deck).toMatchObject({ model: 'Fake Mini', keyCount: 6 })
  expect(device.brightnessHistory[0]).toBe(100) // controller started
})

it('auto-reconnects on install when enabled is already true (page-reload persistence)', async () => {
  // Returning-user path: settings hydrate synchronously from localStorage BEFORE the
  // manager installs, so there is no enabled transition to observe — install itself
  // must evaluate the current value and run the enable path. A transition-only
  // change detector (prev seeded from the current store value) fails this test.
  const store = makeStore()
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
  const device = new FakeDeckDevice()
  const getGranted = vi.fn(async () => device)
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted })
  // No further dispatches after install: the connection must come from the install-time check.
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
  expect(getGranted).toHaveBeenCalledTimes(1)
})

it('disabling the toggle tears down cleanly', async () => { /* enable as above, then
  dispatch enabled:false; await status 'disconnected'; expect device.closed === true */ })

it('unplug -> disconnected without errors; replug (hid connect event) -> reconnected', async () => {
  /* enable+connect with a fresh FakeDeckDevice per getGranted call;
     device.disconnect(); await 'disconnected'; hid.fire('connect'); await 'connected' again */
})

it('open failure held-elsewhere -> in-use, retried on window focus', async () => {
  const store = makeStore()
  const device = new FakeDeckDevice()
  const getGranted = vi.fn()
    .mockRejectedValueOnce(new DeckOpenError('in-use', 'held'))
    .mockResolvedValueOnce(device)
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted })
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
})

it('non-leader window shows in-use while another window holds the leader lock, connects on handoff', async () => {
  const locks = stubLocks()
  // simulate the other freshell window's manager holding the leader lock
  let releaseOther: () => void = () => {}
  void locks.request('freshell-stream-deck', { mode: 'exclusive' }, () => new Promise<void>((r) => { releaseOther = r }))
  const store = makeStore()
  const device = new FakeDeckDevice()
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted: vi.fn(async () => device) })
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
  releaseOther() // leader closes/disables -> lock handoff
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
})

it('disable while waiting for the leader lock withdraws the request; later handoff must NOT connect', async () => {
  // The disable-while-waiting case: without the AbortSignal the queued request
  // would fire on handoff and connect with the toggle OFF. A pending
  // locks.request can only be withdrawn via its signal - resolving leaderGate
  // does not dequeue it.
  const locks = stubLocks()
  let releaseOther: () => void = () => {}
  void locks.request('freshell-stream-deck', { mode: 'exclusive' }, () => new Promise<void>((r) => { releaseOther = r }))
  const store = makeStore()
  const getGranted = vi.fn(async () => new FakeDeckDevice())
  uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted })
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
  store.dispatch(updateSettingsLocal({ streamDeck: { enabled: false } })) // aborts the queued request
  await vi.waitFor(() => expect(store.getState().deck.status).toBe('disconnected'))
  releaseOther() // previous leader hands off; the withdrawn request must not run
  await new Promise((r) => setTimeout(r, 25))
  expect(store.getState().deck.status).toBe('disconnected')
  expect(getGranted).not.toHaveBeenCalled()
})

it('requestDeckConnect adopts the picked device; picker cancel (or Electron []) keeps prior status', async () => {
  /* request resolves device -> connected; then reset, request resolves null -> status unchanged */
})
```

Fill in the two elided tests fully when writing the file (they follow the same shape).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-manager.test.ts`
Expected: FAIL — `@/store/deckSlice` / `@/deck/deck-manager` not found.

- [ ] **Step 3: Implement `deckSlice`, `deck-manager`, `useStreamDeck`, and wire the store + App**

`deckSlice.ts` is a 30-line standard slice (initial `{ status: 'disconnected', model: null, keyCount: null, virtualDeckOpen: false }`). `deck-manager.ts` implements the behavior spec; default transports lazy-import `./webhid-transport` (so the lib is only touched when supported+enabled — use dynamic `import()` inside the connect path). Store: add `deck: deckReducer` to the reducer map in `src/store/store.ts` with the comment `// Ephemeral device state — never persisted (allowlist rule)`. App: add `useStreamDeck()` after `useElectronExternalLinks()` at `src/App.tsx:169`; hook body:

```ts
// src/hooks/useStreamDeck.ts
import { useEffect } from 'react'
import { useAppStore } from '@/store/hooks'
import { installStreamDeckManager } from '@/deck/deck-manager'

export function useStreamDeck(): void {
  const store = useAppStore()
  useEffect(() => installStreamDeckManager(store), [store])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-manager.test.ts` then `npm run typecheck`.
Expected: PASS / clean. Also run one broad existing App-adjacent suite to catch wiring regressions: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/store/deckSlice.ts src/deck/deck-manager.ts src/hooks/useStreamDeck.ts src/store/store.ts src/App.tsx test/unit/client/deck/deck-manager.test.ts
git commit -m "feat(deck): lifecycle manager, deck slice, useStreamDeck App wiring"
```

---

### Task 12: TerminalView preview registration

**Files:**
- Modify: `src/components/TerminalView.tsx` (one hook call at the top level of the component)
- Test: extend `test/unit/client/deck/terminal-text-registry.test.tsx` (integration-ish assertion via the hook is already covered; this task's test is the typecheck + existing TerminalView suites)

**Interfaces:**
- Consumes: `useTerminalTextRegistration` (Task 8), TerminalView's existing xterm instance ref and `content.terminalId`.

- [ ] **Step 1: Locate the xterm instance ref**

In `src/components/TerminalView.tsx`, find where the xterm `Terminal` is created (`new Terminal(`) and the ref that holds it (a `useRef<Terminal | null>` — commonly named `termRef`/`terminalRef`/`xtermRef`). Also identify the in-scope `terminalId` (the pane content's `terminalId`, present in the component props/state — e.g. the same value used by `buildTerminalInputMessage` call sites around `TerminalView.tsx:2130`).

- [ ] **Step 2: Add the registration (one line + import)**

At the component top level (with the other hooks):

```ts
import { useTerminalTextRegistration } from '@/deck/terminal-text-registry'
// ...
useTerminalTextRegistration(content.terminalId, termRef as never)
```

(`Terminal` satisfies `XtermLike` structurally — `buffer.active.getLine(y)?.translateToString(true)` is the public xterm API. If the ref name differs, use the actual ref; if the instance lives in a non-ref variable scoped to an effect, add a dedicated `const deckTextRef = useRef<XtermLike | null>(null)` assigned where the Terminal is created and cleared where it is disposed.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck` and the existing TerminalView suites: `npm run test:vitest -- run test/unit/client/components/TerminalView` (adjust to the actual existing test file paths; if none match, run `npm run test:vitest -- run test/unit/client` for the client unit set).
Expected: clean/PASS — the hook is inert unless a deck controller reads the registry.

- [ ] **Step 4: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "feat(deck): register live terminal text readers for deck previews"
```

---

### Task 13: Settings UI section

**Files:**
- Create: `src/components/settings/StreamDeckSettings.tsx`
- Modify: `src/components/SettingsView.tsx:31` (add `{ id: 'stream-deck', label: 'Stream Deck' }` + import + render line)
- Test: `test/unit/client/components/settings/StreamDeckSettings.test.tsx`

**Interfaces:**
- Consumes: `SettingsSectionProps` (`settings-types.ts`), `SettingsSection`/`SettingsRow`/`Toggle`/`SteppedRangeInput` (`settings-controls.tsx`), `isWebHidSupported` + `isElectronClient` (`@/lib/webhid-support`, Task 1), `requestDeckConnect` (Task 11), `state.deck` + `setVirtualDeckOpen` (deckSlice), `applyLocalSetting`.
- Produces: the settings tab. Controls: (a) "Enable Stream Deck" `Toggle` → `applyLocalSetting({ streamDeck: { enabled } })`; (b) "Connect Stream Deck" `<button type="button">` → `void requestDeckConnect()` (disabled unless enabled); (c) status line derived from `state.deck` (`Connected: {model} ({keyCount} keys)` / `Not connected` / `In use by another window or app — or missing device permissions (Linux udev)` / error); (d) three numeric rows via `SteppedRangeInput` (idle timeout seconds 0–3600, allowed values `[0, 30, 60, 120, 300, 600, 1800, 3600]`; active brightness 10–100 step 10; idle brightness 0–100 step 10) each with explicit `aria-label`; (e) "Show virtual deck" `Toggle` → `dispatch(setVirtualDeckOpen(v))`. When `!isWebHidSupported()`: render the section with a short note `Stream Deck requires Chrome or Edge (WebHID). The virtual deck below still works.` — hide the connect button and status line, keep the enable/virtual controls visible but the connect flow unavailable. When `isElectronClient()` (checked FIRST — in Electron `navigator.hid` exists but is non-functional: `requestDevice()` always resolves `[]`, no picker): show `Stream Deck is not supported in the desktop app — use Chrome or Edge.` instead of a dead Connect button (hide connect + status line, keep enable/virtual controls, same shape as the unsupported branch).

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/client/components/settings/StreamDeckSettings.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import deckReducer, { setDeckStatus } from '@/store/deckSlice'
import settingsReducer from '@/store/settingsSlice'
import { defaultSettings } from '@/store/settingsSlice'

const requestDeckConnect = vi.fn(async () => {})
vi.mock('@/deck/deck-manager', () => ({ requestDeckConnect: (...a: never[]) => requestDeckConnect(...a) }))
const supported = vi.fn(() => true)
const electron = vi.fn(() => false)
vi.mock('@/lib/webhid-support', () => ({
  isWebHidSupported: () => supported(),
  isElectronClient: () => electron(),
}))

import StreamDeckSettings from '@/components/settings/StreamDeckSettings'

function renderSection(streamDeck = { enabled: true, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 }) {
  const store = configureStore({ reducer: { deck: deckReducer, settings: settingsReducer } })
  const applyLocalSetting = vi.fn()
  render(
    <Provider store={store}>
      <StreamDeckSettings
        settings={{ ...defaultSettings, streamDeck } as never}
        applyLocalSetting={applyLocalSetting}
        applyServerSetting={vi.fn()}
        scheduleServerTextSettingSave={vi.fn()}
      />
    </Provider>,
  )
  return { store, applyLocalSetting }
}

it('toggles enable via applyLocalSetting', () => {
  const { applyLocalSetting } = renderSection({ enabled: false, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 })
  fireEvent.click(screen.getByRole('switch', { name: /enable stream deck/i }))
  expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { enabled: true } })
})

it('connect button is a real button and calls requestDeckConnect', () => {
  renderSection()
  fireEvent.click(screen.getByRole('button', { name: /connect stream deck/i }))
  expect(requestDeckConnect).toHaveBeenCalledTimes(1)
})

it('shows connected model + key count from the deck slice', () => {
  const { store } = renderSection()
  store.dispatch(setDeckStatus({ status: 'connected', model: 'Stream Deck Mini', keyCount: 6 }))
  expect(screen.getByText(/connected: stream deck mini \(6 keys\)/i)).toBeInTheDocument()
})

it('shows in-use status text', () => {
  const { store } = renderSection()
  store.dispatch(setDeckStatus({ status: 'in-use' }))
  expect(screen.getByText(/in use by another window or app/i)).toBeInTheDocument()
})

it('non-Chromium browsers get the requires-Chrome note and no connect button', () => {
  supported.mockReturnValueOnce(false)
  renderSection()
  expect(screen.getByText(/requires chrome or edge/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /connect stream deck/i })).toBeNull()
})

it('Electron gets the honest not-supported message instead of a dead connect button', () => {
  // navigator.hid EXISTS in Electron but requestDevice() always resolves [] — the
  // supported check alone would render a Connect button that can never work.
  electron.mockReturnValueOnce(true)
  renderSection()
  expect(screen.getByText(/not supported in the desktop app/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /connect stream deck/i })).toBeNull()
})

it('virtual deck toggle flips deck.virtualDeckOpen', () => {
  const { store } = renderSection()
  fireEvent.click(screen.getByRole('switch', { name: /show virtual deck/i }))
  expect(store.getState().deck.virtualDeckOpen).toBe(true)
})

it('idle timeout input applies a local patch', () => {
  const { applyLocalSetting } = renderSection()
  const input = screen.getByRole('spinbutton', { name: /idle timeout/i })
  fireEvent.change(input, { target: { value: '60' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { idleTimeoutSeconds: 60 } })
})
```

(If `SteppedRangeInput`'s commit semantics differ from Enter-commit, mirror the interaction its own existing tests / `AppearanceSettings` usage use — adapt the last test to the real control contract rather than weakening the assertion.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the section + register it in `SettingsView.tsx`**

Follow `PanesSettings.tsx` structure exactly (imports from `./settings-controls`, `SettingsSectionProps`); read `useAppSelector((s) => s.deck)`, `useAppDispatch` for `setVirtualDeckOpen`. Register in `SettingsView.tsx`: add to `sections`, import, and a `{activeSection === 'stream-deck' && <StreamDeckSettings {...sectionProps} />}` render line.

- [ ] **Step 4: Run tests + lint**

Run: `npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx` and `npm run lint`.
Expected: PASS, no a11y violations.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/StreamDeckSettings.tsx src/components/SettingsView.tsx test/unit/client/components/settings/StreamDeckSettings.test.tsx
git commit -m "feat(deck): Stream Deck settings section"
```

---

### Task 14: Virtual deck panel (in-app emulator)

**Files:**
- Create: `src/components/VirtualDeckPanel.tsx`
- Modify: `src/App.tsx` (render `<VirtualDeckPanel />` near the top-level overlays)
- Test: `test/unit/client/components/VirtualDeckPanel.test.tsx`

**Interfaces:**
- Consumes: `FakeDeckDevice`/`MINI_CAPS`/`PLUS_CAPS`, `DeckController`, `state.deck.virtualDeckOpen` + `setVirtualDeckOpen`, `useAppStore`.
- Produces: a fixed-position panel (bottom-right, `role="dialog"`, `aria-label="Virtual Stream Deck"`) rendered only when `virtualDeckOpen`. Contents: profile `SegmentedControl` (`Mini` / `Plus`, local `useState`, default Mini); a grid (`grid-cols-{caps.keyColumns}`) of `<button type="button" aria-label={\`Deck key ${i + 1}\`}>` each containing a `<canvas width={caps.keyPixelWidth} height={caps.keyPixelHeight}>`; for Plus: two labeled dial widgets (buttons `aria-label="Dial 1 rotate left" / "Dial 1 rotate right" / "Press dial 1"`, same for dial 2) and a strip `<canvas>`; a close `<button aria-label="Close virtual deck">`.

Mechanics: on open (and profile change) create `FakeDeckDevice(profileCaps)` + `DeckController({ store, device, settings: () => store.getState().settings.settings.streamDeck })`, `start()`; cleanup `stop()`. Key painting: subscribe to the fake device by wrapping `setKeyImage` — simplest reliable approach: after constructing the device, monkey-wrap in the component (`const orig = device.setKeyImage.bind(device); device.setKeyImage = async (i, rgba) => { await orig(i, rgba); paintCanvas(i, rgba) }`) where `paintCanvas` does `canvasRefs[i]?.getContext('2d')?.putImageData(new ImageData(rgba, w, h), 0, 0)` guarded for null ctx (jsdom). Key buttons: `onPointerDown` → `device.emit({ type: 'keyDown', keyIndex })`, `onPointerUp`/`onPointerLeave` (while pressed) → `keyUp`; ALSO `onKeyDown`/`onKeyUp` for Space/Enter so keyboard users can long-press (a11y). Dial buttons emit `dialRotate ±1`/`dialPress`.

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/client/components/VirtualDeckPanel.test.tsx
// Store: real reducers (deck, settings, tabs, panes, turnCompletion, freshAgent,
// activity slices) with two seeded tabs (reuse the Task 3 fixture builder).
// vi.mock('@/lib/ws-client') as usual.
it('renders nothing while closed, opens with a dialog and 6 key buttons on Mini', ...)
// dispatch(setVirtualDeckOpen(true)); expect role dialog; getAllByRole('button', { name: /deck key/i }) length 6

it('clicking key 1 focuses tab 1 in the store (short press)', async () => { ... })
// fireEvent.pointerDown + pointerUp on 'Deck key 2'; activeTabId becomes the second tab id

it('switching to the Plus profile shows 8 keys and dial controls', ...)
// click 'Plus'; 8 deck-key buttons; dial rotate buttons present

it('close button clears virtualDeckOpen', ...)
```

Write these four tests in full (same store fixture as Task 9's controller test; interactions via Testing Library `fireEvent.pointerDown/pointerUp`).

- [ ] **Step 2: Run to verify failure, implement, re-run**

Run: `npm run test:vitest -- run test/unit/client/components/VirtualDeckPanel.test.tsx` (FAIL → implement → PASS). Note: jsdom canvas ctx is null — `paintCanvas` must silently no-op; tests assert behavior (store effects, button presence), not pixels. Add `<VirtualDeckPanel />` in `src/App.tsx` adjacent to other global overlays (it self-hides when closed).

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add src/components/VirtualDeckPanel.tsx src/App.tsx test/unit/client/components/VirtualDeckPanel.test.tsx
git commit -m "feat(deck): in-app virtual deck panel driven by the fake transport"
```

---

### Task 15: E2E flow suite (fake transport, real store)

**Files:**
- Test: `test/e2e/stream-deck-flow.test.tsx`

**Interfaces:**
- Consumes: everything above; no new production code. This is the ported 7-scenario proof (adapted: focus is client-side; previews come from the registry, not capture).

- [ ] **Step 1: Write the suite (these are the acceptance tests — write all, watch them pass; any failure is a real bug in Tasks 3–11)**

Shared harness at the top of the file: `vi.mock('@/lib/ws-client')` recording sends; real store with the full reducer set (Task 9 fixture builder extracted into a local helper `makeDeckStore({ tabs, busy, pendingPermissions, attention })`); `FakeDeckDevice`; spec-encoding renderer + decoder (Task 9's); `vi.useFakeTimers()`; helper `holdKey(device, i, ms)` = `emit keyDown; vi.advanceTimersByTime(ms); emit keyUp`.

Scenarios (one `it` each):

1. **Tabs appear on keys with titles, previews, and rings** — 3 tabs (one busy via claudeActivity, one with attention, one fresh-agent with a pending permission); register a text reader for `term-1` returning `['$ npm test', 'PASS']`; start controller on Mini; decode keys 0–2: titles in tab order, `previewLines` on key 0, rings `blue`/`green`/`amber` respectively; active tab has `active: true`.
2. **Press focuses the tab in this browser** — press key 1 → `activeTabId` flips, `attentionByTab` for it cleared, key repaints with `active: true` white-ring spec.
3. **Ring colors track state changes** — start quiet; dispatch busy record → key 0 spec ring `blue`; `markTabAttention` → `green` (priority: also set busy, still `green`); `addPermissionRequest` on the fresh-agent session → its key `amber`.
4. **Overflow paging with wrap on the 6-key profile** — 8 tabs: key 5 is `{ kind: 'pager', page: 1, pageCount: 2 }`; press → page 2 tail tabs + `2/2`; press → wraps to page 1.
5. **Long-press APPROVE** — fresh-agent tab with pending permission `r1`: `holdKey(device, itsKey, 600)` → action layer specs (back enabled, approve enabled green, stop disabled); press key 1 → ws frame `freshAgent.approval.respond` with `decision` deep-equal `{ behavior: 'allow' }` and `expect('updatedInput' in frame.decision).toBe(false)`; layer closes (key 0 back to a tab spec).
6. **STOP with escalation on a terminal pane** — busy terminal tab: long-press → press STOP → `terminal.input` `'\x1b'`; long-press again, press STOP within 5s → `'\x03'`; also: layer left open auto-closes after `advanceTimersByTime(10_500)`.
7. **Idle dim & wake** — `idleTimeoutSeconds: 1` settings injection: `advanceTimersByTime(1_500)` of ticks → last brightness 10; press a key → brightness 100 appended AND the press's focus action fired.
8. **Deck+ dials and strip** — PLUS_CAPS, 10 tabs: no pager key in any spec; `dialRotate(0, +1)` cycles active (and wraps from last to first); `dialRotate(1, +1)` pages (clamped at 2); `dialPress(1)` returns to page 1; decoded strip text equals `'{activeTitle}  |  page 1/2  |  1 busy  1 waiting'` for the seeded state; `touchTap` while dimmed restores brightness.
9. **Graceful teardown** — `controller.stop()` clears the device and stops repainting on further dispatches (keyImages cleared, no new paints).

- [ ] **Step 2: Run the suite**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx`
Expected: PASS. Fix any real defects surfaced (in the module at fault, with its unit test extended first — RED/GREEN applies to fixes too).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/stream-deck-flow.test.tsx
git commit -m "test(deck): e2e flow suite over the fake transport (7 ported scenarios + deck+)"
```

---

### Task 16: Docs + full verification

**Files:**
- Modify: `README.md` (new "Stream Deck" subsection under features/usage)
- Test: full repo gates

- [ ] **Step 1: README section**

Add a concise section covering: what it does (tabs on keys, rings, press to focus, long-press APPROVE/STOP, paging, Deck+ dials/strip, idle dim); requirements (Chrome/Edge — WebHID; Elgato Stream Deck, primary target Mini; NOT supported in the freshell desktop app — use Chrome/Edge); how to connect (Settings → Stream Deck → enable → Connect Stream Deck → pick the device; auto-reconnects afterwards); the virtual deck (Settings → Stream Deck → Show virtual deck — works without hardware); note that deck settings are per-browser-profile (localStorage); **Linux udev rules** (hidraw device nodes default to root-only — add a udev rule for the Elgato vendor id `0fd9` to grant user access; without it the browser cannot open the deck, and the status line shows the combined wording "in use by another app — or missing device permissions (Linux udev)" because the browser cannot distinguish the two failure causes); **Memory Saver caveat** (Chrome's Memory Saver can discard a long-hidden freshell tab even with the deck connected — the deck goes dark until the tab is revisited; add freshell to Memory Saver's "Always keep this site active" list to avoid it). `docs/index.html`: intentionally not updated (settings-level feature, not a default-experience change).

- [ ] **Step 2: Full verification**

Run, in order (broad runs go through the shared coordinator; set a reason):

```bash
npm run typecheck
npm run lint
FRESHELL_TEST_SUMMARY="stream-deck-webhid full suite" npm run check
```

Expected: all clean/green, existing suites unaffected. Fix anything that isn't (test-first for real bugs).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Stream Deck support - connecting, browser support, virtual deck"
```

---

## Hardware checkpoints (post-implementation)

Manual checks with a real deck — accepted residuals from the load-bearing review that CI cannot cover (do after merge, with the user):

- **Second-holder open behavior per OS (A2):** with the Elgato Stream Deck software running on each of Windows/macOS/Linux, attempt a freshell connect (and vice versa) — research says concurrent opens generally SUCCEED and both parties paint (user resolves by closing one); confirm whether Windows Elgato software opens exclusive-mode (the one case where `DeckOpenError('in-use')` fires). Also: two same-profile freshell windows must resolve via the Web Locks leader election, not open failure. On Linux, verify the udev-rule vs in-use `NetworkError` ambiguity and the status copy.
- **Backgrounded-window input soak (A3):** hide/minimize the freshell tab >5 min and >1 hr — key presses must still act promptly (HID input is unthrottled); verify timer duties catch up within a tick. Also observe Chrome Memory Saver: a long-hidden tab may be DISCARDED despite the open HID connection (deck goes dark until revisit — accepted residual, README-documented).
- **Stream Deck+ dial presses (A5):** real dial-press traffic must map through `control.type === 'encoder'` → `dialPress` (never `keyDown`), with button presses unaffected.
- **Sustained repaint soak (A14):** long repaint sessions watching for transient write-promise rejections (`fillKeyBuffer`/`fillLcd`) — confirm the secondary disconnect signal doesn't false-positive while the device is still attached.
- **Memory-Saver discard behavior:** confirm the "Always keep this site active" exception prevents the discard, and that revisiting the tab auto-reconnects via `getDevices()`.

---

## Self-Review

**1. Spec coverage:**
- Transport seam + two transports (WebHID, fake) → Tasks 2, 10; future Tauri transport slots in behind `DeckDevice` (no Tauri code built — correct).
- One key = one tab, tile rendering (bg/preview/banner/rings, exact constants) → Tasks 4, 5.
- Overflow pager (wrap) → Tasks 4, 9, e2e #4.
- Short press focus + green dismissal parity with TabBar → Tasks 7, 9, e2e #2.
- Long-press action layer, BACK/APPROVE/STOP, disabled grey, 10s close → Tasks 4, 9, e2e #5/6.
- APPROVE omits `updatedInput`; browser path fixed too → Tasks 6, 7, e2e #5.
- STOP: interrupt for fresh-agent, ESC→Ctrl+C (5s) for terminals, never raw keys to fresh-agent → Tasks 3, 7, 9, e2e #6.
- Multi-model capability-driven (Mini keys-mode, Plus full-mode dials/strip, no model-name branching) → Tasks 4, 9, 10, e2e #8.
- Idle dimming (configurable, wake on activity incl. repaint-worthy changes) → Task 9, e2e #7.
- Feature detection + non-Chromium note → Tasks 1, 13.
- Settings section (toggle, connect gesture button, status line incl. in-use, numerics, virtual deck toggle) → Task 13.
- Auto-reconnect, hotplug, exclusivity (Web Locks leader election + secondary in-use retry) → Task 11.
- Client-side persistence via LocalSettings → Task 1.
- A11y → Tasks 13, 14 + `npm run lint`.
- State sources reuse (tabs/panes/activity/turn-complete/pending-permission) → Task 3.
- Previews design wrinkle resolved (live xterm buffers; title-only otherwise) → Tasks 8, 12.
- Prior-branch independence: fresh from origin/main; only design constants ported. No server changes anywhere.
- Success criteria: unit + e2e green, lint/typecheck clean, README note → Tasks 15, 16.

**1b. No silent deferrals:** The fake transport is a *product feature* (virtual deck) as well as a test substrate — hardware behavior itself is covered by the WebHID transport (Task 10) whose library interaction is contract-tested against the mocked lib API; there is no way to drive physical hardware in CI, and the spec explicitly designates the fake transport as the proof substrate ("both proven via the fake transport in tests"). No requirement was moved to future work. Note: real-hardware smoke (plug in a Mini, connect, observe tiles) remains a manual post-merge check for the user — the spec's own e2e definition is the fake-transport suite.

**2. Placeholder scan:** Task 9 Step 1 and Task 11 Step 1 list two test bodies in compressed comment form with explicit instruction to write them in full; all other steps carry complete code. No TBD/TODO items. Task 12 depends on locating an existing ref in `TerminalView.tsx` — the step provides both the primary path and the fallback (dedicated ref) with code.

**3. Type consistency check:** `DeckCapabilities`/`DeckInputEvent`/`DeckDevice` (Task 2) used verbatim in Tasks 9–11, 14; `KeySpec`/`FrameSpec`/`ACTION_KEYS` (Task 4) match Task 5 renderer and Task 9 controller usage; `TabRingStatus`/`DeckModel`/`ApproveTarget`/`StopTarget` (Task 3) match Task 7/9 signatures; `sendDeckApproval(target)` takes `ApproveTarget` whose optional `cwd` is set by the Task 3 selectors only for freshopencode targets (server auth keys embed cwd — A8) and spread into the frame by Task 7; claude/codex/kilroy frames stay cwd-less; `executeDeckStop(target, escalate)` consistent between Tasks 7 and 9; `useTerminalTextRegistration(terminalId, termRef, maxLines?)` consistent between Tasks 8 and 12. `DeckOpenError` defined in Task 10, consumed in Task 11 tests. Settings field names (`enabled`, `brightness`, `idleBrightness`, `idleTimeoutSeconds`) consistent across Tasks 1, 9, 11, 13.
