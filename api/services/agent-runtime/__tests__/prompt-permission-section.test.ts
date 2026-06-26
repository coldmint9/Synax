import { describe, expect, it } from 'vitest';
import { buildPermissionSection } from '../prompt-permission-section.js';
import { synaxAgentProfile } from '../synax/synax-agent-profile.js';

describe('buildPermissionSection', () => {
  it('summarizes readonly tier gates', () => {
    const section = buildPermissionSection({
      permissionTier: 'readonly',
      profileDefaults: synaxAgentProfile.permissionDefaults,
    });
    expect(section).toContain('## Permission gates');
    expect(section).toContain('require user approval');
    expect(section).toContain('bash (mutating): denied');
  });

  it('summarizes unrestricted tier', () => {
    const section = buildPermissionSection({
      permissionTier: 'unrestricted',
      profileDefaults: synaxAgentProfile.permissionDefaults,
    });
    expect(section).toContain('Unrestricted');
  });
});
