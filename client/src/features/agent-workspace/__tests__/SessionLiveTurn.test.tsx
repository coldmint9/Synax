import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunStep } from "../../../adapters/transport/agentRuntime";
import type { TurnContentBlock } from "../buildInterleavedTurns";
import { SessionLiveTurn } from "../SessionLiveTurn";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";

vi.mock("../ThinkingBlock", () => ({
  ThinkingBlock: ({ content }: { content: string }) => <div>{content}</div>,
}));
const blocks: TurnContentBlock[] = [
  { type: "thinking", content: "Locating BUI styles elsewhere" },
  {
    type: "tool_call",
    call: {
      id: "call-1",
      toolId: "rg",
      inputSummary: "bui-tool|bui-activity|StreamingTextBlock",
      outputSummary: "Found matches",
      status: "completed",
      duration: "55ms",
    },
  },
];
const snapshot = { stepId: "step-1", stepIndex: 1, blocks };
const persisted: AgentRunStep = {
  id: "step-1",
  runId: "run-1",
  sessionId: "session-1",
  index: 1,
  status: "completed",
  model: "test",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z",
  finishReason: "tool-calls",
  metadata: {},
};
const props = {
  steps: [] as AgentRunStep[],
  streamingStepId: "step-2",
  streamingLive: EMPTY_STREAMING_BUFFERS,
  streamingCompletedSteps: [snapshot],
};

describe("SessionLiveTurn", () => {
  it("keeps a snapshot until the store confirms its persisted content", () => {
    const { rerender, container } = render(<SessionLiveTurn {...props} />);
    expect(container.querySelectorAll(".session-activity-group")).toHaveLength(1);

    rerender(<SessionLiveTurn {...props} steps={[persisted]} />);
    expect(container.querySelectorAll(".session-activity-group")).toHaveLength(1);
    rerender(<SessionLiveTurn {...props} steps={[persisted]} streamingCompletedSteps={[]} />);
    expect(screen.queryByText("Locating BUI styles elsewhere")).toBeNull();
    expect(screen.getByTestId("thinking-indicator")).toContainElement(screen.getByRole("status"));
    expect(screen.getByRole("status")).toHaveAccessibleName();
  });

  it("keeps an unsynced step even when its contents match a persisted step", () => {
    const { container } = render(
      <SessionLiveTurn
        {...props}
        steps={[persisted]}
        streamingCompletedSteps={[
          snapshot,
          { ...snapshot, stepId: "other-step", stepIndex: 2 },
        ]}
      />,
    );
    expect(container.querySelectorAll(".session-activity-group")).toHaveLength(2);
  });

  it("renders nothing when history owns every step and there is no active stream", () => {
    const { container } = render(
      <SessionLiveTurn {...props} steps={[persisted]} streamingStepId={null} streamingCompletedSteps={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("keeps the current running step in the live layer", () => {
    const { container } = render(
      <SessionLiveTurn
        {...props}
        steps={[{ ...persisted, status: "running" }]}
        streamingStepId="step-1"
        streamingCompletedSteps={[]}
        streamingLive={{ ...EMPTY_STREAMING_BUFFERS, blocks }}
      />,
    );
    expect(screen.queryByText("Locating BUI styles elsewhere")).toBeNull();
    expect(screen.getByText("正在搜索代码")).toBeInTheDocument();
    expect(
      screen.getAllByText("bui-tool|bui-activity|StreamingTextBlock"),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('.session-process-window-viewport[data-windowed="true"]'),
    ).toHaveLength(1);
  });

  it("folds prior activity while keeping the streamed final answer visible", async () => {
    render(
      <SessionLiveTurn
        {...props}
        streamingStepId="step-1"
        streamingCompletedSteps={[]}
        streamingLive={{
          ...EMPTY_STREAMING_BUFFERS,
          blocks: [...blocks, { type: "text", content: "Final answer" }],
        }}
      />,
    );

    expect(
      document.querySelectorAll(
        '.session-process-window-viewport[data-windowed="true"] .bui-tool',
      ),
    ).toHaveLength(0);
    expect(document.querySelector(".session-process-trigger")).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByText("Final answer")).toBeVisible();
  });

  it("retains every thought row of a live step in order", () => {
    render(
      <SessionLiveTurn
        {...props}
        streamingCompletedSteps={[
          {
            ...snapshot,
            blocks: [
              { type: "thinking", content: "First thought" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  toolId: "rg",
                  inputSummary: "bui-tool",
                  outputSummary: "Found matches",
                  status: "completed",
                  duration: "55ms",
                },
              },
              { type: "thinking", content: "Second thought" },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(document.querySelector(".session-process-trigger")!);
    expect(screen.getByText("First thought")).toBeTruthy();
    expect(screen.getByText("Second thought")).toBeTruthy();
  });
});
