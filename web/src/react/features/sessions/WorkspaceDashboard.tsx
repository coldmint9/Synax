import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, Check, ChevronDown, FileCode2, FileDiff, GitBranch, GitCommit, RefreshCw } from 'lucide-react'
import type {
  EnvironmentChangeStatus,
  SessionEnvironment,
  SessionEnvironmentFile,
  SessionEnvironmentSubagent,
} from '../../../lib/api/agentRuntime'
import { copyTextToClipboard } from '../../../lib/clipboard'
import { useLocale } from '../../../hooks/useLocale'
import type { I18nKey } from '../../../lib/i18n'
import { openWorkspaceDiff, openWorkspaceFile, openWorkspaceSubagent } from './sessionWorkspaceStore'
import { SessionCommitDialog } from './SessionCommitDialog'
import { useSessionEnvironment } from './useSessionEnvironment'

/** Split a workspace path so the panel can keep the file name readable while
 *  the directory prefix truncates first. */
function splitPath(filePath: string): { dir: string; name: string } {
  const parts = filePath.split(/[\\/]/)
  const name = parts.pop() || filePath
  return { dir: shortenDir(parts.join('/')), name }
}

/** Keep the two deepest segments: the tail says more than the repo prefix. */
function shortenDir(dir: string): string {
  const segments = dir.split('/').filter(Boolean)
  if (segments.length === 0) return ''
  const tail = segments.slice(-2).join('/')
  return segments.length > 2 ? `…/${tail}/` : `${tail}/`
}

const STATUS_KEY: Record<string, I18nKey> = {
  queued: 'workspaceStatusQueued',
  running: 'workspaceStatusRunning',
  waiting_permission: 'workspaceStatusWaitingPermission',
  blocked: 'workspaceStatusBlocked',
  completed: 'workspaceStatusCompleted',
  failed: 'workspaceStatusFailed',
  cancelled: 'workspaceStatusCancelled',
  interrupted: 'workspaceStatusInterrupted',
  paused: 'workspaceStatusPaused',
}

function statusText(status: string, t: ReturnType<typeof useLocale>['t']): string {
  const key = STATUS_KEY[status]
  return key ? t(key) : status
}

const STATUS_CHIP: Record<string, string> = {
  queued: 'bg-primary/12 text-primary',
  running: 'bg-[var(--color-run)]/15 text-[var(--color-run)]',
  waiting_permission: 'bg-warning/15 text-warning',
  blocked: 'bg-warning/15 text-warning',
  paused: 'bg-warning/15 text-warning',
  interrupted: 'bg-warning/15 text-warning',
  completed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  cancelled: 'bg-foreground/10 text-foreground/70',
}

const CHANGE_META: Record<EnvironmentChangeStatus, { letter: string; tone: string; labelKey: I18nKey }> = {
  added: { letter: 'A', tone: 'bg-success/15 text-success', labelKey: 'workspaceChangeAdded' },
  modified: { letter: 'M', tone: 'bg-warning/15 text-warning', labelKey: 'workspaceChangeModified' },
  deleted: { letter: 'D', tone: 'bg-danger/15 text-danger', labelKey: 'workspaceChangeDeleted' },
  renamed: { letter: 'R', tone: 'bg-primary/15 text-primary', labelKey: 'workspaceChangeRenamed' },
  untracked: { letter: 'U', tone: 'bg-primary/15 text-primary', labelKey: 'workspaceChangeUntracked' },
  unknown: { letter: '?', tone: 'bg-foreground/10 text-muted-foreground', labelKey: 'workspaceChangeUnknown' },
}

/**
 * Subagent sessions usually have no title of their own, so fall back to the
 * first heading line of the prompt instead of showing a column of "Subagent".
 */
