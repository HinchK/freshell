import { beforeEach, describe, expect, it } from 'vitest'

import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  loadBrowserPreferencesRecord,
  patchBrowserPreferencesRecord,
  resolveBrowserPreferenceSettings,
} from '@/lib/browser-preferences'

describe('browser preferences fresh-agent settings compatibility', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads browser-local settings seeded with agentChat as canonical freshAgent', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        agentChat: {
          showTools: true,
          showThinking: true,
          expandTools: true,
          fontScale: 1.25,
        },
      },
    }))

    const record = loadBrowserPreferencesRecord()
    const resolved = resolveBrowserPreferenceSettings(record)

    expect(record.settings).toEqual({
      freshAgent: {
        expandTools: true,
      },
    })
    expect(resolved.freshAgent.expandTools).toBe(true)
    expect(resolved.freshAgent.expandThinking).toBe(false)
    expect('showThinking' in resolved.freshAgent).toBe(false)
    expect('showTools' in resolved.freshAgent).toBe(false)
    expect('fontScale' in resolved.freshAgent).toBe(false)
    expect('agentChat' in (record.settings ?? {})).toBe(false)
    expect('agentChat' in resolved).toBe(false)
  })

  it('saves browser preferences with only freshAgent settings', () => {
    patchBrowserPreferencesRecord({
      settings: {
        agentChat: {
          expandTools: true,
          showTools: true,
          fontScale: 1.25,
        },
      },
    } as never)

    const raw = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) ?? '{}')

    expect(raw.settings).toEqual({
      freshAgent: {
        expandTools: true,
      },
    })
    expect(raw.settings.agentChat).toBeUndefined()
  })
})
