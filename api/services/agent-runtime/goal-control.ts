import * as z from 'zod/v4';

const text = z.string().trim().min(1);
const count = z.number().int().nonnegative();
const limit = z.number().int().positive();
const evidenceSchema = z.object({
  criterion: text,
  summary: text,
  toolCallIds: z.array(text).optional(),
  artifactIds: z.array(text).optional(),
  humanApproved: z.boolean().optional(),
});

export const goalStateSchema = z.object({
  objective: text,
  status: z.enum(['planning', 'executing', 'completed', 'blocked', 'budget_exhausted', 'cancelled']),
  maxSteps: limit,
  stepsUsed: count,
  maxTokens: limit,
  tokensUsed: count,
  acceptanceEvidence: z.array(evidenceSchema).optional(),
  reason: text.optional(),
}).refine(goal => goal.status !== 'completed' || Boolean(goal.acceptanceEvidence?.length),
  'A completed goal must retain acceptance evidence.');
export type GoalState = z.infer<typeof goalStateSchema>;

type GoalPlan = { status: string; revision: number; acceptanceCriteria: string[] };
const planSchema = z.object({
  status: text,
  revision: limit,
  acceptanceCriteria: z.array(text).min(1),
}).refine(plan => new Set(plan.acceptanceCriteria).size === plan.acceptanceCriteria.length,
  'Acceptance criteria must be unique.');

export function initializeGoal(objective: string, limits?: { maxSteps?: number; maxTokens?: number }): GoalState {
  return goalStateSchema.parse({
    objective,
    status: 'planning',
    maxSteps: limits?.maxSteps === undefined ? 128 : limits.maxSteps,
    stepsUsed: 0,
    maxTokens: limits?.maxTokens === undefined ? 250_000 : limits.maxTokens,
    tokensUsed: 0,
  });
}

export function getGoalState(metadata: Record<string, unknown> | null | undefined): GoalState | null {
  const parsed = goalStateSchema.safeParse(metadata?.goal);
  return parsed.success ? enforceBudget(parsed.data) : null;
}

function enforceBudget(goal: GoalState): GoalState {
  if (['completed', 'cancelled', 'budget_exhausted'].includes(goal.status)) return goal;
  if (goal.stepsUsed >= goal.maxSteps || goal.tokensUsed >= goal.maxTokens) {
    return { ...goal, status: 'budget_exhausted', reason: 'Goal budget exhausted; request explicit user action before continuing.' };
  }
  return goal;
}

/** Usage is already aggregated over the root and its children by the caller. */
export function recordGoalUsage(goal: GoalState, usage: { steps?: number; tokens?: number }): GoalState {
  const current = goalStateSchema.parse(goal);
  const steps = count.parse(usage.steps === undefined ? 0 : usage.steps);
  const tokens = count.parse(usage.tokens === undefined ? 0 : usage.tokens);
  return enforceBudget(goalStateSchema.parse({
    ...current,
    stepsUsed: current.stepsUsed + steps,
    tokensUsed: current.tokensUsed + tokens,
  }));
}

export function buildGoalInstruction(goal: GoalState, plan?: GoalPlan): string {
  const current = enforceBudget(goalStateSchema.parse(goal));
  const lines = [
    '## Bounded goal',
    `Objective: ${current.objective}`,
    `Goal status: ${current.status}.`,
    `Root budget (shared with children): steps ${current.stepsUsed}/${current.maxSteps} (${Math.max(0, current.maxSteps - current.stepsUsed)} remaining); tokens ${current.tokensUsed}/${current.maxTokens} (${Math.max(0, current.maxTokens - current.tokensUsed)} remaining).`,
    'A completed run is not a completed goal; budget exhaustion never means success.',
  ];
  if (current.reason) lines.push(`Reason: ${current.reason}`);
  if (!['planning', 'executing'].includes(current.status)) {
    return [...lines, 'Stop autonomous work. Do not continue or reset the budget; any resumption requires explicit user action.'].join('\n');
  }
  const parsedPlan = planSchema.safeParse(plan);
  if (!parsedPlan.success || parsedPlan.data.status !== 'approved') {
    lines.push('No approved plan: use plan.propose to propose or revise a plan with acceptance criteria, then wait for explicit user approval before execution.');
  } else {
    lines.push(
      `Approved plan revision: ${parsedPlan.data.revision}. Execute only this approved version within the remaining root budget.`,
      ...parsedPlan.data.acceptanceCriteria.map(criterion => `- ${criterion}`),
    );
  }
  lines.push(
    'Completion requires matching evidence for every approved acceptance criterion, referencing completed/successful tool calls or artifacts validated by the server.',
    'Never fabricate evidence or approvals. Subjective acceptance requires human.ask and explicit trusted user approval; a model-written humanApproved flag is not approval.',
    'Do not complete while there are unfinished tasks, active children, or pending interactions. Stop for input, approval, blockers, exhausted budget, or cancellation.',
  );
  return lines.join('\n');
}

