import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  ToolCallRecord,
} from "../../adapters/transport/agentRuntime";

export interface TranscriptRecords {
  messages: AgentRuntimeMessage[];
  runs: AgentRun[];
  steps: AgentRunStep[];
  toolCalls: ToolCallRecord[];
}

/**
 * A side chat still carries the primary conversation snapshot as model context,
 * but the transcript only shows what was exchanged in the side chat itself. The
 * snapshot boundary is the copy commit instant, so every inherited record is
 * filtered out by time and later side-chat turns stay visible.
 */
export function withoutInheritedSnapshot<T extends TranscriptRecords>(
  history: T,
  inheritedThrough: string | null | undefined,
): T {
  const boundary = inheritedThrough ? Date.parse(inheritedThrough) : Number.NaN;
  if (!Number.isFinite(boundary)) return history;
  const current = (value: string | null | undefined) => {
    const at = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) && at > boundary;
  };
  return {
    ...history,
    messages: history.messages.filter((item) => current(item.createdAt)),
    runs: history.runs.filter((item) => current(item.startedAt)),
    steps: history.steps.filter((item) => current(item.startedAt)),
    toolCalls: history.toolCalls.filter((item) => current(item.startedAt)),
  };
}
