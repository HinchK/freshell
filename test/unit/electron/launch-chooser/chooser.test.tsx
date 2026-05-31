// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchChooser } from '../../../../electron/launch-chooser/chooser.js'
import type { LaunchServerCandidate } from '../../../../electron/types.js'

function localCandidate(overrides: Partial<LaunchServerCandidate> = {}): LaunchServerCandidate {
  return {
    id: 'local-3001',
    url: 'http://localhost:3001',
    origin: 'port-scan',
    ownership: 'detected-local',
    label: 'localhost:3001',
    requiresAuth: true,
    ...overrides,
  }
}

function installDesktopApi(options: {
  candidates: LaunchServerCandidate[]
  chooseLaunchOption?: ReturnType<typeof vi.fn>
}) {
  const chooseLaunchOption = options.chooseLaunchOption ?? vi.fn().mockResolvedValue(undefined)
  window.freshellDesktop = {
    getLaunchOptions: vi.fn().mockResolvedValue({
      candidates: options.candidates,
      reason: 'manual-choice',
      alwaysAskOnLaunch: false,
      port: 3001,
    }),
    chooseLaunchOption,
  }
  return { chooseLaunchOption }
}

afterEach(() => {
  cleanup()
  delete window.freshellDesktop
})

describe('LaunchChooser', () => {
  it('keeps the chooser open when a detected auth-required server has no token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [localCandidate()],
    })

    render(<LaunchChooser />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to localhost:3001' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Enter a token for localhost:3001')
    expect(chooseLaunchOption).not.toHaveBeenCalled()
  })

  it('connects to a detected auth-required server with the entered token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [localCandidate()],
    })

    render(<LaunchChooser />)

    fireEvent.change(await screen.findByLabelText('Token for localhost:3001'), {
      target: { value: 'typed-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect to localhost:3001' }))

    await waitFor(() => expect(chooseLaunchOption).toHaveBeenCalledWith({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'typed-token',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    }))
  })

  it('keeps the chooser open when a manual remote server has no token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [],
    })

    render(<LaunchChooser />)

    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'http://10.0.0.5:3001' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect remote' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Enter a token for the remote server')
    expect(chooseLaunchOption).not.toHaveBeenCalled()
  })
})
