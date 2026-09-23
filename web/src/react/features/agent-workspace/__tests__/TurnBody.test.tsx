import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { InterleavedTurn } from "../buildInterleavedTurns";
import { TurnBody } from "../TurnBody";

const emptyTurn: InterleavedTurn = {
  stepId: "step-1",
  index: 0,
  status: "running",
  duration: null,
  blocks: [],
};

describe("TurnBody", () => {
  it("keeps the live header loader after tools finish and collapse, but only times expanded activity", () => {
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
    // Tool activity uses a pixel loader in the header and a timer in the
    // expanded footer; the three-dot placeholder belongs to empty turns only.
    expect(heading.querySelectorAll(".loading-state-cell")).toHaveLength(9);
    expect(heading.querySelector('[role="status"]')).toHaveTextContent("bash · pwd");
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
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
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    expect(heading.querySelectorAll(".loading-state-cell")).toHaveLength(9);

    rerender(<TurnBody turn={turn} entryId="entry-1" isWorking={false} />);
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(container.querySelector(".loading-state-cell")).toBeNull();
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("shows the thinking dots while a streaming turn is waiting for content", () => {
    const { container } = render(
      <TurnBody turn={emptyTurn} entryId="entry-1" isStreaming />,
    );

    expect(container.querySelectorAll(".loading-state-cell")).toHaveLength(9);
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("does not show the thinking dots for an empty completed turn", () => {
    const { container } = render(
      <TurnBody
        turn={{ ...emptyTurn, status: "completed" }}
        entryId="entry-1"
      />,
    );

    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });
});
