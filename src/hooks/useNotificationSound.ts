import { useCallback, useEffect, useRef } from 'react'
import { useAppSelector } from '@/store/hooks'

const NOTIFICATION_SOUND_SRC = '/your-code-is-ready.mp3'

/**
 * Play the built-in fallback tone (the chime file is unusable — a rejected
 * play() never fires `ended`) and invoke `onDone` when the tone COMPLETES.
 * The OscillatorNode is an AudioScheduledSourceNode and fires `ended` at its
 * stop time — that completion signal drives ring-queue progression, never a
 * fixed timeout. Returns false when no completion signal can ever fire right
 * now — no audio machinery exists at all, or the context is (or remains)
 * autoplay-suspended, its clock frozen — so the caller advances the queue
 * immediately instead of stalling every later honest ring behind a dead one.
 */
function playFallbackTone(ctxRef: { current: AudioContext | null }, onDone: () => void): boolean {
  try {
    const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextImpl) return false

    if (!ctxRef.current) {
      ctxRef.current = new AudioContextImpl()
    }

    const ctx = ctxRef.current
    // An autoplay-suspended context (created before user activation) never
    // advances its clock, so a tone's `ended` would NEVER fire and the dead
    // ring would wedge the whole queue. Best-effort resume; if the context
    // is (or remains) suspended, treat this ring as dead — return false so
    // the caller advances the queue exactly like the no-machinery path (a
    // later user-gesture resume lets the NEXT ring's tone play normally).
    if (ctx.state === 'suspended') {
      try {
        void ctx.resume().catch(() => {})
      } catch {
        // best-effort only — a context that cannot resume stays suspended
      }
      if (ctx.state === 'suspended') return false
    }

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
      // A spurious `error` after a successful `ended` must not play an
      // audible stray tone for the already-finished ring.
      if (finished) return
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
