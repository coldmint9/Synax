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
  // Kept readable for goals persisted before budget enforcement was removed.
  status: z.enum(['planning', 'executing', 'completed', 'blocked', 'budget_exhausted', 'cancelled']),
  acceptanceEvidence: z.array(evidenceSchema).optional(),
  /** Criteria accepted by incremental goal.finish gates before final completion. */
  acceptedCriteria: z.array(text).optional(),
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

export function initializeGoal(objective: string): GoalState {
  return goalStateSchema.parse({
    objective,
    status: 'planning',
  });
}

export function getGoalState(metadata: Record<string, unknown> | null | undefined): GoalState | null {
  const parsed = goalStateSchema.safeParse(metadata?.goal);
  return parsed.success ? parsed.data : null;
}

export function buildGoalInstruction(goal: GoalState, plan?: GoalPlan): string {
  const current = goalStateSchema.parse(goal);
  const lines = [
    '## Goal',
    `Objective: ${current.objective}`,
    `Goal status: ${current.status}.`,
    'A completed run is not a completed goal. The round step threshold only requests a graceful wrap-up; it never forces completion or failure.',
    'When a round needs to end before acceptance, use work.checkpoint(action="yield") with a factual summary and next action. An executing approved root goal automatically continues in a new run after the previous execution releases ownership.',
  ];
  if (current.reason) lines.push(`Reason: ${current.reason}`);
  if (!['planning', 'executing'].includes(current.status)) {
    return [...lines, 'Stop autonomous work. Any resumption requires explicit user action.'].join('\n');
  }
  const parsedPlan = planSchema.safeParse(plan);
  if (!parsedPlan.success || parsedPlan.data.status !== 'approved') {
    lines.push('No approved plan: use plan.propose to submit or revise a plan with acceptance criteria. The runtime offers a one-time execute-or-cancel choice; if the user defers, call plan.execute only after an explicit later execution instruction.');
  } else {
    lines.push(
      `Approved plan revision: ${parsedPlan.data.revision}. Execute only this approved version until every criterion is satisfied.`,
      ...parsedPlan.data.acceptanceCriteria.map(criterion => `- ${criterion}`),
    );
  }
  lines.push(
    'goal.finish is an incremental acceptance gate: submit one or more criteria with evidence. The server returns the remaining criteria until all are accepted; only then is the goal completed.',
    'Never fabricate evidence or approvals. Subjective acceptance requires human.ask and explicit trusted user approval; a model-written humanApproved flag is not approval.',
    'Do not complete while there are unfinished tasks, active children, or pending interactions. Stop for input, approval, blockers, or cancellation.',
  );
  return lines.join('\n');
}

export type GoalEvidence = z.infer<typeof evidenceSchema>;

export interface GoalAcceptanceInput {
  goal: GoalState;
  plan: GoalPlan | null;
  evidence: GoalEvidence[];
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
  /** Server-derived readiness blockers that keep the gate open without rejecting it. */
  additionalBlockers?: string[];
}

export interface GoalAcceptanceEvaluation {
  goal: GoalState;
  complete: boolean;
  acceptedCriteria: string[];
  remainingCriteria: string[];
  blockers: string[];
}

/** Replace prior evidence for a criterion with the newest attestation. */
export function mergeGoalEvidence(previous: GoalEvidence[] | undefined, next: GoalEvidence[]): GoalEvidence[] {
  const merged = new Map<string, GoalEvidence>();
  for (const item of [...previous ?? [], ...next]) merged.set(item.criterion.trim(), item);
  return [...merged.values()];
}

export function evaluateGoalAcceptance(input: GoalAcceptanceInput): GoalAcceptanceEvaluation {
  const goal = goalStateSchema.parse(input.goal);
  if (goal.status !== 'executing') throw new Error(`Cannot complete a goal with status ${goal.status}.`);
  const plan = planSchema.parse(input.plan);
  if (plan.status !== 'approved') throw new Error('Goal completion requires an approved plan.');
  for (const field of ['pendingTaskCount', 'activeChildCount', 'pendingInteractionCount'] as const) count.parse(input[field]);

  const criteria = new Set(plan.acceptanceCriteria);
  const subjective = new Set(z.array(text).parse(input.subjectiveCriteria === undefined ? [] : input.subjectiveCriteria));
  const approved = new Set(z.array(text).parse(input.trustedUserApprovedCriteria === undefined ? [] : input.trustedUserApprovedCriteria));
  for (const criterion of [...subjective, ...approved]) {
    if (!criteria.has(criterion)) throw new Error(`Unknown approval criterion in the current plan: ${criterion}.`);
  }
  const validTools = new Set(z.array(text).parse(input.validToolCallIds));
  const validArtifacts = new Set(z.array(text).parse(input.validArtifactIds));
  const evidence = mergeGoalEvidence(
    goal.acceptanceEvidence,
    z.array(evidenceSchema).parse(input.evidence),
  );
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
  const acceptedCriteria = plan.acceptanceCriteria.filter((criterion) => covered.has(criterion));
  const remainingCriteria = plan.acceptanceCriteria.filter((criterion) => !covered.has(criterion));
  const blockers = [
    input.pendingTaskCount ? `pending tasks: ${input.pendingTaskCount}` : null,
    input.activeChildCount ? `active child work: ${input.activeChildCount}` : null,
    input.pendingInteractionCount ? `pending interactions: ${input.pendingInteractionCount}` : null,
    ...(input.additionalBlockers ?? []),
  ].filter((value): value is string => Boolean(value));
  const complete = remainingCriteria.length === 0 && blockers.length === 0;
  const nextGoal: GoalState = complete
    ? { ...goal, status: 'completed', acceptanceEvidence: evidence, acceptedCriteria }
    : { ...goal, acceptanceEvidence: evidence, acceptedCriteria };
  if (complete) delete nextGoal.reason;
  return { goal: nextGoal, complete, acceptedCriteria, remainingCriteria, blockers };
}

export function checkGoalCompletion(input: GoalAcceptanceInput): GoalState {
  const evaluated = evaluateGoalAcceptance(input);
  if (evaluated.blockers.length) throw new Error(`Goal has unfinished work: ${evaluated.blockers.join(', ')}.`);
  if (evaluated.remainingCriteria.length) throw new Error(`Missing acceptance evidence for criterion: ${evaluated.remainingCriteria[0]}.`);
  return evaluated.goal;
}
