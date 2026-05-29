import { Button, ScrollShadow, Spinner, Typography } from '@heroui/react'
import { useParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useProjectSettings } from './useProjectSettings'
import { useConfig } from './useConfig'
import { useLocale } from '../../../hooks/useLocale'

function ProviderTab(_props: { settings: any; globalConfig: any; providers: any; onSave: (data: any) => void }) {
  return <div className="text-sm text-muted-foreground">Provider settings (coming soon)</div>
}
function BasicsTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <div className="text-sm text-muted-foreground">Basic settings (coming soon)</div>
}
function CollaborationTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <div className="text-sm text-muted-foreground">Collaboration settings (coming soon)</div>
}
function NotificationsTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <div className="text-sm text-muted-foreground">Notification settings (coming soon)</div>
}
function ComplianceTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <div className="text-sm text-muted-foreground">Compliance settings (coming soon)</div>
}

export default function ProjectSettingsPage() {
  const { projectId = '' } = useParams()
  const { settings, loading, error, reload, patchSection } = useProjectSettings(projectId)
  const { globalConfig, providers } = useConfig(projectId)
  const { t } = useLocale()

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
      <div className="min-h-full bg-background">
        <div className="mx-auto max-w-2xl px-6 pt-20 pb-12">
          <div className="flex items-start justify-between gap-3 mb-8">
            <div>
              <Typography type="h5">{t('settingsProjectTitle')}</Typography>
              <Typography type="body-xs" color="muted" className="mt-1 font-mono">
                {projectId}
              </Typography>
            </div>
            <Button size="sm" variant="outline" isIconOnly onPress={reload} aria-label="Refresh">
              <RefreshCw size={12} />
            </Button>
          </div>

          <div className="space-y-6">
            <ProviderTab settings={settings} globalConfig={globalConfig} providers={providers} onSave={(data) => patchSection('provider', data)} />
            <BasicsTab settings={settings} onSave={(data) => patchSection('basics', data)} />
            <CollaborationTab settings={settings} onSave={(data) => patchSection('collaboration', data)} />
            <NotificationsTab settings={settings} onSave={(data) => patchSection('notifications', data)} />
            <ComplianceTab settings={settings} onSave={(data) => patchSection('compliance', data)} />
          </div>
        </div>
      </div>
    </ScrollShadow>
  )
}
