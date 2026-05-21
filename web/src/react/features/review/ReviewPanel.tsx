import { AlertTriangle, Check, CheckCircle2, Loader2, ShieldCheck, X, XCircle } from 'lucide-react'
import type { CoordNode } from '../../../lib/coordinates'
import type { GoalReviewPackage } from '../../../lib/api/review'
import { useReviewStore } from '../../state/reviewStore'

interface ReviewPanelProps {
  nodes: Record<string, CoordNode>
  onApply: (pkg: GoalReviewPackage) => void
  onClose: () => void
}

export function ReviewPanel({ nodes, onApply, onClose }: ReviewPanelProps) {
  const open = useReviewStore(s => s.panelOpen)
  const running = useReviewStore(s => s.running)
  const error = useReviewStore(s => s.error)
  const events = useReviewStore(s => s.events)
  const activeGoalId = useReviewStore(s => s.activeGoalId)
  const activeRunId = useReviewStore(s => s.activeRunId)
  const packagesById = useReviewStore(s => s.packagesById)
  const latestPackageByGoal = useReviewStore(s => s.latestPackageByGoal)
  const discardPackage = useReviewStore(s => s.discardPackage)
  const pkg =
    (activeRunId && packagesById[activeRunId]) ||
    (activeGoalId && packagesById[latestPackageByGoal[activeGoalId]]) ||
    null
  const goal = activeGoalId ? nodes[activeGoalId] : null

  if (!open) return null

  return (
    <div className="absolute right-3 top-14 z-40 flex max-h-[calc(100vh-5rem)] w-[460px] flex-col overflow-hidden rounded-lg border border-border/50 bg-card/95 shadow-xl backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck size={14} className="text-primary" />
            Goal 验收
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{goal?.label ?? activeGoalId ?? 'No goal selected'}</div>
        </div>
        <button className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {running && (
          <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2 text-xs text-primary">
            <Loader2 size={13} className="animate-spin" />
            Review Agent 正在检查子 Action 证据
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {pkg && (
          <div className="space-y-3">
            <div className="rounded-md border border-border/40 bg-background/50 px-3 py-2">
              <div className="flex items-center gap-2">
                {pkg.run.overallVerdict === 'accepted' ? (
                  <CheckCircle2 size={14} className="text-success" />
                ) : (
                  <XCircle size={14} className="text-destructive" />
                )}
                <span className="text-xs font-semibold">{pkg.run.overallVerdict}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{pkg.decisions.length} actions</span>
              </div>
              {pkg.run.summary && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{pkg.run.summary}</p>}
            </div>

            <div className="space-y-2">
              {pkg.decisions.map(decision => {
                const action = nodes[decision.actionId]
                const accepted = decision.verdict === 'accept'
                const blocked = decision.verdict === 'blocked'
                return (
                  <div key={decision.actionId} className="rounded-md border border-border/40 bg-background/50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      {accepted ? <CheckCircle2 size={13} className="text-success" /> : <XCircle size={13} className={blocked ? 'text-warning' : 'text-destructive'} />}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{action?.label ?? decision.actionId}</span>
                      <span className="text-[10px] text-muted-foreground">{Math.round(decision.confidence * 100)}%</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{decision.rationale}</p>
                    {decision.issues.length > 0 && (
                      <div className="mt-1 text-[11px] text-destructive/90">{decision.issues.join(' · ')}</div>
                    )}
                    {decision.suggestedPrompt && (
                      <div className="mt-1 rounded border border-border/30 bg-card/60 px-2 py-1 text-[11px] text-muted-foreground">
                        {decision.suggestedPrompt}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {pkg.improvementPlan.length > 0 && (
              <div className="rounded-md border border-border/40 bg-background/50 px-3 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">改进计划</div>
                <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                  {pkg.improvementPlan.map((item, idx) => <li key={idx}>{item}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {events.length > 0 && (
          <div className="rounded-md border border-border/40 bg-background/40">
            <div className="border-b border-border/30 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Agent Loop
            </div>
            <div className="max-h-48 overflow-y-auto px-2 py-1.5 space-y-1">
              {events.map((event, idx) => (
                <div key={idx} className="text-[10px] text-muted-foreground">
                  <span className="font-mono text-primary/80">{event.type}</span>
                  {'payload' in event && event.type === 'review_turn' && event.payload.tool ? ` · ${event.payload.tool}` : ''}
                  {'payload' in event && event.type === 'review_tool_result' ? ` · ${event.payload.resultSummary}` : ''}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {pkg && (
        <div className="flex justify-end gap-2 border-t border-border/40 px-3 py-2">
          <button
            className="rounded-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
            onClick={() => discardPackage(pkg.run.id)}
          >
            Discard
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
            onClick={() => onApply(pkg)}
          >
            <Check size={12} />
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
