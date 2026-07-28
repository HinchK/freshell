const SW_RELOAD_SENTINEL = 'freshell.sw.controller-reload'

interface RegisterServiceWorkerOptions {
  enabled?: boolean
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

export function registerServiceWorker(options?: RegisterServiceWorkerOptions): void {
  if (!('serviceWorker' in navigator)) return
  const enabled = options?.enabled ?? import.meta.env.PROD
  if (!enabled) return
  const reload = options?.reload ?? (() => window.location.reload())
  const storage = options?.storage ?? window.sessionStorage

  try {
    if (storage.getItem(SW_RELOAD_SENTINEL) === '1') {
      storage.removeItem(SW_RELOAD_SENTINEL)
    }
  } catch {
    // Ignore sessionStorage access failures.
  }

  // First-boot guard (wave-B B3 fast-follow): when the page was NOT already
  // controlled, the first controllerchange is the service worker's initial
  // claim (install -> skipWaiting -> clients.claim in sw.js), not an update
  // swap. Reloading there races the first-boot recovery offer: by the time
  // the reload lands, the auto shell tab has persisted a layout, so
  // hadPersistedLayoutAtBoot flips true on the reloaded boot and the offer
  // is permanently lost. Only a genuine update (controller already existed)
  // reloads stale clients.
  let hadController = !!navigator.serviceWorker.controller
  let reloading = false
  const onControllerChange = () => {
    if (!hadController) {
      hadController = true
      return
    }
    if (reloading) return
    reloading = true
    try {
      storage.setItem(SW_RELOAD_SENTINEL, '1')
    } catch {
      // Ignore sessionStorage access failures.
    }
    reload()
  }

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
      .then((registration) => registration.update?.())
      .catch(() => {
        // Non-fatal: app still functions without offline cache support.
      })
  })
}
