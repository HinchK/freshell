# Resume Session Button Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Add a **Resume** button pinned below the Sidebar's session list — always
visible at every scroll position on Node-served deployments (feature-flag gated:
the Rust server ships the same client without the resolve endpoint, so the button
hides there) — that opens a dialog where the user pastes any session-id-bearing
text; freshell resolves it to a concrete (provider, full session id, cwd,
sessionType) tuple across all four CLI providers and resumes that session in a tab.

**Architecture:** A pure shared parser (`shared/resume-input-parser.ts`) extracts
candidate tokens + an advisory provider hint from arbitrary pasted text. A new
`POST /api/sessions/resolve` endpoint on the **Node server** scans the session-indexer
snapshot across all providers at once (exact + prefix), with exact-id fallbacks
(a new Node claude transcript locator; the existing opencode by-id sqlite query).
The client dialog calls resolve, then reuses the existing tab-resume path
(`findPaneForSession` dedup → `openSessionTab`).

**Tech Stack:** TypeScript strict, Express 4 + zod v4 (server), React + Redux Toolkit +
Tailwind (client), Vitest 3 (+ RTL/jsdom for client, supertest/node for server),
Playwright for browser e2e.

## Global Constraints

- Providers are exactly `DEFAULT_ENABLED_CLI_PROVIDERS = ['claude', 'codex', 'opencode', 'amplifier']` from `shared/coding-cli-defaults.ts`.
- Target backend is the **Node server** (`server/index.ts`) — confirmed: `npm run dev` runs `tsx watch server/index.ts` and `npm start` runs `dist/server/index.js`. The "server/ is FROZEN" comments found in some e2e files (e.g. `test/e2e-browser/playwright.config.ts:212`, `test/e2e-browser/specs/sidebar-click-resume.spec.ts:31`) are **stale**: that freeze was branch-scoped parity discipline for the `feat/rust-tauri-port` branch, which merged into main on 2026-07-27; `server/` is actively developed and is the shipping backend. Rust-server parity is **out of scope** — record `POST /api/sessions/resolve` **and the new `sessionResolve` feature flag** as a Rust-parity follow-up item (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` — this edit is performed in Task 6 Step 5); the parity implementation itself stays out of scope.
- The Resume button is **feature-flag gated**: the Node server declares `sessionResolve: true` in `detectFeatureFlags()` (`server/platform-router.ts:20-25`, Task 3), served in `/api/platform` (`server/platform-router.ts:37-38`) and `/api/bootstrap` (`server/index.ts:223`); the client stores it via `setFeatureFlags` into `connection.featureFlags` (`src/App.tsx:601-602`, `src/store/connectionSlice.ts:16,68-69`) and the Sidebar renders the Resume footer only when the flag is true (Task 5; selector precedent `src/components/panes/PanePicker.tsx:105`). The Rust server serves the **same** `dist/client` bundle and 404s cleanly on unmatched `/api/*`; its `/api/platform` featureFlags parity (`crates/freshell-server/src/boot.rs:12,58,167`) intentionally does NOT declare the flag, so the button stays hidden on Rust/Tauri deployments **by design**. Both sides type featureFlags as `Record<string, boolean>`, so the new key forces no type changes.
- **Accepted limitation (per spec):** prefix matching only matches **indexed** sessions. Exact-id misses additionally consult the claude transcript locator and the opencode by-id query. "Provider unavailable" is approximated by the single global index-readiness flag (`startup-state.ts` task `codingCliIndexer`) — the Node server has no per-provider readiness. A **time-extension** of the same limitation (real-store verified): the snapshot stays partial until the first FULL scan completes even after the readiness flag flips (codex worst-case ~4% coverage right after cold start); the exact-id fallbacks still cover claude (locator) and opencode (by-id query) in that window.
- Real-store note: ~20% of indexed cwds no longer exist on disk. Terminal create already handles a missing cwd by defaulting (`server/terminal-registry.ts:1575` — homedir on Linux); a cwd-existence policy is deliberately out of scope for this plan.
- Hex-prefix token rule: **≥8 hex chars containing at least one digit, ≤32 chars** (rejects `decade`, `facade`, `deadbeef`).
- Disambiguation list is capped at **20**, sorted most-recent first by `lastActivityAt` desc.
- Evidence (store scan) decides the provider; hints (agent words, command shapes, id-shape heuristics) are advisory only — they pre-fill the picker and set the "resume anyway" default.
- A tab is only created once a concrete (provider, full id, cwd, sessionType) tuple is in hand — except the explicit "resume anyway" path.
- Conventional Commits with scope (`feat(shared):`, `test(server):`…). Red-Green TDD per step.
- Server/shared code is NodeNext ESM: **relative imports need `.js` suffix**. Client code uses `@/`, `@shared/`, `@test/` aliases.
- Never run raw `npx vitest`; use `npm run test:vitest -- --config <config> <file> --run`. Before any broad run, check the coordinator: `npm run test:status`.
- New markdown docs: none beyond this plan (working/agent doc). Update `docs/index.html` for this user-facing UI change (AGENTS.md rule) — folded into Task 6.
- Data-testids are kebab-case; dialogs are hand-rolled `createPortal` modals following `src/components/ui/confirm-modal.tsx` (role="dialog", aria-modal, Escape closes, `OVERLAY_Z.modal` from `src/components/ui/overlay.ts`).

## Scope Check

Single plan: one feature with three thin layers (shared parser, one endpoint, one
dialog + one footer) that only make sense together and ship as one working unit.
Each task below is still independently testable.

## File Structure

| File | Responsibility |
|---|---|
| `shared/resume-input-parser.ts` (create) | Pure token extraction + advisory hint from pasted text |
| `shared/resume-resolve-contract.ts` (create) | zod request/response schemas + TS types for the resolve API |
| `server/coding-cli/claude-transcript-locator.ts` (create) | Exact-id claude `.jsonl` locator (fallback for index misses) |
| `server/coding-cli/resolve-session.ts` (create) | Resolve engine: index scan (exact+prefix) + fallbacks; pure w.r.t. injected deps |
| `server/sessions-router.ts` (modify) | Add `POST /sessions/resolve` route + widen `SessionsRouterDeps` |
| `server/index.ts` (modify) | Wire readiness + fallback deps into `createSessionsRouter` (~line 748) |
| `server/platform-router.ts` (modify) | Declare the `sessionResolve` feature flag in `detectFeatureFlags()` (client gate for the Resume button) |
| `server/coding-cli/providers/opencode.ts` (modify) | By-id fallback query also selects `directory`; `OpencodeRootResolution` gains `directoriesBySessionId` |
| `src/lib/resume-session.ts` (create) | Client resume helper: `findPaneForSession` dedup → focus, else `openSessionTab` |
| `src/components/ResumeSessionDialog.tsx` (create) | The Resume dialog (paste field, picker, all outcome states) |
| `src/components/Sidebar.tsx` (modify) | Pinned footer with the Resume button (gated on the `sessionResolve` feature flag; sibling AFTER the list wrapper) |
| `test/unit/shared/resume-input-parser.test.ts` (create) | Table-driven parser tests |
| `test/integration/server/claude-transcript-locator.test.ts` (create) | Locator tests against tmpdir fixtures |
| `test/integration/server/sessions-resolve-router.test.ts` (create) | supertest endpoint tests (exact/prefix/ambiguous/missing/warming/fallbacks) |
| `test/unit/client/lib/resume-session.test.ts` (create) | Dedup-vs-open helper tests |
| `test/unit/client/components/ResumeSessionDialog.test.tsx` (create) | Dialog flow tests (RTL) |
| `test/unit/client/components/Sidebar.resume-footer.test.tsx` (create) | Pinned placement + fullWidth tests |
| `test/e2e-browser/specs/resume-button.spec.ts` (create) | Playwright: pinned at all scroll positions; paste→Enter resumes |
| `docs/index.html` (modify) | Mention the Resume button (user-facing feature doc) |

## Spec → test traceability (acceptance examples)

| Pasted input | Covered by |
|---|---|
| `417e8345` → amplifier prefix match | Task 1 parser test; Task 3 router "prefix match" test |
| `codex resume 019fac27-…` → codex | Task 1 hint test; Task 3 exact test; Task 4 dialog test 1 |
| bare v4 UUID → resolve finds claude | Task 3 "exact uuid, no hint"; Task 4 dialog test 1 |
| `opencode --session ses_…` → opencode | Task 1 parser test; Task 3 exact test |
| bare `ses_…`, picker=claude → opencode + note | Task 4 dialog test 2 (evidence wins, note shown) |
| `"claude --resume ed2afda6-…"`, picker=codex → claude + note | Task 1 noise-stripping test; Task 4 dialog test 2 |
| prefix matching multiple → capped list, recent first | Task 3 ambiguous + cap tests; Task 4 dialog test 3 |
| valid id, index warming → loading/retry, NOT "not found" | Task 3 warming test; Task 4 dialog test 5 |
| garbage → inline error, no tab | Task 1 parser test; Task 4 dialog garbage-input test |
| session already open in pane → focus, no duplicate | Task 5 helper test (Task 4's `resume-session.test.ts`) |
| Rust/Tauri deployment (no `sessionResolve` flag) → button hidden | Task 5 "no flag" footer test |
| index start failed → bounded warming retries, then manual retry | Task 4 dialog retry-exhaustion test |

---

### Task 1: Shared resume-input parser

**Files:**
- Create: `shared/resume-input-parser.ts`
- Test: `test/unit/shared/resume-input-parser.test.ts`

**Interfaces:**
- Consumes: nothing (pure, dependency-free).
- Produces (used by Tasks 3 and 4):
  - `parseResumeInput(text: string): ResumeInputParse`
  - `interface ResumeInputParse { candidates: ResumeCandidate[]; hint: ResumeHint | null }`
  - `interface ResumeCandidate { token: string; kind: 'prefixed-id' | 'uuid' | 'hex-prefix' }`
  - `interface ResumeHint { provider: 'claude' | 'codex' | 'opencode' | 'amplifier'; source: 'command' | 'word' | 'id-shape' }`
  - `candidates` are in resolution-priority order: prefixed ids, then full UUIDs (each in order of appearance), then hex prefixes longest-first, deduped.

- [ ] **Step 1: Write the failing test**

Mirror the import style of `test/unit/shared/path-basename.test.ts` (this suite runs
under the client vitest config, which has the `@shared/` alias). Create
`test/unit/shared/resume-input-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseResumeInput } from '@shared/resume-input-parser'

const V4 = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const V7 = '019fac27-69d7-78a0-b972-b339d551042e'
const SES = 'ses_root0000000000000000000000'

describe('parseResumeInput — candidate extraction', () => {
  it.each([
    ['bare short hex', '417e8345', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['bare v4 uuid', V4, [{ token: V4, kind: 'uuid' }]],
    ['bare opencode id', SES, [{ token: SES, kind: 'prefixed-id' }]],
    ['codex resume command', `codex resume ${V7}`, [{ token: V7, kind: 'uuid' }]],
    ['claude --resume command', `claude --resume ${V4}`, [{ token: V4, kind: 'uuid' }]],
    ['claude -r command', `$ claude -r ${V4}`, [{ token: V4, kind: 'uuid' }]],
    ['opencode --session command', `opencode --session ${SES}`, [{ token: SES, kind: 'prefixed-id' }]],
    ['amplifier --resume short id', 'amplifier --resume 417e8345', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['quoted + padded', `  "claude --resume ${V4}"  `, [{ token: V4, kind: 'uuid' }]],
    ['backticks', '`417e8345`', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['id embedded in a path', `/home/x/.claude/projects/foo/${V4}.jsonl`, [{ token: V4, kind: 'uuid' }]],
    ['trailing punctuation', 'session 417e8345.', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['ansi codes', `\u001b[32m417e8345\u001b[0m`, [{ token: '417e8345', kind: 'hex-prefix' }]],
    [
      'multi-line noise',
      `To continue:\n$ codex resume ${V7}\nor open the app`,
      [{ token: V7, kind: 'uuid' }],
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(parseResumeInput(input).candidates).toEqual(expected)
  })

  it.each([
    ['english hex-looking word', 'decade'],
    ['facade sentence', 'I spent a decade behind a facade'],
    ['hex without digits', 'deadbeef'],
    ['garbage', 'hello world!! no ids here'],
    ['empty', ''],
  ] as const)('extracts nothing from %s', (_label, input) => {
    expect(parseResumeInput(input).candidates).toEqual([])
  })

  it('orders prefixed ids, then uuids, then hex prefixes longest-first', () => {
    const { candidates } = parseResumeInput(`417e8345 ${V4} ${SES} 417e8345abcd`)
    expect(candidates.map((c) => c.token)).toEqual([SES, V4, '417e8345abcd', '417e8345'])
  })

  it('dedupes repeated tokens case-insensitively', () => {
    const { candidates } = parseResumeInput(`${V4} ${V4.toUpperCase()}`)
    expect(candidates).toHaveLength(1)
  })

  it('does not extract hex segments out of a uuid', () => {
    const { candidates } = parseResumeInput(V4)
    expect(candidates).toEqual([{ token: V4, kind: 'uuid' }])
  })

  it('caps hex tokens at 32 chars (git shas do not match)', () => {
    expect(parseResumeInput('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2').candidates).toEqual([])
  })
})

describe('parseResumeInput — advisory hint', () => {
  it.each([
    ['codex command', `codex resume ${V7}`, { provider: 'codex', source: 'command' }],
    ['claude --resume', `claude --resume ${V4}`, { provider: 'claude', source: 'command' }],
    ['claude -r', `claude -r ${V4}`, { provider: 'claude', source: 'command' }],
    ['opencode --session', `opencode --session ${SES}`, { provider: 'opencode', source: 'command' }],
    ['amplifier --resume', 'amplifier --resume 417e8345', { provider: 'amplifier', source: 'command' }],
    ['agent word only', `the claude session ${V4}`, { provider: 'claude', source: 'word' }],
    ['ses_ id shape', SES, { provider: 'opencode', source: 'id-shape' }],
    ['uuid v7 shape', V7, { provider: 'codex', source: 'id-shape' }],
    ['uuid v4 shape', V4, { provider: 'claude', source: 'id-shape' }],
    ['short hex shape', '417e8345', { provider: 'amplifier', source: 'id-shape' }],
  ] as const)('%s', (_label, input, expected) => {
    expect(parseResumeInput(input).hint).toEqual(expected)
  })

  it('returns null hint for garbage', () => {
    expect(parseResumeInput('nothing to see').hint).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run`
Expected: FAIL — cannot resolve `@shared/resume-input-parser`.

- [ ] **Step 3: Write the implementation**

Create `shared/resume-input-parser.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run`
Expected: PASS (all tables green).

- [ ] **Step 5: Commit**

```bash
git add shared/resume-input-parser.ts test/unit/shared/resume-input-parser.test.ts
git commit -m "feat(shared): resume-input parser extracting session-id candidates and provider hints"
```

---

### Task 2: Node claude transcript exact-id locator

**Files:**
- Create: `server/coding-cli/claude-transcript-locator.ts`
- Test: `test/integration/server/claude-transcript-locator.test.ts`

**Interfaces:**
- Consumes: `node:fs/promises`, `node:path` only.
- Produces (used by Task 3):
  - `locateClaudeTranscript(sessionId: string, projectsDir: string): Promise<ClaudeTranscriptHit | null>`
  - `interface ClaudeTranscriptHit { sessionId: string; sourceFile: string; cwd?: string }`
  - Returns `null` for non-UUID input, missing dir, or no `<projectsDir>/*/<id>.jsonl` file. `cwd` comes from the first JSONL line containing a string `cwd` field.

Rationale: the spec's "claude transcript locator" exact-id fallback exists only in the
Rust server; the Node server needs its own minimal equivalent for index misses
(cold-start skips cwd-less files, so the index alone yields false negatives).

- [ ] **Step 1: Write the failing test**

Create `test/integration/server/claude-transcript-locator.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { locateClaudeTranscript } from '../../../server/coding-cli/claude-transcript-locator.js'

const SESSION_ID = 'ed2afda6-a340-443e-ba60-024a1b3554b4'

describe('locateClaudeTranscript', () => {
  let projectsDir: string

  beforeEach(async () => {
    projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-projects-'))
  })

  afterEach(async () => {
    await fsp.rm(projectsDir, { recursive: true, force: true })
  })

  async function writeTranscript(dirName: string, id: string, lines: string[]) {
    const dir = path.join(projectsDir, dirName)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${id}.jsonl`)
    await fsp.writeFile(file, lines.join('\n'), 'utf8')
    return file
  }

  it('finds a transcript by exact id and reads cwd from the first entry', async () => {
    const file = await writeTranscript('-repo-alpha', SESSION_ID, [
      JSON.stringify({ type: 'summary', summary: 'hello' }),
      JSON.stringify({ type: 'user', cwd: '/repo/alpha', message: 'hi' }),
    ])
    await expect(locateClaudeTranscript(SESSION_ID, projectsDir)).resolves.toEqual({
      sessionId: SESSION_ID,
      sourceFile: file,
      cwd: '/repo/alpha',
    })
  })

  it('matches case-insensitively and returns the normalized id', async () => {
    await writeTranscript('-repo-alpha', SESSION_ID, [JSON.stringify({ cwd: '/repo/alpha' })])
    const hit = await locateClaudeTranscript(SESSION_ID.toUpperCase(), projectsDir)
    expect(hit?.sessionId).toBe(SESSION_ID)
  })

  it('returns undefined cwd when no entry carries one', async () => {
    await writeTranscript('-repo-beta', SESSION_ID, [JSON.stringify({ type: 'summary' })])
    const hit = await locateClaudeTranscript(SESSION_ID, projectsDir)
    expect(hit).not.toBeNull()
    expect(hit?.cwd).toBeUndefined()
  })

  it('returns null for an unknown id', async () => {
    await expect(
      locateClaudeTranscript('019fac27-69d7-78a0-b972-b339d551042e', projectsDir),
    ).resolves.toBeNull()
  })

  it('returns null for non-uuid input without touching the fs', async () => {
    await expect(locateClaudeTranscript('417e8345', projectsDir)).resolves.toBeNull()
  })

  it('returns null when the projects dir does not exist', async () => {
    await expect(
      locateClaudeTranscript(SESSION_ID, path.join(projectsDir, 'missing')),
    ).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/claude-transcript-locator.test.ts --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `server/coding-cli/claude-transcript-locator.ts`:

```ts
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface ClaudeTranscriptHit {
  sessionId: string
  sourceFile: string
  cwd?: string
}

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Exact-id fallback for claude sessions the index cannot see (e.g. cold-start
 * skipped cwd-less transcripts). Scans <projectsDir>/<project>/<id>.jsonl.
 */
export async function locateClaudeTranscript(
  sessionId: string,
  projectsDir: string,
): Promise<ClaudeTranscriptHit | null> {
  const normalized = sessionId.toLowerCase()
  if (!UUID_ONLY_RE.test(normalized)) return null

  let entries: string[]
  try {
    entries = await fsp.readdir(projectsDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, `${normalized}.jsonl`)
    try {
      const stat = await fsp.stat(candidate)
      if (!stat.isFile()) continue
    } catch {
      continue
    }
    return {
      sessionId: normalized,
      sourceFile: candidate,
      cwd: await readCwdFromTranscript(candidate),
    }
  }
  return null
}

async function readCwdFromTranscript(filePath: string): Promise<string | undefined> {
  let head: string
  try {
    const handle = await fsp.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { cwd?: unknown }
      if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) return parsed.cwd
    } catch {
      continue // truncated tail line etc.
    }
  }
  return undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/claude-transcript-locator.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/claude-transcript-locator.ts test/integration/server/claude-transcript-locator.test.ts
git commit -m "feat(server): claude transcript exact-id locator for index misses"
```

---

### Task 3: `POST /api/sessions/resolve` endpoint

**Files:**
- Create: `shared/resume-resolve-contract.ts`
- Create: `server/coding-cli/resolve-session.ts`
- Modify: `server/sessions-router.ts` (deps interface ~lines 39–58; new route after the existing `/sessions/*` routes ~line 223)
- Modify: `server/index.ts` (the `createSessionsRouter({...})` call at ~line 748; startupState lives at ~line 188, the provider array near ~line 236)
- Modify: `server/coding-cli/providers/opencode.ts` (the by-id query at ~line 255 also selects `directory`; `OpencodeRootResolution` at lines 32–35 gains `directoriesBySessionId`)
- Modify: `server/platform-router.ts` (declare the `sessionResolve` feature flag in `detectFeatureFlags()`, lines 20–25 — the client gate Task 5 consumes)
- Test: `test/integration/server/sessions-resolve-router.test.ts`

**Interfaces:**
- Consumes: `parseResumeInput` (Task 1), `locateClaudeTranscript` (Task 2),
  `CodingCliSession`/`ProjectGroup` from `server/coding-cli/types.ts` (fields:
  `sessionId`, `provider`, `projectPath`, `cwd?`, `title?`, `sessionType?`,
  `firstUserMessage?`, `lastActivityAt: number`),
  `OpencodeProvider.resolveOpencodeSessionRoots(sessionIds: readonly string[]): Promise<OpencodeRootResolution>`
  (`server/coding-cli/providers/opencode.ts:199`; `OpencodeRootResolution` at `:32-35` is
  `{ rootsBySessionId: Map<string, string>; unresolvedSessionIds: Set<string> }` — this task
  extends it with `directoriesBySessionId?: Map<string, string>` so the fallback can return
  the session's cwd),
  `startupState.snapshot(): { ready: boolean; tasks: Record<string, boolean> }`
  (`server/startup-state.ts`), `getClaudeProjectsDir()` (`server/claude-home.ts`).
- Produces (used by Task 4):
  - HTTP `POST /api/sessions/resolve` with body `{ input: string }`.
  - `ResumeResolveRequestSchema`, `ResumeResolveResponseSchema`, `ResumeResolveMatchSchema` and inferred types `ResumeResolveRequest`, `ResumeResolveResponse`, `ResumeResolveMatch` from `shared/resume-resolve-contract.ts`.
  - Response: `{ status: 'ready' | 'warming', matches: ResumeResolveMatch[], hint: { provider, source } | null }` where a match is `{ provider, sessionId, cwd?, sessionType?, title?, firstUserMessage?, lastActivityAt?, matchKind: 'exact' | 'prefix' }`, capped at 20, sorted `lastActivityAt` desc.
  - `resolveResumeInput(input, deps)` and `RESOLVE_MATCH_CAP = 20` from `server/coding-cli/resolve-session.ts`.
  - `sessionResolve: true` in `detectFeatureFlags()` (`server/platform-router.ts:20-25`) — reaches the client via `/api/bootstrap`/`/api/platform` and gates Task 5's Resume footer.

- [ ] **Step 1: Write the shared contract**

Create `shared/resume-resolve-contract.ts` (zod v4 is already a dependency; see
`shared/read-models.ts` for precedent):

```ts
import { z } from 'zod'

export const ResumeResolveRequestSchema = z
  .object({
    input: z.string().min(1).max(20000),
  })
  .strict()

export const ResumeResolveMatchSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().optional(),
  sessionType: z.string().optional(),
  title: z.string().optional(),
  firstUserMessage: z.string().optional(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  matchKind: z.enum(['exact', 'prefix']),
})

export const ResumeResolveHintSchema = z.object({
  provider: z.string().min(1),
  source: z.enum(['command', 'word', 'id-shape']),
})

export const ResumeResolveResponseSchema = z.object({
  status: z.enum(['ready', 'warming']),
  matches: z.array(ResumeResolveMatchSchema),
  hint: ResumeResolveHintSchema.nullable(),
})

export type ResumeResolveRequest = z.infer<typeof ResumeResolveRequestSchema>
export type ResumeResolveMatch = z.infer<typeof ResumeResolveMatchSchema>
export type ResumeResolveResponse = z.infer<typeof ResumeResolveResponseSchema>
```

- [ ] **Step 2: Write the failing endpoint test**

Create `test/integration/server/sessions-resolve-router.test.ts`, modeled on
`test/integration/server/session-directory-router.test.ts` (real router + supertest +
literal `ProjectGroup[]` fake indexer — the house fixture pattern):

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

const CLAUDE_ID = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const CODEX_ID = '019fac27-69d7-78a0-b972-b339d551042e'
const OPENCODE_ID = 'ses_root0000000000000000000000'
const AMP_ID_NEW = '417e8345-aaaa-4bbb-8ccc-000000000001'
const AMP_ID_OLD = '417e8345-bbbb-4ccc-8ddd-000000000002'

function fixtureProjects(): ProjectGroup[] {
  return [
    {
      projectPath: '/repo/alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: CLAUDE_ID,
          projectPath: '/repo/alpha',
          cwd: '/repo/alpha',
          title: 'Fix the parser',
          firstUserMessage: 'fix the parser',
          lastActivityAt: 400,
        },
        {
          provider: 'codex',
          sessionId: CODEX_ID,
          projectPath: '/repo/alpha',
          cwd: '/repo/alpha',
          sessionType: 'codex',
          lastActivityAt: 300,
        },
      ],
    },
    {
      projectPath: '/repo/beta',
      sessions: [
        {
          provider: 'opencode',
          sessionId: OPENCODE_ID,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 200,
        },
        {
          provider: 'amplifier',
          sessionId: AMP_ID_NEW,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 900,
        },
        {
          provider: 'amplifier',
          sessionId: AMP_ID_OLD,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 100,
        },
      ],
    },
  ]
}

interface HarnessOptions {
  projects?: ProjectGroup[]
  ready?: boolean
  resolveOpencodeSessionIds?: (
    ids: readonly string[],
  ) => Promise<{
    rootsBySessionId: Map<string, string>
    directoriesBySessionId?: Map<string, string>
    unresolvedSessionIds: Set<string>
  }>
  locateClaudeTranscript?: (
    id: string,
  ) => Promise<{ sessionId: string; sourceFile: string; cwd?: string } | null>
}

function buildApp(options: HarnessOptions = {}): Express {
  const app = express()
  app.use(express.json())
  app.use(
    '/api',
    createSessionsRouter({
      configStore: {
        getSettings: vi.fn().mockResolvedValue({}),
        patchSessionOverride: vi.fn(),
        deleteSession: vi.fn(),
      },
      codingCliIndexer: {
        getProjects: () => options.projects ?? fixtureProjects(),
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: { list: () => [] },
      getIndexReadiness: () => options.ready ?? true,
      resolveOpencodeSessionIds: options.resolveOpencodeSessionIds,
      locateClaudeTranscript: options.locateClaudeTranscript,
    }),
  )
  return app
}

const post = (app: Express, body: unknown) =>
  request(app).post('/api/sessions/resolve').send(body as object)

describe('POST /api/sessions/resolve', () => {
  let app: Express
  beforeEach(() => {
    app = buildApp()
  })

  it.each([
    ['claude exact uuid', CLAUDE_ID, 'claude', CLAUDE_ID],
    ['codex exact via command line', `codex resume ${CODEX_ID}`, 'codex', CODEX_ID],
    ['opencode exact via command line', `opencode --session ${OPENCODE_ID}`, 'opencode', OPENCODE_ID],
  ] as const)('%s resolves to a single exact match', async (_label, input, provider, id) => {
    const res = await post(app, { input })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ready')
    expect(res.body.matches).toHaveLength(1)
    expect(res.body.matches[0]).toMatchObject({ provider, sessionId: id, matchKind: 'exact' })
  })

  it('returns full resume metadata on matches', async () => {
    const res = await post(app, { input: CLAUDE_ID })
    expect(res.body.matches[0]).toMatchObject({
      provider: 'claude',
      sessionId: CLAUDE_ID,
      cwd: '/repo/alpha',
      title: 'Fix the parser',
      firstUserMessage: 'fix the parser',
      lastActivityAt: 400,
    })
  })

  it('prefix-matches short hex across providers, most-recent first', async () => {
    const res = await post(app, { input: '417e8345' })
    expect(res.body.status).toBe('ready')
    expect(res.body.matches.map((m: { sessionId: string }) => m.sessionId)).toEqual([
      AMP_ID_NEW,
      AMP_ID_OLD,
    ])
    expect(res.body.matches[0].matchKind).toBe('prefix')
    expect(res.body.matches[0].provider).toBe('amplifier')
  })

  it('caps ambiguous prefix matches at 20', async () => {
    const many: ProjectGroup[] = [
      {
        projectPath: '/repo/many',
        sessions: Array.from({ length: 25 }, (_, i) => ({
          provider: 'amplifier',
          sessionId: `417e8345-0000-4000-8000-${String(i).padStart(12, '0')}`,
          projectPath: '/repo/many',
          lastActivityAt: i,
        })),
      },
    ]
    const res = await post(buildApp({ projects: many }), { input: '417e8345' })
    expect(res.body.matches).toHaveLength(20)
    expect(res.body.matches[0].lastActivityAt).toBe(24) // most recent first
  })

  it('dedupes duplicate (provider, sessionId) snapshot entries, keeping the most recent', async () => {
    // Real-store finding: the same claude sessionId can appear on MULTIPLE
    // snapshot entries (same id, different transcript files).
    const dup: ProjectGroup[] = [
      {
        projectPath: '/repo/alpha',
        sessions: [
          {
            provider: 'claude',
            sessionId: CLAUDE_ID,
            projectPath: '/repo/alpha',
            cwd: '/repo/alpha',
            title: 'older file',
            lastActivityAt: 100,
          },
          {
            provider: 'claude',
            sessionId: CLAUDE_ID,
            projectPath: '/repo/alpha',
            cwd: '/repo/alpha',
            title: 'newer file',
            lastActivityAt: 500,
          },
        ],
      },
    ]
    const res = await post(buildApp({ projects: dup }), { input: CLAUDE_ID })
    expect(res.body.matches).toHaveLength(1)
    expect(res.body.matches[0]).toMatchObject({ title: 'newer file', lastActivityAt: 500 })
  })

  it('reports hint alongside evidence', async () => {
    const res = await post(app, { input: `codex resume ${CODEX_ID}` })
    expect(res.body.hint).toEqual({ provider: 'codex', source: 'command' })
  })

  it('returns ready + empty matches for an unknown id', async () => {
    const res = await post(app, { input: '019fffff-ffff-7fff-bfff-ffffffffffff' })
    expect(res.body).toMatchObject({ status: 'ready', matches: [] })
  })

  it('returns warming (not "not found") while the index is not ready', async () => {
    const res = await post(buildApp({ ready: false }), { input: CLAUDE_ID })
    expect(res.body).toMatchObject({ status: 'warming', matches: [] })
  })

  it('falls back to the opencode by-id query on exact-id index miss (with the row directory as cwd)', async () => {
    const unknown = 'ses_child000000000000000000000'
    const res = await post(
      buildApp({
        resolveOpencodeSessionIds: vi.fn().mockResolvedValue({
          rootsBySessionId: new Map([[unknown, OPENCODE_ID]]),
          directoriesBySessionId: new Map([[unknown, '/repo/beta']]),
          unresolvedSessionIds: new Set<string>(),
        }),
      }),
      { input: unknown },
    )
    expect(res.body.matches).toEqual([
      {
        provider: 'opencode',
        sessionId: unknown,
        cwd: '/repo/beta',
        sessionType: 'opencode',
        matchKind: 'exact',
      },
    ])
  })

  it('falls back to the claude transcript locator on exact-id index miss', async () => {
    const unknown = 'aaaaaaaa-1111-4222-8333-444444444444'
    const res = await post(
      buildApp({
        locateClaudeTranscript: vi.fn().mockResolvedValue({
          sessionId: unknown,
          sourceFile: `/home/u/.claude/projects/x/${unknown}.jsonl`,
          cwd: '/repo/gamma',
        }),
      }),
      { input: unknown },
    )
    expect(res.body.matches).toEqual([
      {
        provider: 'claude',
        sessionId: unknown,
        cwd: '/repo/gamma',
        sessionType: 'claude',
        matchKind: 'exact',
      },
    ])
  })

  it('returns ready + empty matches for garbage input with no id-like token', async () => {
    const res = await post(app, { input: 'hello decade facade!!' })
    expect(res.body).toMatchObject({ status: 'ready', matches: [], hint: null })
  })

  it('rejects an invalid body with 400', async () => {
    const res = await post(app, { nope: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/sessions-resolve-router.test.ts --run`
Expected: FAIL — 404 on `/api/sessions/resolve` and unknown deps (TS error on
`getIndexReadiness` etc.).

- [ ] **Step 4: Implement the resolve engine**

Create `server/coding-cli/resolve-session.ts`:

```ts
import { parseResumeInput } from '../../shared/resume-input-parser.js'
import type {
  ResumeResolveMatch,
  ResumeResolveResponse,
} from '../../shared/resume-resolve-contract.js'
import type { CodingCliSession, ProjectGroup } from './types.js'
import type { ClaudeTranscriptHit } from './claude-transcript-locator.js'

export const RESOLVE_MATCH_CAP = 20

export interface ResolveResumeDeps {
  getProjects: () => ProjectGroup[]
  isIndexReady: () => boolean
  resolveOpencodeSessionIds?: (
    ids: readonly string[],
  ) => Promise<{
    rootsBySessionId: Map<string, string>
    directoriesBySessionId?: Map<string, string>
    unresolvedSessionIds: Set<string>
  }>
  locateClaudeTranscript?: (sessionId: string) => Promise<ClaudeTranscriptHit | null>
}

export async function resolveResumeInput(
  input: string,
  deps: ResolveResumeDeps,
): Promise<ResumeResolveResponse> {
  const { candidates, hint } = parseResumeInput(input)

  if (!deps.isIndexReady()) {
    return { status: 'warming', matches: [], hint }
  }
  if (candidates.length === 0) {
    return { status: 'ready', matches: [], hint }
  }

  const sessions = deps.getProjects().flatMap((group) => group.sessions)

  // Evidence pass: one scan answers all providers at once. Candidates are
  // tried in priority order until one resolves.
  for (const candidate of candidates) {
    const needle = candidate.token.toLowerCase()
    const exact: ResumeResolveMatch[] = []
    const prefix: ResumeResolveMatch[] = []
    for (const session of sessions) {
      const id = session.sessionId.toLowerCase()
      if (id === needle) exact.push(toMatch(session, 'exact'))
      else if (id.startsWith(needle)) prefix.push(toMatch(session, 'prefix'))
    }
    const matches = exact.length > 0 ? exact : prefix
    if (matches.length > 0) {
      matches.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      return { status: 'ready', matches: dedupe(matches).slice(0, RESOLVE_MATCH_CAP), hint }
    }
  }

  // Exact-id fallbacks for sessions the index cannot see (opencode child
  // sessions; cwd-less claude transcripts skipped on cold start).
  for (const candidate of candidates) {
    if (
      candidate.kind === 'prefixed-id' &&
      candidate.token.startsWith('ses_') &&
      deps.resolveOpencodeSessionIds
    ) {
      const resolution = await deps.resolveOpencodeSessionIds([candidate.token])
      if (!resolution.unresolvedSessionIds.has(candidate.token)) {
        return {
          status: 'ready',
          matches: [
            {
              provider: 'opencode',
              sessionId: candidate.token,
              // opencode resumes in the SPAWN cwd, not the session's stored
              // project dir — a cwd-less match would run the agent in the
              // wrong directory. The sqlite row's NOT NULL `directory`
              // column always supplies it.
              cwd: resolution.directoriesBySessionId?.get(candidate.token),
              sessionType: 'opencode',
              matchKind: 'exact',
            },
          ],
          hint,
        }
      }
    }
    if (candidate.kind === 'uuid' && deps.locateClaudeTranscript) {
      const hit = await deps.locateClaudeTranscript(candidate.token)
      if (hit) {
        return {
          status: 'ready',
          matches: [
            {
              provider: 'claude',
              sessionId: hit.sessionId,
              cwd: hit.cwd,
              sessionType: 'claude',
              matchKind: 'exact',
            },
          ],
          hint,
        }
      }
    }
  }

  return { status: 'ready', matches: [], hint }
}

function toMatch(session: CodingCliSession, matchKind: 'exact' | 'prefix'): ResumeResolveMatch {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    cwd: session.cwd ?? session.projectPath,
    sessionType: session.sessionType,
    title: session.title,
    firstUserMessage: session.firstUserMessage,
    lastActivityAt: session.lastActivityAt,
    matchKind,
  }
}

// Real stores carry the SAME (provider, sessionId) on multiple snapshot
// entries (observed: one claude id across 3 transcript files). Matches are
// sorted lastActivityAt desc BEFORE deduping, so the survivor is the entry
// with the most recent activity.
function dedupe(matches: ResumeResolveMatch[]): ResumeResolveMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = `${match.provider}:${match.sessionId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
```

- [ ] **Step 5: Register the route and widen deps**

In `server/sessions-router.ts`:

1. Add to the imports (NodeNext — keep `.js` suffixes):

```ts
import { ResumeResolveRequestSchema } from '../shared/resume-resolve-contract.js'
import { resolveResumeInput } from './coding-cli/resolve-session.js'
import type { ClaudeTranscriptHit } from './coding-cli/claude-transcript-locator.js'
```

2. Add to `SessionsRouterDeps` (~line 39–58), after the existing optional members:

```ts
  /** Global index readiness (startup-state codingCliIndexer task). Defaults to ready. */
  getIndexReadiness?: () => boolean
  /** Opencode by-id sqlite fallback (OpencodeProvider.resolveOpencodeSessionRoots). */
  resolveOpencodeSessionIds?: (
    ids: readonly string[],
  ) => Promise<{ rootsBySessionId: Map<string, string>; unresolvedSessionIds: Set<string> }>
  /** Claude transcript exact-id fallback. */
  locateClaudeTranscript?: (sessionId: string) => Promise<ClaudeTranscriptHit | null>
```

3. Register the route inside `createSessionsRouter`, after the existing
`/sessions/:sessionId` routes (~line 223), following the house zod pattern
(`safeParse(req.body ?? {})` → `400 { error, details }`):

```ts
  router.post('/sessions/resolve', async (req, res) => {
    const parsed = ResumeResolveRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid resolve request', details: parsed.error.issues })
    }
    const response = await resolveResumeInput(parsed.data.input, {
      getProjects: () => deps.codingCliIndexer.getProjects(),
      isIndexReady: deps.getIndexReadiness ?? (() => true),
      resolveOpencodeSessionIds: deps.resolveOpencodeSessionIds,
      locateClaudeTranscript: deps.locateClaudeTranscript,
    })
    res.json(response)
  })
```

**Route-order caution:** Express matches in registration order and
`router.post('/sessions/resolve', …)` cannot collide with the existing routes (the
only sibling POST is `/sessions/:sessionId/generate-title`, a deeper path) — but if
any `router.all('/sessions/:sessionId', …)` style catch-all is ever present, register
`/sessions/resolve` BEFORE parameterized `/sessions/:sessionId` routes.

4. In `server/platform-router.ts`, declare the client gate for this endpoint in
`detectFeatureFlags()` (lines 20–25):

```ts
export function detectFeatureFlags(): Record<string, boolean> {
  return {
    kilroy: isTruthy(process.env.KILROY_ENABLED),
    aiEnabled: AI_CONFIG.enabled(),
    // Resume-by-id UI: only the Node server implements POST /api/sessions/resolve.
    // The Rust server's featureFlags parity (crates/freshell-server/src/boot.rs)
    // intentionally omits this key, hiding the Sidebar Resume button there.
    sessionResolve: true,
  }
}
```

No type ripples: both servers and the client already treat featureFlags as
`Record<string, boolean>` (`server/platform-router.ts:20`, `src/store/connectionSlice.ts:16`),
and `/api/bootstrap`'s `getPlatform` dep is typed `Promise<unknown>`
(`server/shell-bootstrap-router.ts:13`). The flag is a constant, so it gets no
dedicated server test; Task 5's Sidebar tests cover the client half of the gate.

5. In `server/coding-cli/providers/opencode.ts`, make the by-id fallback return the
session's directory. Rationale (validated): opencode resumes in the SPAWN cwd, not
the session's stored project dir, so a cwd-less match would run the agent in the
wrong directory; the sqlite `session` table's `directory` column is NOT NULL, so
the cwd is always recoverable.

- Extend `OpencodeRootResolution` (lines 32–35) with an optional field (optional so
  the other literal constructors — e.g. `defaultResolveOpencodeSessionRoots` in
  `server/coding-cli/opencode-activity-tracker.ts:201` and existing test fakes —
  keep compiling unchanged):

```ts
export type OpencodeRootResolution = {
  rootsBySessionId: Map<string, string>
  /** Requested id -> that session row's NOT NULL `directory` (the resume cwd). */
  directoriesBySessionId?: Map<string, string>
  unresolvedSessionIds: Set<string>
}
```

- In `resolveOpencodeSessionRoots` (line 199), widen the by-id SELECT (~line 255)
  to `SELECT id, parent_id, directory FROM session WHERE id IN (…)`, record each
  REQUESTED id's own row `directory` into a `directoriesBySessionId` map (child
  rows carry the same directory as their root — 1394/1394 empirically — so no
  root join is needed), and include the map in the returned resolution. The
  schema-without-`parent_id` early return (lines 245–248) may omit the map (the
  field is optional; the engine then returns a cwd-less match, same as today's
  behavior for that degenerate schema).
- Extend the existing `resolveOpencodeSessionRoots` cases in
  `test/unit/server/coding-cli/opencode-provider.test.ts` (its fixture DB already
  has a `directory` column) with an assertion that `directoriesBySessionId` maps a
  requested child id to its row's directory.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/sessions-resolve-router.test.ts --run`
Expected: PASS (all cases).

- [ ] **Step 7: Wire production deps in `server/index.ts`**

In the `createSessionsRouter({ ... })` options object (~line 748), add three
entries. Use the actual local variable names in that file: `startupState`
(declared ~line 188) and the coding-CLI provider array constructed near line 236
(follow how `codingCliProviders` is passed to the router today). Add imports:

```ts
import { locateClaudeTranscript } from './coding-cli/claude-transcript-locator.js'
import { OpencodeProvider } from './coding-cli/providers/opencode.js'
import { getClaudeProjectsDir } from './claude-home.js'
```

(If `getClaudeProjectsDir` is exported under a slightly different name, use the
export that `server/claude-home.ts` actually provides for the projects dir.)

And in the options:

```ts
      getIndexReadiness: () => startupState.snapshot().tasks.codingCliIndexer === true,
      resolveOpencodeSessionIds: (ids) => {
        const opencode = codingCliProviders.find(
          (provider): provider is OpencodeProvider => provider instanceof OpencodeProvider,
        )
        if (!opencode) {
          return Promise.resolve({
            rootsBySessionId: new Map<string, string>(),
            unresolvedSessionIds: new Set(ids),
          })
        }
        return opencode.resolveOpencodeSessionRoots(ids)
      },
      locateClaudeTranscript: (sessionId) =>
        locateClaudeTranscript(sessionId, getClaudeProjectsDir()),
```

- [ ] **Step 8: Type-check and re-run server tests**

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's `npm run check` if the
coordinator is free — check `npm run test:status` first).
Expected: no new type errors.

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/sessions-resolve-router.test.ts test/integration/server/session-directory-router.test.ts --run`
Expected: PASS — new route works and the existing sessions-router suite still passes.

- [ ] **Step 9: Commit**

```bash
git add shared/resume-resolve-contract.ts server/coding-cli/resolve-session.ts server/sessions-router.ts server/index.ts server/platform-router.ts server/coding-cli/providers/opencode.ts test/integration/server/sessions-resolve-router.test.ts test/unit/server/coding-cli/opencode-provider.test.ts
git commit -m "feat(server): POST /api/sessions/resolve with exact-id fallbacks and sessionResolve feature flag"
```

---

### Task 4: Client resume helper + Resume dialog

**Files:**
- Create: `src/lib/resume-session.ts`
- Create: `src/components/ResumeSessionDialog.tsx`
- Test: `test/unit/client/lib/resume-session.test.ts`
- Test: `test/unit/client/components/ResumeSessionDialog.test.tsx`

**Interfaces:**
- Consumes:
  - `findPaneForSession(state, { provider, sessionId }, localServerInstanceId?)` → `{ tabId, paneId? } | undefined` from `src/lib/session-utils.ts` (~line 376).
  - `openSessionTab({ sessionId, provider?, sessionType?, cwd?, title?, firstUserMessage? })` thunk and `setActiveTab(tabId)` from `src/store/tabsSlice.ts`; `setActivePane({ tabId, paneId })` from `src/store/panesSlice.ts`. (`openSessionTab` defaults `provider→'claude'`, `sessionType→provider` — always pass `sessionType` explicitly.)
  - `api.post(path, body)` from `src/lib/api.ts` (full path form, e.g. `api.post('/api/network/disable-remote-access', {})`).
  - `parseResumeInput` (Task 1); `ResumeResolveResponseSchema`, `ResumeResolveMatch` (Task 3); `DEFAULT_ENABLED_CLI_PROVIDERS` from `@shared/coding-cli-defaults`.
  - `OVERLAY_Z` from `src/components/ui/overlay.ts`; modal structure copied from `src/components/ui/confirm-modal.tsx`; `RootState`/`AppDispatch` from the store types used by `src/store/hooks.ts`.
- Produces (used by Task 5):
  - `resumeSessionInTab(state: RootState, dispatch: AppDispatch, target: ResumeTarget, onNavigate?: (view: 'terminal') => void): { deduped: boolean }`
  - `interface ResumeTarget { provider: string; sessionId: string; cwd?: string; sessionType?: string; title?: string; firstUserMessage?: string }`
  - `<ResumeSessionDialog open onClose={...} onNavigate={...} />` with props `{ open: boolean; onClose: () => void; onNavigate?: (view: 'terminal') => void }`.
  - Dialog data-testids: `resume-dialog`, `resume-input`, `resume-agent-picker`, `resume-resolve-button`, `resume-warming`, `resume-index-unavailable`, `resume-index-retry`, `resume-error`, `resume-note`, `resume-match-list`, `resume-match`, `resume-anyway-cwd`, `resume-anyway-button`.

- [ ] **Step 1: Write the failing helper test**

Create `test/unit/client/lib/resume-session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findPaneForSession = vi.fn()
vi.mock('@/lib/session-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findPaneForSession: (...args: unknown[]) => findPaneForSession(...args),
}))

