import { describe, expect, it } from 'vitest'
import * as fixtures from './fixtures.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import {
  MACHINE_ID_STORAGE_KEY,
  STORAGE_VERSION,
  STORAGE_VERSION_KEY,
} from '../../../src/store/storage-keys.js'

const serverInfo = {
  baseUrl: 'http://127.0.0.1:45123',
  token: 'e2e-fixture-token',
} as E2eServerInfo

type ManualContextFactory = (
  browser: unknown,
  info: E2eServerInfo,
  machineId: string,
  options?: unknown,
) => Promise<unknown>

type FreshManualContextFactory = (
  browser: unknown,
  info: E2eServerInfo,
  options?: unknown,
) => Promise<{ context: unknown; machine: { id: string; label: string } }>

type InstalledInitScript = (input: {
  machineKey: string
  machineId: string
  serverOrigin: string
  versionKey: string
  version: number
}) => void

function helper(name: 'createE2eBrowserContext' | 'createFreshE2eBrowserContext'): unknown {
  return (fixtures as Record<string, unknown>)[name]
}

describe('manual E2E browser contexts', () => {
  it('installs the selected fixture machine before the manual context navigates', async () => {
    let options: unknown
    let initScript: InstalledInitScript | undefined
    let initScriptInput: Parameters<InstalledInitScript>[0] | undefined
    const context = {
      addInitScript: async (script: InstalledInitScript, input: Parameters<InstalledInitScript>[0]) => {
        initScript = script
        initScriptInput = input
      },
    }
    const browser = {
      newContext: async (nextOptions: unknown) => {
        options = nextOptions
        return context
      },
    }

    const createContext = helper('createE2eBrowserContext') as ManualContextFactory | undefined
    expect(createContext).toBeTypeOf('function')
    const result = await createContext!(browser, serverInfo, 'machine-fixture-owned', { serviceWorkers: 'block' })

    expect(result).toBe(context)
    expect(options).toEqual({ serviceWorkers: 'block' })
    expect(initScript).toBeTypeOf('function')

    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    const localStorage = {
      setItem: (key: string, value: string) => values.set(key, value),
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: serverInfo.baseUrl },
        localStorage,
      },
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: localStorage,
    })
    try {
      initScript!(initScriptInput!)
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow)
      }
      else {
        delete (globalThis as { window?: unknown }).window
      }
      if (originalLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
      }
      else {
        delete (globalThis as { localStorage?: unknown }).localStorage
      }
    }

    expect(values).toEqual(new Map([
      [STORAGE_VERSION_KEY, String(STORAGE_VERSION)],
      [MACHINE_ID_STORAGE_KEY, 'machine-fixture-owned'],
    ]))
  })

  it('registers a fresh server-owned machine before creating an isolated manual context', async () => {
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    let initScript: InstalledInitScript | undefined
    let initScriptInput: Parameters<InstalledInitScript>[0] | undefined
    const context = {
      addInitScript: async (script: InstalledInitScript, input: Parameters<InstalledInitScript>[0]) => {
        initScript = script
        initScriptInput = input
      },
    }
    const browser = { newContext: async () => context }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      requestedUrl = String(url)
      requestedInit = init
      return new Response(JSON.stringify({
        machine: { id: 'machine-fresh', label: 'Fresh E2E device' },
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    try {
      const createFreshContext = helper('createFreshE2eBrowserContext') as FreshManualContextFactory | undefined
      expect(createFreshContext).toBeTypeOf('function')
      const result = await createFreshContext!(browser, serverInfo)

      expect(result).toEqual({
        context,
        machine: { id: 'machine-fresh', label: 'Fresh E2E device' },
      })
      expect(requestedUrl).toBe(`${serverInfo.baseUrl}/api/machines`)
      expect(requestedInit).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ 'x-auth-token': serverInfo.token }),
      })
      expect(initScriptInput?.machineId).toBe('machine-fresh')
      expect(initScript).toBeTypeOf('function')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
