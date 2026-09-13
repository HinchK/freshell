import {
  DEVICE_ID_STORAGE_KEY,
  MACHINE_ID_STORAGE_KEY as STORED_MACHINE_ID_STORAGE_KEY,
  MACHINE_SELECTION_RESET_STORAGE_KEY as STORED_MACHINE_SELECTION_RESET_STORAGE_KEY,
  MACHINE_SELECTIONS_STORAGE_KEY as STORED_MACHINE_SELECTIONS_STORAGE_KEY,
  MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY as STORED_MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY,
} from '@/store/storage-keys'

export const MACHINE_ID_STORAGE_KEY = STORED_MACHINE_ID_STORAGE_KEY
export const MACHINE_SELECTIONS_STORAGE_KEY = STORED_MACHINE_SELECTIONS_STORAGE_KEY
export const MACHINE_SELECTION_RESET_STORAGE_KEY = STORED_MACHINE_SELECTION_RESET_STORAGE_KEY
export const MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY = STORED_MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY
export const LEGACY_DEVICE_ID_STORAGE_KEY = DEVICE_ID_STORAGE_KEY

export interface Machine {
  id: string
  label: string
  /** Unix epoch milliseconds, as serialized by the server's MachineStore. */
  createdAt: number
  /** Unix epoch milliseconds, as serialized by the server's MachineStore. */
  lastSeenAt: number
}

export type MachineIdentityResolution =
  | { kind: 'selected'; machine: Machine; source: 'saved' | 'legacy' | 'created' }
  | { kind: 'chooser'; machines: Machine[]; suggestedLabel: string }

type MachineSelectionMap = Record<string, string>

export type BrowserIdentityHints = {
  platform?: string
  userAgent?: string
}

export type DesktopMachineApi = {
  getHostname?: () => Promise<string>
}

function safeStorage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    localStorage.getItem(MACHINE_ID_STORAGE_KEY)
    return localStorage
  } catch {
    return undefined
  }
}

const ACTIVE_MACHINE_SELECTION_STORAGE_KEY = 'freshell.machine.active-selection'

function safeSessionStorage(): Storage | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined
    sessionStorage.getItem(ACTIVE_MACHINE_SELECTION_STORAGE_KEY)
    return sessionStorage
  } catch {
    return undefined
  }
}

/**
 * bb58 follow-up (reload-safety): the chooser's pick handlers arm this
 * ONE-SHOT, per-tab marker right before their intentional
 * `window.location.reload()` bootstrap. The next boot's machine restore
 * consumes it to tell an ACTIVE machine choice — where the rehydrated local
 * layout may be a different machine's stale cache, so a non-recoverable
 * inventory must clear it — apart from a natural reload of a remembered
 * selection, where the rehydrated layout IS this machine's newest truth and
 * must survive. sessionStorage (never localStorage) keeps the marker
 * per-tab: it survives the chooser's reload exactly once and is consumed on
 * the boot it armed; a later natural reload never inherits it.
 */
export function markActiveMachineSelection(storage = safeSessionStorage()): void {
  try {
    storage?.setItem(ACTIVE_MACHINE_SELECTION_STORAGE_KEY, '1')
  } catch {
    // Best effort: without the marker the next boot takes the conservative
    // keep-local path, which never destroys data.
  }
}

/**
 * Read the marker WITHOUT consuming it. The boot's restore peeks before the
 * (asynchronous) inventory request and consumes only after a SUCCESSFUL
 * restore — so an in-flight reload (the document dying mid-restore) leaves
 * the marker armed and the next boot still treats the machine as actively
 * chosen, never falling back to the keep-local path over a foreign cache.
 */
