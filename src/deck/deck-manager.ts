// ---------------------------------------------------------------------------
// Stream Deck lifecycle manager — module-level singleton wiring settings to
// the device: enable/disable, silent auto-reconnect, hotplug, in-use retry,
// and same-origin multi-window exclusivity via Web Locks leader election.
// ---------------------------------------------------------------------------
//
// Leader election (locked design decision): navigator.locks.request holds the
// 'freshell-stream-deck' exclusive lock for the manager's enabled lifetime.
// A non-leader window shows status 'in-use' and waits; when the leader closes
// or disables, the lock releases and the waiting window takes over (handoff).
// Each enable cycle gets a fresh AbortController: aborting the signal is the
// ONLY way to withdraw a locks.request that is still queued behind another
// window — without it, a window disabled while waiting would later seize the
// lock on handoff and connect with its toggle off.
//
// The DeckOpenError('in-use') mapping + focus/visibilitychange retry is the
// SECONDARY signal for the other-OS-app case (e.g. an exclusive-mode holder on
// Windows) — the same-origin case is handled by the lock, not by open failure.

import type { DeckDevice } from './deck-device'
import { DeckController, type DeckControllerOptions } from './deck-controller'
import { setDeckStatus } from '@/store/deckSlice'
import { isWebHidSupported } from '@/lib/webhid-support'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('DeckManager')

export const DECK_LEADER_LOCK_NAME = 'freshell-stream-deck'

export type DeckTransports = {
  request: () => Promise<DeckDevice | null>
  getGranted: () => Promise<DeckDevice | null>
  // Test seam: jsdom has no canvas 2D context, so tests inject byte-array
  // renderers for the adopted DeckController (the same injection pattern as
  // deck-controller.test.ts). Production omits these and the controller uses
  // its canvas defaults.
  renderKey?: DeckControllerOptions['renderKey']
  renderStrip?: DeckControllerOptions['renderStrip']
}

// Minimal Web Locks surface (lib.dom's LockManager, duck-typed so the manager
// works — by skipping the election — when navigator.locks is missing).
type LocksApi = {
  request: (
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: (lock: unknown) => Promise<void>,
  ) => Promise<unknown>
}

type Manager = {
  store: DeckControllerOptions['store']
  transports: DeckTransports
  prevEnabled: boolean
  unsubscribeStore: (() => void) | null
  // Per-enable-cycle abort: withdraws a still-queued locks.request on disable
  // and invalidates stale async continuations from earlier cycles.
  cycleAbort: AbortController | null
  // Resolving this releases the held leader lock (the lock callback awaits it).
  releaseLeaderGate: (() => void) | null
  isLeader: boolean
  // The cycle whose getGranted() call is currently in flight (dedupes retries).
  connectFor: AbortController | null
  device: DeckDevice | null
  controller: DeckController | null
  unsubDeviceDisconnect: (() => void) | null
  onHidConnect: () => void
  onFocus: () => void
  onVisibilityChange: () => void
}

let manager: Manager | null = null

// Default transports lazy-import the WebHID wrapper so @elgato-stream-deck/webhid
// is only loaded when WebHID is supported AND the feature gets used.
const defaultTransports: DeckTransports = {
  request: async () => (await import('./webhid-transport')).requestWebHidDeck(),
  getGranted: async () => (await import('./webhid-transport')).getGrantedWebHidDeck(),
}

function isInUseOpenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'DeckOpenError' &&
    (error as { reason?: string }).reason === 'in-use'
  )
}

function isEnabled(m: Manager): boolean {
  return m.store.getState().settings.settings.streamDeck.enabled
}

function adopt(m: Manager, device: DeckDevice): void {
  m.device = device
  const controller = new DeckController({
    store: m.store,
    device,
    settings: () => m.store.getState().settings.settings.streamDeck,
    ...(m.transports.renderKey ? { renderKey: m.transports.renderKey } : {}),
    ...(m.transports.renderStrip ? { renderStrip: m.transports.renderStrip } : {}),
  })
  m.controller = controller
  controller.start()
  // Driven by the transport's navigator.hid 'disconnect' listener + the
  // write-rejection fallback (the lib's 'error' event never fires).
  m.unsubDeviceDisconnect = device.onDisconnect(() => {
    if (manager !== m || m.device !== device) return
    teardownDevice(m)
    m.store.dispatch(setDeckStatus({ status: 'disconnected' }))
    // Replug reconnects via the navigator.hid 'connect' hotplug listener.
  })
  const caps = device.capabilities
  m.store.dispatch(setDeckStatus({ status: 'connected', model: caps.model, keyCount: caps.keyCount }))
}

