import { memo } from 'react'
import { ScrollShadow } from '@heroui/react'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { toolBlocksToBatches } from './toolCallUtils'
import { ToolCallBatchSummaryLine } from './ToolCallBatchSummaryLine'

interface Props {
  toolBlocks: TurnContentBlock[]
  maxHeight?: string
}

export const ToolCallRoundPanel = memo(function ToolCallRoundPanel({
  toolBlocks,
  maxHeight = '160px',
}: Props) {
  if (toolBlocks.length === 0) return null

  const batches = toolBlocksToBatches(toolBlocks)

  return (
    <ScrollShadow
      className="rounded-lg border border-border/35 bg-muted/10"
      style={{ maxHeight }}
    >
      <div className="flex flex-col gap-1 p-1.5">
        {batches.map(batch => (
          <ToolCallBatchSummaryLine
            key={`${batch.toolId}-${batch.calls[0]?.id}`}
            batch={batch}
          />
        ))}
      </div>
    </ScrollShadow>
  )
})
