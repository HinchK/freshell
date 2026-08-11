/**
 * HARNESS-04 — shared types for the multi-provider session corpus builder.
 *
 * The corpus builder materializes deterministic, fully-isolated provider
 * histories (Claude / Codex / OpenCode / Amplifier) into a throwaway HOME so
 * e2e harness consumers (session-directory, history, resume, restore specs)
 * get realistic state without ever touching the real `~/.claude`, `~/.codex`,
 * `~/.local/share/opencode`, `~/.amplifier`, or `~/.freshell`.
 *
 * Every generated path, session id, and title embeds the per-run marker
 * (`h04corpus-<runToken>`) so leakage into the real home is attributable.
 */

export type CorpusProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'

export interface CorpusFileRecord {
  /** Path relative to the corpus home, posix separators. */
  path: string
  sha256: string
  bytes: number
  /** Stable role tag, e.g. 'claude-session:alpha', 'opencode-db', 'freshell-config'. */
  role: string
}

export type SessionVisibility =
  /** Appears in the default session-directory listing. */
  | 'listed'
  /** Never appears (deleted override, provider-level archive, child/subagent row). */
  | 'absent'
  /** Indexed but filtered by the default visibility knobs. */
  | 'hidden-default'

export interface VisibilityToggles {
  includeSubagents?: boolean
  includeNonInteractive?: boolean
  includeEmpty?: boolean
}

export interface CorpusSessionExpectation {
  /** Wire composite key: `${provider}:${sessionId}`. */
  key: string
  provider: CorpusProvider
  sessionId: string
  /** Stable corpus role: 'bulk-001', 'alpha', 'frac-200', 'worktree', ... */
  role: string
  /** Expected wire title AFTER provider extraction + override layering. */
  title?: string
  /** Expected wire summary (same layering). */
  summary?: string
  /** Absolute expected projectPath (post git-root resolution). */
  projectPath: string
  /** Absolute expected checkoutPath when the cwd is a linked worktree. */
  checkoutPath?: string
  /** Absolute session cwd as the providers record it. */
  cwd: string
  /** Expected integer createdAt where asserted (claude init ts; amplifier floor). */
  createdAt?: number
  /** Expected integer lastActivityAt (post-floor, post-override). */
  lastActivityAt: number
  /** Expected wire `archived` flag when listed. */
  archived?: boolean
  visibility: SessionVisibility
  /** For visibility 'hidden-default': the exact toggles that reveal the session. */
  visibleWith?: VisibilityToggles
}

export interface CorpusGitFixture {
  kind: 'nested-repo' | 'worktree' | 'repo-subdir'
  /** Repo-or-checkout root path, relative to the corpus workspace. */
  path: string
  /** Absolute projectPath the server must resolve for sessions under `path`. */
  expectedProjectPath: string
  /** Worktree only: absolute checkoutPath the server must resolve. */
  expectedCheckoutPath?: string
  /**
   * `.git`-fixture-internal files (relative to homeDir). These are hashed like
   * any other corpus file; they are listed separately so consumers can also
   * assert their STRUCTURE (HEAD file, gitdir pointer, commondir).
   */
  internalFiles: string[]
}

/** Inputs every provider writer receives from the orchestrator. */
export interface CorpusContext {
  homeDir: string
  /** Short unique per-build token. */
  runToken: string
  /** Leakage tripwire marker: `h04corpus-<runToken>`. */
  marker: string
  /** `<homeDir>/h04corpus-<runToken>` — where corpus cwds/repos live. */
  workspace: string
  /** Writers append every regular file they create (except the manifest). */
  files: CorpusFileRecord[]
  sessions: CorpusSessionExpectation[]
  gitFixtures: CorpusGitFixture[]
}

export interface CorpusBuildOptions {
  /** Override the random token (tests pin it for determinism). */
  runToken?: string
  /** Bulk Claude session count (default 52 → 67 listed > one 50-item page). */
  bulkCount?: number
}

export interface SessionCorpus {
  homeDir: string
  marker: string
  manifestPath: string
  manifest: import('./manifest.js').CorpusManifest
}
