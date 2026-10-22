import type {
  AgentRunStep,
  AgentRuntimeMessage,
} from "../../../../adapters/transport/agentRuntime";
import {
  attachSnapshotRunIds,
  isLiveStepPersisted,
  retirePersistedSnapshots,
  type CompletedLiveStep,
} from "../liveStepRetirement";

const step = (id: string, runId: string): AgentRunStep => ({
  id,
  runId,
  sessionId: "session",
  index: 1,
  status: "completed",
  model: "model",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  finishReason: "stop",
  metadata: {},
});

const answer = (
  id: string,
  content: string,
  overrides: Partial<AgentRuntimeMessage> = {},
): AgentRuntimeMessage => ({
  id,
  sessionId: "session",
  runId: "run",
  stepId: "step",
  role: "assistant",
  content,
  metadata: {},
  createdAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

const snapshot = (
  stepId: string,
  text: string,
  runId?: string,
): CompletedLiveStep => ({
  stepId,
  stepIndex: 1,
  runId,
  blocks: [{ type: "text", content: text }],
});

describe("liveStepRetirement", () => {
  it("keeps the snapshot while the persisted answer is still partial", () => {
    expect(
      isLiveStepPersisted(
        snapshot("step", "Hello world"),
        [step("step", "run")],
        [answer("m1", "Hello wor")],
      ),
    ).toBe(false);
  });

  it("retires the snapshot in the commit that renders the persisted answer", () => {
    const snapshots = [
      snapshot("step-1", "first answer"),
      snapshot("step-2", "second answer"),
    ];
    const remaining = retirePersistedSnapshots(
      snapshots,
      [step("step-1", "run"), step("step-2", "run")],
      [
        answer("m1", "first answer", { stepId: "step-1" }),
        answer("m2", "second answer", { stepId: "step-2" }),
      ],
      [],
    );
    expect(remaining).toEqual([]);
  });

  it("matches a message that has no step id through the snapshot run", () => {
    expect(
      isLiveStepPersisted(
        snapshot("step", "final answer", "run"),
        [step("step", "run")],
        [answer("m1", "final answer", { stepId: null })],
      ),
    ).toBe(true);
  });

  it("does not retire on an incremental page that omits unchanged tool calls", () => {
    const thinking: CompletedLiveStep = {
      stepId: "step",
      stepIndex: 1,
      runId: "run",
      blocks: [
        { type: "thinking", content: "plan" },
        {
          ...({ type: "tool_call" } as never),
          call: { id: "call-1", name: "read", arguments: "" } as never,
        },
      ],
    };
    const steps = [step("step", "run")];
    const messages = [answer("m1", "plan", { metadata: { type: "thinking" } })];
    // Without the tool call collection (incremental page) the settled step is
    // enough; with it we still need the call to be visible.
    expect(isLiveStepPersisted(thinking, steps, messages)).toBe(true);
    expect(isLiveStepPersisted(thinking, steps, messages, [])).toBe(false);
  });

  it("recovers the run identity for snapshots taken before the step arrived", () => {
    const anchored = attachSnapshotRunIds(
      [snapshot("step", "answer")],
      [step("step", "run")],
      [{ id: "run" }],
      null,
    );
    expect(anchored[0].runId).toBe("run");
    expect(anchored[0].runId).toBe("run");
    expect(
      isLiveStepPersisted(
        anchored[0],
        [step("step", "run")],
        [answer("m1", "answer", { stepId: null })],
      ),
    ).toBe(true);
  });

  it("keeps the snapshot when the projected history omitted message content", () => {
    expect(
      isLiveStepPersisted(
        snapshot("step", "answer"),
        [step("step", "run")],
        [
          answer("m1", "", {
            historyProjection: { omittedFields: ["content"] },
          }),
        ],
      ),
    ).toBe(false);
  });
});

it("retires reasoning stored alongside a nonempty assistant answer", () => {
  const thinking: CompletedLiveStep = {
    stepId: "step", stepIndex: 1, runId: "run",
    blocks: [{ type: "thinking", content: "First turn reasoning" }],
  };
  const messages = [answer("reply", "First turn answer", { metadata: { thought: "First turn reasoning" } })];
  expect(isLiveStepPersisted(thinking, [step("step", "run")], messages, [])).toBe(true);
  expect(isLiveStepPersisted(thinking, [step("step", "run")], [
    answer("reply", "First turn reasoning", { metadata: { thought: "Different reasoning" } }),
  ], [])).toBe(false);
});
