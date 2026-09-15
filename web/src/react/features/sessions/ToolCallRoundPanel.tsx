import { memo, useId, useState, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ScrollShadow } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { toolBlocksToBatches } from './toolCallUtils'
import { ThinkingBlock } from './ThinkingBlock'
import { activityPreview } from './activityText'
import { ToolCallBatchSummaryLine } from './ToolCallBatchSummaryLine'

interface Props {
  toolBlocks: TurnContentBlock[]
  maxHeight?: string
  isStreaming?: boolean
}

export const ToolCallRoundPanel = memo(function ToolCallRoundPanel({
  toolBlocks,
  maxHeight = '160px',
  isStreaming = false,
}: Props) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const previews = toolBlocks.flatMap((block, index) => {
    if (block.type === 'thinking') return [{ id: `thinking-${index}`, text: activityPreview(block.content.replace(/\*\*/g, ''), 160) }]
    const calls = block.type === 'tool_call' ? [block.call] : block.type === 'tool_call_group' ? block.calls : []
    return calls.map(call => ({ id: call.id, text: `${call.toolId} · ${activityPreview(call.inputSummary || call.outputSummary, 140)}` }))
  }).filter(item => item.text).slice(-4)
  const latestId = previews[previews.length - 1]?.id
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  useEffect(() => { setCursor(latestId) }, [latestId])
  useEffect(() => {
    if (!isStreaming || expanded || previews.length < 2) return
    const ids = previews.map(item => item.id)
    const timer = window.setInterval(() => setCursor(current => ids[(ids.indexOf(current ?? '') + 1) % ids.length]), 2800)
    return () => window.clearInterval(timer)
  }, [expanded, isStreaming, latestId, previews.length])
  const preview = (isStreaming ? previews.find(item => item.id === cursor) : undefined) ?? previews[previews.length - 1]
  if (toolBlocks.length === 0) return null
  const batches = toolBlocksToBatches(toolBlocks)
  const calls = batches.flatMap(batch => batch.calls)


  return (
    <div className="bui-tool-group">
      {<button
        type="button"
        className="bui-tool-group-heading"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <span className="bui-tool-group-count">{calls.length ? t('sessionWorkLogCalls', { count: calls.length }) : '思考'}</span>
        {preview && <span className="bui-activity-carousel" title={preview.text}><span key={preview.id} className={`bui-activity-brief${isStreaming ? ' bui-activity-brief--live' : ''}`}>{preview.text}</span></span>}
      </button>}
      {expanded && (
        <ScrollShadow id={listId} style={{ maxHeight }} visibility="none">
          <div className="bui-tool-list">
            {toolBlocks.map((block, index) => block.type === 'thinking'
              ? <ThinkingBlock key={`thinking-${index}`} content={block.content} isStreaming={isStreaming && index === toolBlocks.length - 1} />
              : toolBlocksToBatches([block]).map(batch => <ToolCallBatchSummaryLine key={`${batch.toolId}-${batch.calls[0]?.id}`} batch={batch} />))}
          </div>
        </ScrollShadow>
      )}
    </div>
  )
})
