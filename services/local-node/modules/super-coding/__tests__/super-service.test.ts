import { describe, expect, it } from "vitest";
import {
  SUPER_MAX_BRIEF_CHARS,
  SUPER_MAX_MESSAGE_CHARS,
  SUPER_MAX_MESSAGES_PER_NODE,
  createEmptySuperGraph,
  type SuperGraph,
  type SuperNode,
} from "../../../../../packages/contracts/super-coding.js";
import {
  SUPER_MAX_SUMMARY_CHARS,
  SuperGraphConflictError,
  buildNodeBrief,
  createSuperService,
  type NewSuperNodeInput,
  type SuperServiceDeps,
} from "../super-service.js";

const SESSION = "session-1";
const START = Date.UTC(2026, 9, 29, 0, 0, 0);

function node(id: string, overrides: Partial<SuperNode> = {}): SuperNode {
  return {
    id,
    title: `Task ${id}`,
    taskType: "implement",
    objective: `Objective ${id}`,
    deliverable: `Deliverable ${id}`,
    acceptance: [],
    scope: [],
    status: "queued",
    depth: 0,
    model: "model:implement",
    effort: "high",
    childSessionId: null,
    messages: 0,
    summary: null,
    error: null,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...overrides,
  };
}

function seededGraph(overrides: Partial<SuperGraph> = {}): SuperGraph {
  return {
    ...createEmptySuperGraph({
      sessionId: SESSION,
      now: new Date(START).toISOString(),
    }),
    ...overrides,
  };
}

function nodeInput(
  id: string,
  overrides: Partial<NewSuperNodeInput> = {},
): NewSuperNodeInput {
  return {
    id,
    title: `Task ${id}`,
    taskType: "implement",
    objective: `Objective ${id}`,
    deliverable: `Deliverable ${id}`,
    acceptance: [`acceptance ${id}`],
    scope: ["services/local-node"],
    ...overrides,
  };
}

function fakeDeps(initial: SuperGraph | null = null) {
  let stored = initial ? structuredClone(initial) : null;
  let tick = 0;
  const writes: SuperGraph[] = [];
  const published: Array<{ kind: "snapshot" | "nodes"; rev: number }> = [];
  const started: Array<{ node: SuperNode; brief: string }> = [];
  const delivered: Array<{ childSessionId: string; text: string }> = [];
  const stopped: string[] = [];
  const woken: Array<{ parentSessionId: string; childSessionId: string; status: string; summary?: string | null }> = [];
  const deps: SuperServiceDeps = {
    async readGraph() {
      return stored ? structuredClone(stored) : null;
    },
    async writeGraph(graph, expectedRev) {
      if ((stored?.rev ?? -1) !== expectedRev)
        throw new SuperGraphConflictError(SESSION, expectedRev, stored?.rev ?? null);
      stored = structuredClone(graph);
      writes.push(structuredClone(graph));
    },
    publish(kind, graph) {
      published.push({ kind, rev: graph.rev });
    },
    async startChild({ node: target, brief }) {
      started.push({ node: target, brief });
      return { childSessionId: `child-${target.id}` };
    },
    async deliverToChild(input) {
      delivered.push(input);
      return "queued";
    },
    async stopChild(childSessionId) {
      stopped.push(childSessionId);
    },
    async wakeParent(input) {
      woken.push(input);
    },
    modelFor(taskType) {
      return `model:${taskType}`;
    },
    effortFor() {
      return "high";
    },
    now() {
      tick += 1;
      return new Date(START + tick * 1_000).toISOString();
    },
  };
  return {
    deps,
    writes,
    published,
    started,
    delivered,
    stopped,
    woken,
    graph: () => (stored ? structuredClone(stored) : null),
    seed: (graph: SuperGraph) => {
      stored = structuredClone(graph);
    },
  };
}

