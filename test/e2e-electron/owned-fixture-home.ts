/**
 * Delete isolated fixture state only after its exact owning process has been
 * contained and any caller-required release proof has succeeded. Callers keep
 * containment and deletion failures in their own aggregate so every teardown
 * failure remains visible.
 */
export interface OwnedFixtureHomeCleanupDeps {
  containOwner(): Promise<void>
  removeHome(): Promise<void>
}

export async function cleanupOwnedFixtureHome({
  containOwner,
  removeHome,
}: OwnedFixtureHomeCleanupDeps): Promise<void> {
  await containOwner()
  await removeHome()
}
