import { ListChecks, CheckCircle2, Loader2, Clock, XCircle, Trash2 } from 'lucide-react'
import { Card } from '@heroui/react'
import { iconBadgeClass, type IconTone } from '../../../lib/icon-tones'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import { type WikiPlanWithSummary } from '../../../lib/api/evaluation'
import { relativeTime } from './PlanNodeCard'

interface Props {
  projectId: string
}

function PlanStatusBadge({ status }: { status: WikiPlanWithSummary['status'] }) {
  const { t } = useLocale()
  const map: Record<string, { labelKey: 'planStatusDraft' | 'planStatusConfirmed' | 'planStatusExecuting' | 'planStatusReviewing' | 'planStatusCommitting' | 'planStatusCompleted' | 'planStatusDiscarded'; icon: typeof CheckCircle2; tone: IconTone }> = {
    draft: { labelKey: 'planStatusDraft', icon: Clock, tone: 'warning' },
    confirmed: { labelKey: 'planStatusConfirmed', icon: CheckCircle2, tone: 'primary' },
    executing: { labelKey: 'planStatusExecuting', icon: Loader2, tone: 'info' },
    reviewing: { labelKey: 'planStatusReviewing', icon: Clock, tone: 'warning' },
    committing: { labelKey: 'planStatusCommitting', icon: Loader2, tone: 'purple' },
    completed: { labelKey: 'planStatusCompleted', icon: CheckCircle2, tone: 'success' },
    discarded: { labelKey: 'planStatusDiscarded', icon: XCircle, tone: 'muted' },
  }
  const { labelKey, icon: Icon, tone } = map[status] ?? map.draft
  return (
    <span className={iconBadgeClass(tone, 'px-2 py-0.5')} data-tone={tone}>
      <Icon size={10} className={status === 'executing' || status === 'committing' ? 'animate-spin' : ''} />
      {t(labelKey)}
    </span>
  )
}

export default function PlanListView({ projectId }: Props) {
  const { t } = useLocale()
  const plans = useWikiStore(s => s.plans)
  const loading = useWikiStore(s => s.loading.plans)
  const selectPlan = useWikiStore(s => s.selectPlan)
  const selectedPlanId = useWikiStore(s => s.selectedPlanId)
  const deletePlan = useWikiStore(s => s.deletePlan)

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
        <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} onDelete={deletePlan} selected={selectedPlanId === plan.id} />
      ))}
      {finishedPlans.map(plan => (
        <PlanRow key={plan.id} plan={plan} index={plans.indexOf(plan)} total={plans.length} onSelect={selectPlan} onDelete={deletePlan} selected={selectedPlanId === plan.id} />
      ))}
    </div>
  )
}

function PlanRow({ plan, index, total, onSelect, onDelete, selected }: { plan: WikiPlanWithSummary; index: number; total: number; onSelect: (id: string) => void; onDelete: (id: string) => Promise<void>; selected?: boolean }) {
  const { t } = useLocale()
  const num = total - index
  const nodeSummary = plan.nodeSummary ?? { total: 0, completed: 0, titles: [] }
  const showProgress = plan.status !== 'draft' && plan.status !== 'discarded' && nodeSummary.total > 0
  const isDiscarded = plan.status === 'discarded'

  return (
    <Card
      variant="transparent"
      className={`cursor-pointer transition-all p-3 shadow-sm hover:shadow-md group ${
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
          <div className="flex items-center gap-1">
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-danger/10 text-muted-foreground/40 hover:text-danger"
              onClick={(e) => { e.stopPropagation(); onDelete(plan.id) }}
              aria-label="Delete plan"
            >
              <Trash2 size={12} />
            </button>
            <PlanStatusBadge status={plan.status} />
          </div>
        </div>
      </Card.Header>
      {nodeSummary.titles.length > 0 && (
        <Card.Content className="p-0 mt-1.5">
          <div className="space-y-0.5">
            {nodeSummary.titles.map((title, i) => (
              <div key={i} className="text-[11px] text-foreground/60 truncate">• {title}</div>
            ))}
            {nodeSummary.total > nodeSummary.titles.length && (
              <div className="text-[10px] text-muted-foreground/40">{t('planMore', { count: nodeSummary.total - nodeSummary.titles.length })}</div>
            )}
          </div>
        </Card.Content>
      )}
      <Card.Footer className="p-0 mt-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
          <span>{plan.evaluationIds.length} Issue</span>
          {showProgress && <span>{t('planProgress', { done: nodeSummary.completed, total: nodeSummary.total })}</span>}
          <span>{relativeTime(plan.createdAt)}</span>
        </div>
      </Card.Footer>
    </Card>
  )
}

function EmptyState() {
  const { t } = useLocale()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center px-8">
      <div className="rounded-2xl border border-border/30 bg-card/50 backdrop-blur-xl p-8 max-w-sm w-full">
        <ListChecks size={32} className="mx-auto mb-3 text-muted-foreground/25" />
        <h2 className="text-sm font-semibold text-foreground/80">{t('planEmpty')}</h2>
        <p className="mt-2 text-[12px] text-muted-foreground/55 leading-relaxed">
          {t('planEmptyDesc')}
        </p>
      </div>
    </div>
  )
}
