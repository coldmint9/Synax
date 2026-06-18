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


const askTask = (reason = 'Task delegation requires approval.'): PermissionRule => ({
  gate: 'task',
  pattern: '*',
  action: 'ask',
  reason,
});

const denyNonWhitelistShell = (reason = 'Only whitelisted shell commands are permitted in readonly mode.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'non-whitelist',
  action: 'deny',
  reason,
});

const allowWhitelistShell = (reason = 'Whitelisted shell commands are allowed.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'whitelist',
  action: 'allow',
  reason,
});

const askWhitelistShell = (reason = 'Whitelisted shell commands require approval.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'whitelist',
  action: 'ask',
  reason,
});

const askNonWhitelistShell = (reason = 'Non-whitelisted shell commands require approval.'): PermissionRule => ({
  gate: 'shell',
  pattern: 'non-whitelist',
  action: 'ask',
  reason,
});

/**
 * Three permission tiers:
 *
 * 1. readonly — read freely; write, delete, and whitelisted shell commands require approval.
 * 2. readwrite — full read/write/delete; non-whitelisted shell commands require approval.
 * 3. unrestricted — no permission gates.
 */
export function permissionRulesForTier(tier: PermissionTier): PermissionRule[] {
  switch (tier) {
    case 'readonly':
      return [
        allowRead(),
        askWrite(),
        askDelete(),
        denyNonWhitelistShell(),
        askWhitelistShell(),
        askTask(),
      ];
    case 'readwrite':
      return [
        allowRead(),
        allowWrite(),
        allowDelete(),
        allowWhitelistShell(),
        askNonWhitelistShell(),
        askTask(),
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
