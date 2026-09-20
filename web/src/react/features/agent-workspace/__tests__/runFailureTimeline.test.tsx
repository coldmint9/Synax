import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunStep } from "../../../../lib/api/agentRuntime";
import { buildConversationTimeline } from "../buildConversationTimeline";
import { groupActivityEntries } from "../groupActivityEntries";
import { TimelineEntryView } from "../TimelineEntryView";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh", t: (key: string) => key }),
}));

const failure: AgentRun = {
  id: "failed-run",
  sessionId: "session",
  status: "failed",
  startedAt: "2026-09-20T05:30:00Z",
  completedAt: "2026-09-20T05:30:03Z",
  triggerMessageId: null,
  currentStep: 1,
  stopReason: "Request failed with status code 400",
  model: "custom-api:kiro-local/claude-opus-5",
  metadata: {},
};
const step: AgentRunStep = {
  id: "failed-step",
  sessionId: "session",
  runId: failure.id,
  index: 1,
  status: "failed",
  startedAt: failure.startedAt,
  completedAt: failure.completedAt,
  model: failure.model,
  finishReason: null,
  metadata: {},
};

describe("failed runs in the conversation", () => {
  it.each([true, false])(
    "shows an empty failed model call instead of a work log (fold=%s)",
    (foldWorkRuns) => {
      const entries = groupActivityEntries(
        buildConversationTimeline([failure], [step], [], [], undefined, {
          foldWorkRuns,
        }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "error",
        message: failure.stopReason,
        model: failure.model,
      });
      render(<TimelineEntryView entry={entries[0]} />);
      expect(screen.getByRole("alert")).toHaveTextContent("请求失败");
      expect(screen.getByRole("alert")).toHaveTextContent("claude-opus-5");
      expect(screen.getByRole("alert")).toHaveTextContent("400");
      expect(screen.queryByText(/工作用时/)).not.toBeInTheDocument();
    },
  );

  it("shows an error even when the run failed before creating a step", () => {
    expect(buildConversationTimeline([failure], [], [], [])[0]).toMatchObject({
      kind: "error",
      message: failure.stopReason,
    });
  });

  it("retains a historical failure after a later successful run", () => {
    const success = {
      ...failure,
      id: "success",
      status: "completed" as const,
      startedAt: "2026-09-20T05:31:00Z",
      completedAt: "2026-09-20T05:31:04Z",
      stopReason: "work_completed",
    };
    const nextStep = {
      ...step,
      id: "success-step",
      runId: success.id,
      status: "completed" as const,
      startedAt: success.startedAt,
      completedAt: success.completedAt,
    };
    const entries = buildConversationTimeline(
      [failure, success],
      [step, nextStep],
      [
        {
          id: "reply",
          sessionId: "session",
          runId: success.id,
          stepId: nextStep.id,
          role: "assistant",
          content: "Hello",
          createdAt: success.completedAt,
          metadata: {},
        },
      ],
      [],
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["error", "agent"]);
    expect(entries[0]).toMatchObject({ message: failure.stopReason });
  });

  it("keeps partial output and the failure visible as separate entries", () => {
    const entries = buildConversationTimeline(
      [failure],
      [step],
      [
        {
          id: "partial",
          sessionId: "session",
          runId: failure.id,
          stepId: step.id,
          role: "assistant",
          content: "Partial reply",
          createdAt: failure.startedAt,
          metadata: {},
        },
      ],
      [],
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["agent", "error"]);
  });
});
