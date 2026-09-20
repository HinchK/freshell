import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'
import type { ReactNode } from 'react'

function createStore(soundEnabled: boolean) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
    },
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          notifications: { soundEnabled },
        },
        loaded: true,
      },
    },
  })
}

function createWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

type FakeAudio = {
  preload: string
  volume: number
  src: string
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  addEventListener: (type: string, cb: () => void) => void
  emit: (type: string) => void
}

describe('useNotificationSound', () => {
  let AudioSpy: ReturnType<typeof vi.fn>
  let audioInstances: FakeAudio[]
  let playImpl: () => Promise<void>

  beforeEach(() => {
    audioInstances = []
    playImpl = () => Promise.resolve()
    AudioSpy = vi.fn(() => {
      const listeners = new Map<string, Array<() => void>>()
      const instance: FakeAudio = {
        preload: '',
        volume: 1,
        src: '',
        play: vi.fn(() => playImpl()),
        pause: vi.fn(),
        addEventListener: (type, cb) => {
          const list = listeners.get(type) ?? []
          list.push(cb)
          listeners.set(type, list)
        },
        emit: (type) => {
          for (const cb of [...(listeners.get(type) ?? [])]) cb()
        },
      }
      audioInstances.push(instance)
      return instance
    })
    vi.stubGlobal('Audio', AudioSpy)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('plays sound when soundEnabled is true', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalledWith('/your-code-is-ready.mp3')
    expect(audioInstances[0].play).toHaveBeenCalled()
  })

  it('does not play sound when soundEnabled is false', () => {
    const store = createStore(false)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).not.toHaveBeenCalled()
    expect(audioInstances).toHaveLength(0)
  })

  it('defaults to enabled when notifications config is missing', () => {
    const store = configureStore({
      reducer: {
        settings: settingsReducer,
      },
      preloadedState: {
        settings: {
          settings: {
            ...defaultSettings,
            // Simulate old config without notifications key
            notifications: undefined as unknown as typeof defaultSettings.notifications,
          },
          loaded: true,
        },
      },
    })

    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalled()
    expect(audioInstances[0].play).toHaveBeenCalled()
  })

  it('queues rings serially: the second ring starts only after the first completes', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })
    act(() => {
      result.current.play()
    })

    // Ring 1 started immediately; ring 2 is queued and has NOT started yet.
    expect(AudioSpy).toHaveBeenCalledTimes(1)
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1)

    // Ring 1 completes (chime `ended`) → ring 2 starts on a FRESH Audio instance.
    act(() => {
      audioInstances[0].emit('ended')
    })

    expect(AudioSpy).toHaveBeenCalledTimes(2)
    expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
  })

  it('never drops rings: a third play while two are queued still yields three sequential rings', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
      result.current.play()
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(1)

    act(() => {
      audioInstances[0].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(2)

    act(() => {
      audioInstances[1].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(3)

    // Queue drained: completing the last ring starts nothing further.
    act(() => {
      audioInstances[2].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(3)

    // Three distinct sequential rings, each played exactly once.
    expect(audioInstances).toHaveLength(3)
    for (const instance of audioInstances) {
      expect(instance.play).toHaveBeenCalledTimes(1)
    }
  })

  it('advances the queue when the chime cannot play: the fallback tone\'s completion starts the next ring', async () => {
    const toneEndedCallbacks: Array<() => void> = []
    class FakeOscillator {
      type = 'sine'
      frequency = { value: 0 }
      connect = vi.fn()
      start = vi.fn()
      stop = vi.fn()
      addEventListener = (type: string, cb: () => void) => {
        if (type === 'ended') toneEndedCallbacks.push(cb)
      }
    }
    class FakeAudioContext {
      currentTime = 0
      destination = {}
      close = vi.fn().mockResolvedValue(undefined)
      createOscillator = () => new FakeOscillator()
      createGain = () => ({ gain: {}, connect: vi.fn() })
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    // The chime file cannot play — a rejected Audio.play() never fires `ended`.
    playImpl = () => Promise.reject(new Error('chime file failed to load'))

    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })
    act(() => {
      result.current.play()
    })

    // Let the rejected play() settle so the fallback tone is armed.
    await act(async () => {
      await Promise.resolve()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(1)
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1)
    expect(toneEndedCallbacks).toHaveLength(1)

    // The fallback tone completes → ring 2 starts. The queue never stalls.
    act(() => {
      for (const cb of [...toneEndedCallbacks]) cb()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(2)
    expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
  })
})
