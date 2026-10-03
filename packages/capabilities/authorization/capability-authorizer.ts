import type { AgentCapabilityRequest, AgentCapabilityRisk } from "../../agent-protocol/index.js";
import { decideCapability, type CapabilityDecision, type CapabilityPolicy } from "../index.js";

export interface CapabilityDefinition {
  capability: string;
  risk: AgentCapabilityRisk;
}

export interface AuthorizationScope {
  taskId: string;
  nodeId: string;
  principalId: string;
  capability: string;
  resource: string;
}

interface Grant {
  scope: AuthorizationScope;
  expiresAt: number;
}

function sameScope(a: AuthorizationScope, b: AuthorizationScope): boolean {
  return a.taskId === b.taskId && a.nodeId === b.nodeId &&
    a.principalId === b.principalId && a.capability === b.capability && a.resource === b.resource;
}

/** Grants are issued by the receiving node's trusted confirmation handler, never by protocol input. */
export class CapabilityAuthorizer {
  private readonly definitions = new Map<string, AgentCapabilityRisk>();
  private readonly grants = new Map<string, Grant>();
  private readonly policy: CapabilityPolicy;

  constructor(definitions: readonly CapabilityDefinition[], policy: CapabilityPolicy, private readonly now = Date.now) {
    this.policy = { ...policy };
    for (const definition of definitions) {
      if (this.definitions.has(definition.capability)) throw new Error("Duplicate capability definition");
      this.definitions.set(definition.capability, definition.risk);
    }
  }

  decide(request: AgentCapabilityRequest): CapabilityDecision {
    const risk = this.definitions.get(request.capability);
    // Risk comes from the receiver's registry. The sender cannot downgrade it.
    if (!risk || risk !== request.risk) return "deny";
    const policyDecision = decideCapability({ ...request, risk }, this.policy);
    if (policyDecision === "deny") return "deny";
    return risk === "read" ? policyDecision : "prompt";
  }

  approve(scope: AuthorizationScope, ttlMs = 60_000): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) throw new Error("Invalid grant lifetime");
    if (Object.values(scope).some(value => typeof value !== "string" || value.trim() === "")) {
      throw new Error("Authorization scope must be complete");
    }
    const risk = this.definitions.get(scope.capability);
    if (!risk || this.decide({ capability: scope.capability, risk, resource: scope.resource }) === "deny") {
      throw new Error("Capability cannot be approved");
    }
    this.prune();
    const id = crypto.randomUUID();
    this.grants.set(id, { scope: { ...scope }, expiresAt: this.now() + ttlMs });
    return id;
  }

  authorize(request: AgentCapabilityRequest, scope: AuthorizationScope, grantId?: string): boolean {
    if (request.capability !== scope.capability || request.resource !== scope.resource) return false;
    if (!scope.taskId || !scope.nodeId || !scope.principalId || !scope.resource) return false;
    this.prune();
    const decision = this.decide(request);
    if (decision === "deny") return false;
    if (decision === "allow") return true;
    if (!grantId) return false;
    const grant = this.grants.get(grantId);
    if (!grant || !sameScope(grant.scope, scope)) return false;
    // Consume before executing a side effect; retries need a new confirmation.
    this.grants.delete(grantId);
    return true;
  }

  revokeTask(taskId: string): void {
    for (const [id, grant] of this.grants) if (grant.scope.taskId === taskId) this.grants.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
  }
}
