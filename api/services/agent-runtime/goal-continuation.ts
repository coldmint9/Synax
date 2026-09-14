import type { StreamTurnRequest } from './contracts.js';
import type { AcceptedRuntimeInput } from './run-admission.js';
import { agentRuntimeStore as store } from './session-store.js';
import { getGoalState } from './goal-control.js';
import { getStoredPlan } from './plan-execution.js';
import { interactionService } from './interaction-service.js';
import { inputQueueService } from './input-queue-service.js';
import { workStore } from './work-store.js';

/** Only an explicit, settled round handoff can continue an already approved root goal. */
export function goalContinuationInput(sessionId: string, runId: string): StreamTurnRequest | null {
  const session = store.getSession(sessionId);
  const run = store.getRun(runId);
  if (session.parentSessionId || session.sessionMetadata?.mode !== 'goal' || session.sessionMetadata?.runtimeControl ||
      session.status !== 'paused' || session.activeRunId || run.sessionId !== sessionId ||
      run.status !== 'completed' || run.stopReason !== 'round_yielded' || store.listRuns(sessionId)[0]?.id !== runId)
    return null;
  const goal = getGoalState(session.sessionMetadata);
  const plan = getStoredPlan(sessionId);
  const work = workStore.current(sessionId);
  if (goal?.status !== 'executing' || plan?.status !== 'approved' || !plan.executionId ||
      run.metadata.goalExecutionId !== plan.executionId || work?.status !== 'active' || run.metadata.workId !== work.id ||
      interactionService.pending(sessionId) || inputQueueService.hasPending(sessionId))
    return null;
  const previous = (run.metadata.runtime as AcceptedRuntimeInput | undefined)?.input;
  return {
    message: 'Continue the approved goal from the previous round handoff. Keep the same objective and approved plan. Work on the remaining items, verify them, and submit acceptance evidence only when the goal is achieved. A previous round summary is not proof of completion. Stop for required user input, approval, a real blocker, or cancellation.',
    messageSource: 'system_injection',
    model: run.model ?? previous?.model,
    purpose: previous?.purpose,
    maxSteps: previous?.maxSteps ?? run.metadata.convergenceThreshold as number | undefined,
    maxTokens: previous?.maxTokens,
    temperature: previous?.temperature,
    locale: previous?.locale,
    reasoningEffort: session.reasoningEffort ?? previous?.reasoningEffort,
    references: previous?.references,
  };
}
