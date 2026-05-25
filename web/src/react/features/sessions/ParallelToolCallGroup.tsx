import { Chip } from '@heroui/react'
import { Layers } from 'lucide-react'
import type { ToolCallView } from './buildInterleavedTurns'
import { EnhancedToolCallCard } from './EnhancedToolCallCard'

interface Props {
  calls: ToolCallView[]
}

export function ParallelToolCallGroup({ calls }: Props) {
  const allCompleted = calls.every(c => c.status === 'completed')
  const anyRunning = calls.some(c => c.status === 'running')

  return (
    <div className="rounded-lg border border-border/40 bg-muted/10 p-2 animate-[fade-up_0.3s_ease-out]">
      <div className="flex items-center gap-2 mb-2 px-1">
        <Layers size={11} className="text-muted-foreground/60" />
        <span className="text-[10px] font-medium text-muted-foreground/70">
          Parallel ({calls.length})
        </span>
        <Chip
          size="sm"
          variant="dot"
          color={allCompleted ? 'success' : anyRunning ? 'primary' : 'default'}
          className="h-4 text-[9px]"
        >
          {allCompleted ? 'done' : anyRunning ? 'running' : 'pending'}
        </Chip>
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {calls.map((call, i) => (
          <div key={call.id} style={{ animationDelay: `${i * 50}ms` }} className="animate-[fade-up_0.25s_ease-out_both]">
            <EnhancedToolCallCard call={call} />
          </div>
        ))}
      </div>
    </div>
  )
}
