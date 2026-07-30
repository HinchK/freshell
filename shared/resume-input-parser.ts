// Pure, dependency-free parser: extracts candidate session ids and an
// advisory provider hint from arbitrary pasted text. Hints only assist
// the UI — session-store evidence decides the provider.

export type ResumeHintProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'

export type ResumeCandidateKind = 'prefixed-id' | 'uuid' | 'hex-prefix'

export interface ResumeCandidate {
  token: string
  kind: ResumeCandidateKind
}

export interface ResumeHint {
  provider: ResumeHintProvider
  source: 'command' | 'word' | 'id-shape'
}

export interface ResumeInputParse {
  /** Candidate tokens in resolution-priority order. */
  candidates: ResumeCandidate[]
  hint: ResumeHint | null
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[0-9A-Za-z]/g
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
// ses_ + 26 base62 is the first-class shape; the generic form also accepts
// other known xxx_-prefixed id families.
const PREFIXED_ID_RE = /\b[a-z]{2,10}_[0-9A-Za-z]{8,40}\b/g
// >=8 hex chars, <=32; must contain a digit (filters decade/facade/deadbeef).
const HEX_PREFIX_RE = /\b[0-9a-fA-F]{8,32}\b/g

const COMMAND_HINTS: ReadonlyArray<readonly [RegExp, ResumeHintProvider]> = [
  [/\bclaude\s+(?:--resume|-r)\b/i, 'claude'],
  [/\bcodex\s+resume\b/i, 'codex'],
  [/\bopencode\s+--session\b/i, 'opencode'],
  [/\bamplifier\s+(?:--resume|resume)\b/i, 'amplifier'],
]

const WORD_HINTS: ReadonlyArray<readonly [RegExp, ResumeHintProvider]> = [
  [/\bclaude\b/i, 'claude'],
  [/\bcodex\b/i, 'codex'],
  [/\bopencode\b/i, 'opencode'],
  [/\bamplifier\b/i, 'amplifier'],
]

function extractAndMask(text: string, re: RegExp, out: string[]): string {
  return text.replace(re, (match) => {
    out.push(match)
    return ' '.repeat(match.length)
  })
}

function earliestHint(
  text: string,
  table: ReadonlyArray<readonly [RegExp, ResumeHintProvider]>,
): ResumeHintProvider | null {
  let best: ResumeHintProvider | null = null
  let bestIndex = Number.POSITIVE_INFINITY
  for (const [re, provider] of table) {
    const match = re.exec(text)
    if (match && match.index < bestIndex) {
      bestIndex = match.index
      best = provider
    }
  }
  return best
}

function deriveHint(text: string, candidates: ResumeCandidate[]): ResumeHint | null {
  const byCommand = earliestHint(text, COMMAND_HINTS)
  if (byCommand) return { provider: byCommand, source: 'command' }
  const byWord = earliestHint(text, WORD_HINTS)
  if (byWord) return { provider: byWord, source: 'word' }
  const top = candidates[0]
  if (!top) return null
  if (top.kind === 'prefixed-id' && top.token.startsWith('ses_')) {
    return { provider: 'opencode', source: 'id-shape' }
  }
  if (top.kind === 'uuid') {
    const version = top.token.charAt(14)
    if (version === '7') return { provider: 'codex', source: 'id-shape' }
    // Real-store caveat: amplifier TOP-LEVEL session ids are also UUIDv4,
    // so v4 => claude is a heuristic, not an invariant. Acceptable because
    // hints are advisory only — store evidence decides the provider.
    if (version === '4') return { provider: 'claude', source: 'id-shape' }
    return null
  }
  if (top.kind === 'hex-prefix') return { provider: 'amplifier', source: 'id-shape' }
  return null
}

export function parseResumeInput(text: string): ResumeInputParse {
  const sanitized = text.replace(ANSI_ESCAPE_RE, ' ')

  const uuids: string[] = []
  const prefixed: string[] = []
  const rawHex: string[] = []

  // Mask each class as it is extracted so uuid segments never re-match as hex.
  let masked = extractAndMask(sanitized, UUID_RE, uuids)
  masked = extractAndMask(masked, PREFIXED_ID_RE, prefixed)
  extractAndMask(masked, HEX_PREFIX_RE, rawHex)

  const hexTokens = rawHex.filter((token) => /[0-9]/.test(token))
  hexTokens.sort((a, b) => b.length - a.length)

  const seen = new Set<string>()
  const candidates: ResumeCandidate[] = []
  const push = (token: string, kind: ResumeCandidateKind) => {
    const key = kind === 'prefixed-id' ? token : token.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ token, kind })
  }
  for (const token of prefixed) push(token, 'prefixed-id')
  for (const token of uuids) push(token, 'uuid')
  for (const token of hexTokens) push(token, 'hex-prefix')

  return { candidates, hint: deriveHint(sanitized, candidates) }
}
