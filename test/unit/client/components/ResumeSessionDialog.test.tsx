import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

const apiPost = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}))

const resumeSessionInTab = vi.fn(() => ({ deduped: false }))
vi.mock('@/lib/resume-session', () => ({
  resumeSessionInTab: (...args: unknown[]) => resumeSessionInTab(...args),
}))

import { ResumeSessionDialog } from '@/components/ResumeSessionDialog'

const V4 = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const V7 = '019fac27-69d7-78a0-b972-b339d551042e'
const SES = 'ses_root0000000000000000000000'

const match = (overrides: Record<string, unknown> = {}) => ({
  provider: 'codex',
  sessionId: V7,
  cwd: '/repo/alpha',
  sessionType: 'codex',
  matchKind: 'exact',
  ...overrides,
})

const ok = (matches: unknown[], hint: unknown = null) =>
  Promise.resolve({ status: 'ready', matches, hint })

function renderDialog() {
  const store = configureStore({
    reducer: { connection: () => ({ serverInstanceId: 'srv-1' }) },
  })
  const onClose = vi.fn()
  const onNavigate = vi.fn()
  render(
    <Provider store={store}>
      <ResumeSessionDialog open onClose={onClose} onNavigate={onNavigate} />
    </Provider>,
  )
  return { onClose, onNavigate }
}

const typeAndResolve = (text: string) => {
  const input = screen.getByTestId('resume-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('ResumeSessionDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    // No vitest globals in this repo's config, so RTL auto-cleanup is off;
    // unmount the portal explicitly (matches existing component tests).
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('resolves on Enter and resumes a single match with a note', async () => {
    apiPost.mockReturnValue(ok([match()]))
    renderDialog()
    typeAndResolve(`codex resume ${V7}`)
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/sessions/resolve', {
        input: `codex resume ${V7}`,
      }),
    )
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'codex',
      sessionId: V7,
      cwd: '/repo/alpha',
      sessionType: 'codex',
    })
    expect(screen.getByTestId('resume-note').textContent).toContain('codex')
  })

  it('evidence wins over the picker, with a note', async () => {
    apiPost.mockReturnValue(ok([match({ provider: 'opencode', sessionId: SES, sessionType: undefined })]))
    renderDialog()
    fireEvent.change(screen.getByTestId('resume-agent-picker'), { target: { value: 'claude' } })
    typeAndResolve(SES)
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({ provider: 'opencode' })
    expect(screen.getByTestId('resume-note').textContent).toContain('opencode')
  })

  it('shows a disambiguation list and resumes the clicked match', async () => {
    apiPost.mockReturnValue(
      ok([
        match({ sessionId: '417e8345-aaaa-4bbb-8ccc-000000000001', provider: 'amplifier', matchKind: 'prefix', lastActivityAt: 900 }),
        match({ sessionId: '417e8345-bbbb-4ccc-8ddd-000000000002', provider: 'amplifier', matchKind: 'prefix', lastActivityAt: 100 }),
      ]),
    )
    renderDialog()
    typeAndResolve('417e8345')
    const rows = await screen.findAllByTestId('resume-match')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      sessionId: '417e8345-bbbb-4ccc-8ddd-000000000002',
    })
  })

  it('zero matches: inline error, input preserved, resume-anyway uses picker agent', async () => {
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve(V4)
    await screen.findByTestId('resume-error')
    expect((screen.getByTestId('resume-input') as HTMLTextAreaElement).value).toBe(V4)
    // hint pre-filled the picker to claude (v4 shape); user switches to amplifier
    fireEvent.change(screen.getByTestId('resume-agent-picker'), { target: { value: 'amplifier' } })
    expect((screen.getByTestId('resume-anyway-cwd') as HTMLInputElement).value).toBe('~')
    fireEvent.click(screen.getByTestId('resume-anyway-button'))
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'amplifier',
      sessionId: V4,
      sessionType: 'amplifier',
      cwd: undefined, // '~' means server default (home directory)
    })
  })

  it('warming is not "not found": shows retry state and re-resolves', async () => {
    apiPost
      .mockReturnValueOnce(Promise.resolve({ status: 'warming', matches: [], hint: null }))
      .mockReturnValueOnce(ok([match()]))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-warming')
    expect(screen.queryByTestId('resume-error')).toBeNull()
    await vi.advanceTimersByTimeAsync(2100)
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
  })

  it('warming auto-retry is bounded: exhaustion shows "index unavailable" with a working manual Retry', async () => {
    // Readiness can stick false forever (indexer start rejection is only
    // logged) — the dialog must not spin the auto-retry loop indefinitely.
    apiPost.mockReturnValue(Promise.resolve({ status: 'warming', matches: [], hint: null }))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-warming')
    // Burn through the budget: 15 auto-retries, then the terminal state.
    for (let i = 0; i < 16; i += 1) {
      await vi.advanceTimersByTimeAsync(2100)
    }
    await screen.findByTestId('resume-index-unavailable')
    expect(screen.queryByTestId('resume-warming')).toBeNull()
    // The manual Retry still works (it resets the budget) and can succeed.
    apiPost.mockReturnValue(ok([match()]))
    fireEvent.click(screen.getByTestId('resume-index-retry'))
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
  })

  it('garbage input: inline error, no server call, no tab', async () => {
    renderDialog()
    typeAndResolve('hello decade facade!!')
    await screen.findByTestId('resume-error')
    expect(apiPost).not.toHaveBeenCalled()
    expect(resumeSessionInTab).not.toHaveBeenCalled()
  })

  it('pre-fills the agent picker from the hint', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('resume-input'), {
      target: { value: `codex resume ${V7}` },
    })
    expect((screen.getByTestId('resume-agent-picker') as HTMLSelectElement).value).toBe('codex')
  })

  it('closes on Escape', () => {
    const { onClose } = renderDialog()
    fireEvent.keyDown(screen.getByTestId('resume-dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
