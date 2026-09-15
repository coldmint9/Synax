import { useLocale } from '../../../hooks/useLocale'
import { ThinkingTrace } from './ThinkingTrace'

export function ThinkingIndicator() {
  const { t } = useLocale()
  return <ThinkingTrace label={t('sessionActivityThinking')} working />
}
