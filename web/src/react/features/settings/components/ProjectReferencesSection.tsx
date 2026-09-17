import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Label, TextField, Tooltip } from '@heroui/react'
import { Loader2, Plus, RefreshCw, Unlink, X, Layers2 } from 'lucide-react'
import { projectApi, type ProjectWorkspace } from '../../../../lib/api/project'
import { WorkspaceProjectSources } from '../../workspace/WorkspaceProjectSources'
import { WorkspaceProjectRow } from '../../workspace/WorkspaceProjectRow'
import {
  useWorkspaceCopy,
  workspacePathKey,
  type WorkspaceCopy
} from '../../workspace/workspaceCopy'
import {
  isElectron,
  openDirectoryPicker
} from '../../../../lib/open-directory-picker'
import type { ProjectSummary } from '../../../state/shellStore'
import { SettingsCard } from './SettingsCard'
import { DirectoryPickerDialog } from '../../../components/directory-picker/DirectoryPickerDialog'

type Busy = 'reload' | 'add' | 'browse' | `remove:${string}`
type MessageKey = keyof WorkspaceCopy
type Failure = { key: MessageKey; detail: string }
const errorDetail = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause ?? '')

// A new instance for each project also resets form input and directory picker results.
export function ProjectReferencesSection({ projectId }: { projectId: string }) {
  return <ProjectReferencesContent key={projectId} projectId={projectId} />
}

