import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { explorerSessionInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { closeDb } from "../../../infrastructure/database/index.js";
import { toolRegistry } from "../tool-registry.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";

function createParent() {
  ensureSynaxAgentRegistered();
  return agentSessionRuntime.create({ ...explorerSessionInput, profileId: "synax" });
}

const specialist = {
  name: "Expert", role: "Reviewer", instructions: "Read files", capabilities: ["file.read"],
};

describe("LLM-provided subagent names", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it.each(["随便看看的小土豆", "Cloud 9", "🦆", "42"])("persists free-form name %s and uses it in the child context", async (name) => {
    const root = createParent();
    const result = await toolRegistry.execute(root.id, "subagent.delegate", {
      name, prompt: "Read files only", specialist,
    });
    expect(result.record.status).toBe("completed");
    const { taskId } = result.toolResult!.result as { taskId: string };
    const child = agentRuntimeStore.getSession(taskId);
    expect(child.sessionMetadata?.subagentName).toBe(name);
    expect(child.sessionMetadata?.roleName).toBe("Reviewer");
    expect(child.prompt).toContain(`You are ${name}.`);
    closeDb();
    expect(agentRuntimeStore.getSession(taskId).sessionMetadata?.subagentName).toBe(name);
  });

  it("uses the same naming contract for builtin profiles", async () => {
    const root = createParent();
    const result = await toolRegistry.execute(root.id, "subagent.delegate", {
      name: "  路过的云 ☁️  ", prompt: "Read files only", profileId: "explorer",
    });
    expect(result.record.status).toBe("completed");
    const { taskId } = result.toolResult!.result as { taskId: string };
    const child = agentRuntimeStore.getSession(taskId);
    expect(child.sessionMetadata).toMatchObject({ subagentName: "路过的云 ☁️", roleName: "探索员" });
    expect(child.prompt).toContain("You are 路过的云 ☁️.");
  });

  it("allows repeated names in simultaneous delegates without reserving them", async () => {
    const root = createParent();
    const results = await Promise.all([0, 1, 2].map(() =>
      toolRegistry.execute(root.id, "subagent.delegate", {
        name: "同一只鸭 🦆", prompt: "Read files only", specialist,
      }),
    ));
    for (const result of results) {
      expect(result.record.status).toBe("completed");
      const { taskId } = result.toolResult!.result as { taskId: string };
      expect(agentRuntimeStore.getSession(taskId).sessionMetadata?.subagentName).toBe("同一只鸭 🦆");
    }
    expect(agentRuntimeStore.getSession(root.id).sessionMetadata?.subagentNamesUsed).toBeUndefined();
  });

  it.each([undefined, "", " \n\t "])("rejects missing or blank name %j before creating a child", async (name) => {
    const root = createParent();
    const result = await toolRegistry.execute(root.id, "subagent.delegate", {
      ...(name === undefined ? {} : { name }), prompt: "Read files only", specialist,
    });
    expect(result.record.status).toBe("failed");
    expect(agentRuntimeStore.getSession(root.id).childSessionIds).toEqual([]);
  });
});
