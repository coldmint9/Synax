import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { InterleavedTurn } from "../buildInterleavedTurns";
import { TurnBody } from "../TurnBody";
import { useShellStore } from "../../../shared/state/shellStore";

const emptyTurn: InterleavedTurn = {
  stepId: "step-1",
  index: 0,
  status: "running",
  duration: null,
  blocks: [],
};

describe("TurnBody", () => {
  beforeEach(() => {
    useShellStore.setState((s) => ({ preferences: { ...s.preferences, locale: "zh", sessionShowThinking: true } }));
  });
  it("keeps the live header loader after tools finish and collapse", () => {
    const turn: InterleavedTurn = {
      ...emptyTurn,
      status: "completed",
      blocks: [
        {
          type: "tool_call",
          call: {
            id: "call-1",
            toolId: "bash",
            inputSummary: "pwd",
            outputSummary: "/workspace",
            status: "completed",
            duration: "10ms",
          },
        },
      ],
    };
    const { container, rerender } = render(
      <TurnBody turn={turn} entryId="entry-1" isWorking />,
    );
    const heading = container.querySelector(
      ".bui-thinking-trigger",
    ) as HTMLButtonElement;
    expect(container.querySelector(".bui-thinking")).toHaveAttribute(
      "data-live",
      "true",
    );
    // Tool activity keeps its live loader even when the completed calls are folded.
    expect(heading.querySelectorAll(".loading-state-cell")).toHaveLength(9);
    expect(heading.querySelector('[role="status"]')).toHaveTextContent("执行命令 · pwd");
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('[data-activity-body] [role="timer"]')).toBeNull();
    expect(container.querySelector('[data-activity-body] .loading-state-cell')).toBeNull();
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".bui-thinking-reveal")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(heading.querySelectorAll(".loading-state-cell")).toHaveLength(9);
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
    expect(container.querySelector(".bui-thinking")).toHaveAttribute(
      "data-live",
      "true",
    );
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(heading.querySelectorAll(".loading-state-cell")).toHaveLength(9);

    rerender(<TurnBody turn={turn} entryId="entry-1" isWorking={false} />);
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(container.querySelector(".loading-state-cell")).toBeNull();
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("shows an accessible thinking status while a streaming turn is waiting for content", () => {
    const { container } = render(
      <TurnBody turn={emptyTurn} entryId="entry-1" isStreaming />,
    );

    expect(container.querySelector('[data-testid="thinking-indicator"]')).toHaveAttribute("role", "status");
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("keeps the activity rail open while the final answer is streaming", () => {
    const turn: InterleavedTurn = {
      ...emptyTurn,
      blocks: [
        {
          type: "tool_call",
          call: {
            id: "call-1",
            toolId: "bash",
            inputSummary: "pwd",
            outputSummary: "/workspace",
            status: "completed",
            duration: "10ms",
          },
        },
        { type: "text", content: "Final answer" },
      ],
    };
    const { container } = render(
      <TurnBody turn={turn} entryId="entry-final-answer" isWorking />,
    );

    expect(container.querySelector(".bui-thinking")).toHaveAttribute(
      "data-live",
      "true",
    );
    expect(
      container.querySelector(".session-answer-region"),
    ).toHaveTextContent("Final answer");
  });

  it("does not show a thinking status for an empty completed turn", () => {
    const { container } = render(
      <TurnBody
        turn={{ ...emptyTurn, status: "completed" }}
        entryId="entry-1"
      />,
    );

    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("mounts only the newest thought row of the work log", () => {
    const turn: InterleavedTurn = {
      ...emptyTurn,
      status: "running",
      blocks: [
        { type: "thinking", content: "First thought" },
        { type: "thinking", content: "Second thought" },
      ],
    };
    const { container } = render(
      <TurnBody turn={turn} entryId="entry-1" isWorking />,
    );

    const rows = container.querySelectorAll(
      '.bui-thinking[data-variant="reasoning"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Second thought");
    expect(container).not.toHaveTextContent("First thought");
  });
});
