import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'

describe('fresh-agent shared transcript widgets', () => {
  it('renders the moved diff view from the fresh-agent namespace', () => {
    render(<DiffView oldStr={'alpha\nbeta'} newStr={'alpha\ngamma'} filePath="src/example.ts" />)
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
    expect(screen.getByText(/gamma/)).toBeInTheDocument()
  })

  it('renders the moved slot reel from the fresh-agent namespace', () => {
    render(<SlotReel toolName="Bash" previewText="$ npm test" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ npm test')).toBeInTheDocument()
  })

  it('keeps tool previews available without importing agent-chat modules', () => {
    expect(getToolPreview('Read', { file_path: '/tmp/example.txt' })).toBe('/tmp/example.txt')
    expect(getToolPreview('Bash', { command: 'npm test' })).toBe('$ npm test')
  })
})
