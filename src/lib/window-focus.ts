/**
 * The receipt-time witness inputs (DR5-3, delta round 5): the window's
 * CURRENT focus + visibility, read synchronously wherever an ending event is
 * RECEIVED (the turn-completion receipt middleware stamping the watched bit).
 * Shared by the notification hook (its focus listeners) and the receipt
 * middleware so both read one definition of "the window is witnessed".
 */
export function isWindowFocused(): boolean {
  if (typeof document === 'undefined') return true
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return hasFocus && !document.hidden
}
