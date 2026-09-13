import { buildGoalInstruction, getGoalState } from '../goal-control.js';
import type { SynaxSessionMetadata, SynaxSessionMode } from './synax-session-mode.js';

export interface SynaxModePromptContext {
  mode: SynaxSessionMode;
  metadata: SynaxSessionMetadata;
  prompt: string;
}

export abstract class SynaxModePromptStrategy {
  abstract readonly mode: SynaxSessionMode;

  abstract buildSection(context: SynaxModePromptContext): string | null;
}

class ChatModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'chat' as const;

  buildSection(): string | null {
    return [
      'Session mode: chat.',
      'Adapt to the user intent.',
      'For exploration or discovery requests, delegate immediately via subagent.delegate(profileId: "explorer"). The child runs wiki-first research — do not explore on the parent.',
      'Use subagent.delegate(profileId: "reviewer") when a structured review is needed.',
      'Use plan.execute only when the user explicitly asks to execute a saved plan.',
      'When the user asks to plan before implementing, use mode.switch to plan. When the user asks to execute a saved plan, use plan.execute. Use mode.switch for other explicit chat, plan, or goal workflow changes.',
      'For implementation requests, follow the injected coding-task hints when present.',
    ].join('\n');
  }
}

class PlanModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'plan' as const;
  buildSection(context: SynaxModePromptContext): string {
    const lines = [
      'Session mode: plan.',
      'Research only; never edit project files or run shell commands. Ask focused questions through human.ask, then submit a versioned implementation plan with plan.propose. The runtime shows one execute-or-cancel confirmation; the user may also defer it and execute in a later turn.',
      'When the user explicitly asks to execute a deferred plan, call plan.execute. Use mode.switch only when the user explicitly asks for a different workflow mode.',
      'Control tools must occupy a step alone. Professional subagents may research read-only.',
    ];
    const plan = buildStoredPlanSection(context.metadata as Record<string, unknown>);
    if (plan) lines.push('', plan);
    return lines.join('\n');
  }
}

class GoalModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'goal' as const;

  buildSection(context: SynaxModePromptContext): string | null {
    const goal = context.metadata.goalContent?.trim() || context.prompt.trim();
    const lines = [
      'Session mode: goal.',
      'Work toward the user goal with bounded, verifiable steps.',
    ];
    const state = getGoalState(context.metadata as Record<string, unknown>);
    if (state) lines.push(buildGoalInstruction(state, (context.metadata as Record<string, unknown>).plan as Parameters<typeof buildGoalInstruction>[1]));
    lines.push('Use human.ask for missing decisions and plan.propose to save or revise a plan. Call plan.execute only when the user explicitly asks to execute a saved plan. Use mode.switch only for an explicit workflow-mode request. Control tools must occupy a step alone. Complete through goal.finish with cited successful tool call or artifact IDs for every criterion; plain final text is not goal completion.');
    if (goal) {
      lines.push('', '## User Goal', goal);
    }
    if (context.metadata.documentId || context.metadata.wikiAttachMode) {
      lines.push(
        '',
        '## Wiki Context',
        context.metadata.wikiAttachMode === 'auto'
          ? '- Wiki context may have been auto-matched from goal intent.'
          : '- Wiki context is attached when available.',
      );
      if (context.metadata.documentId) {
        lines.push(`- Document ID: ${context.metadata.documentId}`);
      }
      lines.push('- Keep wiki documentation aligned when you change related code.');
    }
    return lines.join('\n');
  }
}

function buildStoredPlanSection(metadata: Record<string, unknown>): string | null {
  const plan = metadata.plan;
  if (!plan || typeof plan !== 'object') return null;
  const value = plan as {
    revision?: unknown;
    status?: unknown;
    title?: unknown;
    objective?: unknown;
    steps?: Array<{ title?: unknown; description?: unknown }>;
    acceptanceCriteria?: unknown;
  };
  if (typeof value.title !== 'string' || typeof value.objective !== 'string') return null;
  const lines = [
    '## Saved plan',
    `Revision: ${typeof value.revision === 'number' ? value.revision : 'unknown'}`,
    `Status: ${typeof value.status === 'string' ? value.status : 'unknown'}`,
    `Title: ${value.title}`,
    `Objective: ${value.objective}`,
  ];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (steps.length) {
    lines.push(`Steps (${Math.min(steps.length, 12)} of ${steps.length}):`, ...steps.slice(0, 12).map((step, index) =>
      `- ${index + 1}. ${typeof step.title === 'string' ? step.title : 'Untitled step'}${typeof step.description === 'string' ? `: ${step.description.slice(0, 500)}` : ''}`,
    ));
  }
  const criteria = Array.isArray(value.acceptanceCriteria)
    ? value.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === 'string')
    : [];
  if (criteria.length) {
    lines.push(`Acceptance criteria (${Math.min(criteria.length, 12)} of ${criteria.length}):`, ...criteria
      .slice(0, 12)
      .map((criterion) => `- ${criterion.slice(0, 500)}`));
  }
  lines.push('The plan is not executing until plan.execute succeeds in a user instruction turn.');
  return lines.join('\n');
}

class PlanNodeModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'plan_node' as const;

  buildSection(context: SynaxModePromptContext): string | null {
    const lines = [
      'Session mode: plan_node.',
      'Execute one bounded plan node. Prefer minimal, focused diffs.',
      'Explain blockers clearly if you cannot finish.',
    ];
    if (context.metadata.planNodeTitle) {
      lines.push('', `Plan node: ${context.metadata.planNodeTitle}`);
    }
    if (context.prompt.trim()) {
      lines.push('', '## Node Task', context.prompt.trim());
    }
    return lines.join('\n');
  }
}

export class SynaxModePromptRegistry {
  private readonly strategies = new Map<SynaxSessionMode, SynaxModePromptStrategy>();

  constructor() {
    for (const strategy of [
      new ChatModePromptStrategy(),
      new PlanModePromptStrategy(),
      new GoalModePromptStrategy(),
      new PlanNodeModePromptStrategy(),
    ]) {
      this.strategies.set(strategy.mode, strategy);
    }
  }

  resolve(mode: SynaxSessionMode): SynaxModePromptStrategy {
    return this.strategies.get(mode) ?? new ChatModePromptStrategy();
  }

  buildSection(context: SynaxModePromptContext): string | null {
    return this.resolve(context.mode).buildSection(context);
  }
}

export const synaxModePromptRegistry = new SynaxModePromptRegistry();
