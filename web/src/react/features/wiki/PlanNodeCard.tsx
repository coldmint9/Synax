import { CheckCircle2, Circle, Loader2, ChevronUp, ChevronDown, Trash2, Pencil, Eye } from 'lucide-react'
import { Button, Card } from '@heroui/react'
import { type WikiPlanNode } from '../../../lib/api/goal'

export type NodeCardMode = 'compact' | 'expanded'

interface Props {
  node: WikiPlanNode
  index: number
  isLast: boolean
  mode?: NodeCardMode
  editable?: boolean
  onEdit?: (node: WikiPlanNode) => void
  onDelete?: (nodeId: string) => void
  onMoveUp?: (nodeId: string) => void
  onMoveDown?: (nodeId: string) => void
}

function NodeStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'committed':
    case 'accepted':
      return <CheckCircle2 size={16} className="text-emerald-500" />
    case 'executing':
      return <Loader2 size={16} className="animate-spin text-blue-500" />
    case 'review':
      return <Eye size={16} className="text-amber-500" />
    default:
      return <Circle size={16} className="text-muted-foreground/40" />
  }
}

export { NodeStatusIcon }

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(dateStr).toLocaleDateString()
}

export { relativeTime }

export default function PlanNodeCard({ node, index, isLast, mode = 'expanded', editable, onEdit, onDelete, onMoveUp, onMoveDown }: Props) {
  if (mode === 'compact') {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-card/30">
        <NodeStatusIcon status={node.status} />
        <span className="text-[12px] font-medium text-foreground/80 truncate flex-1">
          {index + 1}. {node.title}
        </span>
        {node.completedAt && (
          <span className="text-[10px] text-muted-foreground/50">{relativeTime(node.completedAt)}</span>
        )}
      </div>
    )
  }

  return (
    <div className="plan-node-card group relative flex gap-3">
      {!isLast && (
        <div className="absolute left-[9px] top-7 bottom-0 w-px bg-border/30" />
      )}
      <div className="relative z-10 mt-1 shrink-0">
        <NodeStatusIcon status={node.status} />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-border/20 bg-card/50 backdrop-blur-sm p-4 transition-all hover:border-border/40">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-foreground/90">
            {index + 1}. {node.title}
          </h3>
          {editable && (
            <NodeActions index={index} isLast={isLast} node={node} onMoveUp={onMoveUp} onMoveDown={onMoveDown} onEdit={onEdit} onDelete={onDelete} />
          )}
        </div>
        {node.description && (
          <p className="mt-1.5 text-[11px] text-muted-foreground/70 leading-relaxed">{node.description}</p>
        )}
        {node.expectedFiles.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {node.expectedFiles.map(f => (
              <span key={f} className="rounded-md bg-foreground/[0.04] border border-border/10 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60">{f}</span>
            ))}
          </div>
        )}
        {node.dependsOn.length > 0 && (
          <div className="mt-2 text-[10px] text-muted-foreground/50">⬆️ 依赖: {node.dependsOn.join(', ')}</div>
        )}
        {node.completedAt && (
          <div className="mt-2 text-[10px] text-emerald-500/70">完成于 {relativeTime(node.completedAt)}</div>
        )}
      </div>
    </div>
  )
}

function NodeActions({ index, isLast, node, onMoveUp, onMoveDown, onEdit, onDelete }: Pick<Props, 'index' | 'isLast' | 'node' | 'onMoveUp' | 'onMoveDown' | 'onEdit' | 'onDelete'>) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {onMoveUp && index > 0 && (
        <Button variant="ghost" size="sm" isIconOnly aria-label="上移" onPress={() => onMoveUp(node.id)} className="min-w-6 h-6"><ChevronUp size={12} /></Button>
      )}
      {onMoveDown && !isLast && (
        <Button variant="ghost" size="sm" isIconOnly aria-label="下移" onPress={() => onMoveDown(node.id)} className="min-w-6 h-6"><ChevronDown size={12} /></Button>
      )}
      {onEdit && (
        <Button variant="ghost" size="sm" isIconOnly aria-label="编辑" onPress={() => onEdit(node)} className="min-w-6 h-6"><Pencil size={12} /></Button>
      )}
      {onDelete && (
        <Button variant="ghost" size="sm" isIconOnly aria-label="删除" onPress={() => onDelete(node.id)} className="min-w-6 h-6 text-destructive/70"><Trash2 size={12} /></Button>
      )}
    </div>
  )
}
