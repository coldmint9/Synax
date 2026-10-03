import { describe, expect, it } from "vitest";
import { CapabilityAuthorizer, defaultLocalCapabilityPolicy, decideCapability } from "../index.js";
import type { AuthorizationScope } from "./capability-authorizer.js";

const definitions = [
  { capability: "file.read", risk: "read" },
  { capability: "file.write", risk: "write" },
  { capability: "terminal", risk: "execute" },
  { capability: "admin", risk: "admin" },
] as const;
const scope: AuthorizationScope = { taskId: "t1", nodeId: "cloud", principalId: "tenant/user", capability: "file.write", resource: "/workspace/file" };
const write = { capability: "file.write", risk: "write", resource: scope.resource } as const;

describe("receiving node capability authorization", () => {
  it("allows registered reads but rejects missing resources and unknown capabilities", () => {
    const authorizer = new CapabilityAuthorizer(definitions, defaultLocalCapabilityPolicy);
    const readScope = { ...scope, capability: "file.read" };
    expect(authorizer.authorize({ capability: "file.read", risk: "read", resource: scope.resource }, readScope)).toBe(true);
    expect(authorizer.authorize({ capability: "file.read", risk: "read" }, readScope)).toBe(false);
    expect(authorizer.decide({ capability: "unknown", risk: "read" })).toBe("deny");
  });
  it("does not accept a sender's risk downgrade or a blanket high-risk allow policy", () => {
    const authorizer = new CapabilityAuthorizer(definitions, { read: "allow", write: "allow", execute: "allow", admin: "deny" });
    expect(authorizer.decide({ ...write, risk: "read" })).toBe("deny");
    expect(authorizer.decide(write)).toBe("prompt");
    expect(authorizer.authorize(write, scope)).toBe(false);
  });
  it("consumes each write approval once", () => {
    const authorizer = new CapabilityAuthorizer(definitions, defaultLocalCapabilityPolicy);
    const grant = authorizer.approve(scope);
    expect(authorizer.authorize(write, scope, grant)).toBe(true);
    expect(authorizer.authorize(write, scope, grant)).toBe(false);
  });
  it.each(["taskId", "nodeId", "principalId", "capability", "resource"] as const)("binds approvals to %s", field => {
    const authorizer = new CapabilityAuthorizer(definitions, defaultLocalCapabilityPolicy);
    const grant = authorizer.approve(scope);
    expect(authorizer.authorize(write, { ...scope, [field]: "other" }, grant)).toBe(false);
    expect(authorizer.authorize(write, scope, grant)).toBe(true);
  });
  it("expires grants and revokes them when a task is cancelled", () => {
    let now = 0;
    const authorizer = new CapabilityAuthorizer(definitions, defaultLocalCapabilityPolicy, () => now);
    const expired = authorizer.approve(scope, 10);
    now = 10;
    expect(authorizer.authorize(write, scope, expired)).toBe(false);
    const revoked = authorizer.approve(scope);
    authorizer.revokeTask(scope.taskId);
    expect(authorizer.authorize(write, scope, revoked)).toBe(false);
  });
  it("fails closed for denied capability and inherited policy keys", () => {
    const authorizer = new CapabilityAuthorizer(definitions, defaultLocalCapabilityPolicy);
    expect(() => authorizer.approve({ ...scope, capability: "admin" })).toThrow("cannot be approved");
    expect(decideCapability({ capability: "forged", risk: "toString" as "read" })).toBe("deny");
  });
});