export function peekActiveMachineSelectionMark(storage = safeSessionStorage()): boolean {
  try {
    return storage?.getItem(ACTIVE_MACHINE_SELECTION_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function consumeActiveMachineSelectionMark(storage = safeSessionStorage()): boolean {
  try {
    const armed = storage?.getItem(ACTIVE_MACHINE_SELECTION_STORAGE_KEY) === '1'
    storage?.removeItem(ACTIVE_MACHINE_SELECTION_STORAGE_KEY)
    return armed
  } catch {
    return false
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readSelections(storage: Pick<Storage, 'getItem'> | undefined): MachineSelectionMap {
  if (!storage) return {}
  try {
    const raw = storage.getItem(MACHINE_SELECTIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([serverInstanceId, machineId]) => {
        const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
        const normalizedMachineId = nonEmptyString(machineId)
        return normalizedServerInstanceId && normalizedMachineId
          ? [[normalizedServerInstanceId, normalizedMachineId]]
          : []
      }),
    )
  } catch {
    return {}
  }
}

function writeSelections(storage: Pick<Storage, 'setItem'> | undefined, selections: MachineSelectionMap): void {
  if (!storage) return
  try {
    storage.setItem(MACHINE_SELECTIONS_STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // Storage can be disabled or full. The current browser session still has
    // its resolved machine in Redux, so do not turn a write failure into a
    // transport identity change.
  }
}

/**
 * The selected machine is origin-scoped by the browser. Once a websocket
 * supplies the durable server instance id, we additionally retain it in a
 * small map keyed by that id. The direct key is needed before the first hello;
 * the map protects a browser profile that later talks to more than one server.
 */
export function getSelectedMachineId(serverInstanceId?: string, storage = safeStorage()): string | undefined {
  const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
  if (normalizedServerInstanceId) {
    const fromServer = readSelections(storage)[normalizedServerInstanceId]
    if (fromServer) return fromServer
  }
  try {
    return nonEmptyString(storage?.getItem(MACHINE_ID_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function persistSelectedMachineId(
  machineId: string,
  serverInstanceId?: string,
  storage = safeStorage(),
): void {
  const normalizedMachineId = nonEmptyString(machineId)
  if (!normalizedMachineId || !storage) return
  try {
    storage.setItem(MACHINE_ID_STORAGE_KEY, normalizedMachineId)
    // An explicit choice supersedes the one-shot instruction to ignore a
    // legacy id after the user pressed Switch machine.
    storage.removeItem(MACHINE_SELECTION_RESET_STORAGE_KEY)
  } catch {
    // Keep going: the server-instance map has the same best-effort semantics.
  }
  const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
  if (!normalizedServerInstanceId) return
  const selections = readSelections(storage)
  selections[normalizedServerInstanceId] = normalizedMachineId
  writeSelections(storage, selections)
}

/**
 * The selected machine is changed before a machine-switch reload, while the
 * local tab layout still belongs to the prior selection. This marker tracks
 * that layout's last successfully restored machine independently of selection
 * so local-only UI state can never bridge that boundary.
 */
export function getMachineWorkspaceOriginId(storage = safeStorage()): string | undefined {
  try {
    return nonEmptyString(storage?.getItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function persistMachineWorkspaceOriginId(
  machineId: string,
  storage = safeStorage(),
): void {
  const normalizedMachineId = nonEmptyString(machineId)
  if (!normalizedMachineId || !storage) return
  try {
    storage.setItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY, normalizedMachineId)
  } catch {
    // A blocked local storage must conservatively disable local decoration
    // preservation, not change the selected machine or server workspace.
  }
}

/** Clear every cached selection for this browser origin. The reset marker
 * prevents a retained legacy v2 id from silently selecting the old machine
 * again after Switch machine. */
export function clearSelectedMachineId(storage = safeStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(MACHINE_ID_STORAGE_KEY)
    storage.removeItem(MACHINE_SELECTIONS_STORAGE_KEY)
    storage.setItem(MACHINE_SELECTION_RESET_STORAGE_KEY, '1')
  } catch {
    // no-op when storage is unavailable
  }
}

export function getBrowserMachineLabel(hints: BrowserIdentityHints = {}): string {
  const platform = hints.platform
    ?? (typeof navigator !== 'undefined' ? navigator.platform : '')
  const userAgent = hints.userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  const fingerprint = `${platform} ${userAgent}`.toLowerCase()

  if (fingerprint.includes('android')) return 'Android device 1'
  if (fingerprint.includes('iphone')) return 'iPhone 1'
  if (fingerprint.includes('ipad')) return 'iPad 1'
  if (fingerprint.includes('win')) return 'Windows device 1'
  if (fingerprint.includes('mac')) return 'macOS device 1'
  if (fingerprint.includes('linux')) return 'Linux device 1'
  return 'Browser device 1'
}

function getDesktopApi(): DesktopMachineApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { freshellDesktop?: DesktopMachineApi }).freshellDesktop
}

/**
 * Electron can name a machine from the renderer's own operating system.
 * A browser intentionally gets only a broad platform label; the server owns
 * label; the server may further canonicalize it when another machine already
 * has the same name.
 */
export async function getSuggestedMachineLabel(): Promise<string> {
  const desktop = getDesktopApi()
  if (typeof desktop?.getHostname === 'function') {
    try {
      const hostname = nonEmptyString(await desktop.getHostname())
      if (hostname) return hostname
    } catch {
      // Fall back to the browser-safe label when Electron IPC is unavailable.
    }
  }
  return getBrowserMachineLabel()
}

export async function resolveMachineIdentity({
  machines,
  createMachine,
  suggestedLabel,
  serverInstanceId,
  storage = safeStorage(),
}: {
  machines: Machine[]
  createMachine: (label: string) => Promise<Machine>
  suggestedLabel: string
  serverInstanceId?: string
  storage?: Storage
}): Promise<MachineIdentityResolution> {
  const savedMachineId = getSelectedMachineId(serverInstanceId, storage)
  const skipLegacyMigration = storage?.getItem(MACHINE_SELECTION_RESET_STORAGE_KEY) === '1'
  const savedMachine = savedMachineId
    ? machines.find((machine) => machine.id === savedMachineId)
    : undefined
  // A direct selection can be stale when this browser was last pointed at a
  // different server. In that case a recognized legacy v2 id still wins over
  // the chooser: it is the one durable identity this server explicitly knows.
  const legacyMachineId = savedMachine || skipLegacyMigration
    ? undefined
    : nonEmptyString(storage?.getItem(LEGACY_DEVICE_ID_STORAGE_KEY))
  const legacyMachine = legacyMachineId
    ? machines.find((machine) => machine.id === legacyMachineId)
    : undefined
  const selectedMachine = savedMachine ?? legacyMachine

  if (selectedMachine) {
    persistSelectedMachineId(selectedMachine.id, serverInstanceId, storage)
    return {
      kind: 'selected',
      machine: selectedMachine,
      source: savedMachine ? 'saved' : 'legacy',
    }
  }

  if (machines.length === 0) {
    const machine = await createMachine(suggestedLabel)
    persistSelectedMachineId(machine.id, serverInstanceId, storage)
    return { kind: 'selected', machine, source: 'created' }
  }

  return { kind: 'chooser', machines, suggestedLabel }
}
