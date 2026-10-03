import { describe, expect, it } from "vitest";
import { agentTaskRequestSchema, negotiateProtocolVersion } from "./index.js";

const request = {
  protocolVersion: "1",
  taskId: "task-1",
  source: { nodeId: "cloud", kind: "cloud", protocolVersion: "1" },
  target: { nodeId: "local", kind: "local", protocolVersion: "1" },
  prompt: "Inspect repository",
  capabilities: [{ capability: "file.read", risk: "read", resource: "/workspace/file" }],
};

describe("versioned Agent task boundary", () => {
  it("round-trips the task through a serialized protocol boundary", () => {
    expect(agentTaskRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });
  it.each([undefined, "", "2"])("rejects unsupported envelope version %s", protocolVersion => {
    expect(agentTaskRequestSchema.safeParse({ ...request, protocolVersion }).success).toBe(false);
  });
  it("rejects unsupported peer versions and undeclared envelope fields", () => {
    expect(agentTaskRequestSchema.safeParse({ ...request, source: { ...request.source, protocolVersion: "2" } }).success).toBe(false);
    expect(agentTaskRequestSchema.safeParse({ ...request, approved: true }).success).toBe(false);
  });
  it("rejects empty tasks and malformed capabilities", () => {
    expect(agentTaskRequestSchema.safeParse({ ...request, prompt: "  " }).success).toBe(false);
    expect(agentTaskRequestSchema.safeParse({ ...request, capabilities: [{ capability: "file.read", risk: "owner" }] }).success).toBe(false);
  });
  it("negotiates only a supported common version", () => {
    expect(negotiateProtocolVersion(["2", "1"])).toBe("1");
    expect(() => negotiateProtocolVersion(["2"])).toThrow("No compatible");
  });
});
