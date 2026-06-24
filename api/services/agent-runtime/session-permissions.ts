import { z } from 'zod';
import type {
  AgentSession,
  PermissionOverrides,
  PermissionRule,
  PermissionTier,
} from './contracts.js';
import { permissionTierSchema, permissionOverridesSchema } from './contracts.js';
import { profileService } from './profile-service.js';
import { resolveSessionPermissionRules } from './permission-tiers.js';
import { agentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';

export const SESSION_PERMISSION_TIER_KEY = 'permissionTier';
export const SESSION_PERMISSION_OVERRIDES_KEY = 'permissionOverrides';
export const SESSION_ALWAYS_PERMISSION_RULES_KEY = 'alwaysPermissionRules';

const permissionRuleSchema = z.object({
  gate: z.string(),
  pattern: z.string(),
  action: z.enum(['allow', 'ask', 'deny']),
  reason: z.string().optional(),
});

export interface SessionPermissionConfig {
  permissionTier?: PermissionTier;
  permissionOverrides?: PermissionOverrides;
  alwaysPermissionRules: PermissionRule[];
}

export const updateSessionPermissionRequestSchema = z.object({
  permissionTier: permissionTierSchema.optional(),
  permissionOverrides: permissionOverridesSchema.optional(),
});
export type UpdateSessionPermissionRequest = z.infer<typeof updateSessionPermissionRequestSchema>;

export function readSessionPermissionConfig(
  metadata: Record<string, unknown> | null | undefined,
): SessionPermissionConfig {
  const tier = metadata?.[SESSION_PERMISSION_TIER_KEY];
  const overrides = metadata?.[SESSION_PERMISSION_OVERRIDES_KEY];
  const alwaysRaw = metadata?.[SESSION_ALWAYS_PERMISSION_RULES_KEY];
  const parsedTier = permissionTierSchema.safeParse(tier);
  const parsedOverrides = permissionOverridesSchema.safeParse(overrides);
  const parsedAlways = z.array(permissionRuleSchema).safeParse(alwaysRaw);
  return {
    permissionTier: parsedTier.success ? parsedTier.data : undefined,
    permissionOverrides: parsedOverrides.success ? parsedOverrides.data : undefined,
    alwaysPermissionRules: parsedAlways.success ? parsedAlways.data as PermissionRule[] : [],
  };
}

export function rebuildSessionPermissionRules(
  session: AgentSession,
  profilePermissionDefaults: PermissionRule[],
): PermissionRule[] {
  const config = readSessionPermissionConfig(session.sessionMetadata);
  const tierRules = resolveSessionPermissionRules(profilePermissionDefaults, {
    permissionTier: config.permissionTier,
    permissionOverrides: config.permissionOverrides,
  });
  const alwaysRules = config.alwaysPermissionRules;

  if (session.parentSessionId) {
    const parent = agentRuntimeStore.tryGetSession(session.parentSessionId);
    const inheritedRules = parent?.permissionRules ?? [];
    return [...inheritedRules, ...tierRules, ...alwaysRules];
  }

  return [...tierRules, ...alwaysRules];
}

export function applySessionPermissionUpdate(
  sessionId: string,
  input: UpdateSessionPermissionRequest,
): AgentSession {
  if (input.permissionTier === undefined && input.permissionOverrides === undefined) {
    return agentRuntimeStore.getSession(sessionId);
  }

  const session = agentRuntimeStore.getSession(sessionId);
  const profile = profileService.get(session.profileId);
  const current = readSessionPermissionConfig(session.sessionMetadata);

  const metadataPatch: Record<string, unknown> = {};
  if (input.permissionTier !== undefined) {
    metadataPatch[SESSION_PERMISSION_TIER_KEY] = input.permissionTier;
  }
  if (input.permissionOverrides !== undefined) {
    metadataPatch[SESSION_PERMISSION_OVERRIDES_KEY] = input.permissionOverrides;
  }

  const nextMetadata = { ...(session.sessionMetadata ?? {}), ...metadataPatch };
  const nextConfig = readSessionPermissionConfig(nextMetadata);
  const permissionRules = rebuildSessionPermissionRules(
    { ...session, sessionMetadata: nextMetadata },
    profile.permissionDefaults,
  );

  agentRuntimeStore.updateSessionMetadata(sessionId, metadataPatch);
  return agentRuntimeStore.updateSession(sessionId, {
    permissionRules,
    updatedAt: nowIso(),
  });
}

export function appendAlwaysPermissionRule(
  sessionId: string,
  rule: PermissionRule,
): AgentSession {
  const session = agentRuntimeStore.getSession(sessionId);
  const profile = profileService.get(session.profileId);
  const config = readSessionPermissionConfig(session.sessionMetadata);
  const alwaysPermissionRules = [...config.alwaysPermissionRules, rule];

  agentRuntimeStore.updateSessionMetadata(sessionId, {
    [SESSION_ALWAYS_PERMISSION_RULES_KEY]: alwaysPermissionRules,
  });

  const updated = agentRuntimeStore.getSession(sessionId);
  const permissionRules = rebuildSessionPermissionRules(updated, profile.permissionDefaults);
  return agentRuntimeStore.updateSession(sessionId, {
    permissionRules,
    updatedAt: nowIso(),
  });
}

export function seedSessionPermissionMetadata(
  sessionMetadata: Record<string, unknown> | null | undefined,
  input: { permissionTier?: PermissionTier; permissionOverrides?: PermissionOverrides },
): Record<string, unknown> {
  const next = { ...(sessionMetadata ?? {}) };
  if (input.permissionTier !== undefined) {
    next[SESSION_PERMISSION_TIER_KEY] = input.permissionTier;
  }
  if (input.permissionOverrides !== undefined && Object.keys(input.permissionOverrides).length > 0) {
    next[SESSION_PERMISSION_OVERRIDES_KEY] = input.permissionOverrides;
  }
  if (!Array.isArray(next[SESSION_ALWAYS_PERMISSION_RULES_KEY])) {
    next[SESSION_ALWAYS_PERMISSION_RULES_KEY] = [];
  }
  return next;
}
