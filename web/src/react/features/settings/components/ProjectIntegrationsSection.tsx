import { Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useShellStore } from '../../../state/shellStore'
import { useLocale } from '../../../../hooks/useLocale'
import { useProjectSettings } from '../useProjectSettings'
import { ProjectCapabilitiesSection } from '../integrations/ProjectCapabilitiesSection'
import { SettingsCard } from './SettingsCard'

function ProjectIntegrations({ projectId }: { projectId: string }) {
  const { t } = useLocale()
  const { settings, loading, error, patchSection } = useProjectSettings(projectId)

  if (loading && !settings) {
    return (
      <SettingsCard title={t('settingsProjectIntegrationsTitle')} description={t('settingsProjectIntegrationsDesc')}>
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
        </div>
      </SettingsCard>
    )
  }

  if (error || !settings) {
    return (
      <SettingsCard title={t('settingsProjectIntegrationsTitle')} description={t('settingsProjectIntegrationsDesc')}>
        <div className="py-4 text-xs text-destructive">{error ?? t('settingsProjectIntegrationsLoadFailed')}</div>
      </SettingsCard>
    )
  }

  return (
    <ProjectCapabilitiesSection
      projectId={projectId}
      servers={settings.mcpServers}
      onSave={async (servers) => { await patchSection('mcp', { mcpServers: servers }) }}
    />
  )
}

export function ProjectIntegrationsSection() {
  const { t } = useLocale()
  const projectId = useShellStore(s => s.currentProjectId)
  if (!projectId) return null
  return (
    <div className="mt-8">
      <div className="mb-4 flex justify-end">
        <Link className="text-sm text-primary hover:underline" to={`/projects/${encodeURIComponent(projectId)}/settings`}>
          {t('settingsProjectTitle')}
        </Link>
      </div>
      <ProjectIntegrations key={projectId} projectId={projectId} />
    </div>
  )
}
