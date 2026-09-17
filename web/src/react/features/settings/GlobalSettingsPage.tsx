import { useEffect } from 'react'
import { ScrollShadow, Spinner, Typography } from '@heroui/react'
import { useConfig } from './useConfig'
import { useLocale } from '../../../hooks/useLocale'
import { LayoutSection } from './components/LayoutSection'
import { LlmProviderSection } from './components/LlmProviderSection'
import { LimitsSection } from './components/LimitsSection'
import { AdvancedSection } from './components/AdvancedSection'
import { ProjectIntegrationsSection } from './components/ProjectIntegrationsSection'

export default function GlobalSettingsPage() {
  const { globalConfig, providers, reload, updateGlobalConfig } = useConfig()
  const { t } = useLocale()

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [reload])

  // Background refreshes must preserve open dialogs and their unsaved input.
  if (!globalConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    )
  }

  return (
    <ScrollShadow className="h-full overflow-y-auto">
      <div className="min-h-full bg-background">
        <div className="mx-auto max-w-5xl px-6 pt-16 pb-16">
          <div className="mb-8">
            <Typography type="h5">{t('settingsSystemConfig')}</Typography>
            <Typography type="body-sm" color="muted" className="mt-1">
              {t('settingsTitle')}
            </Typography>
          </div>

          <div className="space-y-8">
            <LayoutSection />
            <LlmProviderSection
              config={globalConfig}
              providers={providers}
              onUpdate={updateGlobalConfig}
              onReload={reload}
            />
            <LimitsSection config={globalConfig} onUpdate={updateGlobalConfig} />
            <AdvancedSection config={globalConfig} onUpdate={updateGlobalConfig} />
          </div>
          <ProjectIntegrationsSection />
        </div>
      </div>
    </ScrollShadow>
  )
}
