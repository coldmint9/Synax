import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import { Sparkles } from 'lucide-react'
import { ActivityStatus } from '../../components/beautiful-ui/ActivityStatus'
import { ActivityRow } from './ActivityRow'
import { ThinkingBanner } from './ThinkingBanner'
import { ACTIVITY_BODY_LIMIT, activityPreview, formatCharCount, tailForDisplay, thinkingBannerPhrase } from './activityText'

interface Props {
  content: string
  isStreaming?: boolean
  rememberKey?: string
}

/** Displays model supplied reasoning incrementally as it arrives. */
export function ThinkingBlock({ content, isStreaming, rememberKey }: Props) {
  const { t } = useLocale()
  const [visible, setVisible] = useState(isStreaming ? '' : content)
  const target = useRef(content)
  useEffect(() => { target.current = content }, [content])
  useEffect(() => {
    if (!isStreaming) return
    const timer = window.setInterval(() => {
      setVisible(previous => {
        const next = target.current
        const prefix = next.startsWith(previous) ? previous : ''
        // Advance by a Unicode code point so emoji are never split in half.
        return prefix + (Array.from(next.slice(prefix.length))[0] ?? '')
      })
    }, 12)
    return () => window.clearInterval(timer)
  }, [isStreaming])
  const banner = thinkingBannerPhrase(content)
  if (banner) return <ThinkingBanner phrase={banner} isStreaming={isStreaming} />
  const { text, hidden } = tailForDisplay(isStreaming ? visible : content)
  return <ActivityRow
    icon={isStreaming ? <ActivityStatus status="running" compact /> : <Sparkles size={13} aria-hidden="true" />}
    label={isStreaming ? t('sessionActivityThinking') : t('sessionActivityThought')}
    meta={isStreaming ? null : t('sessionActivityChars', { count: formatCharCount(content.length) })}
    preview={isStreaming ? null : activityPreview(content)}
    body={text}
    footnote={hidden > 0 ? t('sessionActivityTruncated', { hidden: formatCharCount(hidden), shown: formatCharCount(ACTIVITY_BODY_LIMIT) }) : null}
    live={isStreaming}
    rememberKey={rememberKey}
  />
}
