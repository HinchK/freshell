import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import { ApiError } from '@/lib/api'

// Only `api.get` needs stubbing here; the real `ApiError` class must survive the
// mock so the component's instanceof classification keeps working.
const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (...args: unknown[]) => apiGet(...args),
    },
  }
})

describe('FreshAgentDiffPanel', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders diff entries', () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff: src/app.tsx' })).toBeInTheDocument()
  })

  it('renders the shared diff view with data-file-path copy target metadata', () => {
    const { container } = render(
      <DiffView oldStr="const value = 1\n" newStr="const value = 2\n" filePath="src/app.tsx" />,
    )

    const diffView = screen.getByRole('figure', { name: 'diff view' })
    expect(diffView).toBeInTheDocument()
    expect(container.querySelector('[data-diff]')).toHaveAttribute('data-file-path', 'src/app.tsx')
    expect(diffView).toHaveTextContent(/const value = 1/)
    expect(diffView).toHaveTextContent(/const value = 2/)
  })

  describe('diff loading', () => {
    const entry = { id: 'd1', path: 'src/a.ts', status: 'modified' as const }

    it('expand → success renders the diff lines', async () => {
      apiGet.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText('+two')
    })

    it('expand → server 500 shows the inline error and a Retry button', async () => {
      apiGet.mockRejectedValue(
        new ApiError(500, 'git diff failed: fatal: not a git repository', { error: 'git diff failed: …' }),
      )
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/git diff failed/)
      const retry = screen.getByRole('button', { name: 'Retry loading diff' })
      apiGet.mockResolvedValue({ diff: 'later' })
      await userEvent.click(retry)
      await screen.findByText('later')
      expect(apiGet).toHaveBeenCalledTimes(2)
    })

    it('expand → 404 shows the unsupported-server copy', async () => {
      apiGet.mockRejectedValue(new ApiError(404, 'Not found', { error: 'Not found' }))
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/not supported by this server/)
    })

    it('missing cwd renders an explicit inline state and never fetches', async () => {
      render(<FreshAgentDiffPanel diffs={[entry]} cwd={undefined} />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/Diff unavailable for this file/)
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('empty diff keeps its copy', async () => {
      apiGet.mockResolvedValue({ diff: '' })
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/No uncommitted changes for this file/)
    })
  })
})
