import { visualizationReplyParts } from "./visualizationTranscript";
import { gitMergeReplyParts, type GitMergeReplyPart } from "./gitMergeTranscript";
import type { InlineVisualizationReference } from "./visualizationTranscript";
import type { RuntimeContentPart } from "../../adapters/transport/runtimeMedia";
import { hasDisplayableReasoning } from "./activityText";
import { toolCallRecordToView } from "./toolCallUtils";
import type {
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../adapters/transport/agentRuntime";

export interface ToolCallView {
  execution?: ToolCallRecord["execution"];
  outputRef?: unknown;
  contentParts?: RuntimeContentPart[];
  id: string;
  toolId: string;
  inputSummary: string;
  outputSummary: string;
  status: string;
  category: string;
  duration: string | null;
  mutability: string;
}

export type TurnContentBlock =
  | Extract<GitMergeReplyPart, { type: "git_merge" }>
  | {
      type: "visualization";
      reference: InlineVisualizationReference;
      messageId?: string;
    }
  | { type: "media"; parts: RuntimeContentPart[]; messageId?: string }
  | { type: "text"; content: string; messageId?: string }
  | { type: "thinking"; content: string }
  | {
      type: "sources";
      messageId?: string;
      sources: Array<{ id: string; url: string; title?: string }>;
    }
  | { type: "tool_call"; call: ToolCallView }
  | { type: "tool_call_group"; calls: ToolCallView[] }
  | { type: "sub_session"; session: AgentSession }
  | {
      type: "context_compacted";
      originalTokens: number;
      compressedTokens: number;
      messageCount: number;
    };

export interface InterleavedTurn {
  stepId: string;
  index: number;
  status: string;
  duration: string | null;
  /** Null while the step is still running, so the UI can omit the stamp. */
  completedAt: string | null;
  /** A live snapshot contributes a frozen array; readers must not mutate it. */
  blocks: readonly TurnContentBlock[];
}

function computeDuration(step: AgentRunStep): string | null {
  if (!step.completedAt) return null;
  const ms =
    new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function groupParallelToolCalls(
  blocks: TurnContentBlock[],
): TurnContentBlock[] {
  const result: TurnContentBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "tool_call") {
      const group: ToolCallView[] = [block.call];
      let j = i + 1;
      while (j < blocks.length && blocks[j].type === "tool_call") {
        group.push(
          (blocks[j] as { type: "tool_call"; call: ToolCallView }).call,
        );
        j++;
      }
      if (group.length > 1) {
        result.push({ type: "tool_call_group", calls: group });
      } else {
        result.push(block);
      }
      i = j;
    } else {
      result.push(block);
      i++;
    }
  }
  return result;
}

