import { CheckCircle2, Circle, Clock, ListChecks, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { evaluationApi, type WikiPlan, type WikiPlanNode } from '../../../lib/api/evaluation'

export default function PlanView({ projectId }: { projectId: string }) {
  const snapshot = useWikiStore(s => s.snapshot)
  const [plan, setPlan] = useState<WikiPlan | null>(null)
  const [nodes, setNodes] = useState<WikiPlanNode[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    evaluationApi.getActivePlan(projectId).then(data => {
      setPlan(data.plan)
      setNodes(data.nodes)
    }).finally(() => setLoading(false))
  }, [projectId])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground/40" />
      </div>
    )
  }

  if (!plan || nodes.length === 0) {
    return <EmptyPlanState />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/20 px-5">
        <div className="flex items-center gap-2">
          <ListChecks size={12} className="text-primary" />
          <span className="text-[12px] font-medium text-foreground/80">
            {nodes.length} 个节点
          </span>
        </div>
        <PlanStatusBadge status={plan.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="relative space-y-3">
          {nodes.map((node, i) => (
            <PlanNodeCard key={node.id} node={node} index={i} isLast={i === nodes.length - 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: '待确认', cls: 'bg-amber-400/15 text-amber-500' },
    confirmed: { label: '已确认', cls: 'bg-primary/15 text-primary' },
    in_progress: { label: '执行中', cls: 'bg-blue-400/15 text-blue-500' },
    completed: { label: '已完成', cls: 'bg-green-400/15 text-green-500' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'bg-secondary text-muted-foreground' }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>
}

function NodeStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <CheckCircle2 size={14} className="text-green-500" />
    case 'in_progress': return <Clock size={14} className="text-blue-500" />
    case 'incomplete': return <XCircle size={14} className="text-destructive" />
    default: return <Circle size={14} className="text-muted-foreground/40" />
  }
}

function PlanNodeCard({ node, index, isLast }: { node: WikiPlanNode; index: number; isLast: boolean }) {
  return (
    <div className="relative flex gap-3">
      {/* Vertical connector line */}
      {!isLast && (
        <div className="absolute left-[7px] top-6 bottom-0 w-px bg-border/40" />
      )}
      <div className="relative z-10 mt-0.5 shrink-0">
        <NodeStatusIcon status={node.status} />
      </div>
      <div className="flex-1 rounded-xl border border-border/30 bg-card/40 p-3 backdrop-blur-sm">
        <h3 className="text-[12px] font-semibold text-foreground/90">{node.title}</h3>
        {node.description && (
          <p className="mt-1 text-[11px] text-muted-foreground/70 leading-relaxed">{node.description}</p>
        )}
        {node.expectedFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {node.expectedFiles.map(f => (
              <span key={f} className="rounded bg-foreground/[0.04] px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground/60">
                {f}
              </span>
            ))}
          </div>
        )}
        {node.dependsOn.length > 0 && (
          <div className="mt-1.5 text-[10px] text-muted-foreground/50">
            依赖: {node.dependsOn.join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyPlanState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-xl p-8 max-w-sm w-full shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
        <ListChecks size={32} className="mx-auto mb-3 text-muted-foreground/30" />
        <h2 className="text-sm font-semibold text-foreground/80">暂无规划</h2>
        <p className="mt-2 text-[12px] text-muted-foreground/60 leading-relaxed">
          在文档视图中对 Block 添加 Issue，
          <br />
          然后点击「生成规划」。
        </p>
      </div>
    </div>
  )
}