function teardownDevice(m: Manager): void {
  m.unsubDeviceDisconnect?.()
  m.unsubDeviceDisconnect = null
  m.controller?.stop()
  m.controller = null
  const device = m.device
  m.device = null
  if (device) void device.close().catch((error) => log.warn('device close failed', error))
}

function handleOpenError(m: Manager, error: unknown): void {
  if (isInUseOpenError(error)) {
    // Secondary signal: an OS app holds the device exclusively — or missing
    // device permissions (Linux udev). Retry is armed via the focus /
    // visibilitychange listeners installed at install time.
    m.store.dispatch(setDeckStatus({ status: 'in-use' }))
    return
  }
  log.warn('deck open failed', error)
  m.store.dispatch(setDeckStatus({ status: 'error' }))
}

async function runLeaderConnect(m: Manager, abort: AbortController): Promise<void> {
  if (m.connectFor === abort) return // this cycle is already connecting
  m.connectFor = abort
  m.store.dispatch(setDeckStatus({ status: 'connecting' }))
  try {
    const device = await m.transports.getGranted()
    if (abort.signal.aborted || manager !== m) {
      if (device) void device.close().catch(() => undefined)
      return
    }
    if (!device) {
      // Nothing granted yet — wait for the user to press Connect (user gesture).
      m.store.dispatch(setDeckStatus({ status: 'disconnected' }))
      return
    }
    adopt(m, device)
  } catch (error) {
    if (abort.signal.aborted || manager !== m) return
    handleOpenError(m, error)
  } finally {
    if (m.connectFor === abort) m.connectFor = null
  }
}

function enable(m: Manager): void {
  const abort = new AbortController()
  m.cycleAbort = abort

  const locks = (navigator as Navigator & { locks?: LocksApi }).locks
  if (!locks || typeof locks.request !== 'function') {
    // Old browser / jsdom: no Web Locks — skip the election, proceed as leader.
    m.isLeader = true
    void runLeaderConnect(m, abort)
    return
  }

  let granted = false
  const request = locks.request(
    DECK_LEADER_LOCK_NAME,
    { mode: 'exclusive', signal: abort.signal },
    async () => {
      // Belt-and-suspenders: re-check first thing inside the callback — the
      // abort can lose the race with the grant. Returning immediately releases
      // the lock without touching state or the device.
      if (abort.signal.aborted) return
      if (manager !== m || m.cycleAbort !== abort) return
      if (!isEnabled(m)) return
      granted = true
      m.isLeader = true
      const leaderGate = new Promise<void>((resolve) => {
        m.releaseLeaderGate = resolve
      })
      await runLeaderConnect(m, abort)
      // Hold the lock for the manager's enabled lifetime; disable/uninstall
      // resolves the gate, releasing the lock so a waiting window takes over.
      await leaderGate
    },
  )
  void request.catch((error: unknown) => {
    // A withdrawn (aborted-while-queued) request rejects with AbortError.
    // Matched by name: DOMException is not an Error subclass everywhere (jsdom).
    if ((error as { name?: string } | null)?.name === 'AbortError') return
    log.warn('leader lock request failed', error)
  })
  if (!granted && !abort.signal.aborted) {
    // Another freshell window is the leader ("in use elsewhere / another
    // window"); we are queued and will connect on handoff.
    m.store.dispatch(setDeckStatus({ status: 'in-use' }))
  }
}

function disable(m: Manager): void {
  // Withdraw a still-queued locks.request (disable-while-waiting) and
  // invalidate any in-flight connect from this cycle.
  m.cycleAbort?.abort()
  m.cycleAbort = null
  m.isLeader = false
  // Release the held leader lock (if any) so a waiting window can take over.
  m.releaseLeaderGate?.()
  m.releaseLeaderGate = null
  teardownDevice(m)
  m.store.dispatch(setDeckStatus({ status: 'disconnected' }))
}

