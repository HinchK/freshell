export function isWebHidSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'hid' in navigator
  } catch {
    return false
  }
}

// In the packaged Electron app navigator.hid EXISTS but requestDevice() always
// resolves [] (no picker) and getDevices() is always [] (no persistence) because
// no select-hid-device handler is registered. Zero electron/ changes is a recorded
// decision — the UI must detect Electron and message honestly instead.
export function isElectronClient(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
  } catch {
    return false
  }
}
