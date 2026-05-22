import { CheckCircle2, Circle, Loader2, XCircle, AlertCircle } from 'lucide-react'
import type { AgentRunStep, RuntimeEvent } from '../../../lib/api/agentRuntime'
import { DebugToolCall } from './DebugToolCall'

interface Props {
  steps: AgentRunStep[]
  events: RuntimeEvent[]
}

const STATUS_ICON = {
  running: <Loader2 size={12} className="animate-spin text-[var(--color-run)]" />,
  completed: <CheckCircle2 size={12} className="text-success" />,
  failed: <XCircle size={12} className="text-danger" />,
  waiting_permission: <AlertCircle size={12} className="text-warning" />,
  blocked: <AlertCircle size={12} className="text-warning" />,
  cancelled: <Circle size={12} className="text-muted-foreground/50" />,
  interrupted: <XCircle size={12} className="text-muted-foreground/50" />,
}

function stepDuration(step: AgentRunStep): string {
  if (!step.completedAt) return ''
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function DebugStepTimeline({ steps, events }: Props) {
  return (
    <div className="space-y-1">
      {steps.map(step => {
        const stepEvents = events.filter(e =>
          (e.payload as Record<string, unknown>)?.stepId === step.id
        )
        const toolCalls = stepEvents.filter(e => e.type === 'tool_call')

        return (
          <div
            key={step.id}
            className="debug-step-border"
            data-status={step.status}
          >
            <div className="flex items-center gap-2 py-1">
              {STATUS_ICON[step.status] ?? <Circle size={12} className="text-muted-foreground/40" />}
              <span className="text-[11px] font-medium">Step {step.index + 1}</span>
              {step.model && (
                <span className="text-[10px] text-muted-foreground">{step.model}</span>
              )}
              <span className="text-[10px] text-muted-foreground">{stepDuration(step)}</span>
            </div>

            {toolCalls.length > 0 && (
              <div className="ml-5 space-y-0.5 pb-1">
                {toolCalls.map(event => (
                  <DebugToolCall key={event.id} event={event} />
                ))}
              </div>
            )}

            {step.finishReason && step.status === 'completed' && (
              <div className="ml-5 text-[10px] text-muted-foreground/70">
                {step.finishReason}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
