export const STORAGE_KEYS = {
  // The bare `freshell.layout.v3` family is the LEGACY (pre-per-window)
  // shape: adoption source for a window's first post-change boot, never
  // deleted (other live pre-change windows may still read it). The live
  // per-window key is `freshell.layout.v3.<layoutWindowId>` — see
  // window-layout-keys.ts (delta round 3, finding 1; e3r1 finding 3: the
  // id is the immutable layout-window-id, not the registry client id).
  legacyLayout: 'freshell.layout.v3',
  legacyLayoutBackup: 'freshell.layout.v3.bak',
  legacyLayoutPreMigrationRaw: 'freshell.layout.pre-migration-raw.v1',
  // One-shot global marker: the FIRST window to adopt the legacy envelope
  // sets it; every later fresh window classifies absent and rebuilds from
  // the inventory instead of adopting (e3r1 finding 2).
  legacyLayoutAdoptionMarker: 'freshell.layout.legacy-adopted.v1',
  tabs: 'freshell.tabs.v2',
  panes: 'freshell.panes.v2',
  sessionActivity: 'freshell.sessionActivity.v2',
  terminalCursor: 'freshell.terminal-cursors.v2',
  browserPreferences: 'freshell.browser-preferences.v1',
  tabRecency: 'freshell.tab-recency.v1',
  turnCompletion: 'freshell.turn-completion.v1',
  deviceId: 'freshell.device-id.v2',
  deviceLabel: 'freshell.device-label.v2',
  deviceLabelCustom: 'freshell.device-label-custom.v2',
  deviceFingerprint: 'freshell.device-fingerprint.v2',
  deviceAliases: 'freshell.device-aliases.v2',
  deviceDismissed: 'freshell.device-dismissed.v1',
  machineId: 'freshell.machine-id.v1',
  machineSelections: 'freshell.machine-selections.v1',
  machineSelectionReset: 'freshell.machine-selection-reset.v1',
  layoutWindowId: 'freshell.layout-window-id.v1',
  tabRegistryClientInstanceId: 'freshell.tabs.client-instance-id.v1',
  tabRegistrySnapshotRevision: 'freshell.tabs.snapshot-revision.v1',
  inputHistory: 'freshell.input-history.v1',
} as const

export const LEGACY_LAYOUT_STORAGE_KEY = STORAGE_KEYS.legacyLayout
export const LEGACY_LAYOUT_BACKUP_STORAGE_KEY = STORAGE_KEYS.legacyLayoutBackup
export const LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY = STORAGE_KEYS.legacyLayoutPreMigrationRaw
export const LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY = STORAGE_KEYS.legacyLayoutAdoptionMarker
export const LAYOUT_WINDOW_ID_STORAGE_KEY = STORAGE_KEYS.layoutWindowId
export const TABS_STORAGE_KEY = STORAGE_KEYS.tabs
export const PANES_STORAGE_KEY = STORAGE_KEYS.panes
export const SESSION_ACTIVITY_STORAGE_KEY = STORAGE_KEYS.sessionActivity
export const TERMINAL_CURSOR_STORAGE_KEY = STORAGE_KEYS.terminalCursor
export const BROWSER_PREFERENCES_STORAGE_KEY = STORAGE_KEYS.browserPreferences
export const TAB_RECENCY_STORAGE_KEY = STORAGE_KEYS.tabRecency
export const TURN_COMPLETION_STORAGE_KEY = STORAGE_KEYS.turnCompletion
export const DEVICE_ID_STORAGE_KEY = STORAGE_KEYS.deviceId
export const DEVICE_LABEL_STORAGE_KEY = STORAGE_KEYS.deviceLabel
export const DEVICE_LABEL_CUSTOM_STORAGE_KEY = STORAGE_KEYS.deviceLabelCustom
export const DEVICE_FINGERPRINT_STORAGE_KEY = STORAGE_KEYS.deviceFingerprint
export const DEVICE_ALIASES_STORAGE_KEY = STORAGE_KEYS.deviceAliases
export const DEVICE_DISMISSED_STORAGE_KEY = STORAGE_KEYS.deviceDismissed
export const MACHINE_ID_STORAGE_KEY = STORAGE_KEYS.machineId
export const MACHINE_SELECTIONS_STORAGE_KEY = STORAGE_KEYS.machineSelections
export const MACHINE_SELECTION_RESET_STORAGE_KEY = STORAGE_KEYS.machineSelectionReset
export const TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY = STORAGE_KEYS.tabRegistryClientInstanceId
export const TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY = STORAGE_KEYS.tabRegistrySnapshotRevision
