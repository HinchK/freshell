import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalExitBanner } from '@/components/TerminalExitBanner'

const noop = () => {}

describe('TerminalExitBanner', () => {
  // This repo's vitest setup does not auto-cleanup between tests (globals off);
  // sibling suites (DeadSessionPanel.test.tsx) call cleanup() explicitly.
  afterEach(() => cleanup())

  it('renders a loud error bar with the exit code and an accessible relaunch button', () => {
    const onRelaunch = vi.fn()
    render(<TerminalExitBanner mode="claude" exitCode={1} notice={null} onRelaunch={onRelaunch} onCancelAutoResume={noop} />)
    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited (code 1)')
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    fireEvent.click(btn)
    expect(onRelaunch).toHaveBeenCalledTimes(1)
  })

  it('renders without a code when the exit code is unknown (post-reload)', () => {
    render(<TerminalExitBanner mode="codex" exitCode={null} notice={null} onRelaunch={noop} onCancelAutoResume={noop} />)
    expect(screen.getByRole('alert')).toHaveTextContent('process exited')
    expect(screen.getByRole('alert')).not.toHaveTextContent('(code')
  })

  it('renders a recovering notice with a cancel button instead of the error bar while auto-resume is in flight', () => {
    const onCancel = vi.fn()
    render(<TerminalExitBanner mode="claude" exitCode={1}
      notice={{ kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onRelaunch={noop} onCancelAutoResume={onCancel} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resuming, attempt 1/2')
    // znhn item 2: the user can opt out of the in-flight auto-resume.
    const cancel = screen.getByRole('button', { name: 'Cancel auto-resume for claude' })
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders a resumed notice', () => {
    render(<TerminalExitBanner mode="claude" exitCode={null}
      notice={{ kind: 'resumed', attempt: 2, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onRelaunch={noop} onCancelAutoResume={noop} />)
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resumed, attempt 2/2')
  })
})
