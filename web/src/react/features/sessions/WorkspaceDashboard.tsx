import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, FileCode2, FileDiff, GitBranch, GitCommit, RefreshCw } from 'lucide-react'
import type { SessionEnvironment } from '../../../lib/api/agentRuntime'
import { copyTextToClipboard } from '../../../lib/clipboard'
import { openWorkspaceDiff, openWorkspaceFile, openWorkspaceSubagent } from './sessionWorkspaceStore'
import { useSessionEnvironment } from './useSessionEnvironment'

/** Input files are listed by basename; the full path stays available on hover
 *  and via right-click, which copies it. */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function statusText(status: string): string {
  switch (status) {
    case 'running': return '运行中'
    case 'waiting_permission': return '等待授权'
    case 'blocked': return '已阻塞'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    case 'paused': return '已暂停'
    default: return status
  }
}

function statusTone(status: string): string {
  switch (status) {
    case 'running': return 'text-[var(--color-run)]'
    case 'completed': return 'text-success'
    case 'failed': return 'text-danger'
    case 'waiting_permission':
    case 'blocked': return 'text-warning'
    default: return 'text-muted-foreground'
  }
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

  const recentFiles = (environment?.inputFiles ?? []).slice(-8).reverse()
  const changedFiles = environment?.changedFiles ?? []

  return (
    <div className="workspace-dashboard session-workspace-scroll min-h-0 flex-1 overflow-y-auto p-3">
      {!sessionId ? (
        <div className="py-10 text-center text-[10px] text-muted-foreground/60">选择会话后查看工作区</div>
      ) : environment ? (
        <>
          <div className="rounded-md border border-border/30 bg-secondary/15 px-2.5 py-2 text-[10px]">
            <div className="flex items-center gap-1.5">
              <GitBranch size={10} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{environment.branch}</span>
              <span className="shrink-0 text-muted-foreground">{environment.dirty ? 'dirty' : 'clean'}</span>
              <button
                type="button"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                onClick={() => void reload()}
                disabled={loading}
                aria-label="刷新工作区"
                title="刷新工作区"
              >
                <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
              <GitCommit size={10} className="shrink-0" />
              <span className="font-mono">{environment.headCommitSha.slice(0, 8)}</span>
              <span className="ml-auto font-mono">
                <span className="text-success">+{environment.additions}</span>
                <span className="mx-0.5">/</span>
                <span className="text-danger">-{environment.deletions}</span>
              </span>
            </div>
          </div>

          {/* Only meaningful once the session actually spawned subagents — an
              empty placeholder here is pure noise. */}
          {environment.subagents.length > 0 ? (
            <DashboardSection title="Subagents" count={environment.subagents.length}>
              {environment.subagents.map(sub => (
                <button
                  key={sub.id}
                  type="button"
                  className="flex w-full min-w-0 items-start gap-1.5 rounded px-1.5 py-1.5 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceSubagent(sessionId, sub.id, sub.title ?? sub.id.slice(0, 8))}
                >
                  <Bot size={11} className="mt-0.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-foreground/85">{sub.title ?? 'Subagent'}</span>
                    <span className="mt-0.5 line-clamp-1 text-[9px] text-muted-foreground/60">{sub.prompt}</span>
                  </span>
                  <span className={`shrink-0 text-[9px] ${statusTone(sub.status)}`}>{statusText(sub.status)}</span>
                </button>
              ))}
            </DashboardSection>
          ) : null}

          <DashboardSection title="Git 变更" count={changedFiles.length}>
            {changedFiles.length === 0 ? (
              <div className="px-1 py-3 text-center text-[9px] text-muted-foreground/55">无变更</div>
            ) : (
              changedFiles.slice(0, 12).map(file => (
                <button
                  key={`${file.status}:${file.path}`}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceDiff(sessionId, file.path)}
                >
                  <FileDiff size={10} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/75">{file.path}</span>
                </button>
              ))
            )}
          </DashboardSection>

          <DashboardSection title="输入文件" count={recentFiles.length}>
            {recentFiles.length === 0 ? (
              <div className="px-1 py-3 text-center text-[9px] text-muted-foreground/55">暂无读取文件</div>
            ) : (
              recentFiles.map(path => (
                <button
                  key={path}
                  type="button"
                  title={path}
                  className="flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceFile(sessionId, path)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    void copyPath(path)
                  }}
                >
                  {copiedPath === path ? (
                    <Check size={10} className="shrink-0 text-success" />
                  ) : (
                    <FileCode2 size={10} className="shrink-0 text-primary" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/75">{baseName(path)}</span>
                </button>
              ))
            )}
          </DashboardSection>
        </>
      ) : loading ? (
        <div className="py-10 text-center text-[10px] text-muted-foreground/60">加载工作区…</div>
      ) : null}
    </div>
  )
})

function DashboardSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        <span className="ml-auto">{count}</span>
      </div>
      <div className="mt-1 rounded-md border border-border/30 bg-secondary/10 p-1">{children}</div>
    </div>
  )
}
