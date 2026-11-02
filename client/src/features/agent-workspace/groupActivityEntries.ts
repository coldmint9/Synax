import type { TurnContentBlock } from "./buildInterleavedTurns";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";

type AgentTimelineEntry = Extract<ConversationTimelineEntry, { kind: "agent" }>;
type BuildingAgentEntry = Omit<AgentTimelineEntry, "turn"> & {
  turn: Omit<AgentTimelineEntry["turn"], "blocks"> & {
    blocks: TurnContentBlock[];
  };
};
type BuildingEntry =
  | Exclude<ConversationTimelineEntry, { kind: "agent" }>
  | BuildingAgentEntry;

/** Replies and user/system events end an activity group; model steps do not. */
export function groupActivityEntries(
  entries: ConversationTimelineEntry[],
): ConversationTimelineEntry[] {
  // Every agent row and its block array are owned by this call until return.
  // Block objects and non-agent entries are shared with the input, never edited.
  const result: BuildingEntry[] = [];
  let pending: BuildingAgentEntry | undefined;
  const flush = () => {
    if (pending) result.push(pending);
    pending = undefined;
  };
  for (const entry of entries) {
    if (entry.kind !== "agent") {
      flush();
      result.push(entry);
      continue;
    }
    // Persisted reasoning may be merged, omitted or arrive after the reply.
    // Count rendered replies independently so that handoff does not remount
    // an existing answer merely because its offset among activity blocks changed.
    let contentIndex = 0;
    entry.turn.blocks.forEach((block, index) => {
      const activity =
        block.type === "thinking" ||
        block.type === "tool_call" ||
        block.type === "tool_call_group";
      if (block.type === "text" && !block.content.trim()) return;
      if (activity) {
        if (!pending) {
          pending = {
            ...entry,
            id: `${entry.id}:activity:${index}`,
            turn: { ...entry.turn, blocks: [] },
          };
        }
        pending.turn.blocks.push(block);
        pending.turn.status = entry.turn.status;
      } else {
        flush();
        const previous = result[result.length - 1];
        const messageId = "messageId" in block ? block.messageId : undefined;
        const previousBlock =
          previous?.kind === "agent"
            ? previous.turn.blocks[previous.turn.blocks.length - 1]
            : undefined;
        if (
          messageId &&
          previous?.kind === "agent" &&
          previousBlock &&
          "messageId" in previousBlock &&
          previousBlock.messageId === messageId
        ) {
          previous.turn.blocks.push(block);
          return;
        }
        result.push({
          ...entry,
          id: `${entry.id}:content:${contentIndex++}`,
          turn: { ...entry.turn, blocks: [block] },
        });
      }
    });
  }
  flush();
  return result;
}
