import { useEffect, useState } from 'react'
import { ScrollShadow, Spinner, Surface, Tabs, Typography } from '@heroui/react'
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
  const [activeTab, setActiveTab] = useState<string>('appearance')

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
          <div className="mb-6">
            <Typography type="h5">{t('settingsSystemConfig')}</Typography>
            <Typography type="body-sm" color="muted" className="mt-1">
              {t('settingsTitle')}
            </Typography>
          </div>

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as string)}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label={t('settingsSystemConfig')}>
                <Tabs.Tab id="appearance">{t('settingsLayoutTitle')}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="providers">LLM<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="acp">ACP<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="limits">{t('settingsLimitsTitle')}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="advanced">{t('settingsAdvancedTitle')}<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="appearance" className="pt-4">
              <LayoutSection />
            </Tabs.Panel>
            <Tabs.Panel id="providers" className="pt-4">
              <LlmProviderSection
                config={globalConfig}
                providers={providers}
                onUpdate={updateGlobalConfig}
                onReload={reload}
              />
            </Tabs.Panel>
            <Tabs.Panel id="acp" className="pt-4">
              <AcpSection config={globalConfig} onUpdate={updateGlobalConfig} onReload={reload} />
            </Tabs.Panel>
            <Tabs.Panel id="limits" className="pt-4">
              <LimitsSection config={globalConfig} onUpdate={updateGlobalConfig} />
            </Tabs.Panel>
            <Tabs.Panel id="advanced" className="pt-4">
              <AdvancedSection config={globalConfig} onUpdate={updateGlobalConfig} />
            </Tabs.Panel>
          </Tabs>
        </div>
      </Surface>
    </ScrollShadow>
  )
}
