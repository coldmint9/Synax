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
      'Adapt to the user intent. For multi-step requests, start with task.create to outline steps.',
      'For exploration or discovery requests, delegate immediately via subagent.delegate(profileId: "explorer"). The child runs wiki-first research (FTS, sections, tree) then code evidence — do not explore on the parent.',
      'Use subagent.delegate(profileId: "reviewer") when a structured review is needed.',
      'For implementation requests, follow the injected coding-task hints (breakdown, style, tests, file summary).',
    ].join('\n');
  }
}

class GoalModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = 'goal' as const;

  buildSection(context: SynaxModePromptContext): string | null {
    const goal = context.metadata.goalContent?.trim() || context.prompt.trim();
    const lines = [
      'Session mode: goal.',
      'Work toward the user goal with bounded, verifiable steps.',
      'Break the goal into task.create items when there are multiple steps; update status as you complete each.',
      'Read and search before editing. Prefer edit for surgical changes.',
    ];
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
      'Use task.create for sub-steps within this node; mark them completed with task.update.',
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
