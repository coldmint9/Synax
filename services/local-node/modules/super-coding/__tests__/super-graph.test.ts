import { describe, expect, it } from "vitest";
import {
  createEmptySuperGraph,
  liveNodeCount,
  type SuperEdge,
  type SuperGraph,
  type SuperNode,
} from "../../../../../packages/contracts/super-coding.js";
import {
  addMessageCount,
  appendNodeMessage,
  admitNode,
  archiveNode,
  closeGraph,
  createsCycle,
  markPhase,
  setNodeStatus,
  upsertEdge,
  upsertNode,
} from "../super-graph.js";

const NOW = "2026-10-29T00:00:00.000Z";

function node(id: string, overrides: Partial<SuperNode> = {}): SuperNode {
  return {
    id,
    title: id,
    taskType: "implement",
    objective: `objective ${id}`,
    deliverable: `deliverable ${id}`,
    acceptance: [],
    scope: [],
    status: "queued",
    depth: 0,
    model: "model-implement",
    effort: "high",
    childSessionId: null,
    messages: 0,
    summary: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function graph(overrides: Partial<SuperGraph> = {}): SuperGraph {
  return { ...createEmptySuperGraph({ sessionId: "session-1", now: NOW }), ...overrides };
}

function dependency(from: string, to: string): SuperEdge {
  return { id: `dep:${from}->${to}`, from, to, kind: "dependency", count: 1 };
}

describe("admitNode", () => {
  it("admits a node while the budget lasts", () => {
    expect(admitNode(graph(), node("a"), [])).toEqual({ ok: true });
  });

  it("rejects a duplicate id with one action", () => {
    const graphWithNode = upsertNode(graph(), node("a"), NOW);
    const rejection = admitNode(graphWithNode, node("a"), []);
    expect(rejection.ok).toBe(false);
    if (rejection.ok) return;
    expect(rejection.code).toBe("DUP_ID");
    expect(rejection.action).toContain("a");
  });

  it("rejects a node whose parent is missing or not yet planned", () => {
    const noParent = admitNode(graph(), node("child", { depth: 1 }), []);
    expect(noParent.ok).toBe(false);
    if (!noParent.ok) expect(noParent.code).toBe("NO_PARENT");

    const missingParent = admitNode(graph(), node("child", { depth: 1 }), ["ghost"]);
    expect(missingParent.ok).toBe(false);
    if (!missingParent.ok) expect(missingParent.code).toBe("NO_PARENT");

    const partialParent = admitNode(
      upsertNode(graph(), node("a"), NOW),
      node("child", { depth: 1 }),
      ["a", "ghost"],
    );
    expect(partialParent.ok).toBe(false);
    if (!partialParent.ok) {
      expect(partialParent.code).toBe("NO_PARENT");
      expect(partialParent.message).toContain("ghost");
    }
  });

  it("rejects a self dependency as a cycle", () => {
    const rejection = admitNode(graph(), node("a"), ["a"]);
    expect(rejection.ok).toBe(false);
    if (!rejection.ok) {
      expect(rejection.code).toBe("CYCLE");
      expect(rejection.action).toContain("back-edge");
    }
  });

  it("rejects the node that would exceed maxNodes - 1 and keeps the verify slot", () => {
    let limited = graph({ maxNodes: 4 });
    for (const id of ["a", "b", "c"])
      limited = upsertNode(limited, node(id), NOW);
    const rejection = admitNode(limited, node("d"), []);
    expect(rejection.ok).toBe(false);
    if (!rejection.ok) {
      expect(rejection.code).toBe("BUDGET");
      expect(rejection.message).toContain("3/3");
    }
    expect(liveNodeCount(limited)).toBe(3);
  });

  it("frees the slot of a failed node instead of blocking the graph", () => {
    let limited = graph({ maxNodes: 4 });
    for (const id of ["a", "b", "c"])
      limited = upsertNode(limited, node(id), NOW);
    expect(admitNode(limited, node("d"), []).ok).toBe(false);

    const failed = setNodeStatus(
      limited,
      "c",
      { status: "failed", error: "child session failed to start." },
      NOW,
    );
    // The record survives for audit, but the slot comes back.
    expect(failed.nodes.find((entry) => entry.id === "c")?.error).toBe(
      "child session failed to start.",
    );
    expect(liveNodeCount(failed)).toBe(2);
    expect(admitNode(failed, node("d"), []).ok).toBe(true);
  });
});

describe("createsCycle", () => {
  it("detects a back-edge into an existing chain", () => {
    const chain = graph({
      nodes: [node("a"), node("b", { depth: 1 }), node("c", { depth: 2 })],
      edges: [dependency("a", "b"), dependency("b", "c")],
    });
    expect(createsCycle(chain, "a", ["c"])).toBe(true);
    expect(createsCycle(chain, "c", ["a"])).toBe(false);
    expect(createsCycle(chain, "d", ["b"])).toBe(false);
  });

  it("ignores message edges", () => {
    const messaging = graph({
      nodes: [node("a"), node("b")],
      edges: [{ id: "msg:b->a", from: "b", to: "a", kind: "message", count: 2 }],
    });
    expect(createsCycle(messaging, "a", ["b"])).toBe(false);
  });
});

describe("archiveNode", () => {
  it("archives completed and failed nodes only", () => {
    for (const status of ["queued", "running", "waiting_input", "paused", "archived"] as const) {
      const unchanged = graph({ nodes: [node("a", { status })] });
      expect(archiveNode(unchanged, "a", NOW)).toBe(unchanged);
    }
    for (const status of ["completed", "failed"] as const) {
      const before = graph({ nodes: [node("a", { status })], rev: 4 });
      const archived = archiveNode(before, "a", NOW);
      expect(archived.nodes[0]?.status).toBe("archived");
      expect(archived.rev).toBe(5);
      expect(before.nodes[0]?.status).toBe(status);
      expect(liveNodeCount(archived)).toBe(0);
    }
  });
});

describe("closeGraph", () => {
  it("archives finished nodes, adds one verify node and stays idempotent", () => {
    const before = graph({
      rev: 2,
      nodes: [
        node("a", { status: "completed" }),
        node("b", { status: "failed" }),
        node("c", { status: "running", childSessionId: "child-c" }),
      ],
    });
    const verify = node("verify", { taskType: "verify" });
    const closed = closeGraph(before, { now: NOW, verifyNode: verify });
    expect(closed.rev).toBe(3);
    expect(closed.phase).toBe("running");
    expect(closed.verifyNodeId).toBe("verify");
    expect(closed.nodes.map((entry) => entry.status)).toEqual([
      "archived",
      "archived",
      "running",
      "queued",
    ]);
    expect(closed.nodes.filter((entry) => entry.id === "verify")).toHaveLength(1);

    const again = closeGraph(closed, { now: NOW, verifyNode: verify });
    expect(again.verifyNodeId).toBe("verify");
    expect(again.nodes).toHaveLength(closed.nodes.length);
    expect(again.nodes.filter((entry) => entry.id === "verify")).toHaveLength(1);
    expect(again.rev).toBe(4);
  });

  it("fits the verify node into a full budget without tripping admission", () => {
    let full = graph({ maxNodes: 4 });
    for (const id of ["a", "b", "c"])
      full = upsertNode(full, node(id, { status: "completed" }), NOW);
    const closed = closeGraph(full, { now: NOW, verifyNode: node("verify") });
    expect(closed.nodes).toHaveLength(4);
    expect(closed.phase).toBe("running");
  });

  it("reports done when the verify node already completed and never archives it", () => {
    const running = graph({
      nodes: [node("a", { status: "completed" })],
    });
    const closed = closeGraph(running, { now: NOW, verifyNode: node("verify") });
    const settled = {
      ...closed,
      nodes: closed.nodes.map((entry) =>
        entry.id === "verify" ? { ...entry, status: "completed" as const } : entry,
      ),
    };
    const done = closeGraph(settled, { now: NOW, verifyNode: node("verify") });
    expect(done.phase).toBe("done");
    expect(done.nodes.find((entry) => entry.id === "verify")?.status).toBe("completed");
    expect(done.nodes.filter((entry) => entry.id === "verify")).toHaveLength(1);
  });
});

describe("mutators", () => {
  it.each(["completed", "failed", "archived"] as const)(
    "does not overwrite or revive a %s node",
    (status) => {
      const before = graph({
        rev: 5,
        nodes: [node("a", { status, summary: "original" })],
      });
      for (const nextStatus of ["queued", "running", "waiting_permission", "waiting_input", "paused", "completed", "failed"] as const) {
        expect(setNodeStatus(before, "a", {
          status: nextStatus, summary: "late", childSessionId: "late-child",
        }, NOW)).toBe(before);
      }
    },
  );

  it("bumps rev once per change and never mutates the input", () => {
    const base = graph();
    const snapshot = structuredClone(base);

    const withNode = upsertNode(base, node("a"), NOW);
    expect(withNode.rev).toBe(1);

    const withEdge = upsertEdge(withNode, dependency("a", "b"), NOW);
    expect(withEdge.rev).toBe(2);

    const running = setNodeStatus(
      withEdge,
      "a",
      { status: "running", childSessionId: "child-a" },
      NOW,
    );
    expect(running.rev).toBe(3);
    expect(running.nodes[0]?.childSessionId).toBe("child-a");

    const messaged = addMessageCount(running, "a", NOW);
    expect(messaged.rev).toBe(4);
    expect(messaged.nodes[0]?.messages).toBe(1);

    const finallyRunning = markPhase(messaged, "running", NOW);
    expect(finallyRunning.rev).toBe(5);

    expect(base).toEqual(snapshot);
    expect(base.nodes).toHaveLength(0);
    expect(base.edges).toHaveLength(0);
  });

  it("replaces an existing node instead of duplicating it", () => {
    const base = upsertNode(graph(), node("a"), NOW);
    const replaced = upsertNode(base, node("a", { status: "completed" }), NOW);
    expect(replaced.nodes).toHaveLength(1);
    expect(replaced.nodes[0]?.status).toBe("completed");
    expect(replaced.rev).toBe(base.rev + 1);
  });

  it("keeps the graph untouched for unknown ids", () => {
    const base = upsertNode(graph(), node("a"), NOW);
    expect(setNodeStatus(base, "ghost", { status: "completed" }, NOW)).toBe(base);
    expect(addMessageCount(base, "ghost", NOW)).toBe(base);
    expect(archiveNode(base, "ghost", NOW)).toBe(base);
  });

  it("keeps a bounded per-node message log and bumps the revision", () => {
    let graph = createEmptySuperGraph({ sessionId: "s1", now: NOW, maxNodes: 8 });
    graph = upsertNode(
      graph,
      node("impl", { depth: 0, status: "running", childSessionId: "child-1" }),
      NOW,
    );
    for (let index = 0; index < 8; index += 1) {
      graph = appendNodeMessage(
        graph,
        "impl",
        { from: "user", text: `m${index}`, at: NOW, delivery: "queued" },
        NOW,
      );
    }
    const target = graph.nodes.find((item) => item.id === "impl")!;
    expect(target.messages).toBe(8);
    expect(target.messageLog).toHaveLength(6);
    expect(target.messageLog?.map((item) => item.text)).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expect(graph.rev).toBe(9);
  });
});
