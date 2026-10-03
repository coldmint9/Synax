import { beforeEach, describe, expect, it } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { agentRuntimeStore } from "../../../modules/agent-runtime/session-store.js";
import { resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";

beforeEach(resetAgentRuntimeFixtures);

describe("session pin route", () => {
  it("validates requests and preserves session metadata and activity dates", async () => {
    agentRuntimeStore.createSession({
      id: "pin-test",
      projectId: "p1",
      parentSessionId: null,
      childSessionIds: [],
      nodeId: null,
      profileId: "explorer",
      status: "completed",
      title: null,
      prompt: "Test",
      contextSnapshotId: null,
      thinkingMode: "standard",
      permissionRules: [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      completedAt: null,
      resultSummary: null,
      blockedReason: null,
      skillIds: [],
      mcpServerIds: [],
      activeRunId: null,
      pendingResumeToken: null,
      sessionMetadata: { mode: "chat" },
    });
    const pin = (id: string, body: unknown) =>
      agentRuntimeRoutes.request(`/sessions/${id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      {},
      { pinned: "true" },
      { pinned: true, mode: "goal" },
    ]) {
      expect((await pin("pin-test", body)).status).toBe(400);
    }
    expect((await pin("missing", { pinned: true })).status).toBe(404);
    for (const pinned of [true, false]) {
      const response = await pin("pin-test", { pinned });
      expect(response.status).toBe(200);
      const { session } = await response.json();
      expect(session.sessionMetadata).toEqual({ mode: "chat", pinned });
      expect(session.updatedAt).toBe("2026-01-01");
      expect(
        agentRuntimeStore.getSession("pin-test").sessionMetadata?.pinned,
      ).toBe(pinned);
    }
  });
});
