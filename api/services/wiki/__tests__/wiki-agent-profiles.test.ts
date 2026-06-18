import { describe, expect, it } from 'vitest';
import { isWikiAgentProfile } from '../wiki-agent-profiles.js';

describe('isWikiAgentProfile', () => {
  it('matches wiki-prefixed profiles', () => {
    expect(isWikiAgentProfile('wiki-planner')).toBe(true);
    expect(isWikiAgentProfile('wiki-writer')).toBe(true);
    expect(isWikiAgentProfile('wiki-refresh')).toBe(true);
  });

  it('matches wiki plan profiles', () => {
    expect(isWikiAgentProfile('plan-planner')).toBe(true);
    expect(isWikiAgentProfile('plan-generator')).toBe(true);
  });

  it('does not match universal synax or explorer profiles', () => {
    expect(isWikiAgentProfile('synax')).toBe(false);
    expect(isWikiAgentProfile('explorer')).toBe(false);
    expect(isWikiAgentProfile('goal')).toBe(false);
  });
});
