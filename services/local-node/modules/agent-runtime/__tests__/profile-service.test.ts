import { describe, expect, it } from 'vitest';
import { profileService } from '../profile-service.js';

describe('profileService', () => {
  it('lists the Synax business agent profiles', () => {
    const ids = profileService.list().map((profile) => profile.id);
    expect(ids).toEqual(expect.arrayContaining(['planner', 'executor', 'reviewer', 'explorer']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('limits v1 sub-sessions to read-only review and exploration profiles', () => {
    expect(() => profileService.assertCanStart('planner', { parentSessionId: 'parent' })).toThrow(/subagent profile/i);
    expect(profileService.assertCanStart('explorer', { parentSessionId: 'parent' }).id).toBe('explorer');
    expect(profileService.assertCanStart('reviewer', { parentSessionId: 'parent' }).id).toBe('reviewer');
  });
});
