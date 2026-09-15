import { Sparkles } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { ActivityStatus } from '../../components/beautiful-ui/ActivityStatus'

interface Props {
  /** Headline text, already stripped of its markdown `**` markers. */
  phrase: string
  isStreaming?: boolean
}

/**
 * Reasoning that is only a headline.
 *
 * A model inside a tool loop often reports `**Inspecting backend metadata**`
 * instead of thinking out loud: there is no reasoning body worth expanding, and
 * a collapsed row would just leak the markdown markers. The phrase is rendered
 * as a banner with a left-to-right light sweep so it reads as a status prompt.
 */
export function ThinkingBanner({ phrase, isStreaming }: Props) {
  const { t } = useLocale()

  return (
    <div className="bui-thinking-banner" data-live={isStreaming || undefined}>
      <span className="bui-thinking-banner-symbol" aria-hidden="true">
        {isStreaming ? <ActivityStatus status="running" compact /> : <Sparkles size={13} />}
      </span>
      <span className="bui-thinking-banner-label">
        {isStreaming ? t('sessionActivityThinking') : t('sessionActivityThought')}
      </span>
      <span className="bui-thinking-banner-text" title={phrase}>{phrase}</span>
    </div>
  )
}
