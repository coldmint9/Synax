import { useEffect, useState, useCallback } from 'react'
import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom'
import { projectApi } from '../../lib/api/project'
import { addProject, useShellStore } from '../state/shellStore'
import { useContextStore } from '../state/contextStore'
import { useContextStream } from '../../hooks/useContextStream'
import { useAgentPermissionNotifier } from '../../hooks/useAgentPermissionNotifier'
import { useDesktopNotification } from '../../hooks/useDesktopNotification'
import { useTaskNotificationListener } from '../../hooks/useTaskNotificationListener'
import { useRuntimeSSE } from '../features/sessions/useRuntimeSSE'
import { useSessionTitleSync } from '../features/sessions/useSessionDisplayTitle'
import { useAgentSessionStore } from '../features/sessions/agentSessionStore'
import { sessionPath } from '../features/sessions/sessionRoutes'
import { resolveSessionsEntryPath } from '../features/sessions/sessionLastVisit'
import type { ActivityPanel } from './ActivityBar'
import { WorkbenchHeader } from './WorkbenchHeader'
import { ProjectCreateDialog } from '../features/project-create/ProjectCreateDialog'
import { ToastContainer } from '../components/ToastContainer'
import WikiPage from '../pages/WikiPage'
import SessionsPage from '../pages/SessionsPage'

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

  const projects = useShellStore(s => s.projects)
  const projectsLoaded = useShellStore(s => s.projectsLoaded)
  const fetchProjects = useShellStore(s => s.fetchProjects)
  const project = projects.find(p => p.id === effectiveProjectId) ?? null
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects()
  }, [projectsLoaded, fetchProjects])

  const bindContext = useContextStore(s => s.bind)
  const boundProjectId = useContextStore(s => s.projectId)
  useEffect(() => {
    if (!effectiveProjectId) return
    if (boundProjectId !== effectiveProjectId) {
      bindContext(effectiveProjectId, 'local-user')
    }
  }, [effectiveProjectId, boundProjectId, bindContext])
  useContextStream()

  // 单例 SSE 订阅 + 绑定 projectId 到 agentSessionStore
  const setSessionProjectId = useAgentSessionStore(s => s.setProjectId)
  useEffect(() => {
    setSessionProjectId(effectiveProjectId || null)
  }, [effectiveProjectId, setSessionProjectId])
  useRuntimeSSE()
  useSessionTitleSync()

  const navigate = useNavigate()
  const location = useLocation()

  const navigateToSession = useCallback((sessionId: string) => {
    if (effectiveProjectId) {
      navigate(sessionPath(effectiveProjectId, sessionId))
    }
  }, [effectiveProjectId, navigate])
  useAgentPermissionNotifier(effectiveProjectId || null, navigateToSession)
  useDesktopNotification(effectiveProjectId || null)
  useTaskNotificationListener(effectiveProjectId || null)

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

  const projectName = project?.name ?? (effectiveProjectId || 'Synax')

  // Derive activePanel from current route
  const activePanel: ActivityPanel | null = (() => {
    const path = location.pathname
    if (path.includes('/sessions')) return 'sessions'
    if (path.includes('/wiki')) return 'wiki'
    if (path === '/settings' || path.includes('/settings')) return 'settings'
    return null
  })()

  const panelRoutes: Record<ActivityPanel, string> = {
    wiki: `/projects/${effectiveProjectId}/wiki`,
    sessions: resolveSessionsEntryPath(effectiveProjectId),
    search: `/projects/${effectiveProjectId}/wiki`,
    settings: `/projects/${effectiveProjectId}/settings`,
    projects: `/projects/${effectiveProjectId}`,
  }

  const handlePanelToggle = (panel: ActivityPanel) => {
    if (panel === 'settings') {
      navigate('/settings')
      return
    }
    if (effectiveProjectId) {
      navigate(panelRoutes[panel])
    }
  }

  const isCachedPanel = effectiveProjectId && (activePanel === 'wiki' || activePanel === 'sessions')

  const unbindContext = useContextStore(s => s.unbind)
  const removeFromStore = useShellStore(s => s.removeProject)

  const handleRemoveProject = useCallback(async (projectId: string) => {
    const isCurrentProject = projectId === effectiveProjectId
    if (isCurrentProject) {
      unbindContext()
      setCurrentProjectId(null)
    }
    await projectApi.deleteProject(projectId)
    removeFromStore(projectId)
    if (isCurrentProject) {
      const remaining = useShellStore.getState().projects
      if (remaining.length > 0) {
        navigate(`/projects/${remaining[0].id}/wiki`, { replace: true })
      } else {
        navigate('/', { replace: true })
      }
    }
  }, [effectiveProjectId, unbindContext, setCurrentProjectId, removeFromStore, navigate])

  return (
    <div className="workbench-shell">
      <WorkbenchHeader
        activePanel={activePanel}
        onPanelToggle={handlePanelToggle}
        hasProject={!!effectiveProjectId}
        projectName={projectName}
        currentProjectId={effectiveProjectId}
        projects={projects}
        onProjectSwitch={(id) => navigate(`/projects/${id}/wiki`)}
        onCreateProject={() => setCreateDialogOpen(true)}
        onRemoveProject={handleRemoveProject}
      />
      <div className="workbench-island">
        <div className="island-body">
          {/* Cached project pages — always mounted once project exists */}
          {effectiveProjectId && (
            <>
              <div
                className="absolute inset-0 flex flex-col"
                style={{ visibility: activePanel === 'wiki' ? 'visible' : 'hidden', zIndex: activePanel === 'wiki' ? 1 : 0 }}
              >
                <WikiPage projectId={effectiveProjectId} />
              </div>
              <div
                className="absolute inset-0 flex flex-col"
                style={{ visibility: activePanel === 'sessions' ? 'visible' : 'hidden', zIndex: activePanel === 'sessions' ? 1 : 0 }}
              >
                <SessionsPage />
              </div>
            </>
          )}
          {/* Outlet for non-cached routes (welcome, settings) */}
          <div className={isCachedPanel ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>
            <Outlet context={{ onCreateProject: () => setCreateDialogOpen(true) }} />
          </div>
        </div>
      </div>
      <ProjectCreateDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} />
      <ToastContainer />
    </div>
  )
}
