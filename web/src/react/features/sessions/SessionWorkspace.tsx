import './agentControls.css'
import { memo, useEffect, useMemo, useState } from 'react'
import { formatContextLimit, formatTokenCount } from '../../../lib/formatTokens'
import { ChevronRight, Target, CheckCircle2, Circle, Clock, Cpu, FileEdit, FilePlus, FileX, File, Loader2, Users } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import type { AgentSession, SessionStats, TodoItem, AgentRunStep } from '../../../lib/api/agentRuntime'
import { SessionCapabilitiesPanel } from './SessionCapabilitiesPanel'
import { sumAgentTurnDurationMs } from './sumAgentTurnDuration'
import { useLocale } from '../../../hooks/useLocale'

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
  queued: 'bg-primary/12 text-primary',
  running: 'bg-[var(--color-run)]/15 text-[var(--color-run)]',
  waiting_permission: 'bg-warning/15 text-warning',
  waiting_input: 'bg-warning/15 text-warning',
  blocked: 'bg-warning/15 text-warning',
  completed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  paused: 'bg-run/15 text-run',
  interrupted: 'bg-warning/15 text-warning',
  cancelled: 'bg-foreground/10 text-foreground/70',
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

export function SessionStatusCard({
  stats,
  steps,
  todos,
}: {
  stats: SessionStats
  steps: AgentRunStep[]
  todos: TodoItem[]
}) {
  const { locale } = useLocale()
  const [tick, setTick] = useState(0)
  const isLive = stats.status === 'running' || steps.some(step => step.status === 'running')

  useEffect(() => {
    if (!isLive) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [isLive])

  const elapsed = useMemo(() => {
    if (steps.length > 0) return sumAgentTurnDurationMs(steps)
    return stats.runningDuration
  }, [steps, stats.runningDuration, tick])

  const badgeClass = STATUS_BADGE[stats.status] ?? 'bg-secondary/70 text-foreground/80'

  return (
    <div className="border-b border-border/40 px-2 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${badgeClass}`}>{stats.status === 'waiting_input' ? (locale === 'zh' ? '等待输入' : 'Waiting for input') : stats.status}</span>
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <Clock size={9} />{fmtDuration(elapsed)}
        </span>
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Usage</span><span>{stats.contextUsedPercent}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-secondary/60">
          <div
            className={`h-full rounded-full transition-all ${progressColor(stats.contextUsedPercent)}`}
            style={{ width: `${stats.contextUsedPercent}%` }}
          />
        </div>
        <div className="text-[8px] text-muted-foreground/60">
          {formatTokenCount(stats.tokenUsage.total)} / {formatContextLimit(stats.contextLimit)} context
        </div>
      </div>
      <TodoCard items={todos} />
      <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1"><Cpu size={9} />{stats.toolCallCount} calls</span>
        {stats.activeSubAgentCount > 0 && (
          <span className="flex items-center gap-1"><Users size={9} />{stats.activeSubAgentCount} active</span>
        )}
      </div>
    </div>
  )
}

const GOAL_STATUS_LABELS = {
  planning: ['规划中', 'Planning'],
  executing: ['执行中', 'Executing'],
  completed: ['目标已完成', 'Goal completed'],
  blocked: ['目标受阻', 'Goal blocked'],
  budget_exhausted: ['预算已耗尽', 'Budget exhausted'],
  cancelled: ['目标已取消', 'Goal cancelled'],
}

export function SessionModeSummary({ session }: { session: AgentSession }) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const { goal, plan, specialist } = session.sessionMetadata ?? {}
  const snapshot = specialist && typeof specialist === 'object' ? specialist as Record<string, unknown> : null
  const name = typeof snapshot?.name === 'string' ? snapshot.name : null
  const role = typeof snapshot?.role === 'string' ? snapshot.role : null
  if (!goal && !plan && !name && !role) return null
  const title = goal?.objective ?? plan?.title ?? name ?? role
  const status = goal ? (GOAL_STATUS_LABELS[goal.status]?.[zh ? 0 : 1] ?? goal.status)
    : plan ? (plan.status === 'approved' ? (zh ? '已批准' : 'Approved') : plan.status === 'saved' ? (zh ? '已保存' : 'Saved') : (zh ? '草稿' : 'Draft')) : null
  return (
    <details key={session.id} className="agent-summary" aria-label={zh ? '会话目标和角色' : 'Session goal and specialist'}>
      <summary>
        <ChevronRight size={11} aria-hidden className="agent-disclosure-arrow" />
        <Target size={11} aria-hidden className="shrink-0 opacity-65" />
        <span className="min-w-0 flex-1 truncate" title={title ?? undefined}>{title}</span>
        {status && <span role="status" className="shrink-0 text-[10px] opacity-80">{status}</span>}
      </summary>
      <div className="agent-context-body space-y-2">
        {(name || role) && <p><strong className="font-medium">{zh ? '专家：' : 'Specialist: '}{name}</strong>{role && <span> — {role}</span>}</p>}
        {plan && <p>{zh ? '计划' : 'Plan'} v{plan.revision}: {plan.title}</p>}
        {goal && <>
          <p className="whitespace-pre-wrap text-foreground/85">{goal.objective}</p>
          <div className="grid gap-3 sm:grid-cols-2 text-[11px]">
            <label>{zh ? '步骤预算' : 'Step budget'}: {goal.stepsUsed} / {goal.maxSteps}
              <progress aria-label={zh ? '步骤预算' : 'Step budget'} className="agent-budget-bar" value={goal.stepsUsed} max={Math.max(1, goal.maxSteps)} />
            </label>
            <label>{zh ? 'Token 预算' : 'Token budget'}: {formatTokenCount(goal.tokensUsed)} / {formatTokenCount(goal.maxTokens)}
              <progress aria-label={zh ? 'Token 预算' : 'Token budget'} className="agent-budget-bar" value={goal.tokensUsed} max={Math.max(1, goal.maxTokens)} />
            </label>
          </div>
        </>}
      </div>
      {goal?.reason && <p className="pb-1 text-[11px] leading-relaxed text-warning">{goal.reason}</p>}
    </details>
  )
}

