import { useEffect } from 'react'
import { useAppStore } from '@/store/hooks'
import { installStreamDeckManager } from '@/deck/deck-manager'

export function useStreamDeck(): void {
  const store = useAppStore()
  useEffect(() => installStreamDeckManager(store), [store])
}
