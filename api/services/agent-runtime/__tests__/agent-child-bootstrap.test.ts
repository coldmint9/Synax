import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureWikiProfileRegistered = vi.fn();
const ensurePlanProfileRegistered = vi.fn();
const ensureRefreshProfileRegistered = vi.fn();
const ensureLegacyGoalProfileRegistered = vi.fn();
const tryGetSession = vi.fn();
const maybeGet = vi.fn();

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: {
    tryGetSession: (...args: unknown[]) => tryGetSession(...args),
  },
}));

vi.mock('../../wiki/wiki-loop-profile.js', () => ({
  ensureWikiProfileRegistered: (...args: unknown[]) => ensureWikiProfileRegistered(...args),
}));

vi.mock('../../wiki/wiki-plan-profile.js', () => ({
  ensurePlanProfileRegistered: (...args: unknown[]) => ensurePlanProfileRegistered(...args),
  PLAN_GENERATOR_LEGACY_ID: 'plan-generator',
  PLAN_PLANNER_PROFILE_ID: 'plan-planner',
}));

vi.mock('../../wiki/wiki-refresh-profile.js', () => ({
  ensureRefreshProfileRegistered: (...args: unknown[]) => ensureRefreshProfileRegistered(...args),
}));

vi.mock('../synax/index.js', () => ({
  ensureLegacyGoalProfileRegistered: (...args: unknown[]) => ensureLegacyGoalProfileRegistered(...args),
  isSynaxProfile: (profileId: string) => profileId === 'synax' || profileId === 'goal',
}));

vi.mock('../profile-service.js', () => ({
  profileService: {
    maybeGet: (...args: unknown[]) => maybeGet(...args),
  },
}));

vi.mock('../../wiki/wiki-agent-tool-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../../wiki/wiki-agent-tool-provider.js')>(
    '../../wiki/wiki-agent-tool-provider.js',
  );
  return {
    ...actual,
  };
});

import { bootstrapAgentChildForSession } from '../agent-child-bootstrap.js';

describe('bootstrapAgentChildForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers wiki tool provider for synax sessions that allow wiki tools', () => {
    tryGetSession.mockReturnValue({ id: 'ars_1', profileId: 'synax', projectId: 'p1' });
    maybeGet.mockReturnValue({
      id: 'synax',
      allowedCapabilities: ['wiki.get_tree', 'wiki.search_content', 'bash'],
    });

    bootstrapAgentChildForSession('ars_1');

    expect(ensureLegacyGoalProfileRegistered).toHaveBeenCalled();
    expect(ensureWikiProfileRegistered).toHaveBeenCalled();
  });

  it('registers wiki tool provider for explorer sessions', () => {
    tryGetSession.mockReturnValue({ id: 'ars_2', profileId: 'explorer', projectId: 'p1' });
    maybeGet.mockReturnValue({
      id: 'explorer',
      allowedCapabilities: ['wiki.get_tree', 'wiki.search_content'],
    });

    bootstrapAgentChildForSession('ars_2');

    expect(ensureWikiProfileRegistered).toHaveBeenCalled();
    expect(ensureLegacyGoalProfileRegistered).not.toHaveBeenCalled();
  });

  it('does not register wiki tools for profiles without wiki capabilities', () => {
    tryGetSession.mockReturnValue({ id: 'ars_3', profileId: 'reviewer', projectId: 'p1' });
    maybeGet.mockReturnValue({
      id: 'reviewer',
      allowedCapabilities: ['bash', 'grep.search'],
    });

    bootstrapAgentChildForSession('ars_3');

    expect(ensureWikiProfileRegistered).not.toHaveBeenCalled();
  });
});
