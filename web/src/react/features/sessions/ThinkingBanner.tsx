import { useLocale } from '../../../hooks/useLocale'
import { ThinkingGlyph } from './ThinkingTrace'

interface Props {
  phrase: string
  isStreaming?: boolean
  rememberKey?: string
}

export function ThinkingBanner({ phrase, isStreaming }: Props) {
  const { t } = useLocale()
  return (
    <div className="bui-thinking-banner" data-live={isStreaming || undefined}>
      <span className="bui-thinking-banner-symbol" aria-hidden="true">
        <ThinkingGlyph />
      </span>
      <span className="bui-thinking-banner-label">
        {isStreaming ? t('sessionActivityThinking') : t('sessionActivityThought')}
      </span>
      <span role="status" className="bui-thinking-banner-text" title={phrase}>{phrase}</span>
    </div>
  )
}
