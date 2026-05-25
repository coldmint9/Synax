import { Switch } from '@heroui/react'
import { Palette } from 'lucide-react'
import { useShellStore } from '../../../state/shellStore'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsCard } from './SettingsCard'
import { SettingsSelect } from './SettingsSelect'
import { FormRow } from './FormRow'

export function LayoutSection() {
  const { t } = useLocale()
  const locale = useShellStore(s => s.preferences.locale)
  const defaultHome = useShellStore(s => s.preferences.defaultHome)
  const notifications = useShellStore(s => s.preferences.notifications)
  const editor = useShellStore(s => s.preferences.editor)
  const setLocale = useShellStore(s => s.setLocale)
  const setDefaultHome = useShellStore(s => s.setDefaultHome)
  const setNotifications = useShellStore(s => s.setNotifications)
  const setEditor = useShellStore(s => s.setEditor)

  return (
    <SettingsCard title={t('settingsLayoutTitle')} icon={Palette}>
      <div className="space-y-3">
        <FormRow label={t('settingsLanguage')} description={t('settingsLanguageHint')}>
          <SettingsSelect
            className="w-36"
            fullWidth={false}
            selectedKeys={[locale]}
            onSelectionChange={(keys) => {
              const val = [...keys][0] as string
              if (val) setLocale(val as 'zh' | 'en')
            }}
            disallowEmptySelection
            aria-label={t('settingsLanguage')}
            options={[
              { key: 'zh', label: '中文' },
              { key: 'en', label: 'English' },
            ]}
          />
        </FormRow>

        <FormRow label={t('settingsDefaultHome')} description={t('settingsDefaultHomeHint')}>
          <SettingsSelect
            className="w-36"
            fullWidth={false}
            selectedKeys={[defaultHome]}
            onSelectionChange={(keys) => {
              const val = [...keys][0] as string
              if (val) setDefaultHome(val as 'global-home' | 'last-project')
            }}
            disallowEmptySelection
            aria-label={t('settingsDefaultHome')}
            options={[
              { key: 'global-home', label: t('settingsGlobalHome') },
              { key: 'last-project', label: t('settingsLastProject') },
            ]}
          />
        </FormRow>

        <FormRow label={t('settingsNotifications')} description={t('settingsNotificationsHint')}>
          <Switch size="sm" isSelected={notifications} onChange={setNotifications} aria-label={t('settingsNotifications')}>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch>
        </FormRow>

        <FormRow label={t('settingsEditor')} description={t('settingsEditorHint')}>
          <SettingsSelect
            className="w-36"
            fullWidth={false}
            selectedKeys={[editor]}
            onSelectionChange={(keys) => {
              const val = [...keys][0] as string
              if (val) setEditor(val as typeof editor)
            }}
            disallowEmptySelection
            aria-label={t('settingsEditor')}
            options={[
              { key: 'system', label: locale === 'zh' ? '系统默认' : 'System default' },
              { key: 'vscode', label: 'VS Code' },
              { key: 'cursor', label: 'Cursor' },
              { key: 'windsurf', label: 'Windsurf' },
              { key: 'webstorm', label: 'WebStorm' },
            ]}
          />
        </FormRow>
      </div>
    </SettingsCard>
  )
}