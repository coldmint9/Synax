import { useEffect, useMemo, useState } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router-dom'
import { Circle, FileText } from 'lucide-react'
import { headerGitBranchLabel } from '../../lib/projectGitBranch'
import { projectApi } from '../../lib/api/project'
import { useCoordinatesState } from '../state/coordinatesStore'
import { useWikiStore } from '../state/wikiStore'
import { addProject, useShellStore } from '../state/shellStore'
import { useContextStore } from '../state/contextStore'
import { useContextStream } from '../../hooks/useContextStream'
import { ActivityBar, type ActivityPanel } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { TitleBar } from './TitleBar'
import { ProjectCreateDialog } from '../features/project-create/ProjectCreateDialog'
import SessionList from '../features/coordinates/context/SessionList'

const isElectron = document.documentElement.classList.contains('electron')

export default function WorkbenchLayout() {
  const { projectId: routeProjectId = '' } = useParams()
  const currentProjectId = useShellStore(s => s.currentProjectId)
  const setCurrentProjectId = useShellStore(s => s.setCurrentProjectId)

  // Effective projectId: URL param takes priority, fallback to stored currentProjectId
  const effectiveProjectId = routeProjectId || currentProjectId || ''

  // Update stored currentProjectId when entering a project route
  useEffect(() => {
    if (routeProjectId && routeProjectId !== currentProjectId) {
      setCurrentProjectId(routeProjectId)
    }
  }, [routeProjectId, currentProjectId, setCurrentProjectId])

  const project = useShellStore(s => s.projects.find(p => p.id === effectiveProjectId) ?? null)
  const [notFoundForId, setNotFoundForId] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  // Context store initialization — bind to effectiveProjectId, don't unbind on homepage
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
    setNotFoundForId(null)
    if (!effectiveProjectId) return
    const inStore = useShellStore.getState().projects.some(p => p.id === effectiveProjectId)
    if (inStore) return
    let cancelled = false
    void projectApi.getProject(effectiveProjectId).then((p) => {
      if (cancelled) return
      if (p) addProject(p)
      else setNotFoundForId(effectiveProjectId)
    })
    return () => { cancelled = true }
  }, [effectiveProjectId])

  const projectName = project?.name ?? (effectiveProjectId || 'Synapse')
  const forestSource = useCoordinatesState(effectiveProjectId || '__none', projectName, s => s.forest.source)
  const headerBranch = useMemo(
    () => effectiveProjectId ? headerGitBranchLabel(project, forestSource) : null,
    [project, forestSource, effectiveProjectId],
  )
  const nodeCount = useCoordinatesState(effectiveProjectId || '__none', projectName, s => Object.keys(s.forest.nodes).length)

  const navigate = useNavigate()

  const [activePanel, setActivePanel] = useState<ActivityPanel | null>(effectiveProjectId ? 'coordinates' : null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelPosition, setPanelPosition] = useState<'left' | 'right'>('left')

  const panelRoutes: Record<ActivityPanel, string> = {
    coordinates: `/projects/${effectiveProjectId}/coordinates`,
    wiki: `/projects/${effectiveProjectId}/wiki`,
    sessions: `/projects/${effectiveProjectId}/sessions`,
    search: `/projects/${effectiveProjectId}/coordinates`,
    settings: `/projects/${effectiveProjectId}/settings`,
    projects: `/projects/${effectiveProjectId}`,
  }

  const panelsWithSideContent: Set<ActivityPanel> = new Set(['coordinates', 'sessions', 'search'])

  const handlePanelToggle = (panel: ActivityPanel) => {
    if (panel === 'settings') {
      navigate('/settings')
      return
    }
    const hasSideContent = panelsWithSideContent.has(panel)
    if (panel === activePanel && panelOpen) {
      setPanelOpen(false)
    } else {
      setActivePanel(panel)
      setPanelOpen(hasSideContent)
    }
    if (effectiveProjectId) {
      navigate(panelRoutes[panel])
    }
  }

  const effectivePanelOpen = panelOpen && panelsWithSideContent.has(activePanel!) && !!routeProjectId

  return (
    <div className="workbench-shell">
      {isElectron && (
        <TitleBar
          projectName={projectName}
          headerBranch={headerBranch}
          nodeCount={nodeCount}
          onPanelToggle={handlePanelToggle}
        />
      )}
      <ActivityBar activePanel={effectivePanelOpen ? activePanel : null} onPanelToggle={handlePanelToggle} onHome={() => navigate('/')} hasProject={!!effectiveProjectId} />

      {panelPosition === 'left' && (
        <SidePanel
          activePanel={activePanel}
          open={effectivePanelOpen}
          position="left"
          onClose={() => setPanelOpen(false)}
          onFlipPosition={() => setPanelPosition('right')}
        >
          <PanelContent panel={activePanel} projectId={effectiveProjectId} />
        </SidePanel>
      )}

      <main className="workbench-main">
        <div className="workbench-island">
          <div className="island-body">
            <Outlet context={{ onCreateProject: () => setCreateDialogOpen(true) }} />
          </div>
        </div>
      </main>

      {panelPosition === 'right' && (
        <SidePanel
          activePanel={activePanel}
          open={effectivePanelOpen}
          position="right"
          onClose={() => setPanelOpen(false)}
          onFlipPosition={() => setPanelPosition('left')}
        >
          <PanelContent panel={activePanel} projectId={effectiveProjectId} />
        </SidePanel>
      )}

      <ProjectCreateDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} />
    </div>
  )
}

