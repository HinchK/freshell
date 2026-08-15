import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ConfirmModal } from '@/components/ui/confirm-modal'

describe('ConfirmModal', () => {
  // vitest runs this file with sequence.shuffle=true ("detect order-dependent
  // tests"): each render portals into document.body, so tests must not leak
  // their modal into a sibling test's queries.
  afterEach(() => {
    cleanup()
  })

  it('defaults the confirm button to destructive styling', () => {
    render(
      <ConfirmModal
        open
        title="Delete session"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive')
  })

  it('renders a non-destructive primary button when confirmVariant is default', () => {
    render(
      <ConfirmModal
        open
        title="Administrator approval required"
        body="To complete this, you will need to accept the Windows administrator prompt on the next screen."
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('bg-primary')
  })

  it('announces an operation failure with an alert role when error is provided', () => {
    render(
      <ConfirmModal
        open
        title="Delete session?"
        body="This cannot be undone."
        confirmLabel="Delete"
        error="Failed to delete session: boom"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed to delete session: boom',
    )
  })

  it('renders no alert region when no error is provided', () => {
    render(
      <ConfirmModal
        open
        title="Delete session?"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
