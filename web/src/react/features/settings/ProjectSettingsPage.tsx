import { useState } from 'react'
import { Button, ScrollShadow, Spinner, Surface, Tabs, Typography } from '@heroui/react'
import { useParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useProjectSettings } from './useProjectSettings'
import { useConfig } from './useConfig'
import { useLocale } from '../../../hooks/useLocale'
import { ProviderTab } from './tabs/ProviderTab'
import { BasicsTab } from './tabs/BasicsTab'
import { CollaborationTab } from './tabs/CollaborationTab'
import { NotificationsTab } from './tabs/NotificationsTab'
import { ComplianceTab } from './tabs/ComplianceTab'

export default function ProjectSettingsPage() {
  const { projectId = '' } = useParams()
  const { settings, loading, error, reload, patchSection } = useProjectSettings(projectId)
  const { globalConfig, providers } = useConfig(projectId)
  const { t } = useLocale()
  const [activeTab, setActiveTab] = useState<string>('provider')

  if (!projectId) return <div className="p-6 text-sm text-destructive">Missing project ID</div>

  if (loading || !settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    )
  }

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>
  }

  return (
    <ScrollShadow className="h-full overflow-y-auto">
      <Surface variant="default" className="min-h-full">
        <div className="mx-auto max-w-2xl px-6 pt-20 pb-12">
          <div className="flex items-start justify-between gap-3 mb-6">
            <div>
              <Typography type="h5">{t('settingsProjectTitle')}</Typography>
              <Typography type="body-xs" color="muted" className="mt-1 font-mono">
                {projectId}
              </Typography>
            </div>
            <Button size="sm" variant="bordered" isIconOnly onPress={reload} aria-label="Refresh">
              <RefreshCw size={12} />
            </Button>
          </div>

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as string)}
            className="project-settings-tabs"
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label={t('settingsProjectTitle')}>
                <Tabs.Tab id="provider">Provider<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="basics">{t('settingsTabBasics')}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="collaboration">{t('settingsTabCollaboration')}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="notifications">{t('settingsTabNotifications')}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="compliance">{t('settingsTabCompliance')}<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="provider">
              <ProviderTab settings={settings} globalConfig={globalConfig} providers={providers} onSave={(data) => patchSection('provider', data)} />
            </Tabs.Panel>
            <Tabs.Panel id="basics">
              <BasicsTab settings={settings} onSave={(data) => patchSection('basics', data)} />
            </Tabs.Panel>
            <Tabs.Panel id="collaboration">
              <CollaborationTab settings={settings} onSave={(data) => patchSection('collaboration', data)} />
            </Tabs.Panel>
            <Tabs.Panel id="notifications">
              <NotificationsTab settings={settings} onSave={(data) => patchSection('notifications', data)} />
            </Tabs.Panel>
            <Tabs.Panel id="compliance">
              <ComplianceTab settings={settings} onSave={(data) => patchSection('compliance', data)} />
            </Tabs.Panel>
          </Tabs>
        </div>
      </Surface>
    </ScrollShadow>
  )
}
