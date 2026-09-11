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
      'For implementation requests, follow the injected coding-task hints when present.',
    ].join('\n');
  }
}

class PlanModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'plan' as const;
  buildSection(): string {
    return 'Session mode: plan. Research only; never edit project files or run shell commands. Ask focused questions through human.ask, then submit a versioned implementation plan with plan.propose. Both tools must occupy a step alone. Saving a plan does not authorize execution. Professional subagents may research read-only. Do not claim a submitted plan is already approved.';
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
    lines.push('Use human.ask for missing decisions; use plan.propose for approval before implementation. Control tools must occupy a step alone. Complete through goal.finish with cited successful tool call or artifact IDs for every criterion; plain final text is not goal completion.');
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
