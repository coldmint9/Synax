import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptySuperGraph,
  type SuperNode,
} from "../../../../../packages/contracts/super-coding.js";
import {
  createSuperRuntimeDeps,
  type SuperRuntimeAdapterOptions,
} from "../super-runtime-adapter.js";
import { createSuperService } from "../super-service.js";
import { agentRuntimeStore } from "../../agent-runtime/session-store.js";
import { runtimeFacade } from "../../agent-runtime/sidecar/runtime-facade.js";

const runtime = vi.hoisted(() => ({
  createChild: vi.fn(),
  runChild: vi.fn(),
  readResult: vi.fn(),
  enqueue: vi.fn(),
  dispatchQueuedInput: vi.fn(),
  submit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../agent-runtime/subagent-delegation.js", () => ({
  createConfiguredSubagent: runtime.createChild,
}));
vi.mock("../../agent-runtime/subagent-orchestrator.js", () => ({
  runChildToCompletion: runtime.runChild,
  readPersistedSubagentResult: runtime.readResult,
}));
vi.mock("../../agent-runtime/agent-stream-proxy.js", () => ({
  interruptAgentSessionsAndWait: vi.fn(),
}));
vi.mock("../../agent-runtime/event-service.js", () => ({
  agentEventService: { append: vi.fn() },
}));
vi.mock("../../agent-runtime/input-queue-runtime.js", () => ({
  inputQueueRuntime: { enabled: vi.fn(), enqueue: runtime.enqueue },
}));
vi.mock("../../agent-runtime/run-coordinator.js", () => ({
  runCoordinator: {
    dispatchQueuedInput: runtime.dispatchQueuedInput,
    submit: runtime.submit,
  },
}));
vi.mock("../../agent-runtime/runtime-ids.js", () => ({
  nowIso: () => "2026-10-29T00:00:00.000Z",
}));
vi.mock("../../agent-runtime/runtime-bus-bridge.js", () => ({
  emitRuntimeBusEvent: vi.fn(),
}));
vi.mock("../../agent-runtime/session-store.js", () => ({
  agentRuntimeStore: { tryGetSession: vi.fn(), updateSessionMetadata: vi.fn() },
}));
vi.mock("../../agent-runtime/session-runtime.js", () => ({
  agentSessionRuntime: { interrupt: vi.fn() },
}));
vi.mock("../../agent-runtime/sidecar/runtime-facade.js", () => ({
  runtimeFacade: { streamMode: vi.fn(), stopSessionAuthoritative: vi.fn() },
}));
vi.mock("../../../infrastructure/runtime/config/config-store.js", () => ({
  getGlobalConfigForRuntime: () => ({}),
}));
vi.mock("../../../infrastructure/runtime/logger.js", () => ({
  logger: { warn: runtime.warn },
}));

const NOW = "2026-10-29T00:00:00.000Z";
const spec = { profileId: "subagent", prompt: "Task" };

type Settlement = Parameters<NonNullable<SuperRuntimeAdapterOptions["onChildSettled"]>>[0];

