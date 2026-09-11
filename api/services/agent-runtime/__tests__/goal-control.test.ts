import { describe, expect, it } from 'vitest';
import {
  buildGoalInstruction,
  checkGoalCompletion,
  getGoalState,
  goalStateSchema,
  initializeGoal,
  recordGoalUsage,
  type GoalState,
} from '../goal-control.js';

function completionInput(): Parameters<typeof checkGoalCompletion>[0] {
  return {
    goal: { ...initializeGoal('Ship the fix'), status: 'executing', reason: 'Previously waiting' },
    plan: { status: 'approved', revision: 3, acceptanceCriteria: ['Tests pass', 'Report delivered'] },
    evidence: [
      { criterion: 'Tests pass', summary: 'Regression check passed', toolCallIds: ['test-1'] },
      { criterion: 'Report delivered', summary: 'Report saved', artifactIds: ['report-1'] },
    ],
    pendingTaskCount: 0,
    activeChildCount: 0,
    pendingInteractionCount: 0,
    validToolCallIds: ['test-1'],
    validArtifactIds: ['report-1'],
  };
}

const invalidCounts = [-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1];

describe('goal state and bounded usage', () => {
  it('initializes a trimmed objective with finite default or explicit budgets', () => {
    expect(initializeGoal('  Ship the fix  ')).toEqual({
      objective: 'Ship the fix', status: 'planning',
      maxSteps: 128, stepsUsed: 0, maxTokens: 250_000, tokensUsed: 0,
    });
    expect(initializeGoal('Fix', { maxSteps: 7, maxTokens: 900 })).toMatchObject({ maxSteps: 7, maxTokens: 900 });
    expect(initializeGoal('Fix', { maxSteps: undefined, maxTokens: 900 })).toMatchObject({ maxSteps: 128, maxTokens: 900 });
    expect(() => initializeGoal(' \n ')).toThrow();
  });

  it.each(['maxSteps', 'maxTokens'] as const)('rejects invalid %s instead of disabling the budget', (field) => {
    for (const value of [...invalidCounts, 0, null, '128']) {
      expect(() => initializeGoal('Fix', { [field]: value } as never)).toThrow();
    }
  });

  it('reads metadata defensively without inventing a fresh goal for malformed state', () => {
    for (const metadata of [null, undefined, {}, { goal: null }, { goal: 'Fix' }, { goal: { objective: 'Fix' } }]) {
      expect(getGoalState(metadata)).toBeNull();
    }
    const goal = initializeGoal('Fix');
    expect(getGoalState({ goal, unrelated: true })).toEqual(goal);
    expect(getGoalState({ goal })).not.toBe(goal);
    expect(getGoalState({ goal: { ...goal, maxSteps: undefined } })).toBeNull();
    expect(getGoalState({ goal: { ...goal, status: 'unknown' } })).toBeNull();
  });

  it('does not trust arbitrary completion booleans or completed state without evidence', () => {
    const goal = initializeGoal('Fix');
    for (const metadata of [
      { completed: true }, { goalCompleted: true }, { goal: true }, { goal: false },
      { goal: { completed: true } },
      { goal: { ...goal, status: 'completed' } },
      { goal: { ...goal, status: 'completed', acceptanceEvidence: [] } },
    ]) {
      expect(getGoalState(metadata)).toBeNull();
    }
    expect(getGoalState({ goal: { ...goal, completed: true, isCompleted: true } })?.status).toBe('planning');
    const completed = checkGoalCompletion(completionInput());
    expect(getGoalState({ goal: completed })).toEqual(completed);
  });

  it('validates all persisted counters and the six specified statuses', () => {
    const goal = initializeGoal('Fix');
    for (const field of ['maxSteps', 'maxTokens', 'stepsUsed', 'tokensUsed']) {
      for (const value of invalidCounts) {
        expect(goalStateSchema.safeParse({ ...goal, [field]: value }).success).toBe(false);
        expect(getGoalState({ goal: { ...goal, [field]: value } })).toBeNull();
      }
    }
    for (const status of ['planning', 'executing', 'completed', 'blocked', 'budget_exhausted', 'cancelled']) {
      expect(goalStateSchema.safeParse({ ...goal, status, acceptanceEvidence: completionInput().evidence }).success).toBe(true);
    }
    expect(goalStateSchema.safeParse({ ...goal, acceptanceEvidence: [{ criterion: 'Done', summary: '' }] }).success).toBe(false);
  });

  it('records caller-aggregated usage immutably without approving a plan', () => {
    const goal = initializeGoal('Fix');
    const updated = recordGoalUsage(recordGoalUsage(goal, { steps: 3, tokens: 100 }), { steps: 2, tokens: 50 });
    expect(updated).toMatchObject({ status: 'planning', stepsUsed: 5, tokensUsed: 150 });
    expect(goal).toMatchObject({ status: 'planning', stepsUsed: 0, tokensUsed: 0 });
    expect(recordGoalUsage(updated, {})).toEqual(updated);
  });

  it.each(['steps', 'tokens'] as const)('rejects malformed %s increments and unsafe sums', (field) => {
    const goal = initializeGoal('Fix');
    for (const value of [...invalidCounts, null, '1']) {
      expect(() => recordGoalUsage(goal, { [field]: value } as never)).toThrow();
    }
    const usedField = field === 'steps' ? 'stepsUsed' : 'tokensUsed';
    expect(() => recordGoalUsage({ ...goal, [usedField]: Number.MAX_SAFE_INTEGER }, { [field]: 1 })).toThrow();
    expect(goal.stepsUsed).toBe(0);
    expect(goal.tokensUsed).toBe(0);
  });

  it.each([{ steps: 3 }, { steps: 4 }, { tokens: 100 }, { tokens: 120 }])('exhausts at or beyond either budget: %j', (usage) => {
    const goal = initializeGoal('Fix', { maxSteps: 3, maxTokens: 100 });
    const exhausted = recordGoalUsage(goal, usage);
    expect(exhausted.status).toBe('budget_exhausted');
    expect(exhausted.reason).toMatch(/budget.*exhausted/i);
    expect(exhausted.acceptanceEvidence).toBeUndefined();
    expect(recordGoalUsage(exhausted, {}).status).toBe('budget_exhausted');
    expect(goal.status).toBe('planning');
  });

  it('reconciles stale active metadata at the budget boundary without mutating it', () => {
    const goal: GoalState = { ...initializeGoal('Fix', { maxSteps: 1 }), status: 'executing', stepsUsed: 1 };
    expect(getGoalState({ goal })?.status).toBe('budget_exhausted');
    expect(goal.status).toBe('executing');
  });

  it.each(['completed', 'cancelled', 'budget_exhausted'] as const)('does not revive or replace terminal status %s when late usage arrives', (status) => {
    const goal: GoalState = { ...initializeGoal('Fix', { maxSteps: 1 }), status, reason: 'Existing reason', acceptanceEvidence: completionInput().evidence };
    expect(recordGoalUsage(goal, { steps: 2 })).toMatchObject({ status, stepsUsed: 2, reason: 'Existing reason' });
  });

  it('preserves a blocker below budget, but still enforces the root budget', () => {
    const goal: GoalState = { ...initializeGoal('Fix', { maxSteps: 2 }), status: 'blocked', reason: 'Need access' };
    expect(recordGoalUsage(goal, { steps: 1 })).toMatchObject({ status: 'blocked', reason: 'Need access' });
    expect(recordGoalUsage(goal, { steps: 2 }).status).toBe('budget_exhausted');
  });
});

