import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentStatusStrip } from '@/components/fresh-agent/FreshAgentStatusStrip'

const MODEL_LABEL = 'Claude Opus 5 (1M context)'

describe('FreshAgentStatusStrip', () => {
  afterEach(() => cleanup())

  it('renders the model chip with the display label and id+effort tooltip', () => {
    render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="opus[1m] · effort high"
        contextUsage={null}
        onOpenModelDialog={() => {}}
      />,
    )
    const chip = screen.getByRole('button', { name: `Model: ${MODEL_LABEL} — change model` })
    expect(chip).toHaveAttribute('title', 'opus[1m] · effort high')
  })

  it('renders long and short chip labels; the short label defaults to the long label when omitted', () => {
    render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="t"
        contextUsage={null}
        onOpenModelDialog={() => {}}
      />,
    )
    const chip = screen.getByRole('button', { name: `Model: ${MODEL_LABEL} — change model` })
    expect(chip.querySelector('.fresh-agent-status-chip-label-long')).toHaveTextContent(MODEL_LABEL)
    expect(chip.querySelector('.fresh-agent-status-chip-label-short')).toHaveTextContent(MODEL_LABEL)

    cleanup()

    render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelLabelShort="Claude Opus 5"
        modelTooltip="t"
        contextUsage={null}
        onOpenModelDialog={() => {}}
      />,
    )
    const chipWithShort = screen.getByRole('button', { name: `Model: ${MODEL_LABEL} — change model` })
    expect(chipWithShort.querySelector('.fresh-agent-status-chip-label-long')).toHaveTextContent(MODEL_LABEL)
    expect(chipWithShort.querySelector('.fresh-agent-status-chip-label-short')).toHaveTextContent('Claude Opus 5')
  })

  it('clicking the chip opens the model dialog', () => {
    const onOpenModelDialog = vi.fn()
    render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="t"
        contextUsage={null}
        onOpenModelDialog={onOpenModelDialog}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: `Model: ${MODEL_LABEL} — change model` }))
    expect(onOpenModelDialog).toHaveBeenCalledTimes(1)
  })

  it('renders the context meter at 47% with an exact-token tooltip', () => {
    render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="t"
        contextUsage={{ percent: 47, contextTokens: 96000, thresholdTokens: 200000 }}
        onOpenModelDialog={() => {}}
      />,
    )
    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
    expect(meter).toHaveAttribute('aria-valuenow', '47')
    expect(meter).toHaveAttribute('title', '96,000 / 200,000 tokens (47% full) — compacts at 100%')
    expect(meter.querySelector('.fresh-agent-status-meter i')).toHaveStyle({ width: '47%' })
    expect(meter.querySelector('.fresh-agent-status-pct')).toHaveTextContent('47%')
  })

  it('shows muted "context —" with no meter when usage is unknown (never a fake 0%)', () => {
    const { container } = render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="t"
        contextUsage={null}
        onOpenModelDialog={() => {}}
      />,
    )
    expect(screen.queryByRole('meter')).toBeNull()
    const unknown = screen.getByText('context —')
    expect(unknown).toHaveAttribute('title', 'No token data reported yet')
    expect(container.querySelector('.fresh-agent-status-strip')).toHaveAttribute('data-severity', 'unknown')
  })

  it.each([
    [47, 'ok'],
    [69, 'ok'],
    [70, 'warn'],
    [89, 'warn'],
    [90, 'hot'],
    [91, 'hot'],
  ])('applies severity tier %s at %i% (boundaries pinned: 69/70, 89/90)', (percent, tier) => {
    const { container } = render(
      <FreshAgentStatusStrip
        modelLabel={MODEL_LABEL}
        modelTooltip="t"
        contextUsage={{ percent, contextTokens: percent * 2000, thresholdTokens: 200000 }}
        onOpenModelDialog={() => {}}
      />,
    )
    expect(container.querySelector('.fresh-agent-status-strip')).toHaveAttribute('data-severity', tier)
  })
})
