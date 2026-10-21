import { memo } from "react";
import { useShellStore } from "../../shared/state/shellStore";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { TurnContent } from "./TurnBody";
import { formatDurationMs, latestActivityPreview, thinkingBannerPhrase } from "./activityText";

type WorkLogEntryData = Extract<ConversationTimelineEntry, { kind: "work_log" }>;
interface Props {
  entry: WorkLogEntryData;
  onExpandChild?: (sessionId: string) => void;
}

function latestThinking(entry: WorkLogEntryData): string | null {
  for (let i = entry.turns.length - 1; i >= 0; i--) {
    const blocks = entry.turns[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === "thinking" && block.content.trim()) return block.content;
    }
  }
  return null;
}

/** The same timeline for completed rounds; respect the user's work-log folding preference. */
export const WorkLogEntry = memo(function WorkLogEntry({ entry, onExpandChild }: Props) {
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const thinking = showThinking ? latestThinking(entry) : null;
  const preview = thinking ? thinkingBannerPhrase(thinking) ?? latestActivityPreview(thinking) : null;
  const blocks = entry.turns.flatMap((turn) => turn.blocks)
    .filter((block) => showThinking || block.type !== "thinking");

  return (
    <TurnContent
      blocks={blocks}
      rowKeyPrefix={entry.id}
      onExpandChild={onExpandChild}
      defaultExpanded={false}
      processOnly
      processMeta={formatDurationMs(entry.stats.elapsedMs) ?? undefined}
      processPreview={preview}
    />
  );
});

export type { WorkLogEntryData };
