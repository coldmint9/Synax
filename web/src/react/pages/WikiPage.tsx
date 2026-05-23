import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useWikiStore } from '../state/wikiStore'
import WikiWorkspace from '../features/wiki/WikiWorkspace'
import PlanView from '../features/wiki/PlanView'

export default function WikiPage() {
  const { projectId = '' } = useParams()
  const loadLatest = useWikiStore(s => s.loadLatest)
  const reset = useWikiStore(s => s.reset)
  const viewMode = useWikiStore(s => s.viewMode)

  useEffect(() => {
    reset()
    if (projectId) void loadLatest(projectId)
  }, [projectId, loadLatest, reset])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
