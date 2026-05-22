import { BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useWikiStore } from '../state/wikiStore'
import WikiWorkspace from '../features/wiki/WikiWorkspace'
import PlanView from '../features/wiki/PlanView'

export type WikiViewMode = 'document' | 'plan'

function SegmentedControl({ value, onChange }: { value: WikiViewMode; onChange: (v: WikiViewMode) => void }) {
  return (
    <div className="relative flex h-7 items-center rounded-full bg-foreground/[0.04] p-0.5 backdrop-blur-xl border border-white/[0.08] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.05)]">
      <div
        className="absolute top-0.5 h-6 rounded-full bg-white/90 dark:bg-white/15 shadow-sm transition-all duration-200 ease-out"
        style={{
          width: 'calc(50% - 2px)',
          left: value === 'document' ? '2px' : 'calc(50% + 0px)',
        }}
      />
      <button
        type="button"
        onClick={() => onChange('document')}
        className={`relative z-10 flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${
          value === 'document' ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
        }`}
      >
        文档
      </button>
      <button
        type="button"
        onClick={() => onChange('plan')}
        className={`relative z-10 flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${
          value === 'plan' ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
        }`}
      >
        规划
      </button>
    </div>
  )
}

export default function WikiPage() {
  const { projectId = '' } = useParams()
  const loadLatest = useWikiStore(s => s.loadLatest)
  const reset = useWikiStore(s => s.reset)
  const [viewMode, setViewMode] = useState<WikiViewMode>('document')

  useEffect(() => {
    reset()
    if (projectId) void loadLatest(projectId)
  }, [projectId, loadLatest, reset])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[hsl(var(--background))]">
      <div className="flex h-11 shrink-0 items-center border-b border-border/30 px-5">
        <div className="flex items-center gap-2.5">
          <BookOpen size={13} className="shrink-0 text-primary" />
          <span className="text-[13px] font-semibold tracking-tight">Wiki</span>
        </div>

        {/* Pill Segmented Control — macOS 26 Liquid Glass style */}
        <div className="ml-4 flex items-center">
          <SegmentedControl value={viewMode} onChange={setViewMode} />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {viewMode === 'document' ? (
          <WikiWorkspace projectId={projectId} />
        ) : (
          <PlanView projectId={projectId} />
        )}
      </div>
    </div>
  )
}
