import { describe, expect, it } from "vitest";
import { buildConversationTimeline } from "../buildConversationTimeline";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  ToolCallRecord,
} from "../../../adapters/transport/agentRuntime";

const SESSION_ID = "sess-1";
const RUN_ID = "run-1";

function makeStep(
  index: number,
  status: AgentRunStep["status"] = "completed",
): AgentRunStep {
  const minute = String(index).padStart(2, "0");
  return {
    id: `step-${index}`,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index,
    status,
    model: "test-model",
    startedAt: `2026-01-01T00:${minute}:00.000Z`,
    completedAt: `2026-01-01T00:${minute}:30.000Z`,
    finishReason: status === "completed" ? "tool-calls" : null,
    metadata: {},
  };
}

function thinking(
  stepIndex: number,
  content = `thinking ${stepIndex}`,
): AgentRuntimeMessage {
  return {
    id: `msg-think-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    role: "assistant",
    content,
    metadata: { type: "thinking" },
    createdAt: `2026-01-01T00:${String(stepIndex).padStart(2, "0")}:05.000Z`,
  };
}

function answer(
  stepIndex: number,
  content = "here is the answer",
): AgentRuntimeMessage {
  return {
    id: `msg-text-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    role: "assistant",
    content,
    metadata: {},
    createdAt: `2026-01-01T00:${String(stepIndex).padStart(2, "0")}:20.000Z`,
  };
}

