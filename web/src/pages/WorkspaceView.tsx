/**
 * Workspace View — The project nerve center
 *
 * Not a dashboard. A living workspace where requirements, architecture,
 * tasks, and events flow together. The agent's insights appear inline.
 */

import { useState } from 'react'
import { cn } from '../lib/utils'
import {
  GitBranch, AlertTriangle, CheckCircle2, Clock, ArrowRight,
  Bot, User, BookOpen, Layers, FileText, Zap,
} from 'lucide-react'

// ─── Data ─────────────────────────────────────────────────────────────────

const TRACE_CHAIN = [
  { id: 'REQ-003', type: 'req' as const, title: '用户权限管理', status: 'in_progress' },
  { id: 'ADR-005', type: 'arch' as const, title: '认证方案决策', status: 'approved' },
  { id: 'T5', type: 'task' as const, title: 'Auth token refresh flow', status: 'in_progress' },
  { id: 'PR#42', type: 'git' as const, title: 'feat/auth-refresh', status: 'merged' },
]

const BLOCKERS = [
  { id: 'B1', title: 'DB migration blocked by infra', severity: 'high', task: 'T4', assignee: 'DevOps Agent', suggested: true },
  { id: 'B2', title: 'ADR-005 implementation mismatch', severity: 'medium', task: 'T5', assignee: 'Alice', suggested: false },
]

const MILESTONES = [
  { id: 'M1', name: 'Alpha Release', date: 'Apr 25', progress: 78, tasks: 12, done: 9, risk: 'low' },
  { id: 'M2', name: 'Beta Release', date: 'May 15', progress: 35, tasks: 20, done: 7, risk: 'medium' },
  { id: 'M3', name: 'GA Launch', date: 'Jun 01', progress: 10, tasks: 30, done: 3, risk: 'high' },
]

const AGENT_INSIGHTS = [
  { agent: 'PM Agent', insight: 'Sprint 还剩3天，当前速率不足以完成剩余6个任务。建议将 REQ-007 移至下个 Sprint。', action: 'Re-prioritize Sprint', confidence: 0.85 },
  { agent: 'Arch Agent', insight: 'ADR-005 与实现不一致：JWT vs Session。建议更新 ADR 或修改实现。', action: 'Resolve ADR mismatch', confidence: 0.92 },
  { agent: 'Wiki Agent', insight: 'PR #42 合并后，API 文档章节需要同步更新。', action: 'Sync API docs', confidence: 0.78 },
]