export function checkGoalCompletion(input: {
  goal: GoalState;
  plan: GoalPlan | null;
  evidence: Array<z.infer<typeof evidenceSchema>>;
  pendingTaskCount: number;
  activeChildCount: number;
  pendingInteractionCount: number;
  /** Caller supplies only successful/completed proof IDs belonging to this root goal. */
  validToolCallIds: string[];
  validArtifactIds: string[];
  /** Trusted server/user classification, never model-controlled tool arguments. */
  subjectiveCriteria?: string[];
  /** Explicit user approvals for this exact plan revision, supplied by the caller, not the model. */
  trustedUserApprovedCriteria?: string[];
}): GoalState {
  const goal = goalStateSchema.parse(input.goal);
  if (goal.status === 'budget_exhausted' || goal.stepsUsed >= goal.maxSteps || goal.tokensUsed >= goal.maxTokens) {
    throw new Error('Goal budget exhausted; exhaustion cannot complete a goal.');
  }
  if (goal.status !== 'executing') throw new Error(`Cannot complete a goal with status ${goal.status}.`);
  const plan = planSchema.parse(input.plan);
  if (plan.status !== 'approved') throw new Error('Goal completion requires an approved plan.');
  for (const field of ['pendingTaskCount', 'activeChildCount', 'pendingInteractionCount'] as const) {
    if (count.parse(input[field]) !== 0) throw new Error(`Goal has unfinished work: ${field}.`);
  }

  const criteria = new Set(plan.acceptanceCriteria);
  const subjective = new Set(z.array(text).parse(input.subjectiveCriteria === undefined ? [] : input.subjectiveCriteria));
  const approved = new Set(z.array(text).parse(input.trustedUserApprovedCriteria === undefined ? [] : input.trustedUserApprovedCriteria));
  for (const criterion of [...subjective, ...approved]) {
    if (!criteria.has(criterion)) throw new Error(`Unknown approval criterion in the current plan: ${criterion}.`);
  }
  const validTools = new Set(z.array(text).parse(input.validToolCallIds));
  const validArtifacts = new Set(z.array(text).parse(input.validArtifactIds));
  const evidence = z.array(evidenceSchema).parse(input.evidence);
  const covered = new Set<string>();
  for (const item of evidence) {
    if (!criteria.has(item.criterion)) throw new Error(`Evidence references an unknown criterion: ${item.criterion}.`);
    for (const id of item.toolCallIds ?? []) {
      if (!validTools.has(id)) throw new Error(`Unknown or unsuccessful tool call evidence: ${id}.`);
    }
    for (const id of item.artifactIds ?? []) {
      if (!validArtifacts.has(id)) throw new Error(`Unknown or unsuccessful artifact evidence: ${id}.`);
    }
    const humanApproved = approved.has(item.criterion);
    if ((subjective.has(item.criterion) || item.humanApproved) && !humanApproved) {
      throw new Error(`Trusted user approval required for criterion: ${item.criterion}.`);
    }
    if (!humanApproved && !item.toolCallIds?.length && !item.artifactIds?.length) {
      throw new Error(`Missing verifiable evidence for criterion: ${item.criterion}.`);
    }
    if (humanApproved) item.humanApproved = true;
    covered.add(item.criterion);
  }
  for (const criterion of criteria) {
    if (!covered.has(criterion)) throw new Error(`Missing acceptance evidence for criterion: ${criterion}.`);
  }
  const completed: GoalState = { ...goal, status: 'completed', acceptanceEvidence: evidence };
  delete completed.reason;
  return completed;
}
