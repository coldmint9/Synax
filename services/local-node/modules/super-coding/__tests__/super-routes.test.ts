import { beforeEach, describe, expect, it } from "vitest";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "../../agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../../agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../agent-runtime/session-store.js";
import { synaxAgent } from "../../agent-runtime/synax/synax-agent.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";

async function post(path: string, body: unknown) {
  return agentRuntimeRoutes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("super orchestration routes", () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
  });

  it("returns a null graph for a session without orchestration", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const response = await agentRuntimeRoutes.request(
      `/sessions/${session.id}/super`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ graph: null });
  });

  it("rejects unknown commands instead of guessing", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const response = await post(`/sessions/${session.id}/super/commands`, {
      kind: "graph.explode",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a message without text", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const response = await post(`/sessions/${session.id}/super/commands`, {
      kind: "node.message",
      nodeId: "impl",
    });
    expect(response.status).toBe(400);
  });

  it("reports NO_GRAPH when closing a session that never planned", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const response = await post(`/sessions/${session.id}/super/commands`, {
      kind: "graph.close",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "NO_GRAPH",
    });
  });

  it("persists super when an idle primary session switches mode", async () => {
    synaxAgent.register();
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      profileId: "synax",
    });
    // A fresh fixture session starts as running; settle it before switching.
    agentRuntimeStore.updateSession(session.id, {
      status: "completed",
      activeRunId: null,
    });
    const response = await agentRuntimeRoutes.request(
      `/sessions/${session.id}/mode`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "super" }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { sessionMetadata?: { mode?: string } };
    };
    expect(body.session.sessionMetadata?.mode).toBe("super");
  });
});
