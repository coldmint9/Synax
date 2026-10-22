import { memo } from "react";
import { useShellStore } from "../../shared/state/shellStore";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { TurnContent } from "./TurnBody";

type WorkLogEntryData = Extract<ConversationTimelineEntry, { kind: "work_log" }>;
interface Props {
  entry: WorkLogEntryData;
  onExpandChild?: (sessionId: string) => void;
}

/** The same timeline for completed rounds; respect the user's work-log folding preference. */
export const WorkLogEntry = memo(function WorkLogEntry({ entry, onExpandChild }: Props) {
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const blocks = entry.turns.flatMap((turn) => turn.blocks)
    .filter((block) => showThinking || block.type !== "thinking");

  return (
    <TurnContent
      blocks={blocks}
      rowKeyPrefix={entry.id}
      onExpandChild={onExpandChild}
      defaultExpanded={false}
    />
  );
});

export type { WorkLogEntryData };
