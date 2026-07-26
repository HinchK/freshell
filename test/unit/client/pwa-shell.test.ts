import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerServiceWorker } from '@/lib/pwa'

describe('PWA shell registration', () => {
  const originalAddEventListener = window.addEventListener
  const originalServiceWorker = (navigator as any).serviceWorker
  const originalSessionStorage = window.sessionStorage

  function createStorageMock(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial))
    return {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: originalAddEventListener,
    })

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: originalServiceWorker,
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: originalSessionStorage,
    })
  })

  it('registers service worker on window load when enabled', async () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const handlers: Record<string, EventListener> = {}
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = handler
      }),
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })
    handlers.load?.(new Event('load'))

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/sw.js')
    })
  })

  it('requests a service worker update after registering', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const register = vi.fn().mockResolvedValue({ update })
    const handlers: Record<string, EventListener> = {}
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = handler
      }),
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })
    handlers.load?.(new Event('load'))

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1)
    })
  })

  it('reloads once when a new service worker takes control of an already-controlled page', () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const addEventListener = vi.fn()
    const handlers: Record<string, EventListener> = {}
    const reload = vi.fn()
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: {
        register,
        // The page is ALREADY controlled -- this controllerchange is an
        // UPDATE swap, the case the stale-client reload exists for.
        controller: {},
        addEventListener: vi.fn((event: string, handler: EventListener) => {
          handlers[event] = handler
          addEventListener(event, handler)
        }),
      },
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, reload, storage })
    handlers.controllerchange?.(new Event('controllerchange'))
    handlers.controllerchange?.(new Event('controllerchange'))

    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledWith('freshell.sw.controller-reload', '1')
    expect(addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function))
  })

  it('does not reload on the first controllerchange of an uncontrolled page (first-boot claim)', () => {
    // WAVE-B fast-follow (B3 lane review): on FIRST boot the SW's
    // install -> skipWaiting -> clients.claim fires controllerchange on a
    // page that was never controlled. Reloading there races the first-boot
    // recovery offer: by the time the reload lands, the auto shell tab has
    // persisted a layout, hadPersistedLayoutAtBoot flips true, and the
    // offer is permanently lost. The first claim must NOT reload; only a
    // real update swap (controller already existed) does.
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const handlers: Record<string, EventListener> = {}
    const reload = vi.fn()
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: {
        register,
        // No controller: the page was NOT controlled when we registered.
        controller: null,
        addEventListener: vi.fn((event: string, handler: EventListener) => {
          handlers[event] = handler
        }),
      },
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, reload, storage })
    // First claim: no reload.
    handlers.controllerchange?.(new Event('controllerchange'))
    expect(reload).not.toHaveBeenCalled()
    // A LATER swap (a genuine update) still reloads.
    handlers.controllerchange?.(new Event('controllerchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears the stale reload sentinel on startup', () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const storage = createStorageMock({ 'freshell.sw.controller-reload': '1' })

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })

    expect(storage.removeItem).toHaveBeenCalledWith('freshell.sw.controller-reload')
  })

  it('does not register when disabled', () => {
    const register = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    registerServiceWorker({ enabled: false })
    expect(register).not.toHaveBeenCalled()
  })
})
