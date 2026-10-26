import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../contracts.js';
import { ProfileService, profileService } from '../profile-service.js';

describe('profileService', () => {
  it('resolves persisted merge workers in a fresh host without launching a worker', () => {
    const profiles = new ProfileService();
    const profile = profiles.getForSession({
      id: 'merge-child', profileId: 'git-merge-worker', parentSessionId: 'parent',
    } as AgentSession);
    expect(profile).toMatchObject({
      id: 'git-merge-worker', mode: 'subagent', toolProviderId: 'conversation-git-worker',
      allowsSubsessions: false, toolPolicy: { allowSubtasks: false },
    });
    expect(profile.allowedCapabilities).toContain('git.merge.worker.read');
    expect(profile.allowedCapabilities.every(id => id.startsWith('git.merge.worker.'))).toBe(true);
    expect(profiles.list().map(item => item.id)).not.toContain(profile.id);
    expect(() => profiles.assertCanStart(profile.id)).toThrow(/require a parent/);
    expect(profiles.assertCanStart(profile.id, { parentSessionId: 'parent' }).id).toBe(profile.id);
  });

  it('lists the Synax business agent profiles', () => {
    const ids = profileService.list().map((profile) => profile.id);
    expect(ids).toEqual(expect.arrayContaining(['planner', 'executor', 'subagent']));
    expect(profileService.list().filter(profile => profile.mode === 'subagent').map(profile => profile.id)).toEqual(['subagent']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires a parent for the generic profile and retains historical profile lookups', () => {
    expect(() => profileService.assertCanStart('planner', { parentSessionId: 'parent' })).toThrow(/subagent profile/i);
    expect(profileService.assertCanStart('explorer', { parentSessionId: 'parent' }).id).toBe('explorer');
    expect(profileService.assertCanStart('reviewer', { parentSessionId: 'parent' }).id).toBe('reviewer');
    expect(() => profileService.assertCanStart('subagent')).toThrow(/parent/);
    expect(profileService.assertCanStart('subagent', { parentSessionId: 'parent' }).id).toBe('subagent');
  });
});
