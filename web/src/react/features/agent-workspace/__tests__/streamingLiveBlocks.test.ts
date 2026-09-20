import { describe, expect, it } from "vitest";
import {
  applyMessageDelta,
  applyThoughtDelta,
  applyToolCall,
  EMPTY_STREAMING_BUFFERS,
  hasStreamingContent,
  materializeLiveBlocks,
  snapshotStreamingBuffers,
} from "../streamingLiveBlocks";
import type { ToolCallRecord } from "../../../../lib/api/agentRuntime";

const toolCall = (id: string): ToolCallRecord => ({
  id,
  sessionId: "sess-1",
  runId: "run-1",
  stepId: "step-1",
  toolId: "grep.search",
  category: "read",
  mutability: "read",
  inputSummary: "pattern",
  outputSummary: null,
  status: "running",
  startedAt: "2026-01-01T00:00:02.000Z",
  endedAt: null,
  error: null,
});

describe("streamingLiveBlocks", () => {
  it("does not flash a reasoning row for split placeholder deltas", () => {
    let state = EMPTY_STREAMING_BUFFERS;
    for (const delta of [".", ".", "."]) {
      state = applyThoughtDelta(state, delta);
      expect(materializeLiveBlocks(state)).toEqual([]);
      expect(snapshotStreamingBuffers(state)).toEqual([]);
      expect(hasStreamingContent(state)).toBe(false);
    }
    state = applyThoughtDelta(state, "嗯");
    expect(materializeLiveBlocks(state)).toEqual([
      { type: "thinking", content: "...嗯" },
    ]);
  });

  it("discards placeholders at text and tool boundaries instead of attaching them to later thoughts", () => {
    let state = applyThoughtDelta(EMPTY_STREAMING_BUFFERS, "...");
    state = applyMessageDelta(state, "Answer");
    state = applyThoughtDelta(state, "……");
    state = applyToolCall(state, toolCall("tc-1"));
    state = applyThoughtDelta(state, "检查");
    const blocks = snapshotStreamingBuffers(state);
    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool_call",
      "thinking",
    ]);
    expect(blocks.at(-1)).toEqual({ type: "thinking", content: "检查" });
  });

  it("interleaves thinking, body text, and tool calls in order", () => {
    let state = applyThoughtDelta(
      {
        blocks: [],
        pendingThinking: "",
        pendingText: "",
        pendingToolCalls: [],
      },
      "plan",
    );
    state = applyMessageDelta(state, "I will inspect the file.");
    state = applyToolCall(state, toolCall("tc-1"));
    state = applyThoughtDelta(state, "next");
    state = applyMessageDelta(state, "Done.");

    const blocks = materializeLiveBlocks(state);
    expect(blocks.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_call",
      "thinking",
      "text",
    ]);
  });

  it("snapshots flushed blocks when a step completes", () => {
    let state = applyThoughtDelta(
      {
        blocks: [],
        pendingThinking: "",
        pendingText: "",
        pendingToolCalls: [],
      },
      "plan",
    );
    state = applyToolCall(state, toolCall("tc-1"));
    state = applyMessageDelta(state, "status");

    const snapshot = snapshotStreamingBuffers(state);
    expect(snapshot.map((b) => b.type)).toEqual([
      "thinking",
      "tool_call",
      "text",
    ]);
  });
});
