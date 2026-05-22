import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertTriangle, BookOpen, CheckCircle2, FileCode2, Layers, Target, Zap } from 'lucide-react'
import type { CoordNode } from '../../../lib/coordinates'
import { latestRun, runCount, nodeArtifactSummary } from '../../../lib/coordinates'
import { ReviewBadge } from '../review/ReviewBadge'

// ── 多方向 Handle 配置 ──
// 每个方向有一对 source/target handle，支持任意方向连接
const HANDLE_DIRECTIONS = [
  { id: 'top', position: Position.Top, style: { top: -5, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'right', position: Position.Right, style: { right: -5, top: '50%', transform: 'translateY(-50%)' } },
  { id: 'bottom', position: Position.Bottom, style: { bottom: -5, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'left', position: Position.Left, style: { left: -5, top: '50%', transform: 'translateY(-50%)' } },
] as const

// ── 状态样式映射 ──
const STATUS_CONFIG: Record<CoordNode['status'], { cls: string; dot: string }> = {
  done:       { cls: 'bg-success/10 text-success border-success/30',             dot: 'bg-success' },
  active:     { cls: 'bg-primary/10 text-primary border-primary/30',             dot: 'bg-primary animate-pulse' },
  rejection:  { cls: 'bg-destructive/10 text-destructive border-destructive/30',  dot: 'bg-destructive' },
  cancel:     { cls: 'bg-destructive/10 text-destructive border-destructive/30',  dot: 'bg-destructive' },
  review:     { cls: 'bg-warning/10 text-warning border-warning/30',             dot: 'bg-warning animate-pulse' },
  testing:    { cls: 'bg-warning/10 text-warning border-warning/30',             dot: 'bg-warning animate-pulse' },
  draft:      { cls: 'bg-secondary/70 text-muted-foreground border-border',      dot: 'bg-muted-foreground' },
  pending:    { cls: 'bg-secondary text-muted-foreground border-border',         dot: 'bg-muted-foreground' },
}

// ── 类型色板映射 ──
const TYPE_CONFIG: Record<CoordNode['type'], { accent: string; icon: React.ReactNode; label: string }> = {
  project: { accent: 'bg-primary/15 text-primary border-primary/30',   icon: <Layers size={10} />,    label: 'project' },
  feature: { accent: 'bg-run/15 text-run border-run/30',               icon: <Target size={10} />,    label: 'feature' },
  goal:    { accent: 'bg-warning/20 text-warning border-warning/30',   icon: <Target size={10} />,    label: 'goal' },
  action:  { accent: 'bg-secondary text-muted-foreground border-border', icon: <Zap size={10} />,       label: 'action' },
}

export default function CoordNodeView({ data, selected }: NodeProps) {
  const d = data as {
    node: CoordNode
    linkStats?: { files: number; symbols: number }
    childDone?: { done: number; total: number }
    contextStats?: {
      inputs: number
      incoming: number
      produced: number
      handoffs: number
      snapshot: boolean
    }
  }
  const node = d.node
  const linkStats = d.linkStats
  const childDone = d.childDone
  const contextStats = d.contextStats
  const artifact = nodeArtifactSummary(node)
  const rCount = runCount(node)
  const hasFlags = (node.convergenceFlags?.length ?? 0) > 0
  const flagLevel = node.convergenceFlags?.some(f => f.level === 'critical') ? 'critical' : 'warn'
  const status = STATUS_CONFIG[node.status] ?? STATUS_CONFIG.pending
  const type = TYPE_CONFIG[node.type] ?? TYPE_CONFIG.action
  // Evidence badge visibility: only meaningful for feature/action nodes
  // that actually have bound code. The project root stays clean.
  const showEvidence =
    (node.type === 'feature' || node.type === 'action') &&
    !!linkStats &&
    (linkStats.files > 0 || linkStats.symbols > 0)
  const showChildDone = !!childDone && childDone.total > 0

  // active / review / testing 状态使用边框发光
  const isActiveStyle = node.status === 'active'
  const glowBorder = isActiveStyle

  return (
    <div
      className={[
        'coord-node-card group relative w-[280px] rounded-xl border bg-card/95 px-3.5 py-3 shadow-sm',
        'transition-all duration-200 ease-out',
        'hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5',
        selected
          ? 'border-primary shadow-[0_0_0_1px_oklch(from var(--accent) l c h / 0.4),0_4px_20px_-6px_oklch(from var(--accent) l c h / 0.25)]'
          : glowBorder
            ? 'border-primary/50 ring-1 ring-primary/20 shadow-[0_0_12px_-4px_oklch(from var(--accent) l c h / 0.3)]'
            : 'border-border/60',
      ].join(' ')}
    >
      {/* ── 多方向 Handles ── */}
      {HANDLE_DIRECTIONS.map(({ id, position, style }) => (
        <Handle
          key={`${id}-target`}
          id={`${id}-target`}
          position={position}
          type="target"
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-border !bg-background !transition-all !duration-150 hover:!border-primary/60 hover:!bg-primary/10"
          style={style}
        />
      ))}
      {HANDLE_DIRECTIONS.map(({ id, position, style }) => (
        <Handle
          key={`${id}-source`}
          id={`${id}-source`}
          position={position}
          type="source"
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-primary/40 !bg-primary/15 !transition-all !duration-150 hover:border-primary hover:bg-primary/30 hover:scale-125"
          style={style}
        />
      ))}

      {/* ── Flag Badge (top-left) ── */}
      {hasFlags && (
        <div className={[
          'absolute -top-2 -left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shadow-md',
          flagLevel === 'critical'
            ? 'bg-destructive text-destructive-foreground'
            : 'bg-warning text-warning-foreground',
        ].join(' ')}>
          <AlertTriangle size={10} />
        </div>
      )}

      {/* ── Header Row ── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={['inline-flex items-center gap-0.5 rounded border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide', type.accent].join(' ')}>
              {type.icon}
              {type.label}
            </span>
            <ReviewBadge review={node.review} />
          </div>
          <div className="mt-1 truncate text-xs font-semibold leading-tight">{node.label}</div>
        </div>
        <span className={[
          'shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-px text-[9px] font-medium uppercase tracking-wider',
          status.cls,
        ].join(' ')}>
          <span className={['inline-block h-1.5 w-1.5 rounded-full', status.dot].join(' ')} />
          {node.status}
        </span>
      </div>

      {/* ── Summary ── */}
      <div className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/80">
        {node.summary || 'No summary'}
      </div>

      {/* ── Artifact Summary ── */}
      {artifact && (
        <div className="mt-2 line-clamp-1 rounded-md bg-secondary/40 px-2 py-1 text-[10px] text-primary/70">
          {artifact}
        </div>
      )}

      {/* ── Evidence Badge (feature/action bound-code counts) ── */}
      {showEvidence && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <FileCode2 size={11} className="text-primary/70" />
          {linkStats!.files > 0 && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary/80">
              {linkStats!.files} {linkStats!.files === 1 ? 'file' : 'files'}
            </span>
          )}
          {linkStats!.symbols > 0 && (
            <span className="rounded bg-run/10 px-1.5 py-0.5 font-medium text-run/80">
              {linkStats!.symbols} {linkStats!.symbols === 1 ? 'symbol' : 'symbols'}
            </span>
          )}
          {showChildDone && (
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 font-medium text-muted-foreground">
              <CheckCircle2 size={10} className={childDone!.done === childDone!.total ? 'text-success' : 'text-muted-foreground/70'} />
              {childDone!.done}/{childDone!.total}
            </span>
          )}
        </div>
      )}
      {/* child-task ratio on its own line when there is no evidence row */}
      {!showEvidence && showChildDone && (
        <div className="mt-2 inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <CheckCircle2 size={10} className={childDone!.done === childDone!.total ? 'text-success' : 'text-muted-foreground/70'} />
          {childDone!.done}/{childDone!.total} done
        </div>
      )}

      {/* ── Footer Row ── */}
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <div className="flex items-center gap-1.5">
          {contextStats && (contextStats.inputs > 0 || contextStats.incoming > 0 || contextStats.produced > 0 || contextStats.handoffs > 0 || contextStats.snapshot) && (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary/80">
              <BookOpen size={10} />
              {contextStats.inputs}
              {contextStats.incoming > 0 && <span>in {contextStats.incoming}</span>}
              {contextStats.handoffs > 0 && <span>out {contextStats.handoffs}</span>}
            </span>
          )}
          {rCount > 0 && (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-medium">
              {rCount} {rCount === 1 ? 'run' : 'runs'}
            </span>
          )}
        </div>
        <span className="truncate text-[9px]">
          {node.executor ? `${node.executor.type}:${node.executor.name}` : 'unassigned'}
        </span>
      </div>
    </div>
  )
}
