import type {
  PermissionAction,
  PermissionOverrides,
  PermissionRule,
} from "./contracts.js";

export function applyPermissionOverrides(
  defaults: PermissionRule[],
  overrides?: PermissionOverrides,
): PermissionRule[] {
  if (!overrides || Object.keys(overrides).length === 0) return defaults;
  const rules = defaults.map((rule) => {
    const gate = rule.gate;
    if (
      gate === "read" ||
      gate === "write" ||
      gate === "delete" ||
      gate === "shell" ||
      gate === "task"
    ) {
      const action = overrides[gate];
      if (action)
        return {
          ...rule,
          action: action as PermissionAction,
          reason: `Session override: ${gate} ${action === "allow" ? "is allowed" : action === "deny" ? "is denied" : "requires approval"}.`,
        };
    }
    return rule;
  });
  // Unrestricted/default profiles may contain only a wildcard rule. Explicit
  // per-gate choices still need a concrete rule, especially inherited denies.
  for (const [gate, action] of Object.entries(overrides)) {
    if (action && !defaults.some(rule => rule.gate === gate))
      rules.push({ gate: gate as keyof PermissionOverrides, pattern: "*", action,
        reason: `Session override: ${gate} ${action}.` });
  }
  return rules;
}
