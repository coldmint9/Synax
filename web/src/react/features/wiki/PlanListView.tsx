import { ListChecks, CheckCircle2, Loader2, Clock } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import { type WikiPlanWithSummary } from '../../../lib/api/evaluation'
import { relativeTime } from './PlanNodeCard'

interface Props {
  projectId: string
}

function PlanStatusBadge({ status }: { status: WikiPlanWithSummary['status'] }) {
  const map: Record<string, { label: string; icon: typeof CheckCircle2; cls: string }> = {
    draft: { label: '草案', icon: Clock, cls: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
    confirmed: { label: '已确认', icon: CheckCircle2, cls: 'bg-primary/10 text-primary border-primary/20' },
    executing: { label: '执行中', icon: Loader2, cls: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
    reviewing: { label: '审查中', icon: Clock, cls: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
    committing: { label: '提交中', icon: Loader2, cls: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
    completed: { label: '已完成', icon: CheckCircle2, cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
  }
  const { label, icon: Icon, cls } = map[status] ?? map.draft
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      <Icon size={10} className={status === 'executing' || status === 'committing' ? 'animate-spin' : ''} />
      {label}
    </span>
  )
}

export default function PlanListView({ projectId }: Props) {
  const plans = useWikiStore(s => s.plans)
  const loading = useWikiStore(s => s.loading.plans)
  const selectPlan = useWikiStore(s => s.selectPlan)
  const selectedPlanId = useWikiStore(s => s.selectedPlanId)

  if (loading && plans.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted-foreground/40" />
      </div>
    )
  }

  if (plans.length === 0) {
    return <EmptyState />
  }

  const activePlan = plans.find(p => p.status !== 'completed')
  const completedPlans = plans.filter(p => p.status === 'completed')

  return (
    <div className="px-3 py-3 space-y-2">
      {activePlan && (
        <PlanRow plan={activePlan} index={plans.indexOf(activePlan)} total={plans.length} onSelect={selectPlan} selected={selectedPlanId === activePlan.id} active />
      )}
      {completedPlans.map(plan => (
        <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} selected={selectedPlanId === plan.id} />
      ))}
    </div>
  )
}

function PlanRow({ plan, index, total, onSelect, selected, active }: { plan: WikiPlanWithSummary; index: number; total: number; onSelect: (id: string) => void; selected?: boolean; active?: boolean }) {
  const num = total - index
  const nodeSummary = plan.nodeSummary ?? { total: 0, completed: 0, titles: [] }
  const showProgress = plan.status !== 'draft' && nodeSummary.total > 0

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(plan.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(plan.id) }}
      className={`w-full text-left p-3 rounded-lg border cursor-pointer transition-all ${
        selected
          ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
          : active
            ? 'border-primary/20 bg-primary/[0.03]'
            : 'border-border/20 bg-card/40 hover:bg-card/60'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-foreground/85">#{num}</span>
        <PlanStatusBadge status={plan.status} />
      </div>
      {nodeSummary.titles.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {nodeSummary.titles.map((title, i) => (
            <div key={i} className="text-[11px] text-foreground/60 truncate">
              • {title}
            </div>
          ))}
          {nodeSummary.total > nodeSummary.titles.length && (
            <div className="text-[10px] text-muted-foreground/40">
              +{nodeSummary.total - nodeSummary.titles.length} 更多
            </div>
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/50">
        <span>{plan.evaluationIds.length} Issue</span>
        {showProgress && <span>{nodeSummary.completed}/{nodeSummary.total} 完成</span>}
        <span>{relativeTime(plan.createdAt)}</span>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center px-8">
      <div className="rounded-2xl border border-border/30 bg-card/50 backdrop-blur-xl p-8 max-w-sm w-full">
        <ListChecks size={32} className="mx-auto mb-3 text-muted-foreground/25" />
        <h2 className="text-sm font-semibold text-foreground/80">暂无规划</h2>
        <p className="mt-2 text-[12px] text-muted-foreground/55 leading-relaxed">
          在文档视图中对 Block 添加 Issue，<br />然后点击「生成规划」创建第一个规划。
        </p>
      </div>
    </div>
  )
}
