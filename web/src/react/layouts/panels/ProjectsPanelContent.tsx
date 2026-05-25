import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Trash2, X, Shield, Circle } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../../state/shellStore'
import { projectApi } from '../../../lib/api/project'

const STATUS_COLOR: Record<string, string> = {
  healthy: 'text-success',
  at_risk: 'text-warning',
  blocked: 'text-destructive',
}

interface ProjectsPanelContentProps {
  onCreateProject: () => void
}

export function ProjectsPanelContent({ onCreateProject }: ProjectsPanelContentProps) {
  const navigate = useNavigate()
  const projects = useShellStore(s => s.projects)
  const setProjects = useShellStore(s => s.setProjects)
  const removeFromStore = useShellStore(s => s.removeProject)
  const filter = useShellStore(s => s.projectFilter)
  const setFilter = useShellStore(s => s.setProjectFilter)

  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { items } = await projectApi.listProjects()
        if (!cancelled) {
          setProjects(items)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [setProjects])

  const filteredProjects = useMemo(() => {
    let result = [...projects]
    if (filter.search) {
      const q = filter.search.toLowerCase()
      result = result.filter(
        p =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.source?.repo && p.source.repo.toLowerCase().includes(q)) ||
          (p.source?.localPath && p.source.localPath.toLowerCase().includes(q)),
      )
    }
    if (filter.statusFilter.length > 0) {
      result = result.filter(p => filter.statusFilter.includes(p.status))
    }
    if (filter.environmentFilter.length > 0) {
      result = result.filter(p => filter.environmentFilter.includes(p.environment))
    }
    result.sort((a, b) => {
      let aVal: number | string, bVal: number | string
      switch (filter.sortBy) {
        case 'name':
          aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase()
          break
        case 'healthScore':
          aVal = a.healthScore; bVal = b.healthScore
          break
        case 'updatedAt':
          aVal = a.updatedAt === 'just now' ? Date.now() : new Date(a.updatedAt).getTime()
          bVal = b.updatedAt === 'just now' ? Date.now() : new Date(b.updatedAt).getTime()
          break
        default:
          aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0
          bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0
          break
      }
      const cmp = typeof aVal === 'string' ? aVal.localeCompare(bVal as string) : aVal - (bVal as number)
      return filter.sortOrder === 'asc' ? cmp : -cmp
    })
    return result
  }, [projects, filter])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await projectApi.deleteProject(deleteTarget.id)
      removeFromStore(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[ProjectsPanel] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, removeFromStore])

  return (
    <div className="sp-section">
      {/* Search + Add */}
      <div className="flex items-center gap-1 px-1 pb-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
          <input
            type="text"
            className="sp-search-input pl-6"
            placeholder="搜索项目…"
            value={filter.search}
            onChange={e => setFilter({ search: e.target.value })}
          />
          {filter.search && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground"
              onClick={() => setFilter({ search: '' })}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="sp-btn shrink-0"
          title="导入项目"
          onClick={onCreateProject}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Project list */}
      <div className="sp-list">
        {loading && <div className="sp-empty">加载中...</div>}
        {!loading && filteredProjects.length === 0 && (
          <div className="sp-empty">
            {filter.search ? '无匹配项目' : '暂无项目'}
          </div>
        )}
        {filteredProjects.map(project => (
          <button
            key={project.id}
            type="button"
            className="sp-list-item group"
            onClick={() => navigate(`/projects/${project.id}/wiki`)}
          >
            <Circle
              size={6}
              className={`shrink-0 ${STATUS_COLOR[project.status] ?? 'text-muted-foreground'}`}
              fill="currentColor"
            />
            <span className="flex-1 truncate text-left">{project.name}</span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground/30 opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              onClick={e => {
                e.stopPropagation()
                setDeleteTarget(project)
              }}
              title="删除"
            >
              <Trash2 size={11} />
            </button>
          </button>
        ))}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="dialog-overlay" onClick={deleting ? undefined : () => setDeleteTarget(null)}>
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10">
                <Trash2 size={18} className="text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <h3>删除项目「{deleteTarget.name}」</h3>
                <p className="mt-1">此操作不可撤销。</p>
                {(deleteTarget.source?.kind === 'github' || deleteTarget.source?.kind === 'gitlab') && (
                  <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                    <Shield size={12} className="inline mr-1" />
                    Git 工作目录中的克隆代码也将被清理。
                  </div>
                )}
              </div>
            </div>
            <div className="dialog-actions">
              <button
                className="inline-flex items-center rounded-lg border border-border/50 bg-background/60 px-4 py-2 text-xs text-foreground hover:bg-background/90 transition disabled:opacity-40"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="inline-flex items-center rounded-lg bg-destructive px-4 py-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition disabled:opacity-40"
                onClick={handleDelete}
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
