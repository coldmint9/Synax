import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Label, ListBox, Select, TextField } from '@heroui/react'
import { GitBranch, Plus, RefreshCw, Scissors, Trash2 } from 'lucide-react'
import { projectApi, type GitWorkspaceSummary, type ProjectWorkspaceRoot } from '../../../../lib/api/project'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsCard } from './SettingsCard'
import { WorkspaceRootSelect } from '../../workspace/WorkspaceRootSelect'

export function GitWorktreesSection({ projectId }: { projectId: string }) {
  return <GitWorktreesContent key={projectId} projectId={projectId} />
}

function GitWorktreesContent({ projectId }: { projectId: string }) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const [roots, setRoots] = useState<ProjectWorkspaceRoot[]>([])
  const [rootId, setRootId] = useState('')
  const [summary, setSummary] = useState<GitWorkspaceSummary | null>(null)
  const [branch, setBranch] = useState('')
  const [startPoint, setStartPoint] = useState('HEAD')
  const [createBranch, setCreateBranch] = useState(false)
  const [busy, setBusy] = useState<string | null>('roots')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const locked = useRef(false)
  const selectedRoot = roots.find(root => root.id === rootId)
  const canOperate = selectedRoot?.status === 'available' && Boolean(summary)

  // Every selection invalidates reads, mutations and follow-up refreshes for the old root.
  const run = useCallback(async (action: string, task: (isCurrent: () => boolean) => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    const request = ++generation.current
    const isCurrent = () => generation.current === request
    setBusy(action)
    setError(null)
    try {
      await task(isCurrent)
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) {
        locked.current = false
        setBusy(null)
      }
    }
  }, [])

  const resetForm = () => {
    setBranch('')
    setStartPoint('HEAD')
    setCreateBranch(false)
  }

  const reload = useCallback((preferredRootId?: string) => run('roots', async isCurrent => {
    setSummary(null)
    setRoots([])
    setBranch('')
    setStartPoint('HEAD')
    setCreateBranch(false)
    const result = await projectApi.getWorkspace(projectId)
    if (!isCurrent()) return
    const root = result.roots.find(item => item.id === preferredRootId)
      ?? result.roots.find(item => item.role === 'primary')
      ?? result.roots[0]
    setRoots(result.roots)
    setRootId(root?.id ?? '')
    if (root?.status !== 'available') return
    setBusy('reload')
    const nextSummary = await projectApi.listGitWorkspaces(projectId, root.id)
    if (isCurrent()) setSummary(nextSummary)
  }), [projectId, run])

  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
      locked.current = false
    }
  }, [reload])

  const selectRoot = (id: string) => {
    const root = roots.find(item => item.id === id)
    if (!root || root.status !== 'available' || id === rootId) return
    generation.current += 1
    locked.current = false
    setRootId(id)
    setSummary(null)
    resetForm()
    void run('reload', async isCurrent => {
      const nextSummary = await projectApi.listGitWorkspaces(projectId, id)
      if (isCurrent()) setSummary(nextSummary)
    })
  }

  const create = () => {
    const name = branch.trim()
    if (!name || !canOperate) return
    return run('create', async isCurrent => {
      await projectApi.createGitWorktree(projectId, {
        rootId,
        branch: name,
        createBranch,
        startPoint: createBranch ? (startPoint.trim() || 'HEAD') : undefined,
      })
      if (!isCurrent()) return
      setBranch('')
      const nextSummary = await projectApi.listGitWorkspaces(projectId, rootId)
      if (isCurrent()) setSummary(nextSummary)
    })
  }

  const remove = (path: string, force: boolean) => {
    if (!canOperate || locked.current) return
    const accepted = window.confirm(zh ? `删除工作树？\n${path}` : `Remove worktree?\n${path}`)
    if (!accepted) return
    return run(path, async isCurrent => {
      await projectApi.removeGitWorktree(projectId, { path, force, rootId })
      if (!isCurrent()) return
      const nextSummary = await projectApi.listGitWorkspaces(projectId, rootId)
      if (isCurrent()) setSummary(nextSummary)
    })
  }

  const prune = () => {
    if (!canOperate) return
    return run('prune', async isCurrent => {
      const nextSummary = await projectApi.pruneGitWorktrees(projectId, rootId)
      if (isCurrent()) setSummary(nextSummary)
    })
  }

  return (
    <SettingsCard
      title={zh ? 'Git 工作树' : 'Git worktrees'}
      description={zh ? '选择工作区内的项目，为并行会话维护独立工作目录' : 'Choose a project in this workspace to manage isolated working directories for parallel sessions'}
      icon={GitBranch}
      trailing={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label={zh ? '清理失效工作树' : 'Prune stale worktrees'} onPress={() => void prune()} isDisabled={!canOperate || Boolean(busy)}>
            <Scissors size={13} />
          </Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={zh ? '刷新工作树' : 'Refresh worktrees'} onPress={() => void reload(rootId)} isDisabled={Boolean(busy)}>
            <RefreshCw size={13} className={busy === 'roots' || busy === 'reload' ? 'animate-spin' : ''} />
          </Button>
        </div>
      }
    >
      <div className="workspace-worktrees">
      <WorkspaceRootSelect roots={roots} value={selectedRoot?.id ?? ''} onChange={selectRoot} disabled={busy === 'roots'} />
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
      {(busy === 'roots' || busy === 'reload') && <p role="status" className="mb-3 text-xs text-muted-foreground">{zh ? '正在加载项目与工作树…' : 'Loading projects and worktrees…'}</p>}
      {selectedRoot?.status === 'missing' && <p role="status" className="mb-3 text-xs text-warning">{zh ? '项目目录缺失，无法管理工作树。恢复目录后请刷新。' : 'The project directory is missing. Restore it and refresh to manage worktrees.'}</p>}
      {!busy && !error && roots.length === 0 && <p className="text-xs text-muted-foreground">{zh ? '此工作区尚未添加项目。' : 'This workspace has no projects yet.'}</p>}

      {summary && canOperate && (
        <>
          <div className="divide-y divide-border/40 border-y border-border/40">
            {summary.worktrees.map(worktree => (
              <div key={worktree.path} className="flex min-w-0 items-center gap-3 py-3">
                <GitBranch size={14} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
                    <span className="break-all font-medium">{worktree.branch ?? (zh ? '分离 HEAD' : 'Detached HEAD')}</span>
                    {worktree.primary && <span className="text-xs text-muted-foreground">{zh ? '主工作树' : 'Primary'}</span>}
                    {worktree.managed && <span className="text-xs text-muted-foreground">Synax</span>}
                    {worktree.dirty && <span className="text-xs text-warning">{zh ? '有未提交修改' : 'Dirty'}</span>}
                    {worktree.sessionCount > 0 && <span className="text-xs text-primary">{worktree.sessionCount} {zh ? '个会话' : 'sessions'}</span>}
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground" title={worktree.path}>{worktree.path}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">HEAD {worktree.head}</p>
                </div>
                {!worktree.primary && worktree.sessionCount === 0 && (
                  <Button
                    size="sm"
                    variant="danger-soft"
                    isIconOnly
                    aria-label={worktree.dirty ? (zh ? '强制删除工作树' : 'Force remove worktree') : (zh ? '删除工作树' : 'Remove worktree')}
                    isDisabled={Boolean(busy)}
                    onPress={() => void remove(worktree.path, worktree.dirty)}
                  >
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            {createBranch ? <TextField value={branch} onChange={setBranch} isDisabled={Boolean(busy)} className="min-w-0 flex-1"><Label>{zh ? '新分支名称' : 'New branch name'}</Label><Input placeholder="feature/my-change" /></TextField> :
              <Select value={branch || null} onChange={key => setBranch(key ? String(key) : '')} isDisabled={Boolean(busy)} placeholder={zh ? '选择分支' : 'Choose branch'} className="min-w-0 flex-1">
                <Label>{zh ? '现有分支' : 'Existing branch'}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox aria-label={zh ? '现有分支' : 'Existing branch'}>{summary.branches.filter(item => !item.checkedOutPath).map(item => <ListBox.Item key={item.name} id={item.name} textValue={item.name}>{item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
              </Select>}
            {createBranch && <TextField value={startPoint} onChange={setStartPoint} isDisabled={Boolean(busy)} className="min-w-0 flex-1"><Label>{zh ? '起点' : 'Start point'}</Label><Input /></TextField>}
            <label className="flex h-9 items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={createBranch} disabled={Boolean(busy)} onChange={event => { setCreateBranch(event.target.checked); setBranch('') }} />
              {zh ? '创建新分支' : 'Create branch'}
            </label>
            <Button size="sm" onPress={() => void create()} isDisabled={!branch.trim() || Boolean(busy)} isPending={busy === 'create'}>
              {({ isPending }) => <>{isPending ? null : <Plus size={13} />}{zh ? '创建工作树' : 'Create worktree'}</>}
            </Button>
          </div>
        </>
      )}
      </div>
    </SettingsCard>
  )
}
