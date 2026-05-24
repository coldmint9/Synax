import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useWikiStore } from '../state/wikiStore'
import WikiWorkspace from '../features/wiki/WikiWorkspace'

export default function WikiPage({ projectId: propId }: { projectId?: string }) {
  const { projectId: routeId = '' } = useParams()
  const projectId = propId || routeId
  const loadLatest = useWikiStore(s => s.loadLatest)
  const reset = useWikiStore(s => s.reset)
  const loadedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!projectId || projectId === loadedRef.current) return
    if (loadedRef.current) reset()
    loadedRef.current = projectId
    void loadLatest(projectId)
  }, [projectId, loadLatest, reset])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <WikiWorkspace projectId={projectId} />
      </div>
    </div>
  )
}
