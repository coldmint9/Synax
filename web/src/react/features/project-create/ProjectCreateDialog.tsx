import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, X } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../../state/shellStore'
import { apiFetch } from '../../../lib/api/origin'
import { openDirectoryPicker, isElectron } from '../../../lib/open-directory-picker'

interface ProjectCreateDialogProps {
  open: boolean
  onClose: () => void
}

export function ProjectCreateDialog({ open, onClose }: ProjectCreateDialogProps) {
  const navigate = useNavigate()
  const addProject = useShellStore(s => s.addProject)
  const [pathInput, setPathInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPathInput('')
    setError(null)
    setSubmitting(false)
  }

  const handleClose = () => {
    if (submitting) return
    reset()
    onClose()
  }

  const createProject = useCallback(async (dirPath: string, dirName: string) => {
    setSubmitting(true)
    setError(null)
    try {
      const resp = await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: dirName,
          environment: 'development',
          source: { kind: 'localPath', localPath: dirPath },
        }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText }))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      const { project } = (await resp.json()) as {
        project: ProjectSummary & { source?: { kind: string; localPath?: string } }
      }
      const apiSource = project.source as { kind: string; localPath?: string } | undefined
      addProject({
        id: project.id,
        name: project.name,
        status: project.status ?? 'healthy',
        environment: project.environment ?? 'development',
        healthScore: project.healthScore ?? 0,
        activeAgents: 0,
        activeHumans: 1,
        openRisks: 0,
        updatedAt: 'just now',
        source: { kind: 'localPath', localPath: apiSource?.localPath },
        importState: 'syncing',
      })
      reset()
      onClose()
      navigate(`/projects/${project.id}/wiki`)
    } catch (err) {
      setError((err as Error).message || String(err))
      setSubmitting(false)
    }
  }, [addProject, navigate, onClose])

  useEffect(() => {
    if (!open) return
    if (!isElectron) return
    let cancelled = false
    void (async () => {
      const result = await openDirectoryPicker()
      if (cancelled) return
      if (!result) {
        onClose()
        return
      }
      await createProject(result.path, result.name)
    })()
    return () => { cancelled = true }
  }, [open, createProject, onClose])

  const handleWebSubmit = () => {
    const p = pathInput.trim()
    if (!p) return
    const segments = p.replace(/\\/g, '/').split('/').filter(Boolean)
    const name = segments[segments.length - 1] || 'Project'
    void createProject(p, name)
  }

  if (!open) return null
  if (isElectron) {
    if (!submitting && !error) return null
    return (
      <div className="dialog-overlay" onClick={handleClose}>
        <div className="dialog-content w-full max-w-sm" onClick={e => e.stopPropagation()}>
          {submitting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              正在创建项目…
            </div>
          )}
          {error && (
            <div className="space-y-3">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={handleClose}>关闭</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className="dialog-content w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">导入项目</h2>
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors" onClick={handleClose}>
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              项目目录路径
            </span>
            <div className="flex gap-2">
              <input
                type="text"
                className="import-input flex-1"
                placeholder="/path/to/project"
                value={pathInput}
                onChange={e => { setPathInput(e.target.value); setError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') handleWebSubmit() }}
                autoFocus
              />
            </div>
            <span className="mt-1 block text-[11px] text-muted-foreground/60">
              输入本地代码目录的绝对路径，项目名将使用文件夹名称
            </span>
          </label>
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
            onClick={handleWebSubmit}
            disabled={submitting || !pathInput.trim()}
          >
            {submitting ? (
              <><Loader2 size={12} className="animate-spin" /> 创建中…</>
            ) : (
              <><FolderOpen size={12} /> 导入</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
