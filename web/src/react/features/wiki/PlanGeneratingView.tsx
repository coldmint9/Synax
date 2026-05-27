import { useRef, useEffect, useState } from 'react'
import { Loader2, FileCode, AlertCircle, RotateCcw, Search, Brain, Send, CheckCircle2 } from 'lucide-react'
import { Button } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiEvaluation } from '../../../lib/api/evaluation'
import PlanDAGView from './PlanDAGView'

const PHASES = [
  { key: 'analyzing', labelKey: 'planPhaseAnalyzing' as const, icon: Search },
  { key: 'reading_source', labelKey: 'planPhaseReadingSource' as const, icon: FileCode },
  { key: 'planning', labelKey: 'planPhasePlanning' as const, icon: Brain },
  { key: 'submitting', labelKey: 'planPhaseSubmitting' as const, icon: Send },
] as const

interface Props {
  projectId: string
}

export default function PlanGeneratingView({ projectId }: Props) {
  const { t } = useLocale()
  const gen = useWikiStore(s => s.planGeneration)
  const evaluations = useWikiStore(s => s.evaluations)
  const resetPlanGeneration = useWikiStore(s => s.resetPlanGeneration)
  const logRef = useRef<HTMLDivElement>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(timer)
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
      <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
        {gen.previewNodes.length > 0 ? (
          <>
            <div ref={logRef} className="shrink-0 max-h-[180px] overflow-y-auto px-5 py-3 border-b border-border/10">
              <div className="max-w-2xl mx-auto space-y-3">
                <IssueContext issues={evaluations} />
                <ActivityFeed toolCalls={gen.toolCalls} text={gen.streamingText} />
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <PlanDAGView nodes={gen.previewNodes} isGenerating />
            </div>
          </>
        ) : (
          <div ref={logRef} className="flex-1 overflow-y-auto px-5 py-5">
            <div className="max-w-2xl mx-auto space-y-4">
              <IssueContext issues={evaluations} />
              <ActivityFeed toolCalls={gen.toolCalls} text={gen.streamingText} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseSteps({ current, elapsed }: { current: string | null; elapsed: number }) {
  const { t } = useLocale()
  const idx = PHASES.findIndex(p => p.key === current)
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="shrink-0 border-b border-border/15 px-5 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Loader2 size={13} className="animate-spin text-primary" />
          <span className="text-[12px] font-semibold text-foreground/80">{t('planGenerating')}</span>
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
                <span className="hidden sm:inline">{t(phase.labelKey)}</span>
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
  const { t } = useLocale()
  const active = issues.filter(e => e.status === 'active')
  if (active.length === 0) return null

  return (
    <div className="rounded-xl border border-border/20 bg-card/30 p-3">
      <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">{t('planAnalyzingIssues')}</span>
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
  const { t } = useLocale()
  if (toolCalls.length === 0 && !text) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center">
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
        <span className="ml-2 text-[11px] text-muted-foreground/40">{t('planAgentThinking')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {toolCalls.length > 0 && (
        <div className="rounded-xl border border-border/20 bg-card/30 p-3 space-y-1.5">
          <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">{t('planActivityLog')}</span>
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

function FailedView({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useLocale()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <div className="rounded-2xl border border-destructive/20 bg-destructive/[0.03] p-8 max-w-sm w-full text-center">
        <AlertCircle size={28} className="mx-auto mb-3 text-destructive/60" />
        <h3 className="text-[13px] font-semibold text-foreground/80">{t('planFailedTitle')}</h3>
        <p className="mt-2 text-[11px] text-muted-foreground/60">{error ?? t('planUnknownError')}</p>
        <Button size="sm" variant="ghost" className="mt-4" onPress={onRetry}>
          <RotateCcw size={12} />
          {t('planRetry')}
        </Button>
      </div>
    </div>
  )
}
