import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperGraph, SuperNode } from "../../../../../packages/contracts/super-coding";
import { useSuperGraph } from "./useSuperGraph";
import { superCodingApi } from "../../../adapters/transport/super-coding";

const bus = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: MessageEvent) => void>,
}));

vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: (sub: { events?: Record<string, (event: MessageEvent) => void> }) => {
    Object.assign(bus.handlers, sub.events ?? {});
    return () => {};
  },
}));

vi.mock("../../../adapters/transport/super-coding", () => ({
  superCodingApi: {
    getGraph: vi.fn(),
    getChannel: vi.fn(),
    sendCommand: vi.fn(),
  },
}));

const getGraph = vi.mocked(superCodingApi.getGraph);
const sendCommand = vi.mocked(superCodingApi.sendCommand);

const baseNode: SuperNode = {
  id: "root",
  title: "任务拆解",
  taskType: "design",
  objective: "拆解",
  deliverable: "链路",
  acceptance: [],
  scope: [],
  status: "completed",
  depth: 0,
  model: "m",
  effort: "high",
  childSessionId: null,
  messages: 0,
  summary: null,
  error: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

function graph(nodes: SuperNode[], rev = 1): SuperGraph {
  return {
    id: "super:s1",
    sessionId: "s1",
    rev,
    phase: "running",
    maxNodes: 8,
    maxConcurrent: 5,
    nodes,
    edges: [],
    verifyNodeId: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

function Probe() {
  const { graph: current, channel, error } = useSuperGraph("s1");
  return (
    <div>
      <span data-testid="rev">{current?.rev ?? "none"}</span>
      <span data-testid="phase">{current?.phase ?? "none"}</span>
      <span data-testid="nodes">{current?.nodes.length ?? 0}</span>
      <span data-testid="channel">{channel.map((item) => item.text).join("|")}</span>
      <span data-testid="error">{error ?? ""}</span>
    </div>
  );
}

function emit(type: string, patch: unknown) {
  const handler = bus.handlers[type];
  expect(handler).toBeTruthy();
  act(() => {
    handler({ data: JSON.stringify({ sessionId: "s1", patch }) } as MessageEvent);
  });
}

describe("useSuperGraph", () => {
  beforeEach(() => {
    getGraph.mockReset();
    sendCommand.mockReset();
    bus.handlers = {};
  });

  it("applies a node delta without refetching", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("nodes").textContent).toBe("1"));

    emit("super.nodes", {
      rev: 2,
      nodes: [baseNode, { ...baseNode, id: "impl", title: "实现", depth: 1 }],
      edges: [],
    });
    expect(screen.getByTestId("nodes").textContent).toBe("2");
    expect(screen.getByTestId("rev").textContent).toBe("2");
    expect(screen.getByTestId("phase").textContent).toBe("running");
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("applies the terminal phase carried by a node delta", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode], 5) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("5"));

    emit("super.nodes", {
      rev: 6,
      phase: "done",
      verifyNodeId: "verify",
      nodes: [{ ...baseNode, id: "verify", status: "completed" }],
      edges: [],
    });
    expect(screen.getByTestId("phase").textContent).toBe("done");
  });

  it("ignores a delta older than the current revision", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode], 5) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("5"));

    emit("super.nodes", { rev: 3, nodes: [], edges: [] });
    expect(screen.getByTestId("nodes").textContent).toBe("1");
    expect(screen.getByTestId("rev").textContent).toBe("5");
  });

  it("replaces the graph from a snapshot event", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode]) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("nodes").textContent).toBe("1"));

    emit("super.snapshot", {
      graph: graph([{ ...baseNode, id: "verify", status: "running" }], 4),
    });
    expect(screen.getByTestId("rev").textContent).toBe("4");
    expect(screen.getByTestId("nodes").textContent).toBe("1");
  });

  it("does not let an older snapshot overwrite a newer terminal graph", async () => {
    getGraph.mockResolvedValue({ graph: graph([baseNode], 5) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("5"));

    emit("super.snapshot", {
      graph: { ...graph([{ ...baseNode, id: "verify", status: "completed" }], 8), phase: "done" },
    });
    emit("super.snapshot", {
      graph: graph([baseNode], 7),
    });
    expect(screen.getByTestId("rev").textContent).toBe("8");
    expect(screen.getByTestId("phase").textContent).toBe("done");
  });

  it("reports transport failures instead of dropping them", async () => {
    getGraph.mockRejectedValue(new Error("offline"));
    render(<Probe />);
    expect(await screen.findByText("offline")).toBeTruthy();
  });
});
