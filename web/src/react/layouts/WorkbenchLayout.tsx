import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router-dom'
import { projectApi } from '../../lib/api/project'
import { addProject, useShellStore } from '../state/shellStore'
import { useContextStore } from '../state/contextStore'
import { useContextStream } from '../../hooks/useContextStream'
import type { ActivityPanel } from './ActivityBar'
import { WorkbenchHeader } from './WorkbenchHeader'
import { TitleBar } from './TitleBar'
import { ProjectCreateDialog } from '../features/project-create/ProjectCreateDialog'

const isElectron = document.documentElement.classList.contains('electron')

export default function WorkbenchLayout() {
  const { projectId: routeProjectId = '' } = useParams()
  const currentProjectId = useShellStore(s => s.currentProjectId)
  const setCurrentProjectId = useShellStore(s => s.setCurrentProjectId)

  const effectiveProjectId = routeProjectId || currentProjectId || ''

  useEffect(() => {
    if (routeProjectId && routeProjectId !== currentProjectId) {
      setCurrentProjectId(routeProjectId)
    }
  }, [routeProjectId, currentProjectId, setCurrentProjectId])

  const project = useShellStore(s => s.projects.find(p => p.id === effectiveProjectId) ?? null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const bindContext = useContextStore(s => s.bind)
  const boundProjectId = useContextStore(s => s.projectId)
  useEffect(() => {
    if (!effectiveProjectId) return
    if (boundProjectId !== effectiveProjectId) {
      bindContext(effectiveProjectId, 'local-user')
    }
  }, [effectiveProjectId, boundProjectId, bindContext])
  useContextStream()

  useEffect(() => {
    if (!effectiveProjectId) return
    const inStore = useShellStore.getState().projects.some(p => p.id === effectiveProjectId)
    if (inStore) return
    let cancelled = false
    void projectApi.getProject(effectiveProjectId).then((p) => {
      if (cancelled) return
      if (p) addProject(p)
    })
    return () => { cancelled = true }
  }, [effectiveProjectId])

  const projectName = project?.name ?? (effectiveProjectId || 'Synapse')
  const navigate = useNavigate()

  const [activePanel, setActivePanel] = useState<ActivityPanel | null>(effectiveProjectId ? 'wiki' : null)

  const panelRoutes: Record<ActivityPanel, string> = {
    wiki: `/projects/${effectiveProjectId}/wiki`,
    sessions: `/projects/${effectiveProjectId}/sessions`,
    search: `/projects/${effectiveProjectId}/wiki`,
    settings: `/projects/${effectiveProjectId}/settings`,
    projects: `/projects/${effectiveProjectId}`,
  }

  const handlePanelToggle = (panel: ActivityPanel) => {
    if (panel === 'settings') {
      navigate('/settings')
      return
    }
    setActivePanel(panel)
    if (effectiveProjectId) {
      navigate(panelRoutes[panel])
    }
  }

  return (
    <div className="workbench-shell">
      {isElectron && (
        <TitleBar
          projectName={projectName}
          onPanelToggle={handlePanelToggle}
        />
      )}
      <div className="workbench-island">
        <div className="island-body">
          <Outlet context={{ onCreateProject: () => setCreateDialogOpen(true) }} />
        </div>
        <WorkbenchHeader
          activePanel={activePanel}
          onPanelToggle={handlePanelToggle}
          onHome={() => navigate('/')}
          hasProject={!!effectiveProjectId}
        />
      </div>
      <ProjectCreateDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} />
    </div>
  )
}
