import { describe, expect, it } from "vitest";
import { defaultLocalCapabilityPolicy } from "../../packages/capabilities/index.js";
import { createAgentNode } from "./agent-node.js";

describe("agent node capability boundary", () => {
  it("keeps high-risk local capabilities interactive", () => {
    const node = createAgentNode(
      { nodeId: "local", kind: "local", protocolVersion: "1" },
      defaultLocalCapabilityPolicy,
    );

    expect(node.decide({ capability: "terminal", risk: "execute" })).toBe("prompt");
    expect(node.decide({ capability: "read-file", risk: "read" })).toBe("allow");
  });

  it("creates a task addressed to the current node", () => {
    const node = createAgentNode(
      { nodeId: "cloud", kind: "cloud", protocolVersion: "1" },
      { read: "allow", write: "deny", execute: "deny", admin: "deny" },
    );

    const task = node.createTask("inspect the repository");
    expect(task.source).toEqual(node.identity);
    expect(task.taskId).toMatch(/^[-_a-zA-Z0-9]+$/);
  });
});