const openSessionTabAction = { type: 'test/openSessionTab' }
const openSessionTab = vi.fn(() => openSessionTabAction)
vi.mock('@/store/tabsSlice', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openSessionTab: (...args: unknown[]) => openSessionTab(...args),
}))

import { setActiveTab } from '@/store/tabsSlice'
import { setActivePane } from '@/store/panesSlice'
import { resumeSessionInTab } from '@/lib/resume-session'
import type { RootState } from '@/store/store'

const state = { connection: { serverInstanceId: 'srv-1' } } as unknown as RootState

describe('resumeSessionInTab', () => {
  const dispatch = vi.fn()
  const onNavigate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('focuses the existing pane instead of opening a duplicate', () => {
    findPaneForSession.mockReturnValue({ tabId: 'tab-1', paneId: 'pane-1' })
    const result = resumeSessionInTab(
      state,
      dispatch,
      { provider: 'codex', sessionId: 'abc', sessionType: 'codex' },
      onNavigate,
    )
    expect(result).toEqual({ deduped: true })
    expect(findPaneForSession).toHaveBeenCalledWith(
      state,
      { provider: 'codex', sessionId: 'abc' },
      'srv-1',
    )
    expect(dispatch).toHaveBeenCalledWith(setActiveTab('tab-1'))
    expect(dispatch).toHaveBeenCalledWith(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(openSessionTab).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('terminal')
  })

  it('opens a new tab with the full tuple when no pane holds the session', () => {
    findPaneForSession.mockReturnValue(undefined)
    const result = resumeSessionInTab(
      state,
      dispatch,
      { provider: 'opencode', sessionId: 'ses_x00000000000000000000000000', cwd: '/repo/beta' },
      onNavigate,
    )
    expect(result).toEqual({ deduped: false })
    expect(openSessionTab).toHaveBeenCalledWith({
      sessionId: 'ses_x00000000000000000000000000',
      provider: 'opencode',
      sessionType: 'opencode', // defaults to provider when unset
      cwd: '/repo/beta',
      title: undefined,
      firstUserMessage: undefined,
    })
    expect(dispatch).toHaveBeenCalledWith(openSessionTabAction)
    expect(onNavigate).toHaveBeenCalledWith('terminal')
  })
})
```

- [ ] **Step 2: Run helper test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/lib/resume-session.test.ts --run`
Expected: FAIL — `@/lib/resume-session` not found.

- [ ] **Step 3: Implement the helper**

Create `src/lib/resume-session.ts`:

```ts
import { findPaneForSession } from '@/lib/session-utils'
import { openSessionTab, setActiveTab } from '@/store/tabsSlice'
import { setActivePane } from '@/store/panesSlice'
import type { AppDispatch, RootState } from '@/store/store'

export interface ResumeTarget {
  provider: string
  sessionId: string
  cwd?: string
  sessionType?: string
  title?: string
  firstUserMessage?: string
}

/**
 * Resume a session in a tab following the sidebar's dedup convention:
 * if a pane already holds the session, focus it; otherwise open a new
 * focused tab running the correct agent with the FULL session id.
 */
export function resumeSessionInTab(
  state: RootState,
  dispatch: AppDispatch,
  target: ResumeTarget,
  onNavigate?: (view: 'terminal') => void,
): { deduped: boolean } {
  const existing = findPaneForSession(
    state,
    { provider: target.provider, sessionId: target.sessionId },
    state.connection.serverInstanceId,
  )
  if (existing) {
    dispatch(setActiveTab(existing.tabId))
    if (existing.paneId) {
      dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
    }
    onNavigate?.('terminal')
    return { deduped: true }
  }
  dispatch(
    openSessionTab({
      sessionId: target.sessionId,
      provider: target.provider,
      sessionType: target.sessionType ?? target.provider,
      cwd: target.cwd,
      title: target.title,
      firstUserMessage: target.firstUserMessage,
    }),
  )
  onNavigate?.('terminal')
  return { deduped: false }
}
```

If `src/store/store.ts` does not export `RootState`/`AppDispatch` under those exact
names, use the type exports that `src/store/hooks.ts` imports (same types, canonical
names for this repo).

- [ ] **Step 4: Run helper test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/lib/resume-session.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add src/lib/resume-session.ts test/unit/client/lib/resume-session.test.ts
git commit -m "feat(client): resumeSessionInTab helper with pane-dedup focus"
```

- [ ] **Step 6: Write the failing dialog test**

Create `test/unit/client/components/ResumeSessionDialog.test.tsx`:

```tsx
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
```

- [ ] **Step 7: Run dialog test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/components/ResumeSessionDialog.test.tsx --run`
Expected: FAIL — component not found.

- [ ] **Step 8: Implement the dialog**

Create `src/components/ResumeSessionDialog.tsx`. Modal shell (portal, backdrop,
z-index, focus handling) follows `src/components/ui/confirm-modal.tsx`; the select
styling matches the sidebar's raw `<select>` pattern (`Sidebar.tsx:735-739`):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'react-redux'
import { api } from '@/lib/api'
import { resumeSessionInTab, type ResumeTarget } from '@/lib/resume-session'
import { OVERLAY_Z } from '@/components/ui/overlay'
import { useAppDispatch } from '@/store/hooks'
import type { RootState } from '@/store/store'
import { DEFAULT_ENABLED_CLI_PROVIDERS } from '@shared/coding-cli-defaults'
import { parseResumeInput } from '@shared/resume-input-parser'
import {
  ResumeResolveResponseSchema,
  type ResumeResolveMatch,
} from '@shared/resume-resolve-contract'

const WARMING_RETRY_MS = 2000
// Readiness can stick false FOREVER: startupState.markReady('codingCliIndexer')
// is only called in the success .then() of the indexer start chain
// (server/index.ts:1057) and the .catch (:1077-1079) only logs. Bound the
// auto-retry so a failed indexer degrades to a manual-retry state instead of
// an infinite spinner.
const WARMING_RETRY_LIMIT = 15 // ~30s of auto-retries
const RESUMED_CLOSE_MS = 1500

type Phase =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'warming' }
  | { kind: 'index-unavailable' }
  | { kind: 'no-token' }
  | { kind: 'no-match' }
  | { kind: 'disambiguate'; matches: ResumeResolveMatch[] }
  | { kind: 'resumed'; note: string }
  | { kind: 'request-failed' }

