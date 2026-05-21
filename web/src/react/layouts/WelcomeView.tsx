import { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plus, FolderCode, Search, Trash2 } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { projectApi, type ProjectStats } from '../../lib/api/project'
import { ProjectCard } from '../components/ProjectCard'

interface WorkbenchContext {
  onCreateProject: () => void
}

export function WelcomeView() {
  const { onCreateProject } = useOutletContext<WorkbenchContext>()
  const projects = useShellStore(s => s.projects)
  const projectsLoaded = useShellStore(s => s.projectsLoaded)
  const fetchProjects = useShellStore(s => s.fetchProjects)
  const removeFromStore = useShellStore(s => s.removeProject)

  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [statsMap, setStatsMap] = useState<Record<string, ProjectStats>>({})

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects()
  }, [projectsLoaded, fetchProjects])

  // Fetch stats for all projects once loaded
  useEffect(() => {
    if (!projectsLoaded || projects.length === 0) return
    let cancelled = false
    void Promise.all(
      projects.map(p => projectApi.getProjectStats(p.id))
    ).then(results => {
      if (cancelled) return
      const map: Record<string, ProjectStats> = {}
      projects.forEach((p, i) => {
        if (results[i]) map[p.id] = results[i]!
      })
      setStatsMap(map)
    })
    return () => { cancelled = true }
  }, [projectsLoaded, projects])

  const filtered = search
    ? projects.filter(p =>
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.source?.localPath?.toLowerCase().includes(search.toLowerCase()) ||
        p.source?.repo?.toLowerCase().includes(search.toLowerCase())
      )
    : projects

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await projectApi.deleteProject(deleteTarget.id)
      removeFromStore(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[Dashboard] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, removeFromStore])

  if (!projectsLoaded) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="project-card animate-pulse">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-secondary" />
                  <div className="h-4 w-24 rounded bg-secondary" />
                </div>
                <div className="mt-2 h-3 w-16 rounded bg-secondary" />
                <div className="mt-3 flex gap-4">
                  <div className="h-3 w-10 rounded bg-secondary" />
                  <div className="h-3 w-8 rounded bg-secondary" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary/60">
            <FolderCode size={24} className="text-muted-foreground" />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">还没有项目</p>
          <p className="mt-1 text-xs text-muted-foreground">
            导入代码仓库或创建空白项目，启动 AI 协调分析
          </p>
          <button
            type="button"
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
            onClick={onCreateProject}
          >
            <Plus size={13} />
            导入第一个项目
          </button>
        </div>
      </div>
    )
  }

  // Dashboard
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">项目</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {projects.length} 个项目
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
            onClick={onCreateProject}
          >
            <Plus size={13} />
            导入项目
          </button>
        </div>

        {/* Search (show when > 5 projects) */}
        {projects.length > 5 && (
          <div className="relative mt-4">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              className="w-full rounded-lg border border-border/40 bg-background/60 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none"
              placeholder="搜索项目…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        )}

        {/* Project grid */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {filtered.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              stats={statsMap[project.id]}
              onDelete={() => setDeleteTarget(project)}
            />
          ))}
        </div>

        {search && filtered.length === 0 && (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            未找到匹配的项目
          </p>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="dialog-overlay" onClick={deleting ? undefined : () => setDeleteTarget(null)}>
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10">
                <Trash2 size={16} className="text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-foreground">
                  删除「{deleteTarget.name}」
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  此操作不可撤销，项目配置和元数据将被永久删除。
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg border border-border/50 px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary disabled:opacity-40"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:opacity-40"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}