describe("plan", () => {
  it.each(["stopped", "done"] as const)(
    "refuses to add nodes to a %s graph instead of leaving them queued",
    async (phase) => {
      const initial = seededGraph({ phase, nodes: [node("finished", { status: "completed" })] });
      const fake = fakeDeps(initial);
      const service = createSuperService(fake.deps);

      const result = await service.plan({
        sessionId: SESSION,
        nodes: [nodeInput("new-work")],
      });

      expect(result).toMatchObject({ ok: false, code: "GRAPH_TERMINAL", graph: initial });
      expect(fake.graph()).toEqual(initial);
      expect(fake.writes).toHaveLength(0);
      expect(fake.started).toHaveLength(0);
    },
  );

  it("admits nodes, links dependencies and writes once", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);

    const result = await service.plan({
      sessionId: SESSION,
      nodes: [
        nodeInput("a", { taskType: "explore" }),
        nodeInput("b", { requires: ["a"] }),
      ],
    });

    expect(result.ok).toBe(true);
    const graph = result.graph as SuperGraph;
    expect(graph.nodes.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(graph.nodes[0]?.model).toBe("model:explore");
    expect(graph.nodes[1]?.depth).toBe(1);
    expect(graph.edges).toEqual([
      { id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 },
    ]);
    // Creation writes the graph, then starts the runnable node.
    expect(fake.writes.length).toBeGreaterThanOrEqual(1);
    expect(fake.published[0]?.kind).toBe("snapshot");
    expect(fake.graph()?.rev).toBeGreaterThanOrEqual(graph.rev);
    expect(fake.started[0]?.node.id).toBe("a");
  });

  it("rejects a duplicate id and never writes the rejected node", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({ sessionId: SESSION, nodes: [nodeInput("a")] });

    const duplicate = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b")],
    });

    const writesBefore = fake.writes.length;
    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe("DUP_ID");
    expect(duplicate.graph?.nodes.map((entry) => entry.id)).toEqual(["a"]);
    expect(fake.graph()?.nodes.map((entry) => entry.id)).toEqual(["a"]);
    expect(fake.writes).toHaveLength(writesBefore);
  });

  it("stops at the budget but keeps the accepted prefix", async () => {
    const fake = fakeDeps(
      seededGraph({
        maxNodes: 4,
        rev: 7,
        nodes: [node("a"), node("b")],
      }),
    );
    const service = createSuperService(fake.deps);

    const result = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("c"), nodeInput("d")],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("BUDGET");
    expect(fake.graph()?.nodes.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("frees the slot of a failed child so a replacement can be planned", async () => {
    const fake = fakeDeps(
      seededGraph({
        maxNodes: 4,
        rev: 2,
        nodes: [
          node("a", { status: "running", childSessionId: "child-a" }),
          node("b", { status: "running", childSessionId: "child-b" }),
          node("c", { status: "running", childSessionId: "child-c" }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const blocked = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("d")],
    });
    expect(blocked.code).toBe("BUDGET");

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-c",
      status: "failed",
    });

    // The failure record survives, but the slot came back without super.close.
    expect(fake.graph()?.nodes.find((entry) => entry.id === "c")).toMatchObject({
      status: "failed",
      error: "Child session ended as failed.",
    });
    const replacement = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("d")],
    });
    expect(replacement.ok).toBe(true);
    expect(fake.graph()?.nodes.map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("rejects a dangling requirement instead of writing a broken edge", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);

    const result = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b", { requires: ["a", "ghost"] })],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("NO_PARENT");
    expect(fake.graph()?.nodes.map((entry) => entry.id)).toEqual(["a"]);
    expect(fake.graph()?.edges).toEqual([]);
  });
});

describe("start", () => {
  it.each(["stopped", "done"] as const)(
    "refuses to start queued work in a %s graph",
    async (phase) => {
      const initial = seededGraph({ phase, nodes: [node("a")] });
      const fake = fakeDeps(initial);
      const service = createSuperService(fake.deps);

      const result = await service.start({ sessionId: SESSION, nodeId: "a" });

      expect(result).toMatchObject({ ok: false, code: "GRAPH_TERMINAL" });
      expect(fake.graph()).toEqual(initial);
      expect(fake.started).toHaveLength(0);
      expect(fake.writes).toHaveLength(0);
    },
  );

  it("requires a queued node whose dependencies completed", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b", { requires: ["a"] })],
    });

    const blocked = await service.start({ sessionId: SESSION, nodeId: "b" });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("DEPS_PENDING");

    const unknown = await service.start({ sessionId: SESSION, nodeId: "ghost" });
    expect(unknown.code).toBe("NODE_NOT_FOUND");

    // Planning already started the runnable node, so a manual start is refused.
    const already = await service.start({ sessionId: SESSION, nodeId: "a" });
    expect(already.code).toBe("NOT_QUEUED");
    expect(fake.graph()?.phase).toBe("running");
    expect(fake.graph()?.nodes[0]).toMatchObject({
      status: "running",
      childSessionId: "child-a",
    });
    expect(fake.started[0]?.brief).toContain("Objective: Objective a");
    expect(fake.started[0]?.brief).toContain("Deliverable: Deliverable a");

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "done",
    });

    // Settlement advances the graph itself: the dependent node starts without
    // another explicit start call.
    expect(fake.graph()?.nodes.find((entry) => entry.id === "b")).toMatchObject({
      status: "running",
      childSessionId: "child-b",
    });

    const again = await service.start({ sessionId: SESSION, nodeId: "a" });
    expect(again.code).toBe("NOT_QUEUED");

    const duplicate = await service.start({ sessionId: SESSION, nodeId: "b" });
    expect(duplicate.code).toBe("NOT_QUEUED");
  });

  it("refuses to exceed maxConcurrent", async () => {
    const fake = fakeDeps(
      seededGraph({
        maxConcurrent: 1,
        nodes: [
          node("a", { status: "running", childSessionId: "child-a" }),
          node("b"),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const result = await service.start({ sessionId: SESSION, nodeId: "b" });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONCURRENCY_LIMIT");
    expect(fake.started).toHaveLength(0);
  });

  it("reclaims a child when its start loses the graph revision race", async () => {
    const fake = fakeDeps(seededGraph({ nodes: [node("a")] }));
    const concurrent = seededGraph({
      rev: 1,
      nodes: [node("a", { title: "Updated by another writer" })],
    });
    const startChild = fake.deps.startChild;
    fake.deps.startChild = async (input) => {
      const started = await startChild(input);
      fake.seed(concurrent);
      return started;
    };
    const service = createSuperService(fake.deps);

    const result = await service.start({ sessionId: SESSION, nodeId: "a" });

    expect(result).toMatchObject({ ok: false, code: "REV_CONFLICT" });
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a"]);
    expect(fake.stopped).toEqual(["child-a"]);
    expect(fake.graph()).toEqual(concurrent);
    expect(fake.writes).toHaveLength(0);
    expect(fake.published).toHaveLength(0);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "uncommitted child",
    });
    expect(fake.graph()).toEqual(concurrent);
    expect(fake.writes).toHaveLength(0);
  });

  it("reclaims a child on a storage failure without misreporting a conflict", async () => {
    const fake = fakeDeps(seededGraph({ nodes: [node("a")] }));
    fake.deps.writeGraph = async () => { throw new Error("storage offline"); };
    const service = createSuperService(fake.deps);

    const result = await service.start({ sessionId: SESSION, nodeId: "a" });

    expect(result).toMatchObject({ ok: false, code: "WRITE_FAILED" });
    expect(result.message).toContain("storage offline");
    expect(fake.stopped).toEqual(["child-a"]);
    expect(fake.published).toHaveLength(0);
    expect(fake.graph()?.nodes[0]?.status).toBe("queued");
  });

  it("reports the uncommitted child id when cleanup cannot stop it", async () => {
    const fake = fakeDeps(seededGraph({ nodes: [node("a")] }));
    fake.deps.writeGraph = async (_graph, rev) => {
      throw new SuperGraphConflictError(SESSION, rev, rev + 1);
    };
    fake.deps.stopChild = async () => { throw new Error("stop unavailable"); };
    const service = createSuperService(fake.deps);

    const result = await service.start({ sessionId: SESSION, nodeId: "a" });

    expect(result).toMatchObject({ ok: false, code: "REV_CONFLICT" });
    expect(result.message).toContain("Cleanup of child child-a failed: stop unavailable");
    expect(fake.published).toHaveLength(0);
  });
});

