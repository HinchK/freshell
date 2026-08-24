import { useRef, useEffect } from 'react'
import { X, Maximize2, Minimize2, Search, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getTerminalStatusIconClassName } from '@/lib/terminal-status-indicator'
import type { TerminalStatus } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import PaneIcon from '@/components/icons/PaneIcon'
import FreshAgentSettingsButton from '@/components/fresh-agent/FreshAgentSettingsButton'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import RepoIcon, { type RepoIconInfo } from '@/components/icons/RepoIcon'
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import { fetchRepoIconMeta, type RepoIconEntry } from '@/store/repoIconsSlice'
import { FRESH_AGENT_RUNTIME_PROVIDER_LABELS, resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

const EMPTY_REPO_ICONS: Record<string, RepoIconEntry> = {}
const EMPTY_TERMINAL_META: Record<string, TerminalMetaRecord> = {}

interface PaneHeaderProps {
  tabId?: string
  paneId?: string
  title: string
  metaLabel?: string
  metaTooltip?: string
  needsAttention?: boolean
  busy?: boolean
  status: TerminalStatus
  isActive: boolean
  onClose: () => void
  onToggleZoom?: () => void
  isZoomed?: boolean
  content: PaneContent
  isRenaming?: boolean
  renameValue?: string
  renameError?: string
  onRenameChange?: (value: string) => void
  onRenameBlur?: () => void
  onRenameKeyDown?: (e: React.KeyboardEvent) => void
  onDoubleClick?: () => void
  onSearch?: () => void
  onRefresh?: () => void
}

export default function PaneHeader({
  tabId = '',
  paneId = '',
  title,
  metaLabel,
  metaTooltip,
  needsAttention,
  busy,
  status,
  isActive,
  onClose,
  onToggleZoom,
  isZoomed,
  content,
  isRenaming,
  renameValue,
  renameError,
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onDoubleClick,
  onSearch,
  onRefresh,
}: PaneHeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dispatch = useAppDispatch()
  const repoIconsOnTabs = useAppSelector((s) => s.settings?.settings?.panes?.repoIconsOnTabs ?? true)
  const repoIconsByCwd = useAppSelector((s) => s.repoIcons?.byCwd ?? EMPTY_REPO_ICONS)
  const terminalMetaById = useAppSelector((s) => s.terminalMeta?.byTerminalId ?? EMPTY_TERMINAL_META)
  const isFreshAgentPane = content.kind === 'fresh-agent'
  // The tabs-only `repoIconsOnTabs` setting does not govern the fresh-agent
  // pane header — its repo icon is part of the header design regardless.
  const repoCwd = isFreshAgentPane || repoIconsOnTabs
    ? resolvePaneRepoCwd(content, undefined, terminalMetaById)
    : undefined
  const repoEntry = repoCwd ? repoIconsByCwd[repoCwd] : undefined
  const repoIconInfo: RepoIconInfo | undefined =
    repoCwd && repoEntry && repoEntry.status !== 'loading'
      ? {
          repoKey: repoEntry.repoRoot || repoCwd,
          repoName: repoEntry.repoName || pathBasename(repoEntry.repoRoot || repoCwd),
          iconUrl: repoEntry.hasIcon ? buildRepoIconUrl(repoCwd) : undefined,
        }
      : undefined
  // Fresh-agent header: always show a repo icon when the pane has a cwd —
  // letter-avatar fallback while the probe is loading/missing/failed.
  const freshAgentRepoIconInfo: RepoIconInfo | undefined =
    isFreshAgentPane && repoCwd
      ? {
          repoKey: repoEntry?.repoRoot || repoCwd,
          repoName: repoEntry?.repoName || pathBasename(repoEntry?.repoRoot || repoCwd),
          iconUrl: repoEntry && repoEntry.status !== 'loading' && repoEntry.hasIcon
            ? buildRepoIconUrl(repoCwd)
            : undefined,
        }
      : undefined
  // The tooltip names the coding agent (preview wording: "Claude (freshclaude
  // pane)"), i.e. the runtime provider's display name — never the pane-type
  // label ("Freshclaude") that the picker surfaces.
  const freshAgentLabel = isFreshAgentPane
    ? FRESH_AGENT_RUNTIME_PROVIDER_LABELS[content.provider]
      ?? resolveFreshAgentType(content.sessionType)?.label
      ?? content.sessionType
    : undefined

  // TabBar is not mounted on every surface (e.g. initial mobile-landscape
  // terminal view) and its probe skips entirely when repoIconsOnTabs is off,
  // so the header owns the one-per-cwd probe for the icon it renders.
  useEffect(() => {
    if (repoCwd && !repoIconsByCwd[repoCwd]) {
      void dispatch(fetchRepoIconMeta(repoCwd))
    }
  }, [repoCwd, repoIconsByCwd, dispatch])
  const freshAgentDerivedTitle = isFreshAgentPane ? derivePaneTitle(content) : undefined
  const freshAgentTitle = title.trim()
  const freshAgentTitleMatchesMeta = isFreshAgentPane
    && !!metaLabel
    && !!freshAgentTitle
    && (metaLabel === freshAgentTitle || metaLabel.startsWith(`${freshAgentTitle} `))
  const isFreshAgentDefaultTitle = isFreshAgentPane && (title === freshAgentDerivedTitle || freshAgentTitleMatchesMeta)
  const freshAgentTitleRepeatsIdentity = isFreshAgentPane && freshAgentTitle.toLowerCase() === content.sessionType
  const freshAgentTitleLabel = isFreshAgentPane && freshAgentTitle
    ? (!isFreshAgentDefaultTitle || (!metaLabel && !freshAgentTitleRepeatsIdentity) ? title : undefined)
    : undefined
  const freshAgentMetaLabel = isFreshAgentPane && metaLabel && metaLabel !== freshAgentTitleLabel
    ? metaLabel
    : undefined
  const refreshButton = onRefresh ? (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onRefresh()
      }}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
      title="Refresh pane"
      aria-label="Refresh pane"
    >
      <RefreshCw className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
    </button>
  ) : null

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  return (
    <div
      className={cn(
        'pane-header flex h-[2.625rem] shrink-0 items-center border-b border-border text-sm sm:h-7',
        isFreshAgentPane ? 'pane-header--fresh-agent gap-1.5 px-1.5' : 'gap-2 px-2',
        needsAttention
          ? 'bg-emerald-50 border-l-2 border-l-emerald-500 dark:bg-emerald-900/30'
          : isActive ? 'bg-muted' : 'bg-muted/50 text-muted-foreground'
      )}
      data-context={ContextIds.PaneHeader}
      data-tab-id={tabId}
      data-pane-id={paneId}
      onDoubleClick={isRenaming ? undefined : onDoubleClick}
      role="banner"
      aria-label={`Pane: ${title}`}
    >
      {!isFreshAgentPane && repoIconInfo ? (
        <RepoIcon info={repoIconInfo} className="h-3.5 w-3.5 shrink-0" />
      ) : null}

      {!isFreshAgentPane ? (
        <PaneIcon
          content={content}
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            busy && status === 'running' ? 'text-blue-500' : getTerminalStatusIconClassName(status),
          )}
        />
      ) : null}

      {isFreshAgentPane ? (
        <>
          {freshAgentRepoIconInfo ? (
            <span
              title={`Repo: ${freshAgentRepoIconInfo.repoName}`}
              className="inline-flex shrink-0"
            >
              <RepoIcon info={freshAgentRepoIconInfo} className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <span
            title={`${freshAgentLabel} (${content.sessionType} pane)`}
            className="inline-flex shrink-0"
          >
            <PaneIcon
              content={content}
              className={cn(
                'h-3.5 w-3.5',
                busy && status === 'running' ? 'text-blue-500' : 'text-muted-foreground',
              )}
            />
          </span>
        </>
      ) : null}

      <div className={cn(
        'min-w-0 flex flex-1 items-center gap-1.5',
        isFreshAgentPane && 'pane-header-fresh-agent-title',
      )}>
        {isRenaming ? (
          <input
            ref={inputRef}
            className="bg-transparent outline-none w-full min-w-0 text-sm"
            value={renameValue ?? ''}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onBlur={onRenameBlur}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            aria-label="Rename pane"
            aria-invalid={renameError ? true : undefined}
          />
        ) : isFreshAgentPane ? (
          <>
            {freshAgentTitleLabel ? (
              <span className="pane-header-fresh-agent-detail block min-w-0 truncate" title={title}>
                {freshAgentTitleLabel}
              </span>
            ) : null}
            {freshAgentMetaLabel ? (
              <span
                className={cn(
                  'pane-header-fresh-agent-detail pane-header-fresh-agent-meta block min-w-0 truncate',
                  freshAgentTitleLabel ? 'text-muted-foreground' : undefined,
                )}
                title={metaTooltip || freshAgentMetaLabel}
              >
                {freshAgentMetaLabel}
              </span>
            ) : null}
          </>
        ) : (
          <span className="block min-w-0 truncate" title={title}>
            {title}
          </span>
        )}
      </div>

      <div className={cn(
        'pane-header-actions ml-auto flex h-full shrink-0 items-center',
        isFreshAgentPane ? 'gap-1.5' : 'gap-2',
      )}>
        {!isFreshAgentPane && metaLabel && (
          <span
            className="max-w-[18rem] truncate text-xs text-muted-foreground text-right"
            title={metaTooltip || metaLabel}
          >
            {metaLabel}
          </span>
        )}

        {onSearch && content.kind === 'terminal' && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSearch()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
            title="Search in terminal"
            aria-label="Search in terminal"
          >
            <Search className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
          </button>
        )}

        {!isFreshAgentPane ? refreshButton : null}

        {isFreshAgentPane ? (
          <div className="pane-header-fresh-agent-optional-action">
            <FreshAgentSettingsButton
              tabId={tabId}
              paneId={paneId}
              paneContent={content}
            />
          </div>
        ) : null}

        {isFreshAgentPane && refreshButton ? (
          <div className="pane-header-fresh-agent-optional-action">
            {refreshButton}
          </div>
        ) : null}

        {onToggleZoom && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleZoom()
            }}
            className={cn(
              'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4',
              isFreshAgentPane && 'pane-header-fresh-agent-optional-action',
            )}
            title={isZoomed ? 'Restore pane' : 'Maximize pane'}
            aria-label={isZoomed ? 'Restore pane' : 'Maximize pane'}
          >
            {isZoomed
              ? <Minimize2 className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
              : <Maximize2 className="h-[18px] w-[18px] sm:h-3 sm:w-3" />}
          </button>
        )}

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 hover:bg-background/50 transition-opacity sm:h-4 sm:w-4"
          title="Close pane"
          aria-label="Close pane"
        >
          <X className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
        </button>
      </div>
    </div>
  )
}
