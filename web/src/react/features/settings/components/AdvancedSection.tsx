import { useCallback } from 'react'
import { Button, Switch } from '@heroui/react'
import { Wrench, FileCode, Plug } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { FormRow } from './FormRow'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { apiFetch } from '../../../../lib/api/origin'
import type { GlobalConfig } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'

interface AdvancedSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function AdvancedSection({ config, onUpdate }: AdvancedSectionProps) {
  const { t } = useLocale()
  const saveFn = useCallback(async (features: GlobalConfig['features']) => {
    await onUpdate({ features })
  }, [onUpdate])

  const { saveImmediate, saving, saved, error } = useAutoSave(saveFn)

  const handleToggle = (key: keyof GlobalConfig['features'], value: boolean) => {
    saveImmediate({ ...config.features, [key]: value })
  }

  const openConfigFile = async () => {
    try {
      await apiFetch('/api/config/open-file', { method: 'POST' })
    } catch {
      // silently fail if endpoint not available
    }
  }

  return (
    <div className="space-y-3">
      <SettingsCard title={t('settingsAdvancedTitle')} icon={Wrench} trailing={<SaveIndicator saving={saving} saved={saved} error={error} />}>
        <div className="space-y-3">
          <FormRow label={t('settingsAllowProjectOverride')} description={t('settingsAllowProjectOverrideDesc')}>
            <Switch
              size="sm"
              isSelected={config.features.allowProjectConnectionOverride}
              onChange={(v) => handleToggle('allowProjectConnectionOverride', v)}
              aria-label={t('settingsAllowProjectOverride')}
            >
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch>
          </FormRow>

          <div className="border-t border-border/30 pt-3">
            <Button
              size="sm"
              variant="bordered"
              onPress={openConfigFile}
              startContent={<FileCode size={13} />}
            >
              {t('settingsOpenConfigFile')}
            </Button>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t('settingsOpenConfigFileDesc')}
            </p>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t('settingsMcpTitle')}
        icon={Plug}
        badge={<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t('settingsMcpComingSoon')}</span>}
      >
        <p className="text-xs text-muted-foreground">{t('settingsMcpDesc')}</p>
      </SettingsCard>
    </div>
  )
}