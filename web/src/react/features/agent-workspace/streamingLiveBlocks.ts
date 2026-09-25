import type { ToolCallRecord } from "../../../lib/api/agentRuntime";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { toolCallRecordToView } from "./toolCallUtils";
import { hasDisplayableReasoning } from "./activityText";

export interface StreamingLiveBuffers {
  blocks: TurnContentBlock[];
  pendingThinking: string;
  pendingText: string;
  pendingToolCalls: ToolCallRecord[];
}

export const EMPTY_STREAMING_BUFFERS: StreamingLiveBuffers = {
  blocks: [],
  pendingThinking: "",
  pendingText: "",
  pendingToolCalls: [],
};

const LIVE_TEXT_CHARS = 64 * 1024;
export const LIVE_PREVIEW_OMISSION =
  "[Earlier live preview omitted; final message is retained]\n";
const boundedText = (text: string) =>
  text.length <= LIVE_TEXT_CHARS
    ? text
    : LIVE_PREVIEW_OMISSION + text.slice(-LIVE_TEXT_CHARS);
function toolCallsToBlocks(toolCalls: ToolCallRecord[]): TurnContentBlock[] {
  if (toolCalls.length === 0) return [];
  const views = toolCalls.map(toolCallRecordToView);
  if (views.length === 1) return [{ type: "tool_call", call: views[0] }];
  return [{ type: "tool_call_group", calls: views }];
}

function flushThinking(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (!state.pendingThinking) return state;
  if (!hasDisplayableReasoning(state.pendingThinking))
    return { ...state, pendingThinking: "" };
  return {
    ...state,
    blocks: [
      ...state.blocks.slice(-31),
      { type: "thinking", content: state.pendingThinking },
    ],
    pendingThinking: "",
  };
}

function flushText(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (!state.pendingText.trim()) return state;
  return {
    ...state,
    blocks: [...state.blocks.slice(-31), { type: "text", content: state.pendingText }],
    pendingText: "",
  };
}

function flushToolCalls(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (state.pendingToolCalls.length === 0) return state;
  return {
    ...state,
    blocks: [...state.blocks.slice(-31), ...toolCallsToBlocks(state.pendingToolCalls)],
    pendingToolCalls: [],
  };
}

export function applyThoughtDelta(
  state: StreamingLiveBuffers,
  delta: string,
): StreamingLiveBuffers {
  if (!delta) return state;
  let next = flushText(state);
  if (next.pendingToolCalls.length > 0) {
    next = flushToolCalls(next);
  }
  return { ...next, pendingThinking: boundedText(next.pendingThinking + delta) };
}

export function applyMessageDelta(
  state: StreamingLiveBuffers,
  delta: string,
): StreamingLiveBuffers {
  if (!delta) return state;
  let next = flushToolCalls(state);
  next = flushThinking(next);
  return { ...next, pendingText: boundedText(next.pendingText + delta) };
}

export function applyToolCall(
  state: StreamingLiveBuffers,
  toolCall: ToolCallRecord,
): StreamingLiveBuffers {
  let next = state;
  next = flushThinking(next);
  if (next.pendingText.trim()) next = flushText(next);
  return {
    ...next,
    pendingToolCalls: [...next.pendingToolCalls.slice(-31), toolCall],
  };
}

export function applyToolResult(
  state: StreamingLiveBuffers,
  toolCall: ToolCallRecord,
): StreamingLiveBuffers {
  if (state.pendingToolCalls.length === 0) return state;
  return {
    ...state,
    pendingToolCalls: state.pendingToolCalls.map((tc) =>
      tc.id === toolCall.id ? toolCall : tc,
    ),
  };
}

export function snapshotStreamingBuffers(
  state: StreamingLiveBuffers,
): TurnContentBlock[] {
  let next = flushThinking(state);
  next = flushText(next);
  next = flushToolCalls(next);
  return next.blocks;
}

export function hasStreamingText(state: StreamingLiveBuffers): boolean {
  return (
    state.blocks.some(
      (block) => block.type === "text" && Boolean(block.content.trim()),
    ) || Boolean(state.pendingText.trim())
  );
}

export function hasStreamingContent(state: StreamingLiveBuffers): boolean {
  return (
    state.blocks.length > 0 ||
    hasDisplayableReasoning(state.pendingThinking) ||
    Boolean(state.pendingText) ||
    state.pendingToolCalls.length > 0
  );
}

export function materializeLiveBlocks(
  state: StreamingLiveBuffers,
): TurnContentBlock[] {
  const blocks = [...state.blocks];
  if (hasDisplayableReasoning(state.pendingThinking)) {
    blocks.push({ type: "thinking", content: state.pendingThinking });
  }
  if (state.pendingToolCalls.length > 0) {
    blocks.push(...toolCallsToBlocks(state.pendingToolCalls));
  }
  if (state.pendingText.trim()) {
    blocks.push({ type: "text", content: state.pendingText });
  }
  return blocks;
}
