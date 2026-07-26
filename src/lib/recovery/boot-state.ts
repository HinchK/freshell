const LAYOUT_KEY = 'freshell.layout.v3'
const LAYOUT_BAK_KEY = 'freshell.layout.v3.bak'

export function computeHadPersistedLayout(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem(LAYOUT_KEY) !== null || storage.getItem(LAYOUT_BAK_KEY) !== null
}

// Captured at module import. Synchronous module-load writers of freshell.layout.v3 DO
// exist (storage-migration.ts:332/431 — self-executing via main.tsx's side-effect import
// at main.tsx:4 — and migrateV2ToV3, persistedState.ts:594, during tabsSlice module eval),
// but each fires only when durable layout data ALREADY existed, so key-presence here
// remains the correct "had layout" signal. storage-migration also re-materializes
// freshell.layout.v3 from the `.backup-before-fresh-agent-centralization` key BEFORE this
// module can load — which is why we check only v3 + .bak. Invariants (pinned by
// main-import-order.test.ts): the storage-migration import stays ahead of the store/App
// imports in main.tsx (the imports above it are side-effect-free library imports);
// main.tsx never imports this module.
// The asynchronous writers (auto shell tab App.tsx:1423-1427, 500ms persist debounce)
// land long after module eval (see docs/plans/2026-07-26-recover-my-panes.md D1).
export const hadPersistedLayoutAtBoot: boolean =
  typeof window !== 'undefined' && computeHadPersistedLayout(window.localStorage)

// Paired with the capture above: the moment this boot's "had layout" signal was taken.
// Anchor for the inventory request's bootAgoMs (D2's concurrent-client filter) - sent as
// an elapsed DURATION so client/server clock skew cannot corrupt the server-side cutoff.
export const bootCapturedAtMs: number = Date.now()
