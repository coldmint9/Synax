import type { AgentRunStep } from '../../../lib/api/agentRuntime'

/** Sum wall time across all agent run steps (completed + in-progress). */
export function sumAgentTurnDurationMs(steps: AgentRunStep[], now = Date.now()): number {
  return steps.reduce((total, step) => {
    const start = new Date(step.startedAt).getTime()
    if (!Number.isFinite(start)) return total
    const end = step.completedAt
      ? new Date(step.completedAt).getTime()
      : step.status === 'running'
        ? now
        : start
    return total + Math.max(0, end - start)
  }, 0)
}
