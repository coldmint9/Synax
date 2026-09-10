import { memo, useEffect, useState } from 'react'
import { Bot, FileCode2, FileDiff, GitBranch, GitCommit, LayoutDashboard, RefreshCw } from 'lucide-react'
import { agentRuntimeApi, type SessionEnvironment } from '../../../lib/api/agentRuntime'
import { useAgentSessionStore } from './agentSessionStore'
import { openWorkspaceDiff, openWorkspaceFile, openWorkspaceSubagent } from './sessionWorkspaceStore'

const REFRESH_MS = 8000

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

export const WorkspaceDashboard = memo(function WorkspaceDashboard({ sessionId }: { sessionId: string | null }) {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      setEnvironment(await agentRuntimeApi.getSessionEnvironment(sessionId))
    } catch {
      setEnvironment(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    if (!sessionId) return
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [sessionId])

  const recentFiles = (environment?.inputFiles ?? []).slice(-8).reverse()
  const changedFiles = environment?.changedFiles ?? []

  return (
    <div className="workspace-dashboard min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex items-center gap-1.5">
        <LayoutDashboard size={12} className="text-primary" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">工作区</span>
        <button
          type="button"
          className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => void load()}
          disabled={loading || !sessionId}
          aria-label="刷新工作区"
          title="刷新工作区"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!sessionId ? (
        <div className="py-10 text-center text-[10px] text-muted-foreground/60">选择会话后查看工作区</div>
      ) : environment ? (
        <>
          <div className="mt-2 rounded-md border border-border/30 bg-secondary/15 px-2.5 py-2 text-[10px]">
            <div className="flex items-center gap-1.5">
              <GitBranch size={10} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{environment.branch}</span>
              <span className="shrink-0 text-muted-foreground">{environment.dirty ? 'dirty' : 'clean'}</span>
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

          <DashboardSection title="Subagents" count={environment.subagents.length}>
            {environment.subagents.length === 0 ? (
              <div className="px-1 py-3 text-center text-[9px] text-muted-foreground/55">暂无 Subagent</div>
            ) : (
              environment.subagents.map(sub => (
                <button
                  key={sub.id}
                  type="button"
                  className="flex w-full min-w-0 items-start gap-1.5 rounded px-1.5 py-1.5 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceSubagent(sub.id, sub.title ?? sub.id.slice(0, 8))}
                >
                  <Bot size={11} className="mt-0.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-foreground/85">{sub.title ?? 'Subagent'}</span>
                    <span className="mt-0.5 line-clamp-1 text-[9px] text-muted-foreground/60">{sub.prompt}</span>
                  </span>
                  <span className={`shrink-0 text-[9px] ${statusTone(sub.status)}`}>{statusText(sub.status)}</span>
                </button>
              ))
            )}
          </DashboardSection>

          <DashboardSection title="Git 变更" count={changedFiles.length}>
            {changedFiles.length === 0 ? (
              <div className="px-1 py-3 text-center text-[9px] text-muted-foreground/55">无变更</div>
            ) : (
              changedFiles.slice(0, 12).map(file => (
                <button
                  key={`${file.status}:${file.path}`}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceDiff(file.path)}
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
                  className="flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left transition hover:bg-secondary/50"
                  onClick={() => openWorkspaceFile(path)}
                >
                  <FileCode2 size={10} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/75">{path}</span>
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
