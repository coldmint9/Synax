import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SuperGraph, SuperNode } from "../../../../../packages/contracts/super-coding";
import { SuperDagCard } from "./SuperDagCard";
import { superCodingApi } from "../../../adapters/transport/super-coding";

vi.mock("../../../adapters/transport/super-coding", () => ({
  superCodingApi: {
    getGraph: vi.fn(),
    getChannel: vi.fn(),
    sendCommand: vi.fn(),
  },
}));

vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: () => () => {},
}));

const getGraph = vi.mocked(superCodingApi.getGraph);
const sendCommand = vi.mocked(superCodingApi.sendCommand);
const getChannel = vi.mocked(superCodingApi.getChannel);

const baseNode: SuperNode = {
  id: "root",
  title: "任务拆解",
  taskType: "design",
  objective: "拆解",
  deliverable: "三条链路",
  acceptance: ["拆解出可并行链路"],
  scope: [],
  status: "completed",
  depth: 0,
  model: "claude-opus-4.5",
  effort: "high",
  childSessionId: null,
  messages: 0,
  summary: "契约先行",
  error: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

function graph(nodes: SuperNode[]): SuperGraph {
  return {
    id: "super:s1",
    sessionId: "s1",
    rev: 1,
    phase: "running",
    maxNodes: 8,
    maxConcurrent: 5,
    nodes,
    edges: [{ id: "root-impl", from: "root", to: "impl", kind: "dependency", count: 0 }],
    verifyNodeId: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

describe("SuperDagCard", () => {
  beforeEach(() => {
    getGraph.mockReset();
    getChannel.mockReset();
    sendCommand.mockReset();
    getChannel.mockResolvedValue({ items: [] });
  });

  it("renders nothing until the main agent plans a graph", async () => {
    getGraph.mockResolvedValue({ graph: null });
    const { container } = render(<SuperDagCard sessionId="s1" defaultOpen />);
    await waitFor(() => expect(getGraph).toHaveBeenCalled());
    expect(container.querySelector('[aria-label="编排图"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /编排/ })).toBeNull();
  });

  it("opens the node detail from the DAG graph", async () => {
    getGraph.mockResolvedValue({
      graph: graph([
        baseNode,
        {
          ...baseNode,
          id: "impl",
          title: "实现 graph 领域层",
          taskType: "implement",
          status: "running",
          depth: 1,
          scope: ["services/local-node"],
        },
      ]),
    });
    render(<SuperDagCard sessionId="s1" defaultOpen />);

    const node = await screen.findByRole("button", { name: /实现 graph 领域层/ });
    fireEvent.click(node);

    expect(screen.getByText("← 返回")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "交付" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "交付" }));
    expect(screen.getByText("三条链路")).toBeTruthy();
    expect(screen.getByText("services/local-node")).toBeTruthy();

    fireEvent.click(screen.getByText("← 返回"));
    expect(screen.queryByText("← 返回")).toBeNull();
  });

  it("labels an unset node model as inheriting the session model", async () => {
    getGraph.mockResolvedValue({
      graph: graph([
        { ...baseNode, id: "impl", title: "实现", model: "", depth: 1 },
      ]),
    });
    render(<SuperDagCard sessionId="s1" defaultOpen />);

    fireEvent.click(await screen.findByRole("button", { name: /实现/ }));
    fireEvent.click(screen.getByRole("tab", { name: "路由" }));
    expect(screen.getByText("跟随主会话")).toBeTruthy();
  });

  it("starts as one compact row and expands into the full card", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<SuperDagCard sessionId="s1" />);
    const row = await screen.findByRole("button", { name: /编排 · 1 节点/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "编排图" })).toBeNull();

    fireEvent.click(row);
    expect(await screen.findByRole("region", { name: "编排图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /任务拆解/ })).toBeTruthy();
  });

  it("keeps graph-level controls and the list view out of the card", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<SuperDagCard sessionId="s1" defaultOpen />);
    await screen.findByRole("region", { name: "编排图" });

    expect(screen.queryByRole("button", { name: "停止编排" })).toBeNull();
    expect(screen.queryByRole("button", { name: "归档并终验" })).toBeNull();
    expect(screen.queryByRole("group", { name: "视图" })).toBeNull();
    expect(screen.queryByRole("button", { name: "列表" })).toBeNull();
    expect(screen.queryByRole("list", { name: "节点列表" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全屏" })).toBeNull();
  });

  it("inspects the graph in a modal that the close button dismisses", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<SuperDagCard sessionId="s1" defaultOpen />);
    await screen.findByRole("region", { name: "编排图" });
    expect(screen.queryByRole("dialog", { name: "编排图检视" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    const dialog = await screen.findByRole("dialog", { name: "编排图检视" });
    expect(dialog).toBeTruthy();
    // The modal reuses the card body, so the node is reachable on both surfaces.
    expect(screen.getAllByRole("button", { name: /任务拆解/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "关闭编排图检视" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "编排图检视" })).toBeNull(),
    );
  });

  it("closes the inspection modal with Escape", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<SuperDagCard sessionId="s1" defaultOpen />);
    await screen.findByRole("region", { name: "编排图" });

    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await screen.findByRole("dialog", { name: "编排图检视" });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "编排图检视" })).toBeNull(),
    );
  });

  it("shows the delivered channel and refreshes it after sending", async () => {
    const node = { ...baseNode, id: "impl", title: "实现", status: "running" as const, depth: 1, messages: 1 };
    getGraph.mockResolvedValue({ graph: graph([baseNode, node]) });
    getChannel.mockResolvedValue({
      items: [
        { from: "user", text: "先补一个回归用例", at: "t1", delivery: "queued" },
      ],
    });
    render(<SuperDagCard sessionId="s1" defaultOpen />);

    fireEvent.click(await screen.findByRole("button", { name: /实现/ }));
    expect(await screen.findByText("先补一个回归用例")).toBeTruthy();
    expect(screen.getByText(/已投递 1 条消息/)).toBeTruthy();
    expect(getChannel).toHaveBeenCalledWith("s1", "impl");

    const input = screen.getByLabelText("给节点发消息");
    fireEvent.change(input, { target: { value: "继续" } });
    sendCommand.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith("s1", {
        kind: "node.message",
        nodeId: "impl",
        text: "继续",
      }),
    );
    await waitFor(() => expect(getChannel).toHaveBeenCalledTimes(2));
  });

  it("shows an empty channel without inventing messages", async () => {
    getGraph.mockResolvedValue({
      graph: graph([{ ...baseNode, id: "impl", title: "实现", depth: 1 }]),
    });
    render(<SuperDagCard sessionId="s1" defaultOpen />);
    fireEvent.click(await screen.findByRole("button", { name: /实现/ }));
    expect(await screen.findByText("这个节点还没有收到消息。")).toBeTruthy();
  });
});
