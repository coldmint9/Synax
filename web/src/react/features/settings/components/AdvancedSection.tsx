import { useCallback } from 'react'
import { Wrench, FileCode } from 'lucide-react'
import { SettingsSection } from './SettingsSection'
import { SaveIndicator } from './SaveIndicator'
import { CapsuleSwitch } from './CapsuleSwitch'
import { useAutoSave } from '../useAutoSave'
import type { GlobalConfig } from '../../../../lib/contracts/config'

interface AdvancedSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function AdvancedSection({ config, onUpdate }: AdvancedSectionProps) {
  const saveFn = useCallback(async (features: GlobalConfig['features']) => {
    await onUpdate({ features })
  }, [onUpdate])

  const { saveImmediate, saving, saved, error } = useAutoSave(saveFn)

  const handleToggle = (key: keyof GlobalConfig['features'], value: boolean) => {
    saveImmediate({ ...config.features, [key]: value })
  }

  const openConfigFile = async () => {
    try {
      await fetch('/api/config/open-file', { method: 'POST' })
    } catch {
      // silently fail if endpoint not available
    }
  }

  return (
    <SettingsSection title="高级" icon={Wrench} trailing={<SaveIndicator saving={saving} saved={saved} error={error} />}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">允许项目覆盖连接参数</div>
            <div className="text-[11px] text-muted-foreground">项目可自定义 ACP 连接配置</div>
          </div>
          <CapsuleSwitch
            checked={config.features.allowProjectConnectionOverride}
            onChange={v => handleToggle('allowProjectConnectionOverride', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">多 Provider 模式</div>
            <div className="text-[11px] text-muted-foreground">允许同时使用多个 LLM Provider</div>
          </div>
          <CapsuleSwitch
            checked={config.features.allowMultiProvider}
            onChange={v => handleToggle('allowMultiProvider', v)}
          />
        </div>

        <div className="border-t border-border/30 pt-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary"
            onClick={openConfigFile}
          >
            <FileCode size={13} />
            打开配置文件
          </button>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            在系统编辑器中打开 JSON 配置文件，保存后自动同步
          </p>
        </div>
      </div>
    </SettingsSection>
  )
}
