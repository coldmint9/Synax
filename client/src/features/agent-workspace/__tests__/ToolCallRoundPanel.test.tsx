import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolCallRoundPanel } from "../ToolCallRoundPanel";
import type { ToolCallView } from "../buildInterleavedTurns";

describe("ToolCallRoundPanel placeholder reasoning", () => {
  it("keeps the latest activity visible without an idle preview carousel", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <ToolCallRoundPanel
          toolBlocks={[
            { type: "thinking", content: "First activity" },
            { type: "text", content: "Progress" },
            { type: "thinking", content: "Latest activity" },
          ]}
          isStreaming
        />,
      );
      const heading = container.querySelector(".bui-thinking-label");
      expect(heading).toHaveTextContent("Latest activity");
      act(() => vi.advanceTimersByTime(3000));
      expect(container.querySelector(".bui-thinking-label")).toBe(heading);
      expect(heading).toHaveTextContent("Latest activity");
      rerender(
        <ToolCallRoundPanel
          toolBlocks={[{ type: "thinking", content: "Finished activity" }]}
        />,
      );
      expect(container.querySelector(".bui-thinking-label")).toBe(heading);
      expect(heading).toHaveTextContent("Finished activity");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not leave an empty outer activity panel for a placeholder-only round", () => {
    const { container, rerender } = render(
      <ToolCallRoundPanel
        toolBlocks={[{ type: "thinking", content: "..." }]}
        isStreaming
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ToolCallRoundPanel
        toolBlocks={[{ type: "thinking", content: "..." }]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the tool preview when the last thought is a placeholder", () => {
    const { container } = render(
      <ToolCallRoundPanel
        toolBlocks={[
          {
            type: "tool_call",
            call: {
              id: "call-1",
              toolId: "file.read",
              inputSummary: "app.ts",
              outputSummary: "Read file",
              status: "completed",
              duration: "5ms",
            },
          },
          { type: "thinking", content: "..." },
        ]}
      />,
    );
    expect(container).toHaveTextContent("file.read · app.ts");
    expect(container).not.toHaveTextContent("...");
  });

  it("keeps the latest thought at the bottom while tools are appended", () => {
    const first = toolCall("call-1");
    const second = toolCall("call-2");
    const { container, rerender } = render(
      <ToolCallRoundPanel
        isStreaming
        toolBlocks={[
          { type: "thinking", content: "Thinking" },
          { type: "tool_call", call: first },
        ]}
      />,
    );

    const list = container.querySelector(".bui-tool-list");
    const thought = list?.querySelector(
      '.bui-thinking[data-variant="reasoning"]',
    );
    expect(list?.lastElementChild).toBe(thought);

    rerender(
      <ToolCallRoundPanel
        isStreaming
        toolBlocks={[
          { type: "thinking", content: "Thinking" },
          { type: "tool_call", call: first },
          { type: "tool_call", call: second },
        ]}
      />,
    );

    expect(list?.lastElementChild).toBe(thought);
    expect(list?.querySelectorAll(".bui-tool")).toHaveLength(2);
  });

  it("mounts only the newest reasoning row of the round", () => {
    const { container } = render(
      <ToolCallRoundPanel
        isStreaming
        toolBlocks={[
          { type: "thinking", content: "First thought" },
          { type: "tool_call", call: toolCall("call-1") },
          { type: "thinking", content: "Second thought" },
          { type: "tool_call", call: toolCall("call-2") },
          { type: "thinking", content: "Latest thought" },
        ]}
      />,
    );
    const rows = container.querySelectorAll(
      '.bui-thinking[data-variant="reasoning"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Latest thought");
    expect(container).not.toHaveTextContent("First thought");
    expect(container).not.toHaveTextContent("Second thought");
  });
});

function toolCall(id: string): ToolCallView {
  return {
    id,
    toolId: "bash",
    inputSummary: "pwd",
    outputSummary: "/workspace",
    status: "completed",
    category: "exec",
    duration: "5ms",
    mutability: "read",
  };
}
