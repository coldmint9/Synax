import type { PermissionRule, PermissionTier } from './contracts.js';
import { isUnrestrictedPermissionRules, resolveSessionPermissionRules } from './permission-tiers.js';

export interface BuildPermissionSectionInput {
  permissionTier?: PermissionTier;
  profileDefaults: PermissionRule[];
}

function actionForGate(rules: PermissionRule[], gate: string, pattern = '*'): string | null {
  const rule = rules.find((entry) => entry.gate === gate && entry.pattern === pattern);
  return rule?.action ?? null;
}

export function buildPermissionSection(input: BuildPermissionSectionInput): string {
  const rules = resolveSessionPermissionRules(input.profileDefaults, {
    permissionTier: input.permissionTier,
  });

  if (isUnrestrictedPermissionRules(rules)) {
    return [
      '## Permission gates',
      'Unrestricted: read, write, delete, and shell are allowed without approval.',
    ].join('\n');
  }

  const tier = input.permissionTier ?? 'profile-default';
  const write = actionForGate(rules, 'write');
  const deleteAction = actionForGate(rules, 'delete');
  const shellRead = actionForGate(rules, 'shell', 'read');
  const shellWrite = actionForGate(rules, 'shell', 'write');

  const lines = [
    '## Permission gates',
    `Active tier: ${tier}.`,
    '- Read tools (file.read, grep.search, file.glob, file.list, diff.read, wiki.*): allowed.',
  ];

  if (write === 'ask') lines.push('- Write tools (file.write, edit): require user approval before execution.');
  else if (write === 'allow') lines.push('- Write tools (file.write, edit): allowed.');
  else if (write === 'deny') lines.push('- Write tools (file.write, edit): denied.');

  if (deleteAction === 'ask') lines.push('- Delete (file.delete): requires user approval.');
  else if (deleteAction === 'allow') lines.push('- Delete (file.delete): allowed.');
  else if (deleteAction === 'deny') lines.push('- Delete (file.delete): denied.');

  if (shellRead === 'ask') lines.push('- bash (read-only): requires user approval.');
  else if (shellRead === 'allow') lines.push('- bash (read-only): allowed.');
  else if (shellRead === 'deny') lines.push('- bash (read-only): denied.');

  if (shellWrite === 'deny') lines.push('- bash (mutating): denied.');
  else if (shellWrite === 'ask') lines.push('- bash (mutating): requires user approval.');
  else if (shellWrite === 'allow') lines.push('- bash (mutating): allowed.');

  lines.push('If a tool waits on approval, continue with read-only work or summarize blockers for the user.');

  return lines.join('\n');
}