function subagentHeadline(sub: SessionEnvironmentSubagent): string {
  const title = sub.title?.trim()
  if (title && title.toLowerCase() !== 'subagent') return title
  const [firstLine] = sub.prompt.split('\n')
  const cleaned = (firstLine ?? '').replace(/^#+\s*/, '').trim()
  return cleaned || 'Subagent'
}

/** Prompt preview with the headline line removed so the two lines differ. */
function subagentPreview(sub: SessionEnvironmentSubagent): string {
  const lines = sub.prompt.split('\n').map(line => line.trim()).filter(Boolean)
  const hasHeadline = !sub.title?.trim() || sub.title.trim().toLowerCase() === 'subagent'
  const body = (hasHeadline ? lines.slice(1) : lines).join(' ')
  return body || sub.prompt.trim()
}

export const WorkspaceDashboard = memo(function WorkspaceDashboard({
  sessionId,
  environment: providedEnvironment,
  loading: providedLoading,
  reload: providedReload,
}: {
  sessionId: string | null
  environment?: SessionEnvironment | null
  loading?: boolean
  reload?: () => void | Promise<void>
}) {
  const { t } = useLocale()
  // The workspace panel already polls this snapshot; only fall back to owning
  // the request when rendered standalone.
  const owned = useSessionEnvironment(providedEnvironment === undefined ? sessionId : null)
  const environment = providedEnvironment === undefined ? owned.environment : providedEnvironment
  const loading = providedLoading ?? owned.loading
  const reload = providedReload ?? owned.reload
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const copiedTimer = useRef<number | null>(null)

  const copyPath = useCallback(async (filePath: string) => {
    // Only claim success when the write actually landed.
    if (!await copyTextToClipboard(filePath)) return
    setCopiedPath(filePath)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopiedPath(null), 1200)
  }, [])

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
  }, [])

  const recentFiles = useMemo(
    () => (environment?.inputFiles ?? []).slice(-8).reverse(),
    [environment?.inputFiles],
  )
  const changedFiles = environment?.changedFiles ?? []
  const subagents = environment?.subagents ?? []
  const runningSubagents = subagents.filter(sub => sub.status === 'running').length
  const stagedFiles = changedFiles.filter(file => file.staged).length

  return (
    <div className="workspace-dashboard session-workspace-scroll min-h-0 flex-1 overflow-y-auto">
      {!sessionId ? (
        <div className="ws-placeholder">{t('workspaceSelectSession')}</div>
      ) : environment ? (
        <>
          <RepositoryCard environment={environment} loading={loading} reload={reload} />

          {/* Only meaningful once the session actually spawned subagents — an
              empty placeholder here is pure noise. */}
          {subagents.length > 0 ? (
            <WorkspaceCard
              icon={<Bot size={11} />}
              title={t('workspaceCardSubagents')}
              count={subagents.length}
              summary={runningSubagents > 0 ? t('workspaceRunningCount', { count: runningSubagents }) : null}
            >
              {subagents.map(sub => (
                <SubagentRow
                  key={sub.id}
                  sub={sub}
                  onOpen={() => openWorkspaceSubagent(sessionId, sub.id, subagentHeadline(sub))}
                />
              ))}
            </WorkspaceCard>
          ) : null}

          <WorkspaceCard
            icon={<FileDiff size={11} />}
            title={t('workspaceCardGitChanges')}
            count={changedFiles.length}
            summary={stagedFiles > 0 ? t('workspaceStagedCount', { count: stagedFiles }) : null}
          >
            {changedFiles.length === 0 ? (
              <div className="ws-empty">{t('workspaceNoChanges')}</div>
            ) : (
              changedFiles.map(file => (
                <ChangedFileRow
                  key={`${file.status}:${file.path}`}
                  file={file}
                  onOpen={() => openWorkspaceDiff(sessionId, file.path)}
                />
              ))
            )}
          </WorkspaceCard>

          <WorkspaceCard icon={<FileCode2 size={11} />} title={t('workspaceCardInputFiles')} count={recentFiles.length}>
            {recentFiles.length === 0 ? (
              <div className="ws-empty">{t('workspaceNoInputFiles')}</div>
            ) : (
              recentFiles.map(path => (
                <InputFileRow
                  key={path}
                  path={path}
                  copied={copiedPath === path}
                  onOpen={() => openWorkspaceFile(sessionId, path)}
                  onCopy={() => void copyPath(path)}
                />
              ))
            )}
          </WorkspaceCard>
        </>
      ) : loading ? (
        <div className="ws-placeholder">{t('workspaceLoading')}</div>
      ) : null}
    </div>
  )
})

/** Collapsible card: header stays visible, the list scrolls inside the body. */
function WorkspaceCard({
  icon,
  title,
  count,
  summary,
  children,
}: {
  icon: ReactNode
  title: string
  count: number
  summary?: string | null
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)

  return (
    <section className="ws-card" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="ws-card-head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="ws-card-icon">{icon}</span>
        <span className="ws-card-title">{title}</span>
        <span className="ws-card-count">{count}</span>
        <span className="ws-card-tail">
          {summary ? <span className="ws-card-summary">{summary}</span> : null}
          <ChevronDown size={11} className="ws-card-chevron" />
        </span>
      </button>
      {open ? <div className="ws-card-body">{children}</div> : null}
    </section>
  )
}

