import type { PermissionOverrides, PermissionRule, PermissionTier } from './contracts.js';
import { applyPermissionOverrides } from './permission-overrides.js';

const allowRead = (reason = 'Read access is allowed.'): PermissionRule => ({
  gate: 'read',
  pattern: '*',
  action: 'allow',
  reason,
});

const allowWrite = (reason = 'Write access is allowed.'): PermissionRule => ({
  gate: 'write',
  pattern: '*',
  action: 'allow',
  reason,
});

const allowDelete = (reason = 'Delete access is allowed.'): PermissionRule => ({
  gate: 'delete',
  pattern: '*',
  action: 'allow',
  reason,
});

const askWrite = (reason = 'Writes require approval.'): PermissionRule => ({
  gate: 'write',
  pattern: '*',
  action: 'ask',
  reason,
});

const askDelete = (reason = 'Deletes require approval.'): PermissionRule => ({
  gate: 'delete',
  pattern: '*',
  action: 'ask',
  reason,
});

const denyWriteShell = (reason = 'Mutating shell commands are not permitted in readonly mode.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'write',
  action: 'deny',
  reason,
});

const askReadShell = (reason = 'Read-only shell commands require approval.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'read',
  action: 'ask',
  reason,
});

const allowReadShell = (reason = 'Read-only shell commands are allowed.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'read',
  action: 'allow',
  reason,
});

const askWriteShell = (reason = 'Mutating shell commands require approval.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'write',
  action: 'ask',
  reason,
});

/**
 * Three permission tiers:
 *
 * 1. readonly — read freely; write/delete and read shell need approval; mutating shell denied.
 * 2. readwrite — full read/write/delete; read shell allowed; mutating shell needs approval.
 * 3. unrestricted — no permission gates.
 */
export function permissionRulesForTier(tier: PermissionTier): PermissionRule[] {
  switch (tier) {
    case 'readonly':
      return [
        allowRead(),
        askWrite(),
        askDelete(),
        denyWriteShell(),
        askReadShell(),
      ];
    case 'readwrite':
      return [
        allowRead(),
        allowWrite(),
        allowDelete(),
        allowReadShell(),
        askWriteShell(),
      ];
    case 'unrestricted':
      return [{ gate: '*', pattern: '*', action: 'allow', reason: 'Unrestricted access.' }];
    default: {
      const _exhaustive: never = tier;
      return _exhaustive;
    }
  }
}

export function isUnrestrictedPermissionRules(rules: PermissionRule[]): boolean {
  return rules.some((rule) => rule.gate === '*' && rule.pattern === '*' && rule.action === 'allow');
}

export function resolveSessionPermissionRules(
  profileDefaults: PermissionRule[],
  input: { permissionTier?: PermissionTier; permissionOverrides?: PermissionOverrides },
): PermissionRule[] {
  const base = input.permissionTier ? permissionRulesForTier(input.permissionTier) : profileDefaults;
  return applyPermissionOverrides(base, input.permissionOverrides);
}
