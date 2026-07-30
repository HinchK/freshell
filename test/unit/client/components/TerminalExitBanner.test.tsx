import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalExitBanner } from '@/components/TerminalExitBanner'

const noop = () => {}
const baseProps = {
  crashTrace: null,
  onRelaunch: noop,
  onCancelAutoResume: noop,
  onDismissCrashTrace: noop,
}

describe('TerminalExitBanner', () => {
  // This repo's vitest setup does not auto-cleanup between tests (globals off);
  // sibling suites (DeadSessionPanel.test.tsx) call cleanup() explicitly.
  afterEach(() => cleanup())

  it('renders a loud error bar with the exit code and an accessible relaunch button', () => {
    const onRelaunch = vi.fn()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} notice={null} settledDead onRelaunch={onRelaunch} />)
    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited (code 1)')
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    fireEvent.click(btn)
    expect(onRelaunch).toHaveBeenCalledTimes(1)
  })

  it('renders without a code when the exit code is unknown (post-reload)', () => {
    render(<TerminalExitBanner {...baseProps} mode="codex" exitCode={null} notice={null} settledDead />)
    expect(screen.getByRole('alert')).toHaveTextContent('process exited')
    expect(screen.getByRole('alert')).not.toHaveTextContent('(code')
  })

  it('renders a recovering notice with a cancel button instead of the error bar while auto-resume is in flight', () => {
    const onCancel = vi.fn()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} settledDead
      notice={{ kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onCancelAutoResume={onCancel} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resuming, attempt 1/2')
    // znhn item 2: the user can opt out of the in-flight auto-resume.
    const cancel = screen.getByRole('button', { name: 'Cancel auto-resume for claude' })
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders the persistent crash trace (role=status, NOT alert) with a dismiss button', () => {
    // znhn item 1: the trace replaces the ephemeral 'resumed' strip. It must
    // NOT be role=alert — e2e happy paths assert alert count 0.
    const onDismiss = vi.fn()
    // 2026-07-29T03:37:00 local — assert on the derived HH:MM.
    const resumedAtMs = new Date(2026, 6, 29, 9, 5).getTime()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={null} notice={null} settledDead={false}
      crashTrace={{ exitCode: 1, resumedAtMs }}
      onDismissCrashTrace={onDismiss} />)
    expect(screen.queryByRole('alert')).toBeNull()
    const trace = screen.getByTestId('crash-trace')
    expect(trace).toHaveAttribute('role', 'status')
    expect(trace).toHaveTextContent('claude crashed (exit 1) & auto-resumed at 09:05')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude crash notice' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when there is no notice, no settled death, and no trace', () => {
    const { container } = render(
      <TerminalExitBanner {...baseProps} mode="claude" exitCode={null} notice={null} settledDead={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
