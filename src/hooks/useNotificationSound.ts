import { useCallback, useEffect, useRef } from 'react'
import { useAppSelector } from '@/store/hooks'

const NOTIFICATION_SOUND_SRC = '/your-code-is-ready.mp3'

/**
 * Play the built-in fallback tone (the chime file is unusable — a rejected
 * play() never fires `ended`) and invoke `onDone` when the tone COMPLETES.
 * The OscillatorNode is an AudioScheduledSourceNode and fires `ended` at its
 * stop time — that completion signal drives ring-queue progression, never a
 * fixed timeout. Returns false when no audio machinery exists at all (nothing
 * can ever complete), so the caller advances the queue immediately instead of
 * stalling every later honest ring behind a dead one.
 */
function playFallbackTone(ctxRef: { current: AudioContext | null }, onDone: () => void): boolean {
  try {
    const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextImpl) return false

    if (!ctxRef.current) {
      ctxRef.current = new AudioContextImpl()
    }

    const ctx = ctxRef.current
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.value = 0.05

    oscillator.connect(gain)
    gain.connect(ctx.destination)

    oscillator.addEventListener('ended', onDone, { once: true })
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.12)
    return true
  } catch {
    return false
  }
}

export function useNotificationSound() {
  const soundEnabled = useAppSelector((s) => s.settings.settings.notifications?.soundEnabled ?? true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const queueLengthRef = useRef(0)
  const ringingRef = useRef(false)
  const drainRef = useRef<() => void>(() => {})

  useEffect(() => {
    return () => {
      queueLengthRef.current = 0
      ringingRef.current = false

      const ctx = audioContextRef.current
      audioContextRef.current = null
      if (ctx) {
        void ctx.close().catch(() => {})
      }
    }
  }, [])

  const startRing = useCallback(() => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      ringingRef.current = false
      drainRef.current()
    }
    // Arm the fallback at most once per ring — the chime can fail via the
    // play() rejection AND a media `error` event for the same dead ring.
    let fallbackArmed = false
    const armFallback = () => {
      if (fallbackArmed) return
      fallbackArmed = true
      if (!playFallbackTone(audioContextRef, finish)) finish()
    }

    try {
      // A FRESH Audio instance per ring — restarting one shared element would
      // truncate an in-flight chime.
      const audio = new Audio(NOTIFICATION_SOUND_SRC)
      audio.preload = 'auto'
      audio.volume = 1
      audio.addEventListener('ended', finish, { once: true })
      audio.addEventListener('error', armFallback, { once: true })
      const pending = audio.play()
      if (pending) {
        pending.catch(armFallback)
      }
    } catch {
      armFallback()
    }
  }, [])

  const drain = useCallback(() => {
    if (ringingRef.current) return
    if (queueLengthRef.current <= 0) return
    queueLengthRef.current -= 1
    ringingRef.current = true
    startRing()
  }, [startRing])

  useEffect(() => {
    drainRef.current = drain
  }, [drain])

  const play = useCallback(() => {
    if (typeof window === 'undefined') return
    if (!soundEnabled) return
    // Unbounded queue: every honest event enqueues a ring — dropping bells for
    // large bursts would silence events the user was never told about.
    queueLengthRef.current += 1
    drain()
  }, [soundEnabled, drain])

  return { play }
}
