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
  const labels = {
    allow: "allowed",
    ask: "requires user approval",
    deny: "denied",
  };
  const decision = (
    category: "read" | "write" | "delete" | "shell",
    pattern = "*",
  ) =>
    resolvePermissionDecision(
      {
        sessionId: "prompt-preview",
        category: category === "delete" ? "write" : category,
        pattern,
        rules,
        isSubSession: input.isSubSession,
        ...(category !== "read" ? { internalGate: category } : {}),
      },
      null,
    ).action;
  const unscoped = rules.filter((r) => r.pattern === "*");
  const scoped = rules.filter(
    (r) =>
      r.pattern !== "*" &&
      !(r.gate === "shell" && ["read", "write"].includes(r.pattern)),
  );
  const lines = ["## Permission gates"];
  if (tier === "boundary" || tier === "auto") {
    lines.push(
      tier === "boundary"
        ? "Boundary approval: external files and network access ALWAYS require user approval per operation unless denied. Remembered allow rules cannot bypass this."
        : "Automatic risk review: low-risk operations may be approved automatically; dangerous or uncertain operations require approval unless denied.",
      "Defaults below describe base rules, not final approval. Per-operation risk review and mode/Work restrictions still apply; explicit deny rules remain authoritative.",
    );
  }
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
