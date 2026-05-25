import { ListChecks, CheckCircle2, Loader2, Clock, XCircle } from 'lucide-react'
import { Card } from '@heroui/react'
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
    discarded: { label: '已废弃', icon: XCircle, cls: 'bg-muted/10 text-muted-foreground/60 border-muted/20' },
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

  const activePlans = plans.filter(p => p.status !== 'completed' && p.status !== 'discarded')
  const finishedPlans = plans.filter(p => p.status === 'completed' || p.status === 'discarded')

  return (
    <div className="px-3 py-3 space-y-2">
      {activePlans.map(plan => (
        <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} selected={selectedPlanId === plan.id} />
      ))}
      {finishedPlans.map(plan => (
        <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} selected={selectedPlanId === plan.id} />
      ))}
    </div>
  )
}

function PlanRow({ plan, index, total, onSelect, selected }: { plan: WikiPlanWithSummary; index: number; total: number; onSelect: (id: string) => void; selected?: boolean }) {
  const num = total - index
  const nodeSummary = plan.nodeSummary ?? { total: 0, completed: 0, titles: [] }
  const showProgress = plan.status !== 'draft' && plan.status !== 'discarded' && nodeSummary.total > 0
  const isDiscarded = plan.status === 'discarded'

  return (
    <Card
      variant="transparent"
      className={`cursor-pointer transition-all p-3 shadow-sm hover:shadow-md ${
        selected
          ? 'border-primary bg-primary/10 ring-1 ring-primary/30 shadow-primary/10'
          : isDiscarded
            ? 'opacity-50 border-border/10 shadow-none hover:opacity-70'
            : 'border-border/20 hover:bg-card/60'
      }`}
      onClick={() => onSelect(plan.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') onSelect(plan.id) }}
    >
      <Card.Header className="p-0 gap-0">
        <div className="flex items-center justify-between w-full">
          <Card.Title className="text-[12px] font-semibold text-foreground/85">#{num}</Card.Title>
          <PlanStatusBadge status={plan.status} />
        </div>
      </Card.Header>
      {nodeSummary.titles.length > 0 && (
        <Card.Content className="p-0 mt-1.5">
          <div className="space-y-0.5">
            {nodeSummary.titles.map((title, i) => (
              <div key={i} className="text-[11px] text-foreground/60 truncate">• {title}</div>
            ))}
            {nodeSummary.total > nodeSummary.titles.length && (
              <div className="text-[10px] text-muted-foreground/40">+{nodeSummary.total - nodeSummary.titles.length} 更多</div>
            )}
          </div>
        </Card.Content>
      )}
      <Card.Footer className="p-0 mt-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
          <span>{plan.evaluationIds.length} Issue</span>
          {showProgress && <span>{nodeSummary.completed}/{nodeSummary.total} 完成</span>}
          <span>{relativeTime(plan.createdAt)}</span>
        </div>
      </Card.Footer>
    </Card>
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
