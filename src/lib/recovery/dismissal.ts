const DISMISSED_KEY = 'freshell.recovery.dismissed.v1'
const PENDING_KEY = 'freshell.recovery.pending.v1'
const CAP = 20

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function isDismissed(contentId: string): boolean {
  return readDismissed().includes(contentId)
}

export function recordDismissal(contentId: string): void {
  const next = [...readDismissed().filter((id) => id !== contentId), contentId].slice(-CAP)
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
}

export interface PendingOffer {
  contentId: string
  bootAt: number
}

export function getPendingOffer(): PendingOffer | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    const p = parsed as { contentId?: unknown; bootAt?: unknown }
    return typeof p?.contentId === 'string' && typeof p?.bootAt === 'number'
      ? { contentId: p.contentId, bootAt: p.bootAt }
      : null
  } catch {
    return null
  }
}

export function setPendingOffer(contentId: string, bootAt: number): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ contentId, bootAt }))
}

export function clearPendingOffer(): void {
  localStorage.removeItem(PENDING_KEY)
}
