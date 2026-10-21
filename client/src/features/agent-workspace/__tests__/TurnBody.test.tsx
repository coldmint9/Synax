import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { InterleavedTurn, ToolCallView, TurnContentBlock } from "../buildInterleavedTurns";
import { TurnBody } from "../TurnBody";
import { useShellStore } from "../../../shared/state/shellStore";

const emptyTurn: InterleavedTurn = { stepId: "step-1", index: 0, status: "running", duration: null, completedAt: null, blocks: [] };
const call = (id: string): ToolCallView => ({
  id, toolId: "bash", inputSummary: "command-" + id, outputSummary: "result-" + id,
  status: "completed", category: "exec", duration: "10ms", mutability: "read",
});
const tool = (id: string): TurnContentBlock => ({ type: "tool_call", call: call(id) });

describe("TurnBody continuous process", () => {
  beforeEach(() => {
    useShellStore.setState((s) => ({ preferences: { ...s.preferences, locale: "zh", sessionShowThinking: true } }));
  });

  it("preserves thoughts, calls, commentary and results in source order", () => {
    const blocks: TurnContentBlock[] = [
      { type: "thinking", content: "First thought" }, tool("one"),
      { type: "text", content: "Progress update" },
      { type: "thinking", content: "Second thought" }, tool("two"),
      { type: "text", content: "Final answer" },
    ];
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks }} entryId="ordered" isWorking />);
    const rows = [...container.querySelectorAll(".session-flow-entry")];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("First thought"), expect.stringContaining("result-one"),
      expect.stringContaining("Progress update"), expect.stringContaining("Second thought"),
      expect.stringContaining("result-two"), expect.stringContaining("Final answer"),
    ]);
    // Folded records preview how they ended; the input stays behind a click.
    expect(rows[1]).not.toHaveTextContent("command-one");
    expect(container.querySelectorAll("[data-activity-body]")).toHaveLength(0);
    expect(rows[5]).not.toHaveAttribute("data-process");
  });

  it("keeps open tool details and DOM identity when another call is appended", () => {
    const first = tool("stable-one");
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [first] }} entryId="stable" isWorking />);
    const button = container.querySelector(".bui-tool-trigger")!;
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    rerender(<TurnBody turn={{ ...emptyTurn, blocks: [first, tool("stable-two")] }} entryId="stable" isWorking />);
    expect(container.querySelector(".bui-tool-trigger")).toBe(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".bui-tool-details")).toHaveTextContent("result-stable-one");
  });

  it("keeps the process open as an answer arrives and the turn completes", () => {
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [tool("live")] }} entryId="live" isWorking />);
    const header = container.querySelector(".session-process-trigger");
    // A live row reads as the streaming activity line; it no longer reports "进行中".
    expect(header?.querySelector(".bui-status")).toBeNull();
    const turn = { ...emptyTurn, blocks: [tool("live"), { type: "text" as const, content: "Final answer" }] };
    rerender(<TurnBody turn={turn} entryId="live" isWorking />);
    expect(container.querySelector(".session-process-trigger")).toBe(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    rerender(<TurnBody turn={{ ...turn, status: "completed" }} entryId="live" />);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header?.querySelector(".bui-status")).toHaveAttribute("data-state", "completed");
  });

  it("streams the tail of the newest thought into one fixed line", () => {
    const blocks: TurnContentBlock[] = [
      { type: "thinking", content: "First thought" },
      tool("stream"),
      { type: "thinking", content: "Older line\nNewest thought tail" },
    ];
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks }} entryId="stream" isWorking />);
    const header = container.querySelector(".session-process-trigger")!;
    expect(header.querySelector(".session-process-line")?.textContent).toBe(
      "正在思考:「Older line Newest thought tail」",
    );
    expect(header.querySelector(".bui-status")).toBeNull();
    expect(header.querySelector(".session-process-chevron")).toBeNull();
    // A finished row goes back to the call-count summary.
    rerender(<TurnBody turn={{ ...emptyTurn, status: "completed", blocks }} entryId="stream" />);
    expect(header.querySelector(".session-process-line")).toBeNull();
    expect(header).toHaveTextContent("处理过程");
  });

  it("reports the newest call once a live turn stops thinking", () => {
    const blocks: TurnContentBlock[] = [
      { type: "thinking", content: "Planning the change" },
      tool("call-line"),
    ];
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks }} entryId="call-line" isWorking />);
    expect(container.querySelector(".session-process-line")?.textContent).toBe(
      "最近调用:「执行命令 · command-call-line」",
    );
  });

  it("restores manually expanded tool details after history remounts", () => {
    const turn = { ...emptyTurn, blocks: [tool("remembered")] };
    const first = render(<TurnBody turn={turn} entryId="remembered-entry" />);
    fireEvent.click(first.container.querySelector(".bui-tool-trigger")!);
    first.unmount();
    const second = render(<TurnBody turn={turn} entryId="remembered-entry" />);
    expect(second.container.querySelector(".bui-tool-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(second.container.querySelector(".bui-tool-details")).toHaveTextContent("result-remembered");
  });

  it("allows folding the process without hiding the final answer", () => {
    const turn = { ...emptyTurn, blocks: [tool("fold"), { type: "text" as const, content: "Final answer" }] };
    const { container, rerender } = render(<TurnBody turn={turn} entryId="fold" isWorking />);
    const header = container.querySelector(".session-process-trigger")!;
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-process]")).not.toBeVisible();
    expect(screen.getByText("Final answer")).toBeVisible();
    rerender(<TurnBody turn={{ ...turn, status: "completed" }} entryId="fold" />);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("shows errors in their tool row without opening details", () => {
    const failed: TurnContentBlock = { type: "tool_call", call: { ...call("error"), status: "failed", outputSummary: "Test failed: button remains enabled" } };
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks: [failed] }} entryId="failed" />);
    expect(container.querySelector(".bui-tool-result")).toHaveTextContent("Test failed");
    expect(container.querySelector(".bui-tool-details")).toBeNull();
    expect(container.querySelector(".session-process-trigger")).toHaveTextContent("失败");
  });

  it("shows the waiting indicator for an empty live turn only", () => {
    const { container, rerender } = render(<TurnBody turn={emptyTurn} entryId="empty" isStreaming />);
    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute("role", "status");
    rerender(<TurnBody turn={{ ...emptyTurn, status: "completed" }} entryId="empty" />);
    expect(container.querySelector('[data-testid="thinking-indicator"]')).toBeNull();
  });

  it("reveals rows appended while the turn streams and leaves history still", () => {
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [tool("streamed")] }} entryId="streamed" isStreaming isWorking />);
    const flow = container.querySelector(".session-conversation-flow");
    expect(flow).toHaveClass("session-flow-append");
    // Frozen at mount: finishing the turn must not replay the reveal, and the
    // rows already appended keep the class they animated with.
    rerender(<TurnBody turn={{ ...emptyTurn, status: "completed", blocks: [tool("streamed")] }} entryId="streamed" />);
    expect(flow).toHaveClass("session-flow-append");
    expect(flow?.querySelector(".session-flow-entry")).toBeInTheDocument();
  });

  it("does not reveal a turn restored from history", () => {
    const { container } = render(<TurnBody turn={{ ...emptyTurn, status: "completed", blocks: [tool("history")] }} entryId="history" />);
    expect(container.querySelector(".session-conversation-flow")).not.toHaveClass("session-flow-append");
  });

  it("renders reply actions only for the final reply row", () => {
    const turn = { ...emptyTurn, blocks: [{ type: "text" as const, content: "Final answer" }] };
    const { container, rerender } = render(<TurnBody turn={turn} entryId="actions" />);
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    rerender(<TurnBody turn={turn} entryId="actions" showActions={false} />);
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });
});
