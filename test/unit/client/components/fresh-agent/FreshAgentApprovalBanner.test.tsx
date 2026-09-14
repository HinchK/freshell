import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { FreshAgentApprovalBanner } from '@/components/fresh-agent/FreshAgentApprovalBanner'

describe('FreshAgentApprovalBanner dismissal', () => {
  afterEach(() => cleanup())

  it('renders the text with no dismiss control when onDismiss is absent', () => {
    render(<FreshAgentApprovalBanner text="Restoring session..." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Restoring session...')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('renders an accessible dismiss button when onDismiss is provided and invokes it on click', () => {
    const onDismiss = vi.fn()
    render(<FreshAgentApprovalBanner text="Agent error: boom" onDismiss={onDismiss} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Agent error: boom')
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toBeInTheDocument()
    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
