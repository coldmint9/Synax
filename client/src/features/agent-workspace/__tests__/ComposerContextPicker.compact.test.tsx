import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { ContextCompactionFeedback } from "../ContextCompactionFeedback";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
const live = vi.hoisted(() => ({ subscribe: vi.fn(), close: vi.fn(), handler: undefined as undefined | ((event: unknown) => void) }));
vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  addSessionLiveListener: live.subscribe,
  ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn(),
}));

const props = {
  projectId: "p",
  sessionId: "s",
  backendId: "native",
  references: [],
  onChange: vi.fn(),
  disabled: false,
  onOpen: vi.fn(),
};
const completed = {
  type: "context_compaction_state" as const,
  state: {
    id: "cmp-1",
    status: "completed" as const,
    startedAt: "",
    requestId: null,
    completedAt: "",
    compacted: true,
    originalTokens: 10000,
    compressedTokens: 2000,
    messageCount: 4,
    contextUsage: {
      version: 1 as const,
      stepId: "cmp-step",
      total: 2000,
      limit: 200000,
      composition: { version: 2 as const, messages: 1500, tools: 200, mcp: 100, skills: 50, system: 150, total: 2000, measuredAt: "" },
      measuredAt: "",
    },
  },
  message: {
    id: "msg-1",
    sessionId: "s",
    runId: null,
    stepId: null,
    role: "system" as const,
    content: "上下文已压缩",
    metadata: { source: "context_compaction" },
    createdAt: "",
  },
};
beforeEach(() => {
  live.subscribe.mockReset(); live.close.mockReset(); live.handler = undefined;
  live.subscribe.mockImplementation((_id, handler) => { live.handler = handler; return live.close; });
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    selectedSessionId: "s",
    sessions: [{ id: "s", sessionMetadata: {} } as never],
    fetchSessionStats: vi.fn(async () => {}),
    refreshDetail: vi.fn(async () => {}),
  });
});
afterEach(() => vi.restoreAllMocks());
async function open() {
  await userEvent.click(screen.getByRole("button", { name: "添加上下文" }));
  return screen.getByRole("button", { name: /强制压缩上下文/ });
}
describe("manual compaction", () => {
  it("subscribes while an idle session compacts and releases observation after completion", async () => {
    vi.spyOn(agentRuntimeApi, "compactContext").mockResolvedValue({ accepted: true, status: "compacting" });
    render(<ComposerContextPicker {...props} />);
    expect(live.subscribe).not.toHaveBeenCalled();
    await userEvent.click(await open());
    await waitFor(() => expect(live.subscribe).toHaveBeenCalledWith("s", expect.any(Function)));
    // A snapshot fetched between admission and context_begin has no durable
    // compaction row yet. It must not end observation of the accepted run.
    act(() => useAgentSessionStore.setState({ contextCompactionNotice: null }));
    expect(live.close).not.toHaveBeenCalled();
    act(() => live.handler?.(completed));
    await waitFor(() => expect(live.close).toHaveBeenCalledTimes(1));
    expect(useAgentSessionStore.getState().contextCompactionNotice?.status).toBe("completed");
  });
  it("closes the popover immediately and stays disabled until the durable state arrives", async () => {
    vi.spyOn(agentRuntimeApi, "compactContext").mockResolvedValue({
      accepted: true,
      status: "compacting",
    });
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    const button = screen.getByRole("button", { name: /正在压缩上下文/ });
    expect(button).toBeDisabled();
    act(() => useAgentSessionStore.getState().applyLiveEvent(completed, "s"));
    expect(useAgentSessionStore.getState().contextCompactionNotice).toEqual({
      status: "completed",
      originalTokens: 10000,
      compressedTokens: 2000,
      messageCount: 4,
    });
  });
  it("applies the post-compaction usage snapshot to the composer session", () => {
    act(() => useAgentSessionStore.getState().applyLiveEvent(completed, "s"));
    expect(useAgentSessionStore.getState().sessions[0].sessionMetadata?.contextUsage).toMatchObject({ total: 2000, stepId: "cmp-step" });
  });
  it("keeps a running state after refresh data is applied", () => {
    render(
      <ContextCompactionFeedback
        state={{ id: "cmp", status: "running", startedAt: "", requestId: null }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在压缩上下文");
  });
  it("renders the durable completion row", () => {
    render(<ContextCompactionFeedback state={completed.state} />);
    expect(screen.getByRole("status")).toHaveTextContent("上下文已压缩");
    expect(screen.getByRole("status")).toHaveTextContent("2,000 tokens");
  });
  it("renders failures as an alert", () => {
    render(
      <ContextCompactionFeedback
        state={{
          id: "cmp",
          status: "failed",
          startedAt: "",
          requestId: null,
          error: "摘要服务超时",
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("摘要服务超时");
  });
  it("does not let a late HTTP failure replace a durable completion", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(agentRuntimeApi, "compactContext").mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    act(() => useAgentSessionStore.getState().applyLiveEvent(completed, "s"));
    await act(async () => reject(new Error("late response")));
    expect(useAgentSessionStore.getState().contextCompactionNotice).toEqual({
      status: "completed",
      originalTokens: 10000,
      compressedTokens: 2000,
      messageCount: 4,
    });
  });
  it("reports admission failure even if an early snapshot has cleared the notice", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(agentRuntimeApi, "compactContext").mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    act(() => useAgentSessionStore.setState({ contextCompactionNotice: null }));
    await act(async () => reject(new Error("Worker unavailable")));
    expect(useAgentSessionStore.getState().contextCompactionNotice).toEqual({ status: "failed", error: "Worker unavailable" });
  });
});
