import { useState } from 'react'
import { cn } from '@/lib/utils'

export interface RepoIconInfo {
  /** Canonical repo identity (repoRoot when known, else the cwd hint). */
  repoKey: string
  /** Display name — basename of the repo root (all worktrees share it). */
  repoName: string
  /** Set when the server reports a detected icon. */
  iconUrl?: string
}

interface RepoIconProps {
  info: RepoIconInfo
  className?: string
}

/** djb2 string hash -> stable hue in [0, 360). */
export function hueFromString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

/**
 * Canonical letter-avatar fill. 60% saturation / 42% lightness keeps white
 * text readable in both themes. Shared with the deck's canvas replica
 * (src/deck/tile-renderer.ts) — change it here and both surfaces follow.
 */
export function repoAvatarColor(hue: number): string {
  return `hsl(${hue}, 60%, 42%)`
}

/** Letter font-size as a fraction of the avatar diameter (SVG: 9 units / 16-unit viewBox). */
export const REPO_AVATAR_FONT_RATIO = 9 / 16

/**
 * Decorative repo identity icon: the repo's own icon via the server when
 * available, else a letter avatar (uppercase first letter on a circle with a
 * deterministic per-repo hue). Rendered ONLY via <img src> for server bytes —
 * remote SVG is never inlined into the DOM.
 */
export default function RepoIcon({ info, className }: RepoIconProps) {
  const [imgFailed, setImgFailed] = useState(false)
  if (info.iconUrl && !imgFailed) {
    return (
      <img
        src={info.iconUrl}
        alt=""
        aria-hidden="true"
        className={cn('shrink-0 rounded-[2px] object-contain', className)}
        onError={() => setImgFailed(true)}
      />
    )
  }
  const letter = (info.repoName.trim()[0] || '?').toUpperCase()
  const hue = hueFromString(info.repoName)
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="8" cy="8" r="8" fill={repoAvatarColor(hue)} />
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={16 * REPO_AVATAR_FONT_RATIO}
        fontWeight="600"
        fill="white"
      >
        {letter}
      </text>
    </svg>
  )
}
