import { useEffect } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import PlanListView from './PlanListView'
import PlanDraftView from './PlanDraftView'
import PlanGeneratingView from './PlanGeneratingView'
import PlanNodeCard from './PlanNodeCard'
import { type WikiPlanNode } from '../../../lib/api/evaluation'

interface Props {
  projectId: string
}

export default function PlanView({ projectId }: Props) {
  const planNav = useWikiStore(s => s.planNav)
  const activePlan = useWikiStore(s => s.activePlan)
  const plans = useWikiStore(s => s.plans)
  const loadPlans = useWikiStore(s => s.loadPlans)
  const loadActivePlan = useWikiStore(s => s.loadActivePlan)
  const setPlanNav = useWikiStore(s => s.setPlanNav)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)

  useEffect(() => {
    loadPlans(projectId)
    loadActivePlan(projectId)
  }, [projectId, loadPlans, loadActivePlan])

  // Auto-navigate: if there's an active plan, show detail; otherwise show list
  useEffect(() => {
    if (activePlan) {
      setPlanNav('detail')
    } else if (plans.length > 0 && planGenStatus === 'idle') {
      setPlanNav('list')
    }
  }, [activePlan, plans.length, setPlanNav, planGenStatus])

  // While generating, always show detail (which renders PlanGeneratingView)
  if (planGenStatus === 'generating' || planGenStatus === 'failed') {
    return <PlanDetailRouter projectId={projectId} />
  }

  if (planNav === 'list') {
    return <PlanListView projectId={projectId} />
  }

  // Detail view — route by plan status
  if (!activePlan) {
    return <PlanListView projectId={projectId} />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {plans.length > 1 && (
        <div className="px-5 pt-3 pb-1">
          <Button variant="light" size="sm" onPress={() => setPlanNav('list')} className="text-[11px] text-muted-foreground/50">
            <ChevronLeft size={12} />
            历史 ({plans.length})
          </Button>
        </div>
      )}
      <PlanDetailRouter projectId={projectId} />
    </div>
  )
}

function PlanDetailRouter({ projectId }: Props) {
  const activePlan = useWikiStore(s => s.activePlan)
  const nodes = useWikiStore(s => s.activePlanNodes)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)

  if (planGenStatus === 'generating' || planGenStatus === 'failed') {
    return <PlanGeneratingView projectId={projectId} />
  }

  if (!activePlan) return null

  switch (activePlan.status) {
    case 'draft':
      return <PlanDraftView projectId={projectId} />
    case 'confirmed':
    case 'executing':
      return <PlanExecutingView projectId={projectId} nodes={nodes} />
    case 'reviewing':
    case 'committing':
    case 'completed':
      return <PlanCompletedView projectId={projectId} nodes={nodes} />
    default:
      return <PlanDraftView projectId={projectId} />
  }
}

function PlanExecutingView({ projectId, nodes }: { projectId: string; nodes: WikiPlanNode[] }) {
  const acceptedCount = nodes.filter(n => n.status === 'accepted' || n.status === 'committed').length

  return (
    <div className="flex h-full flex-col overflow-hidden flex-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2.5">
          <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[13px] font-semibold text-foreground/80">执行中</span>
          <span className="text-[11px] text-muted-foreground/50">{acceptedCount}/{nodes.length} 完成</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-2xl mx-auto space-y-3">
          {nodes.map((node, i) => (
            <PlanNodeCard key={node.id} node={node} index={i} isLast={i === nodes.length - 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanCompletedView({ projectId, nodes }: { projectId: string; nodes: WikiPlanNode[] }) {
  const activePlan = useWikiStore(s => s.activePlan)
  const setPlanNav = useWikiStore(s => s.setPlanNav)

  return (
    <div className="flex h-full flex-col overflow-hidden flex-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold text-foreground/80">规划完成</span>
          <span className="text-[11px] text-muted-foreground/50">{nodes.length} 个节点</span>
        </div>
        <Button variant="light" size="sm" onPress={() => setPlanNav('list')} className="text-[11px]">
          查看全部规划
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-2xl mx-auto space-y-3">
          {nodes.map((node, i) => (
            <PlanNodeCard key={node.id} node={node} index={i} isLast={i === nodes.length - 1} mode="compact" />
          ))}
        </div>
      </div>
    </div>
  )
}
