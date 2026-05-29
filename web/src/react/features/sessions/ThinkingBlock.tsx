import { Accordion, Chip } from '@heroui/react'
import { Brain } from 'lucide-react'

interface Props {
  content: string
  isStreaming?: boolean
}

export function ThinkingBlock({ content, isStreaming }: Props) {
  const displayContent = content.length > 2000 && !isStreaming
    ? '...' + content.slice(-2000)
    : content

  return (
    <Accordion
      className="px-0 gap-0"
      defaultExpandedKeys={isStreaming ? ['thinking'] : undefined}
    >
      <Accordion.Item
        id="thinking"
        aria-label="Agent thinking"
        className="border-border/30 bg-muted/20 rounded-md animate-[fade-up_0.3s_ease-out]"
      >
        <Accordion.Trigger className="flex items-center gap-2 px-3 py-2 text-left w-full">
          <Brain size={12} className="shrink-0 text-muted-foreground/60" />
          <span className="text-[11px] font-medium text-muted-foreground/70">Thinking</span>
          {isStreaming && (
            <Chip size="sm" color="accent" variant="soft" className="h-4 text-[9px]">
              live
            </Chip>
          )}
          <Accordion.Indicator className="ml-auto text-muted-foreground/50 [&>svg]:size-3" />
        </Accordion.Trigger>
        <Accordion.Panel>
          <Accordion.Body className="px-3 pb-2 pt-0">
            <div className="text-[12px] italic leading-relaxed text-muted-foreground/70 whitespace-pre-wrap">
              {displayContent}
              {isStreaming && (
                <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}
