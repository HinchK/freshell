import { TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY } from './storage-keys'

/**
 * The per-window client id, shared by the tab-registry sync AND the
 * per-window layout keys (delta round 3, finding 1: the layout envelope is
 * keyed `freshell.layout.v3.<clientInstanceId>` from this SAME id source —
 * the sessionStorage key freshell.tabs.client-instance-id.v1). Extracted to
 * a dependency-free leaf so key-derivation modules can resolve the id
 * without importing the registry-sync module graph (cyclic with the
 * self-executing storage migration).
 *
 * One window is one JS realm; sessionStorage (unlike localStorage) is NOT
 * shared across tabs, which is exactly the per-window scope the id needs.
 * The in-memory fallback keeps the id stable when sessionStorage is
 * unavailable (tests, privacy modes).
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
    clientInstanceId = inMemoryClientInstanceId
  }
  if (!storage) {
    clientInstanceId = inMemoryClientInstanceId
  }
  if (!clientInstanceId) {
    return mintTabRegistryClientInstanceId()
  }
  inMemoryClientInstanceId = clientInstanceId
  return clientInstanceId
}
