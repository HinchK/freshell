// Stream Deck settings section — enable/connect an Elgato Stream Deck (WebHID),
// tune brightness/idle behavior, and show the on-screen virtual deck.

import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setVirtualDeckOpen, type DeckSliceState } from '@/store/deckSlice'
import { requestDeckConnect } from '@/deck/deck-manager'
import { isElectronClient, isWebHidSupported } from '@/lib/webhid-support'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  SteppedRangeInput,
  Toggle,
} from './settings-controls'

const IDLE_TIMEOUT_VALUES = [0, 30, 60, 120, 300, 600, 1800, 3600] as const
const ACTIVE_BRIGHTNESS_VALUES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const IDLE_BRIGHTNESS_VALUES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const

function deckStatusText(deck: DeckSliceState): string {
  switch (deck.status) {
    case 'connected': {
      const model = deck.model ?? 'Stream Deck'
      const keys = deck.keyCount != null ? ` (${deck.keyCount} keys)` : ''
      return `Connected: ${model}${keys}`
    }
    case 'connecting':
      return 'Connecting…'
    case 'in-use':
      return 'In use by another window or app — or missing device permissions (Linux udev)'
    case 'error':
      return 'Connection failed — check the device and try again.'
    default:
      return 'Not connected'
  }
}

export default function StreamDeckSettings({
  settings,
  applyLocalSetting,
}: SettingsSectionProps) {
  const dispatch = useAppDispatch()
  const deck = useAppSelector((s) => s.deck)
  const streamDeck = settings.streamDeck

  // Electron is checked FIRST: in the packaged desktop app navigator.hid
  // exists (so isWebHidSupported() is true) but requestDevice() always
  // resolves [] with no picker — a Connect button there can never work.
  const electron = isElectronClient()
  const connectAvailable = !electron && isWebHidSupported()

  return (
    <SettingsSection id="stream-deck" title="Stream Deck" description="Control freshell with an Elgato Stream Deck.">
      {electron ? (
        <p className="text-sm text-muted-foreground">
          Stream Deck is not supported in the desktop app — use Chrome or Edge.
        </p>
      ) : !connectAvailable ? (
        <p className="text-sm text-muted-foreground">
          Stream Deck requires Chrome or Edge (WebHID). The virtual deck below still works.
        </p>
      ) : null}

      <SettingsRow
        label="Enable Stream Deck"
        description="Connect and drive a Stream Deck from this window."
      >
        <Toggle
          checked={streamDeck.enabled}
          aria-label="Enable Stream Deck"
          onChange={(enabled) => {
            applyLocalSetting({ streamDeck: { enabled } })
          }}
        />
      </SettingsRow>

      {connectAvailable && (
        <SettingsRow label="Connection" description={deckStatusText(deck)}>
          <button
            type="button"
            disabled={!streamDeck.enabled}
            onClick={() => {
              void requestDeckConnect()
            }}
            className="h-10 px-3 text-sm rounded-md border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent md:h-8"
          >
            Connect Stream Deck
          </button>
        </SettingsRow>
      )}

      <SettingsRow
        label="Idle timeout"
        description="Dim the deck after this many seconds without activity. 0 disables idle dimming."
      >
        <SteppedRangeInput
          value={streamDeck.idleTimeoutSeconds}
          values={IDLE_TIMEOUT_VALUES}
          aria-label="Idle timeout"
          unit="s"
          onChange={(idleTimeoutSeconds) => {
            applyLocalSetting({ streamDeck: { idleTimeoutSeconds } })
          }}
        />
      </SettingsRow>

      <SettingsRow label="Active brightness">
        <SteppedRangeInput
          value={streamDeck.brightness}
          values={ACTIVE_BRIGHTNESS_VALUES}
          aria-label="Active brightness"
          unit="%"
          onChange={(brightness) => {
            applyLocalSetting({ streamDeck: { brightness } })
          }}
        />
      </SettingsRow>

      <SettingsRow label="Idle brightness" description="Brightness while idle-dimmed.">
        <SteppedRangeInput
          value={streamDeck.idleBrightness}
          values={IDLE_BRIGHTNESS_VALUES}
          aria-label="Idle brightness"
          unit="%"
          onChange={(idleBrightness) => {
            applyLocalSetting({ streamDeck: { idleBrightness } })
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Show virtual deck"
        description="On-screen deck panel that mirrors the keys — works without hardware."
      >
        <Toggle
          checked={deck.virtualDeckOpen}
          aria-label="Show virtual deck"
          onChange={(open) => {
            dispatch(setVirtualDeckOpen(open))
          }}
        />
      </SettingsRow>
    </SettingsSection>
  )
}
