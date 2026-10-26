import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeMessage, AgentSession } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { SubSessionCard } from "../SubSessionCard";
import { buildSubagentInteractions } from "../subagentInteractions";

const api = vi.hoisted(() => ({ getSessionSummary: vi.fn(), listMessages: vi.fn() }));
vi.mock("../../../adapters/transport/agentRuntime", () => ({ agentRuntimeApi: api }));
vi.mock("../SubagentControls", () => ({ SubagentControls: () => null }));

const session = {
  id: "child", parentSessionId: "parent", profileId: "subagent", status: "running",
  title: "实现 Rust 历史截断", prompt: "实现历史截断，并验证恢复后的消息顺序。",
  createdAt: "2026-10-25T08:00:00.000Z", updatedAt: "2026-10-25T08:01:00.000Z",
  completedAt: null, resultSummary: null, blockedReason: null,
  sessionMetadata: { subagentName: "锈核", roleName: "开发者" },
} as AgentSession;
function message(id: string, role: AgentRuntimeMessage["role"], content: string, metadata = {}): AgentRuntimeMessage {
  return { id, sessionId: session.id, runId: "run", stepId: null, role, content, metadata, createdAt: `2026-10-25T08:0${id}:00.000Z` };
}
const exchanges = [
  message("0", "user", session.prompt),
  message("1", "assistant", "已定位历史恢复入口，正在补齐截断逻辑。"),
  message("2", "user", "补充验证重复截断和空会话。"),
  message("3", "assistant", "已补齐两个边界用例，正在运行测试。"),
];
const toggle = () => screen.getByRole("button", { name: /实现 Rust 历史截断/ });
async function expand() {
  await act(async () => fireEvent.click(toggle()));
}

beforeEach(() => {
  vi.resetAllMocks();
  useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "zh" } }));
  api.getSessionSummary.mockResolvedValue({ session });
  api.listMessages.mockResolvedValue({ items: exchanges });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("subagent interaction projection", () => {
  it("orders both directions, removes duplicate records and excludes internal content", () => {
    const items = buildSubagentInteractions(session, [
      ...exchanges.slice().reverse(), exchanges[1],
      message("4", "assistant", "私有推理", { type: "thinking" }),
      message("10", "tool", "工具输出"),
      message("5", "assistant", "压缩上下文", { source: "context_compaction" }),
      message("6", "system", "系统提示"),
      { ...message("7", "assistant", "其他子代理"), sessionId: "other-child" },
      message("8", "assistant", "内部思考", { kind: "thought" }),
      message("9", "user", "注入上下文", { source: "system_injection" }),
      message("11", "assistant", "Background command completion (untrusted output data): {}", { source: "command_completion" }),
    ]);
    expect(items.map((item) => item.content)).toEqual(exchanges.map((item) => item.content));
    expect(items.map((item) => item.kind)).toEqual(["assignment", "progress", "instruction", "progress"]);
  });

  it("uses the prompt before messages arrive and does not duplicate the final answer", () => {
    expect(buildSubagentInteractions(session, [])[0]).toMatchObject({ kind: "assignment", content: session.prompt });
    const completed = { ...session, status: "completed" as const, resultSummary: exchanges[3].content };
    const items = buildSubagentInteractions(completed, exchanges);
    expect(items).toHaveLength(4);
    expect(items[3].kind).toBe("result");
    expect(buildSubagentInteractions({ ...session, resultSummary: "上轮结果" }, exchanges).some((item) => item.content === "上轮结果")).toBe(false);
  });

  it("keeps a blocked reason visible even when there is no final result", () => {
    const items = buildSubagentInteractions({ ...session, status: "failed", blockedReason: "无法读取历史文件。" }, []);
    expect(items[items.length - 1]).toMatchObject({ kind: "blocked", content: "无法读取历史文件。" });
  });
});