function readSubagentSessionId(value: unknown, seen = new Set<unknown>()): string | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["childSessionId", "taskId"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  if (record.session && typeof record.session === "object") {
    const id = (record.session as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  for (const key of ["result", "output", "data", "payload"]) {
    const nested = readSubagentSessionId(record[key], seen);
    if (nested) return nested;
  }
  return null;
}

function childForTaskCall(
  toolCall: ToolCallRecord,
  parentSessionId: string,
  childSessions: AgentSession[],
  usedChildIds: Set<string>,
  renderedChildIds: Set<string>,
): AgentSession | undefined {
  if (toolCall.toolId !== "subagent.delegate" && toolCall.toolId !== "subagent.lifecycle") return undefined;
  const explicitId = readSubagentSessionId(toolCall.inputRef) ?? readSubagentSessionId(toolCall.outputRef);
  if (explicitId) {
    if (usedChildIds.has(explicitId) || renderedChildIds.has(explicitId)) return undefined;
    const explicit = childSessions.find((child) => child.id === explicitId && child.parentSessionId === parentSessionId);
    if (explicit) return explicit;
  }
  return childSessions
    .filter((child) => child.parentSessionId === parentSessionId && !usedChildIds.has(child.id) && !renderedChildIds.has(child.id))
    .sort((a, b) =>
      Math.abs(Date.parse(a.createdAt) - Date.parse(toolCall.startedAt)) -
      Math.abs(Date.parse(b.createdAt) - Date.parse(toolCall.startedAt)),
    )[0];
}

function mergeConsecutiveBlocks(
  blocks: TurnContentBlock[],
): TurnContentBlock[] {
  const result: TurnContentBlock[] = [];
  for (const block of blocks) {
    const prev = result[result.length - 1];
    if (
      block.type === "text" &&
      prev?.type === "text" &&
      block.messageId === prev.messageId
    ) {
      result[result.length - 1] = {
        ...prev,
        type: "text",
        content: prev.content + "\n" + block.content,
      };
    } else if (block.type === "thinking" && prev?.type === "thinking") {
      result[result.length - 1] = {
        type: "thinking",
        content: prev.content + "\n" + block.content,
      };
    } else {
      result.push(block);
    }
  }
  return result;
}

export function buildInterleavedTurns(
  steps: AgentRunStep[],
  toolCallRecords: ToolCallRecord[],
  messages: AgentRuntimeMessage[],
  childSessions?: AgentSession[],
): InterleavedTurn[] {
  const sorted = [...steps].sort((a, b) => a.index - b.index);
  const lastStepByRun = new Map(sorted.map((step) => [step.runId, step.id]));
  // A child can have several lifecycle records (start, inspect, wait, resume)
  // and those records can land in different steps. The transcript owns one
  // visual card per child session, so dedupe across the complete timeline.
  const renderedChildIds = new Set<string>();

  const messagesByStep = new Map<string, AgentRuntimeMessage[]>();
  // A live upsert and a detail refresh can briefly overlap. Keep the newest
  // record for each id before building blocks so the transcript never renders
  // the same assistant message twice.
  const uniqueMessages = new Map<string, AgentRuntimeMessage>();
  for (const message of messages) uniqueMessages.set(message.id, message);
  for (const message of uniqueMessages.values()) {
    // Completion receipts are model context, not assistant replies. The
    // associated tool call already owns the command's result in the transcript.
    if (
      ["artifact_publisher", "artifact_request", "artifact_job", "command_completion"].includes(
        String(message.metadata?.source),
      )
    )
      continue;
    if (message.role !== "assistant") continue;
    // Work/goal completion messages are persisted without a step. They belong
    // to the final step of their Run so the transcript survives live cleanup.
    const stepId =
      message.stepId ??
      (message.runId ? lastStepByRun.get(message.runId) : null);
    if (!stepId) continue;
    const bucket = messagesByStep.get(stepId);
    if (bucket) bucket.push(message);
    else messagesByStep.set(stepId, [message]);
  }

  const toolCallsByStep = new Map<string, ToolCallRecord[]>();
  const uniqueToolCalls = new Map<string, ToolCallRecord>();
  for (const toolCall of toolCallRecords)
    uniqueToolCalls.set(toolCall.id, toolCall);
  for (const toolCall of uniqueToolCalls.values()) {
    if (!toolCall.stepId) continue;
    const bucket = toolCallsByStep.get(toolCall.stepId);
    if (bucket) bucket.push(toolCall);
    else toolCallsByStep.set(toolCall.stepId, [toolCall]);
  }

  return sorted.map((step) => {
    const items: Array<{ timestamp: number; block: TurnContentBlock }> = [];
    const usedChildIds = new Set<string>();

    const stepMessages = messagesByStep.get(step.id) ?? [];
    for (const original of stepMessages) {
      const msg = original;
      const timestamp = new Date(msg.createdAt).getTime();
      if (msg.contentParts?.some((part) => part.type !== "text"))
        items.push({
          timestamp,
          block: { type: "media", parts: msg.contentParts, messageId: msg.id },
        });

      const isThinking =
        msg.metadata?.type === "thinking" || msg.metadata?.kind === "thought";
      if (isThinking) {
        if (hasDisplayableReasoning(msg.content))
          items.push({
            timestamp,
            block: { type: "thinking", content: msg.content },
          });
        continue;
      }
      // CLI and ACP backends retain visible reasoning alongside the answer.
      // Reading only standalone thinking messages drops it at live/history handoff.
      const thought = msg.metadata?.thought;
      if (typeof thought === "string" && hasDisplayableReasoning(thought))
        items.push({ timestamp, block: { type: "thinking", content: thought } });
      for (const block of gitMergeReplyParts(msg) ?? visualizationReplyParts(msg))
        items.push({ timestamp, block });
      if (msg.content.trim()) {
        const sources = Array.isArray(msg.metadata?.sources)
          ? msg.metadata.sources.flatMap((source) => {
              if (
                !source ||
                typeof source !== "object" ||
                Array.isArray(source)
              )
                return [];
              const record = source as Record<string, unknown>;
              if (
                typeof record.id !== "string" ||
                typeof record.url !== "string"
              )
                return [];
              try {
                if (!["http:", "https:"].includes(new URL(record.url).protocol))
                  return [];
              } catch {
                return [];
              }
              return [
                {
                  id: record.id,
                  url: record.url,
                  ...(typeof record.title === "string"
                    ? { title: record.title }
                    : {}),
                },
              ];
            })
          : [];
        if (sources.length)
          items.push({
            timestamp,
            block: { type: "sources", sources, messageId: msg.id },
          });
      }
    }

    const stepToolCalls = toolCallsByStep.get(step.id) ?? [];
    for (const tc of stepToolCalls) {
      items.push({
        timestamp: new Date(tc.startedAt).getTime(),
        block: {
          type: "tool_call",
          call: toolCallRecordToView(tc),
        },
      });

      if (tc.mutability === "task" && childSessions) {
        const child = childForTaskCall(tc, step.sessionId, childSessions, usedChildIds, renderedChildIds);
        if (child) {
          usedChildIds.add(child.id);
          renderedChildIds.add(child.id);
          items.push({
            timestamp: new Date(child.createdAt).getTime(),
            block: { type: "sub_session", session: child },
          });
        }
      }
    }

    const compaction = step.metadata?.contextCompaction as
      | {
          compacted?: boolean;
          originalTokens?: number;
          projectedTokens?: number;
        }
      | undefined;
    if (
      compaction?.compacted &&
      typeof compaction.originalTokens === "number" &&
      typeof compaction.projectedTokens === "number"
    ) {
      items.push({
        timestamp: new Date(step.completedAt ?? step.startedAt).getTime(),
        block: {
          type: "context_compacted",
          originalTokens: compaction.originalTokens,
          compressedTokens: compaction.projectedTokens,
          messageCount: 0,
        },
      });
    }

    items.sort((a, b) => a.timestamp - b.timestamp);
    const merged = mergeConsecutiveBlocks(items.map((i) => i.block));
    const blocks = groupParallelToolCalls(merged);

    return {
      stepId: step.id,
      index: step.index,
      status: step.status,
      duration: computeDuration(step),
      completedAt: step.completedAt,
      blocks,
    };
  });
}