function node(scope: string[] = [], overrides: Partial<SuperNode> = {}): SuperNode {
  return {
    id: "a",
    title: "Task a",
    taskType: "implement",
    objective: "Implement the task",
    deliverable: "Working code",
    acceptance: ["Tests pass"],
    scope,
    status: "queued",
    depth: 0,
    model: "",
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

async function startAndSettle(scope: string[] = []): Promise<Settlement> {
  let receive!: (input: Settlement) => void;
  const settled = new Promise<Settlement>((resolve) => { receive = resolve; });
  const deps = createSuperRuntimeDeps({ onChildSettled: receive });
  await deps.startChild({ parentSessionId: "parent", node: node(scope), brief: "Task" });
  return settled;
}

beforeEach(() => {
  vi.resetAllMocks();
  runtime.createChild.mockResolvedValue({ child: { id: "child-a" }, spec });
  runtime.runChild.mockResolvedValue({
    spec,
    childSessionId: "child-a",
    status: "failed",
    summary: null,
    error: "Child failed",
  });
  runtime.readResult.mockReturnValue(null);
});

describe("super child waiting outcomes", () => {
  it.each(["waiting_permission", "waiting_input", "paused"])(
    "preserves persisted %s instead of forwarding the folded failure",
    async (status) => {
      runtime.readResult.mockReturnValue({
        childSessionId: "child-a",
        parentSessionId: "parent",
        status,
        summary: null,
        error: "Waiting for the user",
        metadata: { state: "waiting" },
      });

      expect(await startAndSettle()).toEqual({
        parentSessionId: "parent",
        childSessionId: "child-a",
        status,
        summary: "Waiting for the user",
      });
      expect(runtime.readResult).toHaveBeenCalledWith("child-a", "parent");
      expect(runtime.warn).not.toHaveBeenCalled();
    },
  );

  it("does not turn a completed-but-blocked run into success", async () => {
    runtime.readResult.mockReturnValue({ status: "completed", summary: null, error: null });
    runtime.runChild.mockResolvedValue({
      spec, childSessionId: "child-a", status: "blocked", summary: null, error: "Blocked run",
    });

    expect(await startAndSettle()).toMatchObject({ status: "blocked", summary: "Blocked run" });
  });

  it("preserves real failures when no waiting child was observed", async () => {
    expect(await startAndSettle()).toMatchObject({ status: "failed", summary: "Child failed" });
  });

  it("wakes a completed parent through the durable input queue when work remains", async () => {
    const graph = {
      ...createEmptySuperGraph({ sessionId: "parent", now: NOW }),
      phase: "running" as const,
      nodes: [node([], { status: "completed", childSessionId: "child-a" })],
    };
    vi.mocked(agentRuntimeStore.tryGetSession).mockReturnValue({
      id: "parent",
      status: "completed",
      parentSessionId: null,
      sessionMetadata: { superGraph: graph },
    } as never);
    vi.mocked(runtimeFacade.streamMode).mockReturnValue("authoritative");
    runtime.enqueue.mockResolvedValue([]);
    runtime.dispatchQueuedInput.mockResolvedValue(true);

    const deps = createSuperRuntimeDeps();
    await deps.wakeParent?.({
      parentSessionId: "parent",
      childSessionId: "child-a",
      status: "failed",
      summary: "Child failed",
    });
    expect(runtime.enqueue).toHaveBeenCalledWith("parent", expect.objectContaining({
      message: expect.stringContaining("Child node child-a settled as failed"),
      messageSource: "system_injection",
    }));
    expect(runtime.dispatchQueuedInput).toHaveBeenCalledWith("parent");
    expect(runtime.submit).not.toHaveBeenCalled();
  });

  it("reports unexpected runner errors through settlement", async () => {
    runtime.runChild.mockRejectedValue(new Error("Runner failed"));

    expect(await startAndSettle()).toMatchObject({ status: "failed", summary: "Runner failed" });
  });

  it("wakes the parent with the graph failure so it can decide what to replan", async () => {
    const graph = {
      ...createEmptySuperGraph({ sessionId: "parent", now: NOW }),
      phase: "failed" as const,
      phaseError: "Node a failed: boom",
      nodes: [node([], { id: "a", status: "failed", childSessionId: "child-a" })],
    };
    vi.mocked(agentRuntimeStore.tryGetSession).mockReturnValue({
      id: "parent",
      status: "completed",
      parentSessionId: null,
      sessionMetadata: { superGraph: graph },
    } as never);
    vi.mocked(runtimeFacade.streamMode).mockReturnValue("authoritative");
    runtime.enqueue.mockResolvedValue([]);
    runtime.dispatchQueuedInput.mockResolvedValue(true);

    const deps = createSuperRuntimeDeps();
    await deps.wakeParent?.({
      parentSessionId: "parent",
      childSessionId: "child-a",
      status: "failed",
      summary: "Child failed",
    });

    expect(runtime.enqueue).toHaveBeenCalledWith("parent", expect.objectContaining({
      message: expect.stringContaining("The graph failed at that node"),
      messageSource: "system_injection",
    }));
    const sent = runtime.enqueue.mock.calls.at(-1)?.[1] as { message: string };
    expect(sent.message).toContain("Node a failed: boom");
    expect(sent.message).toContain("super.plan");
    expect(runtime.dispatchQueuedInput).toHaveBeenCalledWith("parent");
  });

  it("stays silent for a late completion inside a failed graph", async () => {
    const graph = {
      ...createEmptySuperGraph({ sessionId: "parent", now: NOW }),
      phase: "failed" as const,
      nodes: [node([], { id: "a", status: "failed", childSessionId: "child-a" })],
    };
    vi.mocked(agentRuntimeStore.tryGetSession).mockReturnValue({
      id: "parent",
      status: "completed",
      parentSessionId: null,
      sessionMetadata: { superGraph: graph },
    } as never);
    vi.mocked(runtimeFacade.streamMode).mockReturnValue("authoritative");

    const deps = createSuperRuntimeDeps();
    await deps.wakeParent?.({
      parentSessionId: "parent",
      childSessionId: "child-a",
      status: "completed",
      summary: "Finished late",
    });

    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
});

describe("super child write scope", () => {
  it.each([
    { label: "empty entry", scope: [""] },
    { label: "workspace root", scope: ["."] },
    { label: "parent traversal", scope: ["src/../outside"] },
    { label: "absolute path", scope: ["/tmp/outside"] },
    { label: "home path", scope: ["~/outside"] },
    { label: "Windows path", scope: ["C:/outside"] },
    { label: "backslash path", scope: ["src\\outside"] },
    { label: "glob", scope: ["src/*.ts"] },
    { label: "encoded path", scope: ["src/%2e%2e"] },
    { label: "whitespace", scope: [" src "] },
    { label: "mixed valid and invalid paths", scope: ["services/local-node", "../outside"] },
    { label: "oversized path", scope: ["x".repeat(1025)] },
    { label: "too many paths", scope: Array.from({ length: 33 }, (_, index) => `dir-${index}`) },
  ])("rejects $label before child creation rather than inheriting access", async ({ scope }) => {
    const deps = createSuperRuntimeDeps();

    await expect(deps.startChild({ parentSessionId: "parent", node: node(scope), brief: "Task" }))
      .rejects.toThrow();

    expect(runtime.createChild).not.toHaveBeenCalled();
    expect(runtime.runChild).not.toHaveBeenCalled();
    expect(runtime.readResult).not.toHaveBeenCalled();
  });

  it("inherits only when scope is empty", async () => {
    await startAndSettle([]);

    expect(runtime.createChild).toHaveBeenCalledTimes(1);
    const profile = runtime.createChild.mock.calls[0]![1].profile;
    expect(profile).not.toHaveProperty("writeScope");
    expect(runtime.runChild).toHaveBeenCalledTimes(1);
  });

  it("passes normalized nonempty scope to configured delegation", async () => {
    await startAndSettle(["services/./local-node//", "packages/contracts/super-coding.ts"]);

    expect(runtime.createChild).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "parent" }),
      expect.objectContaining({
        profile: expect.objectContaining({
          writeScope: ["services/local-node", "packages/contracts/super-coding.ts"],
        }),
      }),
    );
  });

  it("records invalid scope as a start failure without creating a child", async () => {
    let stored = {
      ...createEmptySuperGraph({ sessionId: "parent", now: NOW }),
      nodes: [node(["../outside"])],
    };
    const service = createSuperService({
      ...createSuperRuntimeDeps(),
      async readGraph() { return structuredClone(stored); },
      async writeGraph(graph, rev) {
        expect(rev).toBe(stored.rev);
        stored = structuredClone(graph);
      },
      publish: vi.fn(),
    });

    const result = await service.start({ sessionId: "parent", nodeId: "a" });

    expect(result).toMatchObject({ ok: false, code: "START_FAILED" });
    expect(result.graph?.nodes[0]).toMatchObject({ status: "failed", childSessionId: null });
    expect(result.message).toContain("workspace-relative");
    expect(runtime.createChild).not.toHaveBeenCalled();
    expect(runtime.runChild).not.toHaveBeenCalled();
  });
});
