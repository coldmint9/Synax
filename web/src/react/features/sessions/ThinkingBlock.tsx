import { useLocale } from '../../../hooks/useLocale'
import { Sparkles } from 'lucide-react'
import { ActivityStatus } from '../../components/beautiful-ui/ActivityStatus'
import { ActivityRow } from './ActivityRow'
import { ACTIVITY_BODY_LIMIT, activityPreview, formatCharCount, tailForDisplay } from './activityText'

interface Props {
  content: string
  isStreaming?: boolean
  /** Stable per-row identity so expand state survives lazy unmounts. */
  rememberKey?: string
}

/**
 * Reasoning rendered as a single collapsed activity line, the way Codex shows
 * `Thought`. The body is mounted only while expanded, so a transcript holding
 * dozens of reasoning blocks no longer keeps their text in the DOM.
 */
export function ThinkingBlock({ content, isStreaming, rememberKey }: Props) {
  const { t } = useLocale()
  const { text, hidden } = tailForDisplay(content)

  return (
    <ActivityRow
      icon={isStreaming ? <ActivityStatus status="running" compact /> : <Sparkles size={13} aria-hidden="true" />}
      label={isStreaming ? t('sessionActivityThinking') : t('sessionActivityThought')}
      meta={isStreaming ? null : t('sessionActivityChars', { count: formatCharCount(content.length) })}
      preview={isStreaming ? null : activityPreview(content)}
      body={text}
      footnote={hidden > 0
        ? t('sessionActivityTruncated', {
            hidden: formatCharCount(hidden),
            shown: formatCharCount(ACTIVITY_BODY_LIMIT),
          })
        : null}
      live={isStreaming}
      rememberKey={rememberKey}
    />
  )
}
