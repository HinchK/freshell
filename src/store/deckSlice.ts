// Runtime-only Stream Deck connection state — NEVER add to any persistence
// allowlist. Device presence is re-derived from hardware on every page load.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type DeckConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'in-use' | 'error'

export interface DeckSliceState {
  status: DeckConnectionStatus
  model: string | null
  keyCount: number | null
  virtualDeckOpen: boolean
}

const initialState: DeckSliceState = {
  status: 'disconnected',
  model: null,
  keyCount: null,
  virtualDeckOpen: false,
}

const deckSlice = createSlice({
  name: 'deck',
  initialState,
  reducers: {
    setDeckStatus: (
      state,
      action: PayloadAction<{ status: DeckConnectionStatus; model?: string | null; keyCount?: number | null }>,
    ) => {
      state.status = action.payload.status
      state.model = action.payload.model ?? null
      state.keyCount = action.payload.keyCount ?? null
    },
    setVirtualDeckOpen: (state, action: PayloadAction<boolean>) => {
      state.virtualDeckOpen = action.payload
    },
  },
})

export const { setDeckStatus, setVirtualDeckOpen } = deckSlice.actions
export default deckSlice.reducer
