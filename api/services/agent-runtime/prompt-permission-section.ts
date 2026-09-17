import type { PermissionRule, PermissionTier } from "./contracts.js";
import {
  resolveSessionPermissionRules,
  permissionTierFromRules,
} from "./permission-tiers.js";
import { resolvePermissionDecision } from "./permission-policy.js";

export interface BuildPermissionSectionInput {
  permissionTier?: PermissionTier;
  profileDefaults: PermissionRule[];
  /** Already-resolved session rules, including overrides and previously approved patterns. */
  effectiveRules?: PermissionRule[];
  isSubSession?: boolean;
}

export function buildPermissionSection(
  input: BuildPermissionSectionInput,
): string {
  const rules =
    input.effectiveRules ??
    resolveSessionPermissionRules(input.profileDefaults, {
      permissionTier: input.permissionTier,
    });
  const tier = permissionTierFromRules(rules) ?? input.permissionTier;
  if (tier === "boundary" || tier === "auto")
    return [
      "## Permission gates",
      tier === "boundary"
        ? "Boundary approval: external files and network access ALWAYS require user approval for each operation. Remembered allow rules cannot bypass this."
        : "Automatic risk review: proven low-risk operations are approved automatically. Dangerous or uncertain operations require user approval.",
      "Ordinary workspace reads and edits are allowed; credential/control files, deletes and uncertain commands require approval. Mode, Work and profile restrictions still apply.",
      `Effective rules: ${JSON.stringify(rules.map(({ gate, pattern, action }) => ({ gate, pattern, action }))).replace(/</g, "\\u003c")}`,
      "Use bash background:true for long-lived services; the user can stop them in the session sidebar.",
      "The current mode is reloaded every step. Runtime decisions and explicit deny overrides are authoritative; never route around an approval or denial.",
    ].join("\n");
  const labels = {
    allow: "allowed",
    ask: "requires user approval",
    deny: "denied",
  };
  const decision = (
    category: "read" | "write" | "delete" | "shell",
    pattern = "*",
  ) =>
    resolvePermissionDecision({
      sessionId: "prompt-preview",
      category: category === "delete" ? "write" : category,
      pattern,
      rules,
      isSubSession: input.isSubSession,
      ...(category !== "read" ? { internalGate: category } : {}),
    }).action;
  const unscoped = rules.filter((r) => r.pattern === "*");
  const scoped = rules.filter(
    (r) =>
      r.pattern !== "*" &&
      !(r.gate === "shell" && ["read", "write"].includes(r.pattern)),
  );
  const lines = ["## Permission gates"];
  if (
    rules.length === 1 &&
    rules[0].gate === "*" &&
    rules[0].pattern === "*" &&
    rules[0].action === "allow"
  ) {
    lines.push(
      "Unrestricted tool permissions. This is not authorization to expand the task or bypass mode/Work gates.",
    );
  } else {
    lines.push(
      `Default decisions: read ${labels[decision("read")]}; write ${labels[decision("write")]}; delete ${labels[decision("delete")]}.`,
    );
    lines.push(
      `Shell: read-only ${labels[decision("shell", "read")]}; mutating ${labels[decision("shell", "write")]}.`,
    );
    if (
      scoped.length ||
      unscoped.some(
        (r) => !["*", "read", "write", "delete", "shell"].includes(r.gate),
      )
    ) {
      // Preserve ordered pattern rules instead of claiming all paths/commands share the default action.
      lines.push(
        `Effective rules (ordered; evaluated by runtime per operation): ${JSON.stringify(rules.map(({ gate, pattern, action }) => ({ gate, pattern, action }))).replace(/</g, "\\u003c")}`,
      );
    }
  }
  lines.push(
    "Runtime decisions are authoritative. Wait when approval or input is pending; do not route around a denial through another tool.",
  );
  return lines.join("\n");
}