describe('goal instruction', () => {
  it('requires a proposed and approved plan, while reporting the shared remaining budget', () => {
    const instruction = buildGoalInstruction(recordGoalUsage(initializeGoal('Fix'), { steps: 2, tokens: 50 }));
    expect(instruction).toContain('Fix');
    expect(instruction).toContain('2/128');
    expect(instruction).toContain('50/250000');
    expect(instruction).toContain('126');
    expect(instruction).toContain('249950');
    expect(instruction).toContain('plan.propose');
    expect(instruction).toMatch(/approved/i);
    expect(instruction).toMatch(/children/i);
  });

  it.each(['draft', 'saved'])('does not mistake a %s plan for approval', (status) => {
    const instruction = buildGoalInstruction(initializeGoal('Fix'), { status, revision: 3, acceptanceCriteria: ['Tests pass'] });
    expect(instruction).toMatch(/no approved plan/i);
  });

  it('includes the approved revision and acceptance gates, not just run completion', () => {
    const input = completionInput();
    const instruction = buildGoalInstruction(input.goal, input.plan!);
    expect(instruction).toMatch(/revision[^\n]*3/i);
    expect(instruction).toContain('Tests pass');
    expect(instruction).toContain('Report delivered');
    expect(instruction).toMatch(/run.*not.*goal/i);
    expect(instruction).toMatch(/subjective/i);
    expect(instruction).toMatch(/human\.ask/);
    expect(instruction).toMatch(/pending.*interaction/i);
  });

  it.each(['blocked', 'budget_exhausted', 'cancelled', 'completed'] as const)('instructs stopped goal %s not to continue', (status) => {
    const instruction = buildGoalInstruction({ ...initializeGoal('Fix'), status, reason: 'Stop reason', acceptanceEvidence: completionInput().evidence });
    expect(instruction).toMatch(/stop/i);
    expect(instruction).toContain('Stop reason');
    expect(instruction).not.toContain('plan.propose');
  });

  it('stops on exhausted counters even if persisted status is stale', () => {
    const instruction = buildGoalInstruction({ ...initializeGoal('Fix'), stepsUsed: 129 });
    expect(instruction).toContain('budget_exhausted');
    expect(instruction).not.toContain('plan.propose');
    expect(instruction).not.toContain('-1 remaining');
  });
});

