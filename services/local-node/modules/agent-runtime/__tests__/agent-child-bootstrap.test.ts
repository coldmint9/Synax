import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureGitMrProfileRegistered = vi.fn();
const ensureLegacyGoalProfileRegistered = vi.fn();
const tryGetSession = vi.fn();

vi.mock('../git/profile.js', () => ({
  ensureGitMrProfileRegistered: (...args: unknown[]) =>
    ensureGitMrProfileRegistered(...args),
}));

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: {
    tryGetSession: (...args: unknown[]) => tryGetSession(...args),
  },
}));

vi.mock('../synax/index.js', () => ({
  ensureLegacyGoalProfileRegistered: (...args: unknown[]) =>
    ensureLegacyGoalProfileRegistered(...args),
  isSynaxProfile: (profileId: string) => profileId.startsWith('synax'),
}));

import { bootstrapAgentChildForSession } from '../agent-child-bootstrap.js';

describe('bootstrapAgentChildForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers Git manager tools on worker resume', () => {
    tryGetSession.mockReturnValue({
      id: 'git_session',
      profileId: 'git-manager',
      projectId: 'p1',
    });

    bootstrapAgentChildForSession('git_session');

    expect(ensureGitMrProfileRegistered).toHaveBeenCalledOnce();
    expect(ensureLegacyGoalProfileRegistered).not.toHaveBeenCalled();
  });

  it('registers the legacy goal profile for synax sessions', () => {
    tryGetSession.mockReturnValue({
      id: 'ars_1',
      profileId: 'synax',
      projectId: 'p1',
    });

    bootstrapAgentChildForSession('ars_1');

    expect(ensureLegacyGoalProfileRegistered).toHaveBeenCalled();
    expect(ensureGitMrProfileRegistered).not.toHaveBeenCalled();
  });

  it('ignores unknown sessions', () => {
    tryGetSession.mockReturnValue(null);

    bootstrapAgentChildForSession('missing');

    expect(ensureGitMrProfileRegistered).not.toHaveBeenCalled();
    expect(ensureLegacyGoalProfileRegistered).not.toHaveBeenCalled();
  });
});