export interface ResumeSessionDialogProps {
  open: boolean
  onClose: () => void
  onNavigate?: (view: 'terminal') => void
}

const providers = DEFAULT_ENABLED_CLI_PROVIDERS as readonly string[]

export function ResumeSessionDialog({ open, onClose, onNavigate }: ResumeSessionDialogProps) {
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()
  const [input, setInput] = useState('')
  const [agent, setAgent] = useState<string>(providers[0])
  const [agentTouched, setAgentTouched] = useState(false)
  const [anywayCwd, setAnywayCwd] = useState('~')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const warmingRetriesRef = useRef(0)

  // Advisory hint pre-fills the picker; never overrides a manual choice.
  useEffect(() => {
    if (agentTouched || !input) return
    const { hint } = parseResumeInput(input)
    if (hint && providers.includes(hint.provider)) setAgent(hint.provider)
  }, [input, agentTouched])

  const finishResume = useCallback(
    (target: ResumeTarget, note: string) => {
      resumeSessionInTab(store.getState(), dispatch, target, onNavigate)
      setPhase({ kind: 'resumed', note })
      closeTimerRef.current = window.setTimeout(onClose, RESUMED_CLOSE_MS)
    },
    [dispatch, onClose, onNavigate, store],
  )

  const resolveInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (parseResumeInput(trimmed).candidates.length === 0) {
        setPhase({ kind: 'no-token' })
        return
      }
      setPhase({ kind: 'resolving' })
      let response
      try {
        response = ResumeResolveResponseSchema.parse(
          await api.post('/api/sessions/resolve', { input: trimmed }),
        )
      } catch {
        setPhase({ kind: 'request-failed' })
        return
      }
      if (response.status === 'warming') {
        if (warmingRetriesRef.current >= WARMING_RETRY_LIMIT) {
          setPhase({ kind: 'index-unavailable' })
          return
        }
        warmingRetriesRef.current += 1
        setPhase({ kind: 'warming' })
        return
      }
      if (response.matches.length === 1) {
        const found = response.matches[0]
        finishResume(found, `Found in ${found.provider}`)
        return
      }
      if (response.matches.length > 1) {
        setPhase({ kind: 'disambiguate', matches: response.matches })
        return
      }
      setPhase({ kind: 'no-match' })
    },
    [finishResume],
  )

  // User-initiated resolves reset the warming auto-retry budget.
  const resolveFromUser = useCallback(
    (text: string) => {
      warmingRetriesRef.current = 0
      return resolveInput(text)
    },
    [resolveInput],
  )

  // Warming is NOT "not found": keep re-resolving until the index is ready —
  // but only within the WARMING_RETRY_LIMIT budget (readiness can stick false
  // forever if the indexer start rejects; see the constant's comment).
  useEffect(() => {
    if (phase.kind !== 'warming') return
    const timer = window.setInterval(() => {
      void resolveInput(inputRef.current?.value ?? '')
    }, WARMING_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [phase.kind, resolveInput])

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) return null

  const resumeAnyway = () => {
    const token = parseResumeInput(input).candidates[0]?.token
    if (!token) {
      setPhase({ kind: 'no-token' })
      return
    }
    const cwd = anywayCwd.trim()
    finishResume(
      {
        provider: agent,
        sessionId: token,
        sessionType: agent,
        cwd: cwd === '' || cwd === '~' ? undefined : cwd,
      },
      `Resuming with ${agent}`,
    )
  }

  const controlClass =
    'min-w-0 flex-1 h-7 px-2 text-xs bg-muted/50 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border'

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Resume a session"
        data-testid="resume-dialog"
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-5 flex flex-col gap-3"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <h2 className="text-sm font-medium">Resume a session</h2>
        <label className="text-xs text-muted-foreground" htmlFor="resume-input">
          Paste a session id or a resume command
        </label>
        <textarea
          id="resume-input"
          data-testid="resume-input"
          ref={inputRef}
          value={input}
          rows={3}
          className="w-full text-xs bg-muted/50 border-0 rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-border resize-none"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void resolveFromUser(event.currentTarget.value)
            }
          }}
          onPaste={() => {
            // Paste-then-Enter fast path: auto-resolve once the value lands.
            window.setTimeout(() => {
              void resolveFromUser(inputRef.current?.value ?? '')
            }, 0)
          }}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="resume-agent-picker">
            Agent
          </label>
          <select
            id="resume-agent-picker"
            data-testid="resume-agent-picker"
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value)
              setAgentTouched(true)
            }}
            className={controlClass}
          >
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Unverified guess — the session store decides the agent.
        </p>
        <button
          type="button"
          data-testid="resume-resolve-button"
          onClick={() => void resolveFromUser(input)}
          disabled={phase.kind === 'resolving'}
          className="h-8 px-3 text-xs rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50"
        >
          {phase.kind === 'resolving' ? 'Resolving…' : 'Resume'}
        </button>

        {phase.kind === 'warming' && (
          <div data-testid="resume-warming" className="text-xs text-muted-foreground" role="status">
            Session index is still warming — retrying…
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => void resolveFromUser(input)}
            >
              Retry now
            </button>
          </div>
        )}
        {phase.kind === 'index-unavailable' && (
          <div
            data-testid="resume-index-unavailable"
            role="alert"
            className="text-xs text-destructive"
          >
            Session index unavailable — retry manually.
            <button
              type="button"
              data-testid="resume-index-retry"
              className="ml-2 underline"
              onClick={() => void resolveFromUser(input)}
            >
              Retry
            </button>
          </div>
        )}
        {phase.kind === 'no-token' && (
          <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
            No session id found in the pasted text.
          </div>
        )}
        {phase.kind === 'request-failed' && (
          <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
            Could not reach the server. Try again.
          </div>
        )}
        {phase.kind === 'resumed' && (
          <div data-testid="resume-note" role="status" className="text-xs text-muted-foreground">
            {phase.note}
          </div>
        )}
        {phase.kind === 'disambiguate' && (
          <ul data-testid="resume-match-list" className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {phase.matches.map((candidate) => (
              <li key={`${candidate.provider}:${candidate.sessionId}`}>
                <button
                  type="button"
                  data-testid="resume-match"
                  className="w-full text-left text-xs p-2 rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border"
                  onClick={() => finishResume(candidate, `Found in ${candidate.provider}`)}
                >
                  <span className="font-medium">
                    {candidate.title ?? candidate.firstUserMessage ?? candidate.sessionId}
                  </span>
                  <span className="block text-muted-foreground">
                    {candidate.provider} · {candidate.sessionId.slice(0, 12)}…
                    {candidate.cwd ? ` · ${candidate.cwd}` : ''}
                    {typeof candidate.lastActivityAt === 'number'
                      ? ` · ${new Date(candidate.lastActivityAt).toLocaleString()}`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {phase.kind === 'no-match' && (
          <div className="flex flex-col gap-2">
            <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
              No matching session found in any agent&apos;s store.
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="resume-anyway-cwd">
                cwd
              </label>
              <input
                id="resume-anyway-cwd"
                data-testid="resume-anyway-cwd"
                value={anywayCwd}
                onChange={(event) => setAnywayCwd(event.target.value)}
                className={controlClass}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              ~ resolves to the server&apos;s home directory.
            </p>
            <button
              type="button"
              data-testid="resume-anyway-button"
              onClick={resumeAnyway}
              className="h-8 px-3 text-xs rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border"
            >
              Resume anyway with {agent}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
```

If `api.post` in `src/lib/api.ts` takes a generic (`api.post<T>(path, body)`), pass
`api.post<unknown>('/api/sessions/resolve', { input: trimmed })` — the zod parse is
the type authority either way.

- [ ] **Step 9: Run dialog test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/components/ResumeSessionDialog.test.tsx --run`
Expected: PASS (9 tests).

- [ ] **Step 10: Commit**

```bash
git add src/components/ResumeSessionDialog.tsx test/unit/client/components/ResumeSessionDialog.test.tsx
git commit -m "feat(client): resume session dialog with resolve flow, disambiguation, warming and resume-anyway"
```

---

### Task 5: Pinned Resume footer in the Sidebar

**Files:**
- Modify: `src/components/Sidebar.tsx` (root `h-full flex flex-col` div spans ~lines 638–901; the `flex flex-1 min-h-0` list wrapper opens at ~line 833 and closes at ~line 899; the footer goes at ~line 900, as a sibling AFTER that wrapper and BEFORE the root close)
- Test: `test/unit/client/components/Sidebar.resume-footer.test.tsx`

**Interfaces:**
- Consumes: `ResumeSessionDialog` (Task 4); Sidebar's existing `onNavigate` prop and `fullWidth` prop (`fullWidth={isMobile}` is passed from `src/App.tsx` line 1755); `connection.featureFlags` from `src/store/connectionSlice.ts` (:16; populated by `setFeatureFlags` from `/api/bootstrap`, `src/App.tsx:601-602`) — the footer renders only when `featureFlags.sessionResolve === true` (declared by the Node server in Task 3; the Rust server intentionally omits it, hiding the button there). Selector precedent: `src/components/panes/PanePicker.tsx:105`.
- Produces: data-testids `sidebar-resume-footer` and `sidebar-resume-button`, used by Task 6's Playwright spec.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/components/Sidebar.resume-footer.test.tsx`. Copy the
store/render harness from `test/unit/client/components/Sidebar.mobile.test.tsx`
(same `react-window`, `@/lib/ws-client` and `@/lib/api` mocks, same
`createTestStore` built on the real slice reducers, same
`<Sidebar view="terminal" onNavigate={...} />` render). One required change:
the preloaded `connection` state must carry the feature flag — preloadedState
replaces `connectionSlice`'s initial state, so set
`connection: { status: 'connected', error: null, featureFlags: { sessionResolve: true } }`
by default and let tests override it. Then add:

```tsx
// ...harness copied from Sidebar.mobile.test.tsx, exposing:
// renderSidebar(
//   overrides?: Partial<ComponentProps<typeof Sidebar>>,
//   featureFlags: Record<string, boolean> = { sessionResolve: true },
// ): ReturnType<typeof render>
// (featureFlags lands in the preloaded `connection` slice state.)

import { screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/components/ResumeSessionDialog', () => ({
  ResumeSessionDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="resume-dialog" /> : null,
}))

describe('Sidebar resume footer', () => {
  it('renders the footer as a sibling AFTER the scrollable list, not inside it', () => {
    renderSidebar()
    const list = screen.getByTestId('sidebar-session-list')
    const footer = screen.getByTestId('sidebar-resume-footer')
    // Not inside the scroll viewport:
    expect(list.contains(footer)).toBe(false)
    // After the list in document order:
    expect(
      list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the footer outside the flex-1 min-h-0 region (pinned at every scroll position)', () => {
    renderSidebar()
    const footer = screen.getByTestId('sidebar-resume-footer')
    // No ancestor between footer and the sidebar root may be the scrollable
    // flex-1 min-h-0 wrapper.
    let node: HTMLElement | null = footer.parentElement
    let insideScrollRegion = false
    while (node) {
      const cls = node.className ?? ''
      if (cls.includes('flex-1') && cls.includes('min-h-0')) insideScrollRegion = true
      node = node.parentElement
    }
    expect(insideScrollRegion).toBe(false)
    expect(footer.className).toContain('flex-shrink-0')
  })

  it('is rendered in fullWidth (mobile) mode too', () => {
    renderSidebar({ fullWidth: true })
    expect(screen.getByTestId('sidebar-resume-button')).toBeInTheDocument()
  })

  it('opens the resume dialog on click and closes it again', () => {
    renderSidebar()
    expect(screen.queryByTestId('resume-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('sidebar-resume-button'))
    expect(screen.getByTestId('resume-dialog')).toBeInTheDocument()
  })

  it('the button is keyboard reachable (a real button with an accessible name)', () => {
    renderSidebar()
    const button = screen.getByTestId('sidebar-resume-button')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAccessibleName()
  })

  it('does not render the footer without the sessionResolve feature flag', () => {
    // e.g. the Rust/Tauri deployments: same client bundle, no resolve
    // endpoint, and a featureFlags payload that omits the flag.
    renderSidebar({}, {})
    expect(screen.queryByTestId('sidebar-resume-footer')).toBeNull()
    expect(screen.queryByTestId('sidebar-resume-button')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/components/Sidebar.resume-footer.test.tsx --run`
Expected: FAIL — `sidebar-resume-footer` not found.

- [ ] **Step 3: Implement the footer**

In `src/components/Sidebar.tsx`:

1. Imports + state (top of component, alongside existing `useState` calls;
`useAppSelector` is already imported at `Sidebar.tsx:6`):

```tsx
import { ResumeSessionDialog } from '@/components/ResumeSessionDialog'
// inside the component:
const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
// Server-declared capability gate: only the Node server declares
// `sessionResolve` (Task 3, server/platform-router.ts). The Rust server
// serves the same bundle WITHOUT the flag or the resolve endpoint, so the
// footer must not render there.
const resumeEnabled = useAppSelector((s) => s.connection?.featureFlags?.sessionResolve === true)
```

2. Insert at ~line 900 — immediately AFTER the closing `</div>` of the
`flex flex-1 min-h-0` list wrapper (closes ~line 899) and BEFORE the root's closing
`</div>` (~line 901):

```tsx
      {resumeEnabled && (
        <div
          data-testid="sidebar-resume-footer"
          className="flex-shrink-0 border-t border-border p-2"
        >
          <button
            type="button"
            data-testid="sidebar-resume-button"
            aria-label="Resume a session by id"
            onClick={() => setResumeDialogOpen(true)}
            className="w-full min-h-11 md:min-h-0 md:h-7 px-2 text-xs bg-muted/50 hover:bg-muted rounded-md focus:outline-none focus:ring-1 focus:ring-border"
          >
            Resume session…
          </button>
        </div>
      )}
      {resumeEnabled && resumeDialogOpen && (
        <ResumeSessionDialog
          open
          onClose={() => setResumeDialogOpen(false)}
          onNavigate={onNavigate}
        />
      )}
```

(`min-h-11 md:min-h-0` matches the sidebar's existing mobile touch-target
convention. The footer needs no `fullWidth` special-casing: the root is
`h-full flex flex-col` in both modes, so a non-scrolling sibling below the
`flex-1 min-h-0` region is pinned in both.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/components/Sidebar.resume-footer.test.tsx --run`
Expected: PASS.

- [ ] **Step 5: Verify no regressions in existing Sidebar tests**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/client/components/Sidebar.render-stability.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.resume-footer.test.tsx
git commit -m "feat(sidebar): flag-gated pinned resume footer below the session list"
```

---

### Task 6: Browser e2e proof + user-facing doc line + full suite

**Files:**
- Create: `test/e2e-browser/specs/resume-button.spec.ts`
- Modify: `docs/index.html` (one feature line)
- Deliberately NOT modified: `test/e2e-browser/playwright.config.ts` — see Step 3 (the default `chromium` project picks up unlisted specs automatically; list membership would ADD a guaranteed-red rust run).

**Interfaces:**
- Consumes: testids from Tasks 4–5 (`sidebar-resume-button`, `resume-dialog`, `resume-input`, `sidebar-session-list`); the `sessionResolve` feature flag (Task 3 — the harness boots the real Node server, which declares it, so the footer renders); the harness/helpers of `test/e2e-browser/specs/sidebar-click-resume.spec.ts` (the direct prior art — it shows how to seed sessions, boot the app, and prove `resume <sessionId>` argv); the dual-mode codex app-server fixture `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (see Step 1's root-cause note).
- Produces: end-user proof of the two spec NFRs jsdom cannot prove: pinned visibility under real scrolling, and the paste→Enter→real-resume path.

- [ ] **Step 1: Study the prior art**

Read `test/e2e-browser/specs/sidebar-click-resume.spec.ts` end-to-end and
`test/e2e-browser/playwright.config.ts`. The pieces you will reuse:

- Imports: `{ test, expect } from '../helpers/fixtures.js'`,
  `{ createE2eServerHandle } from '../helpers/external-target.js'`,
  `{ TestHarness } from '../helpers/test-harness.js'`, plus node `fs/os/path`.
- Server boot: `createE2eServerHandle(process.env, { construct: { env, setupHome: async (homeDir) => {...}, ... } })`
  then `.start()` → `TestServerInfo` (base URL + token) and `.stop()` in cleanup.
- Session seeding happens inside `construct.setupHome(homeDir)`: write
  `~/.freshell/config.json` with `codingCli.enabledProviders`, and provider store
  files (e.g. `~/.codex/sessions/<id>.jsonl` — copy the exact seeding blocks from
  the prior-art spec).
- Fake CLI + argv proof: the spec-local helpers `installFakeCli(source, binName, binDir)`,
  `bootAndConnect(page, { baseUrl, token })`, `readArgvLog(logPath)`, and the
  `CODEX_CMD`/`FAKE_CODEX_ARGV_LOG` env wiring. The resume proof is a polled
  `readArgvLog()` check (codex: the ADJACENT `'resume', ID` pair anywhere in argv —
  the launch-arg builder appends `resumeArgs` LAST, after the `--remote`/`-c`
  overrides) plus the terminal-buffer marker `codex: resumed session <id>`
  (polled `harness.getTerminalBuffer(terminalId)` or
  `harness.waitForTerminalText(...)`, `test/e2e-browser/helpers/test-harness.ts:72,132`).
- Spec conventions: no `beforeEach` — `test.setTimeout(90_000)` at top; every test
  destructures the `e2eServerKind` fixture and guards itself (Step 2).

**Why the prior art's codex leg is `test.fixme` on legacy — and why THIS spec can
pass there (root-caused, do not inherit the fixme):** legacy codex terminal-create
runs `planCodexLaunch` → `runtime.ensureReady`, which spawns the SAME `CODEX_CMD`
binary as a JSON-RPC sidecar — `CODEX_CMD [..., 'app-server', '--listen', <wsUrl>]`
(`server/coding-cli/codex-app-server/runtime.ts:1828-1834`; the command comes from
`CODEX_CMD` at `:1493`) — and requires an `initialize` handshake BEFORE the PTY is
spawned. The prior art's `fixtures/fake-codex-cli.mjs` only logs argv and never
listens on the `--listen` URL, so the create settles into `status: 'error'` with no
terminalId — that is the entire fixme (`sidebar-click-resume.spec.ts:147`), a
fixture/architecture mismatch, not a server bug. Proof the legacy path goes green
with the right fake: `test/integration/server/codex-session-flow.test.ts` (passing)
uses `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` as the sidecar,
and its restore test records PTY argv `['--remote', ws://…, …, 'resume', '<id>']`
(:719-724). This spec therefore uses a dual-mode CODEX_CMD wrapper (Step 2).

- [ ] **Step 2: Write the failing spec**

Create `test/e2e-browser/specs/resume-button.spec.ts`. Copy the prior-art spec's
boot/seed scaffolding verbatim (same imports, same `setupHome` seeding blocks,
same argv-log wiring), seeding **40+ codex sessions** (loop writing
`~/.codex/sessions/<uuid>.jsonl`) so the sidebar list scrolls, with one known
target id `RESUME_ID` among them — with ONE deliberate difference: do NOT copy
`fixtures/fake-codex-cli.mjs` as `CODEX_CMD`. Per Step 1's root cause, write a
dual-mode wrapper into the throwaway bin dir instead and point
`CODEX_CMD`/`FAKE_CODEX_ARGV_LOG` at it (same env wiring as the prior art):

```ts
const FAKE_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Legacy codex terminal-create spawns CODEX_CMD TWICE: first as the JSON-RPC
 * sidecar (`… app-server --listen <ws>`, runtime.ts:1828-1834) whose
 * `initialize` handshake gates the PTY spawn, then as the PTY TUI with the
 * resume argv. fixtures/fake-codex-cli.mjs handles only the second mode —
 * exactly why the prior art is test.fixme on legacy. This wrapper handles both.
 */
async function writeDualModeCodexCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('app-server')) {
  // Delegate to the protocol-faithful fixture AT ITS REPO PATH — it has a
  // bare \`import 'ws'\` that must resolve against the repo's node_modules,
  // so it cannot be copied into this tmp bin dir.
  const child = spawn(process.execPath, [${JSON.stringify(FAKE_APP_SERVER_SOURCE)}, ...argv], { stdio: 'inherit' })
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  // TUI mode (the PTY): same contract as fixtures/fake-codex-cli.mjs —
  // argv-log JSONL + greppable marker + stay alive. Only this mode logs
  // argv, so the log carries PTY invocations, not sidecar ones.
  const logPath = process.env.FAKE_CODEX_ARGV_LOG
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, t: Date.now(), argv }) + '\\n')
  }
  const resumeIndex = argv.indexOf('resume')
  if (resumeIndex !== -1) {
    process.stdout.write('codex: resumed session ' + (argv[resumeIndex + 1] ?? '') + '\\r\\n')
  } else {
    process.stdout.write('codex> \\r\\n')
  }
  process.stdin.resume()
}
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}
```

(With that wrapper, the legacy PTY argv is `['--remote', ws://…, -c …, 'resume',
RESUME_ID]` — the resume pair appended LAST — so the argv-pair assertion below
matches reality; verified against the passing integration test's recorded argv.)

Then three `test(...)` blocks. Every test destructures `e2eServerKind` and guards
itself — the defensive prior-art pattern (`sidebar-click-resume.spec.ts:288-293`,
inverted): the button is flag-hidden on Rust AND the Rust server has no resolve
endpoint, so a future broad-testMatch rust run must skip loudly, not go red:

```ts
const RUST_SKIP =
  'KNOWN DIVERGENCE: the Rust server has no POST /api/sessions/resolve and does not ' +
  'declare the sessionResolve feature flag (button hidden there by design) — ' +
  'out of scope, see docs/plans/2026-07-29-resume-session-button.md.'

test('resume button stays visible at top/middle/bottom scroll', async ({ page, e2eServerKind }) => {
  test.skip(e2eServerKind !== 'legacy', RUST_SKIP)
  // boot + connect exactly as sidebar-click-resume.spec.ts does
  const button = page.getByTestId('sidebar-resume-button')
  await expect(button).toBeVisible()
  for (const fraction of [0, 0.5, 1]) {
    await page.getByTestId('sidebar-session-list').evaluate((el, f) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * f
    }, fraction)
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
  }
})

test('resume button is visible in fullWidth mobile mode', async ({ page, e2eServerKind }) => {
  test.skip(e2eServerKind !== 'legacy', RUST_SKIP)
  await page.setViewportSize({ width: 390, height: 844 })
  // boot + connect, then open the sidebar via the mobile control
  // (testid 'show-sidebar-button' — same approach as mobile-viewport.spec.ts)
  await expect(page.getByTestId('sidebar-resume-button')).toBeVisible()
})

test('paste-then-Enter resumes the session with the right agent', async ({ page, e2eServerKind }) => {
  test.skip(e2eServerKind !== 'legacy', RUST_SKIP)
  // boot + connect
  await page.getByTestId('sidebar-resume-button').click()
  await expect(page.getByTestId('resume-dialog')).toBeVisible()
  await page.getByTestId('resume-input').fill(RESUME_ID)
  await page.getByTestId('resume-input').press('Enter')
  // argv proof — identical mechanism to sidebar-click-resume.spec.ts (the
  // adjacent `resume <id>` pair anywhere in argv, since resumeArgs are
  // appended last):
  await expect
    .poll(async () => {
      const entries = await readArgvLog(argvLogPath)
      return entries.some(
        ({ argv }) => argv.includes('resume') && argv[argv.indexOf('resume') + 1] === RESUME_ID,
      )
    })
    .toBe(true)
})
```

The `// boot + connect` lines are the prior-art spec's real setup calls
(`createE2eServerHandle(...)`, `.start()`, `bootAndConnect(page, {...})`) — lift
them verbatim, including cleanup in the same style the prior-art spec uses, with
`env: { CODEX_CMD: <writeDualModeCodexCli result>, FAKE_CODEX_ARGV_LOG: argvLogPath }`.

- [ ] **Step 3: Verify the spec's routing (no config change)**

Do NOT touch `test/e2e-browser/playwright.config.ts` — add the spec to NEITHER
`MATRIX_SPECS` nor `RUST_ONLY_SPECS`. The default `chromium` project has no
`testMatch` and only `testIgnore: RUST_ONLY_SPECS`
(playwright.config.ts:190-194), so it picks up any new spec automatically and
runs it with the fixture-default `e2eServerKind: 'legacy'`
(`test/e2e-browser/helpers/fixtures.ts:76`) — exactly one local run, like
`mobile-viewport.spec.ts`. `MATRIX_SPECS` membership would instead ADD
`legacy-chromium` AND `rust-chromium` runs (playwright.config.ts:199-217); the
rust leg has no resolve endpoint and would be guaranteed red. The in-spec
`test.skip(e2eServerKind !== 'legacy', …)` guard from Step 2 is defensive cover
for any future broad-testMatch rust run.

Verify: `npx playwright test --config test/e2e-browser/playwright.config.ts --list resume-button`
Expected: 3 tests, all listed under `[chromium]` only.

- [ ] **Step 4: Run the spec**

Run: `npm run test:e2e:chromium -- resume-button`
Expected: 3 tests PASS. (If the suite requires a build first, follow the same
pre-steps the repo uses for `sidebar-click-resume.spec.ts` runs — see the
`test:e2e` script and Playwright config `webServer`/global-setup.)

- [ ] **Step 5: Mirror the Resume button in the docs mock + record the Rust-parity follow-up**

Two documentation edits (the AGENTS.md user-facing-docs rule, plus the Global
Constraints parity commitment). Note `docs/index.html` is a **nonfunctional
HTML mock** of the default app experience — it contains NO `<ul>`/`<li>`
feature list; the sidebar is `<aside class="sidebar" id="sidebar">` (lines
603–643) built from div rows (`.sb-list` spans 633–641; `.sb-footer` is line
642). Mirror the real UI change in that mock:

1. Markup — insert one line between the `</div>` that closes `.sb-list`
   (line 641, 6-space indent) and the `.sb-footer` div (line 642):

```html
      <div class="sb-resume"><button class="sb-resume-btn"><i data-lucide="rotate-ccw" class="icon"></i> Resume session…</button></div>
```

2. CSS — in the `<style>` block, add between the `.sb-item-meta` rule
   (~line 206) and the `.sb-footer` rule (~line 207), copying the
   `.sb-nav-btn` styling conventions (lines 183–190):

```css
    .sb-resume { padding: 8px; border-top: 1px solid hsl(var(--border)); }
    .sb-resume-btn { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: none; background: none; border-radius: 6px; cursor: pointer; transition: all .12s; color: hsl(var(--muted-foreground)); font: inherit; font-size: 13px; }
    .sb-resume-btn:hover { color: hsl(var(--foreground)); background: hsl(var(--muted) / .5); }
```

3. Inert-control wiring — add `'.sb-resume-btn'` to the `inertSelectors`
   array (lines ~1679–1688) so clicking the mock button shows the standard
   mock overlay like every other fake control there.

No layout surgery is needed: `.sidebar` is `display:flex; flex-direction:column`
and `.sb-list` is `flex: 1; overflow-y: auto`, so a sibling inserted between the
list and `.sb-footer` renders pinned below the scroll area automatically.

Verify: open `docs/index.html` in a browser — a "Resume session…" row sits
pinned between the session list and the "★ Star on GitHub" footer; clicking it
triggers the same inert-control overlay as the other mock buttons.

4. Parity checklist — in
   `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, append a
   new item at the END of the ``## P2 — Current `main` catch-up not otherwise
   covered above`` section (after the SYNC-05 item ending at line 801, before
   the `## Final release gates` heading at line 803), using the section's next
   free `SYNC-NN` id (`SYNC-06` at time of writing — SYNC-00…05 exist at lines
   783–801) and the file's exact item format (cf. SYNC-01 at lines 786–787):

```markdown
- [ ] **SYNC-06 — Session resume-by-id parity: `POST /api/sessions/resolve` + `sessionResolve` feature flag.** The Node server (`server/sessions-router.ts`) resolves pasted session ids/resume commands across claude/codex/opencode/amplifier and gates the sidebar Resume button via the `sessionResolve` flag in `detectFeatureFlags()`; the Rust server intentionally omits the flag (button stays hidden) until it implements the endpoint. See `docs/plans/2026-07-29-resume-session-button.md`.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** With the flag declared, the sidebar shows the pinned Resume button; pasting a known session id resumes it in a tab (mirror `test/e2e-browser/specs/resume-button.spec.ts`).
```

- [ ] **Step 6: Full verification pass**

```bash
npm run test:status   # coordinator gate — wait if another agent holds it
npm run test:client
npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run
npm run lint
```

Expected: all PASS, no lint errors (a11y rules are CI-gated on `src/`).

- [ ] **Step 7: Commit**

```bash
git add test/e2e-browser/specs/resume-button.spec.ts
git commit -m "test(e2e): resume button pinned placement and paste-to-resume proof"
git add docs/index.html docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "docs: mirror pinned Resume button in UI mock; record Rust-parity follow-up"
```

---

## Self-Review (performed during planning)

**1. Spec coverage.** Every spec section maps to a task: pinned footer + fullWidth
(Task 5, Task 6), dialog with picker + paste field (Task 4), supported agents
(Global Constraints; picker options in Task 4), Node-server target (confirmed in
Global Constraints), resolve endpoint with exact+prefix across all providers +
per-candidate metadata + warming (Task 3), permissive parsing incl. token shapes,
noise stripping, candidate ordering (Task 1), evidence-decides/hints-advise (Tasks
1+3+4), all five outcome branches (Task 4), tab resume via existing mechanics with
pane dedup (Task 4 helper), acceptance-example tests (traceability table above),
non-functional requirements (parser tables Task 1; endpoint fixtures Task 3; pinned
placement/keyboard/paste-Enter Tasks 5–6).

**1b. No silent deferrals.** No stubs stand in for required behavior: the resolve
endpoint runs against the real indexer in production wiring (Task 3 Step 7); the
dialog drives the real `openSessionTab` path; Task 6 proves the end-to-end outcome
(paste → real spawned `--resume <id>` argv) in a real browser. The two scoped-out
items — Rust parity and prefix search beyond the index — are **explicit spec
carve-outs**, not silent deferrals, and are documented in Global Constraints. Test
doubles appear only inside test files. No unresolved coverage gaps.

**2. Placeholder scan.** All code steps carry complete code. The two
copy-from-named-file instructions (Sidebar test harness, Playwright helpers) point
at exact existing files with the exact assertions to add, because those harnesses
already exist in-repo and must be reused, not re-invented (DRY).

**3. Type consistency.** `parseResumeInput`/`ResumeCandidate`/`ResumeHint` (Task 1)
are consumed with the same names in Tasks 3–4; `ResumeResolveMatch`/`ResumeResolveResponseSchema`
(Task 3) match the dialog's usage (Task 4); `resumeSessionInTab(state, dispatch, target, onNavigate)`
signature is identical in Task 4's helper, its tests, and the dialog;
`getIndexReadiness`/`resolveOpencodeSessionIds`/`locateClaudeTranscript` dep names
match between the router deps, the harness, and the `server/index.ts` wiring
(including the optional `directoriesBySessionId` map in the opencode resolution
shape, consistent across the provider type, the deps, the engine, and the router
test fixture); the `sessionResolve` flag name matches between Task 3's
`detectFeatureFlags()`, Task 5's selector + test harness, and Task 6's skip reason;
`sidebar-resume-footer`/`sidebar-resume-button` testids match between Task 5 and Task 6.
