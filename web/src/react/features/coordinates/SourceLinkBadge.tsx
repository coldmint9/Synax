import { FileCode2, Share2, GitBranch, Hash } from 'lucide-react'

// -----------------------------------------------------------------------------
// SourceLinkBadge - inline 徽章组件
//   - 展示检索 / 引用结果的来源：filePath + 行号范围 + provenance
//   - 点击触发 onClick (通常是跳转到 NodeDetailPanel / 打开外部编辑器)
//   - 纯受控组件，不依赖 store
// -----------------------------------------------------------------------------

export type Provenance = 'graph' | 'keyword' | 'hybrid' | 'inferred' | 'extracted' | 'ambiguous'

export interface SourceLinkBadgeProps {
  filePath: string
  startLine?: number
  endLine?: number
  provenance?: Provenance
  score?: number
  /** 节点 id，展示为 small chip */
  symbolId?: string
  onClick?: () => void
  /** 紧凑模式（用于列表内），仅展示文件名 + 行号 */
  compact?: boolean
}

const provenanceClass: Record<Provenance, string> = {
  graph: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  keyword: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  hybrid: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
  extracted: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
  inferred: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  ambiguous: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
}

function fileName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

export default function SourceLinkBadge({
  filePath,
  startLine,
  endLine,
  provenance,
  score,
  symbolId,
  onClick,
  compact = false,
}: SourceLinkBadgeProps) {
  const name = fileName(filePath)
  const range =
    startLine !== undefined
      ? endLine !== undefined && endLine !== startLine
        ? `L${startLine}-${endLine}`
        : `L${startLine}`
      : null

  const base =
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono transition-colors'
  const interactive = onClick ? 'cursor-pointer hover:bg-muted/60' : ''
  const provCls = provenance ? provenanceClass[provenance] : 'border-border/50 bg-background/60 text-muted-foreground'

  return (
    <span
      className={`${base} ${provCls} ${interactive}`}
      title={`${filePath}${range ? ':' + range : ''}${provenance ? ' · ' + provenance : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <FileCode2 size={10} className="shrink-0" />
      <span className="truncate max-w-[160px]">{compact ? name : filePath}</span>
      {range && <span className="opacity-80">{range}</span>}
      {!compact && symbolId && (
        <span className="inline-flex items-center gap-0.5 border-l border-current/20 pl-1 opacity-70">
          <Hash size={9} />
          {symbolId.length > 14 ? symbolId.slice(0, 14) + '…' : symbolId}
        </span>
      )}
      {!compact && score !== undefined && (
        <span className="inline-flex items-center gap-0.5 border-l border-current/20 pl-1 opacity-70">
          <Share2 size={9} />
          {score.toFixed(2)}
        </span>
      )}
      {!compact && provenance === 'graph' && (
        <GitBranch size={9} className="opacity-70" />
      )}
    </span>
  )
}
