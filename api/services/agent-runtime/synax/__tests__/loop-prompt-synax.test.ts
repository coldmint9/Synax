import { describe, expect, it } from 'vitest';
import { buildLoopSystemPrompt } from '../../loop-prompt.js';
import { synaxAgentProfile } from '../synax-agent-profile.js';

describe('buildLoopSystemPrompt synax mode section', () => {
  it('includes mode prompt section when provided', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Fix auth',
      maxSteps: 10,
      stepIndex: 1,
      modePromptSection: 'Session mode: goal.\n## User Goal\nFix auth',
    });
    expect(prompt).toContain('Session mode: goal');
    expect(prompt).toContain('Fix auth');
  });

  it('includes task tracking guidance for profiles with task.create', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Refactor auth',
      maxSteps: 10,
      stepIndex: 1,
    });
    expect(prompt).toContain('task.create');
    expect(prompt).toContain('subagent.delegate');
  });
});
