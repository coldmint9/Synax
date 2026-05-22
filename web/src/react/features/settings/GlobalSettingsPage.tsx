import { useEffect } from 'react'
import { Spinner } from '@heroui/react'
import { useConfig } from './useConfig'
import { LayoutSection } from './components/LayoutSection'
import { LlmProviderSection } from './components/LlmProviderSection'
import { AcpSection } from './components/AcpSection'
import { LimitsSection } from './components/LimitsSection'
import { McpSection } from './components/McpSection'
import { AdvancedSection } from './components/AdvancedSection'

export default function GlobalSettingsPage() {
  const { globalConfig, providers, loading, reload, updateGlobalConfig } = useConfig()

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
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <h1 className="text-base font-semibold text-foreground mb-2">系统配置</h1>

        <LayoutSection />
        <LlmProviderSection
          config={globalConfig}
          providers={providers}
          onUpdate={updateGlobalConfig}
          onReload={reload}
        />
        <AcpSection config={globalConfig} onUpdate={updateGlobalConfig} onReload={reload} />
        <LimitsSection config={globalConfig} onUpdate={updateGlobalConfig} />
        <McpSection />
        <AdvancedSection config={globalConfig} onUpdate={updateGlobalConfig} />
      </div>
    </div>
  )
}
