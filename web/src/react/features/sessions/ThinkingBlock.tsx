import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import { ThinkingTrace } from './ThinkingTrace'
import { ThinkingBanner } from './ThinkingBanner'
import { ACTIVITY_BODY_LIMIT, activityPreview, formatCharCount, tailForDisplay, thinkingBannerPhrases } from './activityText'

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
  const bannerPhrases = thinkingBannerPhrases(content)
  if (bannerPhrases) return <ThinkingBanner phrases={bannerPhrases} isStreaming={isStreaming} />
  const { text, hidden } = tailForDisplay(isStreaming ? visible : content)
  return <ThinkingTrace
    label={isStreaming ? t('sessionActivityThinking') : t('sessionActivityThought')}
    meta={isStreaming ? null : t('sessionActivityChars', { count: formatCharCount(content.length) })}
    title={activityPreview(content)}
    working={isStreaming}
    rememberKey={rememberKey}
  >
    <div className="bui-thinking-prose">{text}</div>
    {hidden > 0 && <div className="bui-activity-footnote">{t('sessionActivityTruncated', { hidden: formatCharCount(hidden), shown: formatCharCount(ACTIVITY_BODY_LIMIT) })}</div>}
  </ThinkingTrace>
}
