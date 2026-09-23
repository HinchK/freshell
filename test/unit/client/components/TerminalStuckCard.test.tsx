import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalStuckCard } from '@/components/TerminalStuckCard'

// Presentational mirror of TerminalExitBanner.test.tsx: pure render + click
// propagation — every behavioral gate lives in TerminalView.stuckCard.test.tsx.

describe('TerminalStuckCard', () => {
  // This repo's vitest setup does not auto-cleanup between tests (globals off);
  // sibling suites (TerminalExitBanner.test.tsx) call cleanup() explicitly.
  afterEach(() => cleanup())

  it('renders an amber alert with restart and start-fresh buttons (a11y: role=alert + non-empty accessible names)', () => {
    render(<TerminalStuckCard mode="opencode" onRestart={vi.fn()} onStartFresh={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/appears stuck/i)
    expect(alert).toHaveTextContent('Agent appears stuck — no agent output for a while.')
    // The accessible names come from the aria-labels (a11y contract).
    expect(screen.getByRole('button', { name: 'Restart the opencode agent and resume this conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a fresh conversation' })).toBeInTheDocument()
  })

  it('invokes the callbacks', () => {
    const onRestart = vi.fn()
    const onStartFresh = vi.fn()
    render(<TerminalStuckCard mode="opencode" onRestart={onRestart} onStartFresh={onStartFresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart the opencode agent and resume this conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start a fresh conversation' }))

    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStartFresh).toHaveBeenCalledTimes(1)
  })

  it('names the restart action for the given agent mode', () => {
    render(<TerminalStuckCard mode="claude" onRestart={vi.fn()} onStartFresh={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Restart the claude agent and resume this conversation' })).toBeInTheDocument()
  })
})
