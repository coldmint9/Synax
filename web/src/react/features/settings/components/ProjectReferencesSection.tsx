import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import { FolderOpen, Loader2, Plus, RefreshCw, Unlink } from 'lucide-react'
import { projectApi, type ProjectWorkspace } from '../../../../lib/api/project'
import { useLocale } from '../../../../hooks/useLocale'
import { isElectron, openDirectoryPicker } from '../../../../lib/open-directory-picker'
import type { ProjectSummary } from '../../../state/shellStore'
import { SettingsCard } from './SettingsCard'

const zh = {
  title: '项目目录与引用',
  description: '管理主目录和会话可使用的引用目录。',
  nextRun: '配置更改将在下一次会话执行时生效。',
  unlinkHint: '解除引用只移除关联，不会删除磁盘上的文件。',
  primary: '主目录',
  reference: '引用目录',
  available: '可用',
  missing: '目录缺失',
  noRoots: '尚未配置项目目录。',
  noReferences: '尚未添加引用目录。',
  refresh: '刷新目录和项目列表',
  loading: '正在加载目录和项目…',
  source: '添加方式',
  local: '本地目录',
  existing: '已有项目',
  path: '目录绝对路径',
  name: '引用名称（可选）',
  browse: '选择目录',
  browserHint: '浏览器版请输入服务端可访问的目录绝对路径；桌面版也可使用目录选择器。',
  project: '选择项目',
  chooseProject: '请选择项目',
  noProjects: '没有其他已配置本地目录的项目。',
  projectHint: '只记录所选项目的主目录路径，不会递归添加其引用目录。',
  add: '添加引用',
  remove: '解除引用',
  added: '已添加引用，将在下一次会话执行时生效。',
  removed: '已解除引用，文件已保留；将在下一次会话执行时生效。',
  loadError: '加载项目目录失败',
  projectsError: '加载已有项目失败，请刷新重试',
  addError: '添加引用失败',
  removeError: '解除引用失败',
  browseError: '选择目录失败',
  unknownError: '未知错误，请重试。',
}

type MessageKey = keyof typeof zh
const en: Record<MessageKey, string> = {
  title: 'Project directories and references',
  description: 'Manage the primary directory and reference directories available to sessions.',
  nextRun: 'Configuration changes take effect on the next session execution.',
  unlinkHint: 'Removing a reference only unlinks it. Files on disk are preserved.',
  primary: 'Primary directory',
  reference: 'Reference directory',
  available: 'Available',
  missing: 'Directory missing',
  noRoots: 'No project directories configured yet.',
  noReferences: 'No reference directories added yet.',
  refresh: 'Refresh directories and projects',
  loading: 'Loading directories and projects…',
  source: 'Add from',
  local: 'Local directory',
  existing: 'Existing project',
  path: 'Absolute directory path',
  name: 'Reference name (optional)',
  browse: 'Choose directory',
  browserHint: 'In the browser, enter an absolute directory path accessible to the server. The desktop app also supports the directory picker.',
  project: 'Select project',
  chooseProject: 'Choose a project',
  noProjects: 'No other projects with a local directory are available.',
  projectHint: 'Only the selected project’s primary directory path is recorded. Its references are not added recursively.',
  add: 'Add reference',
  remove: 'Remove reference',
  added: 'Reference added. It will take effect on the next session execution.',
  removed: 'Reference removed and files preserved. This takes effect on the next session execution.',
  loadError: 'Failed to load project directories',
  projectsError: 'Failed to load existing projects. Refresh to retry',
  addError: 'Failed to add reference',
  removeError: 'Failed to remove reference',
  browseError: 'Failed to choose directory',
  unknownError: 'Unknown error. Please retry.',
}

type Busy = 'reload' | 'add' | 'browse' | `remove:${string}`
type Failure = { key: MessageKey; detail: string }
const errorDetail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause ?? '')
const inputClass = 'h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground disabled:opacity-50'

// A new instance for each project also resets form input and directory picker results.
export function ProjectReferencesSection({ projectId }: { projectId: string }) {
  return <ProjectReferencesContent key={projectId} projectId={projectId} />
}

