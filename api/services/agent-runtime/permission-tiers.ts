import type {
  PermissionOverrides,
  PermissionRule,
  PermissionTier,
} from "./contracts.js";
import { applyPermissionOverrides } from "./permission-overrides.js";

export function permissionRulesForTier(tier: PermissionTier): PermissionRule[] {
  if (tier === "unrestricted")
    return [
      {
        gate: "*",
        pattern: "*",
        action: "allow",
        reason: "Unrestricted access.",
      },
    ];
  return [
    {
      gate: "approval_mode",
      pattern: tier,
      action: "ask",
      reason: "Runtime risk review is authoritative.",
    },
    {
      gate: "read",
      pattern: "*",
      action: "allow",
      reason: "Ordinary workspace reads are allowed.",
    },
    {
      gate: "write",
      pattern: "*",
      action: "allow",
      reason: "Ordinary workspace edits are allowed.",
    },
    {
      gate: "delete",
      pattern: "*",
      action: "ask",
      reason: "Deletion requires approval.",
    },
    { gate: "shell", pattern: "read", action: "allow" },
    {
      gate: "shell",
      pattern: "write",
      action: "ask",
      reason: "Unknown or mutating commands require approval.",
    },
    {
      gate: "external_path",
      pattern: "*",
      action: "ask",
      reason: "External file access requires approval.",
    },
    {
      gate: "network",
      pattern: "*",
      action: tier === "boundary" ? "ask" : "allow",
      reason: "Network access is reviewed per operation.",
    },
  ];
}

export function permissionTierFromRules(
  rules: PermissionRule[],
): PermissionTier | undefined {
  const modes = rules
    .filter((rule) => rule.gate === "approval_mode")
    .map((rule) => rule.pattern);
  if (modes.includes("boundary")) return "boundary";
  if (modes.includes("auto")) return "auto";
  if (
    rules.some(
      (rule) =>
        rule.gate === "*" && rule.pattern === "*" && rule.action === "allow",
    )
  )
    return "unrestricted";
  return undefined;
}

export function isUnrestrictedPermissionRules(
  rules: PermissionRule[],
): boolean {
  return permissionTierFromRules(rules) === "unrestricted";
}

export function resolveSessionPermissionRules(
  profileDefaults: PermissionRule[],
  input: {
    permissionTier?: PermissionTier;
    permissionOverrides?: PermissionOverrides;
  },
): PermissionRule[] {
  return applyPermissionOverrides(
    input.permissionTier
      ? permissionRulesForTier(input.permissionTier)
      : profileDefaults,
    input.permissionOverrides,
  );
}
