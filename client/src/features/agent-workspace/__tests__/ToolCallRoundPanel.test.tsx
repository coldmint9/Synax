import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolCallRoundPanel } from "../ToolCallRoundPanel";
import { useShellStore } from "../../../shared/state/shellStore";
import type { ToolCallView } from "../buildInterleavedTurns";

const toolCall = (id: string): ToolCallView => ({
  id, toolId: "file.read", inputSummary: id + ".ts", outputSummary: "Read file",
  status: "completed", category: "read", duration: "5ms", mutability: "read",
});

describe("ToolCallRoundPanel continuous rows", () => {
  beforeEach(() => {
    useShellStore.setState((s) => ({ preferences: { ...s.preferences, locale: "zh", sessionShowThinking: true } }));
  });
  it("does not leave an empty panel for placeholder reasoning", () => {
    const { container } = render(<ToolCallRoundPanel toolBlocks={[{ type: "thinking", content: "..." }]} isStreaming />);
    expect(container).toBeEmptyDOMElement();
  });
  it("keeps all thoughts and tools in source order with lazy reasoning bodies", () => {
    const { container } = render(<ToolCallRoundPanel isStreaming toolBlocks={[
      { type: "thinking", content: "First thought" }, { type: "tool_call", call: toolCall("one") },
      { type: "thinking", content: "Second thought" }, { type: "tool_call", call: toolCall("two") },
    ]} />);
    expect([...container.querySelector(".bui-tool-list")!.children].map((row) => row.textContent)).toEqual([
      expect.stringContaining("First thought"), expect.stringContaining("one.ts"),
      expect.stringContaining("Second thought"), expect.stringContaining("two.ts"),
    ]);
    expect(container.querySelectorAll("[data-activity-body]")).toHaveLength(0);
    act(() => useShellStore.getState().setSessionShowThinking(false));
    expect(container.querySelectorAll(".bui-thinking")).toHaveLength(0);
    expect(container.querySelectorAll(".bui-tool")).toHaveLength(2);
  });
  it("preserves reasoning DOM as tools arrive", () => {
    const thought = { type: "thinking" as const, content: "Inspect before editing" };
    const { container, rerender } = render(<ToolCallRoundPanel toolBlocks={[thought]} isStreaming />);
    const row = container.querySelector(".bui-thinking");
    rerender(<ToolCallRoundPanel toolBlocks={[thought, { type: "tool_call", call: toolCall("append") }]} isStreaming />);
    expect(container.querySelector(".bui-thinking")).toBe(row);
    expect(row?.querySelector("button")).toHaveAttribute("aria-expanded", "false");
  });
  it("shows every parallel target and reveals its individual calls in place", () => {
    const { container, getByRole } = render(<ToolCallRoundPanel toolBlocks={[
      { type: "tool_call_group", calls: [toolCall("one"), toolCall("two")] },
    ]} />);
    expect(container).toHaveTextContent("2 个并行调用");
    expect(container).toHaveTextContent("one.ts · two.ts");
    expect(container.querySelector(".bui-tool-batch-body")).toBeNull();
    fireEvent.click(getByRole("button"));
    expect(container.querySelectorAll(".bui-tool-batch-body > .bui-tool")).toHaveLength(2);
  });
  it("surfaces failed parallel calls without expanding the group", () => {
    const { container } = render(<ToolCallRoundPanel toolBlocks={[
      { type: "tool_call_group", calls: [toolCall("one"), { ...toolCall("two"), status: "failed", outputSummary: "Permission denied" }] },
    ]} />);
    expect(container.querySelector(".bui-tool-result")).toHaveTextContent("Permission denied");
    expect(container.querySelector(".bui-tool-batch-body")).toBeNull();
  });
});