describe('goal completion evidence', () => {
  it('completes only after validating every criterion and returns detached evidence', () => {
    const input = completionInput();
    const original = structuredClone(input);
    const completed = checkGoalCompletion(input);
    expect(completed.status).toBe('completed');
    expect(completed.acceptanceEvidence).toEqual(input.evidence);
    expect(completed.reason).toBeUndefined();
    expect(input).toEqual(original);
    input.evidence[0].toolCallIds!.push('later-change');
    expect(completed.acceptanceEvidence![0].toolCallIds).toEqual(['test-1']);
  });

  it('requires evidence for every criterion, even when another has duplicate evidence', () => {
    const input = completionInput();
    for (const evidence of [[], input.evidence.slice(0, 1), [input.evidence[0], input.evidence[0]]]) {
      expect(() => checkGoalCompletion({ ...input, evidence })).toThrow(/missing.*evidence/i);
    }
  });

  it('rejects unrelated criteria, blank summaries and unbacked assertions', () => {
    const input = completionInput();
    for (const evidence of [
      { ...input.evidence[0], criterion: 'Unapproved criterion' },
      { ...input.evidence[0], criterion: ' ' },
      { ...input.evidence[0], summary: ' ' },
      { criterion: 'Tests pass', summary: 'I say it passes' },
      { criterion: 'Tests pass', summary: 'I say it passes', toolCallIds: [], artifactIds: [] },
    ]) {
      expect(() => checkGoalCompletion({ ...input, evidence: [evidence, input.evidence[1]] })).toThrow();
    }
  });

  it.each(['toolCallIds', 'artifactIds'] as const)('validates every %s reference, including mixed valid/forged proof', (field) => {
    const input = completionInput();
    const validId = field === 'toolCallIds' ? 'test-1' : 'report-1';
    input.evidence[0] = { ...input.evidence[0], [field]: [validId, 'forged-or-failed'] };
    expect(() => checkGoalCompletion(input)).toThrow(/unknown|unsuccessful|invalid/i);
    input.trustedUserApprovedCriteria = ['Tests pass'];
    input.evidence[0].humanApproved = true;
    expect(() => checkGoalCompletion(input)).toThrow(/unknown|unsuccessful|invalid/i);
  });

  it.each(['validToolCallIds', 'validArtifactIds'] as const)('rejects proof excluded from the caller-provided %s success set', (field) => {
    const input = completionInput();
    input[field] = [];
    expect(() => checkGoalCompletion(input)).toThrow();
  });

  it.each(['pendingTaskCount', 'activeChildCount', 'pendingInteractionCount'] as const)('rejects unfinished %s and invalid counts', (field) => {
    for (const count of [1, ...invalidCounts]) {
      expect(() => checkGoalCompletion({ ...completionInput(), [field]: count })).toThrow();
    }
  });

  it('requires an approved, nonempty, unique, versioned plan', () => {
    const input = completionInput();
    for (const plan of [
      null,
      { ...input.plan!, status: 'draft' },
      { ...input.plan!, status: 'saved' },
      { ...input.plan!, revision: 0 },
      { ...input.plan!, revision: NaN },
      { ...input.plan!, revision: 1.5 },
      { ...input.plan!, acceptanceCriteria: [] },
      { ...input.plan!, acceptanceCriteria: ['Tests pass', ' Tests pass '] },
    ]) {
      expect(() => checkGoalCompletion({ ...input, plan })).toThrow();
    }
  });

  it.each(['planning', 'blocked', 'cancelled', 'budget_exhausted', 'completed'] as const)('does not complete an inactive %s goal', (status) => {
    const input = completionInput();
    expect(() => checkGoalCompletion({ ...input, goal: { ...input.goal, status } })).toThrow();
  });

  it.each(['stepsUsed', 'tokensUsed'] as const)('cannot complete after %s reaches the budget, regardless of status', (field) => {
    const input = completionInput();
    input.goal[field] = field === 'stepsUsed' ? input.goal.maxSteps : input.goal.maxTokens;
    expect(() => checkGoalCompletion(input)).toThrow(/budget.*exhausted/i);
  });

  it('normalizes surrounding whitespace without fuzzy-matching different criteria', () => {
    const input = completionInput();
    input.evidence[0].criterion = ' Tests pass ';
    expect(checkGoalCompletion(input).acceptanceEvidence![0].criterion).toBe('Tests pass');
    input.evidence[0].criterion = 'tests pass';
    expect(() => checkGoalCompletion(input)).toThrow();
  });
});

