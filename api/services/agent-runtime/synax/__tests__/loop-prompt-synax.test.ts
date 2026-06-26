import { describe, expect, it } from 'vitest';
import { buildLoopSystemPrompt, buildCoreLoopSection } from '../../loop-prompt.js';
import { synaxAgentProfile } from '../synax-agent-profile.js';

describe('buildLoopSystemPrompt synax mode section', () => {
  it('uses profile label without Synax duplication', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Fix auth',
      maxSteps: 10,
      stepIndex: 1,
    });
    expect(prompt).toContain('You are the Synax Agent.');
    expect(prompt).not.toContain('Synax Synax Agent');
  });

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
    expect(prompt).toContain('grep.search');
    expect(prompt).not.toContain('Prefer the bash tool');
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

  it('includes permission section and language directive', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: '你好',
      maxSteps: 10,
      stepIndex: 1,
      locale: 'zh',
      permissionTier: 'readonly',
    });
    expect(prompt.indexOf('## Language Output Directive')).toBeLessThan(prompt.indexOf('## Permission gates'));
    expect(prompt).toContain('## Permission gates');
    expect(prompt).toContain('Chinese (Simplified)');
  });

  it('does not include context warnings by default', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: {
        id: 'ctx',
        projectId: 'p1',
        sessionId: null,
        nodeId: null,
        profileId: null,
        blocks: [],
        citations: [],
        warnings: ['No CoordForest node id supplied; bundle is project-level.'],
        createdAt: new Date().toISOString(),
      },
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Hi',
      maxSteps: 10,
      stepIndex: 1,
    });
    expect(prompt).not.toContain('Context warnings');
  });

  it('orders mode before intent and variant overlays', () => {
    const prompt = buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context: null,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: 'Fix auth',
      maxSteps: 10,
      stepIndex: 1,
      modePromptSection: 'Session mode: goal.',
      intentPromptSection: '## Coding Task Role',
      variantPromptSection: 'Active variant: planner',
    });
    expect(prompt.indexOf('Session mode: goal.')).toBeLessThan(prompt.indexOf('## Coding Task Role'));
    expect(prompt.indexOf('## Coding Task Role')).toBeLessThan(prompt.indexOf('Active variant: planner'));
  });
});

describe('buildCoreLoopSection', () => {
  it('prefers dedicated read tools over bash', () => {
    const section = buildCoreLoopSection(synaxAgentProfile);
    expect(section).toContain('grep.search');
    expect(section).toContain('shell gate');
  });
});
