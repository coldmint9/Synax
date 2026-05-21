import { useMemo } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { useCoordinatesState } from '../../state/coordinatesStore'

// -----------------------------------------------------------------------------
// InitProgressOverlay - 分析阶段遮罩
//   - Bun analyzer phases:
//       cloning 5 → parsing 25 → graph_build 45
//       → semantic 60 → indexing 75 → mapping 90 → ready 100
//   - semantic 阶段仍然代表社区发现与语义提取
// -----------------------------------------------------------------------------

const PHASE_ORDER: string[] = [
  'idle',
  'cloning',
  'parsing',
  'graph_build',
  'semantic',
  'indexing',
  'mapping',
  'ready',
]

const PHASE_LABEL: Record<string, string> = {
  idle: '待机',
  cloning: '克隆仓库',
  parsing: 'Tree-sitter 解析',
  graph_build: '构建代码图',
  semantic: '语义提取',
  indexing: '建立索引',
  mapping: '映射坐标森林',
  ready: '完成',
  failed: '失败',
}

// semantic 阶段按 progress 派生子步标签
function semanticSubLabel(progress: number): string {
  if (progress <= 56) return '划分社区'
  if (progress <= 62) return '社区语义打标 · LLM'
  return '种子代理推理 · graph→features/actions'
}

function displayPhase(phase: string, progress: number) {
  if (phase === 'indexing') {
    if (progress >= 82) {
      return {
        title: '整理分析结果',
        detail: '保存图谱与增量变更',
      }
    }
    return {
      title: '建立索引',
      detail: '构建代码检索索引',
    }
  }
  if (phase === 'semantic') {
    return {
      title: '语义提取',
      detail: semanticSubLabel(progress),
    }
  }
  return {
    title: PHASE_LABEL[phase] ?? phase,
    detail: '',
  }
}

function displayMessage(phase: string, progress: number, message?: string) {
  if (!message) return '正在处理…'
  if (phase === 'semantic') {
    const labeling = message.match(/^labeling (\d+) communities(?: via .+)?$/i)
    if (labeling) return `正在为 ${labeling[1]} 个社区生成语义标签`
    const heartbeat = message.match(/^labeling (\d+) communities… \((\d+)s\)$/i)
    if (heartbeat) return `正在为 ${heartbeat[1]} 个社区生成语义标签（已运行 ${heartbeat[2]}s）`
    if (message === 'derive features + actions') return '正在识别社区并准备提取 feature / action'
    if (message === 'seed agent: exploring graph → features + actions') return '正在探索代码图并提取 feature / action'
    const seedHeartbeat = message.match(/^seed agent reasoning over graph… \((\d+)s, turn≈(\d+)\)$/i)
    if (seedHeartbeat) return `正在探索代码图并提取 feature / action（${seedHeartbeat[1]}s，约第 ${seedHeartbeat[2]} 轮）`
    if (message === 'reusing cached labels (no code changes)') return '未检测到代码变化，复用已有语义结果'
  }
  if (phase === 'cloning' && message === 'preparing work dir') return '正在准备分析工作目录'
  if (phase === 'parsing' && message === 'parse symbols + files') return '正在解析文件与符号'
  if (phase === 'graph_build' && message === 'NetworkX graph') return '正在构建代码关系图'
  if (phase === 'indexing' && progress < 82 && message === 'keyword index build') return '正在建立代码检索索引'
  if (phase === 'indexing' && progress >= 82 && message === 'persist graph + delta cleanup') return '正在保存图谱并清理增量变更'
  if (phase === 'mapping' && message === 'CoordForest patch') return '正在把分析结果映射到坐标森林'
  if (message === 'Starting analyzer…') return '正在启动分析器'
  return message
}

interface Props {
  projectId: string
  projectName: string
}

export default function InitProgressOverlay({ projectId, projectName }: Props) {
  const analysis = useCoordinatesState(projectId, projectName, (s) => s.forest.analysis)
  const cancel = useCoordinatesState(projectId, projectName, (s) => s.cancelInitialize)
  const abort = useCoordinatesState(projectId, projectName, (s) => s.analysisAbort)

  const phase = analysis?.phase ?? 'idle'
  const active = phase !== 'idle' && phase !== 'ready'
  const failed = phase === 'failed'
  const current = displayPhase(phase, analysis?.progress ?? 0)
  const message = displayMessage(phase, analysis?.progress ?? 0, analysis?.message)

  const stepIndex = useMemo(() => PHASE_ORDER.indexOf(phase), [phase])

  if (!active) return null

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      role="dialog"
      aria-label="Analyzer progress"
    >
      <div className="relative w-[420px] max-w-[92vw] rounded-xl border border-border/50 bg-background/95 p-5 shadow-2xl">
        {/* 关闭按钮（实际触发 cancel） */}
        {!failed && abort && (
          <button
            className="absolute right-2 top-2 rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => cancel()}
            aria-label="Cancel analysis"
            title="取消分析"
          >
            <X size={14} />
          </button>
        )}

        {/* 标题 + 阶段 */}
        <div className="flex items-center gap-2">
          {failed ? (
            <AlertTriangle size={16} className="text-destructive" />
          ) : (
            <Loader2 size={16} className="animate-spin text-primary" />
          )}
          <div className="text-sm font-medium">
            {failed
              ? '分析失败'
              : `${current.title}${current.detail ? ` · ${current.detail}` : ''} · ${analysis?.progress ?? 0}%`}
          </div>
        </div>

        {/* 阶段 breadcrumb */}
        <div className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground">
          {PHASE_ORDER.filter((p) => p !== 'idle').map((p, i) => {
            const idx = PHASE_ORDER.indexOf(p)
            const done = stepIndex > idx
            const current = stepIndex === idx
            return (
              <span key={p} className="flex items-center gap-1">
                {i > 0 && <span className="opacity-30">›</span>}
                <span
                  className={
                    current
                      ? 'font-semibold text-primary'
                      : done
                      ? 'text-foreground/80'
                      : 'text-muted-foreground/60'
                  }
                >
                  {PHASE_LABEL[p] ?? p}
                </span>
              </span>
            )
          })}
        </div>

        {/* 进度条 */}
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all duration-500 ${
              failed ? 'bg-destructive' : 'bg-primary'
            }`}
            style={{ width: `${Math.min(100, Math.max(2, analysis?.progress ?? 0))}%` }}
          />
        </div>

        {/* 消息 */}
        <div className="mt-3 min-h-[1.25rem] truncate text-xs text-muted-foreground">
          {message}
        </div>

        {/* 元信息 */}
        <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
          <span>runId: <code className="font-mono">{analysis?.lastRunId ?? '-'}</code></span>
          {!failed && abort && (
            <button
              className="rounded border border-border/50 px-2 py-0.5 hover:bg-muted/60 hover:text-foreground"
              onClick={() => cancel()}
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
