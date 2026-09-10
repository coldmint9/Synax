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
    <ScrollShadow className="w-full" style={{ maxHeight }}>
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