describe("advance", () => {
  it("starts every runnable node and stops at the dependency frontier", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b", { requires: ["a"] })],
    });

    const advanced = await service.advance(SESSION);

    expect(advanced.ok).toBe(true);
    expect(advanced.graph?.phase).toBe("running");
    expect(advanced.graph?.nodes.map((entry) => entry.status)).toEqual([
      "running",
      "queued",
    ]);
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a"]);
  });

  it("keeps the concurrency budget", async () => {
    const fake = fakeDeps(
      seededGraph({
        maxConcurrent: 1,
        nodes: [node("a"), node("b"), node("c")],
      }),
    );
    const service = createSuperService(fake.deps);

    await service.advance(SESSION);

    expect(fake.started).toHaveLength(1);
    expect(
      fake.graph()?.nodes.filter((entry) => entry.status === "running"),
    ).toHaveLength(1);
  });

  it("keeps starting other runnable nodes when one start fails", async () => {
    const fake = fakeDeps(seededGraph({ nodes: [node("a"), node("b")] }));
    const startChild = fake.deps.startChild;
    fake.deps.startChild = async (input) => {
      if (input.node.id === "a") throw new Error("provider missing");
      return startChild(input);
    };
    const service = createSuperService(fake.deps);

    const result = await service.advance(SESSION);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("START_FAILED");
    expect(fake.graph()?.nodes.find((entry) => entry.id === "a")?.status).toBe(
      "failed",
    );
    expect(fake.graph()?.nodes.find((entry) => entry.id === "b")?.status).toBe(
      "running",
    );
  });

  it("starts the successor when its prerequisite child settles", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b", { requires: ["a"] })],
    });
    await service.advance(SESSION);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "done",
    });

    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a", "b"]);
    expect(fake.graph()?.nodes.find((entry) => entry.id === "b")?.status).toBe(
      "running",
    );
    expect(fake.woken).toEqual([{
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "done",
    }]);
  });

  it("does not auto-close after the last currently planned child settles", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a"), nodeInput("b")],
    });

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "a done",
    });
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-b",
      status: "completed",
      summary: "b done",
    });

    expect(fake.graph()?.verifyNodeId).toBeNull();
    expect(fake.graph()?.phase).toBe("running");
    expect(fake.graph()?.nodes.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a", "b"]);
  });

  it("does not auto-close a persisted settled graph when it is reopened", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [
          node("a", { status: "completed", childSessionId: "child-a" }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const reopened = await service.getGraph(SESSION);

    expect(reopened).toEqual(fake.graph());
    expect(reopened?.verifyNodeId).toBeNull();
    expect(fake.started).toHaveLength(0);
  });

  it("starts the verification node after close", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({ sessionId: SESSION, nodes: [nodeInput("a")] });
    await service.advance(SESSION);
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "shipped",
    });
    await service.close({ sessionId: SESSION });

    const advanced = await service.advance(SESSION);

    expect(
      advanced.graph?.nodes.find((entry) => entry.id === "verify")?.status,
    ).toBe("running");
  });

  it("refuses to close while a required work node is still queued", async () => {
    const initial = seededGraph({
      nodes: [
        node("a", { status: "completed", childSessionId: "child-a" }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    });
    const fake = fakeDeps(initial);
    const service = createSuperService(fake.deps);

    const closed = await service.close({ sessionId: SESSION });

    expect(closed).toMatchObject({ ok: false, code: "WORK_PENDING", graph: initial });
    expect(fake.graph()).toEqual(initial);
    expect(fake.writes).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  it("does not start nodes once the graph is stopped", async () => {
    const fake = fakeDeps(
      seededGraph({ phase: "stopped", nodes: [node("a")] }),
    );
    const service = createSuperService(fake.deps);

    await service.advance(SESSION);

    expect(fake.started).toHaveLength(0);
    expect(fake.graph()?.phase).toBe("stopped");
  });

  it("serializes concurrent advances without revision conflicts", async () => {
    const fake = fakeDeps(
      seededGraph({ nodes: [node("a"), node("b")] }),
    );
    const service = createSuperService(fake.deps);

    const results = await Promise.all([
      service.advance(SESSION),
      service.advance(SESSION),
    ]);

    expect(results.every((entry) => entry.ok)).toBe(true);
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a", "b"]);
  });

  it.each(["queued"] as const)(
    "does not revive a graph stopped between advance and its %s work decision",
    async (status) => {
      const initial = seededGraph({ phase: "running", nodes: [node("a", { status })] });
      const fake = fakeDeps(initial);
      const stopped = { ...initial, phase: "stopped" as const, rev: initial.rev + 1 };
      const readGraph = fake.deps.readGraph;
      let reads = 0;
      fake.deps.readGraph = async (sessionId) => {
        reads += 1;
        // The next read is start() for queued work, close() for settled work.
        if (reads === 2) fake.seed(stopped);
        return readGraph(sessionId);
      };
      const service = createSuperService(fake.deps);

      await service.advance(SESSION);

      expect(fake.graph()).toEqual(stopped);
      expect(fake.started).toHaveLength(0);
      expect(fake.writes).toHaveLength(0);
      expect(fake.published).toHaveLength(0);
    },
  );
});

describe("message", () => {
  it("enforces archived, not-started and limit codes", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [
          node("archived", { status: "archived", childSessionId: "child-arch" }),
          node("queued"),
          node("dead", {
            status: "failed",
            childSessionId: "child-dead",
            error: "child session ended as failed.",
          }),
          node("busy", {
            status: "running",
            childSessionId: "child-busy",
            messages: SUPER_MAX_MESSAGES_PER_NODE,
          }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const archived = await service.message({
      sessionId: SESSION,
      nodeId: "archived",
      from: "main",
      text: "hello",
    });
    expect(archived.code).toBe("ARCHIVED");

    // A failed child is gone: the message would spend the node's budget and
    // never be delivered, so it is refused with the recorded reason.
    const dead = await service.message({
      sessionId: SESSION,
      nodeId: "dead",
      from: "main",
      text: "hello",
    });
    expect(dead.code).toBe("NODE_FAILED");
    expect(dead.message).toContain("child session ended as failed.");

    const notStarted = await service.message({
      sessionId: SESSION,
      nodeId: "queued",
      from: "main",
      text: "hello",
    });
    expect(notStarted.code).toBe("NOT_STARTED");

    const limited = await service.message({
      sessionId: SESSION,
      nodeId: "busy",
      from: "main",
      text: "hello",
    });
    expect(limited.code).toBe("MESSAGE_LIMIT");
    expect(fake.delivered).toHaveLength(0);
  });

  it("truncates the text and counts delivered messages", async () => {
    const fake = fakeDeps(
      seededGraph({
        rev: 3,
        nodes: [
          node("live", {
            status: "running",
            childSessionId: "child-live",
            messages: 2,
          }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const result = await service.message({
      sessionId: SESSION,
      nodeId: "live",
      from: "main",
      text: "x".repeat(SUPER_MAX_MESSAGE_CHARS + 500),
    });

    expect(result.ok).toBe(true);
    expect(fake.delivered[0]?.text).toHaveLength(SUPER_MAX_MESSAGE_CHARS);
    expect(fake.graph()?.nodes[0]?.messages).toBe(3);
    expect(fake.published.at(-1)?.kind).toBe("nodes");
  });

  it("reports a rejected delivery without counting the message", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [node("live", { status: "running", childSessionId: "child-live" })],
      }),
    );
    fake.deps.deliverToChild = async () => {
      throw new Error("queue unavailable");
    };
    const service = createSuperService(fake.deps);

    const result = await service.message({
      sessionId: SESSION,
      nodeId: "live",
      from: "user",
      text: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("MESSAGE_REJECTED");
    expect(fake.graph()?.nodes[0]?.messages).toBe(0);
  });
});

describe("onChildSettled", () => {
  it.each(["waiting_permission", "waiting_input", "paused"] as const)(
    "keeps the graph running while its verification child is %s",
    async (status) => {
      const fake = fakeDeps(seededGraph({
        phase: "running",
        verifyNodeId: "verify",
        nodes: [node("verify", {
          taskType: "verify", status: "running", childSessionId: "child-verify",
        })],
      }));
      const service = createSuperService(fake.deps);

      await service.onChildSettled({
        parentSessionId: SESSION, childSessionId: "child-verify", status,
      });

      expect(fake.graph()?.phase).toBe("running");
      expect(fake.graph()?.nodes[0]).toMatchObject({ status, error: null });
      expect(fake.started).toHaveLength(0);
    },
  );

  it.each(["waiting_permission", "waiting_input", "paused"] as const)(
    "keeps %s children live and occupying their concurrency slot",
    async (status) => {
      const fake = fakeDeps(seededGraph({
        phase: "running",
        maxConcurrent: 1,
        nodes: [
          node("a", { status: "running", childSessionId: "child-a" }),
          node("b"),
        ],
      }));
      const service = createSuperService(fake.deps);

      await service.onChildSettled({
        parentSessionId: SESSION,
        childSessionId: "child-a",
        status,
        summary: "Waiting for the user",
      });

      expect(fake.graph()?.nodes[0]).toMatchObject({
        status,
        summary: "Waiting for the user",
        error: null,
      });
      expect(fake.graph()).toMatchObject({ phase: "running", verifyNodeId: null });
      expect(fake.published).toEqual([{ kind: "nodes", rev: 1 }]);
      expect((await service.start({ sessionId: SESSION, nodeId: "b" })).code)
        .toBe("CONCURRENCY_LIMIT");
      await service.advance(SESSION);
      expect(fake.started).toHaveLength(0);
      expect(fake.graph()?.nodes[1]?.status).toBe("queued");
    },
  );

  it.each(["waiting_permission", "waiting_input", "paused"] as const)(
    "allows a %s child to complete and unblock its successor",
    async (status) => {
      const fake = fakeDeps(seededGraph({
        phase: "running",
        maxConcurrent: 1,
        nodes: [node("a", { status, childSessionId: "child-a" }), node("b")],
        edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
      }));
      const service = createSuperService(fake.deps);

      await service.onChildSettled({
        parentSessionId: SESSION,
        childSessionId: "child-a",
        status: "completed",
        summary: "Resumed and finished",
      });

      expect(fake.graph()?.nodes[0]).toMatchObject({
        status: "completed",
        summary: "Resumed and finished",
        error: null,
      });
      expect(fake.started.map((entry) => entry.node.id)).toEqual(["b"]);
      expect(fake.graph()?.nodes[1]?.status).toBe("running");
    },
  );

  /** The answer the DeepSeek-serving gateway produced on 2026-10-30. */
  const toolCallText = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="agent_execute">
<｜｜DSML｜｜ parameter name="code" string="true">return 1;</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

  it("fails a completed child that only answered with its tool call as text", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: toolCallText,
    });

    expect(fake.graph()?.nodes[0]).toMatchObject({
      status: "failed",
      summary: null,
      error: expect.stringContaining("tool-call text artifact"),
    });
    // Nothing was delivered, so the dependent fails with the graph.
    expect(fake.started).toHaveLength(0);
    expect(fake.graph()?.nodes[1]).toMatchObject({ status: "failed" });
    expect(fake.graph()?.phase).toBe("failed");
  });

  it("fails the graph when verification answers with such a tool call", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      verifyNodeId: "verify",
      nodes: [
        node("verify", {
          taskType: "verify",
          status: "running",
          childSessionId: "child-verify",
        }),
      ],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-verify",
      status: "completed",
      summary: toolCallText,
    });

    expect(fake.graph()?.phase).toBe("failed");
    expect(fake.graph()?.nodes[0]).toMatchObject({ status: "failed" });
  });

  it("cascades one failure to every queued dependent and ends the graph", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("b"),
        node("c"),
        node("d", { status: "running", childSessionId: "child-d" }),
      ],
      edges: [
        { id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 },
        { id: "dep:b->c", from: "b", to: "c", kind: "dependency", count: 1 },
      ],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "failed",
      summary: null,
    });

    const graph = fake.graph()!;
    expect(graph.phase).toBe("failed");
    expect(graph.phaseError).toContain("Node a failed");
    expect(graph.nodes.find((entry) => entry.id === "b")).toMatchObject({
      status: "failed",
      error: "Upstream node a failed.",
    });
    // Transitively dependent nodes fail too, not just direct children.
    expect(graph.nodes.find((entry) => entry.id === "c")).toMatchObject({
      status: "failed",
      error: "Upstream node a failed.",
    });
    // Unrelated live work keeps its own status.
    expect(graph.nodes.find((entry) => entry.id === "d")).toMatchObject({
      status: "running",
    });
    expect(fake.started).toHaveLength(0);
    // Nothing can advance a failed graph.
    await service.advance(SESSION);
    expect(fake.started).toHaveLength(0);
  });

  it("refuses to start, close or message a failed graph", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "failed",
      phaseError: "Node a failed: boom",
      nodes: [
        node("a", { status: "failed", error: "boom" }),
        node("b", { childSessionId: "child-b" }),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const service = createSuperService(fake.deps);

    expect((await service.start({ sessionId: SESSION, nodeId: "b" })).code).toBe(
      "GRAPH_TERMINAL",
    );
    expect((await service.message({
      sessionId: SESSION,
      nodeId: "b",
      from: "main",
      text: "keep going",
    })).code).toBe("GRAPH_TERMINAL");
    const closed = await service.close({ sessionId: SESSION });
    expect(closed.ok).toBe(true);
    // A failed graph is terminal: close archives nothing and adds no verifier.
    expect(fake.graph()?.verifyNodeId).toBeNull();
    expect(fake.started).toHaveLength(0);
  });

  it("does not report done when verification finishes after the graph failed", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      verifyNodeId: "verify",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("verify", {
          taskType: "verify",
          status: "running",
          childSessionId: "child-verify",
        }),
      ],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "failed",
    });
    expect(fake.graph()?.phase).toBe("failed");

    // The verification child was already running; its late success is recorded
    // but must not overwrite the failure with "done".
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-verify",
      status: "completed",
      summary: "All checks passed",
    });
    expect(fake.graph()?.phase).toBe("failed");
    expect(fake.graph()?.nodes.find((entry) => entry.id === "verify")).toMatchObject({
      status: "completed",
    });
  });

  it("reopens a failed graph when replacement work is planned", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "failed",
      phaseError: "Node a failed: boom",
      nodes: [node("a", { status: "failed", error: "boom" })],
    }));
    const service = createSuperService(fake.deps);

    const replanned = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("b")],
    });

    expect(replanned.ok).toBe(true);
    expect(fake.graph()?.phase).toBe("running");
    expect(fake.graph()?.phaseError).toBeNull();
    expect(fake.graph()?.nodes.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("retries a transient provider failure once instead of failing the graph", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "failed",
      summary: "HttpError: Http client error: error decoding response body",
    });

    const graph = fake.graph()!;
    expect(graph.phase).toBe("running");
    expect(graph.nodes.find((entry) => entry.id === "a")).toMatchObject({
      status: "running",
      retries: 1,
      error: null,
    });
    expect(graph.nodes.find((entry) => entry.id === "a")?.lastError).toContain(
      "error decoding response body",
    );
    // The dependent is untouched: nothing cascaded.
    expect(graph.nodes.find((entry) => entry.id === "b")?.status).toBe("queued");
    // The retry was started automatically.
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a"]);
    // The parent is not woken for a retry it did not have to decide.
    expect(fake.woken).toHaveLength(0);
  });

  it("fails the graph when the retry cannot even start its child", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    fake.deps.startChild = async () => {
      throw new Error("worker pool is saturated");
    };
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "failed",
      summary: "HttpError: Http client error: error decoding response body",
    });

    const graph = fake.graph()!;
    expect(graph.phase).toBe("failed");
    expect(graph.nodes.find((entry) => entry.id === "a")?.status).toBe("failed");
    expect(graph.nodes.find((entry) => entry.id === "b")?.status).toBe("failed");
    // The parent is told once the retry could not run.
    expect(fake.woken.at(-1)).toMatchObject({ status: "failed" });
  });

  it("fails the graph when the single retry fails too", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [
        node("a", { status: "running", childSessionId: "child-a", retries: 1 }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "failed",
      summary: "HttpError: Http client error: error decoding response body",
    });

    const graph = fake.graph()!;
    expect(graph.phase).toBe("failed");
    expect(graph.nodes.find((entry) => entry.id === "a")).toMatchObject({
      status: "failed",
      retries: 1,
    });
    expect(graph.nodes.find((entry) => entry.id === "b")).toMatchObject({
      status: "failed",
      error: "Upstream node a failed.",
    });
    expect(fake.started).toHaveLength(0);
  });

  it("revives a failed node together with the dependents its failure cascaded", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "failed",
      phaseError: "Node a failed: Child session ended as failed.",
      nodes: [
        node("a", { status: "failed", error: "Child session ended as failed." }),
        node("b", { status: "failed", error: "Upstream node a failed." }),
        node("c", { status: "failed", error: "Upstream node a failed." }),
        node("done", { status: "completed", summary: "already delivered" }),
      ],
      edges: [
        { id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 },
        { id: "dep:b->c", from: "b", to: "c", kind: "dependency", count: 1 },
      ],
    }));
    const service = createSuperService(fake.deps);

    const revived = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("a")],
    });

    expect(revived.ok).toBe(true);
    const graph = fake.graph()!;
    expect(graph.phase).toBe("running");
    expect(graph.phaseError).toBeNull();
    // The revived node runs again; its cascade victims are queued behind it.
    expect(graph.nodes.find((entry) => entry.id === "a")?.status).toBe("running");
    expect(graph.nodes.find((entry) => entry.id === "a")?.retries).toBeUndefined();
    expect(graph.nodes.find((entry) => entry.id === "b")?.status).toBe("queued");
    expect(graph.nodes.find((entry) => entry.id === "c")?.status).toBe("queued");
    // Completed work and the original dependency edges survive the revival.
    expect(graph.nodes.find((entry) => entry.id === "done")?.status).toBe("completed");
    expect(graph.edges).toHaveLength(2);
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["a"]);
  });

  it("refuses to revive a node whose dependency has not completed", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "failed",
      nodes: [
        node("a", { status: "failed", error: "boom" }),
        node("b", { status: "failed", error: "Upstream node a failed." }),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const service = createSuperService(fake.deps);

    const revived = await service.plan({
      sessionId: SESSION,
      nodes: [nodeInput("b")],
    });

    expect(revived.ok).toBe(false);
    expect(revived.code).toBe("DEPS_PENDING");
    expect(fake.graph()?.nodes.find((entry) => entry.id === "b")?.status).toBe(
      "failed",
    );
  });

  it.each(["completed", "failed", "archived"] as const)(
    "never changes a %s node in response to a duplicate or late callback",
    async (status) => {
      const initial = seededGraph({
        phase: "running",
        rev: 7,
        nodes: [
          node("a", {
            status,
            childSessionId: "child-a",
            summary: "Original result",
            error: status === "failed" ? "Original failure" : null,
          }),
          node("b", { status: "running", childSessionId: "child-b" }),
        ],
      });
      const fake = fakeDeps(initial);
      const service = createSuperService(fake.deps);

      for (const lateStatus of ["completed", "failed", "cancelled", "waiting_permission", "waiting_input", "paused"]) {
        await service.onChildSettled({
          parentSessionId: SESSION,
          childSessionId: "child-a",
          status: lateStatus,
          summary: "Late result",
        });
      }

      expect(fake.graph()).toEqual(initial);
      expect(fake.writes).toHaveLength(0);
      expect(fake.published).toHaveLength(0);
      expect(fake.started).toHaveLength(0);
    },
  );

  it("retries a revision conflict against the fresh graph and preserves concurrent edits", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      maxConcurrent: 1,
      nodes: [
        node("a", { status: "running", childSessionId: "child-a" }),
        node("b"),
      ],
      edges: [{ id: "dep:a->b", from: "a", to: "b", kind: "dependency", count: 1 }],
    }));
    const writeGraph = fake.deps.writeGraph;
    let attempts = 0;
    fake.deps.writeGraph = async (graph, rev) => {
      attempts += 1;
      if (attempts === 1) {
        const current = fake.graph()!;
        fake.seed({
          ...current,
          rev: current.rev + 1,
          nodes: current.nodes.map((entry) => entry.id === "a"
            ? { ...entry, messages: 1, title: "Concurrent edit" }
            : entry),
        });
      }
      await writeGraph(graph, rev);
    };
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "done",
    });

    expect(fake.graph()?.nodes[0]).toMatchObject({
      status: "completed", messages: 1, title: "Concurrent edit", summary: "done",
    });
    expect(fake.started.map((entry) => entry.node.id)).toEqual(["b"]);
    expect(fake.writes.map((graph) => graph.rev)).toEqual([2, 3]);
    expect(fake.published).toEqual([
      { kind: "nodes", rev: 2 },
      { kind: "nodes", rev: 3 },
    ]);
  });

  it.each(["completed", "failed", "archived"] as const)(
    "honors a concurrent %s settlement instead of overwriting it on retry",
    async (status) => {
      const fake = fakeDeps(seededGraph({
        phase: "running",
        nodes: [node("a", { status: "running", childSessionId: "child-a" })],
      }));
      const winner = seededGraph({
        phase: "running",
        rev: 1,
        nodes: [node("a", { status, childSessionId: "child-a", summary: "Winning result" })],
      });
      const writeGraph = fake.deps.writeGraph;
      let attempts = 0;
      fake.deps.writeGraph = async (graph, rev) => {
        attempts += 1;
        fake.seed(winner);
        await writeGraph(graph, rev);
      };
      const service = createSuperService(fake.deps);

      await service.onChildSettled({
        parentSessionId: SESSION,
        childSessionId: "child-a",
        status: status === "completed" ? "failed" : "completed",
        summary: "Losing result",
      });

      expect(attempts).toBe(1);
      expect(fake.graph()).toEqual(winner);
      expect(fake.writes).toHaveLength(0);
      expect(fake.published).toHaveLength(0);
      expect(fake.started).toHaveLength(0);
    },
  );

  it.each(["stopped", "done"] as const)(
    "honors a concurrent %s graph instead of reviving it on retry",
    async (phase) => {
      const initial = seededGraph({
        phase: "running",
        nodes: [node("a", { status: "running", childSessionId: "child-a" })],
      });
      const fake = fakeDeps(initial);
      const winner = { ...initial, phase, rev: initial.rev + 1 };
      const writeGraph = fake.deps.writeGraph;
      fake.deps.writeGraph = async (graph, rev) => {
        fake.seed(winner);
        await writeGraph(graph, rev);
      };
      const service = createSuperService(fake.deps);

      await service.onChildSettled({
        parentSessionId: SESSION,
        childSessionId: "child-a",
        status: "completed",
      });

      expect(fake.graph()).toEqual(winner);
      expect(fake.writes).toHaveLength(0);
      expect(fake.published).toHaveLength(0);
      expect(fake.started).toHaveLength(0);
    },
  );

  it("surfaces exhausted revision retries without publishing or advancing", async () => {
    const fake = fakeDeps(seededGraph({
      phase: "running",
      nodes: [node("a", { status: "running", childSessionId: "child-a" })],
    }));
    const writeGraph = fake.deps.writeGraph;
    let attempts = 0;
    fake.deps.writeGraph = async (graph, rev) => {
      attempts += 1;
      const current = fake.graph()!;
      fake.seed({ ...current, rev: current.rev + 1 });
      await writeGraph(graph, rev);
    };
    const service = createSuperService(fake.deps);

    await expect(service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
    })).rejects.toThrow("changed while writing");

    expect(attempts).toBe(3);
    expect(fake.graph()?.nodes[0]?.status).toBe("running");
    expect(fake.writes).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  it("ignores an old child's settlement if a concurrent writer changed the child binding", async () => {
    const initial = seededGraph({
      phase: "running",
      nodes: [node("a", { status: "running", childSessionId: "child-a" })],
    });
    const fake = fakeDeps(initial);
    const winner = {
      ...initial,
      rev: initial.rev + 1,
      nodes: [node("a", { status: "running", childSessionId: "replacement-child" })],
    };
    const writeGraph = fake.deps.writeGraph;
    fake.deps.writeGraph = async (graph, rev) => {
      fake.seed(winner);
      await writeGraph(graph, rev);
    };
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION, childSessionId: "child-a", status: "completed",
    });

    expect(fake.graph()).toEqual(winner);
    expect(fake.writes).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  it("surfaces storage errors without treating them as revision conflicts", async () => {
    const fake = fakeDeps(seededGraph({
      nodes: [node("a", { status: "running", childSessionId: "child-a" })],
    }));
    let attempts = 0;
    fake.deps.writeGraph = async () => {
      attempts += 1;
      throw new Error("storage offline");
    };
    const service = createSuperService(fake.deps);

    await expect(service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
    })).rejects.toThrow("Could not write the super graph: storage offline");

    expect(attempts).toBe(1);
    expect(fake.graph()?.nodes[0]?.status).toBe("running");
    expect(fake.published).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  it("maps completed and failed children onto their nodes", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [
          node("a", { status: "running", childSessionId: "child-a" }),
          node("b", { status: "running", childSessionId: "child-b" }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "s".repeat(SUPER_MAX_SUMMARY_CHARS + 100),
    });
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-b",
      status: "cancelled",
      summary: "stopped",
    });

    const graph = fake.graph() as SuperGraph;
    expect(graph.nodes[0]).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(graph.nodes[0]?.summary).toHaveLength(SUPER_MAX_SUMMARY_CHARS);
    expect(graph.nodes[1]?.status).toBe("failed");
    expect(graph.nodes[1]?.error).toContain("cancelled");

    const writes = fake.writes.length;
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-unknown",
      status: "completed",
    });
    expect(fake.writes).toHaveLength(writes);
  });

  it("finishes the graph once the verification node completed", async () => {
    const fake = fakeDeps(
      seededGraph({
        verifyNodeId: "verify",
        nodes: [
          node("verify", {
            taskType: "verify",
            status: "running",
            childSessionId: "child-verify",
          }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-verify",
      status: "completed",
      summary: "verified",
    });

    expect(fake.graph()?.phase).toBe("done");
  });

  it("settles a blocked child as failed instead of leaving it running", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [node("a", { status: "running", childSessionId: "child-a" })],
      }),
    );
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "blocked",
      summary: "permission required",
    });

    expect(fake.graph()?.nodes[0]).toMatchObject({
      status: "failed",
      error: "Child session ended as blocked.",
      summary: "permission required",
    });
  });

  it("ignores a late child callback after the graph is stopped", async () => {
    const fake = fakeDeps(
      seededGraph({
        phase: "stopped",
        nodes: [node("a", { status: "failed", childSessionId: "child-a" })],
      }),
    );
    const service = createSuperService(fake.deps);

    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "late success",
    });

    expect(fake.graph()?.phase).toBe("stopped");
    expect(fake.graph()?.nodes[0]?.status).toBe("failed");
  });
});