function canRetryAsLeader(m: Manager): AbortController | null {
  const abort = m.cycleAbort
  if (!abort || abort.signal.aborted) return null
  if (!m.isLeader || m.device) return null
  if (!isEnabled(m)) return null
  return abort
}

function uninstallManager(m: Manager): void {
  if (manager !== m) return
  m.unsubscribeStore?.()
  m.unsubscribeStore = null
  const hid = (navigator as { hid?: { removeEventListener?: (t: string, cb: () => void) => void } }).hid
  hid?.removeEventListener?.('connect', m.onHidConnect)
  window.removeEventListener('focus', m.onFocus)
  document.removeEventListener('visibilitychange', m.onVisibilityChange)
  // HMR safety: a queued lock request from a torn-down manager must never
  // fire its callback later.
  m.cycleAbort?.abort()
  m.cycleAbort = null
  m.isLeader = false
  m.releaseLeaderGate?.()
  m.releaseLeaderGate = null
  teardownDevice(m)
  manager = null
}

export function installStreamDeckManager(store: DeckControllerOptions['store'], transports?: DeckTransports): () => void {
  if (manager) return () => {} // idempotent singleton: the first install owns teardown
  if (!isWebHidSupported()) {
    store.dispatch(setDeckStatus({ status: 'unsupported' }))
    return () => {}
  }

  const m: Manager = {
    store,
    transports: transports ?? defaultTransports,
    prevEnabled: false,
    unsubscribeStore: null,
    cycleAbort: null,
    releaseLeaderGate: null,
    isLeader: false,
    connectFor: null,
    device: null,
    controller: null,
    unsubDeviceDisconnect: null,
    onHidConnect: () => {
      // Hotplug: if enabled, leader, and not connected, try getGranted() again.
      const abort = canRetryAsLeader(m)
      if (abort) void runLeaderConnect(m, abort)
    },
    onFocus: () => retryIfInUse(m),
    onVisibilityChange: () => {
      if (document.visibilityState === 'visible') retryIfInUse(m)
    },
  }
  manager = m

  const hid = (navigator as unknown as { hid: { addEventListener: (t: string, cb: () => void) => void } }).hid
  hid.addEventListener('connect', m.onHidConnect)
  window.addEventListener('focus', m.onFocus)
  document.addEventListener('visibilitychange', m.onVisibilityChange)

  const checkEnabled = () => {
    if (manager !== m) return
    const enabled = isEnabled(m)
    if (enabled === m.prevEnabled) return
    m.prevEnabled = enabled
    if (enabled) enable(m)
    else disable(m)
  }
  m.unsubscribeStore = store.subscribe(checkEnabled)
  // Evaluate the current value NOW — local settings hydrate synchronously from
  // localStorage before the manager installs, so a returning user's enabled is
  // already true and no transition will ever be observed. prevEnabled is
  // seeded false (not the current store value) so this runs the enable path.
  checkEnabled()

  return () => uninstallManager(m)
}

function retryIfInUse(m: Manager): void {
  // In-use retry covers the OS-app case and only applies while this window
  // holds the leader lock; the non-leader case resolves itself via lock
  // handoff, not retry.
  if (manager !== m) return
  if (m.store.getState().deck.status !== 'in-use') return
  const abort = canRetryAsLeader(m)
  if (abort) void runLeaderConnect(m, abort)
}

// Called by the Settings "Connect" button (user gesture required by WebHID).
export async function requestDeckConnect(): Promise<void> {
  const m = manager
  if (!m) return
  // Only meaningful for the leader; a non-leader window keeps status 'in-use'
  // (disable also clears isLeader, so this covers the toggle-off case).
  if (!m.isLeader) return
  try {
    const device = await m.transports.request()
    if (manager !== m || !m.isLeader || !m.cycleAbort || m.cycleAbort.signal.aborted) {
      if (device) void device.close().catch(() => undefined)
      return
    }
    // Picker cancel — or Electron's handler-less requestDevice(), which always
    // resolves []: clean no-op, keep prior status. Never index [0] blindly.
    if (!device) return
    teardownDevice(m) // defensive: replace any existing device
    adopt(m, device)
  } catch (error) {
    if (manager !== m) return
    handleOpenError(m, error)
  }
}

export function resetStreamDeckManagerForTests(): void {
  if (manager) uninstallManager(manager)
  manager = null
}
