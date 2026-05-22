import {
  ChevronRight,
  Clock,
  FolderCode,
  GitBranch,
  Sparkles,
  Trash2,
  Network,
  MessageSquare,
  Bot,
} from 'lucide-react'
import { formatProjectPath } from '../../lib/formatProjectPath'
import { Link } from 'react-router-dom'
import type { ProjectSummary } from '../state/shellStore'
import type { ProjectStats } from '../../lib/api/project'

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return `${Math.floor(diff / 86_400_000)}天前`
}

export function ProjectCard({
  project,
  stats,
  onDelete,
  showDelete = true,
  className,
}: {
  project: ProjectSummary
  stats?: ProjectStats | null
  onDelete?: () => void
  showDelete?: boolean
  className?: string
}) {
  const SourceIcon =
    project.source?.kind === 'github' || project.source?.kind === 'gitlab'
      ? GitBranch
      : project.source?.kind === 'scratch'
        ? Sparkles
        : FolderCode

  return (
    <div className={`project-card group ${className ?? ''}`.trim()}>
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`/projects/${project.id}/wiki`}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <SourceIcon size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {project.name}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          {project.importState && project.importState !== 'ready' && (
            <span className="import-state-badge" data-state={project.importState}>
              {project.importState === 'syncing' ? '同步中' : project.importState === 'failed' ? '失败' : '空闲'}
            </span>
          )}
          {showDelete && onDelete && (
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground/40 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              onClick={e => { e.preventDefault(); e.stopPropagation(); onDelete() }}
              title="删除项目"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {project.source && project.source.kind !== 'scratch' && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          <span className="max-w-[220px] truncate" title={formatProjectPath(project)}>
            {formatProjectPath(project)}
          </span>
        </div>
      )}

      {/* Real stats from backend */}
      {stats && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Network size={11} />
            {stats.nodeCount} 节点
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare size={11} />
            {stats.sessionCount} 会话
          </span>
          {stats.recentRunCount > 0 && (
            <span className="flex items-center gap-1">
              <Bot size={11} />
              {stats.recentRunCount} 运行
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
          <Clock size={10} />
          {stats?.lastActivity ? relativeTime(stats.lastActivity) : relativeTime(project.updatedAt === 'just now' ? new Date().toISOString() : project.updatedAt)}
        </div>
        <Link
          to={`/projects/${project.id}/wiki`}
          className="inline-flex shrink-0 items-center text-[10px] text-muted-foreground/40 transition hover:text-primary"
        >
          进入
          <ChevronRight size={10} />
        </Link>
      </div>
    </div>
  )
}