describe('trusted subjective acceptance', () => {
  it('never trusts a model-only humanApproved claim, even alongside genuine tool proof', () => {
    const input = completionInput();
    input.evidence[0].humanApproved = true;
    expect(() => checkGoalCompletion(input)).toThrow(/trusted user approval/i);
    delete input.evidence[0].toolCallIds;
    expect(() => checkGoalCompletion(input)).toThrow(/trusted user approval/i);
  });

  it.each([undefined, false, true])('requires trusted approval for subjective criteria regardless of model flag %s', (humanApproved) => {
    const input = completionInput();
    input.subjectiveCriteria = ['Tests pass'];
    input.evidence[0].humanApproved = humanApproved;
    expect(() => checkGoalCompletion(input)).toThrow(/trusted user approval/i);
    input.trustedUserApprovedCriteria = ['Tests pass'];
    expect(checkGoalCompletion(input).acceptanceEvidence![0].humanApproved).toBe(true);
  });

  it('accepts explicit user approval as proof and stamps it from trusted input, not the model', () => {
    const input = completionInput();
    input.subjectiveCriteria = ['Report delivered'];
    input.trustedUserApprovedCriteria = ['Report delivered'];
    input.evidence[1] = { criterion: 'Report delivered', summary: 'User accepted the report' };
    const completed = checkGoalCompletion(input);
    expect(completed.acceptanceEvidence![1]).toEqual({ ...input.evidence[1], humanApproved: true });
    expect(input.evidence[1].humanApproved).toBeUndefined();
    expect(() => checkGoalCompletion({ ...input, pendingInteractionCount: 1 })).toThrow();
  });

  it('does not apply approval to other criteria or allow missing acceptance evidence', () => {
    const input = completionInput();
    input.trustedUserApprovedCriteria = ['Report delivered'];
    input.evidence[0].humanApproved = true;
    expect(() => checkGoalCompletion(input)).toThrow(/trusted user approval/i);
    input.trustedUserApprovedCriteria = ['Tests pass', 'Report delivered'];
    expect(() => checkGoalCompletion({ ...input, evidence: [] })).toThrow(/missing.*evidence/i);
  });

  it.each(['trustedUserApprovedCriteria', 'subjectiveCriteria'] as const)('rejects %s that does not belong to the current approved plan', (field) => {
    const input = completionInput();
    input[field] = ['Obsolete criterion'];
    expect(() => checkGoalCompletion(input)).toThrow(/criterion|criteria/i);
  });
});