function TodoCard({ items }: { items: TodoItem[] }) {
  const hasItems = items.length > 0
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!hasItems) {
      setOpen(false)
      return
    }
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [hasItems])

  if (!hasItems) return null

  const done = items.filter(i => i.status === 'done').length

  return (
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-out"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div className="overflow-hidden">
        <div
          className={`rounded-md border border-border/40 bg-muted/20 px-1.5 py-1.5 transition-opacity duration-300 ${
            open ? 'opacity-100' : 'opacity-0'
          }`}
        >
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
      </div>
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

export const SessionWorkspace = memo(function SessionWorkspace() {
  const session = useAgentSessionStore(s => s.sessions.find(item => item.id === s.selectedSessionId))
  const { events, sessionStats, sessionTodos, sessionCapabilities, steps } = useAgentSessionStore(useShallow(s => ({
    events: s.events,
    sessionStats: s.sessionStats,
    sessionTodos: s.sessionTodos,
    sessionCapabilities: s.sessionCapabilities,
    steps: s.steps,
  })))

  const fileChanges = useMemo<FileChange[]>(() => {
    const paths = new Map<string, FileChange>()
    for (const item of events) {
      const p = (item as { payload: Record<string, unknown> }).payload
      if ((p?.mutability as string) !== 'write') continue
      const input = (p.inputSummary as string) ?? ''
      const match = input.match(/^(\S+)/)
      if (match) paths.set(match[1], { path: match[1], changeType: 'modified' })
    }
    return [...paths.values()]
  }, [events])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-[10px]">
      {session && <SessionModeSummary session={session} />}
      {sessionStats ? (
        <SessionStatusCard stats={sessionStats} steps={steps} todos={sessionTodos} />
      ) : sessionTodos.length > 0 ? (
        <div className="border-b border-border/40 px-2 py-2">
          <TodoCard items={sessionTodos} />
        </div>
      ) : null}
      {sessionCapabilities && <SessionCapabilitiesPanel capabilities={sessionCapabilities} />}
      <FilesCard files={fileChanges} />
    </div>
  )
})