function ProjectReferencesContent({ projectId }: { projectId: string }) {
  const c = useWorkspaceCopy()
  const t = (key: MessageKey): string => c[key]
  const [adding, setAdding] = useState(false)
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
  const [pickerOpen, setPickerOpen] = useState(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const wasAdding = useRef(false)
  useEffect(() => {
    if (busy) return
    if (wasAdding.current && !adding) addTrigger.current?.focus()
    wasAdding.current = adding
  }, [adding, busy])
  const locked = useRef(false)
  const generation = useRef(0)

  // The synchronous lock prevents repeated presses before React renders disabled controls.
  // Cleanup invalidates all outstanding requests, including a native directory dialog.
  const run = useCallback(
    async (
      action: Busy,
      failureKey: MessageKey,
      task: (isCurrent: () => boolean) => Promise<void>
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
        if (isCurrent())
          setError({ key: failureKey, detail: errorDetail(cause) })
      } finally {
        if (isCurrent()) {
          locked.current = false
          setBusy(null)
        }
      }
    },
    []
  )

  const reload = useCallback(
    () =>
      run('reload', 'loadError', async (isCurrent) => {
        const [rootsResult, projectsResult] = await Promise.allSettled([
          projectApi.getWorkspace(projectId),
          projectApi.listProjects(undefined, { throwOnError: true })
        ])
        if (!isCurrent()) return
        if (rootsResult.status === 'fulfilled') {
          setWorkspace(rootsResult.value)
        } else {
          setWorkspace(null)
          setError({
            key: 'loadError',
            detail: errorDetail(rootsResult.reason)
          })
        }
        if (projectsResult.status === 'fulfilled') {
          setProjects(
            projectsResult.value.items.filter(
              (project) =>
                project.id !== projectId && project.source?.localPath?.trim()
            )
          )
          setProjectsError(null)
        } else {
          setProjects([])
          setProjectsError({
            key: 'projectsError',
            detail: errorDetail(projectsResult.reason)
          })
        }
      }),
    [projectId, run]
  )

  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
      locked.current = false
    }
  }, [reload])

  const selected = projects.find((project) => project.id === selectedProject)
  const candidatePath =
    mode === 'local' ? localPath : (selected?.source?.localPath ?? '')
  const duplicate = workspace?.roots.some(
    (root) => workspacePathKey(root.path) === workspacePathKey(candidatePath)
  )
  const canAdd =
    Boolean(workspace) && Boolean(candidatePath.trim()) && !duplicate

  const add = () => {
    if (!canAdd) return
    void run('add', 'addError', async (isCurrent) => {
      const result = await projectApi.addReference(
        projectId,
        mode === 'local'
          ? {
              localPath: localPath.trim(),
              ...(name.trim() ? { name: name.trim() } : {})
            }
          : { projectId: selectedProject }
      )
      if (!isCurrent()) return
      setWorkspace(result)
      setLocalPath('')
      setName('')
      setSelectedProject('')
      setNotice('added')
      setAdding(false)
    })
  }

  const remove = (referenceId: string) => {
    void run(`remove:${referenceId}`, 'removeError', async (isCurrent) => {
      const result = await projectApi.removeReference(projectId, referenceId)
      if (!isCurrent()) return
      setWorkspace(result)
      setNotice('removed')
    })
  }

  const browse = () => {
    // Browsers cannot read a local absolute path from the renderer, so the web
    // build browses the runtime host instead of the native dialog.
    if (!isElectron) {
      setError(null)
      setNotice(null)
      setPickerOpen(true)
      return
    }
    void run('browse', 'browseError', async (isCurrent) => {
      const result = await openDirectoryPicker()
      if (!isCurrent() || !result) return
      setLocalPath(result.path)
      setName((current) => current || result.name)
    })
  }

  const disabled = Boolean(busy)
  const failureText = (failure: Failure) =>
    `${t(failure.key)}: ${failure.detail || t('unknownError')}`
  const roots = workspace?.roots ?? []

  return (
    <SettingsCard
      title={c.manage}
      icon={Layers2}
      badge={
        <span className="workspace-count">
          {roots.length.toString().padStart(2, '0')}
        </span>
      }
      trailing={
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={c.refresh}
            isDisabled={disabled}
            onPress={() => void reload()}
          >
            <RefreshCw
              size={13}
              className={busy === 'reload' ? 'animate-spin' : ''}
            />
          </Button>
          <Button
            ref={addTrigger}
            size="sm"
            variant="secondary"
            isDisabled={disabled || !workspace}
            onPress={() => {
              setAdding(true)
              setError(null)
              setNotice(null)
            }}
          >
            <Plus size={13} />
            {c.addProject}
          </Button>
        </div>
      }
    >
      <div className="workspace-management" aria-busy={disabled}>
        <div className="workspace-management-intro">
          <p>{c.manageHint}</p>
          <span>{c.primaryHint}</span>
        </div>
        {busy === 'reload' && (
          <p role="status" className="workspace-management-message">
            <Loader2 size={13} className="animate-spin" />
            {c.loadingWorkspace}
          </p>
        )}
        {error && (
          <p role="alert" className="workspace-feedback">
            {failureText(error)}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="workspace-feedback workspace-feedback--success"
          >
            {t(notice)}
          </p>
        )}
        {workspace && (
          <>
            <div
              className="workspace-management-list"
              role="list"
              aria-label={c.members}
            >
              {[
                ...roots.filter((root) => root.role === 'primary'),
                ...roots.filter((root) => root.role === 'reference')
              ].map((root) => (
                <WorkspaceProjectRow
                  key={root.id}
                  name={root.name}
                  path={root.path}
                  primary={root.role === 'primary'}
                  missing={root.status === 'missing'}
                >
                  <span
                    className="workspace-availability"
                    data-missing={root.status === 'missing' || undefined}
                  >
                    <span />
                    {t(root.status)}
                  </span>
                  {root.role === 'reference' && (
                    <Tooltip delay={300}>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        isDisabled={disabled}
                        isPending={busy === `remove:${root.id}`}
                        aria-label={`${c.remove}: ${root.name} (${root.path})`}
                        onPress={() => remove(root.id)}
                      >
                        <Unlink size={14} />
                      </Button>
                      <Tooltip.Content>
                        {c.remove} · {c.unlinkHint}
                      </Tooltip.Content>
                    </Tooltip>
                  )}
                </WorkspaceProjectRow>
              ))}
              {!roots.length && (
                <p className="workspace-management-message">{c.noRoots}</p>
              )}
            </div>
            {!adding && roots.length === 1 && (
              <button
                type="button"
                className="workspace-add-row"
                onClick={() => setAdding(true)}
                disabled={disabled}
              >
                <Plus size={16} />
                <span>{c.noReferences}</span>
              </button>
            )}
            {adding && (
              <div className="workspace-add-panel">
                <div className="workspace-section-label">
                  <span>{c.addProject}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={c.close}
                    isDisabled={disabled}
                    onPress={() => setAdding(false)}
                  >
                    <X size={15} />
                  </Button>
                </div>
                <WorkspaceProjectSources
                  mode={mode}
                  onModeChange={setMode}
                  projects={projects}
                  loading={busy === 'reload'}
                  error={projectsError ? failureText(projectsError) : null}
                  onRetry={() => void reload()}
                  disabled={disabled}
                  paths={roots.map((root) => root.path)}
                  path={localPath}
                  onPathChange={setLocalPath}
                  onBrowse={browse}
                  onChoose={(project) => setSelectedProject(project.id)}
                  selectedId={selectedProject}
                />
                {mode === 'local' && (
                  <TextField
                    value={name}
                    onChange={setName}
                    isDisabled={disabled}
                  >
                    <Label>{c.projectName}</Label>
                    <Input maxLength={120} />
                  </TextField>
                )}
                <div className="workspace-add-footer">
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={disabled}
                    onPress={() => setAdding(false)}
                  >
                    {c.cancel}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={disabled || !canAdd}
                    isPending={busy === 'add'}
                    onPress={add}
                  >
                    <Plus size={13} />
                    {c.confirmAdd}
                  </Button>
                </div>
              </div>
            )}
            <div className="workspace-management-footer">
              <span>{c.nextRun}</span>
              <span>{c.unlinkHint}</span>
            </div>
          </>
        )}
      </div>
      <DirectoryPickerDialog
        open={pickerOpen}
        initialPath={localPath.trim() || workspace?.roots[0]?.path}
        onClose={() => setPickerOpen(false)}
        onSelect={(selection) => {
          setLocalPath(selection.path)
          setName((current) => current || selection.name)
          setNotice(null)
          setError(null)
          setPickerOpen(false)
        }}
      />
    </SettingsCard>
  )
}