describe("close", () => {
  it.each(["stopped", "done"] as const)(
    "does not restart verification in a %s graph",
    async (phase) => {
      const initial = seededGraph({ phase, nodes: [node("a", { status: "completed" })] });
      const fake = fakeDeps(initial);
      const service = createSuperService(fake.deps);

      const result = await service.close({ sessionId: SESSION });

      expect(result).toEqual({ ok: true, graph: initial });
      expect(fake.graph()).toEqual(initial);
      expect(fake.writes).toHaveLength(0);
      expect(fake.started).toHaveLength(0);
    },
  );

  it("archives finished nodes, keeps one verify node and reports done", async () => {
    const fake = fakeDeps();
    const service = createSuperService(fake.deps);
    await service.plan({ sessionId: SESSION, nodes: [nodeInput("a")] });
    await service.start({ sessionId: SESSION, nodeId: "a" });
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-a",
      status: "completed",
      summary: "shipped",
    });

    const closed = await service.close({ sessionId: SESSION });
    const graph = closed.graph as SuperGraph;
    expect(closed.ok).toBe(true);
    expect(graph.verifyNodeId).toBe("verify");
    expect(graph.nodes.find((entry) => entry.id === "a")?.status).toBe("archived");
    expect(graph.nodes.filter((entry) => entry.taskType === "verify")).toHaveLength(1);
    expect(fake.published.some((entry) => entry.kind === "snapshot")).toBe(true);

    const twice = await service.close({ sessionId: SESSION });
    expect(twice.graph?.verifyNodeId).toBe("verify");
    expect(twice.graph?.nodes.filter((entry) => entry.id === "verify")).toHaveLength(1);
    expect(twice.graph?.nodes).toHaveLength(graph.nodes.length);

    // close() already advanced the graph, so the verification node is running.
    const started = await service.start({ sessionId: SESSION, nodeId: "verify" });
    expect(started.code).toBe("NOT_QUEUED");
    expect(
      fake.graph()?.nodes.find((entry) => entry.id === "verify")?.status,
    ).toBe("running");
    await service.onChildSettled({
      parentSessionId: SESSION,
      childSessionId: "child-verify",
      status: "completed",
      summary: "ok",
    });
    expect(fake.graph()?.phase).toBe("done");

    const final = await service.close({ sessionId: SESSION });
    expect(final.graph?.phase).toBe("done");
  });
});

