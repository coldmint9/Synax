import { useEffect, useRef } from 'react'
import { ScrollShadow } from '@heroui/react'

interface Props {
  text: string
  isStreaming: boolean
  maxHeight?: string
}

export function StreamingTextBlock({ text, isStreaming, maxHeight = '400px' }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStreaming && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [text, isStreaming])

  if (!text && !isStreaming) return null

  return (
    <ScrollShadow className="w-full" style={{ maxHeight }}>
      <div className="text-sm leading-[1.75] text-foreground whitespace-pre-wrap">
        {text}
        {isStreaming && (
          <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
        )}
        <div ref={endRef} />
      </div>
    </ScrollShadow>
  )
}
