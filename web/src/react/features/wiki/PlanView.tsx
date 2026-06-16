import { useEffect, useState } from 'react'
import { Loader2, ListChecks, Check, RotateCcw } from 'lucide-react'
import { Button, TextArea } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import PlanDraftView from './PlanDraftView'
import PlanGeneratingView from './PlanGeneratingView'
import PlanNodeCard from './PlanNodeCard'
import { type WikiPlanNode } from '../../../lib/api/goal'

interface Props {
  projectId: string
}

export default function PlanView({ projectId }: Props) {
  const { t } = useLocale()
  const activePlan = useWikiStore(s => s.activePlan)
  const plans = useWikiStore(s => s.plans)
  const loadPlans = useWikiStore(s => s.loadPlans)
  const loadActivePlan = useWikiStore(s => s.loadActivePlan)
  const selectedPlanId = useWikiStore(s => s.selectedPlanId)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)

  useEffect(() => {
    loadPlans(projectId)
    loadActivePlan(projectId)
  }, [projectId, loadPlans, loadActivePlan])

  if (planGenStatus === 'generating' || planGenStatus === 'failed') {
    return <PlanGeneratingView projectId={projectId} />
  }

  if (!activePlan) {
    if (selectedPlanId) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 size={18} className="animate-spin text-muted-foreground/40" />
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <ListChecks size={28} className="mx-auto mb-2 text-muted-foreground/20" />
          <p className="text-[12px] text-muted-foreground/50">{t('planSelectHint')}</p>
        </div>
      </div>
    )
  }

  return <PlanDetailRouter projectId={projectId} />
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
    case 'reviewing':
    case 'committing':
      return <PlanExecutingView projectId={projectId} nodes={nodes} />
    case 'completed':
      return <PlanCompletedView projectId={projectId} nodes={nodes} />
    default:
      return <PlanDraftView projectId={projectId} />
  }
}

function PlanExecutingView({ projectId, nodes }: { projectId: string; nodes: WikiPlanNode[] }) {
  const { t } = useLocale()
  const activePlan = useWikiStore(s => s.activePlan)
  const startPlanExecutionStream = useWikiStore(s => s.startPlanExecutionStream)
  const stopPlanExecutionStream = useWikiStore(s => s.stopPlanExecutionStream)
  const acceptedCount = nodes.filter(n => n.status === 'accepted' || n.status === 'committed').length

  useEffect(() => {
    if (!activePlan) return
    if (['confirmed', 'executing', 'reviewing', 'committing'].includes(activePlan.status)) {
      startPlanExecutionStream(activePlan.id)
    }
    return () => stopPlanExecutionStream()
  }, [activePlan?.id, activePlan?.status, startPlanExecutionStream, stopPlanExecutionStream])

  return (
    <div className="flex h-full flex-col overflow-hidden flex-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2.5">
          <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[13px] font-semibold text-foreground/80">{t('planExecutingTitle')}</span>
          <span className="text-[11px] text-muted-foreground/50">{t('planDoneCount', { done: acceptedCount, total: nodes.length })}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-2xl mx-auto space-y-3">
          {nodes.map((node, i) => (
            <div key={node.id} className="space-y-2">
              <PlanNodeCard node={node} index={i} isLast={i === nodes.length - 1} />
              {node.status === 'review' && activePlan && (
                <PlanNodeReviewPanel planId={activePlan.id} nodeId={node.id} projectId={projectId} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanNodeReviewPanel({ planId, nodeId, projectId }: { planId: string; nodeId: string; projectId: string }) {
  const { t } = useLocale()
  const artifact = useWikiStore(s => s.planExecution.artifacts[nodeId])
  const loadNodeArtifact = useWikiStore(s => s.loadNodeArtifact)
  const acceptPlanNode = useWikiStore(s => s.acceptPlanNode)
  const redoPlanNode = useWikiStore(s => s.redoPlanNode)
  const workDir = useShellStore(s => s.projects.find(p => p.id === projectId)?.source?.localPath ?? '')
  const [feedback, setFeedback] = useState('')
  const [acting, setActing] = useState(false)

  useEffect(() => {
    void loadNodeArtifact(planId, nodeId)
  }, [planId, nodeId, loadNodeArtifact])

  async function handleAccept() {
    if (!workDir) return
    setActing(true)
    try {
      await acceptPlanNode(planId, nodeId, workDir)
    } finally {
      setActing(false)
    }
  }

  async function handleRedo() {
    if (!feedback.trim()) return
    setActing(true)
    try {
      await redoPlanNode(planId, nodeId, feedback.trim())
      setFeedback('')
    } finally {
      setActing(false)
    }
  }

  return (
    <div className="ml-7 rounded-xl border border-amber-400/30 bg-amber-400/[0.04] p-3 space-y-3">
      {artifact?.patches && artifact.patches.length > 0 && (
        <div className="space-y-1.5">
          {artifact.patches.map((patch, i) => (
            <div key={`${patch.filePath}-${i}`} className="rounded-md border border-border/15 bg-background/40 p-2">
              <div className="text-[10px] font-mono text-muted-foreground/70 mb-1">{patch.filePath}</div>
              <pre className="whitespace-pre-wrap text-[10px] font-mono text-foreground/70 max-h-32 overflow-y-auto">{patch.diff}</pre>
            </div>
          ))}
        </div>
      )}
      <TextArea
        aria-label={t('planNodeReviewFeedback')}
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder={t('planNodeReviewFeedback')}
        rows={2}
        className="text-[11px]"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          isDisabled={acting || !workDir}
          onPress={() => void handleAccept()}
        >
          <Check size={12} />
          {t('planNodeAccept')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={acting || !feedback.trim()}
          onPress={() => void handleRedo()}
        >
          <RotateCcw size={12} />
          {t('planNodeRedo')}
        </Button>
      </div>
    </div>
  )
}

function PlanCompletedView({ projectId, nodes }: { projectId: string; nodes: WikiPlanNode[] }) {
  const { t } = useLocale()
  return (
    <div className="flex h-full flex-col overflow-hidden flex-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold text-foreground/80">{t('planCompletedTitle')}</span>
          <span className="text-[11px] text-muted-foreground/50">{t('planNodeCount', { count: nodes.length })}</span>
        </div>
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
