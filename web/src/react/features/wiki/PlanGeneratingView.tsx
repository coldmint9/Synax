import { useRef, useEffect, useState } from 'react'
import { Loader2, FileCode, AlertCircle, RotateCcw, Search, Brain, Send, CheckCircle2 } from 'lucide-react'
import { Button } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import type { PlanNodeDraft, WikiEvaluation } from '../../../lib/api/evaluation'

const PHASES = [
  { key: 'analyzing', label: '分析 Issues', icon: Search },
  { key: 'reading_source', label: '读取源码', icon: FileCode },
  { key: 'planning', label: '规划节点', icon: Brain },
  { key: 'submitting', label: '提交规划', icon: Send },
] as const

interface Props {
  projectId: string
}

export default function PlanGeneratingView({ projectId }: Props) {
  const gen = useWikiStore(s => s.planGeneration)
  const evaluations = useWikiStore(s => s.evaluations)
  const resetPlanGeneration = useWikiStore(s => s.resetPlanGeneration)
  const logRef = useRef<HTMLDivElement>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [gen.toolCalls.length, gen.streamingText])

  if (gen.status === 'failed') {
    return <FailedView error={gen.error} onRetry={resetPlanGeneration} />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PhaseSteps current={gen.phase} elapsed={elapsed} />
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="max-w-2xl mx-auto space-y-4">
          <IssueContext issues={evaluations} />
          <ActivityFeed toolCalls={gen.toolCalls} text={gen.streamingText} />
          {gen.previewNodes.length > 0 && <NodesPreview nodes={gen.previewNodes} />}
        </div>
      </div>
    </div>
  )
}

function PhaseSteps({ current, elapsed }: { current: string | null; elapsed: number }) {
  const idx = PHASES.findIndex(p => p.key === current)
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="shrink-0 border-b border-border/15 px-5 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Loader2 size={13} className="animate-spin text-primary" />
          <span className="text-[12px] font-semibold text-foreground/80">生成规划中</span>
        </div>
        <span className="text-[11px] font-mono text-muted-foreground/40">{mm}:{ss}</span>
      </div>
      <div className="flex items-center gap-1">
        {PHASES.map((phase, i) => {
          const Icon = phase.icon
          const done = i < idx
          const active = i === idx
          return (
            <div key={phase.key} className="flex items-center gap-1 flex-1">
              <div className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-all ${
                active ? 'bg-primary/10 text-primary' : done ? 'text-emerald-500' : 'text-muted-foreground/30'
              }`}>
                {done ? <CheckCircle2 size={10} /> : <Icon size={10} className={active ? 'animate-pulse' : ''} />}
                <span className="hidden sm:inline">{phase.label}</span>
              </div>
              {i < PHASES.length - 1 && (
                <div className={`h-px flex-1 ${done ? 'bg-emerald-500/40' : 'bg-border/20'}`} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// PLACEHOLDER_REMAINING_COMPONENTS

function IssueContext({ issues }: { issues: WikiEvaluation[] }) {
  const active = issues.filter(e => e.status === 'active')
  if (active.length === 0) return null

  return (
    <div className="rounded-xl border border-border/20 bg-card/30 p-3">
      <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">正在分析的 Issues</span>
      <div className="mt-2 space-y-1.5">
        {active.slice(0, 5).map(issue => (
          <div key={issue.id} className="flex items-start gap-2">
            <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/80" />
            <span className="text-[11px] text-foreground/70 leading-relaxed line-clamp-1">{issue.content}</span>
          </div>
        ))}
        {active.length > 5 && (
          <span className="text-[10px] text-muted-foreground/40">+{active.length - 5} more</span>
        )}
      </div>
    </div>
  )
}

function ActivityFeed({ toolCalls, text }: { toolCalls: { tool: string; summary: string }[]; text: string }) {
  if (toolCalls.length === 0 && !text) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center">
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
        <span className="ml-2 text-[11px] text-muted-foreground/40">Agent 正在思考…</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {toolCalls.length > 0 && (
        <div className="rounded-xl border border-border/20 bg-card/30 p-3 space-y-1.5">
          <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">活动日志</span>
          {toolCalls.map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
              <FileCode size={11} className="shrink-0 text-primary/50" />
              <span className="font-mono truncate">{c.summary || c.tool}</span>
            </div>
          ))}
        </div>
      )}
      {text && (
        <div className="rounded-xl border border-border/20 bg-card/30 p-3">
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground/60 font-mono leading-relaxed max-h-32 overflow-y-auto">
            {text.slice(-800)}
          </pre>
        </div>
      )}
    </div>
  )
}

function NodesPreview({ nodes }: { nodes: PlanNodeDraft[] }) {
  return (
    <div className="space-y-2">
      <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">规划节点预览</span>
      {nodes.map((node, i) => (
        <div key={i} className="rounded-xl border border-primary/20 bg-primary/[0.03] p-3">
          <h4 className="text-[12px] font-semibold text-foreground/85">{i + 1}. {node.title}</h4>
          {node.description && <p className="mt-1 text-[11px] text-muted-foreground/60 line-clamp-2">{node.description}</p>}
          {node.expectedFiles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {node.expectedFiles.map(f => (
                <span key={f} className="rounded-md bg-foreground/[0.04] border border-border/10 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60">{f}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function FailedView({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <div className="rounded-2xl border border-destructive/20 bg-destructive/[0.03] p-8 max-w-sm w-full text-center">
        <AlertCircle size={28} className="mx-auto mb-3 text-destructive/60" />
        <h3 className="text-[13px] font-semibold text-foreground/80">规划生成失败</h3>
        <p className="mt-2 text-[11px] text-muted-foreground/60">{error ?? '未知错误'}</p>
        <Button size="sm" variant="ghost" className="mt-4" onPress={onRetry}>
          <RotateCcw size={12} />
          重试
        </Button>
      </div>
    </div>
  )
}