describe("SubSessionCard interaction summary", () => {
  it("loads only on expansion and displays assignment, follow-up and feedback", async () => {
    const onExpand = vi.fn();
    render(<SubSessionCard session={session} onExpand={onExpand} />);
    expect(api.listMessages).not.toHaveBeenCalled();
    await expand();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "主子代理交互摘要" })).toBeVisible();
    expect(screen.getByText("任务委派")).toBeVisible();
    expect(screen.getByText("补充指令")).toBeVisible();
    expect(screen.getAllByText("主代理 → 子代理")).toHaveLength(2);
    expect(screen.getAllByText("子代理 → 主代理")).toHaveLength(2);
    for (const exchange of exchanges) expect(screen.getByText(exchange.content)).toBeVisible();
    expect(screen.queryByText("执行中...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(onExpand).toHaveBeenCalledWith(session.id);
    fireEvent.click(toggle());
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("shows the actual assignment while the first feedback is pending", async () => {
    api.listMessages.mockResolvedValue({ items: [] });
    render(<SubSessionCard session={session} />);
    await expand();
    expect(screen.getByText(session.prompt)).toBeVisible();
    expect(screen.getByText("任务已下发，等待子代理反馈。")).toBeVisible();
  });

  it("refreshes feedback and stops polling when the child completes or the card collapses", async () => {
    vi.useFakeTimers();
    render(<SubSessionCard session={session} />);
    await expand();
    api.getSessionSummary.mockResolvedValue({ session: { ...session, status: "completed", updatedAt: "2026-10-25T08:05:00.000Z", resultSummary: "测试已通过。" } });
    api.listMessages.mockResolvedValue({ items: [...exchanges, message("4", "assistant", "测试已通过。")] });
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByText("结果回报")).toBeVisible();
    expect(screen.getAllByText("测试已通过。")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(12000));
    expect(api.listMessages).toHaveBeenCalledTimes(2);
    fireEvent.click(toggle());
    api.getSessionSummary.mockResolvedValue({ session });
    await expand();
    fireEvent.click(toggle());
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(api.listMessages).toHaveBeenCalledTimes(3);
  });

  it("retains existing content after a refresh failure and lets the user retry", async () => {
    vi.useFakeTimers();
    render(<SubSessionCard session={session} />);
    await expand();
    api.listMessages.mockRejectedValueOnce(new Error("offline"));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByRole("status")).toHaveTextContent("交互记录暂时无法更新");
    expect(screen.getByText(exchanges[3].content)).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the assignment and latest feedback visible with optional older and longer content", async () => {
    const long = "验证历史恢复和截断边界。".repeat(40);
    api.listMessages.mockResolvedValue({ items: [exchanges[0], ...Array.from({ length: 8 }, (_, i) => message(String(i + 1), "assistant", i === 7 ? long : `反馈 ${i + 1}`))] });
    render(<SubSessionCard session={session} />);
    await expand();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText(session.prompt)).toBeVisible();
    expect(screen.queryByText("反馈 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看更早的 3 条交互" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByText("反馈 1")).toBeVisible();
    expect(screen.queryByText(long)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开内容" }));
    expect(screen.getByText(long)).toBeVisible();
  });

  it("ignores late responses after switching to a different child", async () => {
    let resolve!: (value: { items: AgentRuntimeMessage[] }) => void;
    api.listMessages.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { rerender } = render(<SubSessionCard session={session} />);
    await expand();
    const other = { ...session, id: "other-child", prompt: "检查文件权限。" };
    rerender(<SubSessionCard session={other} />);
    api.getSessionSummary.mockResolvedValue({ session: other });
    api.listMessages.mockResolvedValue({ items: [] });
    await expand();
    await act(async () => resolve({ items: exchanges }));
    expect(screen.getByText(other.prompt)).toBeVisible();
    expect(screen.queryByText(exchanges[3].content)).not.toBeInTheDocument();
  });

  it("localizes the interaction labels", async () => {
    useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "en" } }));
    render(<SubSessionCard session={session} />);
    await expand();
    expect(screen.getByRole("region", { name: "Parent and subagent interaction summary" })).toBeVisible();
    expect(screen.getByText("Assignment")).toBeVisible();
    expect(screen.getByText("Follow-up")).toBeVisible();
  });
});
