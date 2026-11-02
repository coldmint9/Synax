import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunStep, AgentSession, SessionEnvironmentSubagent } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { SubagentIsland } from "../SubagentIsland";
import { SubagentConversationPanel } from "../SubagentConversationPanel";
import { ConversationController, getConversationController } from "../state/conversationController";
import { useSessionWorkspace, useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";

const snapshot = vi.hoisted(() => ({ subagents: [] as SessionEnvironmentSubagent[] }));
vi.mock("../SessionEnvironmentContext", () => ({
  useSessionWorkspaceEnvironment: () => ({ environment: snapshot }),
}));
vi.mock("../../../app/layouts/IslandSurface", () => ({
  IslandSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../SubagentReadonlyView", () => ({
  SubagentReadonlyView: ({ sessionId }: { sessionId: string }) => <div>记录 {sessionId}</div>,
}));
vi.mock("../useProviderNames", async (importOriginal) => ({
  ...await importOriginal<typeof import("../useProviderNames")>(),
  useProviderNames: () => [{ id: "custom-api:test", label: "测试供应商" }],
}));

function child(id: string, status: SessionEnvironmentSubagent["status"]): SessionEnvironmentSubagent {
  return { id, parentSessionId: "parent", subagentName: id === "a" ? "林墨" : "江岚", roleName: "探索员", profileId: "explorer", status, title: null, prompt: "## 检查布局\n梳理交互入口", updatedAt: "2026-10-08T00:00:00Z", completedAt: null, resultSummary: null };
}
function Harness({ owner = "parent" }: { owner?: string }) {
  const { subagent } = useSessionWorkspace(owner);
  return <><div>主对话 {owner}</div><SubagentIsland sessionId={owner} />{subagent && <SubagentConversationPanel ownerSessionId={owner} sessionId={subagent.sessionId} title={subagent.title} />}</>;
}

beforeEach(() => {
  snapshot.subagents = [];
  for (const id of ["a", "b", "parent"]) {
    const controller = getConversationController(id);
    controller.store.setState(new ConversationController(id).getSnapshot(), true);
    vi.spyOn(controller, "retain").mockReturnValue(() => {});
  }
  useSessionWorkspaceStore.setState({ sessions: {} });
  useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } }));
});
afterEach(() => vi.restoreAllMocks());

