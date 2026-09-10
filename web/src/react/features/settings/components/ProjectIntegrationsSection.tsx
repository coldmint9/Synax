import { Loader2, Sparkles } from 'lucide-react'
import { useShellStore } from '../../../state/shellStore'
import { useLocale } from '../../../../hooks/useLocale'
import { SkillMarketplacePanel } from '../../skills/SkillMarketplacePanel'
import { useProjectSettings } from '../useProjectSettings'
import { McpServersSection } from './McpServersSection'
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
    <div className="space-y-6">
      <McpServersSection
        servers={settings.mcpServers}
        onSave={async (servers) => { await patchSection('mcp', { mcpServers: servers }) }}
        title={t('settingsMcpTitle')}
        description={t('settingsMcpDesc')}
      />

      <SettingsCard title={t('settingsSkillsTitle')} description={t('settingsSkillsDesc')} icon={Sparkles}>
        <div className="settings-inset h-[560px] overflow-hidden rounded-xl border border-border/40">
          <SkillMarketplacePanel projectId={projectId} />
        </div>
      </SettingsCard>
    </div>
  )
}

export function ProjectIntegrationsSection() {
  const projectId = useShellStore(s => s.currentProjectId)
  if (!projectId) return null
  return (
    <div className="mt-8">
      <ProjectIntegrations projectId={projectId} />
    </div>
  )
}
