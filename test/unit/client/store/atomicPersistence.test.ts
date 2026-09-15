// Tests for atomic tabs+panes persistence via the per-window layout key
// (delta round 3, finding 1 / e3r1 finding 3: freshell.layout.v3.<layoutWindowId>,
// with freshell.layout.v3 retained as the LEGACY key only).
import { describe, it, expect, beforeEach } from 'vitest'
import { LEGACY_LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY } from '@/store/storage-keys'
import { parsePersistedLayoutRaw, migrateV2ToV3 } from '@/store/persistedState'

const WINDOW_ID = 'client-atomic-persistence'
const OWN_LAYOUT_KEY = `freshell.layout.v3.${WINDOW_ID}`

describe('atomic persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
  })

  describe('layout storage keys', () => {
    it('keeps the bare freshell.layout.v3 as the LEGACY key only (adoption source, never deleted)', () => {
      expect(LEGACY_LAYOUT_STORAGE_KEY).toBe('freshell.layout.v3')
    })

    it('derives the window’s layout key from the dedicated layout-window id (freshell.layout-window-id.v1), not the tab-registry client id', async () => {
      const { getWindowLayoutKey } = await import('@/store/window-layout-keys')
      expect(getWindowLayoutKey()).toBe(OWN_LAYOUT_KEY)
    })
  })

  describe('parsePersistedLayoutRaw', () => {
    it('parses a valid v3 layout payload', () => {
      const payload = {
        version: 3,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', title: 'Tab 1', status: 'running', mode: 'shell', createdAt: 1000 }],
        },
        panes: {
          layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } } },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [{ id: 'deleted-tab', deletedAt: 1000 }],
      }

      const result = parsePersistedLayoutRaw(JSON.stringify(payload))
      expect(result).not.toBeNull()
      expect(result!.tabs.tabs).toHaveLength(1)
      expect(result!.tabs.tabs[0].id).toBe('tab-1')
      expect(result!.panes.layouts).toHaveProperty('tab-1')
      expect(result!.tombstones).toHaveLength(1)
      expect(result!.tombstones[0].id).toBe('deleted-tab')
    })

    it('returns null for invalid JSON', () => {
      expect(parsePersistedLayoutRaw('not json')).toBeNull()
    })

    it('returns null for missing tabs', () => {
      expect(parsePersistedLayoutRaw(JSON.stringify({ version: 3, panes: {} }))).toBeNull()
    })

    it('defaults tombstones to empty array', () => {
      const payload = {
        version: 3,
        tabs: { activeTabId: null, tabs: [] },
        panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      }
      const result = parsePersistedLayoutRaw(JSON.stringify(payload))
      expect(result!.tombstones).toEqual([])
    })
  })

  describe('migrateV2ToV3', () => {
    it('combines v2 tabs and panes into v3 layout', () => {
      const v2Tabs = JSON.stringify({
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', title: 'Shell', status: 'running', mode: 'shell', createdAt: 1000 }],
        },
        tombstones: [{ id: 'old-tab', deletedAt: 500 }],
      })
      const v2Panes = JSON.stringify({
        version: 6,
        layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } } },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      localStorage.setItem(TABS_STORAGE_KEY, v2Tabs)
      localStorage.setItem(PANES_STORAGE_KEY, v2Panes)

      const result = migrateV2ToV3()
      expect(result).not.toBeNull()

      // Should have written the window's own v3 key (never the legacy key)
      const v3Raw = localStorage.getItem(OWN_LAYOUT_KEY)
      expect(v3Raw).not.toBeNull()

      const v3 = JSON.parse(v3Raw!)
      expect(v3.version).toBe(4)
      expect(v3.tabs.tabs).toHaveLength(1)
      expect(v3.panes.layouts).toHaveProperty('tab-1')
      expect(v3.tombstones).toHaveLength(1)

      // Should have deleted v2 keys
      expect(localStorage.getItem(TABS_STORAGE_KEY)).toBeNull()
      expect(localStorage.getItem(PANES_STORAGE_KEY)).toBeNull()
      expect(localStorage.getItem('freshell.layout.v3'), 'the v2→v3 write targets the window\u2019s own key, never the legacy key').toBeNull()
    })

    it('returns null when no v2 keys exist', () => {
      expect(migrateV2ToV3()).toBeNull()
    })

    it('handles missing panes key — creates empty panes', () => {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
        tabs: { activeTabId: null, tabs: [] },
      }))

      const result = migrateV2ToV3()
      expect(result).not.toBeNull()
      expect(result!.panes.layouts).toEqual({})
    })
  })
})
