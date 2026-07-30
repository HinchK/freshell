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
          await api.post<unknown>('/api/sessions/resolve', { input: trimmed }),
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
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- same convention as App.tsx's update-instructions dialog: the container's onClick is a stopPropagation shield and onKeyDown handles Escape; the dialog's real controls are native buttons/inputs. */}
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
