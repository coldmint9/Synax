import type { AgentRunStreamChunk } from "./contracts.js";

export function boundedStreamChunk(chunk: AgentRunStreamChunk): AgentRunStreamChunk {
  return Buffer.byteLength(JSON.stringify(chunk)) > 64 * 1024 ? projectReplayChunk(chunk) : chunk;
}

/** Preserve producer sequencing by splitting before assigning each append ID. */
export function streamBatchGroups(chunks: AgentRunStreamChunk[]): AgentRunStreamChunk[][] {
  const groups: AgentRunStreamChunk[][] = [];
  let group: AgentRunStreamChunk[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(JSON.stringify(boundedStreamChunk(chunk))) + 2048;
    if (size > 512 * 1024) throw new Error("Stream event exceeds the preview budget; externalize its content first.");
    if (bytes + size > 512 * 1024 && group.length) { groups.push(group); group = []; bytes = 0; }
    group.push(chunk); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** The replay journal is a disposable UI feed, not a second copy of tool output
 * or a model context snapshot. Authoritative content stays in the message store. */
export function projectReplayChunk(
  chunk: AgentRunStreamChunk,
): AgentRunStreamChunk {
  const value = { ...chunk } as AgentRunStreamChunk;
  const short = (text: string | null, limit = 8192) =>
    text && text.length > limit
      ? text.slice(0, limit) +
        "\n[Replay preview truncated; full content is in history]"
      : text;
  if ("run" in value && value.run) value.run = { ...value.run, metadata: {} };
  if ("step" in value) value.step = { ...value.step, metadata: {} };
  if ("toolCall" in value)
    value.toolCall = {
      ...value.toolCall,
      inputRef: null,
      outputRef: null,
      inputSummary: short(value.toolCall.inputSummary, 2048)!,
      outputSummary: short(value.toolCall.outputSummary, 2048),
    };
  if ("message" in value && value.message)
    value.message = {
      ...value.message,
      content: short(value.message.content)!,
      metadata: {
        source: value.message.metadata.source,
        purpose: value.message.metadata.purpose,
        replayPreview: true,
      },
      contentParts: value.message.contentParts?.filter(
        (part) => part.type !== "text",
      ),
    };
  if ("event" in value && value.event)
    value.event = {
      ...value.event,
      summary: short(value.event.summary, 1024)!,
      payload:
        JSON.stringify(value.event.payload).length <= 8192
          ? value.event.payload
          : { replayPreview: true },
    };
  return value;
}