describe("SubagentIsland", () => {
  it("shows the child's executed provider/model and effort inline without the subtitle", () => {
    const controller = getConversationController("a");
    controller.store.setState({
      session: { id: "a", activeRunId: "run-a", model: "custom-api:test/configured", reasoningEffort: "low" } as AgentSession,
      history: {
        ...controller.getSnapshot().history,
        runs: [{ id: "run-a", sessionId: "a", model: "custom-api:test/run-model", metadata: { reasoningEffort: "medium" }, startedAt: "2026-10-30T00:00:00Z" } as AgentRun],
        steps: [
          { id: "step-a", sessionId: "a", runId: "run-a", model: "custom-api:test/actual-model", metadata: { reasoningEffort: "max" }, startedAt: "2026-10-30T00:00:01Z" } as AgentRunStep,
          { id: "step-parent", sessionId: "parent", runId: "run-parent", model: "other/parent-model", metadata: { reasoningEffort: "none" }, startedAt: "2026-10-30T00:00:02Z" } as AgentRunStep,
        ],
      },
    });
    useSessionWorkspaceStore.getState().openSubagent("parent", "a", "林墨");
    const { container } = render(<Harness />);
    const model = screen.getByLabelText("供应商/模型: 测试供应商/actual-model");
    expect(model).toHaveTextContent("测试供应商/actual-model");
    expect(model).toHaveAttribute("title", "供应商/模型: 测试供应商/actual-model");
    expect(screen.getByLabelText("推理强度: max")).toHaveTextContent("max");
    expect(container.querySelector(".subagent-conversation-header")).toContainElement(model);
    expect(screen.queryByText(/主对话保持可见/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全屏查看子代理对话" }));
    expect(screen.queryByText(/Esc 返回分栏/)).toBeNull();
    expect(screen.getByLabelText("供应商/模型: 测试供应商/actual-model")).toBe(model);
  });

  it("updates runtime metadata and does not carry it across child switches", () => {
    useSessionWorkspaceStore.getState().openSubagent("parent", "a", "林墨");
    render(<Harness />);
    expect(screen.getByLabelText("供应商/模型: —")).toBeInTheDocument();
    expect(screen.getByLabelText("推理强度: —")).toBeInTheDocument();
    act(() => getConversationController("a").store.setState({
      session: { id: "a", model: "custom-api:test/model-a", reasoningEffort: "high" } as AgentSession,
    }));
    expect(screen.getByLabelText("供应商/模型: 测试供应商/model-a")).toBeInTheDocument();
    expect(screen.getByLabelText("推理强度: high")).toBeInTheDocument();
    act(() => getConversationController("a").store.setState({
      session: { id: "a", model: "custom-api:test/model-a", reasoningEffort: "none" } as AgentSession,
    }));
    expect(screen.getByLabelText("推理强度: none")).toBeInTheDocument();
    act(() => useSessionWorkspaceStore.getState().openSubagent("parent", "b", "江岚"));
    expect(screen.queryByText("测试供应商/model-a")).toBeNull();
    expect(screen.getByLabelText("供应商/模型: —")).toBeInTheDocument();
    expect(screen.getByLabelText("推理强度: —")).toBeInTheDocument();
    act(() => getConversationController("b").store.setState({
      session: { id: "b", model: "unknown-provider/model-b", reasoningEffort: "low" } as AgentSession,
    }));
    expect(screen.getByLabelText("供应商/模型: unknown-provider/model-b")).toBeInTheDocument();
    expect(screen.getByLabelText("推理强度: low")).toBeInTheDocument();
  });

  it("uses run metadata when no step exists and preserves an explicitly unknown effort", () => {
    const controller = getConversationController("a");
    controller.store.setState({
      session: { id: "a", activeRunId: "run-a", model: "custom-api:test/configured", reasoningEffort: "high" } as AgentSession,
      history: {
        ...controller.getSnapshot().history,
        runs: [{ id: "run-a", sessionId: "a", model: "custom-api:test/run-model", metadata: { reasoningEffort: null }, startedAt: "2026-10-30T00:00:00Z" } as AgentRun],
      },
    });
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "en" } }));
    useSessionWorkspaceStore.getState().openSubagent("parent", "a", "Lin");
    render(<Harness />);
    expect(screen.getByLabelText("Provider/model: 测试供应商/run-model")).toBeInTheDocument();
    expect(screen.getByLabelText("Reasoning effort: —")).toBeInTheDocument();
    expect(screen.queryByText(/parent conversation stays open/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View subagent fullscreen" }));
    expect(screen.queryByText(/Esc to return to split view/)).toBeNull();
  });

  it("toggles fullscreen and returns with Escape without remounting the conversation", () => {
    useSessionWorkspaceStore.getState().openSubagent("parent", "a", "林墨");
    render(<Harness />);
    const transcript = screen.getByText("记录 a");
    fireEvent.click(screen.getByRole("button", { name: "全屏查看子代理对话" }));
    expect(screen.getByRole("button", { name: "退出子代理全屏" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("记录 a")).toBe(transcript);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "全屏查看子代理对话" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("记录 a")).toBe(transcript);
    fireEvent.click(screen.getByRole("button", { name: "全屏查看子代理对话" }));
    fireEvent.click(screen.getByRole("button", { name: "退出子代理全屏" }));
    expect(useSessionWorkspaceStore.getState().sessions.parent.subagent?.fullscreen).toBe(false);
  });

  it("hides before any child exists and retains an icon without a count after completion", () => {
    const view = render(<Harness />);
    expect(screen.queryByRole("button", { name: /子代理，/ })).toBeNull();
    snapshot.subagents = [child("a", "completed")];
    view.rerender(<Harness />);
    expect(screen.getByRole("button", { name: "子代理" })).toBeInTheDocument();
    expect(document.querySelector(".subagent-island-count")).toBeNull();
  });

  it("counts only running children and updates when states change", () => {
    snapshot.subagents = [child("a", "running"), child("b", "waiting_input"), child("c", "failed"), child("d", "queued")];
    const view = render(<Harness />);
    expect(screen.getByRole("button", { name: "子代理，1 个工作中" })).toBeInTheDocument();
    expect(document.querySelector(".subagent-island-count")).toHaveTextContent("1");
    snapshot.subagents[0] = child("a", "completed");
    view.rerender(<Harness />);
    expect(screen.getByRole("button", { name: "子代理" })).toBeInTheDocument();
    expect(document.querySelector(".subagent-island-count")).toBeNull();
  });

  it("opens, switches and closes the child pane while keeping the parent visible", async () => {
    snapshot.subagents = [child("a", "running"), child("b", "completed")];
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "子代理，1 个工作中" }));
    const first = await screen.findByRole("button", { name: /林墨.*检查布局/ });
    fireEvent.click(first);
    expect(await screen.findByText("记录 a")).toBeInTheDocument();
    expect(screen.getByText("主对话 parent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /林墨.*检查布局/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "子代理，1 个工作中" }));
    fireEvent.click(await screen.findByRole("button", { name: /江岚.*检查布局/ }));
    expect(await screen.findByText("记录 b")).toBeInTheDocument();
    expect(screen.queryByText("记录 a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(screen.queryByText("记录 b")).toBeNull();
    expect(screen.getByText("主对话 parent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "子代理，1 个工作中" })).toHaveFocus();
  });

  it("orders failed children first and supports Escape dismissal", async () => {
    snapshot.subagents = [child("a", "completed"), child("b", "failed")];
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    const failed = await screen.findByRole("button", { name: /江岚.*检查布局/ });
    const rows = document.querySelectorAll(".subagent-island-row");
    expect(rows[0]).toBe(failed);
    fireEvent.keyDown(failed, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /江岚.*检查布局/ })).toBeNull());
  });

  it("does not show the previous parent's selected child when switching conversations", () => {
    snapshot.subagents = [child("a", "running")];
    act(() => useSessionWorkspaceStore.getState().openSubagent("parent", "a", "林墨"));
    const view = render(<Harness />);
    expect(screen.getByText("记录 a")).toBeInTheDocument();
    snapshot.subagents = [];
    view.rerender(<Harness owner="other" />);
    expect(screen.queryByText("记录 a")).toBeNull();
  });
});
