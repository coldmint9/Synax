import { BookOpen } from 'lucide-react'
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useWikiStore } from '../state/wikiStore'
import WikiWorkspace from '../features/wiki/WikiWorkspace'

export default function WikiPage() {
  const { projectId = '' } = useParams()
  const loadLatest = useWikiStore(s => s.loadLatest)
  const reset = useWikiStore(s => s.reset)

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
      </div>
      <div className="relative min-h-0 flex-1">
        <WikiWorkspace projectId={projectId} />
      </div>
    </div>
  )
}
