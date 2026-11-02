import { describe, expect, it } from "vitest";
import type { SuperEdge, SuperGraph, SuperNode } from "../../../../../packages/contracts/super-coding";
import {
  budgetText,
  canCloseGraph,
  edgePath,
  graphCounts,
  layoutGraph,
  nodeAriaLabel,
} from "./superGraphModel";

const base: SuperNode = {
  id: "root",
  title: "任务拆解",
  taskType: "design",
  objective: "拆解任务",
  deliverable: "三条链路",
  acceptance: [],
  scope: [],
  status: "running",
  depth: 0,
  model: "anthropic/claude-opus-4.5",
  effort: "high",
  childSessionId: null,
  messages: 0,
  summary: null,
  error: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

function node(id: string, over: Partial<SuperNode> = {}): SuperNode {
  return { ...base, id, title: id, ...over };
}

function graph(nodes: SuperNode[], edges: SuperEdge[] = []): SuperGraph {
  return {
    id: "super:s1",
    sessionId: "s1",
    rev: 3,
    phase: "running",
    maxNodes: 8,
    maxConcurrent: 5,
    nodes,
    edges,
    verifyNodeId: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

describe("superGraphModel", () => {
  it("lays nodes out by depth and keeps the order stable", () => {
    const input = graph([
      node("impl", { depth: 1 }),
      node("root", { depth: 0 }),
      node("review", { depth: 2 }),
      node("design", { depth: 1 }),
    ]);
    const first = layoutGraph(input);
    const second = layoutGraph(input);
    expect(first.placed.map((item) => item.node.id)).toEqual([
      "root",
      "design",
      "impl",
      "review",
    ]);
    expect(second.placed).toEqual(first.placed);
    const x = new Map(first.placed.map((item) => [item.node.id, item.x]));
    expect(x.get("root")!).toBeLessThan(x.get("design")!);
    expect(x.get("design")).toBe(x.get("impl"));
    expect(x.get("review")!).toBeGreaterThan(x.get("design")!);
  });

  it("counts failed and archived nodes out of the live budget", () => {
    const counts = graphCounts(
      graph([
        node("root"),
        node("impl", { status: "running", messages: 2 }),
        node("ui", { status: "failed" }),
        node("old", { status: "archived" }),
      ]),
    );
    expect(counts.live).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.archived).toBe(1);
    expect(counts.running).toBe(2);
    expect(counts.messages).toBe(2);
    expect(counts.maxNodes).toBe(8);
    expect(budgetText(graph([node("root")]))).toBe("节点 1/8");
    // A failure frees its slot immediately, so the card matches what super.plan
    // accepts: the same eight nodes with one failure read 7/8, not 8/8.
    expect(
      budgetText(
        graph([
          ...Array.from({ length: 7 }, (_, index) => node(`n${index}`)),
          node("broken", { status: "failed", error: "boom" }),
        ]),
      ),
    ).toBe("节点 7/8");
  });

  it("builds an accessible label from real state", () => {
    expect(
      nodeAriaLabel(node("impl", { status: "waiting_permission", title: "实现图卡" })),
    ).toBe(
      "实现图卡，等待授权，design，anthropic/claude-opus-4.5",
    );
  });

  it("only enables close when something can be archived", () => {
    expect(canCloseGraph(graph([node("root", { status: "running" })]))).toBe(false);
    expect(canCloseGraph(graph([node("root", { status: "completed" })]))).toBe(true);
    expect(
      canCloseGraph(graph([node("root", { status: "failed" })], []), ),
    ).toBe(true);
    expect(
      canCloseGraph({ ...graph([node("root", { status: "completed" })]), phase: "done" }),
    ).toBe(false);
  });

  it("draws a deterministic cubic edge", () => {
    const layout = layoutGraph(graph([node("root"), node("impl", { depth: 1 })]));
    const [root, impl] = layout.placed;
    expect(edgePath(root, impl)).toBe(edgePath(root, impl));
    expect(edgePath(root, impl)).toContain("C");
  });
});
