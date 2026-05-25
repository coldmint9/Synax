import { useShellStore } from '../react/state/shellStore'
import { t, type I18nKey } from '../lib/i18n'

export function useLocale() {
  const locale = useShellStore(s => s.preferences.locale)
  return {
    locale,
    t: (key: I18nKey, vars?: Record<string, string | number>) => t(locale, key, vars),
  }
}