const TYPE_STYLES = {
  req: { color: 'text-req', bg: 'bg-req/10', border: 'border-req/20', icon: <FileText size={12} /> },
  arch: { color: 'text-arch', bg: 'bg-arch/10', border: 'border-arch/20', icon: <Layers size={12} /> },
  task: { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/20', icon: <CheckCircle2 size={12} /> },
  git: { color: 'text-agent', bg: 'bg-agent/10', border: 'border-agent/20', icon: <GitBranch size={12} /> },
  wiki: { color: 'text-wiki', bg: 'bg-wiki/10', border: 'border-wiki/20', icon: <BookOpen size={12} /> },
}

export function WorkspaceView() {
  const [expandedInsight, setExpandedInsight] = useState<string | null>(null)

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header — Context, not chrome */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-lg font-semibold">Synapse Project</h1>
          <span className="text-[10px] font-mono text-muted-foreground px-2 py-0.5 rounded-full bg-secondary">
            Sprint 14 · 3 days left
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          2 agents active · 1 human online · 1 blocker · 3 insights pending
        </p>
      </div>

      {/* Agent Insights — The Zero-Alignment in action */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Bot size={14} className="text-agent" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Agent Insights</span>
        </div>
        <div className="space-y-2">
          {AGENT_INSIGHTS.map(a => (
            <div
              key={a.agent}
              onClick={() => setExpandedInsight(expandedInsight === a.agent ? null : a.agent)}
              className={cn(
                'px-4 py-3 rounded-lg border transition-all cursor-pointer',
                'bg-agent/[0.03] border-agent/10 hover:border-agent/30',
                expandedInsight === a.agent && 'border-agent/30',
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-agent">{a.agent}</span>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      confidence: {(a.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{a.insight}</p>
                </div>
                {expandedInsight === a.agent && (
                  <button className="ml-3 flex-shrink-0 px-3 py-1 rounded-md text-xs font-medium bg-agent/10 text-agent hover:bg-agent/20 transition-colors flex items-center gap-1">
                    <Zap size={10} />
                    {a.action}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Trace Chain — Requirements → Architecture → Tasks → Code */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={14} className="text-primary" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active Trace Chain</span>
          <span className="text-[10px] font-mono text-muted-foreground ml-auto">REQ → ADR → Task → PR</span>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {TRACE_CHAIN.map((item, i) => {
            const style = TYPE_STYLES[item.type]
            return (
              <div key={item.id} className="flex items-center gap-2 flex-shrink-0">
                <div className={cn(
                  'px-3 py-2 rounded-lg border min-w-[160px]',
                  style.bg, style.border,
                )}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={style.color}>{style.icon}</span>
                    <span className={cn('text-[10px] font-mono font-medium', style.color)}>{item.id}</span>
                  </div>
                  <div className="text-xs leading-snug">{item.title}</div>
                </div>
                {i < TRACE_CHAIN.length - 1 && (
                  <ArrowRight size={14} className="text-muted-foreground flex-shrink-0" />
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Two-column: Blockers + Milestones */}
      <div className="grid grid-cols-2 gap-4">
        {/* Blockers */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={14} className="text-destructive" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Blockers</span>
          </div>
          <div className="space-y-2">
            {BLOCKERS.map(b => (
              <div key={b.id} className={cn(
                'px-4 py-3 rounded-lg border',
                b.severity === 'high' ? 'bg-destructive/5 border-destructive/20' : 'bg-warning/5 border-warning/20',
              )}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm">{b.title}</span>
                  <span className={cn(
                    'text-[9px] font-mono px-1.5 py-0.5 rounded',
                    b.severity === 'high' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning',
                  )}>
                    {b.severity}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Affects: {b.task} · {b.assignee}</span>
                  {b.suggested && (
                    <button className="text-[10px] font-mono px-2 py-0.5 rounded bg-agent/10 text-agent hover:bg-agent/20 transition-colors">
                      Auto-resolve →
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Milestones */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Milestones</span>
          </div>
          <div className="space-y-2">
            {MILESTONES.map(m => (
              <div key={m.id} className="px-4 py-3 rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground ml-2">{m.date}</span>
                  </div>
                  <span className={cn(
                    'text-[9px] font-mono px-1.5 py-0.5 rounded',
                    m.risk === 'high' ? 'bg-destructive/10 text-destructive' :
                    m.risk === 'medium' ? 'bg-warning/10 text-warning' :
                    'bg-success/10 text-success',
                  )}>
                    {m.risk} risk
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${m.progress}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-muted-foreground w-16 text-right">
                    {m.done}/{m.tasks}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Role Status Bar */}
      <section className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card">
        <span className="text-xs text-muted-foreground">Team:</span>
        {[
          { name: 'PM Agent', kind: 'agent' as const, status: 'active' },
          { name: 'Alice', kind: 'human' as const, status: 'active' },
          { name: 'QA Agent', kind: 'agent' as const, status: 'active' },
          { name: 'DevOps Agent', kind: 'agent' as const, status: 'idle' },
          { name: 'Bob', kind: 'human' as const, status: 'offline' },
          { name: 'Product Agent', kind: 'agent' as const, status: 'idle' },
        ].map(r => (
          <div key={r.name} className="flex items-center gap-1.5">
            {r.kind === 'agent' ? <Bot size={11} className="text-agent" /> : <User size={11} className="text-human" />}
            <span className={cn(
              'text-[11px]',
              r.status === 'active' ? 'text-foreground' : 'text-muted-foreground',
            )}>{r.name}</span>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full',
              r.status === 'active' ? 'bg-success' : r.status === 'idle' ? 'bg-warning' : 'bg-muted-foreground/30',
            )} />
          </div>
        ))}
      </section>
    </div>
  )
}
