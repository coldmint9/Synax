import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolCallRoundPanel } from "../ToolCallRoundPanel";

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
});
