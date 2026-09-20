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
  it("keeps the latest activity waiting after tools finish, and removes the dots when collapsed or stopped", () => {
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
    expect(container.querySelectorAll("[data-thinking-dot]")).toHaveLength(3);
    expect(
      container.querySelector("[data-activity-body] [data-thinking-dot]"),
    ).toBeNull();

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
    expect(container.querySelector(".bui-thinking")).toHaveAttribute(
      "data-live",
      "true",
    );
    fireEvent.click(heading);
    expect(container.querySelectorAll("[data-thinking-dot]")).toHaveLength(3);

    rerender(<TurnBody turn={turn} entryId="entry-1" isWorking={false} />);
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("shows the thinking dots while a streaming turn is waiting for content", () => {
    const { container } = render(
      <TurnBody turn={emptyTurn} entryId="entry-1" isStreaming />,
    );

    expect(container.querySelectorAll("[data-thinking-dot]")).toHaveLength(3);
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
