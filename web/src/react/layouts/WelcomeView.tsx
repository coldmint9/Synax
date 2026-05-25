import { useEffect } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { Plus, FolderCode } from 'lucide-react'
import { useShellStore } from '../state/shellStore'
import { useLocale } from '../../hooks/useLocale'

interface WorkbenchContext {
  onCreateProject: () => void
}

export function WelcomeView() {
  const { onCreateProject } = useOutletContext<WorkbenchContext>()
  const { t } = useLocale()
  const projects = useShellStore(s => s.projects)
  const projectsLoaded = useShellStore(s => s.projectsLoaded)
  const defaultHome = useShellStore(s => s.preferences.defaultHome)
  const fetchProjects = useShellStore(s => s.fetchProjects)
  const navigate = useNavigate()

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects()
  }, [projectsLoaded, fetchProjects])

  useEffect(() => {
    if (!projectsLoaded) return
    if (defaultHome === 'global-home') return
    if (projects.length === 0) return
    const sorted = [...projects].sort((a, b) => {
      const ta = a.updatedAt === 'just now' ? Date.now() : new Date(a.updatedAt).getTime()
      const tb = b.updatedAt === 'just now' ? Date.now() : new Date(b.updatedAt).getTime()
      return tb - ta
    })
    navigate(`/projects/${sorted[0].id}/wiki`, { replace: true })
  }, [projectsLoaded, projects, defaultHome, navigate])

  if (!projectsLoaded) return null

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary/60">
          <FolderCode size={24} className="text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">{t('welcomeImportHint')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('welcomeConnectHint')}
        </p>
        <button
          type="button"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          onClick={onCreateProject}
        >
          <Plus size={13} />
          {t('appImportProject')}
        </button>
      </div>
    </div>
  )
}
