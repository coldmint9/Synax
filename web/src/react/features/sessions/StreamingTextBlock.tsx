import { memo } from 'react'
import { ScrollShadow } from '@heroui/react'
import { SessionMarkdown } from './SessionMarkdown'

interface Props {
  text: string
  isStreaming: boolean
  maxHeight?: string
  markdown?: boolean
}

export const StreamingTextBlock = memo(function StreamingTextBlock({
  text,
  isStreaming,
  maxHeight = '400px',
  markdown = false,
}: Props) {
  if (!text && !isStreaming) return null

  return (
    // The transcript clamps long blocks with an internal scroller. HeroUI's
    // default ScrollShadow masks the bottom 40px, which fades the last readable
    // line, so the fade is switched off here while scrolling stays.
    <ScrollShadow className="w-full" style={{ maxHeight }} visibility="none">
      {markdown && !isStreaming ? (
        <SessionMarkdown content={text} className="agent-conversation-copy feed-prose" />
      ) : (
        <div className="agent-conversation-copy leading-[1.75] text-foreground whitespace-pre-wrap">
          {text}
          {isStreaming && (
            <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
          )}
        </div>
      )}
    </ScrollShadow>
  )
})
