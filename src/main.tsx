import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
// MUST stay ahead of the store/App imports: recover-my-panes boot-state (D1) depends on
// migrations having re-materialized freshell.layout.v3 BEFORE any capture runs (the
// react/react-dom/react-redux imports above are side-effect-free) — see
// docs/plans/2026-07-26-recover-my-panes.md and main-import-order.test.ts.
import '@/store/storage-migration'
import { store } from '@/store/store'
import App from '@/App'
import '@/index.css'
import { initializeAuthToken } from '@/lib/auth'
import { createClientLogger } from '@/lib/client-logger'
import { initClientPerfLogging } from '@/lib/perf-logger'
import { registerServiceWorker } from '@/lib/pwa'
import { initChunkErrorRecovery } from '@/lib/import-retry'

initializeAuthToken()
createClientLogger().installConsoleCapture()
initClientPerfLogging()
registerServiceWorker()
initChunkErrorRecovery()

if (import.meta.env.DEV) {
  document.title = 'freshell:dev'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled due to xterm.js incompatibility (double-mount causes renderer issues)
  <Provider store={store}>
    <App />
  </Provider>,
)
