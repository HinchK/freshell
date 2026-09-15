import { getWindowLayoutBackupKey, getWindowLayoutKey } from '@/store/window-layout-keys'

export function computeHadPersistedLayout(storage: Pick<Storage, 'getItem'>): boolean {
  // Delta round 3, finding 1: the boot's "had layout" signal reads THIS
  // window's per-window layout key and its per-window backup — never the
  // origin-wide legacy keys (another window's envelope is not this
  // window's layout). The storage-migration import in main.tsx runs (and
  // adopts any legacy envelope into this window's key) BEFORE this module
  // can load — see the invariants below and main-import-order.test.ts.
  return storage.getItem(getWindowLayoutKey()) !== null
    || storage.getItem(getWindowLayoutBackupKey()) !== null
}

// Captured at module import. Synchronous module-load writers of this
// window's per-window layout key DO exist (storage-migration.ts —
// self-executing via main.tsx's side-effect import at main.tsx:4, plus
// migrateV2ToV3 during tabsSlice module eval), but each fires only when
// durable layout data ALREADY existed, so key-presence here remains the
// correct "had layout" signal; the legacy adoption inside the migration
// materializes a pre-change envelope into this window's key BEFORE this
// module can load. Invariants (pinned by main-import-order.test.ts): the
// storage-migration import stays ahead of the store/App imports in main.tsx
// (the imports above it are side-effect-free library imports); main.tsx
// never imports this module.
// The asynchronous writers (auto shell tab App.tsx, 500ms persist debounce)
// land long after module eval (see docs/plans/2026-07-26-recover-my-panes.md D1).
export const hadPersistedLayoutAtBoot: boolean =
  typeof window !== 'undefined' && computeHadPersistedLayout(window.localStorage)

// Paired with the capture above: the moment this boot's "had layout" signal was taken.
// Anchor for the inventory request's bootAgoMs (D2's concurrent-client filter) - sent as
// an elapsed DURATION so client/server clock skew cannot corrupt the server-side cutoff.
export const bootCapturedAtMs: number = Date.now()
