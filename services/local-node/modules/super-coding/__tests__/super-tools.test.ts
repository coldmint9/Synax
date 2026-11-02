import { describe, expect, it } from "vitest";
import type { SuperCommandResult } from "../../../../../packages/contracts/super-coding.js";
import type { ToolExecutionInput } from "../../agent-runtime/contracts.js";
import {
  createSuperTools,
  superCloseArgsSchema,
  superMessageArgsSchema,
  superPlanArgsSchema,
} from "../super-tools.js";
import type { SuperService } from "../super-service.js";

const validNode = {
  id: "a",
  title: "Implement the thing",
  taskType: "implement",
  objective: "Make the feature work.",
  deliverable: "A working feature.",
};

function fakeService(result: SuperCommandResult = { ok: true }) {
  const calls = {
    plan: [] as unknown[],
    message: [] as unknown[],
    close: [] as unknown[],
    advance: [] as string[],
  };
  const service: SuperService = {
    async getGraph() {
      return null;
    },
    async plan(input) {
      calls.plan.push(input);
      return result;
    },
    async start() {
      return result;
    },
    async advance(sessionId) {
      calls.advance.push(sessionId);
      return result;
    },
    async message(input) {
      calls.message.push(input);
      return result;
    },
    async close(input) {
      calls.close.push(input);
      return result;
    },
    async stop() {
      return result;
    },
    async onChildSettled() {
      return;
    },
  };
  return { service, calls };
}

function toolInput(toolId: string, args: unknown): ToolExecutionInput {
  return {
    sessionId: "session-1",
    runId: null,
    stepId: null,
    toolCallId: "call-1",
    toolId,
    category: "task",
    mutability: "task",
    args,
  };
}

describe("super tool contracts", () => {
  it("exposes exactly the three fixed tool ids with task metadata", () => {
    const { service } = fakeService();
    const tools = createSuperTools(service);
    expect(tools.map((tool) => tool.id)).toEqual([
      "super.plan",
      "super.message",
      "super.close",
    ]);
    for (const tool of tools) {
      expect(tool.category).toBe("task");
      expect(tool.internalGate).toBe("task");
      expect(tool.mutability).toBe("task");
      expect(tool.resumeBehavior).toBe("auto");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("requires every mandatory plan field and a known task type", () => {
    expect(superPlanArgsSchema.safeParse({}).success).toBe(false);
    expect(superPlanArgsSchema.safeParse({ nodes: [] }).success).toBe(false);
    expect(
      superPlanArgsSchema.safeParse({ nodes: [{ id: "a", title: "A" }] })
        .success,
    ).toBe(false);
    expect(
      superPlanArgsSchema.safeParse({
        nodes: [{ ...validNode, taskType: "merge" }],
      }).success,
    ).toBe(false);
    expect(
      superPlanArgsSchema.safeParse({
        nodes: [
          {
            ...validNode,
            acceptance: ["tests pass"],
            scope: ["services/local-node"],
            requires: ["root"],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("requires a target node and a message body", () => {
    expect(superMessageArgsSchema.safeParse({ nodeId: "a" }).success).toBe(false);
    expect(superMessageArgsSchema.safeParse({ text: "hi" }).success).toBe(false);
    expect(
      superMessageArgsSchema.safeParse({ nodeId: "a", text: "hi" }).success,
    ).toBe(true);
    expect(superCloseArgsSchema.safeParse({}).success).toBe(true);
  });
});

describe("super tool execution", () => {
  it("plans with the session from the tool input", async () => {
    const { service, calls } = fakeService();
    const plan = createSuperTools(service).find((tool) => tool.id === "super.plan");
    const result = await plan?.execute(
      toolInput("super.plan", { nodes: [validNode] }),
    );

    expect(calls.plan).toEqual([
      { sessionId: "session-1", nodes: [validNode] },
    ]);
    expect(calls.advance).toEqual(["session-1"]);
    expect(result?.result).toEqual({ ok: true });
    expect(result?.outcome).toBeUndefined();
  });

  it("messages as the main agent with the session from the tool input", async () => {
    const { service, calls } = fakeService();
    const message = createSuperTools(service).find(
      (tool) => tool.id === "super.message",
    );
    const result = await message?.execute(
      toolInput("super.message", { nodeId: "a", text: "focus on tests" }),
    );

    expect(calls.message).toEqual([
      { sessionId: "session-1", nodeId: "a", from: "main", text: "focus on tests" },
    ]);
    expect(result?.outcome).toBeUndefined();
  });

  it("closes the graph for the tool input session", async () => {
    const { service, calls } = fakeService();
    const close = createSuperTools(service).find((tool) => tool.id === "super.close");
    await close?.execute(toolInput("super.close", {}));

    expect(calls.close).toEqual([{ sessionId: "session-1" }]);
    expect(calls.advance).toEqual(["session-1"]);
  });

  it("turns a rejected command into a failed tool result", async () => {
    const { service, calls } = fakeService({
      ok: false,
      code: "BUDGET",
      message: "Node budget is full",
    });
    const plan = createSuperTools(service).find((tool) => tool.id === "super.plan");
    const result = await plan?.execute(
      toolInput("super.plan", { nodes: [validNode] }),
    );

    expect(result?.outcome).toBe("failed");
    expect(result?.displaySummary).toContain("BUDGET");
    expect(result?.displaySummary).toContain("Node budget is full");
    expect(calls.advance).toEqual([]);
  });

  it("rejects invalid arguments before calling the service", async () => {
    const { service, calls } = fakeService();
    const plan = createSuperTools(service).find((tool) => tool.id === "super.plan");
    await expect(
      plan?.execute(toolInput("super.plan", { nodes: [] })),
    ).rejects.toThrow();
    expect(calls.plan).toHaveLength(0);
  });
});
