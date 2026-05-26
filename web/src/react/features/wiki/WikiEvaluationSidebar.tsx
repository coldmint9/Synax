import { Loader2, ListChecks, MessageCircle } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import { useNotificationStore } from '../../state/notificationStore'

interface Props {
  projectId: string
  selectedBlockId: string | null
}

export default function WikiEvaluationSidebar({ projectId, selectedBlockId }: Props) {
  const evaluations = useWikiStore(s => s.evaluations)
  const selectBlock = useWikiStore(s => s.selectBlock)

  const grouped = evaluations.reduce<Record<string, typeof evaluations>>((acc, e) => {
    ;(acc[e.blockId] ??= []).push(e)
    return acc
  }, {})

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/20 px-3">
        <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
          Issues
        </span>
        {evaluations.length > 0 && (
          <span className="rounded-full bg-amber-400/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
            {evaluations.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {evaluations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageCircle size={20} className="mb-2 text-muted-foreground/20" />
            <p className="text-[11px] text-muted-foreground/40">
              选中 Block 后直接添加 Issue
            </p>
            <p className="text-[10px] text-muted-foreground/30 mt-1">
              ↑↓ 方向键切换 Block
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {Object.entries(grouped).map(([blockId, issues]) => (
              <button
                key={blockId}
                type="button"
                onClick={() => {
                  selectBlock(blockId)
                  const el = document.getElementById(`wiki-block-${blockId}`)
                  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                }}
                className={`w-full text-left rounded-lg border px-2.5 py-2 transition-all ${
                  selectedBlockId === blockId
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border/15 bg-card/30 hover:border-border/30'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-muted-foreground/40">{blockId.slice(0, 8)}</span>
                  <span className="text-[9px] font-bold text-amber-400">{issues.length}</span>
                </div>
                <p className="text-[11px] text-foreground/70 line-clamp-1">{issues[0].content}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {evaluations.length > 0 && (
        <div className="shrink-0 border-t border-border/20 p-2">
          <GeneratePlanButton projectId={projectId} />
        </div>
      )}
    </div>
  )
}

function GeneratePlanButton({ projectId }: { projectId: string }) {
  const snapshot = useWikiStore(s => s.snapshot)
  const project = useShellStore(s => s.projects.find(p => p.id === projectId))
  const planGenStatus = useWikiStore(s => s.planGeneration.status)
  const startPlanGeneration = useWikiStore(s => s.startPlanGeneration)

  function handleGenerate() {
    if (!snapshot) {
      useNotificationStore.getState().push({ type: 'warning', message: 'Wiki 快照未就绪，无法生成规划。' })
      return
    }
    if (!project?.source?.localPath) {
      useNotificationStore.getState().push({ type: 'warning', message: '项目未配置本地路径，无法生成规划。' })
      return
    }
    startPlanGeneration(projectId, snapshot.id, project.source.localPath)
  }

  const generating = planGenStatus === 'generating'

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
    >
      {generating ? <Loader2 size={10} className="animate-spin" /> : <ListChecks size={10} />}
      {generating ? '生成中…' : '生成规划'}
    </button>
  )
}
