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

  it('includes project rules section when provided', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Fix auth',
      maxSteps: 10,
      stepIndex: 1,
      projectRulesSection: '### SYNAX.md\n\nRun npm test.',
    });
    expect(prompt).toContain('[Project Rules]');
    expect(prompt).toContain('### SYNAX.md');
    expect(prompt).toContain('Run npm test.');
  });

  it('includes intent prompt section when provided', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Explore auth',
      maxSteps: 10,
      stepIndex: 1,
      intentPromptSection: '## Exploration Intent\nDelegate to explorer.',
    });
    expect(prompt).toContain('## Exploration Intent');
    expect(prompt).toContain('Delegate to explorer.');
  });
});
