import { describe, expect, it } from 'vitest';
import {
  inferSynaxSessionMode,
  isGoalLikeSession,
  isSynaxProfile,
  SYNAX_AGENT_PROFILE_ID,
} from '../synax-session-mode.js';
import { synaxAgent } from '../synax-agent.js';

describe('synax session mode', () => {
  it('recognizes synax and legacy goal profiles', () => {
    expect(isSynaxProfile('synax')).toBe(true);
    expect(isSynaxProfile('goal')).toBe(true);
    expect(isSynaxProfile('executor')).toBe(false);
  });

  it('infers goal mode from explicit metadata', () => {
    expect(inferSynaxSessionMode({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: { mode: 'goal', source: 'session-page' },
    })).toBe('goal');
  });

  it('infers plan_node mode from metadata', () => {
    expect(inferSynaxSessionMode({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: { mode: 'plan_node', source: 'plan-execution' },
    })).toBe('plan_node');
  });

  it('infers goal mode for legacy goal profile', () => {
    expect(inferSynaxSessionMode({
      profileId: 'goal',
      sessionMetadata: { source: 'goal-dock' },
    })).toBe('goal');
  });

  it('defaults synax sessions without metadata to chat', () => {
    expect(inferSynaxSessionMode({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: null,
    })).toBe('chat');
  });

  it('detects goal-like sessions across synax and legacy profiles', () => {
    expect(isGoalLikeSession({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: { mode: 'goal' },
    })).toBe(true);
    expect(isGoalLikeSession({
      profileId: 'goal',
      sessionMetadata: null,
    })).toBe(true);
    expect(isGoalLikeSession({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: { mode: 'chat' },
    })).toBe(false);
  });
});

describe('SynaxAgent', () => {
  it('builds mode prompt sections for goal sessions', () => {
    const section = synaxAgent.buildModePromptSection({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: { mode: 'goal', goalContent: 'Fix login bug' },
      prompt: 'Fix login bug',
    });
    expect(section).toContain('Session mode: goal');
    expect(section).toContain('Fix login bug');
  });

  it('returns null for non-synax sessions', () => {
    expect(synaxAgent.buildModePromptSection({
      profileId: 'executor',
      sessionMetadata: null,
      prompt: 'test',
    })).toBeNull();
  });

  it('creates session metadata with mode', () => {
    expect(synaxAgent.createSessionMetadata('goal', { source: 'session-page' })).toEqual({
      mode: 'goal',
      source: 'session-page',
    });
  });

  it('builds variant prompt section when active', () => {
    const section = synaxAgent.buildVariantPromptSection({
      profileId: SYNAX_AGENT_PROFILE_ID,
      sessionMetadata: {
        activeVariant: 'reviewer',
        routeReason: 'Review requested',
      },
    });
    expect(section).toContain('Active variant: Reviewer');
    expect(section).toContain('Review requested');
  });
});
