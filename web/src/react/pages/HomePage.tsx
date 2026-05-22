import { Link as RouterLink } from 'react-router-dom'
import { Button, Modal, Link } from '@heroui/react'
import { Plus, Search, Trash2, SlidersHorizontal, ArrowUpDown, X, FolderCode, Shield, Settings2, Bot } from 'lucide-react'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { projectApi } from '../../lib/api/project'
import { ProjectCard } from '../components/ProjectCard'

const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-success',
  at_risk: 'bg-warning',
  blocked: 'bg-destructive',
}

const STATUS_LABEL: Record<string, string> = {
  healthy: '健康',
  at_risk: '风险',
  blocked: '阻塞',
}

const SORT_OPTIONS: { label: string; value: string }[] = [
  { label: '创建时间', value: 'createdAt' },
  { label: '项目名称', value: 'name' },
  { label: '健康评分', value: 'healthScore' },
  { label: '更新时间', value: 'updatedAt' },
]

export default function HomePage() {
  const projects = useShellStore(s => s.projects)
  const setProjects = useShellStore(s => s.setProjects)
  const removeFromStore = useShellStore(s => s.removeProject)
  const filter = useShellStore(s => s.projectFilter)
  const setFilter = useShellStore(s => s.setProjectFilter)

  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [loading, setLoading] = useState(true)

  // Fetch projects from backend on mount
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

  // Client-side filtering and sorting
  const filteredProjects = useMemo(() => {
    let result = [...projects]

    // Search
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

    // Status filter
    if (filter.statusFilter.length > 0) {
      result = result.filter(p => filter.statusFilter.includes(p.status))
    }

    // Environment filter
    if (filter.environmentFilter.length > 0) {
      result = result.filter(p => filter.environmentFilter.includes(p.environment))
    }

    // Sort
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
        case 'createdAt':
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

  // Delete handler
  const handleDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const result = await projectApi.deleteProject(deleteTarget.id)
      removeFromStore(deleteTarget.id)
      setDeleteTarget(null)
      if (result.gitCleaned) {
        console.log('[HomePage] Git work directory cleaned for', deleteTarget.id)
      }
    } catch (err) {
      console.error('[HomePage] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, removeFromStore])

  // Toggle filter
  const toggleStatusFilter = useCallback((status: string) => {
    setFilter({
      statusFilter: filter.statusFilter.includes(status)
        ? filter.statusFilter.filter(s => s !== status)
        : [...filter.statusFilter, status],
    })
  }, [filter.statusFilter, setFilter])

  const toggleEnvFilter = useCallback((env: string) => {
    setFilter({
      environmentFilter: filter.environmentFilter.includes(env)
        ? filter.environmentFilter.filter(e => e !== env)
        : [...filter.environmentFilter, env],
    })
  }, [filter.environmentFilter, setFilter])

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              项目
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              管理与协调你的 Agent 项目
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/projects/new" className="button button--sm button--primary inline-flex items-center gap-1.5">
              <Plus size={14} />
              导入项目
            </Link>
            <Link href="/settings" className="button button--sm button--outline inline-flex items-center gap-1.5">
              <Settings2 size={14} />
              系统配置
            </Link>
            <Link href="/agent-loop-test" className="button button--sm button--outline inline-flex items-center gap-1.5">
              <Bot size={14} />
              Loop 测试
            </Link>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="search-input-wrapper">
            <Search size={14} className="absolute left-2.5 text-muted-foreground/60" />
            <input
              type="text"
              className="search-input"
              placeholder="搜索项目名称、ID 或仓库…"
              value={filter.search}
              onChange={e => setFilter({ search: e.target.value })}
            />
            {filter.search && (
              <button
                className="absolute right-2 text-muted-foreground/40 hover:text-muted-foreground"
                onClick={() => setFilter({ search: '' })}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filter toggle */}
          <button
            className="filter-chip"
            data-active={showFilters || filter.statusFilter.length > 0 || filter.environmentFilter.length > 0}
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal size={13} />
            筛选
            {(filter.statusFilter.length > 0 || filter.environmentFilter.length > 0) && (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
                {filter.statusFilter.length + filter.environmentFilter.length}
              </span>
            )}
          </button>

          {/* Sort */}
          <select
            className="sort-select"
            value={filter.sortBy}
            onChange={e => setFilter({ sortBy: e.target.value as typeof filter.sortBy })}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            className="filter-chip"
            onClick={() => setFilter({ sortOrder: filter.sortOrder === 'asc' ? 'desc' : 'asc' })}
          >
            <ArrowUpDown size={13} />
            {filter.sortOrder === 'asc' ? '升序' : '降序'}
          </button>

          {/* Clear all */}
          {(filter.search || filter.statusFilter.length > 0 || filter.environmentFilter.length > 0) && (
            <button
              className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition"
              onClick={() => setFilter({ search: '', statusFilter: [], environmentFilter: [] })}
            >
              清除
            </button>
          )}
        </div>

        {/* Expanded filters */}
        {showFilters && (
          <div className="mt-3 space-y-2 rounded-xl border border-border/40 bg-card/60 p-3 animate-fade-up">
            {/* Status filter */}
            <div>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">状态</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {['healthy', 'at_risk', 'blocked'].map(s => (
                  <button
                    key={s}
                    className="filter-chip"
                    data-active={filter.statusFilter.includes(s)}
                    onClick={() => toggleStatusFilter(s)}
                  >
                    <div className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} />
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            {/* Environment filter */}
            <div>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">环境</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {['production', 'staging', 'development'].map(e => (
                  <button
                    key={e}
                    className="filter-chip"
                    data-active={filter.environmentFilter.includes(e)}
                    onClick={() => toggleEnvFilter(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Result count */}
        {filter.search && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            找到 {filteredProjects.length} 个项目
            {filteredProjects.length !== projects.length && `（共 ${projects.length} 个）`}
          </p>
        )}

        {/* Project Grid */}
        {loading ? (
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="project-card animate-pulse">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-secondary" />
                  <div className="h-4 w-24 rounded bg-secondary" />
                </div>
                <div className="mt-2 flex gap-2">
                  <div className="h-4 w-14 rounded-full bg-secondary" />
                  <div className="h-4 w-10 rounded-full bg-secondary" />
                </div>
                <div className="mt-3 flex gap-4">
                  <div className="h-3 w-10 rounded bg-secondary" />
                  <div className="h-3 w-8 rounded bg-secondary" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredProjects.length === 0 && !filter.search ? (
          <div className="mt-8 empty-state rounded-xl border border-border/40">
            <div className="empty-state-icon">
              <FolderCode size={22} />
            </div>
            <p className="text-sm font-medium text-foreground">还没有项目</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-xs">
              导入代码仓库或创建空白项目，启动 AI 协调分析
            </p>
            <Link href="/projects/new" className="button button--sm button--primary inline-flex items-center gap-1.5 mt-4">
              <Plus size={13} />
              导入第一个项目
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Import card (always first) */}
            <RouterLink to="/projects/new" className="new-project-card group">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-current/30 transition group-hover:border-current/50 group-hover:bg-primary/10">
                <Plus size={20} strokeWidth={1.5} />
              </div>
              <span className="text-xs font-medium">导入新项目</span>
            </RouterLink>

            {/* Project cards */}
            {filteredProjects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={() => setDeleteTarget(project)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal (controlled) */}
      <Modal.Backdrop isOpen={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null) }}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[26rem]">
            {deleteTarget && (
              <DeleteConfirmContent
                project={deleteTarget}
                onConfirm={handleDelete}
                onCancel={() => setDeleteTarget(null)}
                loading={deleting}
              />
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}

// ── Delete Confirmation Content (inside Modal) ───────────────────────────────

function DeleteConfirmContent({
  project,
  onConfirm,
  onCancel,
  loading,
}: {
  project: ProjectSummary
  onConfirm: () => void
  onCancel: () => void
  loading: boolean
}) {
  const hasGitSource = project.source?.kind === 'github' || project.source?.kind === 'gitlab'

  return (
    <>
      <Modal.Header>
        <Modal.Icon className="bg-destructive/10 text-destructive">
          <Trash2 size={18} />
        </Modal.Icon>
        <Modal.Heading>删除项目「{project.name}」</Modal.Heading>
      </Modal.Header>
      <Modal.Body>
        <p className="text-sm text-muted-foreground">
          此操作不可撤销。项目将从列表中移除，关联的配置和元数据将被永久删除。
        </p>
        {hasGitSource && (
          <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Shield size={12} className="inline mr-1" />
            Git 工作目录（.data/repos/）中的克隆代码也将被清理。
          </div>
        )}
        {project.source?.kind === 'scratch' && project.importState === 'syncing' && (
          <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            该项目仍在同步中，删除可能导致数据不完整。
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onPress={onCancel} isDisabled={loading}>
          取消
        </Button>
        <Button variant="danger" size="sm" onPress={onConfirm} isDisabled={loading}>
          {loading ? '删除中…' : '确认删除'}
        </Button>
      </Modal.Footer>
    </>
  )
}
