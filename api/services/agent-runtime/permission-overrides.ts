import type { PermissionAction, PermissionOverrides, PermissionRule } from './contracts.js';

export function applyPermissionOverrides(
  defaults: PermissionRule[],
  overrides?: PermissionOverrides,
): PermissionRule[] {
  if (!overrides || Object.keys(overrides).length === 0) return defaults;
  return defaults.map((rule) => {
    const gate = rule.gate;
    if (gate === 'read' || gate === 'write' || gate === 'delete' || gate === 'shell' || gate === 'task') {
      const action = overrides[gate];
      if (action) return { ...rule, action: action as PermissionAction };
    }
    return rule;
  });
}
