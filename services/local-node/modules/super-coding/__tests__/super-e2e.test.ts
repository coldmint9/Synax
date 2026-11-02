import { beforeEach, describe, expect, it } from "vitest";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "../../agent-runtime/__tests__/agent-runtime-fixtures.js";
import { synaxAgent } from "../../agent-runtime/synax/synax-agent.js";
import { runtimeBus, type RuntimeBusEvent } from "../../agent-runtime/runtime-bus.js";
import { agentSessionRuntime } from "../../agent-runtime/session-runtime.js";
import { getSuperCodingService } from "../../../composition/super-coding.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";

async function post(path: string, body: unknown) {
  return agentRuntimeRoutes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("super orchestration end to end", () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
  });

  it("plans a graph, streams it, refuses an unreachable message target, blocks mode switching and refuses premature close", async () => {
    synaxAgent.register();
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      profileId: "synax",
      prompt: "orchestrate a bounded slice",
    });
    const events: RuntimeBusEvent[] = [];
    const unsubscribe = runtimeBus.subscribe((event) => {
      if (event.sessionId === session.id) events.push(event);
    });

    try {
      // 1. The main agent plans; the graph is admitted and persisted.
      const service = getSuperCodingService();
      const planned = await service.plan({
        sessionId: session.id,
        nodes: [
          {
            id: "explore",
            title: "探索 runtime",
            taskType: "explore",
            objective: "列出可复用接口",
            deliverable: "接口清单",
          },
          {
            id: "impl",
            title: "实现领域层",
            taskType: "implement",
            objective: "实现准入与归档",
            deliverable: "纯函数",
            requires: ["explore"],
          },
        ],
      });
      expect(planned.ok).toBe(true);
      expect(planned.graph?.nodes.map((node) => node.id)).toEqual([
        "explore",
        "impl",
      ]);

      // 2. The card's realtime channel received the server-side snapshot.
      expect(events.map((event) => event.type)).toContain("super.snapshot");

      // 3. HTTP snapshot matches what the bus delivered.
      const snapshot = await agentRuntimeRoutes.request(
        `/sessions/${session.id}/super`,
      );
      expect(snapshot.status).toBe(200);
      const snapshotBody = (await snapshot.json()) as {
        graph: {
          rev: number;
          phase: string;
          nodes: Array<{ id: string; status: string }>;
          edges: Array<{ from: string; to: string }>;
        };
      };
      expect(snapshotBody.graph.nodes).toHaveLength(2);
      expect(snapshotBody.graph.edges).toEqual([
        expect.objectContaining({ from: "explore", to: "impl" }),
      ]);

      // 4. A message target outside the graph is refused instead of inventing a
      //    delivery. The queued-node (NOT_STARTED) branch is covered
      //    deterministically in super-service.test.ts, because here the root
      //    node starts for real and its child can settle at any moment.
      const premature = await post(`/sessions/${session.id}/super/commands`, {
        kind: "node.message",
        nodeId: "ghost",
        text: "先看 runtime",
      });
      expect(premature.status).toBe(200);
      expect(await premature.json()).toMatchObject({
        ok: false,
        code: "NODE_NOT_FOUND",
      });

      // 5. Channel history is readable (empty until something is delivered).
      const channel = await agentRuntimeRoutes.request(
        `/sessions/${session.id}/super/channels/explore/messages`,
      );
      expect(channel.status).toBe(200);
      expect(await channel.json()).toEqual({ items: [] });

      const missingChannel = await agentRuntimeRoutes.request(
        `/sessions/${session.id}/super/channels/ghost/messages`,
      );
      expect(missingChannel.status).toBe(404);

      // 6. Switching away from a live orchestration is refused with 409.
      const patch = await agentRuntimeRoutes.request(
        `/sessions/${session.id}/mode`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "chat" }),
        },
      );
      expect(patch.status).toBe(409);

      // 7. Close is a finalization barrier: it must not archive or skip work
      //    that is still running or queued.
      const closed = await post(`/sessions/${session.id}/super/commands`, {
        kind: "graph.close",
      });
      expect(closed.status).toBe(200);
      const closedBody = (await closed.json()) as {
        ok: boolean;
        code?: string;
        graph: {
          verifyNodeId: string | null;
          nodes: Array<{ id: string; status: string }>;
        };
      };
      expect(closedBody).toMatchObject({ ok: false, code: "WORK_PENDING" });
      expect(closedBody.graph.verifyNodeId).toBeNull();
      expect(closedBody.graph.nodes.some((node) => node.status === "queued")).toBe(true);

      // 8. Repeating the premature close is still rejected and cannot create
      //    a verification node as a side effect.
      const closedAgain = await post(
        `/sessions/${session.id}/super/commands`,
        { kind: "graph.close" },
      );
      const againBody = (await closedAgain.json()) as {
        ok: boolean;
        code?: string;
        graph: { verifyNodeId: string | null };
      };
      expect(againBody).toMatchObject({ ok: false, code: "WORK_PENDING" });
      expect(againBody.graph.verifyNodeId).toBeNull();

      // 9. Stop settles the graph without inventing a new phase.
      const stopped = await post(`/sessions/${session.id}/super/commands`, {
        kind: "graph.stop",
      });
      expect(stopped.status).toBe(200);
      const stoppedBody = (await stopped.json()) as {
        ok: boolean;
        graph: { phase: string };
      };
      expect(stoppedBody.ok).toBe(true);
      expect(stoppedBody.graph.phase).toBe("stopped");
    } finally {
      unsubscribe();
    }
  });
});