function PanelContent({ panel, projectId }: { panel: ActivityPanel | null; projectId: string }) {
  if (!panel) return null

  switch (panel) {
    case 'coordinates':
      return <CoordinatesPanelContent projectId={projectId} />
    case 'wiki':
      return <WikiPanelContent projectId={projectId} />
    case 'sessions':
      return <SessionsPanelContent />
    case 'search':
      return <SearchPanelContent />
    default:
      return null
  }
}

function CoordinatesPanelContent({ projectId }: { projectId: string }) {
  const project = useShellStore(s => s.projects.find(p => p.id === projectId))
  const projectName = project?.name ?? projectId
  const nodes = useCoordinatesState(projectId, projectName, s => s.forest.nodes)
  const selectedNodeId = useCoordinatesState(projectId, projectName, s => s.selectedNodeId)
  const setSelectedNode = useCoordinatesState(projectId, projectName, s => s.setSelectedNode)

  const nodeList = useMemo(() => Object.values(nodes), [nodes])

  return (
    <div className="sp-section">
      <div className="sp-section-title">节点列表</div>
      <div className="sp-list">
        {nodeList.length === 0 && (
          <div className="sp-empty">暂无节点</div>
        )}
        {nodeList.map(node => (
          <button
            key={node.id}
            type="button"
            className={`sp-list-item${selectedNodeId === node.id ? ' sp-list-item-active' : ''}`}
            onClick={() => setSelectedNode(node.id)}
          >
            <Circle size={6} className={`shrink-0 ${node.type === 'goal' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} fill="currentColor" />
            <span className="truncate">{node.label || node.id}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function WikiPanelContent({ projectId }: { projectId: string }) {
  const documents = useWikiStore(s => s.documents)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const loadLatest = useWikiStore(s => s.loadLatest)
  const loading = useWikiStore(s => s.loading.snapshot)

  useEffect(() => {
    if (projectId) loadLatest(projectId)
  }, [projectId, loadLatest])

  return (
    <div className="sp-section">
      <div className="sp-section-title">文档</div>
      <div className="sp-list">
        {loading && <div className="sp-empty">加载中...</div>}
        {!loading && documents.length === 0 && (
          <div className="sp-empty">暂无文档</div>
        )}
        {documents.map(doc => (
          <button
            key={doc.id}
            type="button"
            className={`sp-list-item${selectedDocumentId === doc.id ? ' sp-list-item-active' : ''}`}
            onClick={() => selectDocument(doc.id)}
          >
            <FileText size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
            <span className="truncate">{doc.title || doc.id}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SessionsPanelContent() {
  return <SessionList />
}

function SearchPanelContent() {
  return (
    <div className="sp-section">
      <input type="text" placeholder="搜索节点、文档..." className="sp-search-input" />
    </div>
  )
}
