import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { SidebarItem } from '@/components/Sidebar'

function renderSidebarItem(item: any, options?: { remoteStatus?: 'busy' | 'open' }) {
  const store = configureStore({
    reducer: {
      extensions: (state = { entries: [] }) => state,
    },
  })

  const renderResult = render(
    <Provider store={store}>
      <SidebarItem
        item={item}
        isActiveTab={false}
        showProjectBadge={false}
        onClick={() => {}}
        {...(options?.remoteStatus ? { remoteStatus: options.remoteStatus } : {})}
      />
    </Provider>,
  )

  return {
    ...renderResult,
    renderWith: (remoteStatus?: 'busy' | 'open') => renderResult.rerender(
      <Provider store={store}>
        <SidebarItem
          item={item}
          isActiveTab={false}
          showProjectBadge={false}
          onClick={() => {}}
          {...(remoteStatus ? { remoteStatus } : {})}
        />
      </Provider>,
    ),
  }
}

const baseItem = {
  provider: 'claude',
  sessionType: 'claude',
  timestamp: 1_700,
  hasTab: false,
  isRunning: false,
  hasTitle: true,
}

describe('SidebarItem remote status ring', () => {
  it('renders a blue ring for remoteStatus="busy" without changing the grey icon', () => {
    renderSidebarItem(
      {
        ...baseItem,
        id: 'session-claude-remote-busy',
        sessionId: 'remote-busy-1',
        title: 'Remote busy session',
      },
      { remoteStatus: 'busy' },
    )

    const button = screen.getByRole('button', { name: /remote busy session/i })
    expect(button).toHaveAttribute('data-remote-status', 'busy')
    expect(button).toHaveAttribute('data-has-tab', 'false')
    const ring = button.querySelector('span[aria-hidden="true"].rounded-full')
    expect(ring).toHaveClass('border-blue-500')
    expect(ring).not.toHaveClass('border-success')
    expect(button.querySelector('svg')).toHaveClass('text-muted-foreground')
    expect(button.querySelector('.sr-only')).toHaveTextContent('(busy on another device)')
  })

  it('renders a green ring for remoteStatus="open"', () => {
    renderSidebarItem(
      {
        ...baseItem,
        id: 'session-claude-remote-open',
        sessionId: 'remote-open-1',
        title: 'Remote open session',
      },
      { remoteStatus: 'open' },
    )

    const button = screen.getByRole('button', { name: /remote open session/i })
    expect(button).toHaveAttribute('data-remote-status', 'open')
    const ring = button.querySelector('span[aria-hidden="true"].rounded-full')
    expect(ring).toHaveClass('border-success')
    expect(ring).not.toHaveClass('border-blue-500')
    expect(button.querySelector('.sr-only')).toHaveTextContent('(open on another device)')
  })

  it('renders no ring, attribute, or sr-only hint without remoteStatus', () => {
    renderSidebarItem({
      ...baseItem,
      id: 'session-claude-local-only',
      sessionId: 'local-only-1',
      title: 'Local only session',
    })

    const button = screen.getByRole('button', { name: /local only session/i })
    expect(button).not.toHaveAttribute('data-remote-status')
    expect(button.querySelector('span[aria-hidden="true"].rounded-full')).toBeNull()
    expect(button.querySelector('.sr-only')).toBeNull()
  })

  it('adds a non-color tooltip line describing the remote status', () => {
    renderSidebarItem(
      {
        ...baseItem,
        id: 'session-claude-remote-tooltip',
        sessionId: 'remote-tooltip-1',
        title: 'Tooltip session',
      },
      { remoteStatus: 'busy' },
    )

    const button = screen.getByRole('button', { name: /tooltip session/i })
    fireEvent.mouseEnter(button)
    expect(screen.getByText('Busy on another device')).toBeInTheDocument()
  })

  it('re-renders when only remoteStatus changes (memo comparator guard)', () => {
    const item = {
      ...baseItem,
      id: 'session-claude-remote-toggle',
      sessionId: 'remote-toggle-1',
      title: 'Toggle remote session',
    }
    const { renderWith } = renderSidebarItem(item)

    const button = screen.getByRole('button', { name: /toggle remote session/i })
    expect(button).not.toHaveAttribute('data-remote-status')

    renderWith('busy')
    expect(button).toHaveAttribute('data-remote-status', 'busy')
    expect(button.querySelector('span[aria-hidden="true"].rounded-full')).toHaveClass('border-blue-500')

    renderWith('open')
    expect(button).toHaveAttribute('data-remote-status', 'open')
    expect(button.querySelector('span[aria-hidden="true"].rounded-full')).toHaveClass('border-success')

    renderWith(undefined)
    expect(button).not.toHaveAttribute('data-remote-status')
    expect(button.querySelector('span[aria-hidden="true"].rounded-full')).toBeNull()
  })
})
