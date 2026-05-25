import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, Clock, Cpu, FileEdit, FilePlus, FileX, File, Loader2, Users } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import type { SessionStats, TodoItem } from '../../../lib/api/agentRuntime'

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function progressColor(percent: number): string {
  if (percent > 85) return 'bg-danger'
  if (percent > 60) return 'bg-warning'
  return 'bg-success'
}

const STATUS_BADGE: Record<string, string> = {
  running: 'bg-[var(--color-run)]/15 text-[var(--color-run)]',
  completed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  paused: 'bg-sky-400/15 text-sky-400',
  interrupted: 'bg-amber-400/15 text-amber-400',
}

interface FileChange {
  path: string
  changeType: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
}
const CHANGE_ICON = { added: FilePlus, modified: FileEdit, deleted: FileX, renamed: File, unknown: File }
const CHANGE_COLOR = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
}

function SessionStatusCard({ stats }: { stats: SessionStats }) {
  const [elapsed, setElapsed] = useState(stats.runningDuration)

  useEffect(() => {
    if (stats.status !== 'running') { setElapsed(stats.runningDuration); return }
    const start = Date.now() - stats.runningDuration
    const t = setInterval(() => setElapsed(Date.now() - start), 1000)
    return () => clearInterval(t)
  }, [stats.runningDuration, stats.status])

  const badgeClass = STATUS_BADGE[stats.status] ?? 'bg-muted text-muted-foreground'

  return (
    <div className="border-b border-border/40 px-2 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${badgeClass}`}>{stats.status}</span>
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <Clock size={9} />{fmtDuration(elapsed)}
        </span>
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Context</span><span>{stats.contextUsedPercent}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-secondary/60">
          <div
            className={`h-full rounded-full transition-all ${progressColor(stats.contextUsedPercent)}`}
            style={{ width: `${stats.contextUsedPercent}%` }}
          />
        </div>
        <div className="text-[8px] text-muted-foreground/60">
          {(stats.tokenUsage.total / 1000).toFixed(1)}K / {(stats.contextLimit / 1000).toFixed(0)}K tokens
        </div>
      </div>
      <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1"><Cpu size={9} />{stats.toolCallCount} calls</span>
        {stats.activeSubAgentCount > 0 && (
          <span className="flex items-center gap-1"><Users size={9} />{stats.activeSubAgentCount} active</span>
        )}
      </div>
    </div>
  )
}

function TodoCard({ items }: { items: TodoItem[] }) {
  const { t } = useLocale()
  if (items.length === 0) {
    return (
      <div className="border-b border-border/40 px-2 py-2">
        <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">TODO</div>
        <div className="mt-1 text-[10px] text-muted-foreground/50">{t('sessionNoPlans')}</div>
      </div>
    )
  }
  const done = items.filter(i => i.status === 'done').length
  return (
    <div className="border-b border-border/40 px-2 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">TODO</span>
        <span className="text-[9px] text-muted-foreground/60">{done}/{items.length}</span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {items.map(item => (
          <li key={item.id} className="flex items-center gap-1.5 text-[10px]">
            {item.status === 'done' && <CheckCircle2 size={10} className="shrink-0 text-success" />}
            {item.status === 'in_progress' && <Loader2 size={10} className="shrink-0 animate-spin text-warning" />}
            {item.status === 'pending' && <Circle size={10} className="shrink-0 text-muted-foreground/40" />}
            <span className={item.status === 'done' ? 'line-through text-muted-foreground/60' : 'text-foreground/80'}>
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FilesCard({ files }: { files: FileChange[] }) {
  if (files.length === 0) return null
  return (
    <div className="px-2 py-2">
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
        Files ({files.length})
      </div>
      <ul className="space-y-0.5">
        {files.map(f => {
          const Icon = CHANGE_ICON[f.changeType]
          return (
            <li key={f.path} className="flex items-center gap-1.5 font-mono text-[10px]">
              <Icon size={10} className={`shrink-0 ${CHANGE_COLOR[f.changeType]}`} />
              <span className="truncate text-foreground/80" title={f.path}>
                {f.path.split('/').pop()}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function useHasWorkspaceContent(_mode: 'context' | 'agent'): boolean {
  return true
}

export function SessionWorkspace({ mode }: { mode: 'context' | 'agent' }) {
  const { t } = useLocale()
  const events = useDebugConsole(s => s.events)
  const sessionStats = useDebugConsole(s => s.sessionStats)
  const sessionTodos = useDebugConsole(s => s.sessionTodos)

  const fileChanges = useMemo<FileChange[]>(() => {
    if (mode !== 'agent') return []
    const paths = new Map<string, FileChange>()
    for (const item of events) {
      const p = (item as { payload: Record<string, unknown> }).payload
      if ((p?.mutability as string) !== 'write') continue
      const input = (p.inputSummary as string) ?? ''
      const match = input.match(/^(\S+)/)
      if (match) paths.set(match[1], { path: match[1], changeType: 'modified' })
    }
    return [...paths.values()]
  }, [mode, events])

  if (mode !== 'agent') {
    return (
      <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground/50">
        {t('sessionNoOutput')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-[10px]">
      {sessionStats && <SessionStatusCard stats={sessionStats} />}
      <TodoCard items={sessionTodos} />
      <FilesCard files={fileChanges} />
    </div>
  )
}
