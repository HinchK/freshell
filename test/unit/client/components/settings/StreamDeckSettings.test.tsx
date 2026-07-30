import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

// vi.mock factories run during hoisted import resolution, before test-file
// body constants initialize — vi.hoisted makes the fns exist first.
const { requestDeckConnect, supported, electron } = vi.hoisted(() => ({
  requestDeckConnect: vi.fn(async () => {}),
  supported: vi.fn(() => true),
  electron: vi.fn(() => false),
}))
vi.mock('@/deck/deck-manager', () => ({ requestDeckConnect }))
vi.mock('@/lib/webhid-support', () => ({
  isWebHidSupported: () => supported(),
  isElectronClient: () => electron(),
}))

import deckReducer, { setDeckStatus } from '@/store/deckSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import StreamDeckSettings from '@/components/settings/StreamDeckSettings'

function renderSection(
  streamDeck = { enabled: true, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300, tileStyle: 'status-icons' as const, keyLayout: 'auto' as const },
) {
  const store = configureStore({ reducer: { deck: deckReducer, settings: settingsReducer } })
  const applyLocalSetting = vi.fn()
  render(
    <Provider store={store}>
      <StreamDeckSettings
        settings={{ ...defaultSettings, streamDeck }}
        applyLocalSetting={applyLocalSetting}
        applyServerSetting={vi.fn()}
        scheduleServerTextSettingSave={vi.fn()}
      />
    </Provider>,
  )
  return { store, applyLocalSetting }
}

describe('StreamDeckSettings', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('toggles enable via applyLocalSetting', () => {
    const { applyLocalSetting } = renderSection({
      enabled: false,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 300,
    })
    fireEvent.click(screen.getByRole('switch', { name: /enable stream deck/i }))
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { enabled: true } })
  })

  it('connect button is a real button and calls requestDeckConnect', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /connect stream deck/i }))
    expect(requestDeckConnect).toHaveBeenCalledTimes(1)
  })

  it('connect button is disabled while Stream Deck is not enabled', () => {
    renderSection({ enabled: false, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300 })
    expect(screen.getByRole('button', { name: /connect stream deck/i })).toBeDisabled()
  })

  it('shows connected model + key count from the deck slice', () => {
    const { store } = renderSection()
    act(() => {
      store.dispatch(setDeckStatus({ status: 'connected', model: 'Stream Deck Mini', keyCount: 6 }))
    })
    expect(screen.getByText(/connected: stream deck mini \(6 keys\)/i)).toBeInTheDocument()
  })

  it('shows connecting status text', () => {
    const { store } = renderSection()
    act(() => {
      store.dispatch(setDeckStatus({ status: 'connecting' }))
    })
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()
  })

  it('shows in-use status text', () => {
    const { store } = renderSection()
    act(() => {
      store.dispatch(setDeckStatus({ status: 'in-use' }))
    })
    expect(screen.getByText(/in use by another window or app/i)).toBeInTheDocument()
  })

  it('shows error status text', () => {
    const { store } = renderSection()
    act(() => {
      store.dispatch(setDeckStatus({ status: 'error' }))
    })
    expect(screen.getByText(/connection failed/i)).toBeInTheDocument()
  })

  it('non-Chromium browsers get the requires-Chrome note and no connect button', () => {
    supported.mockReturnValueOnce(false)
    renderSection()
    expect(screen.getByText(/requires chrome or edge/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /connect stream deck/i })).toBeNull()
  })

  it('Electron gets the honest not-supported message instead of a dead connect button', () => {
    // navigator.hid EXISTS in Electron but requestDevice() always resolves [] — the
    // supported check alone would render a Connect button that can never work.
    electron.mockReturnValueOnce(true)
    renderSection()
    expect(screen.getByText(/not supported in the desktop app/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /connect stream deck/i })).toBeNull()
  })

  it('virtual deck toggle flips deck.virtualDeckOpen', () => {
    const { store } = renderSection()
    fireEvent.click(screen.getByRole('switch', { name: /show virtual deck/i }))
    expect(store.getState().deck.virtualDeckOpen).toBe(true)
  })

  it('idle timeout input applies a local patch', () => {
    const { applyLocalSetting } = renderSection()
    const input = screen.getByRole('spinbutton', { name: /idle timeout/i })
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { idleTimeoutSeconds: 60 } })
  })

  it('active brightness input applies a local patch', () => {
    const { applyLocalSetting } = renderSection()
    const input = screen.getByRole('spinbutton', { name: /active brightness/i })
    fireEvent.change(input, { target: { value: '50' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { brightness: 50 } })
  })

  it('idle brightness input applies a local patch', () => {
    const { applyLocalSetting } = renderSection()
    const input = screen.getByRole('spinbutton', { name: /idle brightness/i })
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { idleBrightness: 20 } })
  })

  it('offers the tile style choice with Status icons selected by default', () => {
    renderSection()
    const group = screen.getByRole('group', { name: /tile style/i })
    const statusIcons = within(group).getByRole('button', { name: /status icons/i })
    expect(statusIcons).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: /terminal previews/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('selecting Terminal previews patches streamDeck.tileStyle', () => {
    const { applyLocalSetting } = renderSection()
    fireEvent.click(screen.getByRole('button', { name: /terminal previews/i }))
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { tileStyle: 'terminal-previews' } })
  })
})
