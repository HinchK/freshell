/** A local layout older than this rebuilds from the server instead of being
 * kept. 7 days is far beyond any terminal lifetime (15-minute default idle
 * timeout), so it only triggers for genuinely abandoned layouts. Shared
 * by the boot health classifier (layout-health.ts) and the migration-boot
 * prune sweep (storage-migration.ts) — a leaf module because the migration
 * must not import layout-health (which imports the migration for the
 * pre-migration evidence capture). */
export const STALE_LAYOUT_MS = 7 * 24 * 60 * 60 * 1000
