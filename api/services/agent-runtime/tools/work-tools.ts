import { isWorkContinuation } from '../work-intent.js';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { workStore } from '../work-store.js';
import { workRuntime } from '../work-runtime.js';
import { getUserInstructionText } from '../plan-execution.js';
import { AgentValidationError } from '../runtime-errors.js';
import { contextReferenceTool } from '../context-projection.js';

const evidence = z.array(z.object({
  criterion: z.string().min(1), summary: z.string().min(1),
  toolCallIds: z.array(z.string()).max(40).optional(), artifactIds: z.array(z.string()).max(40).optional(),
})).max(30).default([]);
export const workCheckpointTool: RegisteredTool = {
  id: 'work.checkpoint', label: 'Work checkpoint', category: 'task', internalGate: 'none', mutability: 'task', resumeBehavior: 'auto',
  description: 'Make a work-boundary or closing decision, not a per-step progress log. complete submits the final answer and evidence for acceptance; yield reports completed work, verification, remaining work and the next action, ending only this round without accepting the work (an executing approved goal automatically continues); blocked reports a real blocker requiring intervention, not a step threshold; continue identifies an unmet requirement, necessary next action and expected evidence. start requires a new user instruction. Must be the only call in the step.',
  inputSchema: z.object({
    action: z.enum(['start', 'continue', 'complete', 'yield', 'blocked']),
    summary: z.string().trim().min(1).max(16000),
    objective: z.string().trim().min(1).max(16000).optional(),
    unmetRequirement: z.string().trim().min(1).max(4000).optional(),
    nextAction: z.string().trim().min(1).max(4000).optional(),
    expectedEvidence: z.string().trim().min(1).max(4000).optional(),
    evidence,
  }),
  async execute(input) {
    const args = input.args as { action: string; summary: string; objective?: string; unmetRequirement?: string; nextAction?: string; expectedEvidence?: string; evidence: z.infer<typeof evidence> };
    const work = workStore.current(input.sessionId);
    if (!work || !input.runId || !input.stepId || store.getSession(input.sessionId).activeRunId !== input.runId)
      throw new AgentValidationError('A work checkpoint requires the active run step.');
    if (args.action === 'complete' || args.action === 'blocked')
      return workRuntime.complete(input, args.summary, args.evidence, args.action === 'blocked');
    if (args.action === 'yield') return workRuntime.yieldRound(input, args.summary, args.nextAction);
    if (args.action === 'start') {
      const user = getUserInstructionText(input.sessionId, input.runId);
      if (!user || isWorkContinuation(user) || !args.objective)
        throw new AgentValidationError('Starting a different work requires a new user request and objective, not an automatic continuation.');
      if (workRuntime.pendingChildren(work)) throw new AgentValidationError('Resolve child work before switching work.');
      work.status = 'waiting'; work.reason = 'Superseded by a new user-requested work; not marked completed.'; workStore.save(work);
      const next = workStore.create(input.sessionId, args.objective);
      next.requirements.push({ messageId: store.getRun(input.runId).triggerMessageId!, text: user });
      workStore.save(next);
      const run = store.getRun(input.runId);
      store.updateRun(run.id, { metadata: { ...run.metadata, workId: next.id, goalExecutionId: undefined } });
      // The old plan remains in the old Work snapshot; never apply it to a different objective.
      store.updateSessionMetadata(input.sessionId, { plan: null, goal: null, activeVariant: null, routeSource: null });
      return { result: next, displaySummary: `Started work: ${next.objective}`, artifacts: [] };
    }
    if (!args.unmetRequirement || !args.nextAction || !args.expectedEvidence)
      throw new AgentValidationError('Continuing requires an unmet requirement, a necessary next action, and expected evidence.');
    if (work.acceptanceCriteria.length && !work.acceptanceCriteria.includes(args.unmetRequirement))
      throw new AgentValidationError('The unmet requirement must identify an acceptance criterion of the approved plan.');
    work.status = 'active'; work.noProgressSteps = 0; work.decisionFailures = 0; work.reason = args.summary;
    work.remaining = [args.unmetRequirement]; work.nextAction = args.nextAction; work.expectedEvidence = args.expectedEvidence;
    workStore.save(work);
    return { result: { workId: work.id, status: work.status, nextAction: work.nextAction }, displaySummary: args.summary, artifacts: [] };
  },
};
export const workTools = [workCheckpointTool, contextReferenceTool];
