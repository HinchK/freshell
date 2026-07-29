// ============================================================================
// PANE-ICON TINT COLORS — TabItem.tsx's icon tint classes projected to canvas
// hex, derived from freshell's own UI tokens. KEEP IN SYNC: when an app token
// changes, update the deck constant to match (same rule as tile-renderer.ts's
// palette block). These live in their own leaf module because BOTH frame.ts
// (which stamps per-icon readiness by computing the tinted data URL at
// frame-build time) and tile-renderer.ts (which draws) need them — a shared
// leaf module keeps the deck import graph free of runtime cycles.
//
//   deck constant     <- app source token                                  value
//   STATUS_GREEN      <- text-success       (TabItem pane running tint)    hsl(142 71% 45%) = #21c45d
//   STATUS_BLUE       <- text-blue-500      (TabItem pane busy tint)       #3b82f6
//   STATUS_AMBER      <- --warning / text-warning                          hsl(38 92% 50%)  = #f59f0a
//   STATUS_RED        <- --destructive light / text-destructive            hsl(0 72% 51%)   = #dc2828
//   STATUS_MUTED      <- text-muted-foreground dark                        hsl(240 5% 65%)  = #a1a1aa
//   STATUS_MUTED_DIM  <- text-muted-foreground/40 dark                     rgba(161,161,170,0.4)
// ============================================================================

export const STATUS_GREEN = '#21c45d'
export const STATUS_BLUE = '#3b82f6'
export const STATUS_AMBER = '#f59f0a'
export const STATUS_RED = '#dc2828'
export const STATUS_MUTED = '#a1a1aa'
export const STATUS_MUTED_DIM = 'rgba(161,161,170,0.4)'