function toolCall(stepIndex: number): ToolCallRecord {
  return {
    id: `tool-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    toolId: "bash",
    category: "shell",
    mutability: "read",
    inputSummary: `cmd ${stepIndex}`,
    outputSummary: "ok",
    status: "completed",
    startedAt: `2026-01-01T00:${String(stepIndex).padStart(2, "0")}:10.000Z`,
    endedAt: `2026-01-01T00:${String(stepIndex).padStart(2, "0")}:12.000Z`,
    error: null,
  };
}

function makeRun(
  status: AgentRun["status"] = "completed",
  stepCount = 0,
): AgentRun {
  return {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T01:00:00.000Z",
    triggerMessageId: "msg-user",
    currentStep: stepCount,
    stopReason: null,
    model: null,
    metadata: {},
  };
}

function build(
  steps: AgentRunStep[],
  messages: AgentRuntimeMessage[],
  toolCalls: ToolCallRecord[],
  foldWorkRuns?: boolean,
  runStatus: AgentRun["status"] = "completed",
) {
  return buildConversationTimeline(
    [makeRun(runStatus, steps.length)],
    steps,
    messages,
    toolCalls,
    undefined,
    { foldWorkRuns },
  );
}

describe("buildConversationTimeline work logs", () => {
  it("keeps replies with missing steps out of subsequent work duration", () => {
    const timeline = build(
      [makeStep(2), makeStep(3)],
      [answer(1, "Historical reply"), thinking(2), thinking(3), answer(3)],
      [toolCall(2), toolCall(3)],
    );

    expect(timeline.map((entry) => entry.kind)).toEqual([
      "agent", "work_log", "agent",
    ]);
    expect(timeline[0]).toMatchObject({
      id: "reply-msg-text-1",
      turn: { blocks: [{ type: "text", content: "Historical reply" }] },
    });
    expect(timeline[1]).toMatchObject({
      stats: { elapsedMs: 90_000, stepCount: 2, toolCallCount: 2 },
    });
  });

  it("does not fabricate a work log for replies whose steps are all missing", () => {
    const timeline = build([], [answer(1), answer(2)], []);
    expect(timeline.map((entry) => entry.kind)).toEqual(["agent", "agent"]);
  });

  it("uses available step timings when a start time is invalid", () => {
    const timeline = build(
      [{ ...makeStep(1), startedAt: "invalid" }, makeStep(2)],
      [thinking(1), thinking(2)],
      [],
    );
    expect(timeline[0]).toMatchObject({ stats: { elapsedMs: 30_000 } });
  });

  it.each<[string, string | null, number]>([
    ["invalid", "invalid", 0],
    ["2026-01-01T00:01:00.000Z", "invalid", 0],
    ["2026-01-01T00:01:00.000Z", null, 0],
    ["2026-01-01T00:01:00.000Z", "2026-01-01T00:00:30.000Z", 0],
  ])("keeps duration finite and nonnegative for %s / %s", (startedAt, completedAt, elapsedMs) => {
    const timeline = build(
      [{ ...makeStep(1), startedAt, completedAt }],
      [thinking(1)],
      [],
    );
    expect(timeline[0]).toMatchObject({ stats: { elapsedMs } });
  });

  it("folds a process-only run into one entry", () => {
    const steps = [1, 2, 3, 4].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));
    const toolCalls = steps.map((step) => toolCall(step.index));

    const timeline = build(steps, messages, toolCalls);

    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry.kind).toBe("work_log");
    if (entry.kind !== "work_log") throw new Error("expected work log");
    expect(entry.turns).toHaveLength(4);
    expect(entry.stats.stepCount).toBe(4);
    expect(entry.stats.toolCallCount).toBe(4);
    expect(entry.stats.thinkingChars).toBe(
      "thinking 1thinking 2thinking 3thinking 4".length,
    );
    // step-1 starts at 00:01:00, step-4 completes at 00:04:30
    expect(entry.stats.elapsedMs).toBe(210_000);
    expect(entry.id).toBe("work-log-step-1");
  });

  it("folds the whole process of a finished round and leaves its answer outside", () => {
    const steps = [1, 2, 3, 4].map((index) => makeStep(index));
    const messages = [
      thinking(1),
      thinking(2),
      thinking(3),
      // The answer shares its step with reasoning: only the answer stays out.
      thinking(4),
      answer(4, "the answer"),
    ];

    const timeline = build(steps, messages, []);

    expect(timeline.map((entry) => entry.kind)).toEqual(["work_log", "agent"]);

    const folded = timeline[0];
    if (folded.kind !== "work_log") throw new Error("expected work log");
    expect(folded.stats.stepCount).toBe(4);
    expect(folded.turns.map((turn) => turn.stepId)).toEqual([
      "step-1",
      "step-2",
      "step-3",
      "step-4",
    ]);
    // The answer step's own reasoning folds too, rather than trailing the answer.
    expect(folded.turns[3].blocks.map((block) => block.type)).toEqual([
      "thinking",
    ]);
    expect(
      folded.turns
        .flatMap((turn) => turn.blocks)
        .some((block) => block.type === "text"),
    ).toBe(false);

    const answerEntry = timeline[1];
    if (answerEntry.kind !== "agent")
      throw new Error("expected the answer turn");
    expect(answerEntry.id).toBe("step-4-answer");
    expect(answerEntry.turn.blocks.map((block) => block.type)).toEqual([
      "text",
    ]);
  });

  it("never folds while the round is still running", () => {
    const steps = [1, 2, 3, 4].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));

    const timeline = build(steps, messages, [], undefined, "running");

    expect(timeline).toHaveLength(4);
    expect(timeline.every((entry) => entry.kind === "agent")).toBe(true);
  });

  it("folds history even when the run record is missing", () => {
    const steps = [1, 2, 3].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));

    const timeline = buildConversationTimeline([], steps, messages, []);

    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("work_log");
  });

  it("breaks the run at a user message and folds each side separately", () => {
    const steps = [1, 2, 3, 4, 5, 6, 7].map((index) => makeStep(index));
    const messages = [
      thinking(1),
      thinking(2),
      thinking(3),
      thinking(4),
      {
        id: "msg-user-2",
        sessionId: SESSION_ID,
        runId: RUN_ID,
        stepId: null,
        role: "user" as const,
        content: "keep going",
        metadata: {},
        // Lands after step-4 started and before step-5 does.
        createdAt: "2026-01-01T00:04:40.000Z",
      },
      thinking(5),
      thinking(6),
      thinking(7),
    ];

    const timeline = build(steps, messages, []);

    expect(timeline.map((entry) => entry.kind)).toEqual([
      "work_log",
      "user",
      "work_log",
    ]);
  });

  it("folds even a single intermediate turn, so no stray step survives", () => {
    const steps = [1, 2].map((index) => makeStep(index));
    const messages = [thinking(1), thinking(2), answer(2, "done")];

    const timeline = build(steps, messages, []);

    expect(timeline.map((entry) => entry.kind)).toEqual(["work_log", "agent"]);
    const folded = timeline[0];
    if (folded.kind !== "work_log") throw new Error("expected work log");
    expect(folded.turns.map((turn) => turn.stepId)).toEqual([
      "step-1",
      "step-2",
    ]);
  });

  it("keeps every turn when the switch is off", () => {
    const steps = [1, 2, 3, 4].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));

    const timeline = build(steps, messages, [], false);

    expect(timeline).toHaveLength(4);
    expect(timeline.every((entry) => entry.kind === "agent")).toBe(true);
  });

  it("keeps the work-log id stable while the run grows", () => {
    const steps = [1, 2, 3, 4, 5].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));

    const before = build(steps.slice(0, 4), messages.slice(0, 4), []);
    const after = build(steps, messages, []);

    expect(before[0].id).toBe(after[0].id);
  });

  it("never folds the live step", () => {
    const steps = [1, 2, 3, 4].map((index) => makeStep(index));
    const messages = steps.map((step) => thinking(step.index));

    const timeline = buildConversationTimeline(
      [],
      steps,
      messages,
      [],
      undefined,
      { excludeStepId: "step-4" },
    );

    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("work_log");
    if (timeline[0].kind !== "work_log") throw new Error("expected work log");
    expect(timeline[0].turns.map((turn) => turn.stepId)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
  });
});
