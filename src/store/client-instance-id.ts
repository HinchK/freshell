import { TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY } from './storage-keys'

/**
 * The per-window client id used by the tab-registry sync (the sessionStorage
 * key freshell.tabs.client-instance-id.v1). Extracted to a dependency-free
 * leaf so the registry-sync module graph stays importable without cycles.
 * The per-window LAYOUT keys no longer derive from this id (e3r1 finding
 * 3): it is MUTABLE — the lease-collision rotation rewrites it — so the
 * layout envelope is keyed by the dedicated layout-window-id instead
 * (window-layout-keys.ts), which that same rotation remints (e3r2
 * finding 1). The registry id keeps serving the
 * machine-bootstrap exclusion id and server-side identity.
 *
 * One window is one JS realm; sessionStorage (unlike localStorage) is NOT
 * shared across tabs, which is exactly the per-window scope the id needs.
 * The in-memory fallback keeps the id stable when sessionStorage is
 * unavailable (tests, privacy modes) or when writes fail (quota).
 */
let inMemoryClientInstanceId = ''
let inMemorySnapshotRevision = 0

export function randomClientInstanceId(): string {
  return `client-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

export function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

export function readInMemorySnapshotRevision(): number {
  return inMemorySnapshotRevision
}

export function writeInMemorySnapshotRevision(revision: number): void {
  inMemorySnapshotRevision = revision
}

/** Mint a fresh id and persist it (plus a zeroed snapshot revision) — the
 * full original mint sequence from tabRegistrySync, preserved verbatim. */
export function mintTabRegistryClientInstanceId(): string {
  const clientInstanceId = randomClientInstanceId()
  inMemoryClientInstanceId = clientInstanceId
  inMemorySnapshotRevision = 0
  try {
    safeSessionStorage()?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
    safeSessionStorage()?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, '0')
  } catch {
    // Keep the per-window module fallback stable when sessionStorage is unavailable.
  }
  return clientInstanceId
}

/** Force a specific id (registry lease-collision rotation): in-memory id +
 * sessionStorage persist, snapshot revision untouched. */
export function setTabRegistryClientInstanceId(clientInstanceId: string): void {
  inMemoryClientInstanceId = clientInstanceId
  try {
    safeSessionStorage()?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
  } catch {
    // Keep the per-window module fallback stable when sessionStorage is unavailable.
  }
}

export function getCurrentTabRegistryClientInstanceId(): string {
  const storage = safeSessionStorage()
  let clientInstanceId = ''
  try {
    clientInstanceId = storage?.getItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY) || ''
  } catch {
    clientInstanceId = ''
  }
  if (!clientInstanceId && !storage) {
    clientInstanceId = inMemoryClientInstanceId
  }
  if (!clientInstanceId) {
    // getItem succeeded-with-null but the stored write may have failed
    // (quota-exhausted sessionStorage): mint ONCE per context and keep the
    // id in memory regardless of write success, so repeated calls return
    // the same id (e3r1 finding 6).
    clientInstanceId = inMemoryClientInstanceId || mintTabRegistryClientInstanceId()
  }
  inMemoryClientInstanceId = clientInstanceId
  return clientInstanceId
}