function RepositoryCard({
  environment,
  loading,
  reload,
}: {
  environment: SessionEnvironment
  loading: boolean
  reload: () => void | Promise<void>
}) {
  const { t } = useLocale()
  const [commitOpen, setCommitOpen] = useState(false)
  const changedCount = environment.changedFiles.length
  return (
    <section className="ws-card ws-card--repo">
      <div className="ws-repo-head">
        <GitBranch size={11} className="ws-repo-icon" />
        <span className="ws-repo-branch" title={environment.branch}>{environment.branch}</span>
        <span className={`ws-repo-state ${environment.dirty ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}>
          {environment.dirty ? 'dirty' : 'clean'}
        </span>
        <button
          type="button"
          className="ws-repo-action"
          onClick={() => setCommitOpen(true)}
          disabled={loading || changedCount === 0}
          title={t('workspaceCommitPush')}
        >
          <GitCommit size={10} />
          <span>{t('workspaceCommitPush')}</span>
        </button>
        <button
          type="button"
          className="ws-icon-button"
          onClick={() => void reload()}
          disabled={loading}
          aria-label={t('workspaceRefresh')}
          title={t('workspaceRefresh')}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="ws-repo-meta">
        <span className="ws-repo-meta-item">
          <GitCommit size={10} />
          <span className="ws-mono">{environment.headCommitSha.slice(0, 8)}</span>
        </span>
        <span className="ws-repo-meta-item ws-mono">
          <span className="text-success">+{environment.additions}</span>
          <span className="ws-repo-sep">/</span>
          <span className="text-danger">-{environment.deletions}</span>
        </span>
      </div>
      {environment.workspacePath ? (
        <div className="ws-repo-path" title={environment.workspacePath}>{environment.workspacePath}</div>
      ) : null}
      <SessionCommitDialog
        isOpen={commitOpen}
        sessionId={environment.sessionId}
        branch={environment.branch}
        changedFiles={changedCount}
        onClose={() => setCommitOpen(false)}
        onCommitted={() => void reload()}
      />
    </section>
  )
}

function SubagentRow({ sub, onOpen }: { sub: SessionEnvironmentSubagent; onOpen: () => void }) {
  const { t } = useLocale()
  return (
    <button type="button" className="ws-row ws-row--subagent" onClick={onOpen}>
      <Bot size={11} className="ws-row-icon" />
      <span className="ws-row-main">
        <span className="ws-row-file">{subagentHeadline(sub)}</span>
        <span className="ws-row-sub">{subagentPreview(sub)}</span>
      </span>
      <span className={`ws-chip ${STATUS_CHIP[sub.status] ?? 'bg-foreground/10 text-foreground/70'}`}>
        {statusText(sub.status, t)}
      </span>
    </button>
  )
}

function ChangedFileRow({ file, onOpen }: { file: SessionEnvironmentFile; onOpen: () => void }) {
  const { t } = useLocale()
  const meta = CHANGE_META[file.status] ?? CHANGE_META.unknown
  const { dir, name } = splitPath(file.path)
  const hasStats = file.additions > 0 || file.deletions > 0

  return (
    <button type="button" className="ws-row" title={file.path} onClick={onOpen}>
      <span className={`ws-badge ${meta.tone}`} title={t(meta.labelKey)}>{meta.letter}</span>
      <span className="ws-row-main ws-row-main--file">
        {dir ? <span className="ws-row-dir">{dir}</span> : null}
        <span className="ws-row-file">{name}</span>
      </span>
      {hasStats ? (
        <span className="ws-row-diff ws-mono">
          {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="text-danger">-{file.deletions}</span> : null}
        </span>
      ) : null}
    </button>
  )
}

function InputFileRow({
  path,
  copied,
  onOpen,
  onCopy,
}: {
  path: string
  copied: boolean
  onOpen: () => void
  onCopy: () => void
}) {
  const { dir, name } = splitPath(path)

  return (
    <button
      type="button"
      className="ws-row"
      title={path}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        onCopy()
      }}
    >
      {copied ? (
        <Check size={11} className="ws-row-icon text-success" />
      ) : (
        <FileCode2 size={11} className="ws-row-icon" />
      )}
      <span className="ws-row-main ws-row-main--file">
        {dir ? <span className="ws-row-dir">{dir}</span> : null}
        <span className="ws-row-file">{name}</span>
      </span>
    </button>
  )
}
