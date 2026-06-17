import { memo } from 'react'
import { Zap } from 'lucide-react'
import type { ConversationTimelineEntry } from './buildConversationTimeline'
import { sessionEntryDomId } from './buildConversationTimeline'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { SubSessionCard } from './SubSessionCard'
import { UserMessageBlock } from './UserMessageBlock'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import { buildTurnRenderSegments } from './toolCallUtils'

function renderTurnBlocks(
  blocks: TurnContentBlock[],
  onExpandChild?: (sessionId: string) => void,
) {
  const segments = buildTurnRenderSegments(blocks)

  return segments.map((segment, i) => {
    if (segment.type === 'thinking') {
      return <ThinkingBlock key={i} content={segment.content} />
    }
    if (segment.type === 'tool_round') {
      return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />
    }
    if (segment.type === 'text') {
      return (
        <StreamingTextBlock
          key={i}
          text={segment.content}
          isStreaming={false}
          markdown={segment.markdown}
        />
      )
    }
    if (segment.type === 'sub_session') {
      return <SubSessionCard key={i} session={segment.session} onExpand={onExpandChild} />
    }
    if (segment.type === 'context_compacted') {
      return (
        <div key={i} className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
          <Zap size={12} />
          <span>上下文压缩: {segment.originalTokens.toLocaleString()} → {segment.compressedTokens.toLocaleString()} tokens ({segment.messageCount} 条消息被摘要)</span>
        </div>
      )
    }
    return null
  })
}

export const TimelineEntryView = memo(function TimelineEntryView({
  entry,
  onExpandChild,
}: {
  entry: ConversationTimelineEntry
  onExpandChild?: (sessionId: string) => void
}) {
  if (entry.kind === 'user') {
    return (
      <div
        id={sessionEntryDomId(entry.id)}
        className="scroll-mt-4"
        data-session-entry={entry.id}
      >
        <UserMessageBlock content={entry.content} />
      </div>
    )
  }

  return (
    <div
      id={sessionEntryDomId(entry.id)}
      className="scroll-mt-4"
      data-session-entry={entry.id}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {renderTurnBlocks(entry.turn.blocks, onExpandChild)}
        {entry.turn.duration && (
          <div className="mt-1 text-[11px] text-muted-foreground/50">
            {entry.turn.duration}
          </div>
        )}
      </div>
    </div>
  )
})
