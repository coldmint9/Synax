import { useCallback, useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { GitBranch, Plus, RefreshCw, Scissors, Trash2 } from 'lucide-react'
import { projectApi, type GitWorkspaceSummary } from '../../../../lib/api/project'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsCard } from './SettingsCard'

export function GitWorktreesSection({ projectId }: { projectId: string }) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const [summary, setSummary] = useState<GitWorkspaceSummary | null>(null)
  const [branch, setBranch] = useState('')
  const [startPoint, setStartPoint] = useState('HEAD')
  const [createBranch, setCreateBranch] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setBusy('reload')
    setError(null)
    try {
      setSummary(await projectApi.listGitWorkspaces(projectId))
    } catch (cause) {
      setSummary(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [projectId])

  useEffect(() => { void reload() }, [reload])

  const create = async () => {
    const name = branch.trim()
    if (!name) return
    setBusy('create')
    setError(null)
    try {
      await projectApi.createGitWorktree(projectId, {
        branch: name,
        createBranch,
        startPoint: createBranch ? (startPoint.trim() || 'HEAD') : undefined,
      })
      setBranch('')
      setSummary(await projectApi.listGitWorkspaces(projectId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (path: string, force: boolean) => {
    const accepted = window.confirm(zh ? `删除工作树？\n${path}` : `Remove worktree?\n${path}`)
    if (!accepted) return
    setBusy(path)
    setError(null)
    try {
      await projectApi.removeGitWorktree(projectId, { path, force })
      setSummary(await projectApi.listGitWorkspaces(projectId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const prune = async () => {
    setBusy('prune')
    setError(null)
    try {
      setSummary(await projectApi.pruneGitWorktrees(projectId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsCard
      title={zh ? 'Git 工作树' : 'Git worktrees'}
      description={zh ? '为并行会话维护独立工作目录' : 'Maintain isolated working directories for parallel sessions'}
      icon={GitBranch}
      trailing={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label={zh ? '清理失效工作树' : 'Prune stale worktrees'} onPress={() => void prune()} isDisabled={Boolean(busy)}>
            <Scissors size={13} />
          </Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={zh ? '刷新工作树' : 'Refresh worktrees'} onPress={() => void reload()} isDisabled={Boolean(busy)}>
            <RefreshCw size={13} className={busy === 'reload' ? 'animate-spin' : ''} />
          </Button>
        </div>
      }
    >
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}

      {summary && (
        <>
          <div className="divide-y divide-border/40 border-y border-border/40">
            {summary.worktrees.map(worktree => (
              <div key={worktree.path} className="flex min-w-0 items-center gap-3 py-3">
                <GitBranch size={14} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                    <span className="font-medium">{worktree.branch ?? (zh ? '分离 HEAD' : 'Detached HEAD')}</span>
                    {worktree.primary && <span className="text-xs text-muted-foreground">{zh ? '主工作树' : 'Primary'}</span>}
                    {worktree.managed && <span className="text-xs text-muted-foreground">Synax</span>}
                    {worktree.dirty && <span className="text-xs text-warning">{zh ? '有未提交修改' : 'Dirty'}</span>}
                    {worktree.sessionCount > 0 && <span className="text-xs text-primary">{worktree.sessionCount} {zh ? '个会话' : 'sessions'}</span>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={worktree.path}>{worktree.path}</p>
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
            <label className="min-w-52 flex-1 text-xs text-muted-foreground">
              <span className="mb-1.5 block">{createBranch ? (zh ? '新分支名称' : 'New branch name') : (zh ? '现有分支' : 'Existing branch')}</span>
              {createBranch ? (
                <input className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground" value={branch} onChange={event => setBranch(event.target.value)} placeholder="feature/my-change" />
              ) : (
                <select className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground" value={branch} onChange={event => setBranch(event.target.value)}>
                  <option value="">{zh ? '选择分支' : 'Choose branch'}</option>
                  {summary.branches.filter(item => !item.checkedOutPath).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              )}
            </label>
            {createBranch && (
              <label className="min-w-40 text-xs text-muted-foreground">
                <span className="mb-1.5 block">{zh ? '起点' : 'Start point'}</span>
                <input className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground" value={startPoint} onChange={event => setStartPoint(event.target.value)} />
              </label>
            )}
            <label className="flex h-9 items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={createBranch} onChange={event => { setCreateBranch(event.target.checked); setBranch('') }} />
              {zh ? '创建新分支' : 'Create branch'}
            </label>
            <Button size="sm" onPress={() => void create()} isDisabled={!branch.trim() || Boolean(busy)} isPending={busy === 'create'}>
              {({ isPending }) => <>{isPending ? null : <Plus size={13} />}{zh ? '创建工作树' : 'Create worktree'}</>}
            </Button>
          </div>
        </>
      )}
    </SettingsCard>
  )
}
