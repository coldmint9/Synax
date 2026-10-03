import type { AgentCapabilityRequest } from "../agent-protocol/index.js";

export { CapabilityAuthorizer } from "./authorization/capability-authorizer.js";
export type { AuthorizationScope, CapabilityDefinition } from "./authorization/capability-authorizer.js";

export type CapabilityDecision = "allow" | "deny" | "prompt";

export interface CapabilityPolicy {
  read: CapabilityDecision;
  write: CapabilityDecision;
  execute: CapabilityDecision;
  admin: CapabilityDecision;
}

export const defaultLocalCapabilityPolicy: CapabilityPolicy = {
  read: "allow",
  write: "prompt",
  execute: "prompt",
  admin: "deny",
};

export function decideCapability(
  request: AgentCapabilityRequest,
  policy: CapabilityPolicy = defaultLocalCapabilityPolicy,
): CapabilityDecision {
  if (!Object.hasOwn(policy, request.risk)) return "deny";
  const decision = policy[request.risk];
  return decision === "allow" || decision === "prompt" ? decision : "deny";
}
