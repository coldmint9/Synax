import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Label, TextField, Tooltip } from '@heroui/react'
import { ArrowRight, FolderCode, Layers2, Pin, X } from 'lucide-react'
import { WorkspaceProjectSources } from '../workspace/WorkspaceProjectSources'
import { WorkspaceProjectRow } from '../workspace/WorkspaceProjectRow'
import { useWorkspaceCopy, workspacePathKey } from '../workspace/workspaceCopy'
import { projectApi } from '../../../lib/api/project'
import { resolveSessionsEntryPath } from '../sessions/sessionLastVisit'
import { DirectoryPickerDialog } from '../../components/directory-picker/DirectoryPickerDialog'
import { useDialogFocus } from '../../components/directory-picker/useDialogFocus'
import { useShellStore, type ProjectSummary } from '../../state/shellStore'

type Member = { localPath: string; name: string; projectId?: string }
interface ProjectCreateDialogProps {
  open: boolean
  onClose: () => void
}

export function ProjectCreateDialog({
  open,
  onClose
}: ProjectCreateDialogProps) {
  // A new form instance isolates selections and in-flight callbacks on every opening.
  return open ? <ProjectCreateForm onClose={onClose} /> : null
}

function ProjectCreateForm({
  onClose
}: Pick<ProjectCreateDialogProps, 'onClose'>) {
  const navigate = useNavigate()
  const c = useWorkspaceCopy()
  const [mode, setMode] = useState<'local' | 'existing'>('local')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [name, setName] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [existing, setExisting] = useState<ProjectSummary[]>([])
  const [loadingExisting, setLoadingExisting] = useState(true)
  const [existingError, setExistingError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const locked = useRef(false)
  const active = useRef(true)
  const browseRef = useRef<HTMLButtonElement>(null)
  const pickerWasOpen = useRef(false)

  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    // Making the parent inert can blur its trigger before the child captures it.
    if (!pickerOpen && pickerWasOpen.current) browseRef.current?.focus()
    pickerWasOpen.current = pickerOpen
  }, [pickerOpen])

  useEffect(() => {
    let current = true
    setLoadingExisting(true)
    setExistingError(null)
    void projectApi
      .listProjects(undefined, { throwOnError: true })
      .then((result) => {
        if (current && active.current)
          setExisting(
            result.items.filter((item) => item.source?.localPath?.trim())
          )
      })
      .catch((cause) => {
        if (current && active.current)
          setExistingError(
            cause instanceof Error ? cause.message : String(cause)
          )
      })
      .finally(() => {
        if (current && active.current) setLoadingExisting(false)
      })
    return () => {
      current = false
    }
  }, [loadAttempt])

  const handleClose = () => {
    if (locked.current || !active.current) return
    active.current = false
    onClose()
  }
  const dialogRef = useDialogFocus(handleClose, pickerOpen)
  const addMembers = (items: Member[]) => {
    if (locked.current || !active.current) return
    const additions = items.filter(
      (item, index) =>
        !members.some(
          (member) =>
            workspacePathKey(member.localPath) ===
            workspacePathKey(item.localPath)
        ) &&
        items.findIndex(
          (other) =>
            workspacePathKey(other.localPath) ===
            workspacePathKey(item.localPath)
        ) === index
    )
    if (members.length + additions.length > 50) {
      setError(c.limit)
      return
    }
    setMembers((current) => [...current, ...additions])
    setName((current) => current || items[0]?.name || '')
    setError(null)
  }
  const addPath = () => {
    const localPath = pathInput.trim()
    if (!localPath) return
    addMembers([
      {
        localPath,
        name:
          localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          localPath
      }
    ])
    setPathInput('')
  }
  const createWorkspace = async () => {
    if (locked.current || !active.current || !members.length || !name.trim())
      return
    locked.current = true
    setSubmitting(true)
    setError(null)
    try {
      const { project } = await projectApi.createWorkspace({
        name: name.trim(),
        roots: members.map((item) =>
          item.projectId
            ? { projectId: item.projectId }
            : { localPath: item.localPath, name: item.name }
        )
      })
      if (!active.current) return
      active.current = false
      useShellStore.getState().addProject(project)
      onClose()
      navigate(resolveSessionsEntryPath(project.id))
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) {
        locked.current = false
        setSubmitting(false)
      }
    }
  }
  return (
    <>
      <div
        className="dialog-overlay"
        inert={pickerOpen}
        aria-hidden={pickerOpen || undefined}
        onClick={handleClose}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-create-title"
          aria-describedby="workspace-create-intro"
          className="dialog-content workspace-create"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="workspace-create-header">
            <span className="workspace-project-icon workspace-project-icon--large">
              <Layers2 size={22} strokeWidth={1.5} />
            </span>
            <div>
              <h2 id="workspace-create-title">{c.title}</h2>
              <p id="workspace-create-intro">{c.intro}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={c.close}
              isDisabled={submitting}
              onPress={handleClose}
            >
              <X size={17} />
            </Button>
          </header>
          <div className="workspace-create-name">
            <TextField value={name} onChange={setName} isDisabled={submitting}>
              <Label>{c.workspaceName}</Label>
              <Input
                maxLength={120}
                placeholder={c.namePlaceholder}
                data-dialog-autofocus
              />
            </TextField>
          </div>
          <div className="workspace-create-body">
            <section
              className="workspace-create-sources"
              aria-label={c.sources}
            >
              <WorkspaceProjectSources
                mode={mode}
                onModeChange={setMode}
                projects={existing}
                loading={loadingExisting}
                error={existingError}
                onRetry={() => setLoadAttempt((value) => value + 1)}
                disabled={submitting}
                paths={members.map((item) => item.localPath)}
                path={pathInput}
                onPathChange={setPathInput}
                onAddPath={addPath}
                browseRef={browseRef}
                onBrowse={() => setPickerOpen(true)}
                onChoose={(item) => {
                  if (item.source?.localPath)
                    addMembers([
                      {
                        projectId: item.id,
                        name: item.name,
                        localPath: item.source.localPath
                      }
                    ])
                }}
              />
            </section>
            <section className="workspace-create-members">
              <div className="workspace-section-label">
                <span>{c.members}</span>
                <span className="workspace-count">
                  {members.length.toString().padStart(2, '0')}
                </span>
              </div>
              <div
                className="workspace-member-list overflow-y-auto"
                role="list"
                aria-label={c.members}
              >
                {members.length === 0 && (
                  <div className="workspace-members-empty">
                    <span className="workspace-empty-glyph">
                      <FolderCode size={28} strokeWidth={1.2} />
                    </span>
                    <strong>{c.emptyTitle}</strong>
                    <p>{c.emptyHint}</p>
                  </div>
                )}
                {members.map((item, index) => (
                  <WorkspaceProjectRow
                    key={item.localPath}
                    name={item.name}
                    path={item.localPath}
                    primary={index === 0}
                  >
                    {index > 0 && (
                      <Tooltip delay={300}>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`${c.makePrimary}: ${item.name}`}
                          isDisabled={submitting}
                          onPress={() =>
                            setMembers((items) => [
                              item,
                              ...items.filter((member) => member !== item)
                            ])
                          }
                        >
                          <Pin size={13} />
                        </Button>
                        <Tooltip.Content>{c.makePrimary}</Tooltip.Content>
                      </Tooltip>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label={`${c.remove} ${item.name}`}
                      isDisabled={submitting}
                      onPress={() =>
                        setMembers((items) =>
                          items.filter((member) => member !== item)
                        )
                      }
                    >
                      <X size={14} />
                    </Button>
                  </WorkspaceProjectRow>
                ))}
              </div>
              <p className="workspace-primary-note">
                <Pin size={12} />
                {c.primaryHint}
              </p>
            </section>
          </div>
          {error && (
            <div
              role="alert"
              className="workspace-feedback workspace-create-error"
            >
              {error}
            </div>
          )}
          <footer className="workspace-create-footer">
            <span role="status" className="workspace-hint">
              {c.count.replace('{count}', String(members.length))}
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={submitting}
                onPress={handleClose}
              >
                {c.cancel}
              </Button>
              <Button
                size="sm"
                isDisabled={submitting || !members.length || !name.trim()}
                isPending={submitting}
                onPress={() => void createWorkspace()}
              >
                {submitting ? c.creating : c.title}
                {!submitting && <ArrowRight size={14} />}
              </Button>
            </div>
          </footer>
        </div>
      </div>
      <DirectoryPickerDialog
        open={pickerOpen}
        multiple
        initialPath={pathInput.trim() || undefined}
        labels={{ title: c.pickerTitle, confirm: c.pickerConfirm }}
        onClose={() => setPickerOpen(false)}
        onSelect={() => {}}
        onSelectMultiple={(items) => {
          addMembers(
            items.map((item) => ({ localPath: item.path, name: item.name }))
          )
          setPickerOpen(false)
        }}
      />
    </>
  )
}
