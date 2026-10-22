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

  it("keeps commentary in source order outside independently folded activity groups", () => {
    const blocks: TurnContentBlock[] = [
      { type: "thinking", content: "First thought" }, tool("one"),
      { type: "text", content: "Progress update" },
      { type: "thinking", content: "Second thought" }, tool("two"),
      { type: "text", content: "Final answer" },
    ];
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks }} entryId="ordered" isWorking />);
    const rows = [...container.querySelector(".session-flow-content")!.children];
    expect(rows.map((row) => row.textContent)).toEqual([
      "运行了命令", "Progress update", "运行了命令", "Final answer",
    ]);
    expect(container.querySelectorAll(".session-process-trigger[aria-expanded='false']")).toHaveLength(2);
    fireEvent.click(rows[0].querySelector("button")!);
    expect(rows[0]).toHaveTextContent("command-one");
    expect(rows[0]).not.toHaveTextContent("result-one");
    expect(screen.getByText("Progress update")).toBeVisible();
    expect(screen.getByText("Final answer")).toBeVisible();
  });

  it("keeps live rows closed and preserves DOM identity as calls are appended", () => {
    const first = tool("stable-one");
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [first] }} entryId="stable" isWorking />);
    const row = container.querySelector(".bui-tool")!;
    const trigger = container.querySelector(".bui-tool-trigger")!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".bui-tool-details")).toBeNull();
    rerender(<TurnBody turn={{ ...emptyTurn, blocks: [first, tool("stable-two")] }} entryId="stable" isWorking />);
    expect(container.querySelector(".bui-tool")).toBe(row);
    expect(container.querySelector(".bui-tool-trigger")).toBe(trigger);
    expect(container.querySelector(".bui-tool-details")).toBeNull();
  });

  it("opens a live record by handing the window to the reader", () => {
    const { container } = render(
      <TurnBody turn={{ ...emptyTurn, blocks: [tool("opened-live")] }} entryId="opened-live" isWorking />,
    );
    const viewport = container.querySelector(".session-process-window-viewport")!;
    expect(viewport).toHaveAttribute("data-windowed", "true");
    fireEvent.click(container.querySelector(".bui-tool-trigger")!);
    // The fixed one-line window cannot hold an open body, so it stops following
    // the newest record instead of swallowing the reader's disclosure.
    expect(viewport).not.toHaveAttribute("data-windowed");
    expect(container.querySelector(".bui-tool-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".bui-tool-details")).toHaveTextContent("result-opened-live");
  });

  it("opens finished tool details on demand", () => {
    const { container } = render(<TurnBody turn={{ ...emptyTurn, status: "completed", blocks: [tool("settled")] }} entryId="settled" />);
    fireEvent.click(container.querySelector(".session-process-trigger")!);
    const button = container.querySelector(".bui-tool-trigger")!;
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".bui-tool-details")).toHaveTextContent("result-settled");
  });

  it("settles the live group into a quiet summary when the answer arrives", () => {
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [tool("live")] }} entryId="live" isWorking />);
    const header = container.querySelector(".session-process-trigger")!;
    expect(header).toHaveAttribute("aria-expanded", "true");
    rerender(<TurnBody turn={{ ...emptyTurn, blocks: [tool("live"), { type: "text", content: "Final answer" }] }} entryId="live" isWorking />);
    expect(container.querySelector(".session-process-trigger")).toBe(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveTextContent("运行了命令");
    expect(header.querySelector(".bui-status")).toBeNull();
    expect(screen.getByText("Final answer")).toBeVisible();
  });

  it("uses the current thought as the live toggle without duplicating it in the list", () => {
    const blocks: TurnContentBlock[] = [
      { type: "thinking", content: "**Setting up module symlinks**" }, tool("stream"),
    ];
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks }} entryId="stream" isWorking />);
    const header = container.querySelector(".session-process-trigger")!;
    expect(header.querySelector(".session-process-line")?.textContent).toBe("Setting up module symlinks");
    expect(header).toHaveAttribute("aria-label", "Setting up module symlinks");
    expect(header.querySelector(".session-process-chevron")).not.toBeNull();
    expect(container.querySelectorAll(".bui-thinking")).toHaveLength(0);
    expect(container.querySelector(".session-activity-group")).toHaveAttribute("data-live", "true");
  });

  it("reports the latest command when no thought is available", () => {
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks: [tool("call-line")] }} entryId="call-line" isWorking />);
    expect(container.querySelector(".session-process-line")).toHaveTextContent("已在 10ms 内运行 command-call-line");
  });

  it("restores manually expanded groups and tool details after history remounts", () => {
    const turn = { ...emptyTurn, blocks: [tool("remembered")] };
    const first = render(<TurnBody turn={turn} entryId="remembered-entry" />);
    fireEvent.click(first.container.querySelector(".session-process-trigger")!);
    fireEvent.click(first.container.querySelector(".bui-tool-trigger")!);
    first.unmount();
    const second = render(<TurnBody turn={turn} entryId="remembered-entry" />);
    expect(second.container.querySelector(".bui-tool-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(second.container.querySelector(".bui-tool-details")).toHaveTextContent("result-remembered");
  });

  it("preserves a manual expansion when execution finishes", () => {
    const turn = { ...emptyTurn, blocks: [tool("manual")] };
    const { container, rerender } = render(<TurnBody turn={turn} entryId="manual" isWorking />);
    const header = container.querySelector(".session-process-trigger")!;
    fireEvent.click(header);
    fireEvent.click(header);
    rerender(<TurnBody turn={{ ...turn, status: "completed" }} entryId="manual" />);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-live]")).toBeNull();
  });

  it("keeps an error out of the summary and shows it on expansion", () => {
    const failed: TurnContentBlock = { type: "tool_call", call: { ...call("error"), status: "failed", outputSummary: "Test failed: button remains enabled" } };
    const { container } = render(<TurnBody turn={{ ...emptyTurn, blocks: [failed] }} entryId="failed" />);
    const trigger = container.querySelector(".session-process-trigger")!;
    expect(trigger).toHaveTextContent("运行了命令");
    expect(trigger).not.toHaveTextContent("失败");
    expect(trigger.querySelector(".bui-status")).toBeNull();
    fireEvent.click(container.querySelector(".session-process-trigger")!);
    expect(container.querySelector(".bui-tool-result")).toHaveTextContent("Test failed");
    expect(container.querySelector(".bui-tool-details")).toBeNull();
  });

  it("shows the waiting indicator for an empty live turn only", () => {
    const { container, rerender } = render(<TurnBody turn={emptyTurn} entryId="empty" isStreaming />);
    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute("role", "status");
    rerender(<TurnBody turn={{ ...emptyTurn, status: "completed" }} entryId="empty" />);
    expect(container.querySelector('[data-testid="thinking-indicator"]')).toBeNull();
  });

  it("reveals new streamed content without replaying entry motion on completion", () => {
    const { container, rerender } = render(<TurnBody turn={{ ...emptyTurn, blocks: [tool("streamed")] }} entryId="streamed" isStreaming />);
    const flow = container.querySelector(".session-conversation-flow");
    expect(flow).toHaveClass("session-flow-append");
    rerender(<TurnBody turn={{ ...emptyTurn, status: "completed", blocks: [tool("streamed")] }} entryId="streamed" />);
    expect(container.querySelector(".session-conversation-flow")).toBe(flow);
    expect(flow).toHaveClass("session-flow-append");
  });

  it("does not animate a turn restored from history", () => {
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
