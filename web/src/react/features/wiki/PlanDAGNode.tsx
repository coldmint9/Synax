import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FileCode } from 'lucide-react'
import type { PlanNodeDraft } from '../../../lib/api/goal'

export interface PlanDAGNodeData {
  [key: string]: unknown
  node: PlanNodeDraft
  index: number
  status?: 'pending' | 'executing' | 'review' | 'accepted' | 'committed'
}

const statusColors: Record<string, string> = {
  pending: 'border-border/30 bg-card/60',
  executing: 'border-primary/40 bg-primary/[0.04] ring-1 ring-primary/20 animate-pulse',
  review: 'border-amber-400/40 bg-amber-400/[0.04]',
  accepted: 'border-emerald-500/40 bg-emerald-500/[0.04]',
  committed: 'border-emerald-600/40 bg-emerald-600/[0.06]',
}

function PlanDAGNodeComponent({ data }: NodeProps & { data: PlanDAGNodeData }) {
  const { node, index, status = 'pending' } = data
  const colorClass = statusColors[status] ?? statusColors.pending

  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-muted-foreground/30 !border-0" />
      <div className={`plan-dag-node w-[260px] rounded-xl border p-3 shadow-sm transition-all duration-300 ${colorClass}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="flex items-center justify-center w-5 h-5 rounded-md bg-foreground/[0.06] text-[10px] font-bold text-muted-foreground/70">
            {index + 1}
          </span>
          <h4 className="text-[12px] font-semibold text-foreground/85 truncate flex-1">{node.title}</h4>
        </div>
        {node.description && (
          <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-2 mb-2">{node.description}</p>
        )}
        {node.expectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.expectedFiles.slice(0, 3).map(f => (
              <span key={f} className="inline-flex items-center gap-0.5 rounded-md bg-foreground/[0.04] border border-border/10 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground/60">
                <FileCode size={8} className="shrink-0" />
                {f.split('/').pop()}
              </span>
            ))}
            {node.expectedFiles.length > 3 && (
              <span className="text-[9px] text-muted-foreground/40">+{node.expectedFiles.length - 3}</span>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-muted-foreground/30 !border-0" />
    </>
  )
}

export const PlanDAGNode = memo(PlanDAGNodeComponent)
