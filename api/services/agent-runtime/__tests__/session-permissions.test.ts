import { describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import {
  applySessionPermissionUpdate,
  readSessionPermissionConfig,
  rebuildSessionPermissionRules,
  SESSION_PERMISSION_TIER_KEY,
} from '../session-permissions.js';
import { profileService } from '../profile-service.js';
import { agentRuntimeStore } from '../session-store.js';
import { synaxAgentProfile } from '../synax/synax-agent-profile.js';

describe('session-permissions', () => {
  it('rebuilds permission rules when tier changes mid-session', () => {
    profileService.register(synaxAgentProfile);
    const session = agentSessionRuntime.create({
      projectId: 'proj-perm',
      profileId: synaxAgentProfile.id,
      prompt: 'Test permissions',
      permissionTier: 'readonly',
    });

    expect(session.permissionRules.some((rule) => rule.gate === 'shell' && rule.pattern === 'write' && rule.action === 'deny')).toBe(true);

    const updated = applySessionPermissionUpdate(session.id, { permissionTier: 'readwrite' });
    expect(updated.permissionRules.some((rule) => rule.gate === 'write' && rule.action === 'allow')).toBe(true);
    expect(readSessionPermissionConfig(updated.sessionMetadata).permissionTier).toBe('readwrite');
  });

  it('preserves always-granted rules after tier change', () => {
    profileService.register(synaxAgentProfile);
    const session = agentSessionRuntime.create({
      projectId: 'proj-perm-always',
      profileId: synaxAgentProfile.id,
      prompt: 'Always allow test',
      permissionTier: 'readonly',
    });

    agentRuntimeStore.updateSessionMetadata(session.id, {
      alwaysPermissionRules: [{ gate: 'write', pattern: 'src/*', action: 'allow', reason: 'User always allowed.' }],
    });
    const withAlways = agentRuntimeStore.updateSession(session.id, {
      permissionRules: rebuildSessionPermissionRules(
        agentRuntimeStore.getSession(session.id),
        synaxAgentProfile.permissionDefaults,
      ),
    });

    const updated = applySessionPermissionUpdate(withAlways.id, { permissionTier: 'readonly' });
    expect(updated.permissionRules.some((rule) => rule.pattern === 'src/*' && rule.action === 'allow')).toBe(true);
    expect(updated.sessionMetadata?.[SESSION_PERMISSION_TIER_KEY]).toBe('readonly');
  });
});
