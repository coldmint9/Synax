import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { explorerSessionInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { closeDb } from "../../../db/index.js";
import { toolRegistry } from "../tool-registry.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";

const names = ["林墨", "许澄", "乔安"];

describe("subagent name reservations", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("reserves names globally for a root session and persists the history", () => {
    const root = agentSessionRuntime.create(explorerSessionInput);
    const first = agentRuntimeStore.allocateSubagentName(root.id, names);
    const second = agentRuntimeStore.allocateSubagentName(root.id, names);

    expect(first).toBe("林墨");
    expect(second).toBe("许澄");
    expect(agentRuntimeStore.getSession(root.id).sessionMetadata).toMatchObject({
      subagentNamesUsed: ["林墨", "许澄"],
    });
  });

  it("shares the reservation across nested delegates", () => {
    const root = agentSessionRuntime.create(explorerSessionInput);
    const child = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: root.id,
      sessionMetadata: { subagentName: "顾言" },
    });

    const allocated = [root.id, child.id].map((id) =>
      agentRuntimeStore.allocateSubagentName(id, names),
    );

    expect(new Set(allocated).size).toBe(2);
    expect(allocated).toEqual(["林墨", "许澄"]);
  });

  it("assigns different persisted names through simultaneous tool calls", async () => {
    ensureSynaxAgentRegistered();
    const root = agentSessionRuntime.create({ ...explorerSessionInput, profileId: "synax" });
    const results = await Promise.all([0, 1, 2].map(() =>
      toolRegistry.execute(root.id, "subagent.delegate", {
        prompt: "Read files only",
        specialist: { name: "Expert", role: "Reviewer", instructions: "Read files", capabilities: ["file.read"] },
      }),
    ));
    for (const result of results) expect(result.record.status).toBe("completed");
    const allocated = results.map((result) => {
      const { taskId } = result.toolResult!.result as { taskId: string };
      const child = agentRuntimeStore.getSession(taskId);
      expect(child.prompt).toContain(`You are ${child.sessionMetadata?.subagentName}.`);
      return child.sessionMetadata?.subagentName;
    });
    expect(new Set(allocated).size).toBe(3);
  });

  it("does not reuse names after deletion, archive, or reopening the database", () => {
    const root = agentSessionRuntime.create(explorerSessionInput);
    const name = agentRuntimeStore.allocateSubagentName(root.id, names);
    const child = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: root.id, sessionMetadata: { subagentName: name } });
    agentRuntimeStore.deleteSessionTree(child.id);
    agentRuntimeStore.archiveSessionTree(root.id);
    agentRuntimeStore.restoreArchivedBatch(root.id);
    closeDb();
    expect(agentRuntimeStore.allocateSubagentName(root.id, names)).toBe("许澄");
  });

  it("reserves existing names, including archived children and legacy visible names", () => {
    const root = agentSessionRuntime.create(explorerSessionInput);
    const archived = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: root.id, sessionMetadata: { subagentName: "林墨" } });
    agentRuntimeStore.archiveSessionTree(archived.id);
    expect(agentRuntimeStore.allocateSubagentName(root.id, names)).toBe("许澄");
    const legacy = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: root.id });
    const fallback = ["林墨", "许澄", "乔安", "沈砚", "顾言", "周宁"];
    const visibleName = fallback[Array.from(legacy.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % fallback.length];
    expect(agentRuntimeStore.allocateSubagentName(root.id, [visibleName, "江屿"])).toBe("江屿");
  });

  it("fails instead of reusing a name when the candidate pool is exhausted", () => {
    const root = agentSessionRuntime.create(explorerSessionInput);
    agentRuntimeStore.allocateSubagentName(root.id, names);
    agentRuntimeStore.allocateSubagentName(root.id, names);
    agentRuntimeStore.allocateSubagentName(root.id, names);

    expect(() => agentRuntimeStore.allocateSubagentName(root.id, names)).toThrow(
      "No unused subagent name remains",
    );
  });
});
