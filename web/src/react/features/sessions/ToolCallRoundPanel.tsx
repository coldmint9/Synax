import { memo, useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ScrollShadow } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import { ActivityStatus } from '../../components/beautiful-ui/ActivityStatus'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { toolBlocksToBatches } from './toolCallUtils'
import { aggregateToolStatus } from './toolCallPresentation'
import { ToolCallBatchSummaryLine } from './ToolCallBatchSummaryLine'

interface Props {
  toolBlocks: TurnContentBlock[]
  maxHeight?: string
}

export const ToolCallRoundPanel = memo(function ToolCallRoundPanel({
  toolBlocks,
  maxHeight = '160px',
}: Props) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(true)
  const listId = useId()
  if (toolBlocks.length === 0) return null
  const batches = toolBlocksToBatches(toolBlocks)
  const calls = batches.flatMap(batch => batch.calls)
  if (calls.length === 0) return null

  return (
    <div className="bui-tool-group">
      {calls.length > 1 && <button
        type="button"
        className="bui-tool-group-heading"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <span>{t('sessionWorkLogCalls', { count: calls.length })}</span>
        <ActivityStatus status={aggregateToolStatus(calls)} />
      </button>}
      {(calls.length === 1 || expanded) && (
        <ScrollShadow id={listId} style={{ maxHeight }} visibility="none">
          <div className="bui-tool-list">
            {batches.map(batch => (
              <ToolCallBatchSummaryLine key={`${batch.toolId}-${batch.calls[0]?.id}`} batch={batch} />
            ))}
          </div>
        </ScrollShadow>
      )}
    </div>
  )
})
