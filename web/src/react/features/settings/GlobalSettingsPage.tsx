import { useEffect } from 'react'
import { ScrollShadow, Spinner, Surface, Typography } from '@heroui/react'
import { useConfig } from './useConfig'
import { useLocale } from '../../../hooks/useLocale'
import { LayoutSection } from './components/LayoutSection'
import { LlmProviderSection } from './components/LlmProviderSection'
import { AcpSection } from './components/AcpSection'
import { LimitsSection } from './components/LimitsSection'
import { AdvancedSection } from './components/AdvancedSection'

export default function GlobalSettingsPage() {
  const { globalConfig, providers, loading, reload, updateGlobalConfig } = useConfig()
  const { t } = useLocale()

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [reload])

  if (loading || !globalConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    )
  }

  return (
    <ScrollShadow className="h-full overflow-y-auto">
      <Surface variant="default" className="min-h-full">
        <div className="mx-auto max-w-2xl px-6 pt-20 pb-12">
          <div className="mb-8">
            <Typography type="h5">{t('settingsSystemConfig')}</Typography>
            <Typography type="body-sm" color="muted" className="mt-1">
              {t('settingsTitle')}
            </Typography>
          </div>

          <div className="space-y-6">
            <LayoutSection />
            <LlmProviderSection
              config={globalConfig}
              providers={providers}
              onUpdate={updateGlobalConfig}
              onReload={reload}
            />
            <AcpSection config={globalConfig} onUpdate={updateGlobalConfig} onReload={reload} />
            <LimitsSection config={globalConfig} onUpdate={updateGlobalConfig} />
            <AdvancedSection config={globalConfig} onUpdate={updateGlobalConfig} />
          </div>
        </div>
      </Surface>
    </ScrollShadow>
  )
}
