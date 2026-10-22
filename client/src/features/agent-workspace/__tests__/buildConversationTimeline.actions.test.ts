import { describe, expect, it } from "vitest";
import { buildConversationTimeline } from "../buildConversationTimeline";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
} from "../../../adapters/transport/agentRuntime";

const SESSION_ID = "sess-1";
const RUN_ID = "run-1";

function makeStep(index: number): AgentRunStep {
  const minute = String(index).padStart(2, "0");
  return {
    id: `step-${index}`,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index,
    status: "completed",
    model: "test-model",
    startedAt: `2026-01-01T00:${minute}:00.000Z`,
    completedAt: `2026-01-01T00:${minute}:30.000Z`,
    finishReason: "tool-calls",
    metadata: {},
  };
}

function reply(stepIndex: number, content: string): AgentRuntimeMessage {
  return {
    id: `msg-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    role: "assistant",
    content,
    metadata: {},
    createdAt: `2026-01-01T00:${String(stepIndex).padStart(2, "0")}:20.000Z`,
  };
}

function makeRun(status: AgentRun["status"]): AgentRun {
  return {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T01:00:00.000Z",
    triggerMessageId: "msg-user",
    currentStep: 3,
    stopReason: null,
    model: null,
    metadata: {},
  };
}

function build(status: AgentRun["status"], foldWorkRuns?: boolean) {
  const steps = [makeStep(1), makeStep(2), makeStep(3)];
  return buildConversationTimeline(
    [makeRun(status)],
    steps,
    [
      reply(1, "Reading the search module"),
      reply(2, "Found the caller"),
      reply(3, "Here is the final answer"),
    ],
    [],
    undefined,
    { foldWorkRuns },
  );
}

describe("final reply actions", () => {
  it("marks only the folded answer row of a completed round", () => {
    const timeline = build("completed");
    expect(timeline.map((entry) => entry.kind)).toEqual(["work_log", "agent"]);
    const marked = timeline.filter(
      (entry) => entry.kind === "agent" && entry.finalReply,
    );
    expect(marked.map((entry) => entry.id)).toEqual(["step-3-answer"]);
  });

  it("marks only the last step when work logs stay expanded", () => {
    const timeline = build("completed", false);
    const marked = timeline.filter(
      (entry) => entry.kind === "agent" && entry.finalReply,
    );
    expect(marked.map((entry) => entry.id)).toEqual(["step-3"]);
  });

  it("skips trailing process rows that carry no answer", () => {
    const steps = [makeStep(1), makeStep(2), makeStep(3)];
    const timeline = buildConversationTimeline(
      [makeRun("completed")],
      steps,
      [reply(1, "Reading the search module"), reply(2, "Here is the answer")],
      [],
      undefined,
      { foldWorkRuns: false },
    );
    const marked = timeline.filter(
      (entry) => entry.kind === "agent" && entry.finalReply,
    );
    expect(marked.map((entry) => entry.id)).toEqual(["step-2"]);
  });

  it("waits for the run to settle before offering reply actions", () => {
    const timeline = build("running");
    expect(
      timeline.filter((entry) => entry.kind === "agent" && entry.finalReply),
    ).toEqual([]);
  });
});
