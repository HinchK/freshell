import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import RepoIcon, { hueFromString, repoAvatarColor, REPO_AVATAR_FONT_RATIO } from '@/components/icons/RepoIcon'

afterEach(cleanup)

describe('RepoIcon', () => {
  it('renders an <img> when iconUrl is provided', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} className="h-3 w-3" />)
    const img = document.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/repo-icon?cwd=%2Fr')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('alt')).toBe('')
  })

  it('falls back to the letter avatar when the image errors', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} />)
    fireEvent.error(document.querySelector('img')!)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('F')).toBeTruthy()
  })

  it('renders the uppercased first letter when no iconUrl', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell' }} />)
    expect(screen.getByText('F')).toBeTruthy()
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses a deterministic hue per repo name', () => {
    expect(hueFromString('freshell')).toBe(hueFromString('freshell'))
    expect(hueFromString('freshell')).not.toBe(hueFromString('other-repo'))
    const h = hueFromString('anything at all')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('renders ? for an empty repo name', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: '' }} />)
    expect(screen.getByText('?')).toBeTruthy()
  })

  describe('shared avatar constants', () => {
    it('repoAvatarColor formats the canonical 60%/42% HSL fill', () => {
      expect(repoAvatarColor(200)).toBe('hsl(200, 60%, 42%)')
      expect(repoAvatarColor(0)).toBe('hsl(0, 60%, 42%)')
    })

    it('the letter-avatar circle fill and font size use the shared constants', () => {
      render(<RepoIcon info={{ repoKey: '/r/alpha', repoName: 'alpha' }} />)
      const circle = document.querySelector('circle')
      expect(circle?.getAttribute('fill')).toBe(repoAvatarColor(hueFromString('alpha')))
      const text = document.querySelector('text')
      // viewBox is 16 units; fontSize must be 16 * ratio = 9
      expect(text?.getAttribute('font-size')).toBe(String(16 * REPO_AVATAR_FONT_RATIO))
    })
  })
})