describe("stop", () => {
  it("stops live children and freezes the graph", async () => {
    const fake = fakeDeps(
      seededGraph({
        nodes: [
          node("a", { status: "running", childSessionId: "child-a" }),
          node("b", { status: "completed", childSessionId: "child-b" }),
          node("c", { status: "paused", childSessionId: "child-c" }),
          node("d", { status: "waiting_input", childSessionId: "child-d" }),
          node("e", { status: "waiting_permission", childSessionId: "child-e" }),
        ],
      }),
    );
    const service = createSuperService(fake.deps);

    const result = await service.stop({ sessionId: SESSION });

    expect(result.ok).toBe(true);
    expect(fake.stopped).toEqual(["child-a", "child-c", "child-d", "child-e"]);
    expect(result.graph?.phase).toBe("stopped");
    expect(result.graph?.nodes[0]?.status).toBe("failed");
    expect(result.graph?.nodes[1]?.status).toBe("completed");
    expect(result.graph?.nodes.slice(2).map((entry) => entry.status))
      .toEqual(["failed", "failed", "failed"]);
  });
});

describe("buildNodeBrief", () => {
  it("keeps at most two upstream summaries and caps the length", () => {
    const graph = seededGraph({
      nodes: [
        node("a", { status: "completed", summary: "summary-a" }),
        node("b", { status: "completed", summary: "summary-b" }),
        node("c", { status: "completed", summary: "summary-c" }),
        node("target", {
          acceptance: ["acceptance target"],
          scope: ["services/local-node"],
        }),
        node("long", {
          objective: "o".repeat(SUPER_MAX_BRIEF_CHARS + 1_000),
        }),
      ],
      edges: [
        { id: "dep:a->target", from: "a", to: "target", kind: "dependency", count: 1 },
        { id: "dep:b->target", from: "b", to: "target", kind: "dependency", count: 1 },
        { id: "dep:c->target", from: "c", to: "target", kind: "dependency", count: 1 },
      ],
    });
    const target = graph.nodes[3] as SuperNode;
    const brief = buildNodeBrief(graph, target);
    expect(brief).toContain("summary-a");
    expect(brief).toContain("summary-b");
    expect(brief).not.toContain("summary-c");
    expect(brief).toContain("Objective:");
    expect(brief).toContain("Acceptance:");
    expect(brief).toContain("Write scope:");

    const longBrief = buildNodeBrief(graph, graph.nodes[4] as SuperNode);
    expect(longBrief).toHaveLength(SUPER_MAX_BRIEF_CHARS);
  });
});
