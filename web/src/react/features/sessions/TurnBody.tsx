import { Zap } from 'lucide-react'
import type { InterleavedTurn, TurnContentBlock } from './buildInterleavedTurns'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import { StreamingTextBlock } from './StreamingTextBlock'
import { SubSessionCard } from './SubSessionCard'
import { buildTurnRenderSegments } from './toolCallUtils'

function renderTurnBlocks(blocks: TurnContentBlock[], onExpandChild?: (sessionId: string) => void, rowKeyPrefix = '', isStreaming = false) {
  const segments = buildTurnRenderSegments(blocks)
  const toolBlocks = blocks.filter(block => block.type === 'thinking' || block.type === 'tool_call' || block.type === 'tool_call_group')
  const answers = segments.filter(segment => segment.type !== 'tool_round' && (toolBlocks.length === 0 || segment.type !== 'thinking'))
  const render = (segment: (typeof segments)[number], i: number) => {
    if (segment.type === 'thinking') return <ThinkingBlock isStreaming={isStreaming && segment === segments[segments.length - 1]} key={i} content={segment.content} rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${i}` : undefined} />
    if (segment.type === 'tool_round') return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />
    if (segment.type === 'text') return <StreamingTextBlock key={i} text={segment.content} isStreaming={isStreaming && segment === segments[segments.length - 1]} markdown={segment.markdown} />
    if (segment.type === 'sub_session') return <SubSessionCard key={i} session={segment.session} onExpand={onExpandChild} />
    if (segment.type === 'context_compacted') return <div key={i} className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning"><Zap size={12} /><span>上下文压缩: {segment.originalTokens.toLocaleString()} → {segment.compressedTokens.toLocaleString()} tokens ({segment.messageCount} 条消息被摘要)</span></div>
    return null
  }
  return <><div className="session-tool-region">{toolBlocks.length > 0 && <ToolCallRoundPanel toolBlocks={toolBlocks} maxHeight="420px" isStreaming={isStreaming} />}</div><div className="session-answer-region">{answers.map(render)}</div></>
}
/** One agent turn. Turn duration separators are intentionally omitted from the transcript. */
export function TurnBody({
  turn,
  entryId,
  onExpandChild,
  isStreaming = false,
}: {
  turn: InterleavedTurn
  entryId: string
  onExpandChild?: (sessionId: string) => void
  isStreaming?: boolean
}) {
  return (
    <div className="session-turn-content flex min-w-0 flex-1 flex-col gap-1">
      {renderTurnBlocks(turn.blocks, onExpandChild, entryId, isStreaming)}
    </div>
  )
}
