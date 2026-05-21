import { BrainCircuit, BookOpen, FolderCode, GitBranch, Home, Moon, Settings2, Sun } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { formatProjectPath } from '../../lib/formatProjectPath'
import { headerGitBranchLabel } from '../../lib/projectGitBranch'
import { projectApi } from '../../lib/api/project'
import { useCoordinatesState } from '../state/coordinatesStore'
import { addProject, useShellStore } from '../state/shellStore'

export default function ProjectLayout() {
  const { projectId = '' } = useParams()
  const project = useShellStore(s => s.projects.find(p => p.id === projectId) ?? null)
  /** When GET /projects/:id returns 404, record which id so we do not treat the next route as failed. */
  const [notFoundForId, setNotFoundForId] = useState<string | null>(null)

  useEffect(() => {
    setNotFoundForId(null)
    if (!projectId) return
    const inStore = useShellStore.getState().projects.some(p => p.id === projectId)
    if (inStore) return

    let cancelled = false
    void projectApi.getProject(projectId).then((p) => {
      if (cancelled) return
      if (p) addProject(p)
      else setNotFoundForId(projectId)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const sidebarMissingProject = Boolean(projectId) && !project
  const sidebarProjectLoading = sidebarMissingProject && notFoundForId !== projectId

  const projectName = project?.name ?? (projectId || '—')
  const forestSource = useCoordinatesState(projectId, projectName, s => s.forest.source)
  const headerBranch = useMemo(
    () => headerGitBranchLabel(project, forestSource),
    [project, forestSource],
  )
  const nodeCount = useCoordinatesState(projectId, projectName, s => Object.keys(s.forest.nodes).length)
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navItems = [
    { to: `/projects/${projectId}/coordinates`, label: 'Coordinates', icon: BrainCircuit },
    { to: `/projects/${projectId}/wiki`, label: 'Wiki', icon: BookOpen },
    { to: `/projects/${projectId}/settings`, label: '项目配置', icon: Settings2 },
  ]

  return (
    <div className="relative flex h-full min-h-0">
      {/* ── Pull handle (always visible when drawer closed) ── */}
      {!drawerOpen && (
        <button
          type="button"
          aria-label="Open sidebar"
          className={`sidebar-handle z-20 flex items-center gap-1${headerBranch ? ' sidebar-handle-expanded' : ''}`}
          onClick={() => setDrawerOpen(true)}
        >
          <BrainCircuit size={14} className="shrink-0" />
          {headerBranch ? (
            <span
              className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/75"
              title={`Git 分支：${headerBranch}`}
            >
              {headerBranch}
            </span>
          ) : null}
        </button>
      )}

      {/* ── Drawer overlay ── */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[2px]"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* ── Sliding sidebar drawer ── */}
      <aside
        className={`sidebar-drawer ${drawerOpen ? 'sidebar-drawer-open' : 'sidebar-drawer-closed'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 rounded-xl border border-border/50 bg-background/55 p-3">
            {project ? (
              <>
                <div className="flex min-w-0 items-center gap-1.5">
                  <div className="truncate text-sm font-semibold text-foreground">{project.name}</div>
                  {headerBranch ? (
                    <span
                      className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/75"
                      title={`Git 分支：${headerBranch}`}
                    >
                      <GitBranch size={11} className="text-muted-foreground/55" />
                      <span className="max-w-[7rem] truncate font-mono">{headerBranch}</span>
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                
                  <div className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground/85">
                    {project.source?.kind === 'github' || project.source?.kind === 'gitlab' ? (
                      <GitBranch size={12} className="mt-0.5 shrink-0 text-muted-foreground/50" />
                    ) : (
                      <FolderCode size={12} className="mt-0.5 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className="min-w-0 break-all leading-snug" title={formatProjectPath(project)}>
                      {formatProjectPath(project)}
                    </span>
                  </div>
                </div>
                <div className="mt-2 text-xs tabular-nums text-muted-foreground">
                  节点 <span className="font-medium text-foreground">{nodeCount}</span>
                </div>
              </>
            ) : sidebarProjectLoading ? (
              <>
                <div className="truncate text-sm font-semibold text-muted-foreground">加载项目…</div>
                <p className="mt-1 text-xs text-muted-foreground">正在从服务器获取项目信息</p>
                <div className="mt-2 text-xs tabular-nums text-muted-foreground">
                  节点 <span className="font-medium text-foreground">{nodeCount}</span>
                </div>
              </>
            ) : (
              <>
                <div className="truncate text-sm font-semibold text-foreground">{projectId || '未知项目'}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {notFoundForId === projectId
                    ? '未找到该项目，可能已被删除或 ID 不正确。'
                    : '列表中暂无该项目，请返回首页同步。'}
                </p>
                <div className="mt-2 text-xs tabular-nums text-muted-foreground">
                  节点 <span className="font-medium text-foreground">{nodeCount}</span>
                </div>
              </>
            )}
          </div>
         
        </div>
        <nav className="mt-3 space-y-1">
          {navItems.map(item => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.label}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition ${isActive ? 'bg-primary/18 text-primary' : 'text-muted-foreground hover:bg-secondary/45'}`
                }
                onClick={() => setDrawerOpen(false)}
              >
                <Icon size={14} className="shrink-0" />
                {item.label}
              </NavLink>
            )
          })}
        </nav>
        <button
          type="button"
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl border border-border/50 px-3 py-2 text-xs text-muted-foreground hover:bg-secondary/60"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          {`Theme: ${theme}`}
        </button>
        <Link
          to="/"
          className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs text-muted-foreground hover:bg-secondary/60 transition"
          onClick={() => setDrawerOpen(false)}
        >
          <Home size={13} />
          Back to Projects
        </Link>
      </aside>

      {/* ── Main content fills entire viewport ── */}
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