function ProjectReferencesContent({ projectId }: { projectId: string }) {
  const { locale } = useLocale()
  const t = (key: MessageKey): string => (locale === 'zh' ? zh : en)[key]
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [mode, setMode] = useState<'local' | 'existing'>('local')
  const [localPath, setLocalPath] = useState('')
  const [name, setName] = useState('')
  const [selectedProject, setSelectedProject] = useState('')
  const [busy, setBusy] = useState<Busy | null>('reload')
  const [error, setError] = useState<Failure | null>(null)
  const [projectsError, setProjectsError] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const locked = useRef(false)
  const generation = useRef(0)

  // The synchronous lock prevents repeated presses before React renders disabled controls.
  // Cleanup invalidates all outstanding requests, including a native directory dialog.
  const run = useCallback(async (
    action: Busy,
    failureKey: MessageKey,
    task: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (locked.current) return
    locked.current = true
    const request = ++generation.current
    const isCurrent = () => generation.current === request
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      await task(isCurrent)
    } catch (cause) {
      if (isCurrent()) setError({ key: failureKey, detail: errorDetail(cause) })
    } finally {
      if (isCurrent()) {
        locked.current = false
        setBusy(null)
      }
    }
  }, [])

  const reload = useCallback(() => run('reload', 'loadError', async isCurrent => {
    const [rootsResult, projectsResult] = await Promise.allSettled([
      projectApi.getWorkspace(projectId),
      projectApi.listProjects(undefined, { throwOnError: true }),
    ])
    if (!isCurrent()) return
    if (rootsResult.status === 'fulfilled') {
      setWorkspace(rootsResult.value)
    } else {
      setWorkspace(null)
      setError({ key: 'loadError', detail: errorDetail(rootsResult.reason) })
    }
    if (projectsResult.status === 'fulfilled') {
      setProjects(projectsResult.value.items.filter(project => project.id !== projectId && project.source?.localPath?.trim()))
      setProjectsError(null)
    } else {
      setProjects([])
      setProjectsError({ key: 'projectsError', detail: errorDetail(projectsResult.reason) })
    }
  }), [projectId, run])

  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
      locked.current = false
    }
  }, [reload])

  const selected = projects.find(project => project.id === selectedProject)
  const canAdd = Boolean(workspace) && (mode === 'local' ? Boolean(localPath.trim()) : Boolean(selected))

  const add = () => {
    if (!canAdd) return
    void run('add', 'addError', async isCurrent => {
      const result = await projectApi.addReference(projectId, mode === 'local'
        ? { localPath: localPath.trim(), ...(name.trim() ? { name: name.trim() } : {}) }
        : { projectId: selectedProject })
      if (!isCurrent()) return
      setWorkspace(result)
      setLocalPath('')
      setName('')
      setSelectedProject('')
      setNotice('added')
    })
  }

  const remove = (referenceId: string) => {
    void run(`remove:${referenceId}`, 'removeError', async isCurrent => {
      const result = await projectApi.removeReference(projectId, referenceId)
      if (!isCurrent()) return
      setWorkspace(result)
      setNotice('removed')
    })
  }

  const browse = () => {
    void run('browse', 'browseError', async isCurrent => {
      const result = await openDirectoryPicker()
      if (!isCurrent() || !result) return
      setLocalPath(result.path)
      setName(current => current || result.name)
    })
  }

  const disabled = Boolean(busy)
  const failureText = (failure: Failure) => `${t(failure.key)}: ${failure.detail || t('unknownError')}`
  const roots = workspace?.roots ?? []

  return (
    <SettingsCard
      title={t('title')}
      description={t('description')}
      icon={FolderOpen}
      trailing={
        <Button size="sm" variant="ghost" isIconOnly aria-label={t('refresh')} isDisabled={disabled} onPress={() => void reload()}>
          <RefreshCw size={13} className={busy === 'reload' ? 'animate-spin' : ''} />
        </Button>
      }
    >
      <div className="space-y-4" aria-busy={disabled}>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t('nextRun')}</p>
          <p>{t('unlinkHint')}</p>
        </div>
        {error && <p role="alert" className="break-words text-xs text-danger">{failureText(error)}</p>}
        {notice && <p role="status" className="text-xs text-success">{t(notice)}</p>}
        {busy === 'reload' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{t('loading')}</p>}

        {workspace && (
          <>
            <div className="divide-y divide-border/40 border-y border-border/40">
              {[...roots.filter(root => root.role === 'primary'), ...roots.filter(root => root.role === 'reference')].map(root => (
                <div key={`${root.role}:${root.id}`} className="flex min-w-0 flex-wrap items-center gap-3 py-3">
                  <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="break-all font-medium">{root.name}</span>
                      <span className="text-xs text-muted-foreground">{t(root.role)}</span>
                      <span className={`text-xs ${root.status === 'missing' ? 'text-danger' : 'text-muted-foreground'}`}>{t(root.status)}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{root.path}</p>
                  </div>
                  {root.role === 'reference' && (
                    <Button size="sm" variant="danger-soft" isDisabled={disabled} isPending={busy === `remove:${root.id}`} aria-label={`${t('remove')}: ${root.name} (${root.path})`} onPress={() => remove(root.id)}>
                      {({ isPending }) => <>{!isPending && <Unlink size={13} />}{t('remove')}</>}
                    </Button>
                  )}
                </div>
              ))}
              {!roots.length && <p className="py-3 text-xs text-muted-foreground">{t('noRoots')}</p>}
              {roots.length > 0 && !roots.some(root => root.role === 'reference') && <p className="py-3 text-xs text-muted-foreground">{t('noReferences')}</p>}
            </div>

            <form className="space-y-3" onSubmit={event => { event.preventDefault(); add() }}>
              <label className="block text-xs text-muted-foreground">
                <span className="mb-1.5 block">{t('source')}</span>
                <select className={inputClass} value={mode} disabled={disabled} onChange={event => { setMode(event.target.value as 'local' | 'existing'); setError(null); setNotice(null) }}>
                  <option value="local">{t('local')}</option>
                  <option value="existing">{t('existing')}</option>
                </select>
              </label>
              {mode === 'local' ? (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 text-xs text-muted-foreground">
                      <span className="mb-1.5 block">{t('path')}</span>
                      <input className={inputClass} value={localPath} onChange={event => setLocalPath(event.target.value)} disabled={disabled} placeholder="/path/to/directory" required />
                    </label>
                    <Button type="button" size="sm" variant="outline" isDisabled={disabled || !isElectron} isPending={busy === 'browse'} onPress={browse}>
                      {({ isPending }) => <>{!isPending && <FolderOpen size={13} />}{t('browse')}</>}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('browserHint')}</p>
                  <label className="block text-xs text-muted-foreground">
                    <span className="mb-1.5 block">{t('name')}</span>
                    <input className={inputClass} value={name} onChange={event => setName(event.target.value)} disabled={disabled} />
                  </label>
                </>
              ) : (
                <>
                  {projectsError && <p role="alert" className="break-words text-xs text-danger">{failureText(projectsError)}</p>}
                  <label className="block text-xs text-muted-foreground">
                    <span className="mb-1.5 block">{t('project')}</span>
                    <select className={inputClass} value={selected ? selectedProject : ''} onChange={event => setSelectedProject(event.target.value)} disabled={disabled || Boolean(projectsError) || !projects.length} required>
                      <option value="">{t('chooseProject')}</option>
                      {projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.source?.localPath}</option>)}
                    </select>
                  </label>
                  {!projectsError && !projects.length && <p className="text-xs text-muted-foreground">{t('noProjects')}</p>}
                  {selected && <p className="break-all font-mono text-xs text-muted-foreground">{selected.source?.localPath}</p>}
                  <p className="text-xs text-muted-foreground">{t('projectHint')}</p>
                </>
              )}
              <Button type="submit" size="sm" isDisabled={disabled || !canAdd} isPending={busy === 'add'}>
                {({ isPending }) => <>{!isPending && <Plus size={13} />}{t('add')}</>}
              </Button>
            </form>
          </>
        )}
      </div>
    </SettingsCard>
  )
}
