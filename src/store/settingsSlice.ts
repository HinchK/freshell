import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import {
  composeResolvedSettings,
  createDefaultResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  mergeLocalSettings,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
  type LocalSettings,
  type LocalSettingsPatch,
  type LocalSettingsPlatformDefaults,
  type ResolvedSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from '@shared/settings'
import { loadBrowserPreferencesRecord, resolveBrowserPreferenceSettings } from '@/lib/browser-preferences'
import { isMobileDevice } from '@/lib/mobile-device'
import type { AppSettings } from './types'
import type { DeepPartial } from '@/lib/type-utils'

export function resolveDefaultLoggingDebug(isDev: boolean = import.meta.env.DEV): boolean {
  return !!isDev
}

// The floating add/split button's default depends on the viewport class at
// boot: desktop (>=768px) shows it, mobile width (<768px) hides it. This is
// the repo's canonical mobile test — viewport width, not device class (a
// desktop window narrowed below 768px counts as mobile). The default is
// resolved ONCE per page load and is sticky for the session: resizing across
// the breakpoint does not re-resolve until the next reload (the same
// boot-time shape as resolveDefaultLoggingDebug). Every client path that can
// resolve or diff local settings WITHOUT an explicit saved value threads this
// same const, so resolution and the browser-preferences write-diff share one
// base within a boot. The slice reducers do NOT need it: after boot the
// resolved localSettings always carry a concrete boolean that survives every
// seed/merge round-trip (PANES_LOCAL_KEYS whitelist + pickKeys own-key copy +
// mergeLocalSettings panes merge).
export function resolveDefaultFloatingActionButton(isMobile: boolean): boolean {
  return !isMobile
}

export const localSettingsPlatformDefaults: LocalSettingsPlatformDefaults = {
  floatingActionButtonDefault: resolveDefaultFloatingActionButton(isMobileDevice()),
}

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: resolveDefaultLoggingDebug(),
})

export const defaultSettings: AppSettings = createDefaultResolvedSettings({
  loggingDebug: resolveDefaultLoggingDebug(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerPatch(value: unknown): ServerSettingsPatch {
  if (!isRecord(value)) {
    return {}
  }
  return stripLocalSettings(value, { migrateLegacyFreshAgentAlias: false }) as ServerSettingsPatch
}

function normalizeLocalPatch(value: unknown): LocalSettingsPatch {
  if (!isRecord(value)) {
    return {}
  }
  return extractLegacyLocalSettingsSeed(value) ?? {}
}

function resolveServerSettings(settings: ServerSettings): ServerSettings {
  return mergeServerSettings(defaultServerSettings, normalizeServerPatch(settings))
}

function resolveSettings(serverSettings: ServerSettings, localSettings: LocalSettings): ResolvedSettings {
  return composeResolvedSettings(serverSettings, localSettings)
}

function toServerSettings(settings: ResolvedSettings): ServerSettings {
  return mergeServerSettings(
    createDefaultServerSettings({ loggingDebug: settings.logging.debug }),
    normalizeServerPatch(settings),
  )
}

function toLocalSettingsPatch(settings: ResolvedSettings | LocalSettings): LocalSettingsPatch {
  return normalizeLocalPatch(settings)
}

function loadInitialLocalSettings(): LocalSettings {
  return resolveBrowserPreferenceSettings(loadBrowserPreferencesRecord(), localSettingsPlatformDefaults)
}

export interface SettingsState {
  serverSettings: ServerSettings
  localSettings: LocalSettings
  settings: ResolvedSettings
  loaded: boolean
  lastSavedAt?: number
  /** Effective server config dir (~/.freshell or the named profile's dir), as
   *  reported by bootstrap. Undefined until a bootstrap payload with configDir
   *  arrives; kept optional so test-store helpers can omit the field. */
  serverConfigDir?: string | null
}

const initialLocalSettings = loadInitialLocalSettings()

const initialState: SettingsState = {
  serverSettings: defaultServerSettings,
  localSettings: initialLocalSettings,
  settings: resolveSettings(defaultServerSettings, initialLocalSettings),
  loaded: false,
  serverConfigDir: null,
}

export function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const serverSettings = mergeServerSettings(
    toServerSettings(base),
    normalizeServerPatch(patch),
  )
  const localSettings = resolveLocalSettings(
    mergeLocalSettings(toLocalSettingsPatch(base), normalizeLocalPatch(patch)),
  )

  return resolveSettings(serverSettings, localSettings)
}

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setServerSettings: (state, action: PayloadAction<ServerSettings>) => {
      state.serverSettings = resolveServerSettings(action.payload)
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
      state.loaded = true
    },
    setLocalSettings: (state, action: PayloadAction<LocalSettings>) => {
      state.localSettings = resolveLocalSettings(action.payload)
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    updateSettingsLocal: (state, action: PayloadAction<LocalSettingsPatch>) => {
      state.localSettings = resolveLocalSettings(
        mergeLocalSettings(toLocalSettingsPatch(state.localSettings), normalizeLocalPatch(action.payload)),
      )
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    previewServerSettingsPatch: (state, action: PayloadAction<ServerSettingsPatch>) => {
      state.serverSettings = mergeServerSettings(state.serverSettings, normalizeServerPatch(action.payload))
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    markSaved: (state) => {
      state.lastSavedAt = Date.now()
    },
    setServerConfigDir: (state, action: PayloadAction<string | null>) => {
      state.serverConfigDir = action.payload
    },
  },
})

export const {
  setServerSettings,
  setLocalSettings,
  updateSettingsLocal,
  previewServerSettingsPatch,
  markSaved,
  setServerConfigDir,
} = settingsSlice.actions

export default settingsSlice.reducer
