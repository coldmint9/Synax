import { useEffect } from 'react'
import { ListChecks, Plus, CheckCircle2, Loader2, Clock } from 'lucide-react'
import { Button, Card } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import { type WikiPlan } from '../../../lib/api/evaluation'
import { relativeTime } from './PlanNodeCard'

interface Props {
  projectId: string
}

function PlanStatusBadge({ status }: { status: WikiPlan['status'] }) {
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
  const loadPlans = useWikiStore(s => s.loadPlans)
  const selectPlan = useWikiStore(s => s.selectPlan)

  useEffect(() => { loadPlans(projectId) }, [projectId, loadPlans])

  if (loading) {
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
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2">
          <ListChecks size={14} className="text-primary" />
          <span className="text-[13px] font-semibold text-foreground/80">规划历史</span>
          <span className="text-[11px] text-muted-foreground/50">({plans.length})</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-2">
        {activePlan && (
          <PlanRow plan={activePlan} index={plans.indexOf(activePlan)} total={plans.length} onSelect={selectPlan} active />
        )}
        {completedPlans.map(plan => (
          <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} />
        ))}
      </div>
    </div>
  )
}

function PlanRow({ plan, index, total, onSelect, active }: { plan: WikiPlan; index: number; total: number; onSelect: (id: string) => void; active?: boolean }) {
  const num = total - index
  return (
    <Card
      isPressable
      onPress={() => onSelect(plan.id)}
      className={`w-full text-left p-4 transition-all ${
        active ? 'border-primary/20 bg-primary/[0.03]' : 'border-border/20 bg-card/40'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-foreground/85">#{num}</span>
        <PlanStatusBadge status={plan.status} />
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/50">
        <span>{plan.evaluationIds.length} 个 Issue</span>
        <span>{relativeTime(plan.createdAt)}</span>
      </div>
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
