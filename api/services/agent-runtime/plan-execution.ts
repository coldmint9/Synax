import { agentPlanSchema, type AgentPlan } from './control-contracts.js';
import { getGoalState, initializeGoal } from './goal-control.js';
import { AgentRuntimeError, AgentValidationError } from './runtime-errors.js';
import { makeRuntimeId } from './runtime-ids.js';
import { agentRuntimeStore as store } from './session-store.js';
import { TaskStore } from './tools/task-tools.js';

const PLAN_STATUSES = ['draft', 'saved', 'approved'] as const;
export type StoredPlanStatus = (typeof PLAN_STATUSES)[number];

export interface StoredPlan extends AgentPlan {
  revision: number;
  status: StoredPlanStatus;
  executionId?: string;
  approvedRunId?: string;
  approvedStepIndex?: number;
  approvedByMessageId?: string;
}

export function getStoredPlan(sessionId: string): StoredPlan | null {
  const raw = store.getSession(sessionId).sessionMetadata?.plan;
  const parsed = agentPlanSchema.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const revision = record.revision;
  const status = record.status;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    typeof status !== 'string' ||
    !PLAN_STATUSES.includes(status as StoredPlanStatus)
  )
    return null;
  return {
    ...parsed.data,
    revision,
    status: status as StoredPlanStatus,
    ...(typeof record.executionId === 'string' ? { executionId: record.executionId } : {}),
    ...(typeof record.approvedRunId === 'string' ? { approvedRunId: record.approvedRunId } : {}),
    ...(typeof record.approvedStepIndex === 'number' ? { approvedStepIndex: record.approvedStepIndex } : {}),
    ...(typeof record.approvedByMessageId === 'string' ? { approvedByMessageId: record.approvedByMessageId } : {}),
  };
}

export function executeStoredPlan(input: {
  sessionId: string;
  runId: string;
  stepId: string;
  expectedRevision?: number;
  allowWaitingInput?: boolean;
}): StoredPlan {
  const session = store.getSession(input.sessionId);
  if (session.parentSessionId)
    throw new AgentValidationError('Only the primary Synax agent can execute a plan.');
  const allowedStatus = session.status === 'running'
    || (input.allowWaitingInput && session.status === 'waiting_input');
  if (!allowedStatus || session.activeRunId !== input.runId)
    throw new AgentValidationError('Plan execution requires the active run checkpoint.');
  const stored = getStoredPlan(input.sessionId);
  if (!stored)
    throw new AgentValidationError('No saved plan is available to execute.');
  if (input.expectedRevision !== undefined && stored.revision !== input.expectedRevision)
    throw new AgentRuntimeError('The plan revision changed.', 'PLAN_REVISION_CONFLICT', 409);

  const goal = getGoalState(session.sessionMetadata);
  if (stored.status === 'approved' && stored.executionId) {
    if (goal && ['planning', 'executing'].includes(goal.status)) {
      store.updateSessionMetadata(input.sessionId, { mode: 'goal' });
      return stored;
    }
    throw new AgentValidationError('This plan revision has already been executed. Propose a new revision before executing again.');
  }

  const run = store.getRun(input.runId);
  const approved: StoredPlan = {
    ...stored,
    status: 'approved',
    executionId: makeRuntimeId('goalexec'),
    approvedRunId: input.runId,
    approvedStepIndex: store.getRunStep(input.stepId).index,
    ...(run.triggerMessageId ? { approvedByMessageId: run.triggerMessageId } : {}),
  };
  store.updateRun(input.runId, {
    metadata: { ...run.metadata, goalExecutionId: approved.executionId },
  });
  store.updateSessionMetadata(input.sessionId, {
    mode: 'goal',
    plan: approved,
    goal: { ...initializeGoal(approved.objective), status: 'executing' },
  });

  const tasks = new TaskStore();
  const ids = new Map<string, string>();
  for (const step of approved.steps) {
    const task = tasks.create(step.title, step.description);
    ids.set(step.id, task.id);
    tasks.addBlockedBy(task.id, step.dependsOn.map((id) => ids.get(id)!));
  }
  tasks.persist(input.sessionId);
  return approved;
}

export function assertUserInstructionTurn(input: {
  sessionId: string;
  runId: string;
  action: string;
}): void {
  if (!getUserInstructionText(input.sessionId, input.runId))
    throw new AgentValidationError(`${input.action} requires a user instruction turn.`);
}

export function getUserInstructionText(sessionId: string, runId: string): string | null {
  const run = store.getRun(runId);
  const message = run.triggerMessageId
    ? store.listMessages(sessionId).find((item) => item.id === run.triggerMessageId)
    : null;
  if (!message || message.metadata.source === 'system_injection') return null;
  return message.content;
}
