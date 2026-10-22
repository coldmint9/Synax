import { describe, expect, it } from 'vitest';
import { profileService } from '../profile-service.js';

describe('profileService', () => {
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
