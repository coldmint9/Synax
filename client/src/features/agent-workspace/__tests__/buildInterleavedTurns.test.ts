import { describe, it, expect } from "vitest";
import { buildInterleavedTurns } from "../buildInterleavedTurns";
import type {
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../../adapters/transport/agentRuntime";

const SESSION_ID = "sess-1";
const RUN_ID = "run-1";
const STEP_ID = "step-1";

function makeStep(partial: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    id: STEP_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index: 1,
    status: "completed",
    model: "test-model",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    finishReason: "tool-calls",
    metadata: {},
    ...partial,
  };
}

function makeMessage(
  partial: Partial<AgentRuntimeMessage>,
): AgentRuntimeMessage {
  return {
    id: "msg-1",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    role: "assistant",
    content: "",
    metadata: {},
    createdAt: "2026-01-01T00:00:01.000Z",
    ...partial,
  };
}

function makeToolCall(partial: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: "tc-1",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    toolId: "file.read",
    category: "read",
    mutability: "read",
    inputSummary: "path/to/file",
    outputSummary: "file contents",
    status: "completed",
    startedAt: "2026-01-01T00:00:02.000Z",
    endedAt: "2026-01-01T00:00:03.000Z",
    error: null,
    ...partial,
  };
}

describe("buildInterleavedTurns", () => {
  it.each(["codex", "claude-code", "acp"])("restores %s reasoning saved with the answer", (source) => {
    const turns = buildInterleavedTurns([makeStep()], [], [makeMessage({
      content: "Final answer", metadata: { source, thought: "Provider reasoning" },
    })]);
    expect(turns[0].blocks).toEqual([
      { type: "thinking", content: "Provider reasoning" },
      { type: "text", content: "Final answer", messageId: "msg-1" },
    ]);
  });

  it("restores reasoning-only replies and ignores invalid or placeholder metadata", () => {
    const turns = buildInterleavedTurns([makeStep()], [], [
      makeMessage({ id: "reasoning", metadata: { source: "acp", thought: "仍在分析" } }),
      makeMessage({ id: "placeholder", metadata: { thought: "..." } }),
      makeMessage({ id: "invalid", metadata: { thought: { text: "not a string" } } }),
    ]);
    expect(turns[0].blocks).toEqual([{ type: "thinking", content: "仍在分析" }]);
  });

  it.each([{ type: "thinking" }, { kind: "thought" }])(
    "omits historical placeholder thoughts without hiding short reasoning or answer punctuation (%j)",
    (metadata) => {
      const turns = buildInterleavedTurns(
        [makeStep()],
        [],
        [
          makeMessage({ id: "placeholder", content: "...", metadata }),
          makeMessage({ id: "ellipsis", content: "……", metadata }),
          makeMessage({ id: "short", content: "嗯", metadata }),
          makeMessage({ id: "answer", content: "..." }),
        ],
      );
      expect(turns[0].blocks).toEqual([
        { type: "thinking", content: "嗯" },
        { type: "text", content: "...", messageId: "answer" },
      ]);
    },
  );

  it("preserves media-only assistant messages after reloading the timeline", () => {
    const parts = [
      {
        type: "image" as const,
        assetId: "asset_00000000000000000000000000000000",
      },
      {
        type: "audio" as const,
        assetId: "asset_11111111111111111111111111111111",
      },
    ];
    const turns = buildInterleavedTurns(
      [makeStep()],
      [],
      [makeMessage({ content: "", contentParts: parts })],
    );
    expect(turns[0].blocks).toEqual([
      { type: "media", parts, messageId: "msg-1" },
    ]);
  });
  it("places thinking before tool calls when thinking timestamp is earlier", () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({ id: "tc-1", startedAt: "2026-01-01T00:00:02.000Z" })],
      [
        makeMessage({
          id: "msg-thinking",
          content: "Let me read the file first.",
          metadata: { type: "thinking" },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].blocks.map((b) => b.type)).toEqual([
      "thinking",
      "tool_call",
    ]);
    if (turns[0].blocks[0].type === "thinking") {
      expect(turns[0].blocks[0].content).toBe("Let me read the file first.");
    }
  });

  it("orders thinking, text, and tool calls by timestamp", () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({ id: "tc-1", startedAt: "2026-01-01T00:00:03.000Z" })],
      [
        makeMessage({
          id: "msg-thinking",
          content: "Planning next step.",
          metadata: { kind: "thought" },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        makeMessage({
          id: "msg-text",
          content: "I will inspect the file.",
          metadata: {},
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      ],
    );

    expect(turns[0].blocks.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_call",
    ]);
  });

  it("groups parallel tool calls without affecting thinking order", () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [
        makeToolCall({
          id: "tc-1",
          toolId: "file.read",
          startedAt: "2026-01-01T00:00:02.000Z",
        }),
        makeToolCall({
          id: "tc-2",
          toolId: "rg",
          startedAt: "2026-01-01T00:00:02.100Z",
        }),
      ],
      [
        makeMessage({
          id: "msg-thinking",
          content: "Search and read in parallel.",
          metadata: { type: "thinking" },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    );

    expect(turns[0].blocks.map((b) => b.type)).toEqual([
      "thinking",
      "tool_call_group",
    ]);
    if (turns[0].blocks[1].type === "tool_call_group") {
      expect(turns[0].blocks[1].calls).toHaveLength(2);
    }
  });

  it("deduplicates a tool record that arrives from both live upsert and refresh", () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [
        makeToolCall({ id: "tc-1", status: "running", outputSummary: null }),
        makeToolCall({ id: "tc-1", status: "completed", outputSummary: "done" }),
      ],
      [],
    );

    expect(turns[0].blocks).toHaveLength(1);
    expect(turns[0].blocks[0]).toMatchObject({
      type: "tool_call",
      call: { id: "tc-1", status: "completed", outputSummary: "done" },
    });
  });

  it("attaches a child by its persisted session id even when history arrives late", () => {
    const child = {
      id: "child-1",
      parentSessionId: SESSION_ID,
      createdAt: "2026-01-01T00:00:20.000Z",
    } as AgentSession;
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({
        toolId: "subagent.lifecycle",
        mutability: "task",
        startedAt: "2026-01-01T00:00:02.000Z",
        inputRef: { action: "start", prompt: "Inspect the repository" },
        outputRef: { result: { childSessionId: child.id, status: "running" } },
      })],
      [],
      [child],
    );

    expect(turns[0].blocks).toEqual([
      expect.objectContaining({ type: "tool_call" }),
      { type: "sub_session", session: child },
    ]);
  });

  it("pairs a delayed lifecycle start with the nearest unused child when ids are absent", () => {
    const child = {
      id: "child-2",
      parentSessionId: SESSION_ID,
      createdAt: "2026-01-01T00:00:25.000Z",
    } as AgentSession;
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({ toolId: "subagent.lifecycle", mutability: "task", startedAt: "2026-01-01T00:00:02.000Z" })],
      [],
      [child],
    );
    expect(turns[0].blocks.some((block) => block.type === "sub_session" && block.session.id === child.id)).toBe(true);
  });

  it("renders one card when the same child appears in multiple lifecycle records", () => {
    const child = {
      id: "child-duplicate",
      parentSessionId: SESSION_ID,
      createdAt: "2026-01-01T00:00:25.000Z",
    } as AgentSession;
    const secondStep = makeStep({ id: "step-2", index: 2, startedAt: "2026-01-01T00:01:00.000Z", completedAt: "2026-01-01T00:01:05.000Z" });
    const lifecycle = (id: string, stepId: string, startedAt: string): ToolCallRecord => makeToolCall({
      id,
      stepId,
      toolId: "subagent.lifecycle",
      mutability: "task",
      startedAt,
      inputRef: { action: "inspect", childSessionId: child.id },
    });
    const turns = buildInterleavedTurns(
      [makeStep(), secondStep],
      [
        lifecycle("lifecycle-1", STEP_ID, "2026-01-01T00:00:02.000Z"),
        lifecycle("lifecycle-2", "step-2", "2026-01-01T00:01:02.000Z"),
      ],
      [],
      [child],
    );
    expect(turns.flatMap((turn) => turn.blocks).filter((block) => block.type === "sub_session")).toHaveLength(1);
  });

  it("deduplicates repeated explicit child ids in one step", () => {
    const child = {
      id: "child-same-step",
      parentSessionId: SESSION_ID,
      createdAt: "2026-01-01T00:00:25.000Z",
    } as AgentSession;
    const turns = buildInterleavedTurns(
      [makeStep()],
      [
        makeToolCall({ id: "lifecycle-a", toolId: "subagent.lifecycle", mutability: "task", inputRef: { action: "start" }, outputRef: { childSessionId: child.id } }),
        makeToolCall({ id: "lifecycle-b", toolId: "subagent.lifecycle", mutability: "task", inputRef: { action: "inspect", childSessionId: child.id } }),
      ],
      [],
      [child],
    );
    expect(turns[0].blocks.filter((block) => block.type === "sub_session")).toHaveLength(1);
  });
});


it.each([null, STEP_ID])("excludes internal command receipts while retaining tool results (step=%s)", (stepId) => {
  const tool = makeToolCall({ toolId: "bash", outputSummary: "Build output", status: "completed" });
  const receipt = makeMessage({
    id: "command-completion:tc-1", stepId,
    content: 'Background command completion (untrusted output data):\n{"status":"completed"}',
    metadata: { source: "command_completion", commandTaskId: "tc-1" },
  });
  const turns = buildInterleavedTurns([makeStep()], [tool], [receipt]);
  expect(turns[0].blocks).toHaveLength(1);
  expect(turns[0].blocks[0]).toMatchObject({ type: "tool_call", call: { id: tool.id, status: "completed", outputSummary: "Build output" } });
  expect(JSON.stringify(turns)).not.toContain("Background command completion");
});

it("does not hide ordinary replies quoting a command completion", () => {
  const content = "Background command completion explains the previous result.";
  const turns = buildInterleavedTurns([makeStep()], [], [makeMessage({ content })]);
  expect(turns[0].blocks).toContainEqual({ type: "text", content, messageId: "msg-1" });
});
